// SPDX-License-Identifier: MIT
//
// What a person may DO, and what a person may BE. The two are separate questions and this file
// answers both, because the second one has no answer anywhere else in the system.
//
// ## Permissions - what may be done
//
// A flat list of strings. One per (domain, action), checked by name: a route declares the single
// permission it requires and `hasPermission` asks whether the caller holds it.
//
// This replaced an 11-menu x 5-action matrix (`sys_role_auth.role_1`..`role_5`), and the reason is
// that the matrix could not say two of the things this application actually needs to say.
// Approving the money on a purchase order had to borrow the payment menu's `update` bit, so "may
// sign off an amount" and "may record that it was paid" were one grant that could not be split.
// Sending a project's handover mail had to borrow `PROJECT:read`, so anyone who could open a
// project could mail its contents out. Both are their own permission here. The matrix also carried
// a fifth action nobody could name - the columns are `role_1`..`role_5` and the mapping to
// read/create/update/delete/export was a documented guess.
//
// NEOTMS OWNS THESE. They are granted on the 사용자 관리 screen and stored in `sys_role_permission`.
// The account system is asked one question only - may this account open NEOTMS at all - and the
// answer says nothing about which screens or which rows. That boundary is what makes a revocation
// take effect immediately rather than when a cached authority list expires.
//
// ## Attributes - what may be BORNE
//
// Separate from permissions, and the distinction is the point. `PROJECT_UPDATE` says a person may
// edit a project. `NEOTMS_USER_ATTRIBUTE_PM` says a person may be NAMED as one - it is a property
// of the human, not a right over a screen, and the project form reads it to decide who can appear
// in its 담당PM picker.
//
// They are not mutually exclusive: somebody can hold both, sell the work and run it, and name
// themselves in both columns of the same project. Nothing here prevents that, because the business
// does it.

/* -------------------------------------------------------------------------- */
/* Permissions                                                                */
/* -------------------------------------------------------------------------- */

/* 프로젝트 - the project header, and the entry point of the revenue chain. */
export const NEOTMS_PERMISSION_PROJECT_READ = "NEOTMS_PERMISSION_PROJECT_READ";
export const NEOTMS_PERMISSION_PROJECT_CREATE = "NEOTMS_PERMISSION_PROJECT_CREATE";
export const NEOTMS_PERMISSION_PROJECT_UPDATE = "NEOTMS_PERMISSION_PROJECT_UPDATE";
export const NEOTMS_PERMISSION_PROJECT_DELETE = "NEOTMS_PERMISSION_PROJECT_DELETE";
/**
 * Send a project's handover mail to its operating PM.
 *
 * Its own permission rather than a reading of `PROJECT_READ`, which is what it used to borrow. The
 * mail carries the customer, the languages, the deadline and the project's notes out of the system
 * to an address the sender types, and "may look at this project" is not the same decision.
 */
export const NEOTMS_PERMISSION_PROJECT_EMAIL = "NEOTMS_PERMISSION_PROJECT_EMAIL";

/* 작업 - jobs. Revenue is booked here. */
export const NEOTMS_PERMISSION_JOB_READ = "NEOTMS_PERMISSION_JOB_READ";
/**
 * NOTE: the value is `..._JOB_CREATE`, matching the constant.
 *
 * It read `NEOTMS_PERMISSION_JOB_WRITE` when this file was first written - a copy-paste that left
 * the only permission in the set whose name and value disagreed. Harmless while nothing had been
 * granted; a permission nobody could grant under the name the code used once anything had.
 */
export const NEOTMS_PERMISSION_JOB_CREATE = "NEOTMS_PERMISSION_JOB_CREATE";
export const NEOTMS_PERMISSION_JOB_UPDATE = "NEOTMS_PERMISSION_JOB_UPDATE";
export const NEOTMS_PERMISSION_JOB_DELETE = "NEOTMS_PERMISSION_JOB_DELETE";

/* 발주 - purchase orders. Cost is booked here. */
export const NEOTMS_PERMISSION_PO_READ = "NEOTMS_PERMISSION_PO_READ";
export const NEOTMS_PERMISSION_PO_CREATE = "NEOTMS_PERMISSION_PO_CREATE";
export const NEOTMS_PERMISSION_PO_UPDATE = "NEOTMS_PERMISSION_PO_UPDATE";
export const NEOTMS_PERMISSION_PO_DELETE = "NEOTMS_PERMISSION_PO_DELETE";
/**
 * Sign off the amount on a purchase order, or revoke that sign-off.
 *
 * Deliberately NOT implied by `PO_UPDATE`. A PM who may correct a word count is not thereby
 * somebody who may approve what it costs - that separation is the entire purpose of the approval
 * gate, and under the old matrix it did not exist: approval borrowed the payment menu's update bit,
 * which is also what records a payment.
 */
