// SPDX-License-Identifier: MIT
//
// What the handover mail reads out of a project. One read, and no writes at all.
//
// The project header is not here - `ProjectGetOps` already returns it. What this file holds is the
// project's JOBS, and three lines of the mail come entirely from them: the languages, the
// deadlines, and the PMs being handed the work.
//
// ## Why there is no scope clause
//
// Every other read in this repository puts the caller's row scope inside the SQL. This one does
// not, and an omission that is deliberate has to say so, or the next person reads it as forgotten.
//
// A job has three scope columns - `j.job_pm_id`, `p.prj_mgr_id`, `p.prj_pm_id` (
// `JOB_SCOPE_COLUMNS`). The caller reaches this query only after `ProjectGetOps` has returned the
// SAME PROJECT through its own scope, whose columns are `p.prj_mgr_id` and `p.prj_pm_id`. So the
// project having been visible is itself proof that every job under it already satisfies two of the
// three. Adding a scope clause here would change no result and would create a FOURTH COPY of
// `JOB_SCOPE_COLUMNS` - precisely the drift `NeotmsJob.dbops`'s scope comment warns about.
//
// The call order is therefore the authorization. Read the project first; if it cannot be read,
// execution never arrives here.

import { param, readText, type SqlOps, type SqlRow } from "../../utils/PostgresUtils.js";

/**
 * One job, as far as the mail is concerned. Not every column of a job - only the ones that appear
 * in the form.
 *
 * No money. A handover mail tells the operating PM what is due, when, and in what shape; unit
 * prices and revenue are not their business. A query that does not read money cannot leak it.
 */
export type HandoverJob = {
  jobName: string | null;
  /** The job type. Decides whether this job carries a language pair - `isLinguistic` reads it. */
  jobType: string | null;
  jobSlang: string | null;
  jobElang: string | null;
  /** This job's PM. The mail's PM cell is these names collected. */
  jobPmName: string | null;
  jobEday: string | null;
  jobEdayTime: string | null;
};

/**
 * Every live job of one project. Deliberately unpaginated.
 *
 * No cursor and no limit, because this list IS the body of a single mail. A language list truncated
 * at fifty carries no mark anywhere in the mail saying it was truncated, so the reader takes the
 * missing languages for languages that do not exist. A project holds tens of jobs in practice, and
 * reading all of them is cheaper than the consequences of cutting the tail off.
 *
 * Ordered by `j.id` - the order the jobs were registered, which is the order the user sees on the
 * detail screen. If the mail listed languages in some other order, anyone comparing the two would
 * suspect something had gone missing.
 */
export const HandoverJobsOps: (projectId: string) => SqlOps<HandoverJob[]> = (projectId) => ({
  sql: `
    SELECT
      j.job_name      AS job_name,
      j.job_type      AS job_type,
      j.job_pm_name   AS job_pm_name,
      j.job_eday      AS job_eday,
      j.job_eday_time AS job_eday_time,
      jdl.job_slang   AS job_slang,
      jdl.job_elang   AS job_elang
      FROM job j
      LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
     WHERE j.project_id = :project_id
       AND j.deleted = false
     ORDER BY j.id
  `,
  parameters: [param("project_id", projectId, "id")],
  mapper: (rows: SqlRow[]) =>
    rows.map((row) => ({
      jobName: readText(row, "job_name"),
      jobType: readText(row, "job_type"),
      jobSlang: readText(row, "job_slang"),
      jobElang: readText(row, "job_elang"),
      jobPmName: readText(row, "job_pm_name"),
      jobEday: readText(row, "job_eday"),
      jobEdayTime: readText(row, "job_eday_time"),
    })),
});
