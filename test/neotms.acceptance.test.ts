// SPDX-License-Identifier: MIT
//
// Project acceptance: the PM answers, and the answer survives.
//
// Like neotms.jobtype.test.ts and unlike neotms.test.ts, this file IMPORTS the dbops module and
// builds real statements, because the thing most worth protecting here is not visible in the source
// as a substring: `ProjectUpdateOps` must emit the acceptance reset ONLY when the request body
// actually mentions the PM, and that is a property of the statement it produces for a given input.
//
// The three facts these tests exist to keep true:
//
//   1. An edit that re-submits the SAME PM does not wipe an acceptance. The project form PATCHes
//      every field on every save, so an unconditional reset would ask a PM to accept the same
//      project again each time somebody fixed a typo - with nothing on any screen to explain it.
//   2. Only the assigned PM can answer, and only once. Both are predicates in the UPDATE rather
//      than checks in TypeScript, so there is no window between the test and the write.
//   3. `acceptance_status` cannot be written by an ordinary project edit. It has no writable-field
//      spec, which is what makes the endpoint above the only way the column moves.
//
// The SQL semantics themselves - that `p.prj_pm_id` on the right of a SET reads the OLD value, that
// the CHECKs refuse 2 and refuse a 0 answer, that the FKs cascade one way and restrict the other -
// were rehearsed against a real PostgreSQL 17 before this file was written. Twelve cases, in
// db/005's own verification block and in the session notes; none of them is visible from here.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT_ACCEPTANCE_ACCEPTED,
  PROJECT_ACCEPTANCE_ASSIGNED,
  PROJECT_ACCEPTANCE_REJECTED,
  ProjectAcceptanceHistoryOps,
  ProjectAcceptanceOps,
  ProjectAcceptanceRecordOps,
  ProjectAcceptanceResetOps,
  ProjectCreateOps,
  ProjectUpdateOps,
} from "../lambdas/neotms/nodejs/neotms/projects/NeotmsProject.dbops.js";
import {
  AssignableStaffOps,
  ProjectAssigneeCheckOps,
} from "../lambdas/neotms/nodejs/neotms/staff/NeotmsAssignable.dbops.js";
import {
  NEOTMS_ASSIGNABLE_ATTRIBUTES,
  NEOTMS_USER_ATTRIBUTE_PM,
  NEOTMS_USER_ATTRIBUTE_SALES_MANAGER,
  NEOTMS_USER_ATTRIBUTE_SUPERUSER,
} from "../lambdas/neotms/nodejs/auth/NeotmsAuthorities.js";
import type { WriteContext } from "../lambdas/neotms/nodejs/neotms/NeotmsWrite.js";
import type { NeotmsCaller } from "../lambdas/neotms/nodejs/auth/NeotmsAuthGuard.js";

const caller: NeotmsCaller = {
  sub: "sub-1",
  staffId: "42",
  mgrId: "mgr-1",
  name: "Scoped PM",
  email: "pm@example.com",
  corpCode: null,
  roleId: "1",
  roleCode: "PM",
  roleName: "PM",
  permissions: new Set<string>(),
  attributes: new Set<string>(),
  isSuperuser: false,
  viewScope: "OWN",
  seesEveryRow: false,
};

const ctx: WriteContext = { actor: "mgr-1", ip: "203.0.113.7" };

/** Whitespace collapsed, so an assertion is about the SQL rather than about its indentation. */
const flat = (sql: string): string => sql.replace(/\s+/g, " ").trim();

const repoFile = (...segments: string[]): string =>
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ...segments),
    "utf8",
  );

/* -------------------------------------------------------------------------- */
/* The reset                                                                  */
/* -------------------------------------------------------------------------- */

