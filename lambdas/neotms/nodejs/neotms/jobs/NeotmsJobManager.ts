// SPDX-License-Identifier: MIT
//
// Job endpoints. Revenue is created and edited here.

import {
  paginate,
  pgExecute,
  pgQuery,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { ProjectVisibleOps } from "../projects/NeotmsProject.dbops.js";
import { readListQuery, sortAlias } from "../NeotmsQuery.js";
import { created, notFound, ok, runDb, type ListPage } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import type { JobCreate, JobUpdate } from "../neotms.schemas.js";
import {
  JOB_SORTS,
  JobCreateOps,
  JobGetOps,
  JobListOps,
  JobLivePoCountOps,
  JobSoftDeleteOps,
  JobUpdateOps,
  toJobRow,
  type JobFilters,
  type JobRow,
} from "./NeotmsJob.dbops.js";

function readFilters(request: RequestData): JobFilters {
  const read = (key: string): string | undefined => {
    const raw = (request.queryParams[key] ?? "").trim();
    return raw.length > 0 ? raw : undefined;
  };
  return {
    projectId: read("projectId"),
    state: read("state"),
    workCode: read("workCode"),
    slang: read("slang"),
    elang: read("elang"),
    pmId: read("pmId"),
    customerId: read("customerId"),
    corpId: read("corpId"),
    dueFrom: read("dueFrom"),
    dueTo: read("dueTo"),
  };
}

/**
 * List jobs.
 *
 * The same endpoint serves two screens: the global job list, and the jobs inside one project when
 * `?projectId=` is given. One query rather than two because the only difference is a filter, and a
 * separate `/projects/{id}/jobs` implementation would be a second place for the scope predicate to
 * be forgotten.
 */
export async function listJobs(
  caller: NeotmsCaller,
  request: RequestData,
): Promise<ResponseData<ListPage<JobRow> | string>> {
  const query = readListQuery(request, JOB_SORTS, "created");
  const filters = readFilters(request);
  return runDb("list jobs", async () => {
    const rows: SqlRow[] = (await pgQuery(JobListOps(caller, query, filters))).data;
    const page = paginate(rows, query.limit, sortAlias(query.sort.column), "job_id", toJobRow);
    return ok(page);
  });
}

export async function getJob(
  caller: NeotmsCaller,
  id: string,
): Promise<ResponseData<JobRow | string>> {
  return runDb("get job", async () => {
    const row = (await pgQuery(JobGetOps(caller, id))).data;
    return row ? ok(row) : notFound("job");
  });
}

/**
 * Create a job under a project.
 *
 * The project is checked for visibility first, and that check is the authorization for this write:
 * a job has no owner until it is created, so there is nothing on the row itself to scope against.
 * The right to add work to a project is the right to be able to see that project.
 *
 * 404 rather than 403 when the check fails, matching what a direct read of that project would
 * answer. A 403 here would confirm the project exists to someone who cannot see it.
 */
export async function createJob(
  caller: NeotmsCaller,
  input: JobCreate,
  ctx: WriteContext,
): Promise<ResponseData<JobRow | string>> {
  const assigned: JobCreate = input.jobPmId ? input : { ...input, jobPmId: caller.staffId };
  return runDb("create job", async () => {
    const visible = (await pgQuery(ProjectVisibleOps(caller, input.projectId))).data;
    if (!visible) return notFound("project");

    const row = (await pgExecute(JobCreateOps(assigned, ctx))).data;
    if (!row) return { status: 500, body: "The job was not created" };
    // Re-read so the created job carries its project's code and name, which `RETURNING` cannot
    // reach. See the mapper comment on JobCreateOps.
    const full = (await pgQuery(JobGetOps(caller, row.id))).data;
    return created(full ?? row);
  });
}

export async function updateJob(
  caller: NeotmsCaller,
  id: string,
  input: JobUpdate,
  ctx: WriteContext,
): Promise<ResponseData<JobRow | string>> {
  if (Object.keys(input).length === 0) {
    return { status: 400, body: "No editable field was supplied" };
  }
  return runDb("update job", async () => {
    const row = (await pgExecute(JobUpdateOps(caller, id, input, ctx))).data;
    return row ? ok(row) : notFound("job");
  });
}

/**
 * Soft-delete a job, unless live purchase orders hang off it.
 *
 * This one is not a courtesy. The job carries the revenue and its POs carry the cost; deleting the
 * job alone leaves the cost in place with no revenue beside it, and the margin report then shows a
 * loss that never happened. The POs have to go first, which is also the order in which someone
 * cancelling real work does it - you release the translator before you drop the deliverable.
 */
export async function deleteJob(
  caller: NeotmsCaller,
  id: string,
  ctx: WriteContext,
): Promise<ResponseData<{ id: string } | string>> {
  return runDb("delete job", async () => {
    const livePos = (await pgQuery(JobLivePoCountOps(id))).data;
    if (livePos > 0) {
      return {
        status: 409,
        body: `This job still has ${livePos} live purchase order(s). Cancel them first, or the cost would be left without its revenue.`,
      };
    }
    const deletedId = (await pgExecute(JobSoftDeleteOps(caller, id, ctx))).data;
    return deletedId ? ok({ id: deletedId }) : notFound("job");
  });
}
