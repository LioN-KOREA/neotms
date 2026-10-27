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
} as const;

export type NeotmsMenuId = (typeof NeotmsMenu)[keyof typeof NeotmsMenu];
