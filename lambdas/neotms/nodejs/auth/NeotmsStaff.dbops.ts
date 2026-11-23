// SPDX-License-Identifier: MIT
//
// The staff row behind an authenticated identity, and the permissions that hang off it.
//
// The access token says which LPX account is calling. It does not and cannot say which NEOTMS staff
// member that is, which role they hold, or which rows they may see - those are facts about this
// company, kept in `staff`, `sys_role` and `sys_role_permission`. This module reads them.
//
// Two columns here are the whole point of the exercise, and both are load-bearing security values
// that must only ever be read from the server:
//
//   * `staff.role_id` (legacy MGR_AUTH_CODE) -> the 48-menu x 5-action matrix.
//   * `staff.view_scope` (legacy MGR_VIEW) -> whether this person sees their own rows or all of
//     them.
//
// In LKTMS both arrived in an unsigned cookie, so anyone who could edit a cookie could grant
// themselves any role. That is the defect being closed, and it is closed by there being no code
// path anywhere in NEOTMS that accepts either value from a caller.

import { param, readBool, readId, readText, type SqlOps, type SqlRow } from "../utils/PostgresUtils.js";

/**
 * What one role may do: the permission names it has been granted.
 *
 * A set rather than the 48-menu x 5-flag matrix this used to be. The matrix could not express
 * "may approve a purchase order" separately from "may record that it was paid", and it carried a
 * fifth flag whose meaning was a documented guess. See NeotmsAuthorities.ts.
 */
export type GrantedPermissions = ReadonlySet<string>;

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
/*
 * Takes the alias, so that `StaffClaimOps` can select from its own `RETURNING` output rather than
 * joining `staff` back - see the comment on that op for what the join was quietly doing.
 */
const staffColumns = (alias: string) => `
  ${alias}.id            AS staff_id,
  ${alias}.mgr_id        AS staff_mgr_id,
  ${alias}.mgr_name      AS staff_name,
  ${alias}.mgr_email     AS staff_email,
  ${alias}.mgr_position  AS staff_position,
  ${alias}.corp_code     AS staff_corp_code,
  ${alias}.role_id       AS staff_role_id,
  ${alias}.view_scope    AS staff_view_scope,
  ${alias}.active        AS staff_active,
  ${alias}.deleted       AS staff_deleted,
  r.role_code     AS role_code,
  r.role_name     AS role_name
`;

const STAFF_COLUMNS = staffColumns("s");

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
  /*
   * The RETURNING carries the columns, rather than the outer query joining `staff` back.
   *
   * This one was CORRECT BY ACCIDENT and is the reason the others are being fixed with it. A
   * data-modifying CTE and the query around it share one snapshot taken before the statement, so
   * the join read this row as it was before the claim - and that happened not to matter, because
   * the only columns the UPDATE changes are `lpx_sub` and `updated_at`, and `STAFF_COLUMNS`
   * selects neither. Adding `lpx_sub` to that list later - to carry the `linked` flag the
   * administration screen has, say - would have made every first sign-in read it as still
   * unclaimed, in the authentication path, with no error anywhere.
   *
   * `sys_role` is still joined: the UPDATE does not touch it, so the snapshot is right for it.
   */
  sql: `
    WITH claimed AS (
      UPDATE staff
         SET lpx_sub = :sub, updated_at = now()
       WHERE id = :staff_id
         AND lpx_sub IS NULL
         AND deleted = false
         AND active = true
      RETURNING id, mgr_id, mgr_name, mgr_email, mgr_position, corp_code,
                role_id, view_scope, active, deleted
    )
    SELECT ${staffColumns("c")}
      FROM claimed c
      LEFT JOIN sys_role r ON r.id = c.role_id
  `,
  parameters: [param("sub", sub, "text"), param("staff_id", staffId, "id")],
  mapper: firstStaffRow,
});

