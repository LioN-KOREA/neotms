// SPDX-License-Identifier: MIT
//
// `GET /api/v0/staff/assignable?attribute=...` - the two assignee pickers on the project form.
//
// The widest-read endpoint about other people in the application, and the only one any staff member
// may call. What it returns is in `AssignableStaff`: an id, a name, and the legacy readable key.
// That is already less than the project list shows about the same people - every project row carries
// `prj_pm_name` and `prj_mgr_name` to anybody who may see the project.
//
// Gated on `anyStaff` rather than on a permission, like `/api/v0/codes` and `/api/v0/fx-rates`,
// because it is the same kind of thing: a lookup list a form cannot be filled in without. Gating it
// on `PROJECT:create` would be the tighter-looking answer and the wrong one - the project EDIT form
// needs it too, and so would the job form the day its PM field is wired up, so the gate would have
// to be widened to a union of permissions that between them mean "is a user of this system".

import { pgQuery } from "../../utils/PostgresUtils.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { NEOTMS_ASSIGNABLE_ATTRIBUTES } from "../../auth/NeotmsAuthorities.js";
import { badRequest, ok, runDb } from "../NeotmsResult.js";
import { AssignableStaffOps, type AssignableStaff } from "./NeotmsAssignable.dbops.js";

export type AssignableStaffView = { attribute: string; items: AssignableStaff[] };

/**
 * List the people who may be named as the holder of one assignable attribute.
 *
 * The attribute is REQUIRED and is checked against the closed list. Defaulting it would mean one of
 * the two pickers silently showing the other one's people - a project whose sales manager is somebody
 * with only the PM attribute, saved without any error, and refused later by the write check with a
 * message about a field the user believed they had filled in correctly.
 *
 * `NEOTMS_USER_ATTRIBUTE_SUPERUSER` is deliberately not in that list. It is not assignable to a
 * project, and answering it here would turn this into "who are the administrators", readable by
 * every staff member.
 */
export async function listAssignableStaff(
  request: RequestData,
): Promise<ResponseData<AssignableStaffView | string>> {
  const attribute = (request.queryParams["attribute"] ?? "").trim();
  if (!(NEOTMS_ASSIGNABLE_ATTRIBUTES as readonly string[]).includes(attribute)) {
    return badRequest(
      `\`attribute\` must be one of ${NEOTMS_ASSIGNABLE_ATTRIBUTES.join(", ")}. ` +
        "The superuser attribute is not assignable to a project and is not listed here.",
    );
  }

  return runDb("list assignable staff", async () => {
    const items = (await pgQuery(AssignableStaffOps(attribute))).data;
    return ok({ attribute, items });
  });
}
