// SPDX-License-Identifier: MIT
//
// The menu ids permissions are granted on.
//
// `sys_role_auth` grants rights per `menu_id` x action, and `menu_id` is a legacy string from
// SY_MENU - 48 of them. Every route in this API has to name the menu it belongs to, and this module
// is the only place those strings appear. A route that names a menu inline is a route whose
// permission check nobody can audit, and a typo in one is not a syntax error: `hasPermission`
// returns false for an unknown menu, so the route simply refuses everyone, forever, with a message
// that says "your role does not permit this".
//
// ## UNCONFIRMED: the values below are the intended ids, not verified legacy ones
//
// The legacy SY_MENU rows have not been profiled yet, so these constants are what the ETL must map
// the legacy MENU_ID values ONTO (or, equivalently, what must be corrected here once the legacy
// values are known). Confirm with:
//
//   SELECT menu_id, menu_name, menu_url FROM sys_menu ORDER BY ord_no;
//
// Until then every permission check fails closed, which is the right direction to be wrong in: a
// role that can see nothing is reported within the hour, while a role that can see everything is
// never reported at all.

export const NeotmsMenu = {
  /** 고객사 관리 - the customer master. */
  CUSTOMER: "CUSTOMER",
  /** 프로젝트 관리 - the project header, and the whole revenue chain's entry point. */
  PROJECT: "PROJECT",
  /** 작업 관리 - jobs. Revenue is booked here. */
  JOB: "JOB",
  /** 발주 관리 - purchase orders. Cost is booked here. */
  PURCHASE_ORDER: "PURCHASE_ORDER",
  /** 번역가 관리 - the translator/vendor master. */
  TRANSLATOR: "TRANSLATOR",
  /**
   * 보고서 - the report screens.
   *
   * Separate from the entities it aggregates, deliberately. A PM may read every project they own
   * and still not be permitted to see company-wide margin, which is the single most sensitive
   * figure in this system.
   */
  REPORT: "REPORT",
  /**
   * 유지보수 - the code tables.
   *
   * `sys_code` is where 분야, 작업 종류, 단가 단위, 언어 and 사용 프로그램 live, and twenty-two
   * columns across the schema FK to it with ON DELETE RESTRICT. That is why it needs a screen at
   * all: until db/007_codes.sql seeded it, every save that carried a code failed with a foreign key
   * violation, and the only way to add a missing code was to open a SQL console.
   *
   * Gated on its own menu rather than folded into an existing one, because editing a code list is a
   * different authority from using it. Every PM reads these codes all day through
   * `GET /api/v0/codes`, which is `anyStaff`; deciding what the company's 분야 taxonomy IS belongs
   * to whoever runs the system.
   */
  MAINTENANCE: "MAINTENANCE",
  /**
   * 사용자 관리 - the staff list and role assignment.
   *
   * The most dangerous menu in the application, and the only one whose writes change what other
   * menus permit: `staff.role_id` is the column every permission in this system is resolved from,
   * and `staff.view_scope` decides whether somebody sees their own rows or everybody's. A role
   * granted here is a role granted everywhere.
   *
   * Which is also why it is a menu and not a hardcoded "superuser may do this" check. The right to
   * assign roles is itself a grant in `sys_role_auth`, so it can be given, taken away, and audited
   * by the same mechanism as everything else - rather than being an implicit property of a role code
   * that nothing enumerates.
   */
  STAFF: "STAFF",
  /**
   * 대시보드(영업) - the caller's own book as 영업담당자.
   *
   * ## Why two ids and not one `DASHBOARD`
   *
   * Because the requirement is "each person sees the one that matches their position", and one menu
   * id cannot say that. A single `DASHBOARD` grant would be all-or-nothing: a PM who is granted it
   * also gets the 영업 screen, and withholding it takes away the screen they actually need. Two ids
   * make the two screens two separately grantable things, which is what `sys_role_auth` is for - and
   * a system administrator simply holds both.
   *
   * These are not more permissive than `PROJECT`, which is what these two routes were gated on
   * before. Every figure on either screen is an aggregate over the caller's own project, job and PO
   * rows, each already readable one project at a time on the project detail screen. Splitting the
   * gate narrows what a grant means; it does not widen what a holder can see.
   *
   * ## The cost of splitting, and why it is paid rather than avoided
   *
   * A new menu id needs a `sys_menu` row before the screen works at all, and a missing row fails
   * **silently** - `readableNav` drops a nav item whose menu the caller does not hold, and the server
   * answers 403 with a message about the caller's role. That is the hazard db/008_admin.sql warns
   * about, and it is why these two screens originally reused `PROJECT`.
   *
   * It is handled, not avoided: db/013_dashboard_menus.sql seeds both rows and re-grants them to
   * NEOTMS_SYSADMIN, and the bootstrap test in test/neotms.test.ts asserts that every id in this
   * object appears in one of the seed files. Adding an id here without seeding it fails the suite
   * before it can fail a user.
   */
  DASHBOARD_SALES: "DASHBOARD_SALES",
  /** 대시보드(PM) - the same aggregate over `project.prj_pm_id`. See DASHBOARD_SALES above. */
  DASHBOARD_PM: "DASHBOARD_PM",
} as const;

export type NeotmsMenuId = (typeof NeotmsMenu)[keyof typeof NeotmsMenu];
