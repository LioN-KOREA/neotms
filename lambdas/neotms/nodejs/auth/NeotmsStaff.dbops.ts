// SPDX-License-Identifier: MIT
//
// The staff row behind an authenticated identity, and the permissions that hang off it.
//
// The access token says which LPX account is calling. It does not and cannot say which NEOTMS staff
// member that is, which role they hold, or which rows they may see - those are facts about this
// company, kept in `staff`, `sys_role` and `sys_role_auth`. This module reads them.
//
// Two columns here are the whole point of the exercise, and both are load-bearing security values
// that must only ever be read from the server:
//
//   * `staff.role_id` (legacy MGR_AUTH_CODE) -> the 48-menu x 5-action matrix.
//   * `staff.view_scope` (legacy MGR_VIEW)   -> whether this person sees their own rows or all of
//     them.
//
// In LKTMS both arrived in an unsigned cookie, so anyone who could edit a cookie could grant
// themselves any role. That is the defect being closed, and it is closed by there being no code
// path anywhere in NEOTMS that accepts either value from a caller.

import { param, readBool, readId, readText, type SqlOps, type SqlRow } from "../utils/RdsDataUtils.js";

/** One menu's five action flags, in `sys_role_auth.role_1 .. role_5` order. */
export type MenuPermissions = [boolean, boolean, boolean, boolean, boolean];

export type StaffRow = {
  staffId: string;
  mgrId: string;
  name: string | null;
  email: string | null;
  position: string | null;
  corpCode: string | null;
  roleId: string | null;
  roleCode: string | null;
  roleName: string | null;
  /** Raw `staff.view_scope`. Interpreted in NeotmsAuthGuard, never here. */
  viewScope: string | null;
  active: boolean;
  deleted: boolean;
};

/*
 * Every column is aliased, including ones that would not collide today.
 *
 * `formatRecordsAs: "JSON"` keys each row by column name, so two columns of the same name from two
 * joined tables collapse into one - last writer wins, silently, with no error anywhere. `staff.id`
 * and `sys_role.id` are exactly that case. Aliasing the lot means a column added to either table
 * later cannot introduce the collision by accident.
 */
const STAFF_COLUMNS = `
  s.id            AS staff_id,
  s.mgr_id        AS staff_mgr_id,
  s.mgr_name      AS staff_name,
  s.mgr_email     AS staff_email,
  s.mgr_position  AS staff_position,
  s.corp_code     AS staff_corp_code,
  s.role_id       AS staff_role_id,
  s.view_scope    AS staff_view_scope,
  s.active        AS staff_active,
  s.deleted       AS staff_deleted,
  r.role_code     AS role_code,
  r.role_name     AS role_name
`;

const toStaffRow = (row: SqlRow): StaffRow => ({
  staffId: readId(row, "staff_id") ?? "",
  mgrId: readText(row, "staff_mgr_id") ?? "",
  name: readText(row, "staff_name"),
  email: readText(row, "staff_email"),
  position: readText(row, "staff_position"),
  corpCode: readText(row, "staff_corp_code"),
  roleId: readId(row, "staff_role_id"),
  roleCode: readText(row, "role_code"),
  roleName: readText(row, "role_name"),
  viewScope: readText(row, "staff_view_scope"),
  active: readBool(row, "staff_active") ?? false,
  deleted: readBool(row, "staff_deleted") ?? false,
});

const firstStaffRow = (rows: SqlRow[]): StaffRow | null =>
  rows.length > 0 ? toStaffRow(rows[0]!) : null;

/**
 * The staff row claimed by this OIDC subject.
 *
 * `LEFT JOIN sys_role` rather than an inner join: a staff row with no role is a real state (a newly
 * created account, or one whose role was removed), and it has to come back as "signed in with no
 * permissions" rather than as "no such person". Those produce different answers - 403 and 401 - and
 * conflating them is how a permissions problem comes to look like a broken login.
 */
export const StaffByLpxSubOps: (sub: string) => SqlOps<StaffRow | null> = (sub) => ({
  sql: `
    SELECT ${STAFF_COLUMNS}
      FROM staff s
      LEFT JOIN sys_role r ON r.id = s.role_id
     WHERE s.lpx_sub = :sub
       AND s.deleted = false
     LIMIT 1
  `,
  parameters: [param("sub", sub, "text")],
  mapper: firstStaffRow,
});

