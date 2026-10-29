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
  requireLpxAccountOnly,
  requireNeotmsAccess,
  type LpxIdentity,
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
  CodeCreateSchema,
  CodeUpdateSchema,
  CustomerCreateSchema,
  CustomerUpdateSchema,
  JobCreateSchema,
  JobUpdateSchema,
  ProjectCreateSchema,
  ProjectUpdateSchema,
  PurchaseOrderCreateSchema,
  PurchaseOrderUpdateSchema,
  SelfProfileSchema,
  StaffAdminUpdateSchema,
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
import { registerSelf } from "./profile/NeotmsRegistrationManager.js";
import { getWorkload, runReport } from "./reports/NeotmsReportManager.js";
import {
  createCode,
  deleteCode,
  listCodes,
  listCodesForAdmin,
  updateCode,
} from "./codes/NeotmsCodeManager.js";
import { listRoles, listStaff, updateStaff } from "./staff/NeotmsStaffAdminManager.js";

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

/** Where the account-only tier leaves the verified identity. Read with `identityOf`. */
export const IDENTITY_CONTEXT_KEY = "identity";

/**
 * The LPX identity behind this request, for the two routes that run without a staff row.
 *
 * A separate key from `CALLER_CONTEXT_KEY` rather than a nullable field on the caller, so the two
 * tiers cannot be confused by a handler. A route on the account tier has NO caller - there may be
 * no staff row at all - and `callerOf` throwing on it is the correct outcome: it means somebody
 * gave an `account: true` route a handler that reads permissions, and that has to fail in a test
 * rather than at runtime with `undefined`.
 */
export function identityOf(request: RequestData): LpxIdentity {
  const identity = request.context.get(IDENTITY_CONTEXT_KEY);
  if (!identity) {
    throw new Error("No identity is attached to this request; the route escaped the guard.");
  }
  return identity as LpxIdentity;
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
 * Ids are bigints and reach PostgreSQL on a placeholder cast to `bigint`, so a path of
 * `/customers/abc`
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

/*
 * The caller's own registration state, profile and permission matrix.
 *
 * `identityOf` and not `callerOf`: this route is on the account-only tier, because an employee with
 * no staff row has to be able to learn that this is what is wrong with them. See the header of
 * NeotmsProfileManager.
 */
const handleGetProfile: RRHandler = async (request) => getProfile(identityOf(request));

/*
 * The sign-up form. The other account-only route, and the only write in this table with no actor.
 *
 * `clientInet(request.headers)` rather than `writeContext(request)`: a `WriteContext` carries the
 * caller's `mgrId` for `created_by`, and there is no caller here - `writeContext` would throw inside
 * `callerOf`. `staff_self_register()` writes `created_by` itself, as the literal marker
 * 'self-registration'.
 */
const handleRegisterSelf: RRHandler = async (request) => {
  const parsed = parseBody(SelfProfileSchema, request.body);
  return parsed.ok
    ? registerSelf(identityOf(request), parsed.value, clientInet(request.headers))
    : parsed.response;
};

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

/*
 * 코드 - the code tables, in two halves.
 *
 * The read is `anyStaff` and the writes are MAINTENANCE, which is the whole reason there are two
 * listings instead of one with a flag: 22 columns across the schema FK to `sys_code`, so every form
 * in the application needs this list to render its dropdowns, while deciding what the company's
 * 분야 taxonomy IS belongs to whoever runs the system.
 *
 * None of these take the caller. There is nothing row-scoped about a code table - a PM and a
 * director see the same 분야 list - so there is no WHERE clause for a scope to narrow.
 */
const handleListCodes: RRHandler = async () => listCodes();
const handleListCodesForAdmin: RRHandler = async () => listCodesForAdmin();

const handleCreateCode: RRHandler = async (request) => {
  const parsed = parseBody(CodeCreateSchema, request.body);
  return parsed.ok ? createCode(parsed.value) : parsed.response;
};

const handleUpdateCode: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(CodeUpdateSchema, request.body);
  return parsed.ok ? updateCode(id, parsed.value) : parsed.response;
};

