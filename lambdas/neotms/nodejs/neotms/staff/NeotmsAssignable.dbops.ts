// SPDX-License-Identifier: MIT
//
// Who may be NAMED as a project's PM or sales manager, and whether a particular id may be.
//
// ## Why this is a third staff module
//
// `auth/NeotmsStaff.dbops.ts` reads the CALLER's own row on every request. `NeotmsStaffAdmin.dbops`
// reads and writes OTHER PEOPLE's rows from behind `STAFF:read` / `STAFF:update`. This file is a
// third class with a third audience: a NAME LIST that any staff member may read, because anybody
// who can create a project has to be able to fill in its two assignee fields.
//
// Keeping it separate is what lets the route be gated on `anyStaff` without widening either of the
// other two. A reviewer asking "what can a plain user read about colleagues" has one short file to
// read, and the answer is: the ids and names of the people eligible for those two roles, and
// nothing else. No email, no phone, no role, no view scope.
//
// ## The list and the check are deliberately not the same question
//
//   * `AssignableStaffOps` answers "who may I newly assign" - ACTIVE staff holding the attribute.
//   * `ProjectAssigneeCheckOps` answers "may this id be stored" - any undeleted staff holding it,
//     active or not.
//
// The asymmetry is the point. A project assigned years ago to somebody who has since left still has
// to be editable: if the check required `active`, correcting a typo in such a project's name would
// be refused because of its historical PM, and the message would name a person the editor never
// mentioned. Meanwhile offering a departed colleague in a picker is simply a mistake waiting to be
// made, so the list does not.

import {
  param,
  readId,
  readInt,
  readText,
  type SqlOps,
} from "../../utils/PostgresUtils.js";
import {
  NEOTMS_USER_ATTRIBUTE_PM,
  NEOTMS_USER_ATTRIBUTE_SALES_MANAGER,
} from "../../auth/NeotmsAuthorities.js";

/** One person a project may be assigned to. The whole shape - see the module header. */
export type AssignableStaff = {
  id: string;
  name: string | null;
  /**
   * The legacy readable key, for the picker's subtitle.
   *
   * Two colleagues can share a name, and this list is short enough that the duplicate would sit
   * directly under its twin with nothing to tell them apart. `mgr_id` is what appears in
   * `created_by` on everything they touch, so it is also the value somebody would use to check.
   */
  mgrId: string;
};

/**
 * Everybody who may be newly named as the holder of one assignable attribute.
 *
 * `active = true`, unlike the check below. Ordered by name so the picker is stable between reads -
 * an unordered list is a list whose first entry moves, and the first entry is the one people pick
 * by muscle memory.
 *
 * The attribute arrives as a bound parameter rather than interpolated, and the route validates it
 * against `NEOTMS_ASSIGNABLE_ATTRIBUTES` before calling: the superuser attribute is not assignable
 * to a project and must not be listable here, or this endpoint becomes "who are the administrators"
 * for every staff member in the company.
 */
export const AssignableStaffOps: (attribute: string) => SqlOps<AssignableStaff[]> = (
  attribute,
) => ({
  sql: `
    SELECT s.id       AS staff_id,
           s.mgr_name AS staff_name,
           s.mgr_id   AS mgr_id
      FROM staff s
     WHERE s.deleted = false
       AND s.active = true
       AND EXISTS (
             SELECT 1
               FROM staff_attribute a
              WHERE a.staff_id = s.id
                AND a.attribute = :attribute
           )
     ORDER BY s.mgr_name NULLS LAST, s.mgr_id
  `,
  parameters: [param("attribute", attribute, "text")],
  mapper: (rows) =>
    rows.map((row) => ({
      id: readId(row, "staff_id") ?? "",
      name: readText(row, "staff_name"),
      mgrId: readText(row, "mgr_id") ?? "",
    })),
});

/** What is wrong with a named assignee, or null if nothing is. */
export type AssigneeProblem = "missing" | "ineligible";

export type AssigneeCheck = {
  pm: AssigneeProblem | null;
  mgr: AssigneeProblem | null;
};

/**
 * May these two ids be stored as this project's PM and sales manager?
 *
 * ## One statement for both, and four counts rather than two
 *
 * "Exists" and "holds the attribute" are counted separately because they are DIFFERENT MISTAKES
 * with different fixes: a stale id from an old tab is a client problem, and a real colleague who has
 * not been marked as a PM is an administrator's job on the staff administration screen. One boolean would
 * collapse them into "that PM cannot be used", which tells nobody what to do next.
 *
 * ## A NULL id is not a problem
 *
 * `s.id = NULL` matches nothing, so every count is 0 and the mapper reports `null` for a side the
 * caller did not name. Clearing an assignee is a legitimate edit - a project between PMs has none -
 * and must not be refused as "no such staff member".
 */
export const ProjectAssigneeCheckOps: (
  pmId: string | null,
  mgrId: string | null,
) => SqlOps<AssigneeCheck> = (pmId, mgrId) => ({
  sql: `
    SELECT
      (SELECT count(*) FROM staff s
        WHERE s.id = :pm_id AND s.deleted = false)                     AS pm_exists,
      (SELECT count(*) FROM staff s
         JOIN staff_attribute a ON a.staff_id = s.id
        WHERE s.id = :pm_id AND s.deleted = false
          AND a.attribute = :pm_attribute)                             AS pm_eligible,
      (SELECT count(*) FROM staff s
        WHERE s.id = :mgr_id AND s.deleted = false)                    AS mgr_exists,
      (SELECT count(*) FROM staff s
         JOIN staff_attribute a ON a.staff_id = s.id
        WHERE s.id = :mgr_id AND s.deleted = false
          AND a.attribute = :mgr_attribute)                            AS mgr_eligible
  `,
  parameters: [
    param("pm_id", pmId, "id"),
    param("mgr_id", mgrId, "id"),
    param("pm_attribute", NEOTMS_USER_ATTRIBUTE_PM, "text"),
    param("mgr_attribute", NEOTMS_USER_ATTRIBUTE_SALES_MANAGER, "text"),
  ],
  mapper: (rows) => {
    const row = rows[0] ?? {};
    const count = (key: string): number => readInt(row, key) ?? 0;
    const verdict = (id: string | null, exists: number, eligible: number): AssigneeProblem | null => {
      if (id === null) return null;
      if (exists === 0) return "missing";
      return eligible === 0 ? "ineligible" : null;
    };
    return {
      pm: verdict(pmId, count("pm_exists"), count("pm_eligible")),
      mgr: verdict(mgrId, count("mgr_exists"), count("mgr_eligible")),
    };
  },
});