export const NEOTMS_PERMISSION_PO_APPROVE = "NEOTMS_PERMISSION_PO_APPROVE";
/** Send a purchase order to a translator. No feature behind it yet. */
export const NEOTMS_PERMISSION_PO_EMAIL = "NEOTMS_PERMISSION_PO_EMAIL";

/* 번역가 - the translator/vendor master. */
export const NEOTMS_PERMISSION_TRANSLATOR_READ = "NEOTMS_PERMISSION_TRANSLATOR_READ";
export const NEOTMS_PERMISSION_TRANSLATOR_CREATE = "NEOTMS_PERMISSION_TRANSLATOR_CREATE";
export const NEOTMS_PERMISSION_TRANSLATOR_UPDATE = "NEOTMS_PERMISSION_TRANSLATOR_UPDATE";
export const NEOTMS_PERMISSION_TRANSLATOR_DELETE = "NEOTMS_PERMISSION_TRANSLATOR_DELETE";

/* 결제 - translator invoices and the money that moves against them. */
export const NEOTMS_PERMISSION_INVOICE_READ = "NEOTMS_PERMISSION_INVOICE_READ";
export const NEOTMS_PERMISSION_INVOICE_CREATE = "NEOTMS_PERMISSION_INVOICE_CREATE";
export const NEOTMS_PERMISSION_INVOICE_UPDATE = "NEOTMS_PERMISSION_INVOICE_UPDATE";
export const NEOTMS_PERMISSION_INVOICE_DELETE = "NEOTMS_PERMISSION_INVOICE_DELETE";

/* 고객사 - the customer master. Shared company-wide; not row-scoped. */
export const NEOTMS_PERMISSION_CUSTOMER_READ = "NEOTMS_PERMISSION_CUSTOMER_READ";
export const NEOTMS_PERMISSION_CUSTOMER_CREATE = "NEOTMS_PERMISSION_CUSTOMER_CREATE";
export const NEOTMS_PERMISSION_CUSTOMER_UPDATE = "NEOTMS_PERMISSION_CUSTOMER_UPDATE";
export const NEOTMS_PERMISSION_CUSTOMER_DELETE = "NEOTMS_PERMISSION_CUSTOMER_DELETE";

/**
 * 보고서 - the margin and workload reports.
 *
 * Read-only, and one permission rather than four: a report writes nothing. It is its own permission
 * and not implied by `JOB_READ`, because a report aggregates other people's work within the
 * reader's row scope, which is a wider view than the job list it is built from.
 */
export const NEOTMS_PERMISSION_REPORT_READ = "NEOTMS_PERMISSION_REPORT_READ";

/**
 * 대시보드 - the caller's own book, as a sales manager and as a PM.
 *
 * Two permissions, because they are two screens over two different columns of `project`. Neither
 * implies the other and neither is a wider view than the project list beside it: both aggregate
 * only the rows the holder already owns.
 */
export const NEOTMS_PERMISSION_DASHBOARD_SALES_READ = "NEOTMS_PERMISSION_DASHBOARD_SALES_READ";
export const NEOTMS_PERMISSION_DASHBOARD_PM_READ = "NEOTMS_PERMISSION_DASHBOARD_PM_READ";

/**
 * 유지보수 - the code tables behind every dropdown.
 *
 * READING the codes is deliberately not here. Twenty-two columns across the schema are foreign keys
 * to `sys_code`, so every form in the application needs the list to render; gating that would leave
 * somebody entitled to create a customer looking at empty dropdowns. `GET /api/v0/codes` is open to
 * any signed-in staff member for that reason. Deciding what is IN the list is this permission.
 */
export const NEOTMS_PERMISSION_MAINTENANCE_READ = "NEOTMS_PERMISSION_MAINTENANCE_READ";
export const NEOTMS_PERMISSION_MAINTENANCE_CREATE = "NEOTMS_PERMISSION_MAINTENANCE_CREATE";
export const NEOTMS_PERMISSION_MAINTENANCE_UPDATE = "NEOTMS_PERMISSION_MAINTENANCE_UPDATE";
export const NEOTMS_PERMISSION_MAINTENANCE_DELETE = "NEOTMS_PERMISSION_MAINTENANCE_DELETE";

