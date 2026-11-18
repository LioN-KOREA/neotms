// SPDX-License-Identifier: MIT
//
// `sys_role`, `sys_role_permission` and `staff_attribute` from the administrator's side - the role
// administration screen.
//
// Separate from `NeotmsStaffAdmin.dbops.ts`, which assigns an EXISTING role to a person. This file
// decides what a role MEANS, and the two are different privileges: handing somebody the 회계 role is
// a staff administrator's daily business, while changing what 회계 permits changes it for everybody
// who already holds it, retroactively and without any of them being told. Every statement here is
// behind `NeotmsRoute.superuser` for that reason.
//
// ## Why these three tables are one file
//
// They are the whole of the access-control model, and they are only safe read together:
//
//   * `sys_role` - the roles, named.
//   * `sys_role_permission` - what each role may DO, as permission names.
//   * `staff_attribute` - what each PERSON may BE named as (담당영업, 담당PM), and the superuser
//     override. Per person rather than per role, because "may be named as the PM of a project" is
//     a fact about an individual, not about a job title - two people holding the same role can
//     differ on it.
//
// A reviewer asking "what can this screen give somebody" has to read all three; splitting them
// across files would mean three partial answers.
//
// ## The counting hazard, stated once
//
// A role has many permissions AND many staff. Joining both in one SELECT multiplies them - a role
// with 36 permissions and 4 holders reports 144 of each - and the wrong number is plausible enough
// to ship. Every count and list below is therefore a SCALAR SUBQUERY, which cannot fan out, rather
// than a join plus GROUP BY.

