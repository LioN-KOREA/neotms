// SPDX-License-Identifier: MIT
//
// The routing table, and the three things that happen to every request before a handler sees it.
//
// One function serves the whole API (see NeotmsApi.ts for why), so this file is where the request
// stops being HTTP and becomes a domain call. Three concerns are centralised here rather than
// repeated in each handler, and in each case the reason is that the repeated version WILL
// eventually be forgotten on one route - and a forgotten check is invisible until it is exploited:
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
  type NeotmsCaller,
} from "../auth/NeotmsAuthGuard.js";
import {
  NEOTMS_PERMISSION_CUSTOMER_CREATE,
  NEOTMS_PERMISSION_CUSTOMER_DELETE,
  NEOTMS_PERMISSION_CUSTOMER_READ,
  NEOTMS_PERMISSION_CUSTOMER_UPDATE,
  NEOTMS_PERMISSION_DASHBOARD_PM_READ,
  NEOTMS_PERMISSION_DASHBOARD_SALES_READ,
  NEOTMS_PERMISSION_WORKSPACE_READ,
  NEOTMS_PERMISSION_INVOICE_CREATE,
  NEOTMS_PERMISSION_INVOICE_DELETE,
  NEOTMS_PERMISSION_INVOICE_READ,
  NEOTMS_PERMISSION_INVOICE_UPDATE,
  NEOTMS_PERMISSION_JOB_CREATE,
  NEOTMS_PERMISSION_JOB_DELETE,
  NEOTMS_PERMISSION_JOB_READ,
  NEOTMS_PERMISSION_JOB_UPDATE,
  NEOTMS_PERMISSION_MAINTENANCE_CREATE,
  NEOTMS_PERMISSION_MAINTENANCE_DELETE,
  NEOTMS_PERMISSION_MAINTENANCE_READ,
  NEOTMS_PERMISSION_MAINTENANCE_UPDATE,
  NEOTMS_PERMISSION_PO_APPROVE,
  NEOTMS_PERMISSION_PO_CREATE,
  NEOTMS_PERMISSION_PO_DELETE,
  NEOTMS_PERMISSION_PO_EMAIL,
  NEOTMS_PERMISSION_PO_READ,
  NEOTMS_PERMISSION_PO_UPDATE,
  NEOTMS_PERMISSION_PROJECT_CREATE,
  NEOTMS_PERMISSION_PROJECT_DELETE,
  NEOTMS_PERMISSION_PROJECT_EMAIL,
  NEOTMS_PERMISSION_PROJECT_READ,
  NEOTMS_PERMISSION_PROJECT_UPDATE,
  NEOTMS_PERMISSION_REPORT_READ,
  NEOTMS_PERMISSION_STAFF_READ,
  NEOTMS_PERMISSION_STAFF_UPDATE,
  NEOTMS_PERMISSION_TRANSLATOR_CREATE,
  NEOTMS_PERMISSION_TRANSLATOR_DELETE,
  NEOTMS_PERMISSION_TRANSLATOR_READ,
  NEOTMS_PERMISSION_TRANSLATOR_UPDATE,
  type NeotmsPermission,
} from "../auth/NeotmsAuthorities.js";
import { completeLogin, endSession, refreshSession, startLogin } from "../auth/NeotmsSessionManager.js";
import { NEOTMS_ALLOWED_ORIGINS } from "../env/NeotmsEnv.js";
import type { RRHandler, RequestData, ResponseData } from "../reqres/RequestResponse.js";
import {
  CORS_HEADERS_REJECTED,
  generateCorsHeadersActual,
  generateCorsHeadersPreflight,
} from "../utils/CorsUtils.js";
import { badRequest, parseBody } from "./NeotmsResult.js";
import { clientInet, type WriteContext } from "./NeotmsWrite.js";
import {
  CodeCreateSchema,
  CodeUpdateSchema,
  CustomerCreateSchema,
  CustomerUpdateSchema,
  HandoverMailSchema,
  JobHandoverSchema,
  JobGroupActionSchema,
  JobCreateSchema,
  JobUpdateSchema,
  ProjectCreateSchema,
  InvoiceTranslatorCreateSchema,
  InvoiceTranslatorUpdateSchema,
  PoApprovalSchema,
  PoSettlementSchema,
  ProjectAcceptanceSchema,
  ProjectUpdateSchema,
  PurchaseOrderCreateSchema,
  PurchaseOrderUpdateSchema,
  SelfProfileSchema,
  WorkspaceCellSchema,
  WorkspaceColumnOrderSchema,
  WorkspaceColumnSchema,
  WorkspaceLayoutSchema,
  WorkspaceStyleApplySchema,
  AttachmentUploadSchema,
  PoRequestMailSchema,
  RecentSearchForgetSchema,
  RecentSearchRecordSchema,
  RoleAdminCreateSchema,
  RoleAdminUpdateSchema,
  RolePermissionsSchema,
  StaffAttributesSchema,
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
  requestProjectAcceptanceAgain,
  setProjectAcceptance,
  updateProject,
} from "./projects/NeotmsProjectManager.js";
import { createJob, deleteJob, getJob, listJobs, updateJob } from "./jobs/NeotmsJobManager.js";
import { sendHandoverMail } from "./handover/NeotmsHandoverManager.js";
import { sendJobHandover } from "./handover/NeotmsJobHandover.js";
import { applyJobGroup, peekJobGroup } from "./jobs/NeotmsJobGroup.js";
import {
  createPurchaseOrder,
  deletePurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  updatePurchaseOrder,
} from "./purchase-orders/NeotmsPurchaseOrderManager.js";
import {
  approvePurchaseOrder,
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  settlePurchaseOrder,
  updateInvoice,
} from "./invoices/NeotmsInvoiceManager.js";
import { getDashboard } from "./dashboard/NeotmsDashboardManager.js";
import {
  createWorkspaceColumn,
  deleteWorkspaceColumn,
  getWorkspace,
  renameWorkspaceColumn,
  reorderWorkspaceColumns,
  setWorkspaceLayout,
  setWorkspaceStyles,
  writeWorkspaceCell,
} from "./workspace/NeotmsWorkspaceManager.js";
import {
  answerHandover,
  createHandovers,
  getPmSheet,
  listNotices,
  listPendingHandovers,
  listPmStaff,
  listProjectHandovers,
  patchPmRow,
  readNotices,
  translatorSuggestions,
  writePmCells,
  writePmPref,
  readMyPmPrefs,
  confirmPmSeen,
  keepOwnEditsSeen,
  orderPmRows,
} from "./pmsheet/NeotmsPmSheetManager.js";
import {
  PmCellsSchema,
  PmHandoverAnswerSchema,
  PmHandoverCreateSchema,
  PmNoticesReadSchema,
  PmPrefSchema,
  PmRowPatchSchema,
  PmRowOrderSchema,
  PmSeenSchema,
} from "./pmsheet/NeotmsPmSheet.schemas.js";
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
import { listFxRates } from "./fx/NeotmsFxRateManager.js";
import { listRoles, listStaff, updateStaff } from "./staff/NeotmsStaffAdminManager.js";
import { listAssignableStaff } from "./staff/NeotmsAssignableManager.js";
import { createUpload, resolveDownload } from "./attachments/NeotmsAttachmentManager.js";
import { sendPoRequestMail } from "./purchase-orders/NeotmsPoRequestMailManager.js";
import {
  forgetSearch,
  listRecentSearches,
  recordSearch,
} from "./profile/NeotmsRecentSearchManager.js";
import {
  createRole,
  deleteRole,
  listRolesForAdmin,
  setRolePermissions,
  setStaffAttributes,
  updateRole,
} from "./staff/NeotmsRoleAdminManager.js";

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
 * The cluster pauses when idle, so the first request of the morning can legitimately answer 503
 * with a retry hint. A header the browser hides from the page is a header the retry logic cannot
 * read, and the fallback - a fixed retry delay guessed in the client - is how a two-second wake-up
 * becomes a thirty-second one.
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
 * Throws rather than returning null. A handler on an authenticated path cannot run without a
 * caller, so a missing one is a routing bug - a route placed outside the guarded prefix - and it
 * has to fail loudly in a test rather than quietly become an unauthenticated code path. The throw
 * is caught in `index.ts` and answered as a 500.
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
 * `/customers/abc` would otherwise fail inside PostgreSQL and surface as a 500 - an invalid URL
 * reported as a server fault. Checked here instead, as a shape check only: whether the row exists,
 * and whether this caller may see it, are questions for the query.
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
 * caller's `mgrId` for `created_by`, and there is no caller here - `writeContext` would throw
 * inside `callerOf`. `staff_self_register()` writes `created_by` itself, as the literal marker
 * 'self-registration'.
 */