/**
 * 사용자 관리 - the staff directory, role assignment and the attributes below.
 *
 * Read and update only. There is no create: a staff row needs an account-system subject to be
 * usable, so one is minted at first sign-in or by self-registration, never by an administrator
 * inventing it. There is no delete either: every historical project, job and purchase order carries
 * a person's `mgr_id`, so access is ended by deactivating them, which is an update.
 *
 * THIS IS THE PERMISSION THAT GRANTS PERMISSIONS. Whoever holds `STAFF_UPDATE` can give themselves
 * anything else in this file, so it is the one grant that should be rare and deliberate.
 */
export const NEOTMS_PERMISSION_STAFF_READ = "NEOTMS_PERMISSION_STAFF_READ";
export const NEOTMS_PERMISSION_STAFF_UPDATE = "NEOTMS_PERMISSION_STAFF_UPDATE";

/**
 * 나의 업무 - the caller's own worksheet, and the custom columns on it.
 *
 * One permission, and a read one, although the screen is the most write-heavy in the application.
 * That is not an oversight: everything the sheet writes to a project, job or purchase order goes
 * out through the ordinary endpoints for those rows, so editing a cell needs the same
 * `JOB_UPDATE` or `PO_UPDATE` the forms need and a person without them gets a sheet they can read.
 * What THIS permission opens is the screen, plus the caller's own annotation layer - which is
 * private data rather than company data, and so is no more a privilege than `/api/v0/me`.
 *
 * Separate from `DASHBOARD_PM_READ` even though the audience is the same people. The two screens
 * answer different questions - the dashboard is "what is coming", the sheet is "what am I holding"
 * - and a grant should name one screen, which is the argument that split the two dashboards.
 */
export const NEOTMS_PERMISSION_WORKSPACE_READ = "NEOTMS_PERMISSION_WORKSPACE_READ";

/**
 * Every permission this build knows, in the order the administration screen lists them.
 *
 * It exists so that three things cannot drift apart: what a role may be granted, what the admin
 * screen offers, and what the schema will accept. The grant table's CHECK is generated from this
 * list, so a string that is not here cannot be stored - which turns a typo into a refusal at the
 * moment it is made rather than a grant that silently never matches.
 */
export const NEOTMS_PERMISSIONS = [
  NEOTMS_PERMISSION_PROJECT_READ,
  NEOTMS_PERMISSION_PROJECT_CREATE,
  NEOTMS_PERMISSION_PROJECT_UPDATE,
  NEOTMS_PERMISSION_PROJECT_DELETE,
  NEOTMS_PERMISSION_PROJECT_EMAIL,
  NEOTMS_PERMISSION_JOB_READ,
  NEOTMS_PERMISSION_JOB_CREATE,
  NEOTMS_PERMISSION_JOB_UPDATE,
  NEOTMS_PERMISSION_JOB_DELETE,
  NEOTMS_PERMISSION_PO_READ,
  NEOTMS_PERMISSION_PO_CREATE,
  NEOTMS_PERMISSION_PO_UPDATE,
  NEOTMS_PERMISSION_PO_DELETE,
  NEOTMS_PERMISSION_PO_APPROVE,
  NEOTMS_PERMISSION_PO_EMAIL,
  NEOTMS_PERMISSION_TRANSLATOR_READ,
  NEOTMS_PERMISSION_TRANSLATOR_CREATE,
  NEOTMS_PERMISSION_TRANSLATOR_UPDATE,
  NEOTMS_PERMISSION_TRANSLATOR_DELETE,
  NEOTMS_PERMISSION_INVOICE_READ,
  NEOTMS_PERMISSION_INVOICE_CREATE,
  NEOTMS_PERMISSION_INVOICE_UPDATE,
  NEOTMS_PERMISSION_INVOICE_DELETE,
  NEOTMS_PERMISSION_CUSTOMER_READ,
  NEOTMS_PERMISSION_CUSTOMER_CREATE,
  NEOTMS_PERMISSION_CUSTOMER_UPDATE,
  NEOTMS_PERMISSION_CUSTOMER_DELETE,
  NEOTMS_PERMISSION_REPORT_READ,
  NEOTMS_PERMISSION_DASHBOARD_SALES_READ,
  NEOTMS_PERMISSION_DASHBOARD_PM_READ,
  NEOTMS_PERMISSION_MAINTENANCE_READ,
  NEOTMS_PERMISSION_MAINTENANCE_CREATE,
  NEOTMS_PERMISSION_MAINTENANCE_UPDATE,
  NEOTMS_PERMISSION_MAINTENANCE_DELETE,
  NEOTMS_PERMISSION_STAFF_READ,
  NEOTMS_PERMISSION_STAFF_UPDATE,
  NEOTMS_PERMISSION_WORKSPACE_READ,
] as const;

