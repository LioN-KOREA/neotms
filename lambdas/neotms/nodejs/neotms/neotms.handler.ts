// SPDX-License-Identifier: MIT
//
// The routing table, and the three things that happen to every request before a handler sees it.
//
// One function serves the whole API (see NeotmsApi.ts for why), so this file is where the request
// stops being HTTP and becomes a domain call. Three concerns are centralised here rather than
// repeated in each handler, and in each case the reason is that the repeated version WILL eventually
// be forgotten on one route - and a forgotten check is invisible until it is exploited:
//
//   1. **CORS.** Every answer gets the headers, including refusals. A 401 without them reads to the
//      browser as a network failure, so the UI cannot tell "sign in again" from "the API is down".
//   2. **Authentication.** Checked on the path prefix. Everything under `/api/v0/` requires a
//      verified LPX account with a usable staff row; `/api/auth/` is how a browser gets one, so it
//      is open and each of its handlers checks its own cookie. A route added under `/api/v0/` later
//      is authenticated whether or not its author thought about it.
//   3. **Authorization.** Per route, from the table below - because that is the granularity the
//      legacy permission model has. A route declares the menu and the action it belongs to; the
//      check is then made here, once, and a route that forgets to declare them is REFUSED rather
//      than waved through (see `routeAllows`).
//
// The row-level half of access control is not here. It cannot be: "which projects may this person
// see" is a WHERE clause, not a yes/no on a request, so it lives in each dbops module's
// `scopeClause`. This file decides whether the request may run at all; the query decides which rows
// it may touch.

import { addRoute, createRouter, findRoute } from "rou3";
import {
  hasPermission,
  permissionRefusal,
  requireNeotmsAccess,
  type MenuAction,
  type NeotmsCaller,
} from "../auth/NeotmsAuthGuard.js";
import { completeLogin, endSession, refreshSession, startLogin } from "../auth/NeotmsSessionManager.js";
import { NEOTMS_ALLOWED_ORIGINS } from "../env/NeotmsEnv.js";
import type { RRHandler, RequestData, ResponseData } from "../reqres/RequestResponse.js";
import {
  CORS_HEADERS_REJECTED,
  generateCorsHeadersActual,
  generateCorsHeadersPreflight,
} from "../utils/CorsUtils.js";
import { NeotmsMenu, type NeotmsMenuId } from "./NeotmsMenus.js";
import { badRequest, parseBody } from "./NeotmsResult.js";
import { clientInet, type WriteContext } from "./NeotmsWrite.js";
import {
  CustomerCreateSchema,
  CustomerUpdateSchema,
  JobCreateSchema,
  JobUpdateSchema,
  ProjectCreateSchema,
  ProjectUpdateSchema,
  PurchaseOrderCreateSchema,
  PurchaseOrderUpdateSchema,
  TranslatorCreateSchema,
  TranslatorUpdateSchema,
} from "./neotms.schemas.js";
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from "./customers/NeotmsCustomerManager.js";
import {
  createTranslator,
  deleteTranslator,
  getTranslator,
  listTranslators,
  updateTranslator,
} from "./translators/NeotmsTranslatorManager.js";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "./projects/NeotmsProjectManager.js";
import { createJob, deleteJob, getJob, listJobs, updateJob } from "./jobs/NeotmsJobManager.js";
import {
  createPurchaseOrder,
  deletePurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  updatePurchaseOrder,
} from "./purchase-orders/NeotmsPurchaseOrderManager.js";
import { getProfile } from "./profile/NeotmsProfileManager.js";
import { getWorkload, runReport } from "./reports/NeotmsReportManager.js";

/* -------------------------------------------------------------------------- */
/* CORS                                                                       */
/* -------------------------------------------------------------------------- */

const ALLOWED_CORS_HEADERS = ["Authorization", "Content-Type"];
/*
 * PATCH is in the list because every edit in this API is a partial update.
 *
 * The distinction is not cosmetic: `undefined` means "leave this column alone" and `null` means
 * "clear it" (see NeotmsWrite), which a PUT cannot express. A browser will not send a PATCH at all
 * unless the preflight names it, so omitting it here would break every save with a CORS error that
 * mentions nothing about PATCH.
 */
