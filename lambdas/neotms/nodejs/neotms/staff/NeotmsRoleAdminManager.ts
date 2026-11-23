// SPDX-License-Identifier: MIT
//
// Role administration: what a role MEANS, and what a person may BE named as.
//
// ## Why this is not part of NeotmsStaffAdminManager
//
// That file assigns an existing role to a person. This one decides what the role permits, and the
// difference is who is affected. Assigning 회계 to one colleague affects that colleague; adding
// `PO_APPROVE` to 회계 affects everybody who holds it, retroactively, and none of them are told.
//
// Every write here is behind `NeotmsRoute.superuser`, which is NOT a permission - see the comment
// on that field. Gating it on `NEOTMS_PERMISSION_STAFF_UPDATE` would mean the gate is editable
// through the thing it gates: a role holding that one permission could grant itself the other
// thirty-five in a single request.
//
// ## The three refusals, and why each is a refusal rather than a warning
//
// All three protect against the same shape of accident - an administrator removing the access that
// would let them undo the change - and all three are refusals because the asymmetry is the same. A
// wrong refusal costs a minute and a message to a colleague. A missing refusal costs a SQL session
// run by whoever has database credentials, which on this deployment is one person.
//
//   1. You cannot drop your own superuser attribute.
//   2. You cannot rename or delete the bootstrap role.
//   3. You cannot remove the last grant of `NEOTMS_PERMISSION_STAFF_UPDATE` while no superuser
//      exists to put it back.
//
// The third is the one `NeotmsStaffAdminManager` records as deliberately unimplemented, because
// counting it used to need the unconfirmed ROLE_1..ROLE_5 flag mapping. With a flat permission list
// there is no mapping to be wrong about, so it is implemented here - see `AdminReachCountsOps`.

import { pgExecute, pgQuery, pgTransaction, sqlState } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import { NEOTMS_USER_ATTRIBUTE_SUPERUSER } from "../../auth/NeotmsAuthorities.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { badRequest, notFound, ok, runDb } from "../NeotmsResult.js";
import type {
  RoleAdminCreate,
  RoleAdminUpdate,
  RolePermissionsInput,
  StaffAttributesInput,
} from "../neotms.schemas.js";
import {
  AdminReachCountsOps,
  BOOTSTRAP_ROLE_CODE,
  RoleAdminGetOps,
  RoleAdminListOps,
  RoleCreateOps,
  RoleDeleteOps,
  RolePermissionsAddOps,
  RolePermissionsPruneOps,
  RoleUpdateOps,
  StaffAttributesAddOps,
  StaffAttributesPruneOps,
  type RoleAdminRow,
} from "./NeotmsRoleAdmin.dbops.js";
import { StaffAdminGetOps, type StaffAdminRow } from "./NeotmsStaffAdmin.dbops.js";

/** `staff.role_id -> sys_role.id` is `ON DELETE RESTRICT`. */
const FOREIGN_KEY_VIOLATION = "23503";

export type RoleAdminListView = { items: RoleAdminRow[] };

/** Every role with its grants, retired ones included. */
export async function listRolesForAdmin(): Promise<ResponseData<RoleAdminListView | string>> {
  return runDb("list roles for administration", async () => {
    const items = (await pgQuery(RoleAdminListOps())).data;
    return ok({ items });
  });
}

/**
 * Create a role.
 *
 * The new role grants nothing. The screen opens the permission editor immediately afterwards, but
 * the API does not pretend the two are one step: a create that also took a permission list would
 * make "create a role" and "decide what it may do" the same audit entry, and they are the two
 * halves somebody reviewing a surprise would want to tell apart.
 *
 * ## The request carries no role code, and there is no 409 here any more
 *
 * It used to. An administrator typed a code, and a code already taken - by a RETIRED role, which
 * the screen does not list - came back as a 409 explaining that codes are permanent. Both halves of
 * that are gone: `newRoleCode()` mints the code, so the only remaining way to hit the UNIQUE
 * constraint on `sys_role.role_code` is a collision between two random UUIDs, which is not a
 * condition an administrator can do anything about and not one worth a sentence of its own.
 * `runDb` reports it as a 500, which is the honest status for "something impossible happened".
 */
export async function createRole(
  caller: NeotmsCaller,
  input: RoleAdminCreate,
): Promise<ResponseData<RoleAdminRow | string>> {
  return runDb("create role", async () => {
    const row = (await pgExecute(RoleCreateOps(input, caller.mgrId))).data;
    return row ? ok(row, 201) : { status: 500 as const, body: "The role was not created" };
  });
}

