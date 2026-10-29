// SPDX-License-Identifier: MIT
//
// `staff` and `sys_role` from the administrator's side - the 사용자 관리 screen.
//
// Distinct from `auth/NeotmsStaff.dbops.ts`, which reads the CALLER's own row on every request and
// must stay as small and as fast as it is. This module reads and writes OTHER PEOPLE's rows, which
// is a different job with different risks, so it is a different file: a query added here cannot
// accidentally slow down every authenticated request, and - more importantly - a reviewer reading
// "what can change somebody's role" has one file to read.
//
// ## Two columns here decide everything else in the application
//
//   * `staff.role_id` -> `sys_role_auth` -> the menu x action matrix. Every permission in NEOTMS
//     resolves from this column.
//   * `staff.view_scope` -> whether the person sees their own rows or all of them.
//
// In LKTMS both arrived in an unsigned cookie, so anybody who could edit a cookie could grant
// themselves anything. The fix is not only that they now live in the database: it is that there is
// exactly ONE statement in this codebase that writes them (`StaffAdminUpdateOps` below), reached by
// exactly one route, gated on one menu. That is what makes the claim auditable rather than hopeful.
//
// ## There is no INSERT here
//
// An administrator cannot create a staff row. Rows arrive two ways only: the legacy ETL, and
// self-registration by somebody who has signed in through LPX and whose identity therefore exists
// (`staff_self_register()`, db/009_selfservice.sql). An admin-side INSERT would have to invent an
// `lpx_sub`, and a staff row with a made-up or absent subject is either unusable or - worse -
// claimable by whoever next signs in with a matching email. So the administrator's job here is to
// APPROVE, which is an UPDATE.