import {
  param,
  readBool,
  readId,
  readInt,
  readText,
  type SqlOps,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { FieldSpec } from "../NeotmsWrite.js";
import { updateFragments } from "../NeotmsWrite.js";
import type { RoleAdminCreate, RoleAdminUpdate } from "../neotms.schemas.js";

/**
 * The role code the bootstrap depends on.
 *
 * `staff_bootstrap_superuser()` looks this code up by name to decide which role to give the first
 * administrator, and `db/002_initial_seeding.sql` grants it every permission by the same name. So
 * renaming or deleting this row breaks the way back into an empty or misconfigured database - which
 * is exactly the situation in which somebody would be reaching for it. Both are refused in
 * `NeotmsRoleAdminManager`, and the constant lives here because the queries are what enforce it.
 */
export const BOOTSTRAP_ROLE_CODE = "NEOTMS_SYSADMIN";

export type RoleAdminRow = {
  id: string;
  /**
   * The stable identifier. NOT editable - see `ROLE_ADMIN_FIELDS`.
   */
  roleCode: string;
  roleName: string | null;
  active: boolean;
  /** The permission names this role grants, sorted. */
  permissions: string[];
  /**
   * How many administrable people hold this role: `deleted = false`, matching the staff listing.
   *
   * NOT the number that decides whether the role can be deleted. `staff.role_id` is
   * `ON DELETE RESTRICT`, and a soft-deleted staff row is still a row - so a role held only by
   * leavers reports 0 here and still cannot be deleted. `holders` below is the number for that
   * question, and the refusal message uses both.
   */
  staffCount: number;
  /** Every staff row pointing at this role, soft-deleted ones included. See `staffCount`. */
  holders: number;
};

/** `text[]` from `array_agg`, as a string array. node-postgres hands these over already parsed. */
const readTextArray = (row: SqlRow, column: string): string[] => {
  const value = row[column];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

/*
 * Aliased in full, for the reason `NeotmsStaffAdmin.dbops.ts` gives: rows come back keyed by column
 * name, so an unaliased `sys_role.id` alongside anything else called `id` would collapse into one
 * key with no error anywhere.
 *
 * ## Why this takes the alias as an argument
 *
 * The reads select from `sys_role r`. The UPDATE cannot: a data-modifying CTE and the query around
 * it share one snapshot taken before the statement began, so `JOIN sys_role` after an UPDATE
 * returns the row's OLD values, and after an INSERT returns nothing at all. The write therefore
 * selects from its own `RETURNING` output, which is a different alias naming the same columns.
 *
 * The three derived values stay as subqueries in both cases, and that is safe for the opposite
 * reason: they read `sys_role_permission` and `staff`, which neither write touches, so the shared
 * snapshot holds the right rows for them.
 */
const roleAdminColumns = (alias: string) => `
  ${alias}.id        AS role_id,
  ${alias}.role_code AS role_code,
  ${alias}.role_name AS role_name,
  ${alias}.active    AS role_active,
  COALESCE(
    (SELECT array_agg(p.permission ORDER BY p.permission)
       FROM sys_role_permission p
      WHERE p.role_id = ${alias}.id),
    '{}'::text[]
  ) AS role_permissions,
  (SELECT count(*) FROM staff s WHERE s.role_id = ${alias}.id AND s.deleted = false)
    AS role_staff_count,
  (SELECT count(*) FROM staff s WHERE s.role_id = ${alias}.id)
    AS role_holders
`;

const ROLE_ADMIN_COLUMNS = roleAdminColumns("r");

const toRoleAdminRow = (row: SqlRow): RoleAdminRow => ({
  id: readId(row, "role_id") ?? "",
  roleCode: readText(row, "role_code") ?? "",
  roleName: readText(row, "role_name"),
  active: readBool(row, "role_active") ?? false,
  permissions: readTextArray(row, "role_permissions"),
  staffCount: readInt(row, "role_staff_count") ?? 0,
  holders: readInt(row, "role_holders") ?? 0,
});

/**
 * Every role, including the retired ones, with its grants.
 *
 * Unlike `RoleListOps` - which feeds the assignment dropdown and therefore shows only
 * `active = true` - this is the administration view, so a retired role has to appear: it is still
 * held by whoever held it when it was retired, and a screen that hid it would be hiding live
 * permissions. Active first, so the ones in use are at the top.
 *
 * Not paginated. `sys_role` is a handful of rows - one per job title in the company.
 */
export const RoleAdminListOps: () => SqlOps<RoleAdminRow[]> = () => ({
  sql: `
    SELECT ${ROLE_ADMIN_COLUMNS}
      FROM sys_role r
     ORDER BY r.active DESC, r.role_name NULLS LAST, r.role_code
  `,
  parameters: [],
  mapper: (rows) => rows.map(toRoleAdminRow),
});

/** One role, for the read-back after a write and for the messages a refusal needs. */
export const RoleAdminGetOps: (id: string) => SqlOps<RoleAdminRow | null> = (id) => ({
  sql: `
    SELECT ${ROLE_ADMIN_COLUMNS}
      FROM sys_role r
     WHERE r.id = :id
     LIMIT 1
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows.length > 0 ? toRoleAdminRow(rows[0]!) : null),
});

/** One role by its code, so the bootstrap role can be recognised before a write touches it. */
export const RoleAdminByCodeOps: (code: string) => SqlOps<RoleAdminRow | null> = (code) => ({
  sql: `
    SELECT ${ROLE_ADMIN_COLUMNS}
      FROM sys_role r
     WHERE r.role_code = :role_code
     LIMIT 1
  `,
  parameters: [param("role_code", code, "text")],
  mapper: (rows) => (rows.length > 0 ? toRoleAdminRow(rows[0]!) : null),
});

/**
 * Create a role. It grants NOTHING until permissions are written for it.
 *
 * That is deliberate and it is the safe direction: a new role that permits nothing presents as
 * "the screens are empty", which somebody reports within the hour. A new role that inherited a
 * sensible-looking default would present as nothing at all, and nobody reports a permission they
 * were not supposed to have. The screen makes the two-step nature obvious by opening the permission
 * editor straight after a create.
 *
 * `created_by` is the administrator's `mgr_id`, which is how a surprising role can be traced to a
 * person a year from now.
 */
export const RoleCreateOps: (
  input: RoleAdminCreate,
  createdBy: string,
) => SqlOps<RoleAdminRow | null> = (input, createdBy) => ({
  /*
   * A plain INSERT whose RETURNING carries the whole row, derived columns included.
   *
   * This WAS a CTE that joined `sys_role` back to its own `RETURNING id`, and it could not work:
   * the outer query runs against the snapshot from before the statement, so it never saw the row
   * the INSERT had just made. The statement returned zero rows, `createRole` answered "The role
   * was not created" with a 500, and the role was sitting in the table - a 500 on a request that
   * had succeeded, which is the worst shape of failure because retrying makes it worse.
   *
   * The three derived values are literals here rather than subqueries, and they are exact rather
   * than approximate: a role that did not exist until this statement cannot be granted a
   * permission or held by anybody, so empty and zero are what any query would return. Writing
   * them out keeps this a single statement, which is what matters under transaction-mode pooling.
   */
  sql: `
    INSERT INTO sys_role (role_code, role_name, active, created_by)
    VALUES (:role_code, :role_name, :active, :created_by)
    RETURNING id        AS role_id,
              role_code AS role_code,
              role_name AS role_name,
              active    AS role_active,
              '{}'::text[] AS role_permissions,
              0 AS role_staff_count,
              0 AS role_holders
  `,
  parameters: [
    param("role_code", input.roleCode, "text"),
    param("role_name", input.roleName ?? null, "text"),
    param("active", input.active ?? true, "bool"),
    param("created_by", createdBy, "text"),
  ],
  mapper: (rows) => (rows.length > 0 ? toRoleAdminRow(rows[0]!) : null),
});

/**
 * The two columns an administrator may write on a role, and nothing else.
 *
 * `role_code` IS ABSENT, and that is the load-bearing omission. The code is a name other things
 * resolve by: `staff_bootstrap_superuser()` finds the bootstrap role by code, the seed re-asserts
 * its grants `ON CONFLICT (role_code)`, and `sys_role_grant_all_permissions(text)` takes a code as
 * its argument. A rename would leave every one of those looking for a row that no longer answers,
 * and the failure is silent in the worst case - the bootstrap simply stops finding a role, on the
 * day somebody needs it. Renaming a role's LABEL (`role_name`) is the operation people actually
 * want, and that is here.
 *
 * `active` retires a role without deleting it: it stops being offered for assignment while the
 * people who hold it keep holding it, which is the same retire-don't-delete pattern as `sys_code`.
 */
const ROLE_ADMIN_FIELDS: readonly FieldSpec<RoleAdminUpdate>[] = [
  { column: "role_name", kind: "text", read: (i) => i.roleName },
  { column: "active", kind: "bool", read: (i) => i.active },
];

/** Rename a role, or retire it. Returns null when no such row. */
export const RoleUpdateOps: (
  id: string,
  input: RoleAdminUpdate,
) => SqlOps<RoleAdminRow | null> = (id, input) => {
  const fields = updateFragments(ROLE_ADMIN_FIELDS, input);
  return {
    /*
      * The RETURNING carries the four `sys_role` columns, and the outer query reads them from the
      * CTE rather than from the table. Joining `sys_role` back would return the row as it was
      * BEFORE this update - the shared-snapshot rule on `roleAdminColumns` - so a rename would
      * answer with the old name, which is exactly the moment a user decides the save failed.
      */
    sql: `
      WITH updated AS (
        UPDATE sys_role
           SET ${fields.fragment}
         WHERE id = :id
        RETURNING id, role_code, role_name, active
      )
      SELECT ${roleAdminColumns("u")}
        FROM updated u
    `,
    parameters: [...fields.parameters, param("id", id, "id")],
    mapper: (rows) => (rows.length > 0 ? toRoleAdminRow(rows[0]!) : null),
  };
};

/**
 * Delete a role outright.
 *
 * Reachable only when nobody holds it: `staff.role_id` is `ON DELETE RESTRICT`, so this raises
 * 23503 otherwise and the manager turns that into a sentence naming the holders. The role's
 * permission rows go with it - `sys_role_permission.role_id` is `ON DELETE CASCADE`, because a
 * grant to a role that no longer exists is not a grant, it is a row nobody can see or revoke.
 *
 * A real DELETE and not a soft delete, unlike every business table. `sys_role` carries no history:
 * nothing references a role except `staff.role_id`, and `created_by` columns record a person, not
 * their job title. Retiring (`active = false`) is the right move for a role somebody still holds,
 * and the screen offers both.
 */
export const RoleDeleteOps: (id: string) => SqlOps<{ id: string } | null> = (id) => ({
  sql: `DELETE FROM sys_role WHERE id = :id RETURNING id`,
  parameters: [param("id", id, "id")],
  mapper: (rows) => {
    const deleted = rows.length > 0 ? readId(rows[0]!, "id") : null;
    return deleted ? { id: deleted } : null;
  },
});

/* -------------------------------------------------------------------------- */
/* Grants: replacing a role's permission set                                  */
/* -------------------------------------------------------------------------- */
//
// A replace, not a diff the client computes. The screen sends the complete set it wants the role to
// have, and these two statements make the table match it. The alternative - "add these, remove
// those" - puts the diff in the client, which means two administrators editing the same role in two
// tabs produce a union of their intentions rather than one of them winning.
//
// Two statements, run inside one `pgTransaction` by the manager. Delete-then-insert in one
// statement is not expressible, and without the transaction a failure between them leaves the role
// holding fewer permissions than either administrator asked for - the failure mode being "somebody
// quietly lost access", which nobody reports as a transaction bug.

/**
 * Remove every grant this role has that is not in `keep`.
 *
 * An EMPTY `keep` removes all of them, which is correct: a role that grants nothing is a legitimate
 * configuration (a placeholder, or a role being emptied before retirement). `= ANY('{}')` is false
 * for every row, so `NOT (... = ANY(...))` is true for every row, and all of them go.
 */
export const RolePermissionsPruneOps: (
  roleId: string,
  keep: readonly string[],
) => SqlOps<number> = (roleId, keep) => ({
  sql: `
    DELETE FROM sys_role_permission
     WHERE role_id = :role_id
       AND NOT (permission = ANY(:keep))
    RETURNING id
  `,
  parameters: [param("role_id", roleId, "id"), param("keep", [...keep], "textArray")],
  mapper: (rows) => rows.length,
});

/**
 * Add the grants this role does not already have.
 *
 * `ON CONFLICT DO NOTHING` so that re-saving an unchanged set is a no-op rather than a 23505, and
 * so that `created_by` on an existing grant keeps naming whoever first made it rather than being
 * rewritten by every later save.
 *
 * `unnest` rather than a built-up VALUES list: the permission names arrive from the client, and a
 * single array parameter cannot become SQL text no matter what is in it. They are validated against
 * `NEOTMS_PERMISSIONS` before they get here as well, and the CHECK on the table would refuse an
 * unknown name even if both of those failed - three layers, because this is the table that decides
 * what everybody can do.
 */
export const RolePermissionsAddOps: (
  roleId: string,
  permissions: readonly string[],
  createdBy: string,
) => SqlOps<number> = (roleId, permissions, createdBy) => ({
  sql: `
    INSERT INTO sys_role_permission (role_id, permission, created_by)
    SELECT :role_id, p, :created_by
      FROM unnest(:permissions) AS p
    ON CONFLICT (role_id, permission) DO NOTHING
    RETURNING id
  `,
  parameters: [
    param("role_id", roleId, "id"),
    param("permissions", [...permissions], "textArray"),
    param("created_by", createdBy, "text"),
  ],
  mapper: (rows) => rows.length,
});

/* -------------------------------------------------------------------------- */
/* Attributes: what a PERSON may be named as                                  */
/* -------------------------------------------------------------------------- */

/** The same replace-the-whole-set shape as the role grants above, and for the same reasons. */
export const StaffAttributesPruneOps: (
  staffId: string,
  keep: readonly string[],
) => SqlOps<number> = (staffId, keep) => ({
  sql: `
    DELETE FROM staff_attribute
     WHERE staff_id = :staff_id
       AND NOT (attribute = ANY(:keep))
    RETURNING id
  `,
  parameters: [param("staff_id", staffId, "id"), param("keep", [...keep], "textArray")],
  mapper: (rows) => rows.length,
});

export const StaffAttributesAddOps: (
  staffId: string,
  attributes: readonly string[],
  createdBy: string,
) => SqlOps<number> = (staffId, attributes, createdBy) => ({
  sql: `
    INSERT INTO staff_attribute (staff_id, attribute, created_by)
    SELECT :staff_id, a, :created_by
      FROM unnest(:attributes) AS a
    ON CONFLICT (staff_id, attribute) DO NOTHING
    RETURNING id
  `,
  parameters: [
    param("staff_id", staffId, "id"),
    param("attributes", [...attributes], "textArray"),
    param("created_by", createdBy, "text"),
  ],
  mapper: (rows) => rows.length,
});

/**
 * How many active people would still hold `NEOTMS_PERMISSION_STAFF_UPDATE` if `excludeRoleId`'s
 * grants were removed, plus how many superusers exist.
 *
 * This is the lockout question, asked before a write rather than discovered after one. The failure
 * it prevents: an administrator empties the only role that holds `STAFF_UPDATE`, and the screen
 * that could put it back is the screen they just locked themselves out of.
 *
 * `superusers` is counted separately because a superuser passes every permission check, so a
 * database with one is never actually locked out - the refusal is only warranted when there is no
 * superuser left either. The bootstrap authority is invisible from SQL, which is why the manager
 * treats this count as a floor and never as the whole answer.
 */
export const AdminReachCountsOps: (
  excludeRoleId: string | null,
) => SqlOps<{ admins: number; superusers: number }> = (excludeRoleId) => ({
  sql: `
    SELECT (SELECT count(*)
              FROM staff s
              JOIN sys_role_permission p ON p.role_id = s.role_id
             WHERE s.active
               AND NOT s.deleted
               AND p.permission = 'NEOTMS_PERMISSION_STAFF_UPDATE'
               AND (:exclude_role_id IS NULL OR s.role_id <> :exclude_role_id)) AS admins,
           (SELECT count(*)
              FROM staff s
              JOIN staff_attribute a ON a.staff_id = s.id
             WHERE s.active
               AND NOT s.deleted
               AND a.attribute = 'NEOTMS_USER_ATTRIBUTE_SUPERUSER') AS superusers
  `,
  parameters: [param("exclude_role_id", excludeRoleId, "id")],
  mapper: (rows) => ({
    admins: rows.length > 0 ? (readInt(rows[0]!, "admins") ?? 0) : 0,
    superusers: rows.length > 0 ? (readInt(rows[0]!, "superusers") ?? 0) : 0,
  }),
});