/**
 * Rename a role, or retire it.
 *
 * The bootstrap role may be edited but not renamed, and the schema already makes `roleCode`
 * unwritable for every role - so the refusal below is about its LABEL and its active flag. Retiring
 * the bootstrap role would leave `staff_bootstrap_superuser()` assigning a role that the assignment
 * dropdown no longer offers, which is a confusing half-state rather than a broken one, so it is
 * refused too.
 */
export async function updateRole(
  id: string,
  input: RoleAdminUpdate,
): Promise<ResponseData<RoleAdminRow | string>> {
  if (Object.keys(input).length === 0) {
    return badRequest(
      "No editable field was supplied. This endpoint writes only `roleName` and `active`; a " +
        "role's code is permanent, because other things resolve the role by it.",
    );
  }

  return runDb("update role", async () => {
    const existing = (await pgQuery(RoleAdminGetOps(id))).data;
    if (!existing) return notFound("role");

    if (existing.roleCode === BOOTSTRAP_ROLE_CODE && input.active === false) {
      return {
        status: 409 as const,
        body:
          `'${BOOTSTRAP_ROLE_CODE}' cannot be retired. It is the role ` +
          `staff_bootstrap_superuser() assigns to the first administrator who signs in, so ` +
          `retiring it would leave that recovery path handing out a role this screen no longer ` +
          `offers. Create a role of your own and retire that instead.`,
      };
    }

    const row = (await pgExecute(RoleUpdateOps(id, input))).data;
    return row ? ok(row) : notFound("role");
  });
}

/**
 * Delete a role.
 *
 * Only possible when nobody holds it. The 23503 is caught and turned into a sentence with the
 * numbers in it, because the FK's own message names a constraint and the administrator's next
 * question is "held by whom" - and the answer may be "nobody you can see", since a soft-deleted
 * staff row still holds its role and still blocks the delete.
 */
export async function deleteRole(id: string): Promise<ResponseData<{ id: string } | string>> {
  return runDb("delete role", async () => {
    const existing = (await pgQuery(RoleAdminGetOps(id))).data;
    if (!existing) return notFound("role");

    if (existing.roleCode === BOOTSTRAP_ROLE_CODE) {
      return {
        status: 409 as const,
        body:
          `'${BOOTSTRAP_ROLE_CODE}' cannot be deleted. staff_bootstrap_superuser() looks this ` +
          `role up by name to admit the first administrator into an empty or locked-out ` +
          `database, so deleting it removes the way back in at the moment it would be needed.`,
      };
    }

    /*
     * Checked before the DELETE as well as caught after it. The pre-check is what produces a useful
     * message; the catch is what makes the endpoint correct, because somebody can be assigned this
     * role between the two statements.
     */
    if (existing.holders > 0) {
      return { status: 409 as const, body: holdersRefusal(existing) };
    }

    try {
      const deleted = (await pgExecute(RoleDeleteOps(id))).data;
      return deleted ? ok(deleted) : notFound("role");
    } catch (err) {
      if (sqlState(err) === FOREIGN_KEY_VIOLATION) {
        return { status: 409 as const, body: holdersRefusal(existing) };
      }
      throw err;
    }
  });
}

/**
 * The "somebody still holds this" message.
 *
 * Says both numbers when they differ, because that difference is the confusing case: the screen
 * shows `staffCount` and the FK counts `holders`, so a role held only by leavers looks deletable
 * and is not. Without the second number the refusal reads as a bug in the screen.
 */
function holdersRefusal(role: RoleAdminRow): string {
  const hidden = role.holders - role.staffCount;
  const base =
    `'${role.roleCode}' is still assigned to ${String(role.holders)} staff ` +
    `row${role.holders === 1 ? "" : "s"} and cannot be deleted. Move them to another role first, ` +
    `or retire this one instead - a retired role stops being offered while the people who hold ` +
    `it keep it.`;
  if (hidden <= 0) return base;
  return (
    base +
    ` ${String(hidden)} of them ${hidden === 1 ? "is a removed staff row" : "are removed staff rows"}, ` +
    `which the staff screen does not list but which still holds the role.`
  );
}

/**
 * Replace a role's permission set.
 *
 * Two statements in one transaction: prune what is no longer wanted, then add what is new. The
 * transaction is not a precaution - without it a failure between the two leaves the role holding
 * fewer permissions than either the old or the new set, and "somebody quietly lost access" is not a
 * symptom anybody reports as a half-applied request.
 *
 * The lockout check runs BEFORE the write and asks the question with this role's grants already
 * discounted, which is the only way to ask it: counting after the prune would see the answer the
 * prune created.
 */