const handleRegisterSelf: RRHandler = async (request) => {
  const parsed = parseBody(SelfProfileSchema, request.body);
  return parsed.ok
    ? registerSelf(identityOf(request), parsed.value, clientInet(request.headers))
    : parsed.response;
};

/* Customers. Not row-scoped: the customer master is shared company-wide. */
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

/* Translators. Also shared: a vendor belongs to the company, not to a PM. */
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
 * Projects, jobs and purchase orders - the revenue and cost chain, and the row-scoped part of the
 * API.
 *
 * Every one of these takes the caller, because the caller decides which rows the query can see.
 * That is the LKTMS defect being closed: there, the detail screens took an id and returned the row
 * to anyone who asked.
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
    ? keepOwnEditsSeen(callerOf(request), { projectId: id }, () => updateProject(callerOf(request), id, parsed.value, writeContext(request)))
    : parsed.response;
};

const handleDeleteProject: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deleteProject(callerOf(request), id, writeContext(request)) : NOT_A_RECORD_ID;
};

/*
 * Accept or reject a project, as its assigned PM.
 *
 * Gated on `PROJECT_READ` and not on `PROJECT_UPDATE`, which looks too weak and is the correct
 * answer. The authority here is not "may edit projects" - it is "is the PM this project is assigned
 * to", a fact about one row that no permission can express, and `ProjectAcceptanceOps` carries that
 * test in its own WHERE clause. Requiring `PROJECT_UPDATE` on top would mean a PM who may not edit
 * projects cannot answer for their own, which is a second gate on one decision where the second one
 * is invisible from the screen.
 *
 * POST on a static trailing segment, like `/purchase-orders/:id/approval`: the id in the path says
 * which project is being answered for, and the act is not an edit of the project's fields.
 */
/*
 * The sales manager asks a rejected project's PM to look again.
 *
 * `PROJECT:update` and not `PROJECT:read`, unlike the acceptance route beside it, and the
 * difference is real: accepting is an answer only one person can give and the row proves who they
 * are, whereas this is an edit to a project's workflow state made by the person who owns the
 * relationship. Somebody with read-only access to projects should not be able to re-open one.
 *
 * The row test - `prj_mgr_id = <caller>` - is still in the statement, so the permission widens
 * nothing: it decides whether the request may run at all, not which project it may touch.
 */
const handleRequestProjectAcceptanceAgain: RRHandler = async (request) => {
  const id = recordId(request);
  return id
    ? requestProjectAcceptanceAgain(callerOf(request), id, writeContext(request))
    : NOT_A_RECORD_ID;
};

const handleSetProjectAcceptance: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(ProjectAcceptanceSchema, request.body);
  return parsed.ok
    ? setProjectAcceptance(callerOf(request), id, parsed.value, writeContext(request))
    : parsed.response;
};

/*
 * Handover mail - hand a project over to its operating PM by mail.
 *
 * No `writeContext`. Nothing in this database changes: the handler reads a project and its jobs,
 * folds them into the form on page 3 of the handover spec, and posts it through the CALLER'S OWN
 * Hiworks account with credentials that live only in this request. There is no row to stamp a
 * `created_by` on, and inventing one would claim a record exists that does not.
 *
 * That is also why the route is declared `PROJECT:read` rather than `update`. See the header of
 * NeotmsHandoverManager: this endpoint discloses nothing the caller cannot already open, cannot
 * reach a project outside their scope, and sends as them - it replaces a clipboard copy, which
 * needed no authority beyond being able to look at the screen.
 */
const handleSendHandoverMail: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(HandoverMailSchema, request.body);
  return parsed.ok ? sendHandoverMail(callerOf(request), id, parsed.value) : parsed.response;
};

const handleJobHandover: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(JobHandoverSchema, request.body);
  if (!parsed.ok) return parsed.response;
  const caller = callerOf(request);
  // 인계는 PROJECT:update, 메일까지 보내려면 인계메일 권한도 (예전 '인계메일' 단추와 같은 권한).
  if (parsed.value.send && !hasPermission(caller, NEOTMS_PERMISSION_PROJECT_EMAIL)) {
    return permissionRefusal(NEOTMS_PERMISSION_PROJECT_EMAIL);
  }
  return sendJobHandover(caller, id, parsed.value, writeContext(request));
};

const handleListJobs: RRHandler = async (request) => listJobs(callerOf(request), request);

/** 작업 그룹 — 다음 코드 미리보기, [작업 그룹] 단추 (팀장님 2026-11-25). */
const handlePeekJobGroup: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? peekJobGroup(callerOf(request), id) : NOT_A_RECORD_ID;
};

const handleJobGroupAction: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(JobGroupActionSchema, request.body);
  return parsed.ok ? applyJobGroup(callerOf(request), id, parsed.value) : parsed.response;
};

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
    ? keepOwnEditsSeen(callerOf(request), { jobId: id }, () => updateJob(callerOf(request), id, parsed.value, writeContext(request)))
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
    ? keepOwnEditsSeen(callerOf(request), { jobId: parsed.value.jobId }, () => createPurchaseOrder(callerOf(request), parsed.value, writeContext(request)))
    : parsed.response;
};

const handleUpdatePurchaseOrder: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(PurchaseOrderUpdateSchema, request.body);
  return parsed.ok
    ? keepOwnEditsSeen(callerOf(request), { poId: id }, () => updatePurchaseOrder(callerOf(request), id, parsed.value, writeContext(request)))
    : parsed.response;
};

const handleDeletePurchaseOrder: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? keepOwnEditsSeen(callerOf(request), { poId: id }, () => deletePurchaseOrder(callerOf(request), id, writeContext(request))) : NOT_A_RECORD_ID;
};

