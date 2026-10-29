// SPDX-License-Identifier: MIT
//
// The 사용자 관리 endpoints: who works here, what roles exist, and who holds which.
//
// ## This is the most dangerous endpoint in the application
//
// `PATCH /api/v0/admin/staff/:id` writes `staff.role_id`, and every permission in NEOTMS resolves
// from that column through `sys_role_auth`. A caller who can reach this route can grant themselves
// or anybody else the full menu x action matrix. That is not a flaw - somebody has to be able to
// approve a new colleague - but it does mean the gate on the route table (`menu: NeotmsMenu.STAFF`,
// `action: "update"`) is the single thing standing between a PM and total control of the system.
//
// In LKTMS the equivalent value arrived in an unsigned cookie. The improvement is not merely that it
// now lives in a table; it is that the write has exactly one statement
// (`StaffAdminUpdateOps`), one route, and one menu, so the question "what can change somebody's
// permissions" has a finite answer.
//
// ## Why the self-lockout guards are here and not in the database
//
// Two refusals below stop a caller editing their own row into uselessness. They are in TypeScript
// rather than in a CHECK constraint because they depend on WHO IS ASKING, which the database does
// not know - the connection is a single pooled application role, not the end user. A trigger would
// have to be told the caller, i.e. trust a value the application passed it, which is the same
// trust boundary with more moving parts.
//
// ## What these guards do NOT cover, stated plainly
//
// They stop a caller CLEARING their own role or DEACTIVATING themselves. They do not stop a caller
// assigning themselves a role that happens to lack 사용자 관리 rights, and they do not stop the last
// administrator demoting a DIFFERENT administrator. Either can leave the company with nobody able
// to assign roles.
//
// A complete guard would be "refuse if this change leaves no active staff holding STAFF.update",
// which needs a count over `sys_role_auth`. It is deliberately not implemented here, for one
// specific reason: that count would have to read `role_3` as "update", and the ROLE_1..ROLE_5 ->
// action mapping inherited from LKTMS is still UNCONFIRMED (see `ACTION_INDEX` in
// NeotmsAuthGuard.ts). A security refusal built on an unverified column mapping either blocks
// legitimate changes or permits the lockout it was written to prevent, and both are worse than the
// documented recovery path:
//
//   SELECT staff_bootstrap_superuser(...);   -- db/006_bootstrap.sql
//
// which re-mints or repairs a superuser from the SQL editor. Confirm the action mapping and this
// becomes a short query worth adding.

import { pgExecute, pgQuery, sqlState } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { badRequest, notFound, ok, runDb } from "../NeotmsResult.js";
import type { StaffAdminUpdate } from "../neotms.schemas.js";
import {
  RoleListOps,
  StaffAdminListOps,
  StaffAdminUpdateOps,
  type RoleOption,
  type StaffAdminRow,
} from "./NeotmsStaffAdmin.dbops.js";

/** `staff.role_id` names a `sys_role` row that does not exist. */
const FOREIGN_KEY_VIOLATION = "23503";

export type StaffListView = { items: StaffAdminRow[] };
export type RoleListView = { items: RoleOption[] };

/**
 * Every staff row, approval-pending first.
 *
 * Takes no caller. A staff directory is not row-scoped data - `view_scope` narrows business tables
 * to "rows I own", and there is no sense in which an administrator owns a colleague - and an
 * administrator who could not see a pending request could not approve it. The gate is the menu, not
 * the WHERE clause.
 */
export async function listStaff(): Promise<ResponseData<StaffListView | string>> {
  return runDb("list staff", async () => {
    const items = (await pgQuery(StaffAdminListOps())).data;
    return ok({ items });
  });
}

/**
 * The assignable roles, for the dropdown.
 *
 * Separate from the staff listing rather than embedded in it: the role list is the same four or
 * five rows for every caller, and folding it into each staff response would send it again on every
 * refresh of a screen whose whole job is to be refreshed after a write.
 */
export async function listRoles(): Promise<ResponseData<RoleListView | string>> {
  return runDb("list roles", async () => {
    const items = (await pgQuery(RoleListOps())).data;
    return ok({ items });
  });
}

/**
 * Assign a role, a view scope, or the active flag.
 *
 * `input.roleId === null` is the interesting case and it is deliberately distinguishable from
 * `roleId` being absent: the schema is a `v.partial`, so an omitted key arrives as `undefined` and
 * an explicit `null` arrives as `null`. The two mean different things - "do not touch the role" and
 * "take the role away" - and conflating them would turn a scope-only edit into a silent revocation.
 */
export async function updateStaff(
  caller: NeotmsCaller,
  id: string,
  input: StaffAdminUpdate,
): Promise<ResponseData<StaffAdminRow | string>> {
  if (Object.keys(input).length === 0) {
    return badRequest(
      "No editable field was supplied. This endpoint writes only `roleId`, `viewScope` and " +
        "`active`; a person's name, email and phone are maintained by that person on their own " +
        "profile.",
    );
  }

  /*
   * The caller editing their own row.
   *
   * Refused rather than merely warned about, because the two failures are not symmetrical. If the
   * refusal is wrong the caller asks a colleague to make the change, which costs a minute. If the
   * refusal is missing and the change goes through, the caller is locked out of the screen that
   * would undo it, and recovery is a SQL statement run by whoever has database access - which on
   * this deployment is one person.
   *
   * `caller.staffId` and `id` are both `bigint`-as-string from the same column, so `===` compares
   * what it looks like it compares. No parsing, no radix, no Number() above 2^53.
   */
  if (id === caller.staffId) {
    if (input.roleId === null) {
      return {
        status: 409,
        body:
          "You cannot remove your own role. Doing so would revoke your access to this screen, " +
          "and nobody can restore a role except somebody who still has this screen. Ask another " +
          "administrator to change your role, or keep your role and change the other fields.",
      };
    }
    if (input.active === false) {
      return {
        status: 409,
        body:
          "You cannot deactivate your own account. If you are leaving, another administrator " +
          "should deactivate you after your access is no longer needed.",
      };
    }
  }

  return runDb("update staff", async () => {
    try {
      const row = (await pgExecute(StaffAdminUpdateOps(id, input))).data;
      return row ? ok(row) : notFound("staff member");
    } catch (err) {
      /*
       * The only FK on the three writable columns is `staff.role_id -> sys_role.id`, so a 23503
       * here can be nothing else. Caught by SQLSTATE and not by constraint name, as everywhere in
       * this codebase: the names are an implementation detail of 002_tables.sql and only some of
       * them are explicit.
       */
      if (sqlState(err) === FOREIGN_KEY_VIOLATION) {
        return badRequest(
          `There is no role with id '${String(input.roleId)}'. Pick one of the roles the ` +
            `dropdown offers - a role that has been retired is no longer assignable, though the ` +
            `people who already hold it keep it.`,
        );
      }
      throw err;
    }
  });
}