/**
 * Provision - or repair - the staff row for an LPX administrator, and return its id.
 *
 * This is the recovery path for an empty NEOTMS. Everything above assumes a `staff` table that
 * somebody has already populated; immediately after `db/002..005` nobody has, so `StaffByLpxSubOps`
 * finds nothing, `StaffUnclaimedByEmailOps` finds nothing, and every sign-in is refused with "not
 * registered as NEOTMS staff" - including the sign-in of the person who would have registered the
 * others. Only a caller holding `lpx.admin.access` reaches this (see NeotmsAuthGuard), and only
 * when their own lookup came back missing or inactive.
 *
 * ALL OF THE DECISION IS IN THE DATABASE, deliberately, and that is why this file - which is
 * otherwise only queries - calls a function. Three reasons, in order of how much they cost if
 * ignored:
 *
 *   1. It is one statement, so it is atomic without a transaction. Supavisor's transaction mode
 *      hands the connection back at COMMIT, so a read-then-decide-then-write sequence from here
 *      could be spread over three different backends with other work interleaved. Two
 *      administrators signing in together would both find no row and both insert one, and one
 *      person would end up with two staff records - which splits their project history, because
 *      `mgr_id` is what every legacy `REG_ID` points at.
 *   2. The repair, adopt and mint branches all need `FOR UPDATE` and a `unique_violation` handler
 *      to be correct under that race. Those exist in SQL and have no equivalent here.
 *   3. `role_id`, `view_scope` and `active` are the three values this codebase refuses to let a
 *      caller influence. Deciding them inside a `SECURITY INVOKER` function with a pinned
 *      `search_path` keeps the decision in the same place as the constraints that bound it.
 *
 * It returns the id and not the row, because a volatile function and a `JOIN staff` in the same
 * statement would read the snapshot taken before the function ran and come back empty. The caller
 * re-reads through `StaffByLpxSubOps`, which is an ordinary statement with a fresh snapshot.
 *
 * Idempotent: called twice for the same subject it returns the same id the second time. It never
 * downgrades - an explicitly assigned role, or a `view_scope` of 'N', survives a repair.
 *
 * See db/006_bootstrap.sql section 4 for the branches and for the consequence stated plainly there:
 * a holder of this authority cannot be locked out of NEOTMS from inside NEOTMS. Revocation is
 * removing the authority on LPX, or blanking `NEOTMS_BOOTSTRAP_AUTHORITY_ID`.
 */
export const StaffBootstrapSuperuserOps: (
  sub: string,
  email: string | null,
  name: string | null,
) => SqlOps<string | null> = (sub, email, name) => ({
  /*
   * The three `::text` casts are not decoration. node-postgres sends these parameters with no
   * declared type, and PostgreSQL resolves an unknown-typed argument by looking for a unique
   * function of this name and arity. That works today and would start failing - at runtime, on the
   * bootstrap path specifically, which is the path nobody exercises again after go-live - the day
   * somebody adds a second `staff_bootstrap_superuser` overload. Casting pins the signature.
   */
  sql: `SELECT staff_bootstrap_superuser(:sub::text, :email::text, :name::text) AS staff_id`,
  parameters: [
    param("sub", sub, "text"),
    // NULL rather than '' when userInfo omits them: the function tests these with NULLIF(btrim(..))
    // and treats blank and absent alike, but a NULL that arrives as '' would be stored as '' by the
    // mint branch and break every `IS NULL` check against `mgr_email` afterwards.
    param("email", email, "text"),
    param("name", name, "text"),
  ],
  mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "staff_id") : null),
});

/**
 * Create the staff row for an employee registering themselves, and return its id.
 *
 * Deliberately next to `StaffBootstrapSuperuserOps`, because the two are the only paths in this
 * system that mint a `staff` row and the difference between them is the thing worth being able to
 * see at a glance:
 *
 *   * The bootstrap runs for a caller holding `lpx.admin.access` and produces a WORKING ACCOUNT -
 *     it assigns a role, because its entire purpose is to get the first administrator in.
 *   * This one runs for anybody holding the NEOTMS app authority and produces a REQUEST - `role_id`
 *     is NULL, so the row grants nothing until an administrator assigns a role on the staff
 *     administration screen.
 *
 * It follows the bootstrap's shape for the same three reasons given there, and the first applies
 * more sharply here. The decision is "does this subject already have a row, and if not which free
 * `mgr_id` can it take" - a read, then a write, against a column with a UNIQUE constraint. Under
 * Supavisor's transaction mode those would be two different backends, so two tabs submitting the
 * form together would both find nothing and both insert; one person would end up with two staff
 * records, and because `mgr_id` is what every legacy `REG_ID` points at, their history would be
 * split across both from that day on. As one statement calling one function it is atomic without a
 * transaction, and the `unique_violation` handler inside decides the collision.
 *
 * It also returns the id rather than the row, for the reason the bootstrap does: a volatile
 * function and a `JOIN staff` in one statement would read the snapshot taken before the function
 * ran and come back empty. The caller re-reads through the ordinary path - and in fact re-reads
 * through `getProfile`, so the response it builds is the same `ProfileView` the SPA would get from
 * `/api/v0/me` a moment later, built by the same code.
 *
 * Idempotent per subject: called twice it returns the same id and changes nothing. Notably it does
 * NOT update - a second submission cannot rewrite the name on a row an administrator may already
 * have approved. See db/009_selfservice.sql, which also records why there is no adopt-by-email
 * branch here when the bootstrap has one.
 */
type SelfRegisterProfile = {
  name: string;
  nameEng?: string | null;
  email?: string | null;
  phone?: string | null;
  position?: string | null;
};