/*
 * Payment - the translator invoice, PO approval, and PO settlement.
 *
 * All six are gated on `PAYMENT` rather than on `PURCHASE_ORDER`, and the two PO ones are the
 * reason the menu exists: `PATCH /purchase-orders/:id` cannot touch `po_approved` (no `PO_FIELDS`
 * spec) and cannot record money (not in `PoSettlementSchema`'s six columns under that gate), so
 * raising a PO and signing off its amount are two grants. NeotmsMenus.PAYMENT argues it at length.
 *
 * Note the paths. Approval and settlement are static trailing segments on the PO resource
 * (`/purchase-orders/:id/approval`) rather than routes of their own under `/payment/`, because they
 * act on a PO and the id in the path should say which. `recordId` reads `:id` the same way it does
 * for the plain PO routes, so nothing special is needed to find it.
 *
 * All three writes are PATCH. Approval would read better as a PUT - its body IS the complete state
 * of the resource, one boolean - but `ALLOWED_CORS_METHODS` deliberately does not list PUT, and
 * adding a method to the preflight for one route's semantics is a worse trade than the slight
 * imprecision: a verb the allow-list misses fails in the browser as a CORS error that mentions
 * nothing about the route.
 */
const handleListInvoices: RRHandler = async (request) => listInvoices(callerOf(request), request);

const handleGetInvoice: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? getInvoice(callerOf(request), id) : NOT_A_RECORD_ID;
};

const handleCreateInvoice: RRHandler = async (request) => {
  const parsed = parseBody(InvoiceTranslatorCreateSchema, request.body);
  return parsed.ok
    ? createInvoice(callerOf(request), parsed.value, writeContext(request))
    : parsed.response;
};

const handleUpdateInvoice: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(InvoiceTranslatorUpdateSchema, request.body);
  return parsed.ok
    ? updateInvoice(callerOf(request), id, parsed.value, writeContext(request))
    : parsed.response;
};

const handleDeleteInvoice: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deleteInvoice(callerOf(request), id, writeContext(request)) : NOT_A_RECORD_ID;
};

const handleApprovePurchaseOrder: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(PoApprovalSchema, request.body);
  return parsed.ok
    ? approvePurchaseOrder(callerOf(request), id, parsed.value, writeContext(request))
    : parsed.response;
};

const handleSettlePurchaseOrder: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(PoSettlementSchema, request.body);
  return parsed.ok
    ? settlePurchaseOrder(callerOf(request), id, parsed.value, writeContext(request))
    : parsed.response;
};

/* Reports. Gated on their own menu, not on the menus they aggregate. */
const handleRunReport: RRHandler = async (request) => runReport(callerOf(request), request);
const handleGetWorkload: RRHandler = async (request) => getWorkload(callerOf(request), request);

/*
 * Dashboard - the caller's own book, sales or PM.
 *
 * **Two handlers rather than one reading `?as=`.** Each carries its role as a literal, which is
 * what lets the two routes below declare a menu each: this API declares authorization only in the
 * route table and only per path, so a gate that varied by query parameter could not be declared
 * there at all. The role being un-forgeable is the second benefit - see NeotmsDashboardManager's
 * header.
 *
 * Gated on DASHBOARD_SALES / DASHBOARD_PM rather than on REPORT, which is the opposite of the two
 * routes above. The reasoning is in NeotmsMenus: a report aggregates other people's work within the
 * reader's scope and is its own privilege, while these aggregate only the reader's own projects and
 * are therefore not a wider view than the project list they sit beside.
 */
const handleGetSalesDashboard: RRHandler = async (request) =>
  getDashboard(callerOf(request), "sales");
const handleGetPmDashboard: RRHandler = async (request) => getDashboard(callerOf(request), "pm");

/*
 * 나의 업무 - the caller's own worksheet, and the custom columns on it.
 *
 * Six routes, and none of them writes a project, a job or a purchase order. Editing one of the
 * sheet's fourteen fixed columns is a PATCH to `/jobs/{id}` or `/purchase-orders/{id}`, sent by the
 * browser to the same endpoint the forms use - so the approval lock on a PO's translator, the
 * derived name columns, the job-type constraint and the row scope on each table all apply without
 * being written a second time. NeotmsWorkspaceManager's header has the full argument.
 *
 * All six are on WORKSPACE_READ, including the writes, because what they write is the caller's own
 * annotation layer rather than company data - the same reasoning that puts
 * `/me/recent-searches` on `anyStaff`. There is deliberately no WORKSPACE_UPDATE: it would be a
 * permission whose only effect is to stop somebody annotating their own sheet.
 */
const handleGetWorkspace: RRHandler = async (request) => getWorkspace(callerOf(request), request);

const handleCreateWorkspaceColumn: RRHandler = async (request) => {
  const parsed = parseBody(WorkspaceColumnSchema, request.body);
  return parsed.ok
    ? createWorkspaceColumn(callerOf(request), parsed.value, writeContext(request))
    : parsed.response;
};

const handleRenameWorkspaceColumn: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(WorkspaceColumnSchema, request.body);
  return parsed.ok
    ? renameWorkspaceColumn(callerOf(request), id, parsed.value)
    : parsed.response;
};

const handleDeleteWorkspaceColumn: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deleteWorkspaceColumn(callerOf(request), id) : NOT_A_RECORD_ID;
};

/*
 * A PUT on the collection, not on an id. The body is the whole order, so the request says "this is
 * how my columns are arranged" - which is one statement, one plan and one failure, where a PATCH
 * per moved column is three of each and no way back from the second one.
 */
const handleReorderWorkspaceColumns: RRHandler = async (request) => {
  const parsed = parseBody(WorkspaceColumnOrderSchema, request.body);
  return parsed.ok ? reorderWorkspaceColumns(callerOf(request), parsed.value) : parsed.response;
};

const handleWriteWorkspaceCell: RRHandler = async (request) => {
  const parsed = parseBody(WorkspaceCellSchema, request.body);
  return parsed.ok ? writeWorkspaceCell(callerOf(request), parsed.value) : parsed.response;
};

/*
 * Layout and styling. Both are PUTs carrying a whole state rather than a delta, for the same
 * reason: a drag moves several columns at once and a toolbar click paints a whole selection, so
 * the unit the user acted on is the unit the request should carry. A PATCH per column would be
 * several requests, several chances to fail halfway, and a sheet left in a state nobody chose.
 *
 * Still WORKSPACE_READ, like the rest: what these write is the caller's own view of their own
 * sheet. Nothing here touches a project, a job or a purchase order.
 */
const handleSetWorkspaceLayout: RRHandler = async (request) => {
  const parsed = parseBody(WorkspaceLayoutSchema, request.body);
  return parsed.ok ? setWorkspaceLayout(callerOf(request), parsed.value) : parsed.response;
};

const handleSetWorkspaceStyles: RRHandler = async (request) => {
  const parsed = parseBody(WorkspaceStyleApplySchema, request.body);
  return parsed.ok ? setWorkspaceStyles(callerOf(request), parsed.value) : parsed.response;
};

/*
 * The PM work sheet ("나의 업무" v2, pmsheet/). Sheet routes are WORKSPACE_READ like the PO-level
 * workspace: what they write is a sheet, and the TMS values a sheet edits go through the job and PO
 * endpoints with their own permissions. Handing a job over is a sales act on the project, so it is
 * PROJECT_UPDATE. Notices are anyStaff: the sales PM who receives "수정 요청" may hold no sheet.
 */