describe("reassigning the PM resets the acceptance, and nothing else does", () => {
  test("an edit that mentions the PM resets only when the id differs", () => {
    /*
     * The CASE is what makes "only when it differs" true, and it has to be IN THE STATEMENT: the
     * old id is not in the request, and reading it first would be a second round trip and a race.
     * `p.prj_pm_id` on the right-hand side of a SET reads the row's pre-statement value, which is
     * the one rule in PostgreSQL's snapshot behaviour that is useful here rather than a hazard.
     */
    const sql = flat(ProjectUpdateOps(caller, "7", { prjPmId: "99" }, ctx).sql);

    expect(sql).toContain("acceptance_status = CASE");
    expect(sql).toContain("WHEN p.prj_pm_id IS DISTINCT FROM :prj_pm_id");
    expect(sql).toContain(`THEN ${String(PROJECT_ACCEPTANCE_ASSIGNED)}`);
    expect(sql).toContain("ELSE p.acceptance_status");
  });

  test("IS DISTINCT FROM, not <>, so unassigning the PM counts as a change", () => {
    // `prj_pm_id <> NULL` is NULL, which is not true, so a project whose PM is being CLEARED would
    // keep an acceptance given by the person who is no longer on it. The other direction matters
    // too: a project that had no PM and still has none must not be reset to a value it already has.
    const sql = flat(ProjectUpdateOps(caller, "7", { prjPmId: null }, ctx).sql);
    expect(sql).toContain("IS DISTINCT FROM");
    expect(sql).not.toMatch(/prj_pm_id\s*<>\s*:prj_pm_id/);
  });

  test("an edit that does not mention the PM emits no reset at all", () => {
    /*
     * Two failures, one assertion. Emitting the CASE unconditionally would (a) reference
     * `:prj_pm_id`, which `updateFragments` has not bound for this body, making the commonest write
     * in the application a failed statement, and (b) if it were bound to NULL instead, wipe the
     * acceptance of every project whose name somebody corrected.
     */
    const sql = flat(ProjectUpdateOps(caller, "7", { prjName: "새 이름" }, ctx).sql);
    // The SET clause alone. `acceptance_status` is legitimately in the RETURNING list of every one
    // of these statements - that is how the response carries the value back to the screen.
    const assignments = sql.slice(sql.indexOf(" SET "), sql.indexOf(" WHERE "));
    expect(assignments).not.toContain("acceptance_status");
    expect(assignments).not.toContain(":prj_pm_id");
  });

  test("no project write can set the column directly", () => {
    /*
     * The separation that makes the acceptance endpoint the only way in - the same one `po_approved`
     * has. If `acceptance_status` had a writable-field spec, every PM who may edit a project could
     * accept it for somebody else, or un-reject their own, through `PATCH /projects/{id}`.
     *
     * Checked on an UPDATE that names the PM, which is the one body that legitimately mentions the
     * column at all: the CASE is there, and a plain `acceptance_status = :acceptance_status` is not.
     */
    const update = flat(ProjectUpdateOps(caller, "7", { prjPmId: "99", prjName: "x" }, ctx).sql);
    expect(update).not.toContain("acceptance_status = :");

    // And the INSERT never names it, so a created project starts at the column default. Asserted
    // over the COLUMN LIST, because the RETURNING clause names it on purpose.
    const create = flat(
      ProjectCreateOps({ prjName: "x", customerId: "1", prjPmId: "42" }, ctx).sql,
    );
    const columns = create.slice(create.indexOf("("), create.indexOf(") VALUES"));
    expect(columns).not.toContain("acceptance_status");
  });
});

/* -------------------------------------------------------------------------- */
/* The answer                                                                 */
/* -------------------------------------------------------------------------- */