const ALLOWED_CORS_METHODS = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"];
/*
 * `Retry-After` is exposed so the UI can honour it.
 *
 * The cluster pauses when idle, so the first request of the morning can legitimately answer 503 with
 * a retry hint. A header the browser hides from the page is a header the retry logic cannot read,
 * and the fallback - a fixed retry delay guessed in the client - is how a two-second wake-up becomes
 * a thirty-second one.
 */
const EXPOSED_CORS_HEADERS = ["Retry-After"];

/* -------------------------------------------------------------------------- */
/* The caller, and what a handler needs from the request                      */
/* -------------------------------------------------------------------------- */

/** Where the guard leaves the resolved caller. Read with `callerOf`, never re-derived. */
export const CALLER_CONTEXT_KEY = "caller";

/**
 * The caller the guard resolved for this request.
 *
 * Throws rather than returning null. A handler on an authenticated path cannot run without a caller,
 * so a missing one is a routing bug - a route placed outside the guarded prefix - and it has to fail
 * loudly in a test rather than quietly become an unauthenticated code path. The throw is caught in
 * `index.ts` and answered as a 500.
 */
export function callerOf(request: RequestData): NeotmsCaller {
  const caller = request.context.get(CALLER_CONTEXT_KEY);
  if (!caller) throw new Error("No caller is attached to this request; the route escaped the guard.");
  return caller as NeotmsCaller;
}

/**
 * Who is writing, and from where.
 *
 * Both values come from the server's own knowledge of the request - the staff row the guard
 * resolved, and the proxy header - never from the body. An audit column a caller can set is not an
 * audit column, and `created_by` is the only answer this system has to "who changed this".
 */
const writeContext = (request: RequestData): WriteContext => ({
  actor: callerOf(request).mgrId,
  ip: clientInet(request.headers),
});

/**
 * The record id from the path, or null if it is not one.
 *
 * Ids are bigints and reach the Data API with a bigint type hint, so a path of `/customers/abc`
 * would otherwise fail inside PostgreSQL and surface as a 500 - an invalid URL reported as a server
 * fault. Checked here instead, as a shape check only: whether the row exists, and whether this
 * caller may see it, are questions for the query.
 */
const recordId = (request: RequestData): string | null => {
  const raw = (request.pathParams["id"] ?? "").trim();
  return /^\d{1,19}$/.test(raw) ? raw : null;
};

const NOT_A_RECORD_ID = badRequest("That is not a record id");

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/* Sessions. Open to everyone - these are how a browser acquires a token in the first place. */
const handleLogin: RRHandler = async () => startLogin();
const handleCompleteLogin: RRHandler = async (request) => completeLogin(request);
const handleRefreshSession: RRHandler = async (request) => refreshSession(request);
const handleLogout: RRHandler = async (request) => endSession(request);

/* The caller's own profile and permission matrix. Authenticated, but gated on no menu. */
const handleGetProfile: RRHandler = async (request) => getProfile(callerOf(request));

/* 고객사 - customers. Not row-scoped: the customer master is shared company-wide. */
const handleListCustomers: RRHandler = async (request) => listCustomers(request);

const handleGetCustomer: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? getCustomer(id) : NOT_A_RECORD_ID;
};

const handleCreateCustomer: RRHandler = async (request) => {
  const parsed = parseBody(CustomerCreateSchema, request.body);
  return parsed.ok ? createCustomer(parsed.value, writeContext(request)) : parsed.response;
};

const handleUpdateCustomer: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(CustomerUpdateSchema, request.body);
  return parsed.ok ? updateCustomer(id, parsed.value, writeContext(request)) : parsed.response;
};

const handleDeleteCustomer: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deleteCustomer(id, writeContext(request)) : NOT_A_RECORD_ID;
};

/* 번역가 - translators. Also shared: a vendor belongs to the company, not to a PM. */
const handleListTranslators: RRHandler = async (request) => listTranslators(request);

const handleGetTranslator: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? getTranslator(id) : NOT_A_RECORD_ID;
};

const handleCreateTranslator: RRHandler = async (request) => {
  const parsed = parseBody(TranslatorCreateSchema, request.body);
  return parsed.ok ? createTranslator(parsed.value, writeContext(request)) : parsed.response;
};

const handleUpdateTranslator: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(TranslatorUpdateSchema, request.body);
  return parsed.ok ? updateTranslator(id, parsed.value, writeContext(request)) : parsed.response;
};

const handleDeleteTranslator: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deleteTranslator(id, writeContext(request)) : NOT_A_RECORD_ID;
};