import {
  param,
  readBool,
  readId,
  readText,
  type SqlOps,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { FieldSpec } from "../NeotmsWrite.js";
import { updateFragments } from "../NeotmsWrite.js";
import type { StaffAdminUpdate } from "../neotms.schemas.js";

export type StaffAdminRow = {
  /** `staff.id`. */
  id: string;
  /** The legacy readable key. Appears in `created_by` on everything this person touches. */
  mgrId: string;
  name: string | null;
  nameEng: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  roleId: string | null;
  roleCode: string | null;
  roleName: string | null;
  viewScope: string | null;
  active: boolean;
  /**
   * Whether an LPX identity is attached.
   *
   * The `lpx_sub` itself is deliberately NOT returned. It is an identity token for another person's
   * account, nothing on the screen needs it, and "the admin list leaks every colleague's OIDC
   * subject" is a sentence worth never having to write. What the screen does need is the boolean:
   * false means this row came from the ETL and nobody has signed into it yet, which is why its role
   * might be set while its contact details are blank.
   */
  linked: boolean;
  createdAt: string | null;
};

export type RoleOption = {
  id: string;
  roleCode: string;
  roleName: string | null;
};

/*
 * Aliased in full, for the reason given in auth/NeotmsStaff.dbops.ts: rows come back keyed by
 * column name, so `staff.id` and `sys_role.id` in one SELECT would collapse into a single key with
 * no error anywhere. Here that would mean the screen addressing a PATCH at a ROLE id while
 * believing it to be a staff id - and role ids are small integers, so it would hit a real staff row.
 */
const STAFF_ADMIN_COLUMNS = `
  s.id           AS staff_id,
  s.mgr_id       AS staff_mgr_id,
  s.mgr_name     AS staff_name,
  s.mgr_name_eng AS staff_name_eng,
  s.mgr_email    AS staff_email,
  s.mgr_phone    AS staff_phone,
  s.mgr_position AS staff_position,
  s.role_id      AS staff_role_id,
  s.view_scope   AS staff_view_scope,
  s.active       AS staff_active,
  s.created_at   AS staff_created_at,
  (s.lpx_sub IS NOT NULL) AS staff_linked,
  r.role_code    AS role_code,
  r.role_name    AS role_name
`;

const toStaffAdminRow = (row: SqlRow): StaffAdminRow => ({
  id: readId(row, "staff_id") ?? "",
  mgrId: readText(row, "staff_mgr_id") ?? "",
  name: readText(row, "staff_name"),
  nameEng: readText(row, "staff_name_eng"),
  email: readText(row, "staff_email"),
  phone: readText(row, "staff_phone"),
  position: readText(row, "staff_position"),
  roleId: readId(row, "staff_role_id"),
  roleCode: readText(row, "role_code"),
  roleName: readText(row, "role_name"),
  viewScope: readText(row, "staff_view_scope"),
  active: readBool(row, "staff_active") ?? false,
  linked: readBool(row, "staff_linked") ?? false,
  /*
   * `readText`, not a Date. The type parsers in PostgresUtils are overridden so that every
   * timestamptz arrives as the wire string, because `String(new Date())` is
   * "Wed Oct 29 2026 09:00:00 GMT+0900 (KST)" - not ISO, not parseable by the browser, and not an
   * error. Every other mapper in this codebase reads timestamps the same way.
   */
  createdAt: readText(row, "staff_created_at"),
});

/**
 * Every staff row, approval-pending first.
 *
 * ## The ordering is the feature
 *
 * `role_id IS NULL` sorts first, and that is not a cosmetic choice. A self-registered user lands
 * with `role_id = NULL` and sees "관리자님께서 회원가입 요청을 검토하고 있습니다." until somebody
 * acts. Nothing notifies the administrator - there is no mail path in this system - so the ONLY
 * thing standing between a new colleague and an indefinite wait is that their row is the first one
 * on this screen. `active` descending next, so a deactivated leaver with no role does not outrank a
 * live request. Then name, then `mgr_id` to make the order total (an ORDER BY with ties may return
 * them differently between two calls, and a list that reshuffles on refresh reads as broken).
 *
 * ## Not paginated, and not filtered by caller
 *
 * `staff` is tens of rows, not thousands - it is the company's own employees. A cursor would add a
 * shape the client has to handle for a list that fits on one screen. And unlike every business
 * table, this one is NOT narrowed by `view_scope`: a staff directory is not row-scoped data, and an
 * administrator approving a request has to see the request.
 *
 * `deleted = false` only. A soft-deleted staff row is kept because every historical project
 * references its `mgr_id`, but it is not a person to be administered any more; the way back is a
 * database statement, deliberately, so that "undelete an employee" is not a button.
 */
export const StaffAdminListOps: () => SqlOps<StaffAdminRow[]> = () => ({
  sql: `
    SELECT ${STAFF_ADMIN_COLUMNS}
      FROM staff s
      LEFT JOIN sys_role r ON r.id = s.role_id
     WHERE s.deleted = false
     ORDER BY (s.role_id IS NULL) DESC,
              s.active DESC,
              s.mgr_name NULLS LAST,
              s.mgr_id
  `,
  parameters: [],
  mapper: (rows) => rows.map(toStaffAdminRow),
});

/** One staff row, for the read-back after a write and for the messages a refusal needs. */
export const StaffAdminGetOps: (id: string) => SqlOps<StaffAdminRow | null> = (id) => ({
  sql: `
    SELECT ${STAFF_ADMIN_COLUMNS}
      FROM staff s
      LEFT JOIN sys_role r ON r.id = s.role_id
     WHERE s.id = :id
       AND s.deleted = false
     LIMIT 1
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows.length > 0 ? toStaffAdminRow(rows[0]!) : null),
});

/**
 * The roles that may be assigned.
 *
 * `active = true`, so a retired role stops being offered while the people who hold it keep holding
 * it - the same retire-don't-delete pattern as `sys_code`. A role still in use cannot be deleted
 * anyway: `staff.role_id` references it `ON DELETE RESTRICT`.
 *
 * This is the first query in the codebase to read `sys_role` other than as a LEFT JOIN onto `staff`,
 * which is worth noticing: until there was a screen for assigning roles, nothing ever needed to
 * enumerate them. `sys_role_menu` is still read by nothing in TypeScript - only by
 * `sys_role_grant_all_menus()` in db/006_bootstrap.sql - because the guard resolves visibility from
 * `sys_role_auth` alone.
 */
export const RoleListOps: () => SqlOps<RoleOption[]> = () => ({
  sql: `
    SELECT r.id        AS role_id,
           r.role_code AS role_code,
           r.role_name AS role_name
      FROM sys_role r
     WHERE r.active = true
     ORDER BY r.role_name NULLS LAST, r.role_code
  `,
  parameters: [],
  mapper: (rows) =>
    rows
      .filter((row) => (readId(row, "role_id") ?? "").length > 0)
      .map((row) => ({
        id: readId(row, "role_id")!,
        roleCode: readText(row, "role_code") ?? "",
        roleName: readText(row, "role_name"),
      })),
});

/**
 * The three columns an administrator may write, and nothing else.
 *
 * This list IS the security boundary. Everything the 사용자 관리 screen can change about another
 * person is here, so the review question is "are these three acceptable", not "what else might that
 * screen reach". Name, email, phone and position are absent on purpose - the user maintains those
 * (`SelfProfileSchema`), and an administrator assigning a role has no reason to edit a phone number.
 * `mgr_id`, `lpx_sub` and `corp_code` are absent because they are identity: changing `lpx_sub` would
 * hand one person's record to another account, and changing `mgr_id` would orphan every `created_by`
 * that points at it.
 *
 * `role_id` is `kind: "id"`, so it is cast to bigint and a non-numeric value fails as a parameter
 * rather than as a 23503 after the fact. `null` clears it, which is how an account is suspended
 * without being deleted: the person still signs in, and can do nothing.
 */
const STAFF_ADMIN_FIELDS: readonly FieldSpec<StaffAdminUpdate>[] = [
  { column: "role_id", kind: "id", read: (i) => i.roleId },
  { column: "view_scope", kind: "text", read: (i) => i.viewScope },
  { column: "active", kind: "bool", read: (i) => i.active },
];

/**
 * Assign a role, a view scope, or the active flag. Returns null when no such row.
 *
 * `updated_at = now()` is appended unconditionally rather than being a `FieldSpec`, because an
 * administrative change to somebody else's permissions is the one edit in this system where "when
 * did this happen" is always worth answering. `staff` has no `updated_by`, and this is not the place
 * to add one - a column added here and not in the ETL's mapping is a column that reads as "nobody
 * changed this" for every migrated row.
 *
 * `deleted = false` in the WHERE, matching the listing: a soft-deleted row is not administrable from
 * the screen, so an id scraped from an old response cannot reactivate a leaver.
 */
export const StaffAdminUpdateOps: (
  id: string,
  input: StaffAdminUpdate,
) => SqlOps<StaffAdminRow | null> = (id, input) => {
  const fields = updateFragments(STAFF_ADMIN_FIELDS, input);
  return {
    /*
     * A CTE, because `RETURNING` cannot join. The screen needs the role's NAME back - it has just
     * changed, and re-rendering the row with the old label is exactly the moment a user concludes
     * the save did not work - and `sys_role` is not in the UPDATE's scope. The alternative is a
     * second SELECT, which under transaction-mode pooling is a second statement that could in
     * principle run on another connection.
     */
    sql: `
      WITH updated AS (
        UPDATE staff
           SET ${fields.fragment},
               updated_at = now()
         WHERE id = :id
           AND deleted = false
        RETURNING id
      )
      SELECT ${STAFF_ADMIN_COLUMNS}
        FROM updated u
        JOIN staff s ON s.id = u.id
        LEFT JOIN sys_role r ON r.id = s.role_id
    `,
    parameters: [...fields.parameters, param("id", id, "id")],
    mapper: (rows) => (rows.length > 0 ? toStaffAdminRow(rows[0]!) : null),
  };
};