const handleDeleteCode: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deleteCode(id) : NOT_A_RECORD_ID;
};

/*
 * 사용자 관리 - the staff directory and role assignment.
 *
 * The two reads take no caller, for the reason given in NeotmsStaffAdminManager: a staff directory
 * is not row-scoped, and an administrator who could not see a pending request could not approve it.
 *
 * The PATCH is the one handler in this file that passes the caller for a reason other than scoping
 * or `created_by`. It needs to know who is asking so it can refuse a caller clearing their own role
 * or deactivating themselves - the one edit on this screen that cannot be undone from this screen.
 */
const handleListStaff: RRHandler = async () => listStaff();
const handleListRoles: RRHandler = async () => listRoles();

const handleUpdateStaff: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(StaffAdminUpdateSchema, request.body);
  return parsed.ok ? updateStaff(callerOf(request), id, parsed.value) : parsed.response;
};

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
   * Every signed-in staff member may call this, whatever their role grants.
   *
   * One route carries it, and it is something no form in the application can render without:
   * `GET /api/v0/codes`, the code tables. 분야, 작업 종류, 단가 단위 and 언어 fill dropdowns on every
   * form, so gating this on 유지보수 would leave a PM with the right to create a customer looking at
   * empty dropdowns. Reading a list of category names is not a privilege worth gating; deciding what
   * is IN the list is, and that is the `/admin/codes` half.
   *
   * It has to exist as an explicit flag rather than as "no menu declared", because "no menu
   * declared" is also what a route whose author forgot looks like - and those two must not be the
   * same thing.
   */
  anyStaff?: true;
  /**
   * A verified LPX account is enough. NO STAFF ROW IS REQUIRED - and that is the widest tier in
   * this table, so the list of routes carrying it is meant to stay at two.
   *
   * Both exist to break the registration deadlock. `anyStaff` still means "has a usable staff row",
   * so an employee who has never been registered is refused by it - including on the endpoint that
   * would have told them so, and on the endpoint that would have registered them:
   *
   *   * `GET /api/v0/me` - reports the registration state, so the SPA can show the sign-up form or
   *     the waiting notice instead of a bare 403.
   *   * `POST /api/v0/registration` - creates the staff row that `anyStaff` requires.
   *
   * The audience is every employee holding the NEOTMS app authority, approved or not. So a handler
   * here may read and write THIS CALLER'S OWN staff row and nothing else: no business table, no
   * other person's row, no permission decision. `callerOf` throws on these routes, which keeps a
   * handler from quietly treating an unapproved account as a caller.
   */
  account?: true;
};

const CUSTOMERS = "/api/v0/customers";
const TRANSLATORS = "/api/v0/translators";
const PROJECTS = "/api/v0/projects";
const JOBS = "/api/v0/jobs";
const PURCHASE_ORDERS = "/api/v0/purchase-orders";
/*
 * The code tables under two paths, deliberately.
 *
 * `/api/v0/codes` is the dropdown feed and `/api/v0/admin/codes` is the 유지보수 screen, and they
 * are two paths rather than one path with five methods because the authorization differs by HTTP
 * verb otherwise - which is a shape this routing table can express but a reader cannot audit at a
 * glance. With the split, "which endpoints need 유지보수" is answered by reading one prefix.
 */
const CODES = "/api/v0/codes";
const ADMIN_CODES = "/api/v0/admin/codes";
/*
 * Both under `/admin/`, both gated on STAFF, including the role listing.
 *
 * `/admin/roles` could have been `anyStaff` - a role's name is not a secret, and the sidebar
 * already tells the caller their own role. It is gated anyway because nothing except the 사용자 관리
 * screen reads it: an endpoint whose only consumer is an admin screen should be reachable only from
 * that screen, so that "who can enumerate the company's privilege tiers" stays a question with a
 * short answer. If a future screen needs role names for a non-admin audience, that is the moment to
 * split it the way `/codes` and `/admin/codes` are split - not before.
 */
const ADMIN_STAFF = "/api/v0/admin/staff";
const ADMIN_ROLES = "/api/v0/admin/roles";