/*
 * 프로젝트 / 작업 / 발주 - the revenue and cost chain, and the row-scoped part of the API.
 *
 * Every one of these takes the caller, because the caller decides which rows the query can see. That
 * is the LKTMS defect being closed: there, the detail screens took an id and returned the row to
 * anyone who asked.
 */
const handleListProjects: RRHandler = async (request) => listProjects(callerOf(request), request);

const handleGetProject: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? getProject(callerOf(request), id) : NOT_A_RECORD_ID;
};

const handleCreateProject: RRHandler = async (request) => {
  const parsed = parseBody(ProjectCreateSchema, request.body);
  return parsed.ok
    ? createProject(callerOf(request), parsed.value, writeContext(request))
    : parsed.response;
};

const handleUpdateProject: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(ProjectUpdateSchema, request.body);
  return parsed.ok
    ? updateProject(callerOf(request), id, parsed.value, writeContext(request))
    : parsed.response;
};

const handleDeleteProject: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deleteProject(callerOf(request), id, writeContext(request)) : NOT_A_RECORD_ID;
};

const handleListJobs: RRHandler = async (request) => listJobs(callerOf(request), request);

const handleGetJob: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? getJob(callerOf(request), id) : NOT_A_RECORD_ID;
};

const handleCreateJob: RRHandler = async (request) => {
  const parsed = parseBody(JobCreateSchema, request.body);
  return parsed.ok
    ? createJob(callerOf(request), parsed.value, writeContext(request))
    : parsed.response;
};

const handleUpdateJob: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(JobUpdateSchema, request.body);
  return parsed.ok
    ? updateJob(callerOf(request), id, parsed.value, writeContext(request))
    : parsed.response;
};

const handleDeleteJob: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deleteJob(callerOf(request), id, writeContext(request)) : NOT_A_RECORD_ID;
};

const handleListPurchaseOrders: RRHandler = async (request) =>
  listPurchaseOrders(callerOf(request), request);

const handleGetPurchaseOrder: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? getPurchaseOrder(callerOf(request), id) : NOT_A_RECORD_ID;
};

const handleCreatePurchaseOrder: RRHandler = async (request) => {
  const parsed = parseBody(PurchaseOrderCreateSchema, request.body);
  return parsed.ok
    ? createPurchaseOrder(callerOf(request), parsed.value, writeContext(request))
    : parsed.response;
};

const handleUpdatePurchaseOrder: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(PurchaseOrderUpdateSchema, request.body);
  return parsed.ok
    ? updatePurchaseOrder(callerOf(request), id, parsed.value, writeContext(request))
    : parsed.response;
};

const handleDeletePurchaseOrder: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deletePurchaseOrder(callerOf(request), id, writeContext(request)) : NOT_A_RECORD_ID;
};

/* 보고서 - the reports. Gated on their own menu, not on the menus they aggregate. */
const handleRunReport: RRHandler = async (request) => runReport(callerOf(request), request);
const handleGetWorkload: RRHandler = async (request) => getWorkload(callerOf(request), request);

/* -------------------------------------------------------------------------- */
/* The routing table                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One route: how to reach it, what to run, and what it may require.
 *
 * `menu` and `action` are what the per-route permission check reads. They are optional in the type
 * only so that the session routes - which are unauthenticated and belong to no menu - can be
 * declared in the same array; `routeAllows` refuses an authenticated route that omits them.
 */
export type NeotmsRoute = {
  path: string;
  method: string;
  handler: RRHandler;
  menu?: NeotmsMenuId;
  action?: MenuAction;
  /**
   * Set only on `/api/v0/me`, which every signed-in staff member may call.
   *
   * It has to exist as an explicit flag rather than as "no menu declared", because "no menu
   * declared" is also what a route whose author forgot looks like - and those two must not be the
   * same thing.
   */
  anyStaff?: true;
};

const CUSTOMERS = "/api/v0/customers";
const TRANSLATORS = "/api/v0/translators";
const PROJECTS = "/api/v0/projects";
const JOBS = "/api/v0/jobs";
const PURCHASE_ORDERS = "/api/v0/purchase-orders";

