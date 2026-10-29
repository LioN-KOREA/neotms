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
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { CustomerNameOps } from "../customers/NeotmsCustomer.dbops.js";
import { readListQuery, sortAlias } from "../NeotmsQuery.js";
import { created, notFound, ok, runDb, type ListPage } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import type { ProjectCreate, ProjectUpdate } from "../neotms.schemas.js";
import {
  PROJECT_SORTS,
  ProjectCreateOps,
  ProjectGetOps,
  ProjectListOps,
  ProjectLiveJobCountOps,
  ProjectSoftDeleteOps,
  ProjectTotalsOps,
  ProjectUpdateOps,
  toProjectRow,
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
  };
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
): Promise<ResponseData<(ProjectRow & { totals: { revenue: string; cost: string; margin: string } }) | string>> {
  return runDb("get project", async () => {
    const row = (await pgQuery(ProjectGetOps(caller, id))).data;
    if (!row) return notFound("project");
    const totals = (await pgQuery(ProjectTotalsOps(id))).data;
    return ok({ ...row, totals });
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
  const assigned: ProjectCreate =
    input.prjPmId || input.prjMgrId ? input : { ...input, prjPmId: caller.staffId };
  return runDb("create project", async () => {
    const customerName = (await pgQuery(CustomerNameOps(assigned.customerId))).data;
    if (customerName === null) {
      return { status: 400, body: "That customer does not exist or has been deleted" };
    }
    const row = (await pgExecute(ProjectCreateOps(assigned, ctx))).data;
    return row ? created(row) : { status: 500, body: "The project was not created" };
  });
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
    const row = (await pgExecute(ProjectUpdateOps(caller, id, input, ctx))).data;
    return row ? ok(row) : notFound("project");
  });
}

/**
 * Soft-delete a project, unless live jobs still hang off it.
 *
 * Refusing while jobs exist is more than a courtesy here. A project's revenue lives on its jobs, and
 * the jobs do not become invisible when the project does - they would keep feeding the rollup while
 * the project they belong to had vanished from every screen, which is how a report comes to disagree
 * with the project list and nobody can say which is right.
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