/**
 * The two sign-up functions, which differ only in the name they call.
 *
 * They take the same seven arguments and answer the same way; what differs is the row they leave
 * behind, and that difference is entirely inside SQL - `staff_self_register` writes `role_id NULL`,
 * `staff_self_register_bootstrap` writes the NEOTMS_SYSADMIN role and `view_scope 'Y'`. Neither
 * takes a role, a scope or an active flag as an argument, which is the property db/001 section 1
 * exists to keep: the only write path an unapproved account can reach cannot be told what to grant.
 *
 * Built from one factory so the parameter handling below - the `?? null`s, the untyped IP - cannot
 * drift between them. The function name is a union of two literals rather than a string, so there
 * is no interpolation here that could carry anything else.
 */
const selfRegisterOps =
  (
    fn: "staff_self_register" | "staff_self_register_bootstrap",
  ): ((sub: string, profile: SelfRegisterProfile, ip: string | null) => SqlOps<string | null>) =>
  (sub, profile, ip) => ({
  // Every argument cast, for the reason spelled out on `StaffBootstrapSuperuserOps`: node-postgres
  // sends these untyped, PostgreSQL resolves an untyped argument by finding a unique function of
  // this name and arity, and a seven-argument signature of all-text is exactly the kind somebody
  // adds an overload of. The casts pin it.
  sql: `
    SELECT ${fn}(
             :sub::text,
             :name::text,
             :name_eng::text,
             :email::text,
             :phone::text,
             :position::text,
             :ip::text
           ) AS staff_id
  `,
  parameters: [
    param("sub", sub, "text"),
    param("name", profile.name, "text"),
    /*
     * `?? null` on all four, and not `?? ""`.
     *
     * `SelfProfileSchema` uses `settable(...)`, so a field the form left empty arrives as
     * `undefined` and a field the user cleared arrives as `null`. The function treats blank and
     * absent alike - every one of these is wrapped in `NULLIF(btrim(...), '')` - so the distinction
     * does not survive into the row, and that is correct for a CREATE: there is nothing to leave
     * alone. What matters is that `undefined` must not reach `param` as a bound value of its own,
     * because an unbound parameter is a statement that fails rather than a column left NULL.
     */
    param("name_eng", profile.nameEng ?? null, "text"),
    param("email", profile.email ?? null, "text"),
    param("phone", profile.phone ?? null, "text"),
    param("position", profile.position ?? null, "text"),
    // Text, not inet, and that is the point: `clientInet` only shape-checks the header, so a value
    // like "1.2.3.4.5" reaches here intact. Casting it in SQL would abort the registration; the
    // function casts it inside a subtransaction and stores NULL if it will not parse.
    param("ip", ip, "text"),
  ],
  mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "staff_id") : null),
});

export const StaffSelfRegisterOps = selfRegisterOps("staff_self_register");

/**
 * The same sign-up, for an account holding the LPX bootstrap authority - approved on arrival.
 *
 * `role_id` is the NEOTMS_SYSADMIN role and `view_scope` is 'Y', so this identity has a working
 * administrator account the moment the form is submitted, with nobody to approve it. The eligibility
 * decision is NOT here and is not in SQL: it is `holdsBootstrapAuthority()` in NeotmsAuthGuard,
 * reading a verified authority list that the database cannot see. This constant must therefore only
 * ever appear behind that test - `NeotmsRegistrationManager` is the one place it may be named.
 */
export const StaffSelfRegisterBootstrapOps = selfRegisterOps("staff_self_register_bootstrap");

/**
 * Everything one role has been granted.
 *
 * Read in full rather than per-permission-per-request: it is a few dozen short strings, one round
 * trip answers every question a request will ask, and it means a handler cannot cause a database
 * call by asking a permission question.
 *
 * There is no `active` filter because there is no active column. A grant is a row; revoking it is
 * deleting the row. A disabled grant that still exists would be a second way to say "not granted",
 * and two ways to say one thing is how the old pair of tables came to disagree.
 */
export const RolePermissionsOps: (roleId: string) => SqlOps<GrantedPermissions> = (roleId) => ({
  sql: `
    SELECT p.permission AS permission
      FROM sys_role_permission p
     WHERE p.role_id = :role_id
  `,
  parameters: [param("role_id", roleId, "id")],
  mapper: (rows) => {
    const granted = new Set<string>();
    for (const row of rows) {
      const permission = readText(row, "permission");
      if (permission) granted.add(permission);
    }
    return granted;
  },
});

/**
 * What one person may BE: the attributes on their staff row.
 *
 * Per-person, not per-role, and that is the distinction the old schema could not draw at all. A
 * role says what may be done; an attribute says what somebody may be named as, which is a property
 * of the human. The two people who may be a PM here hold the same role as everybody else.
 */
export const StaffAttributesOps: (staffId: string) => SqlOps<ReadonlySet<string>> = (staffId) => ({
  sql: `
    SELECT a.attribute AS attribute
      FROM staff_attribute a
     WHERE a.staff_id = :staff_id
  `,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => {
    const held = new Set<string>();
    for (const row of rows) {
      const attribute = readText(row, "attribute");
      if (attribute) held.add(attribute);
    }
    return held;
  },
});