describe("only the assigned PM answers, and only once", () => {
  const ops = ProjectAcceptanceOps(caller, "7", PROJECT_ACCEPTANCE_ACCEPTED, ctx);
  const sql = flat(ops.sql);

  test("the authority is a predicate in the statement, not a check before it", () => {
    /*
     * `prj_pm_id = :pm_id` IS the access rule for this endpoint. No permission can express it - it
     * is not "may accept projects" but "may accept THIS project" - so it cannot live in the route
     * table, and a check in TypeScript followed by an unscoped write would be a race.
     */
    expect(sql).toContain("AND p.prj_pm_id = :pm_id");
    expect(ops.parameters?.find((p) => p.name === "pm_id")?.value).toBe(caller.staffId);
  });

  test("an already-answered project matches nothing, which is how there is no un-accept", () => {
    // Without this predicate the endpoint would quietly be the un-accept this feature deliberately
    // does not have: an accepted project could be rejected by pressing the other button.
    expect(sql).toContain("AND p.acceptance_status = :assigned");
    expect(ops.parameters?.find((p) => p.name === "assigned")?.value).toBe(
      PROJECT_ACCEPTANCE_ASSIGNED,
    );
  });

  test("a deleted project cannot be answered", () => {
    expect(sql).toContain("AND p.deleted = false");
  });

  test("the two answers are the two non-zero values, and 0 is not sendable", () => {
    // 0 means "has not answered". It is a state a project is PUT IN - by being assigned, or by
    // being reassigned - and not something anybody can say, which is why the request body is a
    // boolean and the translation happens on the server.
    expect(PROJECT_ACCEPTANCE_ACCEPTED).toBe(1);
    expect(PROJECT_ACCEPTANCE_REJECTED).toBe(-1);
    expect(PROJECT_ACCEPTANCE_ASSIGNED).toBe(0);

    const schemas = repoFile("lambdas", "neotms", "nodejs", "neotms", "neotms.schemas.ts");
    const body = /export const ProjectAcceptanceSchema[\s\S]*?\}\);/.exec(schemas)?.[0] ?? "";
    expect(body).toContain("accepted: v.boolean()");
    // Nothing in the body may carry a status, an author or a time: who answered comes from the
    // verified caller and when from `now()`.
    for (const forbidden of ["status", "staffId", "createdAt", "acceptanceStatus"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  test("the record names the caller as its author, not the project's current PM", () => {
    /*
     * By the time anybody reads the history the project may have been reassigned, so a row that
     * identified its author by re-reading `prj_pm_id` would credit the wrong person - and credit
     * them differently depending on when it was read.
     */
    const record = ProjectAcceptanceRecordOps("7", caller, PROJECT_ACCEPTANCE_REJECTED, " ", ctx);
    expect(record.parameters?.find((p) => p.name === "staff_id")?.value).toBe(caller.staffId);
    expect(record.parameters?.find((p) => p.name === "status")?.value).toBe(
      PROJECT_ACCEPTANCE_REJECTED,
    );
    // A blank note is NULL rather than '': `note IS NULL` is how a screen asks whether a reason was
    // given, and '' would answer that question wrongly for every empty box.
    expect(record.parameters?.find((p) => p.name === "note")?.value).toBeNull();
  });

  test("the history is newest-first and tie-broken, so two reads cannot disagree", () => {
    // Two answers recorded in one transaction share a `created_at`. Without the id the two could
    // swap places between reads, and the newest answer is the one the screen presents as current.
    const history = flat(ProjectAcceptanceHistoryOps("7").sql);
    expect(history).toContain("ORDER BY a.created_at DESC, a.id DESC");
  });
});

/* -------------------------------------------------------------------------- */
/* The two vocabularies                                                       */
/* -------------------------------------------------------------------------- */

describe("the database refuses what the application cannot send", () => {
  const schema = repoFile("db", "001_schemas.sql");
  const migration = repoFile("db", "005_project_acceptance.sql");

  test("the project column accepts exactly the three values", () => {
    // Without the CHECK a 2 stores silently, and every screen reads it as "rejected" or "accepted"
    // depending on how it compares. The migration must carry the same constraint as the schema, or
    // a migrated database is the one without it.
    for (const sql of [schema, migration]) {
      expect(sql).toMatch(/ck_project_acceptance_status[\s\S]{0,120}IN \(-1, 0, 1\)/);
    }
  });

  test("the record table refuses a 0 answer", () => {
    // 0 is the absence of an answer, so a row saying 0 would be a record of nothing having
    // happened - and it would make `count(*)` over this table a number nobody can interpret.
    for (const sql of [schema, migration]) {
      expect(sql).toMatch(/ck_project_acceptance_answer[\s\S]{0,120}IN \(-1, 1\)/);
    }
  });

  test("the record has no UNIQUE constraint, because the history is the point", () => {
    /*
     * A project assigned to A who rejects, then reassigned to B who accepts, must hold both rows.
     * A UNIQUE on (project_id) - or on (project_id, staff_id), which looks more reasonable and is
     * just as wrong when a project comes back to its first PM - would collapse that into one and
     * lose exactly what the table exists to keep.
     */
    const table = /CREATE TABLE IF NOT EXISTS project_acceptance[\s\S]*?\n\);/.exec(migration)?.[0];
    expect(table).toBeDefined();
    expect(table).not.toMatch(/UNIQUE/i);
  });

  test("the migration does not backfill an acceptance nobody gave", () => {
    /*
     * Every existing project reads as unanswered after this applies, including ones delivered years
     * ago. The alternative - `UPDATE project SET acceptance_status = 1` - asserts that somebody
     * accepted them, with no row in project_acceptance to say who or when, so the claim could never
     * be checked and would be false. This is the assertion that stops it being added later as a
     * tidy-up.
     */
    expect(migration).not.toMatch(/UPDATE\s+project\s+SET\s+acceptance_status/i);
  });
});

/* -------------------------------------------------------------------------- */
/* The screen                                                                 */
/* -------------------------------------------------------------------------- */

describe("the screen offers the buttons to exactly the person the server will accept", () => {
  test("the condition is the assigned PM's staff id, not their name", () => {
    /*
     * Two people can share a name; `prj_pm_name` is a denormalised copy that can lag a rename; and
     * `prjPmId` is the column the server's own predicate uses. A name comparison here would sooner
     * or later offer a button that answers 403, or hide it from the one person it belongs to -
     * neither of which looks like a bug from the screen.
     */
    const view = repoFile("frontend", "src", "features", "projects", "ProjectDetailView.tsx");
    expect(view).toContain("project.prjPmId === profile.staffId");
    expect(view).toContain("isAssignedPm && project.acceptanceStatus === PROJECT_ACCEPTANCE_ASSIGNED");
  });

  test("the answer is fixed before the dialog opens", () => {
    /*
     * `accepted` comes from which button was pressed and the dialog cannot change it. Offering both
     * answers inside the dialog would let one mis-click land the wrong one - and neither answer can
     * be taken back from this screen afterwards, which is the whole reason the dialog exists.
     */
    const modal = repoFile("frontend", "src", "features", "projects", "ProjectAcceptanceModal.tsx");
    expect(modal).toContain("accepted: boolean");
    expect(modal).toContain("accepted ? ui.btnPrimary : ui.btnDanger");
    // One state for the dialog, so "accepting and rejecting at once" is not expressible.
    const view = repoFile("frontend", "src", "features", "projects", "ProjectDetailView.tsx");
    expect(view).toContain("useState<boolean | null>(null)");
  });
});

/* -------------------------------------------------------------------------- */
/* Who may be named                                                           */
/* -------------------------------------------------------------------------- */

describe("a project's two assignees must carry the matching attribute", () => {
  test("the picker lists active holders of one attribute, and nothing else", () => {
    /*
     * Three predicates, each keeping something out that would otherwise be offered:
     *
     *   * the attribute - the server refuses an id that does not carry it, so a picker without this
     *     is a list most of whose entries produce a 400 on save;
     *   * `active` - a departed colleague is a mistake waiting to be made (the WRITE check is
     *     deliberately looser, see below);
     *   * `deleted` - as everywhere.
     *
     * And the attribute is BOUND, not interpolated. It arrives from a query string, and the two
     * legal values are checked in the manager; binding it means that even if that check were
     * removed the value could not become SQL.
     */
    const ops = AssignableStaffOps(NEOTMS_USER_ATTRIBUTE_PM);
    const sql = flat(ops.sql);

    expect(sql).toContain("a.attribute = :attribute");
    expect(sql).toContain("s.active = true");
    expect(sql).toContain("s.deleted = false");
    expect(ops.parameters?.find((p) => p.name === "attribute")?.value).toBe(
      NEOTMS_USER_ATTRIBUTE_PM,
    );
    // No email, no phone, no role: the one endpoint about colleagues that any staff member may read
    // answers only the question the picker asks. See its manager's header.
    for (const column of ["mgr_email", "mgr_phone", "role_id", "view_scope"]) {
      expect(sql).not.toContain(column);
    }
  });

  test("the superuser attribute is not assignable and not listable", () => {
    /*
     * `NEOTMS_ASSIGNABLE_ATTRIBUTES` is what the route validates against. If the superuser flag
     * were in it, `GET /api/v0/staff/assignable?attribute=...SUPERUSER` would answer "who are the
     * administrators" to every staff member in the company - and the project form would offer them
     * as a sales manager.
     */
    expect([...NEOTMS_ASSIGNABLE_ATTRIBUTES]).toEqual([
      NEOTMS_USER_ATTRIBUTE_SALES_MANAGER,
      NEOTMS_USER_ATTRIBUTE_PM,
    ]);
    expect([...NEOTMS_ASSIGNABLE_ATTRIBUTES]).not.toContain(NEOTMS_USER_ATTRIBUTE_SUPERUSER);

    const manager = repoFile(
      "lambdas", "neotms", "nodejs", "neotms", "staff", "NeotmsAssignableManager.ts",
    );
    expect(manager).toContain("NEOTMS_ASSIGNABLE_ATTRIBUTES as readonly string[]).includes(");
  });

  test("the check tells 'no such person' apart from 'not marked as a PM'", () => {
    /*
     * Two different mistakes with two different fixes - reload the form, versus ask an
     * administrator to grant the attribute - so the statement counts existence and eligibility
     * separately and the mapper returns which. One boolean would collapse them into "that PM cannot
     * be used", which tells nobody what to do next.
     *
     * Run against rows rather than asserted on the SQL text: the branching is in the mapper, and
     * what matters is the verdict it produces.
     */
    const ops = ProjectAssigneeCheckOps("7", "9");
    const verdict = (row: Record<string, unknown>) => ops.mapper([row]);

    expect(verdict({ pm_exists: 1, pm_eligible: 1, mgr_exists: 1, mgr_eligible: 1 })).toEqual({
      pm: null,
      mgr: null,
    });
    expect(verdict({ pm_exists: 1, pm_eligible: 0, mgr_exists: 1, mgr_eligible: 1 })).toEqual({
      pm: "ineligible",
      mgr: null,
    });
    expect(verdict({ pm_exists: 0, pm_eligible: 0, mgr_exists: 1, mgr_eligible: 0 })).toEqual({
      pm: "missing",
      mgr: "ineligible",
    });
  });

  test("a null assignee is not a problem, because clearing one is a real edit", () => {
    /*
     * A project between PMs has none, and a rejected project on its way to somebody else passes
     * through that state. If NULL were reported as "missing", clearing the field would be refused
     * with a message about a staff member the user never named.
     */
    const ops = ProjectAssigneeCheckOps(null, null);
    expect(ops.mapper([{ pm_exists: 0, pm_eligible: 0, mgr_exists: 0, mgr_eligible: 0 }])).toEqual({
      pm: null,
      mgr: null,
    });
  });

  test("the check runs on create and on update, and skips an unchanged id", () => {
    /*
     * The skip is what keeps old projects editable. The project form submits every field on every
     * save, so validating an assignee the request is not CHANGING would refuse a correction to the
     * project's name because its PM left the company - or had the attribute revoked - years after
     * they were assigned. What is enforced is "every assignee this request sets is eligible".
     *
     * Three things are asserted together because the skip is only safe if the comparison really
     * happens: the manager reads the project first, and passes its stored ids as the baseline.
     */
    const manager = repoFile(
      "lambdas", "neotms", "nodejs", "neotms", "projects", "NeotmsProjectManager.ts",
    );
    expect([...manager.matchAll(/await assigneeRefusal\(/g)]).toHaveLength(2);
    expect(manager).toMatch(/assigneeRefusal\(input, \{\s*prjPmId: existing\.prjPmId/);
    expect(manager).toContain("input.prjPmId !== undefined && input.prjPmId !== unchanged.prjPmId");
  });

  test("the creator is only defaulted into a seat they may hold", () => {
    /*
     * The default exists so that a PM who leaves both boxes empty can still see the project they
     * just created - it would otherwise match neither ownership column. It became conditional when
     * `prj_pm_id` started being checked against the attribute: defaulting an ineligible creator
     * into that seat would now be refused by the check, so creating a project would fail with a
     * message about a person the creator never named.
     */
    const manager = repoFile(
      "lambdas", "neotms", "nodejs", "neotms", "projects", "NeotmsProjectManager.ts",
    );
    const fn = /function withDefaultOwner[\s\S]*?\n}/.exec(manager)?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).toContain("caller.attributes.has(NEOTMS_USER_ATTRIBUTE_PM)");
    expect(fn).toContain("caller.attributes.has(NEOTMS_USER_ATTRIBUTE_SALES_MANAGER)");
    // And it gives up rather than naming somebody ineligible.
    expect(fn.trimEnd().endsWith("return input;\n}")).toBe(true);
  });

  test("the form's 담당영업 default is conditional on the same attribute", () => {
    // The screen must not offer the user themselves and then have the save refused. It reads the
    // attribute list out of the profile, which is the same set the server checks.
    const form = repoFile("frontend", "src", "features", "projects", "ProjectFormModal.tsx");
    expect(form).toContain("profile?.attributes.includes(SALES_MANAGER_ATTRIBUTE)");
    // Both seats are always sent, including as null - that is how an assignee is cleared.
    expect(form).toContain("prjPmId: pm?.id ?? null");
    expect(form).toContain("prjMgrId: salesManager?.id ?? null");
  });
});

/* -------------------------------------------------------------------------- */
/* Asking again                                                               */
/* -------------------------------------------------------------------------- */

describe("the 담당영업 can ask again, and cannot withdraw an acceptance", () => {
  const ops = ProjectAcceptanceResetOps(caller, "7", ctx);
  const sql = flat(ops.sql);

  test("only the project's own 담당영업", () => {
    // Not the PM, who would be re-asking themselves, and not a superuser: this is the counterpart
    // of the PM's answer and has the same shape of authority - a fact about one row.
    expect(sql).toContain("AND p.prj_mgr_id = :mgr_id");
    expect(ops.parameters?.find((p) => p.name === "mgr_id")?.value).toBe(caller.staffId);
  });

  test("only from REJECTED, which is what keeps 'no un-accept' true", () => {
    /*
     * THE assertion in this describe. Without this predicate the endpoint resets an ACCEPTED
     * project to unanswered - the withdrawal the acceptance endpoint refuses, reached from the
     * other side, and performed by somebody other than the person who gave the answer.
     */
    expect(sql).toContain("AND p.acceptance_status = :rejected");
    expect(ops.parameters?.find((p) => p.name === "rejected")?.value).toBe(
      PROJECT_ACCEPTANCE_REJECTED,
    );
    expect(ops.parameters?.find((p) => p.name === "assigned")?.value).toBe(
      PROJECT_ACCEPTANCE_ASSIGNED,
    );
  });

  test("it records nothing, because a re-request is not an answer", () => {
    /*
     * `project_acceptance` holds answers PMs gave; its CHECK refuses the 0 a re-request would have
     * to store. The rejection it follows stays in the history with its reason, which is the part
     * anybody goes looking for. The cost - that "asked again on the 3rd" is recorded nowhere - is
     * in the README, so that the gap is a decision rather than a surprise.
     */
    expect(sql).not.toContain("project_acceptance");
    const manager = repoFile(
      "lambdas", "neotms", "nodejs", "neotms", "projects", "NeotmsProjectManager.ts",
    );
    const fn =
      /export async function requestProjectAcceptanceAgain[\s\S]*?\n}/.exec(manager)?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).not.toContain("ProjectAcceptanceRecordOps");
    // And it says so to an accepted project rather than silently doing nothing.
    expect(fn).toContain("PROJECT_ACCEPTANCE_ACCEPTED");
  });

  test("the route is gated on PROJECT:update, not on read", () => {
    /*
     * Different from the acceptance route beside it, deliberately. Accepting is an answer only one
     * person can give and the row proves who they are; this re-opens a project's workflow state,
     * and somebody with read-only access to projects should not be able to.
     */
    const handler = repoFile("lambdas", "neotms", "nodejs", "neotms", "neotms.handler.ts");
    const route = handler
      .split("\n")
      .find((line) => line.includes("/acceptance/again") && line.includes("path:"));
    expect(route).toBeDefined();
    expect(route).toContain("NEOTMS_PERMISSION_PROJECT_UPDATE");
  });
});