export const NEOTMS_ROUTES: NeotmsRoute[] = [
  // -- Sessions (open) ------------------------------------------------------
  { path: "/api/auth/login", method: "GET", handler: handleLogin },
  { path: "/api/auth/session", method: "POST", handler: handleCompleteLogin },
  { path: "/api/auth/refresh", method: "POST", handler: handleRefreshSession },
  { path: "/api/auth/logout", method: "POST", handler: handleLogout },

  // -- The caller's own registration state and profile ----------------------
  //
  // Both `account` and not `anyStaff`, and they are the only two: the first is the route that says
  // WHY there is no staff row, the second is the route that creates one. `anyStaff` means "has a
  // usable staff row", so gating either of these on it would mean an unregistered employee is
  // refused by the endpoint that explains the refusal and by the endpoint that fixes it.
  { path: "/api/v0/me", method: "GET", handler: handleGetProfile, account: true },
  { path: "/api/v0/registration", method: "POST", handler: handleRegisterSelf, account: true },

  // -- 코드 (dropdowns; authenticated, no menu) ------------------------------
  { path: CODES, method: "GET", handler: handleListCodes, anyStaff: true },

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

  // -- 유지보수 (the code tables) --------------------------------------------
  //
  // There is no `/admin/codes/:id` GET. The listing returns every code including the inactive ones
  // and the whole table is about sixty short rows, so a per-row read would only ever be used to
  // re-fetch something the client already has.
  { path: ADMIN_CODES, method: "GET", handler: handleListCodesForAdmin, menu: NeotmsMenu.MAINTENANCE, action: "read" },
  { path: ADMIN_CODES, method: "POST", handler: handleCreateCode, menu: NeotmsMenu.MAINTENANCE, action: "create" },
  { path: `${ADMIN_CODES}/:id`, method: "PATCH", handler: handleUpdateCode, menu: NeotmsMenu.MAINTENANCE, action: "update" },
  { path: `${ADMIN_CODES}/:id`, method: "DELETE", handler: handleDeleteCode, menu: NeotmsMenu.MAINTENANCE, action: "delete" },

  // -- 사용자 관리 (staff and roles) -----------------------------------------
  //
  // There is no POST and no DELETE here, and both absences are deliberate.
  //
  // No POST: an administrator cannot create a staff row. A staff row needs an `lpx_sub` to be
  // usable, so an admin-side INSERT would have to invent one - and a row with a made-up or absent
  // subject is either dead weight or claimable by whoever next signs in with a matching email.
  // Rows arrive from the legacy ETL or from `staff_self_register()`; the admin's job is to APPROVE,
  // which is the PATCH.
  //
  // No DELETE: every historical project, job and purchase order carries this person's `mgr_id` in
  // `created_by`. Deactivating (`active: false`) is the supported way to end somebody's access and
  // is reachable through the PATCH. Soft-deleting a staff row is a database statement on purpose,
  // so that "remove an employee" is not a button next to "change their role".
  { path: ADMIN_STAFF, method: "GET", handler: handleListStaff, menu: NeotmsMenu.STAFF, action: "read" },
  { path: `${ADMIN_STAFF}/:id`, method: "PATCH", handler: handleUpdateStaff, menu: NeotmsMenu.STAFF, action: "update" },
  { path: ADMIN_ROLES, method: "GET", handler: handleListRoles, menu: NeotmsMenu.STAFF, action: "read" },
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
  // Listed first so the three tiers are visible in one place, though `handleRequest` branches on
  // `account` before it gets here - a route on that tier has no caller to check.
  if (route.account) return null;
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

  /*
   * The account-only tier, before the staff lookup.
   *
   * Branching here rather than inside the guard keeps the full guard's contract intact: it either
   * produces a `NeotmsCaller` or a refusal, and nothing downstream has to handle a third thing. The
   * two routes on this tier read their identity with `identityOf`, and `callerOf` throws on them.
   */
  if (route.account) {
    const identity = await requireLpxAccountOnly(request.headers);
    if (!identity.ok) return withCors(identity.response);
    routed.context.set(IDENTITY_CONTEXT_KEY, identity.identity);
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