/**
 * An unclaimed staff row whose email matches, for just-in-time linking.
 *
 * The legacy accounts and the LPX accounts have virtually no overlap, so the link is made on first
 * sign-in rather than migrated. Email is the only thing the two systems share.
 *
 * Three restrictions make this safe to do automatically:
 *
 *   * `lpx_sub IS NULL` - a row already claimed by someone else is never re-pointed. Without this,
 *     a changed email address on the LPX side could silently transfer one person's staff record,
 *     role and history to another account.
 *   * `active AND NOT deleted` - a departed employee's row cannot be claimed.
 *   * `lower(trim(...))` on both sides, because the two systems' data entry differ in case and
 *     stray whitespace, and a comparison that misses is indistinguishable from "no such staff".
 *
 * The match is still only a candidate: the caller claims it conditionally (see StaffClaimOps), so
 * two simultaneous first sign-ins cannot both succeed.
 */
export const StaffUnclaimedByEmailOps: (email: string) => SqlOps<StaffRow | null> = (email) => ({
  sql: `
    SELECT ${STAFF_COLUMNS}
      FROM staff s
      LEFT JOIN sys_role r ON r.id = s.role_id
     WHERE s.lpx_sub IS NULL
       AND s.deleted = false
       AND s.active = true
       AND lower(trim(s.mgr_email)) = lower(trim(:email))
     LIMIT 1
  `,
  parameters: [param("email", email, "text")],
  mapper: firstStaffRow,
});

/**
 * Claim a staff row for an OIDC subject. Returns the row on success and null if someone got there
 * first.
 *
 * `WHERE lpx_sub IS NULL` is the whole concurrency story: two first sign-ins race, both see the
 * same unclaimed candidate, and exactly one UPDATE matches a row. The loser gets null and is told
 * to contact an administrator rather than being handed a record it does not own. `staff.lpx_sub` is
 * also UNIQUE, so even a bug here fails as a constraint violation rather than as a shared account.
 */
export const StaffClaimOps: (staffId: string, sub: string) => SqlOps<StaffRow | null> = (
  staffId,
  sub,
) => ({
  sql: `
    WITH claimed AS (
      UPDATE staff
         SET lpx_sub = :sub, updated_at = now()
       WHERE id = :staff_id
         AND lpx_sub IS NULL
         AND deleted = false
         AND active = true
      RETURNING id
    )
    SELECT ${STAFF_COLUMNS}
      FROM claimed c
      JOIN staff s ON s.id = c.id
      LEFT JOIN sys_role r ON r.id = s.role_id
  `,
  parameters: [param("sub", sub, "text"), param("staff_id", staffId, "id")],
  mapper: firstStaffRow,
});

/**
 * The permission matrix for one role: one row per menu, five action flags each.
 *
 * Read in full rather than per-menu-per-request. It is 48 rows of booleans - one round trip for the
 * whole answer is cheaper than one round trip per check, and it means a handler cannot cause a
 * database call by asking a permission question.
 *
 * `sys_role_auth.active` is filtered here. Its legacy column was `nvarchar(20)`, not `(3)`, so the
 * ETL may find values other than Y/N; the schema's rule is that anything but an explicit 'N' is
 * active, and this query trusts the boolean the ETL produced.
 */
export const RoleMenuPermissionsOps: (roleId: string) => SqlOps<Map<string, MenuPermissions>> = (
  roleId,
) => ({
  sql: `
    SELECT a.menu_id AS menu_id,
           a.role_1  AS action_1,
           a.role_2  AS action_2,
           a.role_3  AS action_3,
           a.role_4  AS action_4,
           a.role_5  AS action_5
      FROM sys_role_auth a
     WHERE a.role_id = :role_id
       AND a.active = true
  `,
  parameters: [param("role_id", roleId, "id")],
  mapper: (rows) => {
    const permissions = new Map<string, MenuPermissions>();
    for (const row of rows) {
      const menuId = readText(row, "menu_id");
      if (!menuId) continue;
      permissions.set(menuId, [
        readBool(row, "action_1") ?? false,
        readBool(row, "action_2") ?? false,
        readBool(row, "action_3") ?? false,
        readBool(row, "action_4") ?? false,
        readBool(row, "action_5") ?? false,
      ]);
    }
    return permissions;
  },
});