const handleGetPmSheet: RRHandler = async (request) => getPmSheet(callerOf(request), request);
const handleListPmStaff: RRHandler = async () => listPmStaff();
const handlePatchPmRow: RRHandler = async (request) => {
  const parsed = parseBody(PmRowPatchSchema, request.body);
  return parsed.ok ? patchPmRow(callerOf(request), parsed.value, writeContext(request)) : parsed.response;
};
const handleWritePmCells: RRHandler = async (request) => {
  const parsed = parseBody(PmCellsSchema, request.body);
  return parsed.ok ? writePmCells(callerOf(request), parsed.value, writeContext(request)) : parsed.response;
};
const handleConfirmPmSeen: RRHandler = async (request) => {
  const parsed = parseBody(PmSeenSchema, request.body);
  return parsed.ok ? confirmPmSeen(callerOf(request), parsed.value, writeContext(request)) : parsed.response;
};
const handleOrderPmRows: RRHandler = async (request) => {
  const parsed = parseBody(PmRowOrderSchema, request.body);
  return parsed.ok ? orderPmRows(callerOf(request), parsed.value, writeContext(request)) : parsed.response;
};
const handleReadMyPmPrefs: RRHandler = async (request) => readMyPmPrefs(callerOf(request));
const handleWritePmPref: RRHandler = async (request) => {
  const parsed = parseBody(PmPrefSchema, request.body);
  return parsed.ok
    ? writePmPref(callerOf(request), request.pathParams["kind"] ?? "", parsed.value)
    : parsed.response;
};
const handleListPendingHandovers: RRHandler = async (request) =>
  listPendingHandovers(callerOf(request), request);
const handleCreateHandovers: RRHandler = async (request) => {
  const parsed = parseBody(PmHandoverCreateSchema, request.body);
  return parsed.ok ? createHandovers(callerOf(request), parsed.value, writeContext(request)) : parsed.response;
};
const handleAnswerHandover: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(PmHandoverAnswerSchema, request.body);
  return parsed.ok ? answerHandover(callerOf(request), id, parsed.value, writeContext(request)) : parsed.response;
};
const handleListProjectHandovers: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? listProjectHandovers(id) : NOT_A_RECORD_ID;
};
const handleListNotices: RRHandler = async (request) => listNotices(callerOf(request));
const handleReadNotices: RRHandler = async (request) => {
  const parsed = parseBody(PmNoticesReadSchema, request.body);
  return parsed.ok ? readNotices(callerOf(request), parsed.value) : parsed.response;
};
const handleTranslatorSuggestions: RRHandler = async (request) => translatorSuggestions(request);

/*
 * Codes - the code tables, in two halves.
 *
 * The read is `anyStaff` and the writes are MAINTENANCE, which is the whole reason there are two
 * listings instead of one with a flag: 22 columns across the schema FK to `sys_code`, so every form
 * in the application needs this list to render its dropdowns, while deciding what the company's
 * subject-field taxonomy IS belongs to whoever runs the system.
 *
 * None of these take the caller. There is nothing row-scoped about a code table - a PM and a
 * director see the same subject-field list - so there is no WHERE clause for a scope to narrow.
 */
const handleListCodes: RRHandler = async () => listCodes();
const handleListCodesForAdmin: RRHandler = async () => listCodesForAdmin();

/*
 * FX rates - the current rate per currency.
 *
 * Takes no caller for the same reason the code listings do not: a rate is a fact about a currency,
 * the same one for everybody, with no row-level scope to apply.
 */
const handleListFxRates: RRHandler = async () => listFxRates();

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
 * Staff administration - the staff directory and role assignment.
 *
 * The two reads take no caller, for the reason given in NeotmsStaffAdminManager: a staff directory
 * is not row-scoped, and an administrator who could not see a pending request could not approve it.
 *
 * The PATCH is the one handler in this file that passes the caller for a reason other than scoping
 * or `created_by`. It needs to know who is asking so it can refuse a caller clearing their own role
 * or deactivating themselves - the one edit on this screen that cannot be undone from this screen.
 */
const handleListStaff: RRHandler = async () => listStaff();

/** The assignee pickers' list. The attribute is validated in the manager against a closed list. */
const handleListAssignableStaff: RRHandler = async (request) => listAssignableStaff(request);
const handleListRoles: RRHandler = async () => listRoles();

const handleUpdateStaff: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(StaffAdminUpdateSchema, request.body);
  return parsed.ok ? updateStaff(callerOf(request), id, parsed.value) : parsed.response;
};

/*
 * Recent searches - the caller's own suggestion list for the list screens.
 *
 * All three take the caller and nothing else identifies whose rows are touched, which is the whole
 * security story: there is no request shape that reads another person's searches, so there is
 * nothing to check for one.
 *
 * `anyStaff`, not a permission. Reading your own recent searches is not a privilege a role grants -
 * it is the same tier as `/api/v0/me`, which is why these live under that path.
 */
const handleListRecentSearches: RRHandler = async (request) =>
  listRecentSearches(callerOf(request));

const handleRecordSearch: RRHandler = async (request) => {
  const parsed = parseBody(RecentSearchRecordSchema, request.body);
  return parsed.ok ? recordSearch(callerOf(request), parsed.value) : parsed.response;
};

const handleForgetSearch: RRHandler = async (request) => {
  const parsed = parseBody(RecentSearchForgetSchema, request.body);
  return parsed.ok ? forgetSearch(callerOf(request), parsed.value) : parsed.response;
};

/*
 * Role administration - what a role MEANS, and what a person may BE named as.
 *
 * Every one of these is `superuser: true` rather than permission-gated, and the reason is on
 * `NeotmsRoute.superuser`: a gate made of permissions would be editable through the endpoint it
 * gates. The five writes here are the only statements in the API that touch `sys_role`,
 * `sys_role_permission` or `staff_attribute`.
 *
 * Three of them pass the caller, and not for scoping. `createRole` and the two set-the-set
 * endpoints need it for `created_by` - so a surprising grant can be traced to a person - and
 * `setStaffAttributes` needs it to refuse a caller removing their own superuser override.
 */
const handleListRolesForAdmin: RRHandler = async () => listRolesForAdmin();

const handleCreateRole: RRHandler = async (request) => {
  const parsed = parseBody(RoleAdminCreateSchema, request.body);
  return parsed.ok ? createRole(callerOf(request), parsed.value) : parsed.response;
};

const handleUpdateRole: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(RoleAdminUpdateSchema, request.body);
  return parsed.ok ? updateRole(id, parsed.value) : parsed.response;
};

const handleDeleteRole: RRHandler = async (request) => {
  const id = recordId(request);
  return id ? deleteRole(id) : NOT_A_RECORD_ID;
};

const handleSetRolePermissions: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(RolePermissionsSchema, request.body);
  return parsed.ok ? setRolePermissions(callerOf(request), id, parsed.value) : parsed.response;
};

const handleSetStaffAttributes: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(StaffAttributesSchema, request.body);
  return parsed.ok ? setStaffAttributes(callerOf(request), id, parsed.value) : parsed.response;
};

/*
 * The PO request mail, and the files it links to.
 *
 * `handleDownloadAttachment` is the odd one. It takes no caller, answers a 302 rather than a body,
 * and is reached by somebody outside the company - see `NeotmsRoute.publicRoute` for why that is
 * safe and what bounds it.
 *
 * The redirect is built by hand rather than through `ok`, because a `Location` header with a 302 is
 * the entire response: a body on a redirect is read by nothing and would only be a place for the
 * presigned URL to leak into a log.
 */
const handleCreateAttachmentUpload: RRHandler = async (request) => {
  const parsed = parseBody(AttachmentUploadSchema, request.body);
  return parsed.ok ? createUpload(callerOf(request), parsed.value) : parsed.response;
};