export const NEOTMS_ROUTES: NeotmsRoute[] = [
  // -- Sessions (open) ------------------------------------------------------
  { path: "/api/auth/login", method: "GET", handler: handleLogin },
  { path: "/api/auth/session", method: "POST", handler: handleCompleteLogin },
  { path: "/api/auth/refresh", method: "POST", handler: handleRefreshSession },
  { path: "/api/auth/logout", method: "POST", handler: handleLogout },

  // -- The caller's own profile (authenticated, no menu) --------------------
  { path: "/api/v0/me", method: "GET", handler: handleGetProfile, anyStaff: true },

  // -- 고객사 ---------------------------------------------------------------
  { path: CUSTOMERS, method: "GET", handler: handleListCustomers, menu: NeotmsMenu.CUSTOMER, action: "read" },
  { path: CUSTOMERS, method: "POST", handler: handleCreateCustomer, menu: NeotmsMenu.CUSTOMER, action: "create" },
  { path: `${CUSTOMERS}/:id`, method: "GET", handler: handleGetCustomer, menu: NeotmsMenu.CUSTOMER, action: "read" },
  { path: `${CUSTOMERS}/:id`, method: "PATCH", handler: handleUpdateCustomer, menu: NeotmsMenu.CUSTOMER, action: "update" },
  { path: `${CUSTOMERS}/:id`, method: "DELETE", handler: handleDeleteCustomer, menu: NeotmsMenu.CUSTOMER, action: "delete" },

  // -- 번역가 ---------------------------------------------------------------
  { path: TRANSLATORS, method: "GET", handler: handleListTranslators, menu: NeotmsMenu.TRANSLATOR, action: "read" },
  { path: TRANSLATORS, method: "POST", handler: handleCreateTranslator, menu: NeotmsMenu.TRANSLATOR, action: "create" },
  { path: `${TRANSLATORS}/:id`, method: "GET", handler: handleGetTranslator, menu: NeotmsMenu.TRANSLATOR, action: "read" },
  { path: `${TRANSLATORS}/:id`, method: "PATCH", handler: handleUpdateTranslator, menu: NeotmsMenu.TRANSLATOR, action: "update" },
  { path: `${TRANSLATORS}/:id`, method: "DELETE", handler: handleDeleteTranslator, menu: NeotmsMenu.TRANSLATOR, action: "delete" },

  // -- 프로젝트 -------------------------------------------------------------
  { path: PROJECTS, method: "GET", handler: handleListProjects, menu: NeotmsMenu.PROJECT, action: "read" },
  { path: PROJECTS, method: "POST", handler: handleCreateProject, menu: NeotmsMenu.PROJECT, action: "create" },
  { path: `${PROJECTS}/:id`, method: "GET", handler: handleGetProject, menu: NeotmsMenu.PROJECT, action: "read" },
  { path: `${PROJECTS}/:id`, method: "PATCH", handler: handleUpdateProject, menu: NeotmsMenu.PROJECT, action: "update" },
  { path: `${PROJECTS}/:id`, method: "DELETE", handler: handleDeleteProject, menu: NeotmsMenu.PROJECT, action: "delete" },

  // -- 작업 (revenue) -------------------------------------------------------
  { path: JOBS, method: "GET", handler: handleListJobs, menu: NeotmsMenu.JOB, action: "read" },
  { path: JOBS, method: "POST", handler: handleCreateJob, menu: NeotmsMenu.JOB, action: "create" },
  { path: `${JOBS}/:id`, method: "GET", handler: handleGetJob, menu: NeotmsMenu.JOB, action: "read" },
  { path: `${JOBS}/:id`, method: "PATCH", handler: handleUpdateJob, menu: NeotmsMenu.JOB, action: "update" },
  { path: `${JOBS}/:id`, method: "DELETE", handler: handleDeleteJob, menu: NeotmsMenu.JOB, action: "delete" },

  // -- 발주 (cost) ----------------------------------------------------------
  { path: PURCHASE_ORDERS, method: "GET", handler: handleListPurchaseOrders, menu: NeotmsMenu.PURCHASE_ORDER, action: "read" },
  { path: PURCHASE_ORDERS, method: "POST", handler: handleCreatePurchaseOrder, menu: NeotmsMenu.PURCHASE_ORDER, action: "create" },
  { path: `${PURCHASE_ORDERS}/:id`, method: "GET", handler: handleGetPurchaseOrder, menu: NeotmsMenu.PURCHASE_ORDER, action: "read" },
  { path: `${PURCHASE_ORDERS}/:id`, method: "PATCH", handler: handleUpdatePurchaseOrder, menu: NeotmsMenu.PURCHASE_ORDER, action: "update" },
  { path: `${PURCHASE_ORDERS}/:id`, method: "DELETE", handler: handleDeletePurchaseOrder, menu: NeotmsMenu.PURCHASE_ORDER, action: "delete" },

  // -- 보고서 ---------------------------------------------------------------
  //
  // Both are GETs with their parameters in the query string, so a report a manager cares about can
  // be bookmarked and mailed to a colleague - which is what people currently do with screenshots.
  { path: "/api/v0/reports/summary", method: "GET", handler: handleRunReport, menu: NeotmsMenu.REPORT, action: "read" },
  { path: "/api/v0/reports/workload", method: "GET", handler: handleGetWorkload, menu: NeotmsMenu.REPORT, action: "read" },
];

