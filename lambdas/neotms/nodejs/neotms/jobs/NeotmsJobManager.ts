// SPDX-License-Identifier: MIT
//
// Job endpoints. Revenue is created and edited here.

import {
  paginate,
  pgExecute,
  pgExecuteCount,
  pgQuery,
  pgTransaction,
  sqlConstraint,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { ProjectVisibleOps } from "../projects/NeotmsProject.dbops.js";
import { readListQuery, sortAlias } from "../NeotmsQuery.js";
import { badRequest, created, notFound, ok, runDb, type ListPage } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import type { JobCreate, JobUpdate } from "../neotms.schemas.js";
import { JOB_TYPE_LINGUISTIC, jobDetailTable, typeMismatchMessage } from "../NeotmsJobTypes.js";
import {
  JOB_SORTS,
  JobCreateOps,
  JobDetailClearOps,
  JobDetailUpsertOps,
  JobGetOps,
  JobListOps,
  JobLivePoCountOps,
  JobProjectOps,
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
    jobType: read("jobType"),
    slang: read("slang"),
    elang: read("elang"),
    jobCategory: read("jobCategory"),
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
 *
 * ## Why this one is a transaction
 *
 * A job's 업무 구분 payload is in a side table (db/011_job_types.sql), so creating a MICE job is two
 * INSERTs. Un-transacted, a failure between them leaves a job row that claims to be MICE with no
 * category anywhere - indistinguishable from a MICE job nobody has finished filling in, and so not
 * even reportable as a defect. Either both land or neither does.
 *
 * The visibility read stays OUTSIDE the transaction deliberately. It is read-only, and under
 * Supavisor's transaction mode the backend is unavailable to every other caller from BEGIN to
 * COMMIT - so the transaction holds only the two writes it has to.
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

    let row: JobRow | null;
    try {
      row = await pgTransaction(async (client) => {
        const job = (await pgExecute(JobCreateOps(assigned, ctx), client)).data;
        if (!job) return null;
        // The job's own INSERT mints the id, so the detail row can only be written after it - which
        // is also why the FK runs child-to-parent rather than the other way about.
        const detail = JobDetailUpsertOps(job.id, assigned.jobType ?? JOB_TYPE_LINGUISTIC, assigned);
        if (detail) await pgExecuteCount(detail, client);
        return job;
      });
    } catch (err) {
      const mismatch = typeMismatchMessage(sqlConstraint(err));
      if (mismatch) return badRequest(mismatch);
      throw err;
    }
    if (!row) return { status: 500, body: "The job was not created" };

    // Re-read so the created job carries its project's code and name and its own language pair or
    // category, none of which `RETURNING` can reach. See the mapper comment on JobCreateOps.
    const full = (await pgQuery(JobGetOps(caller, row.id))).data;
    return created(full ?? row);
  });
}

/**
 * Edit a job.
 *
 * ## The statements are in this order because the database insists
 *
 * Each detail row's `job_type` is pinned to its parent's by a composite FK, so changing
 * `job.job_type` while a row of the old type is still there fails with 23503. The stale row is
 * therefore deleted FIRST, then the job, then the new type's detail row is upserted.
 *
 * That deletion would be needed even without the constraint: a job switched to MICE and back would
 * otherwise still have its original language pair, and would appear to have remembered something
 * the user had moved away from. The constraint's contribution is to make omitting it loud.
 *
 * The table cleared is the one belonging to the type being LEFT - `jobDetailTable(current.jobType)`,
 * not the one the new type does not use. Those are the same table only while there are two types on
 * each side of the linguistic line: MICE to IMC leaves a `MICE` row in `job_detail_non_linguistic`,
 * which is also where an IMC row goes, and clearing "the other table" would clear nothing and let
 * the FK refuse the UPDATE.
 *
 * `JobProjectOps` opens the transaction because it is scoped: it answers "may this caller write this
 * job" and "what type is it now" in one statement, and the unscoped `JobDetailClearOps` that follows
 * is safe only because of it. `JobUpdateOps` is scoped too - redundantly, on purpose, so that no
 * write in the ops module depends on a caller having checked first.
 */
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
    let updated: JobRow | null;
    try {
      updated = await pgTransaction(async (client) => {
        const current = (await pgQuery(JobProjectOps(caller, id), client)).data;
        if (!current) return null;

        const nextType = input.jobType ?? current.jobType;
        if (nextType !== current.jobType) {
          await pgExecuteCount(JobDetailClearOps(id, jobDetailTable(current.jobType)), client);
        }

        const row = (await pgExecute(JobUpdateOps(caller, id, input, ctx), client)).data;
        if (!row) return null;

        const detail = JobDetailUpsertOps(id, nextType, input);
        if (detail) await pgExecuteCount(detail, client);
        return row;
      });
    } catch (err) {
      const mismatch = typeMismatchMessage(sqlConstraint(err));
      if (mismatch) return badRequest(mismatch);
      throw err;
    }
    if (!updated) return notFound("job");

    // Re-read for the same reason create does: the language pair and the category are in the side
    // tables, so the UPDATE's own RETURNING cannot see what it just caused to be written.
    const full = (await pgQuery(JobGetOps(caller, id))).data;
    return ok(full ?? updated);
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