const handleDownloadAttachment: RRHandler = async (request) => {
  const token = request.pathParams?.["token"];
  if (!token) return { status: 404, body: "No such file" };

  const resolved = await resolveDownload(token);
  if (resolved.status !== 200) return resolved as ResponseData<string>;

  return {
    status: 302,
    headers: {
      Location: (resolved.body as { location: string }).location,
      /*
       * A redirect to a presigned URL must never be cached. A shared or proxy cache holding this
       * would serve one translator's 60-second URL to the next request for the same token, and a
       * browser holding it would keep following a URL that stopped working a minute later.
       */
      "Cache-Control": "no-store, max-age=0",
      /*
       * No referrer on the hop to S3. Without this the presigned URL's host sees this system's URL
       * - token and all - in the `Referer` header, which puts a working download link into
       * somebody else's access log.
       */
      "Referrer-Policy": "no-referrer",
    },
    body: "",
  };
};

const handleSendPoRequestMail: RRHandler = async (request) => {
  const id = recordId(request);
  if (!id) return NOT_A_RECORD_ID;
  const parsed = parseBody(PoRequestMailSchema, request.body);
  return parsed.ok ? sendPoRequestMail(callerOf(request), id, parsed.value) : parsed.response;
};

/* -------------------------------------------------------------------------- */
/* The routing table                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One route: how to reach it, what to run, and what it may require.
 *
 * Exactly one of `permission`, `superuser`, `anyStaff` and `account` is what authorizes a route.
 * All four are optional in the type only so that the session routes - unauthenticated, belonging
 * to no permission - can be declared in the same array; `routeAllows` refuses an authenticated
 * route that declares none of them, because that is what a route whose author forgot looks like.
 */
export type NeotmsRoute = {
  path: string;
  method: string;
  handler: RRHandler;
  /**
   * The single permission this route requires.
   *
   * One name rather than the `menu` + `action` pair this used to be. The pair could not say what
   * two of these routes actually need: approving a purchase order had to borrow the payment
   * menu's `update`, which is also what records a payment, and the project handover mail had to
   * borrow `PROJECT:read`, so anyone who could open a project could mail its contents out. Both
   * now name a permission of their own.
   */
  permission?: NeotmsPermission;
  /**
   * Only a superuser may call this - `NeotmsCaller.isSuperuser`, which is the
   * `NEOTMS_USER_ATTRIBUTE_SUPERUSER` attribute or the bootstrap authority.
   *
   * It exists because role administration cannot be gated on a permission without the gate being
   * editable through the thing it gates. `NEOTMS_PERMISSION_STAFF_UPDATE` is the closest candidate
   * and it is not good enough: a role holding it could grant itself every other permission in one
   * request, so the only thing standing between a staff administrator and the whole system would be
   * that nobody thought to try. The superuser flag is not grantable from inside the application at
   * all, which is the property that makes it the right gate for editing grants.
   *
   * Everything that writes `sys_role`, `sys_role_permission` or `staff_attribute` carries this. The
   * staff screens that merely READ roles stay on `NEOTMS_PERMISSION_STAFF_READ`: who holds which
   * role is a staff administrator's daily business, and only deciding what a role MEANS is reserved.
   */
  superuser?: true;
  /**
   * Every signed-in staff member may call this, whatever their role grants.
   *
   * Two routes carry it, and the test each had to pass is the same: a form in the application
   * cannot render without it, and what it discloses is not worth gating.
   *
   *   * `GET /api/v0/codes` - the code tables. Subject fields, work types, pricing units and
   *     languages fill dropdowns on every form, so gating this on MAINTENANCE would leave a PM with
   *     the right to create a customer looking at empty dropdowns. Reading a list of category names
   *     is not a privilege; deciding what is IN the list is, and that is the `/admin/codes` half.
   *   * `GET /api/v0/fx-rates` - the current rate per currency. The job and PO forms convert a
   *     foreign-currency total to KRW on the client, so without this the convert-to-KRW button
   *     cannot show the figure it is about to commit. An exchange rate published daily by a state
   *     bank is not company information, so there is nothing here to protect.
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
  /**
   * NOBODY IS ASKED TO SIGN IN. One route carries this, and it is the only unauthenticated
   * endpoint in the API.
   *
   * `GET /api/v0/attachments/:token` is clicked by a translator, in a mail, on a machine that has
   * never heard of NEOTMS. There is no account to require: inventing one would mean asking
   * somebody outside the company to register with a system in order to read a file that was
   * deliberately mailed to them.
   *
   * The token IS the authorization, and what that buys is bounded on every side:
   *
   *   * 256 bits from `randomBytes`, so it cannot be guessed or enumerated.
   *   * One row, naming one object key that the SERVER chose at upload time. Nothing in the
   *     request can widen it, list a bucket or traverse a path.
   *   * A 21-day TTL, checked in the handler as well as swept by DynamoDB - which deletes within
   *     ~48h of the timestamp rather than at it, so absence alone would be two days too generous.
   *   * Revocable: deleting the row kills the link, which is the property that chose this design
   *     over a CloudFront signed URL.
   *
   * It answers a redirect, never bytes. The only thing it discloses is a 60-second presigned URL
   * for the one file the token names.
   */
  publicRoute?: true;
};

const CUSTOMERS = "/api/v0/customers";
const TRANSLATORS = "/api/v0/translators";
const PROJECTS = "/api/v0/projects";
const JOBS = "/api/v0/jobs";
const PURCHASE_ORDERS = "/api/v0/purchase-orders";
/*
 * Payment - the translator invoices.
 *
 * `/invoices` rather than `/payment/invoices`, even though the menu is PAYMENT. The path names the
 * RESOURCE and the route's `menu` names the authority, and conflating them would make the URL a
 * second, undeclared statement of who may call it - which is the shape that goes stale. The PO's
 * own two money actions stay on `/purchase-orders/:id/...` for the same reason: they act on a PO.
 *
 * `/invoices` and not `/translator-invoices`, because the customer side of the chain
 * (`invoice_customer`) has no endpoints and is not planned to get any under this menu - it is
 * receivables, a different screen and a different authority. If it ever does, this becomes
 * `/invoices/translator` and `/invoices/customer`, and the rename is a one-line change here plus
 * the client's base path.
 */
const INVOICES = "/api/v0/invoices";
/*
 * The code tables under two paths, deliberately.
 *
 * `/api/v0/codes` is the dropdown feed and `/api/v0/admin/codes` is the maintenance screen, and
 * they are two paths rather than one path with five methods because the authorization differs by
 * HTTP verb otherwise - which is a shape this routing table can express but a reader cannot audit
 * at a glance. With the split, "which endpoints need MAINTENANCE" is answered by reading one
 * prefix.
 */
const CODES = "/api/v0/codes";
const ADMIN_CODES = "/api/v0/admin/codes";
/*
 * The rate table. Read-only, and the second route on the `anyStaff` tier.
 *
 * There is deliberately no `/api/v0/admin/fx-rates` to go with it. The maintenance screen edits the
 * company's own taxonomy; an exchange rate is an upstream fact, and the one legitimate reason to
 * write one by hand - correcting a day the fetcher got wrong - moves every open position's reported
 * worth at once. That belongs in SQL, where it is deliberate, not behind a form.
 */
