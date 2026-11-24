// SPDX-License-Identifier: MIT
//
// Project endpoints.
//
// Every function here takes the caller, and that is not for logging: the caller carries the row-level
// scope, and the scope is applied inside each statement. There is no code path in this module that
// reads or writes a project without one, which is what makes "a PM sees only their own projects"
// true of the detail and edit endpoints as well as the list.

import {
  paginate,
  pgExecute,
  pgQuery,
  pgTransaction,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { CustomerNameOps } from "../customers/NeotmsCustomer.dbops.js";
import {
  NEOTMS_USER_ATTRIBUTE_PM,
  NEOTMS_USER_ATTRIBUTE_SALES_MANAGER,
} from "../../auth/NeotmsAuthorities.js";
import { ProjectAssigneeCheckOps } from "../staff/NeotmsAssignable.dbops.js";
import { readListQuery, sortAlias } from "../NeotmsQuery.js";
import { created, notFound, ok, runDb, type ListPage } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import type { ProjectAcceptance, ProjectCreate, ProjectUpdate } from "../neotms.schemas.js";
import {
  PROJECT_ACCEPTANCE_ACCEPTED,
  PROJECT_ACCEPTANCE_ASSIGNED,
  PROJECT_ACCEPTANCE_REJECTED,
  PROJECT_SORTS,
  ProjectAcceptanceHistoryOps,
  ProjectAcceptanceOps,
  ProjectAcceptanceRecordOps,
  ProjectAcceptanceResetOps,
  ProjectCreateOps,
  ProjectGetOps,
  ProjectListOps,
  ProjectLiveJobCountOps,
  ProjectSoftDeleteOps,
  ProjectTotalsOps,
  ProjectUpdateOps,
  toProjectRow,
  type ProjectAcceptanceRow,
  type ProjectFilters,
  type ProjectRow,
} from "./NeotmsProject.dbops.js";

/** Read the filter parameters. Unrecognised ones are ignored rather than reaching the query. */
function readFilters(request: RequestData): ProjectFilters {
  const read = (key: string): string | undefined => {
    const raw = (request.queryParams[key] ?? "").trim();
    return raw.length > 0 ? raw : undefined;
  };
  return {
    state: read("state"),
    invoiceState: read("invoiceState"),
    moneyState: read("moneyState"),
    customerId: read("customerId"),
    corpId: read("corpId"),
    field: read("field"),
    pmId: read("pmId"),
    salesManagerId: read("salesManagerId"),
    dueFrom: read("dueFrom"),
    dueTo: read("dueTo"),
    startFrom: read("startFrom"),
    startTo: read("startTo"),
    acceptanceStatus: readAcceptanceStatus(request),
  };
}

/**
 * The acceptance filter, validated here rather than at the column.
 *
 * It is the one `int` filter in the application: the value is interpolated into a bound parameter of
 * kind `int`, which runs `Number()` over it, so `?acceptanceStatus=abc` would reach PostgreSQL as
 * NaN and come back as a 500 about invalid integer syntax. A malformed query string is not a server
 * error, so anything outside the three legal values is treated as no filter at all - the same answer
 * an empty value gets everywhere else in `readFilters`.
 */
function readAcceptanceStatus(request: RequestData): string | undefined {
  const raw = (request.queryParams["acceptanceStatus"] ?? "").trim();
  const legal = [
    PROJECT_ACCEPTANCE_ASSIGNED,
    PROJECT_ACCEPTANCE_ACCEPTED,
    PROJECT_ACCEPTANCE_REJECTED,
  ].map(String);
  return legal.includes(raw) ? raw : undefined;
}

/**
 * Refuse a PM or a sales manager who may not be named.
 *
 * Returns the sentence to answer with, or null to proceed. The attributes are the whole point of
 * the pickers on the form: without this check the picker is decoration and any staff id - or any
 * id at all, from an old tab or a script - still saves, which is what the comment on
 * `NEOTMS_USER_ATTRIBUTE_SALES_MANAGER` has said since the attributes were introduced.
 *
 * ## Two refusals, not one
 *
 * "No such staff member" and "that person is not marked as a PM" need different things done about
 * them - a reload, versus an administrator on the staff administration screen - so they are different
 * sentences. Collapsing them into "invalid PM" would leave the second case looking like a bug in
 * the form.
 *
 * ## It is skipped for an id that is not changing
 *
 * The caller passes `unchanged` on an edit. A project assigned years ago to somebody who has since
 * left, or whose PM attribute was later revoked, must stay editable: validating a value the request
 * is not altering would refuse a correction to the project's NAME and blame a person the editor
 * never mentioned. What is enforced is therefore "every assignee this request SETS is eligible",
 * which is the rule that can be stated without an exception.
 */
async function assigneeRefusal(
  input: { prjPmId?: string | null; prjMgrId?: string | null },
  unchanged: { prjPmId?: string | null; prjMgrId?: string | null } = {},
): Promise<string | null> {
  const pmId = input.prjPmId !== undefined && input.prjPmId !== unchanged.prjPmId
    ? input.prjPmId
    : null;
  const mgrId = input.prjMgrId !== undefined && input.prjMgrId !== unchanged.prjMgrId
    ? input.prjMgrId
    : null;
  // Clearing an assignee is `null`, which is a legitimate edit and nothing to check. Both null
  // means there is nothing to ask the database about at all.
  if (pmId === null && mgrId === null) return null;

  const check = (await pgQuery(ProjectAssigneeCheckOps(pmId, mgrId))).data;
  const problem = (
    field: string,
    attribute: string,
    verdict: "missing" | "ineligible" | null,
  ): string | null => {
    if (verdict === null) return null;
    return verdict === "missing"
      ? `The ${field} you selected is not a staff member of this system. Reload the form and pick again.`
      : `The ${field} you selected is not marked with ${attribute}, so they cannot be named on a ` +
        `project. An administrator grants that on the 사용자 관리 screen.`;
  };

  return (
    problem("PM", NEOTMS_USER_ATTRIBUTE_PM, check.pm) ??
    problem("담당영업", NEOTMS_USER_ATTRIBUTE_SALES_MANAGER, check.mgr)
  );
}

export async function listProjects(
  caller: NeotmsCaller,
  request: RequestData,
): Promise<ResponseData<ListPage<ProjectRow> | string>> {
  const query = readListQuery(request, PROJECT_SORTS, "created");
  const filters = readFilters(request);
  return runDb("list projects", async () => {
    const rows: SqlRow[] = (await pgQuery(ProjectListOps(caller, query, filters))).data;
    const page = paginate(
      rows,
      query.limit,
      sortAlias(query.sort.column),
      "project_id",
      toProjectRow,
    );
    return ok(page);
  });
}

/**
 * One project, with its revenue, cost and margin.
 *
 * The totals are a second query rather than three more columns on the first. They aggregate the
 * jobs and the POs, so putting them in the list query would aggregate them once per listed row -
 * fifty projects would mean a hundred sub-aggregations for figures the list does not show. On a
 * detail screen, which is where the margin is actually read, one extra round trip is the right
 * price.
 *
 * The visibility decision is made by the first query. If it returns nothing the totals are never
 * asked for, so a caller cannot learn a project's revenue by requesting an id they cannot see.
 */
export async function getProject(
  caller: NeotmsCaller,
  id: string,
): Promise<
  ResponseData<
    | (ProjectRow & {
        totals: { revenue: string; cost: string; margin: string };
        acceptance: ProjectAcceptanceRow[];
      })
    | string
  >
> {
  return runDb("get project", async () => {
    const row = (await pgQuery(ProjectGetOps(caller, id))).data;
    if (!row) return notFound("project");
    const totals = (await pgQuery(ProjectTotalsOps(id))).data;
    /*
     * The acceptance history, on the same screen as the status it explains.
     *
     * A third round trip on a detail read, and it is the right price for the same reason the totals
     * are: `acceptance_status` says the project was REJECTED and nothing else on any screen can say
     * by whom or why. Almost always zero or one row - it grows only when a project is reassigned -
     * and the index is `(project_id, created_at DESC)`, so it is a single index scan.
     *
     * NOT on the list query. Fifty projects would mean fifty of these for a column the list does not
     * show; the list shows the status alone, which is already on the project row.
     */
    const acceptance = (await pgQuery(ProjectAcceptanceHistoryOps(id))).data;
    return ok({ ...row, totals, acceptance });
  });
}

/**
 * Accept or reject a project, as the PM it is assigned to.
 *
 * ## The authority is not a permission, and that is why this reads before it writes
 *
 * Only the assigned PM may answer. No permission expresses that - it is a fact about one row - so
 * the route is gated on `PROJECT_READ` (you must be able to see projects at all) and the real test
 * lives in `ProjectAcceptanceOps`' WHERE clause. That statement is also the only thing that assigns
 * the column; `acceptance_status` has no `PROJECT_FIELDS` spec, so no project edit can write it.
 *
 * The read that precedes the write buys only the MESSAGE. The three ways the statement can match
 * nothing - the project is not visible, the caller is not its PM, somebody has already answered -
 * are one 404 to the writer and three different things to do for the person reading the screen. If
 * the statement then matches nothing anyway, that is a genuine race with another request and it is
 * reported as one rather than mistranslated into one of the three.
 *
 * ## Why the two writes share a transaction
 *
 * The column and the record are one fact stored twice, on purpose - the column is the current
 * answer, the table is how it was reached. A failure between them leaves a project whose status says
 * rejected with no record of who rejected it, or a record of an answer the project does not carry.
 * Neither is visible on any screen, and both make the history a thing nobody can trust afterwards.
 *
 * ## There is no un-accept, and no superuser override
 *
 * Both deliberate. A PM who accepted and cannot deliver is handled by REASSIGNING the project,
 * which resets the status to 0 and asks the new PM - an act by somebody else, with a record of its
 * own. A superuser who needs to undo an answer does the same thing: this endpoint refuses them too,
 * because "the assigned PM answered" has to mean that or it means nothing.
 */
export async function setProjectAcceptance(
  caller: NeotmsCaller,
  id: string,
  input: ProjectAcceptance,
  ctx: WriteContext,
): Promise<ResponseData<ProjectRow | string>> {
  const status = input.accepted ? PROJECT_ACCEPTANCE_ACCEPTED : PROJECT_ACCEPTANCE_REJECTED;

  return runDb("set project acceptance", async () => {
    const existing = (await pgQuery(ProjectGetOps(caller, id))).data;
    if (!existing) return notFound("project");

    if (existing.prjPmId !== caller.staffId) {
      return {
        status: 403,
        body:
          "Only the project manager this project is assigned to can accept or reject it. " +
          "If it needs to move to somebody else, change the PM on the project instead - that " +
          "resets the acceptance and asks the new PM.",
      };
    }

    if (existing.acceptanceStatus !== PROJECT_ACCEPTANCE_ASSIGNED) {
      return {
        status: 409,
        body:
          existing.acceptanceStatus === PROJECT_ACCEPTANCE_ACCEPTED
            ? "You have already accepted this project. An acceptance cannot be withdrawn here; " +
              "ask for the project to be reassigned if you can no longer take it."
            : "You have already rejected this project. Reassigning it is what gives somebody " +
              "else the chance to accept it.",
      };
    }

    const row = await pgTransaction(async (client) => {
      const updated = (await pgExecute(ProjectAcceptanceOps(caller, id, status, ctx), client)).data;
      // The three predicates all held a moment ago, so a miss here means a concurrent request got
      // there first. Returning null aborts before the record is written, which is the point of the
      // transaction: a record of an answer the project does not carry is worse than no answer.
      if (!updated) return null;
      await pgExecute(
        ProjectAcceptanceRecordOps(id, caller, status, input.note ?? null, ctx),
        client,
      );
      return updated;
    });

    if (!row) {
      return {
        status: 409,
        body: "This project was answered by another request a moment ago. Reload and look again.",
      };
    }
    return ok(row);
  });
}

/**
 * Create a project.
 *
 * The customer is checked before the INSERT, and the check is worth the round trip. The foreign key
 * would catch a customer id that does not exist, but it cannot catch one that has been soft-deleted
 * - the row is still there - and the result would be a project whose customer nobody can open, with
 * a NULL customer name where the list screen expects one. Checking here turns that into a sentence
 * the user can act on.
 *
 * The name itself is NOT taken from this check. It is written by a subquery inside the INSERT, so
 * there is exactly one statement that can set `cus_code_name` and it reads the same row the FK
 * points at.
 *
 * An unspecified PM defaults to the caller. Without that, a scoped PM who creates a project and
 * leaves the PM box empty cannot then see the project they just created - it matches neither
 * ownership column - and the only visible symptom is "my project disappeared after I saved it". An
 * administrator entering work on someone else's behalf sets the field explicitly.
 */
export async function createProject(
  caller: NeotmsCaller,
  input: ProjectCreate,
  ctx: WriteContext,
): Promise<ResponseData<ProjectRow | string>> {
  const assigned = withDefaultOwner(caller, input);
  return runDb("create project", async () => {
    const customerName = (await pgQuery(CustomerNameOps(assigned.customerId))).data;
    if (customerName === null) {
      return { status: 400, body: "That customer does not exist or has been deleted" };
    }
    const refusal = await assigneeRefusal(assigned);
    if (refusal) return { status: 400, body: refusal };

    const row = (await pgExecute(ProjectCreateOps(assigned, ctx))).data;
    return row ? created(row) : { status: 500, body: "The project was not created" };
  });
}

/**
 * Which assignee this creator should default to, when the request names neither.
 *
 * ## Why there is a default at all
 *
 * A scoped PM who creates a project and leaves the assignee boxes empty would not be able to see
 * the project they just saved - it matches neither ownership column - and the only visible symptom
 * is "it disappeared". So the creator is written into one of the two seats.
 *
 * ## Why it is now conditional on the attribute
 *
 * It used to be `prjPmId = caller.staffId` unconditionally, which was correct until `prj_pm_id`
 * started meaning "the person who has to accept this" and started being checked against the PM
 * attribute. Defaulting an ineligible creator into that seat would now be refused by
 * `assigneeRefusal` - so a project created by somebody who is neither PM nor sales manager would fail,
 * with a message about a person they never named.
 *
 * So: the PM seat if they may hold it, else the sales manager seat if they may hold that, else neither.
 * In the last case the creator is somebody who is not in either role - an administrator entering
 * work on behalf of others - and whether they can then see the project is their view scope's
 * business, which for such an account is in practice 'Y'.
 */
function withDefaultOwner(caller: NeotmsCaller, input: ProjectCreate): ProjectCreate {
  if (input.prjPmId || input.prjMgrId) return input;
  if (caller.attributes.has(NEOTMS_USER_ATTRIBUTE_PM)) {
    return { ...input, prjPmId: caller.staffId };
  }
  if (caller.attributes.has(NEOTMS_USER_ATTRIBUTE_SALES_MANAGER)) {
    return { ...input, prjMgrId: caller.staffId };
  }
  return input;
}

export async function updateProject(
  caller: NeotmsCaller,
  id: string,
  input: ProjectUpdate,
  ctx: WriteContext,
): Promise<ResponseData<ProjectRow | string>> {
  if (Object.keys(input).length === 0) {
    return { status: 400, body: "No editable field was supplied" };
  }
  return runDb("update project", async () => {
    // Only when the customer is being CHANGED, for the same reason as on create. A PATCH that does
    // not mention the customer must not pay for this check.
    if (input.customerId) {
      const customerName = (await pgQuery(CustomerNameOps(input.customerId))).data;
      if (customerName === null) {
        return { status: 400, body: "That customer does not exist or has been deleted" };
      }
    }

    /*
     * Read first, so an assignee that is NOT changing is not validated.
     *
     * The project form submits every field on every save, so without this an edit to a project
     * whose historical PM has left - or has had the attribute revoked since - would be refused for
     * a value the editor did not touch. One indexed read on a save is the price, and it is the same
     * read that turns an out-of-scope id into the 404 the write would have produced anyway.
     */
    const existing = (await pgQuery(ProjectGetOps(caller, id))).data;
    if (!existing) return notFound("project");

    const refusal = await assigneeRefusal(input, {
      prjPmId: existing.prjPmId,
      prjMgrId: existing.prjMgrId,
    });
    if (refusal) return { status: 400, body: refusal };

    const row = (await pgExecute(ProjectUpdateOps(caller, id, input, ctx))).data;
    return row ? ok(row) : notFound("project");
  });
}

/**
 * Put a rejected project back in front of its PM, as its sales manager.
 *
 * The counterpart of `setProjectAcceptance`, and it reads before it writes for the same reason: the
 * three ways `ProjectAcceptanceResetOps` can match nothing are one miss to the statement and three
 * different things to do for the person reading the screen.
 *
 * The refusal on an ACCEPTED project is the one worth noticing. Resetting one would be the
 * withdrawal the acceptance endpoint refuses, reached from the other side - and it would be the
 * sales manager withdrawing the PM's answer, which is not theirs to withdraw. Reassigning the PM is the
 * supported way to take a project off somebody, and it leaves the acceptance reset as a visible
 * consequence of a visible act.
 */
export async function requestProjectAcceptanceAgain(
  caller: NeotmsCaller,
  id: string,
  ctx: WriteContext,
): Promise<ResponseData<ProjectRow | string>> {
  return runDb("request project acceptance again", async () => {
    const existing = (await pgQuery(ProjectGetOps(caller, id))).data;
    if (!existing) return notFound("project");

    if (existing.prjMgrId !== caller.staffId) {
      return {
        status: 403,
        body:
          "Only the 담당영업 of this project can ask its PM to look at it again. " +
          "If the project has no 담당영업, assign one first.",
      };
    }

    if (existing.acceptanceStatus !== PROJECT_ACCEPTANCE_REJECTED) {
      return {
        status: 409,
        body:
          existing.acceptanceStatus === PROJECT_ACCEPTANCE_ACCEPTED
            ? "This project has been accepted. Asking again would withdraw the PM's acceptance, " +
              "which is not something this screen can do - assign a different PM instead, which " +
              "resets the acceptance and asks the new one."
            : "This project is already waiting for its PM to answer.",
      };
    }

    const row = (await pgExecute(ProjectAcceptanceResetOps(caller, id, ctx))).data;
    if (!row) {
      return {
        status: 409,
        body: "This project changed a moment ago. Reload and look again.",
      };
    }
    return ok(row);
  });
}

/**
 * Soft-delete a project, unless live jobs still hang off it.
 *
 * Refusing while jobs exist is more than a courtesy here. A project's revenue lives on its jobs, so
 * soft-deleting the project silently removes that revenue from every report - the reports join
 * `project` on `p.deleted = false` - while the jobs themselves remain. The month's total would drop
 * with nothing on any screen to explain where it went, which is how a report comes to disagree with
 * the ledger and nobody can say which is right. Refusing makes the operator deal with the jobs
 * first, where the money is visible.
 */
export async function deleteProject(
  caller: NeotmsCaller,
  id: string,
  ctx: WriteContext,
): Promise<ResponseData<{ id: string } | string>> {
  return runDb("delete project", async () => {
    const liveJobs = (await pgQuery(ProjectLiveJobCountOps(id))).data;
    if (liveJobs > 0) {
      return {
        status: 409,
        body: `This project still has ${liveJobs} live job(s). Delete or move them first.`,
      };
    }
    const deletedId = (await pgExecute(ProjectSoftDeleteOps(caller, id, ctx))).data;
    return deletedId ? ok({ id: deletedId }) : notFound("project");
  });
}