export type NeotmsPermission = (typeof NEOTMS_PERMISSIONS)[number];

/** Whether a string is a permission this build knows. Used where one arrives from outside. */
export function isNeotmsPermission(value: string): value is NeotmsPermission {
  return (NEOTMS_PERMISSIONS as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Attributes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * May be named as the 담당영업 of a project.
 *
 * An attribute and not a permission: it does not let its holder do anything, it lets somebody else
 * put their name in a column. The project form's picker lists exactly the people who hold it, and
 * the server refuses a `prj_mgr_id` that names anyone else - without that refusal the picker is
 * decoration and any staff id still saves.
 */
export const NEOTMS_USER_ATTRIBUTE_SALES_MANAGER = "NEOTMS_USER_ATTRIBUTE_SALES_MANAGER";

/** May be named as the PM of a project or a job. The PM half of the pair above. */
export const NEOTMS_USER_ATTRIBUTE_PM = "NEOTMS_USER_ATTRIBUTE_PM";

/**
 * 경영지원부, IMC 매니저, MICE 매니저 - what part of the business somebody belongs to.
 *
 * ## These three are NOT in `NEOTMS_ASSIGNABLE_ATTRIBUTES`, and that is the decision
 *
 * The two above gate a COLUMN: `prj_mgr_id` and `prj_pm_id` refuse an id whose holder lacks the
 * matching attribute, and the project form's pickers list exactly the holders. There is no such
 * column for these three - no table has an "IMC manager" field - so adding them to the assignable
 * list would put them in a picker that writes `prj_pm_id`, which is how an IMC manager ends up
 * recorded as a project's PM.
 *
 * So for now they are what an attribute is in its plainest form: a fact about a person, recorded
 * on 사용자 관리, readable from `profile.attributes`, and gating nothing. When a screen needs to
 * ask "is this person MICE", it is already answerable; when a COLUMN needs one of them, that
 * column's write check is where the refusal belongs, next to the two that already have one.
 */
export const NEOTMS_USER_ATTRIBUTE_HR_MANAGEMENT = "NEOTMS_USER_ATTRIBUTE_HR_MANAGEMENT";
export const NEOTMS_USER_ATTRIBUTE_IMC = "NEOTMS_USER_ATTRIBUTE_IMC";
export const NEOTMS_USER_ATTRIBUTE_MICE = "NEOTMS_USER_ATTRIBUTE_MICE";

/**
 * Overrides every permission check in this file.
 *
 * MUST ONLY BE GRANTED TO ACCOUNTS HOLDING `lpx.admin.access`, or to whoever a later specification
 * names. It is checked before the permission set, so a superuser's answer does not depend on their
 * role having been granted anything - which is what makes it the way back in when a role has been
 * misconfigured badly enough to lock the administrators out.
 *
 * It does NOT widen row scope. `staff.view_scope` is a separate question - which rows - and a
 * superuser who sees only their own projects is a coherent, if unusual, configuration.
 */
export const NEOTMS_USER_ATTRIBUTE_SUPERUSER = "NEOTMS_USER_ATTRIBUTE_SUPERUSER";

/** Every attribute this build knows, in the order the administration screen lists them. */
export const NEOTMS_USER_ATTRIBUTES = [
  NEOTMS_USER_ATTRIBUTE_SALES_MANAGER,
  NEOTMS_USER_ATTRIBUTE_PM,
  NEOTMS_USER_ATTRIBUTE_HR_MANAGEMENT,
  NEOTMS_USER_ATTRIBUTE_IMC,
  NEOTMS_USER_ATTRIBUTE_MICE,
  NEOTMS_USER_ATTRIBUTE_SUPERUSER,
] as const;

export type NeotmsUserAttribute = (typeof NEOTMS_USER_ATTRIBUTES)[number];

/**
 * The two that can be assigned to a project.
 *
 * Neither the superuser flag nor the three departmental attributes are here - see their comments.
 * This list is what `GET /api/v0/staff/assignable` validates against, so anything added to it
 * becomes a picker on the project form and must have a column to be written into.
 */
export const NEOTMS_ASSIGNABLE_ATTRIBUTES = [
  NEOTMS_USER_ATTRIBUTE_SALES_MANAGER,
  NEOTMS_USER_ATTRIBUTE_PM,
] as const;

export function isNeotmsUserAttribute(value: string): value is NeotmsUserAttribute {
  return (NEOTMS_USER_ATTRIBUTES as readonly string[]).includes(value);
}