const FX_RATES = "/api/v0/fx-rates";
/*
 * Both under `/admin/`, both gated on STAFF, including the role listing.
 *
 * `/admin/roles` could have been `anyStaff` - a role's name is not a secret, and the sidebar
 * already tells the caller their own role. It is gated anyway because nothing except the staff
 * administration screen reads it: an endpoint whose only consumer is an admin screen should be
 * reachable only from that screen, so that "who can enumerate the company's privilege tiers" stays
 * a question with a short answer. If a future screen needs role names for a non-admin audience,
 * that is the moment to split it the way `/codes` and `/admin/codes` are split - not before.
 */
const ADMIN_STAFF = "/api/v0/admin/staff";
/**
 * The caller's own recent search terms. Under `/me/` because that is what the path means here -
 * the row set is chosen by who is asking, not by a permission.
 */
/**
 * Files mailed to a translator.
 *
 * `/attachments/:token` is deliberately short and deliberately not under `/me/` or `/admin/`: it is
 * the URL that goes in a mail to somebody outside the company, and it will be read by people
 * deciding whether to trust it.
 */
const ATTACHMENTS = "/api/v0/attachments";
const ATTACHMENT_UPLOADS = "/api/v0/attachments/uploads";
const RECENT_SEARCHES = "/api/v0/me/recent-searches";
const WORKSPACE = "/api/v0/workspace";
const WORKSPACE_COLUMNS = "/api/v0/workspace/columns";
const WORKSPACE_CELLS = "/api/v0/workspace/cells";
const WORKSPACE_LAYOUT = "/api/v0/workspace/layout";
const WORKSPACE_STYLES = "/api/v0/workspace/styles";
const ADMIN_ROLES = "/api/v0/admin/roles";
/**
 * The role administration listing: every role, its grants, and how many people hold it.
 *
 * A path of its own rather than a flag on `ADMIN_ROLES`, because the two have different audiences
 * and different authorization - the same reason `/codes` and `/admin/codes` are two paths. A query
 * parameter that widens a response is a parameter somebody eventually sets.
 */