const neotmsRouter = createRouter<NeotmsRoute>();
NEOTMS_ROUTES.forEach((route) => addRoute(neotmsRouter, route.method, route.path, route));

/* -------------------------------------------------------------------------- */
/* The entry point                                                            */
/* -------------------------------------------------------------------------- */

/** Everything under here needs a signed-in staff member. `/api/auth/` deliberately does not. */
const AUTHENTICATED_PATH_PREFIX = "/api/v0/";

/**
 * Whether this caller may take this route's action.
 *
 * Fails closed on a route that declares neither a menu nor `anyStaff`. That combination is almost
 * certainly an oversight, and the two possible ways to be wrong are not symmetrical: refusing a
 * legitimate route is reported within the hour by the person who cannot use it, while permitting an
 * undeclared one is never reported by anybody.
 */
function routeAllows(route: NeotmsRoute, caller: NeotmsCaller): ResponseData<string> | null {
  if (route.anyStaff) return null;
  if (!route.menu || !route.action) {
    console.error(`The route ${route.method} ${route.path} declares no menu; refusing.`);
    return { status: 403, body: "This endpoint is not configured for authorization" };
  }
  return hasPermission(caller, route.menu, route.action)
    ? null
    : permissionRefusal(route.menu, route.action);
}

export const handleRequest: RRHandler = async (request) => {
  const reqOrigin = request.headers?.["origin"] ?? null;
  const originAllowed = reqOrigin !== null && NEOTMS_ALLOWED_ORIGINS.includes(reqOrigin);

  if (reqOrigin !== null) {
    if (request.method === "OPTIONS" && originAllowed) {
      return {
        status: 204,
        headers: {
          ...generateCorsHeadersPreflight(
            reqOrigin,
            ALLOWED_CORS_HEADERS,
            ALLOWED_CORS_METHODS,
            true,
            EXPOSED_CORS_HEADERS,
          ),
        },
        body: "",
      };
    }
    if (!originAllowed) {
      // Refused before routing, and with no CORS headers: the browser will not hand the body to the
      // page in any case, so there is nothing to be gained by doing the work first.
      return { status: 403, headers: CORS_HEADERS_REJECTED, body: "" };
    }
  }

  const withCors = (response: ResponseData<unknown>): ResponseData<unknown> =>
    originAllowed && reqOrigin !== null
      ? {
          ...response,
          headers: {
            ...response.headers,
            ...generateCorsHeadersActual(reqOrigin, true, EXPOSED_CORS_HEADERS),
          },
        }
      : response;

  const matched = findRoute(neotmsRouter, request.method, request.path);
  if (!matched) return withCors({ status: 404, body: "No such endpoint" });
  const route = matched.data;

  // The path params rou3 extracted are merged in rather than replacing the map, so a param the
  // gateway supplied is kept. `:id` always comes from here.
  const routed: RequestData = matched.params
    ? { ...request, pathParams: { ...request.pathParams, ...matched.params } }
    : request;

  if (!request.path.startsWith(AUTHENTICATED_PATH_PREFIX)) {
    return withCors(await route.handler(routed));
  }

  const guard = await requireNeotmsAccess(request.headers);
  if (!guard.ok) return withCors(guard.response);

  const refusal = routeAllows(route, guard.caller);
  if (refusal) return withCors(refusal);

  // Resolved once, for the whole request. A handler reads it with `callerOf` and never asks again -
  // which is what keeps a permission question from costing a database round trip.
  routed.context.set(CALLER_CONTEXT_KEY, guard.caller);
  return withCors(await route.handler(routed));
};
