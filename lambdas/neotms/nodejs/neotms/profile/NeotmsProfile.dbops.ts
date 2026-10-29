// SPDX-License-Identifier: MIT
//
// The navigation tree, read from `sys_menu`.
//
// This is the only query in the domain layer that reads a table nobody filters by caller: a menu is
// not data about a customer, it is the shape of the application. What differs per caller is which of
// these menus they hold rights on, and that comes from the role matrix already resolved by the guard
// (`caller.permissions`) rather than from a second join here.
//
// Separating the two is what lets `/api/v0/me` answer in one query. It also means an unmapped
// `menu_id` - and the ids in `NeotmsMenus.ts` are still UNCONFIRMED against the legacy SY_MENU rows
// - shows up as a menu the UI renders with no rights rather than as a menu that vanishes.

import { readInt, readText, type SqlOps, type SqlRow } from "../../utils/PostgresUtils.js";

export type MenuNode = {
  menuId: string;
  name: string | null;
  parent: string | null;
  depth: number | null;
  /** Legacy `.asp` path for migrated rows. The UI maps it to a route; see the DDL comment. */
  url: string | null;
  ordNo: number | null;
};

/**
 * Every active menu, in the order the navigation renders.
 *
 * Ordered by `ord_no` with `menu_id` as the tiebreak, because `ord_no` is nullable in the legacy
 * data and NULLs would otherwise make the menu order differ between two calls - a navigation bar
 * that reshuffles itself on refresh reads as a bug long before anyone suspects the data.
 */
export const MenuTreeOps: () => SqlOps<MenuNode[]> = () => ({
  sql: `
    SELECT m.menu_id     AS menu_id,
           m.menu_name   AS menu_name,
           m.menu_parent AS menu_parent,
           m.menu_depth  AS menu_depth,
           m.menu_url    AS menu_url,
           m.ord_no      AS ord_no
      FROM sys_menu m
     WHERE m.active = true
     ORDER BY m.ord_no NULLS LAST, m.menu_id
  `,
  parameters: [],
  mapper: (rows: SqlRow[]): MenuNode[] =>
    rows
      // A row with no `menu_id` cannot be granted rights on, so it would render as a dead entry.
      .filter((row) => (readText(row, "menu_id") ?? "").length > 0)
      .map((row) => ({
        menuId: readText(row, "menu_id")!,
        name: readText(row, "menu_name"),
        parent: readText(row, "menu_parent"),
        depth: readInt(row, "menu_depth"),
        url: readText(row, "menu_url"),
        ordNo: readInt(row, "ord_no"),
      })),
});