const ADMIN_ROLE_GRANTS = "/api/v0/admin/role-grants";

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

  // -- Codes (dropdowns; authenticated, no menu) ----------------------------
  { path: CODES, method: "GET", handler: handleListCodes, anyStaff: true },

  // -- FX rates (the job and PO forms' conversion button) -------------------
  //
  // The second and last `anyStaff` route. A PM entitled to create a job must be able to price it in
  // USD, so this is in the same category as the dropdown feed: something no form can render
  // without.
  { path: FX_RATES, method: "GET", handler: handleListFxRates, anyStaff: true },

  // -- Customers ------------------------------------------------------------
  { path: CUSTOMERS, method: "GET", handler: handleListCustomers, permission: NEOTMS_PERMISSION_CUSTOMER_READ },
  { path: CUSTOMERS, method: "POST", handler: handleCreateCustomer, permission: NEOTMS_PERMISSION_CUSTOMER_CREATE },
  { path: `${CUSTOMERS}/:id`, method: "GET", handler: handleGetCustomer, permission: NEOTMS_PERMISSION_CUSTOMER_READ },
  { path: `${CUSTOMERS}/:id`, method: "PATCH", handler: handleUpdateCustomer, permission: NEOTMS_PERMISSION_CUSTOMER_UPDATE },
  { path: `${CUSTOMERS}/:id`, method: "DELETE", handler: handleDeleteCustomer, permission: NEOTMS_PERMISSION_CUSTOMER_DELETE },

  // -- Translators ----------------------------------------------------------
  { path: TRANSLATORS, method: "GET", handler: handleListTranslators, permission: NEOTMS_PERMISSION_TRANSLATOR_READ },
  { path: TRANSLATORS, method: "POST", handler: handleCreateTranslator, permission: NEOTMS_PERMISSION_TRANSLATOR_CREATE },
  { path: `${TRANSLATORS}/:id`, method: "GET", handler: handleGetTranslator, permission: NEOTMS_PERMISSION_TRANSLATOR_READ },
  { path: `${TRANSLATORS}/:id`, method: "PATCH", handler: handleUpdateTranslator, permission: NEOTMS_PERMISSION_TRANSLATOR_UPDATE },
  { path: `${TRANSLATORS}/:id`, method: "DELETE", handler: handleDeleteTranslator, permission: NEOTMS_PERMISSION_TRANSLATOR_DELETE },

  // -- Projects -------------------------------------------------------------
  { path: PROJECTS, method: "GET", handler: handleListProjects, permission: NEOTMS_PERMISSION_PROJECT_READ },
  { path: PROJECTS, method: "POST", handler: handleCreateProject, permission: NEOTMS_PERMISSION_PROJECT_CREATE },
  { path: `${PROJECTS}/:id`, method: "GET", handler: handleGetProject, permission: NEOTMS_PERMISSION_PROJECT_READ },
  { path: `${PROJECTS}/:id`, method: "PATCH", handler: handleUpdateProject, permission: NEOTMS_PERMISSION_PROJECT_UPDATE },
  { path: `${PROJECTS}/:id`, method: "DELETE", handler: handleDeleteProject, permission: NEOTMS_PERMISSION_PROJECT_DELETE },
  // Handover mail. A static trailing segment on the project resource, like
  // `/purchase-orders/:id/approval` above - the id in the path says which project is being handed
  // over. POST rather than PATCH because it changes nothing here; it performs an act whose result
  // is a mail, not a row.
  { path: `${PROJECTS}/:id/handover-mail`, method: "POST", handler: handleSendHandoverMail, permission: NEOTMS_PERMISSION_PROJECT_EMAIL },
  { path: `${PROJECTS}/:id/handover`, method: "POST", handler: handleJobHandover, permission: NEOTMS_PERMISSION_PROJECT_UPDATE },
  { path: `${PROJECTS}/:id/job-groups/next`, method: "GET", handler: handlePeekJobGroup, permission: NEOTMS_PERMISSION_JOB_CREATE },
  { path: `${PROJECTS}/:id/job-groups`, method: "POST", handler: handleJobGroupAction, permission: NEOTMS_PERMISSION_JOB_UPDATE },
  // Acceptance. `PROJECT_READ` deliberately - see the handler for why the gate is the row and not
  // the permission.
  { path: `${PROJECTS}/:id/acceptance`, method: "POST", handler: handleSetProjectAcceptance, permission: NEOTMS_PERMISSION_PROJECT_READ },
  { path: `${PROJECTS}/:id/acceptance/again`, method: "POST", handler: handleRequestProjectAcceptanceAgain, permission: NEOTMS_PERMISSION_PROJECT_UPDATE },

  // -- Jobs (revenue) -------------------------------------------------------
  { path: JOBS, method: "GET", handler: handleListJobs, permission: NEOTMS_PERMISSION_JOB_READ },
  { path: JOBS, method: "POST", handler: handleCreateJob, permission: NEOTMS_PERMISSION_JOB_CREATE },
  { path: `${JOBS}/:id`, method: "GET", handler: handleGetJob, permission: NEOTMS_PERMISSION_JOB_READ },
  { path: `${JOBS}/:id`, method: "PATCH", handler: handleUpdateJob, permission: NEOTMS_PERMISSION_JOB_UPDATE },
  { path: `${JOBS}/:id`, method: "DELETE", handler: handleDeleteJob, permission: NEOTMS_PERMISSION_JOB_DELETE },

  // -- Purchase orders (cost) -----------------------------------------------
  { path: PURCHASE_ORDERS, method: "GET", handler: handleListPurchaseOrders, permission: NEOTMS_PERMISSION_PO_READ },
  { path: PURCHASE_ORDERS, method: "POST", handler: handleCreatePurchaseOrder, permission: NEOTMS_PERMISSION_PO_CREATE },
  { path: `${PURCHASE_ORDERS}/:id`, method: "GET", handler: handleGetPurchaseOrder, permission: NEOTMS_PERMISSION_PO_READ },
  { path: `${PURCHASE_ORDERS}/:id`, method: "PATCH", handler: handleUpdatePurchaseOrder, permission: NEOTMS_PERMISSION_PO_UPDATE },
  { path: `${PURCHASE_ORDERS}/:id`, method: "DELETE", handler: handleDeletePurchaseOrder, permission: NEOTMS_PERMISSION_PO_DELETE },

  // -- Payment (approval, settlement, translator invoices) ------------------
  //
  // Every row here is PAYMENT, and the two on the PO resource are why. A PO's amounts are edited on
  // PURCHASE_ORDER:update above; approving that amount and recording the money that left are this
  // menu's `update`. Same resource, same id, different grant - which is only expressible as
  // separate routes, because this table declares authorization per path.
  //
  // The permissions are the ones NeotmsMenus.PAYMENT documents: `INVOICE_READ` sees the screens and
  // the printable documents, `PO_APPROVE` signs off a purchase order, `INVOICE_UPDATE` settles one,
  // `INVOICE_CREATE` issues an invoice and `INVOICE_DELETE` voids one.
  { path: `${PURCHASE_ORDERS}/:id/approval`, method: "PATCH", handler: handleApprovePurchaseOrder, permission: NEOTMS_PERMISSION_PO_APPROVE },
  { path: `${PURCHASE_ORDERS}/:id/settlement`, method: "PATCH", handler: handleSettlePurchaseOrder, permission: NEOTMS_PERMISSION_INVOICE_UPDATE },
  { path: INVOICES, method: "GET", handler: handleListInvoices, permission: NEOTMS_PERMISSION_INVOICE_READ },
  { path: INVOICES, method: "POST", handler: handleCreateInvoice, permission: NEOTMS_PERMISSION_INVOICE_CREATE },
  { path: `${INVOICES}/:id`, method: "GET", handler: handleGetInvoice, permission: NEOTMS_PERMISSION_INVOICE_READ },
  { path: `${INVOICES}/:id`, method: "PATCH", handler: handleUpdateInvoice, permission: NEOTMS_PERMISSION_INVOICE_UPDATE },
  { path: `${INVOICES}/:id`, method: "DELETE", handler: handleDeleteInvoice, permission: NEOTMS_PERMISSION_INVOICE_DELETE },

  // -- Reports --------------------------------------------------------------
  //
  // Both are GETs with their parameters in the query string, so a report a manager cares about can
  // be bookmarked and mailed to a colleague - which is what people currently do with screenshots.
  { path: "/api/v0/reports/summary", method: "GET", handler: handleRunReport, permission: NEOTMS_PERMISSION_REPORT_READ },
  { path: "/api/v0/reports/workload", method: "GET", handler: handleGetWorkload, permission: NEOTMS_PERMISSION_REPORT_READ },

  // -- Dashboards -----------------------------------------------------------
  //
  // A path and a menu per role, not one path with `?as=sales|pm`. This is the only table in which
  // this API says who may call what, and it says it per path - so "a person sees the dashboard that
  // matches their position" has to be two rows here or it is not expressible at all. Neither is
  // REPORT: both screens are the caller's own projects' arithmetic and nothing they could not
  // already open one record at a time. Argued in NeotmsMenus and NeotmsDashboardManager.
  //
  // Static trailing segments, like `/reports/summary` above - not `:id` params, so there is no
  // collision with `recordId` and nothing for rou3 to disambiguate.
  { path: "/api/v0/dashboard/sales", method: "GET", handler: handleGetSalesDashboard, permission: NEOTMS_PERMISSION_DASHBOARD_SALES_READ },
  { path: "/api/v0/dashboard/pm", method: "GET", handler: handleGetPmDashboard, permission: NEOTMS_PERMISSION_DASHBOARD_PM_READ },

  // 나의 업무. The reorder is a PUT on the collection and the rename a PATCH on an id, so no
  // static segment ever has to compete with `:id` for a match. See the handlers above.
  { path: WORKSPACE, method: "GET", handler: handleGetWorkspace, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: WORKSPACE_COLUMNS, method: "POST", handler: handleCreateWorkspaceColumn, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: WORKSPACE_COLUMNS, method: "PUT", handler: handleReorderWorkspaceColumns, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: `${WORKSPACE_COLUMNS}/:id`, method: "PATCH", handler: handleRenameWorkspaceColumn, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: `${WORKSPACE_COLUMNS}/:id`, method: "DELETE", handler: handleDeleteWorkspaceColumn, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: WORKSPACE_CELLS, method: "PUT", handler: handleWriteWorkspaceCell, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: WORKSPACE_LAYOUT, method: "PUT", handler: handleSetWorkspaceLayout, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: WORKSPACE_STYLES, method: "PUT", handler: handleSetWorkspaceStyles, permission: NEOTMS_PERMISSION_WORKSPACE_READ },

  // -- PM work sheet (나의 업무 v2, per JOB) ----------------------------------
  { path: "/api/v0/pm-sheet", method: "GET", handler: handleGetPmSheet, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/staff", method: "GET", handler: handleListPmStaff, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/rows", method: "PUT", handler: handlePatchPmRow, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/cells", method: "PUT", handler: handleWritePmCells, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/rows/order", method: "PUT", handler: handleOrderPmRows, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/seen", method: "POST", handler: handleConfirmPmSeen, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/prefs", method: "GET", handler: handleReadMyPmPrefs, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/prefs/:kind", method: "PUT", handler: handleWritePmPref, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/handovers", method: "GET", handler: handleListPendingHandovers, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/handovers", method: "POST", handler: handleCreateHandovers, permission: NEOTMS_PERMISSION_PROJECT_UPDATE },
  { path: "/api/v0/pm-sheet/handovers/:id/answer", method: "POST", handler: handleAnswerHandover, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: "/api/v0/pm-sheet/translator-suggestions", method: "GET", handler: handleTranslatorSuggestions, permission: NEOTMS_PERMISSION_WORKSPACE_READ },
  { path: `${PROJECTS}/:id/job-handovers`, method: "GET", handler: handleListProjectHandovers, permission: NEOTMS_PERMISSION_PROJECT_READ },
  { path: "/api/v0/me/notices", method: "GET", handler: handleListNotices, anyStaff: true },
  { path: "/api/v0/me/notices/read", method: "POST", handler: handleReadNotices, anyStaff: true },

  // -- Maintenance (the code tables) ----------------------------------------
  //
  // There is no `/admin/codes/:id` GET. The listing returns every code including the inactive ones
  // and the whole table is about sixty short rows, so a per-row read would only ever be used to
  // re-fetch something the client already has.
  { path: ADMIN_CODES, method: "GET", handler: handleListCodesForAdmin, permission: NEOTMS_PERMISSION_MAINTENANCE_READ },
  { path: ADMIN_CODES, method: "POST", handler: handleCreateCode, permission: NEOTMS_PERMISSION_MAINTENANCE_CREATE },
  { path: `${ADMIN_CODES}/:id`, method: "PATCH", handler: handleUpdateCode, permission: NEOTMS_PERMISSION_MAINTENANCE_UPDATE },
  { path: `${ADMIN_CODES}/:id`, method: "DELETE", handler: handleDeleteCode, permission: NEOTMS_PERMISSION_MAINTENANCE_DELETE },

  // -- Staff administration (staff and roles) -------------------------------
  //
  // There is no POST and no DELETE here, and both absences are deliberate.
  //
  // No POST: an administrator cannot create a staff row. A staff row needs an `lpx_sub` to be
  // usable, so an admin-side INSERT would have to invent one - and a row with a made-up or absent
  // subject is either dead weight or claimable by whoever next signs in with a matching email. Rows
  // arrive from the legacy ETL or from `staff_self_register()`; the admin's job is to APPROVE,
  // which is the PATCH.
  //
  // No DELETE: every historical project, job and purchase order carries this person's `mgr_id` in
  // `created_by`. Deactivating (`active: false`) is the supported way to end somebody's access and
  // is reachable through the PATCH. Soft-deleting a staff row is a database statement on purpose,
  // so that "remove an employee" is not a button next to "change their role".
  // The two assignee pickers on the project form. `anyStaff`, like the code and FX lists - see the
  // header of NeotmsAssignableManager for why a permission would have to be a union of three.
  { path: "/api/v0/staff/assignable", method: "GET", handler: handleListAssignableStaff, anyStaff: true },
  { path: ADMIN_STAFF, method: "GET", handler: handleListStaff, permission: NEOTMS_PERMISSION_STAFF_READ },
  { path: `${ADMIN_STAFF}/:id`, method: "PATCH", handler: handleUpdateStaff, permission: NEOTMS_PERMISSION_STAFF_UPDATE },
  { path: ADMIN_ROLES, method: "GET", handler: handleListRoles, permission: NEOTMS_PERMISSION_STAFF_READ },

  // -- The PO request mail, and its attachments ------------------------------
  //
  // The upload is gated on NEOTMS_PERMISSION_PO_EMAIL rather than on PO_UPDATE, because the only
  // thing it is for is composing this mail: somebody who may edit a PO but not mail it has no use
  // for a presigned PUT into the attachment bucket.
  //
  // The download is the one unauthenticated route in this table. Everything about why that is
  // acceptable is on `NeotmsRoute.publicRoute`; what matters here is that it is a GET, answers a
  // redirect, and names a token rather than a key.
  { path: `${PURCHASE_ORDERS}/:id/request-mail`, method: "POST", handler: handleSendPoRequestMail, permission: NEOTMS_PERMISSION_PO_EMAIL },
  { path: ATTACHMENT_UPLOADS, method: "POST", handler: handleCreateAttachmentUpload, permission: NEOTMS_PERMISSION_PO_EMAIL },
  { path: `${ATTACHMENTS}/:token`, method: "GET", handler: handleDownloadAttachment, publicRoute: true },

  // -- Recent searches (the caller's own) -----------------------------------
  //
  // Under `/me/`, with the other endpoint that answers "about the person asking". `anyStaff` is
  // the right tier for the reason given on the handlers: this is one person's own convenience
  // data, not company data a role grants access to.
  //
  // The DELETE carries a body, which is unusual and deliberate. The alternative is the term in the
  // path - `DELETE /me/recent-searches/projects/현대차` - and a search term in a URL is a search
  // term in the access log, in the browser history and in any proxy in between. The terms are
  // what somebody typed while looking for a customer's work; they belong in a body.
  { path: RECENT_SEARCHES, method: "GET", handler: handleListRecentSearches, anyStaff: true },
  { path: RECENT_SEARCHES, method: "POST", handler: handleRecordSearch, anyStaff: true },
  { path: RECENT_SEARCHES, method: "DELETE", handler: handleForgetSearch, anyStaff: true },

  // -- Role administration (superuser only) ---------------------------------
  //
  // The two tiers on one path are deliberate. `GET /admin/roles` lists role NAMES for the
  // assignment dropdown and stays on STAFF_READ, because handing somebody an existing role is a
  // staff administrator's daily business. Everything that decides what a role MEANS is
  // `superuser: true`, because a role that could edit grants could grant itself anything -
  // see NeotmsRoute.superuser.
  //
  // `/admin/role-grants` is a second READ of the same resource rather than a parameter on the
  // first, the way `/codes` and `/admin/codes` are split: it returns each role's permission list
  // and how many people hold it, which the dropdown has no use for and should not be made to
  // carry on every refresh of the staff screen.
  //
  // The two set-the-set endpoints are PATCH, though their bodies ARE the complete set and PUT
  // would read better. Same trade the PO approval route records above: `ALLOWED_CORS_METHODS`
  // deliberately omits PUT, and a verb the allow-list misses fails in the browser as a CORS error
  // naming nothing about the route. The replace-the-whole-set contract is carried by the schema
  // and by the `/permissions` and `/attributes` path segments instead.
  //
  // What the contract rules out is the shape a PATCH invites - "add this one permission" - because
  // that puts the diff in the client, and two administrators editing one role in two tabs would
  // then produce the union of their intentions rather than one of them winning.
  { path: ADMIN_ROLE_GRANTS, method: "GET", handler: handleListRolesForAdmin, superuser: true },
  { path: ADMIN_ROLES, method: "POST", handler: handleCreateRole, superuser: true },
  { path: `${ADMIN_ROLES}/:id`, method: "PATCH", handler: handleUpdateRole, superuser: true },
  { path: `${ADMIN_ROLES}/:id`, method: "DELETE", handler: handleDeleteRole, superuser: true },
  { path: `${ADMIN_ROLES}/:id/permissions`, method: "PATCH", handler: handleSetRolePermissions, superuser: true },
  { path: `${ADMIN_STAFF}/:id/attributes`, method: "PATCH", handler: handleSetStaffAttributes, superuser: true },
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
  // Listed first so the tiers are visible in one place, though `handleRequest` branches on
  // `publicRoute` and `account` before it gets here - neither has a caller to check.
  if (route.publicRoute) return null;
  if (route.account) return null;
  if (route.anyStaff) return null;
  /*
   * Before the permission check, not after, and not as a permission of its own: a superuser route
   * names no permission, so asking `hasPermission` first would hit the "declares no permission"
   * refusal below and answer 403 for everybody including the superuser.
   */
  if (route.superuser) {
    return caller.isSuperuser
      ? null
      : {
          status: 403,
          body:
            "This action is reserved for a system administrator. Editing what a role permits is " +
            "not itself a role permission - see NeotmsRoute.superuser.",
        };
  }
  if (!route.permission) {
    console.error(`The route ${route.method} ${route.path} declares no permission; refusing.`);
    return { status: 403, body: "This endpoint is not configured for authorization" };
  }
  return hasPermission(caller, route.permission)
    ? null
    : permissionRefusal(route.permission);
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
  /*
   * The unauthenticated tier, before anything is asked of the request.
   *
   * It sits above the account branch because it needs even less: no token, no cookie, no identity.
   * Everything this route may do is decided by the token in its path, and the reasoning for that
   * is on `NeotmsRoute.publicRoute`.
   */
  if (route.publicRoute) {
    return withCors(await route.handler(routed));
  }

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