export async function setRolePermissions(
  caller: NeotmsCaller,
  id: string,
  input: RolePermissionsInput,
): Promise<ResponseData<RoleAdminRow | string>> {
  return runDb("set role permissions", async () => {
    const existing = (await pgQuery(RoleAdminGetOps(id))).data;
    if (!existing) return notFound("role");

    const refusal = await lockoutRefusal(caller, existing, input.permissions);
    if (refusal) return { status: 409 as const, body: refusal };

    const row = await pgTransaction(async (client) => {
      await pgExecute(RolePermissionsPruneOps(id, input.permissions), client);
      if (input.permissions.length > 0) {
        await pgExecute(RolePermissionsAddOps(id, input.permissions, caller.mgrId), client);
      }
      /*
       * Read back inside the transaction, so the response is the state this request produced
       * rather than whatever a concurrent edit left behind a moment later.
       */
      return (await pgQuery(RoleAdminGetOps(id), client)).data;
    });

    return row ? ok(row) : notFound("role");
  });
}

/**
 * Would this write leave nobody able to reach the staff screens?
 *
 * Returns a refusal message, or null to proceed. The question is asked as "after this change, is
 * there still a way for somebody to administer users", and there are two ways for the answer to be
 * yes: an active staff member whose role grants `NEOTMS_PERMISSION_STAFF_UPDATE`, or a superuser,
 * who passes every permission check regardless.
 *
 * ## It is a floor, not the whole answer
 *
 * `isSuperuser` is also true for holders of the bootstrap authority, and SQL cannot see LPX's
 * authority list - so the count of superusers in the database may understate reality. That makes
 * this check conservative in the safe direction: it can refuse a change that would in fact have
 * been recoverable through an LPX administrator, and it cannot permit one that would not. The
 * caller is told which two facts to change to proceed, so a wrong refusal is not a dead end.
 */
async function lockoutRefusal(
  caller: NeotmsCaller,
  role: RoleAdminRow,
  nextPermissions: readonly string[],
): Promise<string | null> {
  const STAFF_UPDATE = "NEOTMS_PERMISSION_STAFF_UPDATE";

  const had = role.permissions.includes(STAFF_UPDATE);
  const keeps = nextPermissions.includes(STAFF_UPDATE);
  // Only a removal can lock anybody out. Adding it, or leaving it alone, cannot.
  if (!had || keeps) return null;

  const counts = (await pgQuery(AdminReachCountsOps(role.id))).data;
  if (counts.admins > 0 || counts.superusers > 0) return null;

  return (
    `Removing ${STAFF_UPDATE} from '${role.roleCode}' would leave nobody able to administer ` +
    `users: no other active staff member holds it through their role, and no account holds the ` +
    `superuser attribute. The screen that could put it back is the one this change closes.\n\n` +
    `Either grant ${STAFF_UPDATE} to another role first, or give somebody the superuser ` +
    `attribute on the 사용자 관리 screen - then make this change.` +
    (caller.isSuperuser
      ? ` You hold the superuser override yourself, but it comes from your LPX administrator ` +
        `authority rather than from a stored attribute, and that authority can be switched off ` +
        `from outside this application.`
      : "")
  );
}

/**
 * Replace a person's attribute set.
 *
 * The attributes are what let somebody BE named - as a 담당영업 or a 담당PM on a project - plus the
 * superuser override. Nothing here lets its holder open a screen, which is why it is a separate
 * write from the role: granting 담당PM and granting the PM role are different decisions that
 * happen to be made by the same person.
 */
export async function setStaffAttributes(
  caller: NeotmsCaller,
  id: string,
  input: StaffAttributesInput,
): Promise<ResponseData<StaffAdminRow | string>> {
  /*
   * The caller removing their own override.
   *
   * Refused for the same reason `updateStaff` refuses a caller clearing their own role, with one
   * addition: this is the override that works when a role is misconfigured, so dropping it is
   * giving up the recovery path and the ordinary path in one request. Another superuser can do it,
   * which is the supported way to step down.
   */
  if (
    id === caller.staffId &&
    caller.attributes.has(NEOTMS_USER_ATTRIBUTE_SUPERUSER) &&
    !input.attributes.includes(NEOTMS_USER_ATTRIBUTE_SUPERUSER)
  ) {
    return {
      status: 409,
      body:
        "You cannot remove your own superuser attribute. It is the override that still works when " +
        "a role has been misconfigured, so giving it up is the one change this screen cannot undo " +
        "for you. Ask another superuser to remove it.",
    };
  }

  return runDb("set staff attributes", async () => {
    const existing = (await pgQuery(StaffAdminGetOps(id))).data;
    if (!existing) return notFound("staff member");

    const row = await pgTransaction(async (client) => {
      await pgExecute(StaffAttributesPruneOps(id, input.attributes), client);
      if (input.attributes.length > 0) {
        await pgExecute(StaffAttributesAddOps(id, input.attributes, caller.mgrId), client);
      }
      return (await pgQuery(StaffAdminGetOps(id), client)).data;
    });

    return row ? ok(row) : notFound("staff member");
  });
}
