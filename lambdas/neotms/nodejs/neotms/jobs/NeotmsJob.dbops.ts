// SPDX-License-Identifier: MIT
//
// The job (legacy PRJTB_JOB). One deliverable: one language pair, one service, one price.
//
// REVENUE IS BOOKED HERE. `job_price_ksum` is the column the reports sum, which makes this module's
// correctness a reporting concern rather than a screen concern - a job written wrong is a figure
// wrong on every report that includes its delivery date.
//
// ## The scope is inherited, which is why every read joins the project
//
// A job has one owner of its own (`job_pm_id`) but belongs to a project with two
// (`prj_mgr_id`, `prj_pm_id`), and all three must be able to see it: the sales manager who sold the
// project, the PM who runs it, and the PM assigned this particular deliverable. So `project` is
// joined on every read - not for its columns, but because the scope predicate needs them.
//
// The join is INNER and unconditional, which is also the integrity check: `project_id` is NOT NULL
// with an FK, so a job with no visible project is a job whose project was soft-deleted, and that is
// a row no screen should show. See the comment on `JobListOps`.

import {
  param,
  readId,
  readMoney,
  readText,
  type SortTarget,
  type SqlOps,
  type SqlRow,
} from "../../utils/RdsDataUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import { JOB_CODE, codeExpression } from "../NeotmsCodes.js";
import {
  cursorClause,
  filterClause,
  limitClause,
  mergeClauses,
  orderByClause,
  rangeClause,
  scopeClause,
  scopeClauseForOne,
  searchClause,
  type FilterSpec,
  type ListQuery,
} from "../NeotmsQuery.js";
import {
  derivedInsert,
  derivedUpdate,
  insertFragments,
  updateFragments,
  type DerivedSpec,
  type FieldSpec,
  type WriteContext,
} from "../NeotmsWrite.js";
import type { JobCreate, JobUpdate } from "../neotms.schemas.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type JobRow = {
  id: string;
  jobCode: string;
  projectId: string;
  /** Carried from the joined project, so a job list can show what it belongs to. */
  prjCode: string | null;
  prjName: string | null;
  cusCodeName: string | null;
  jobName: string | null;
  workCode: string | null;
  jobPmId: string | null;
  jobPmName: string | null;
  jobSlang: string | null;
  jobElang: string | null;
  /** Decimal strings throughout. See neotms.schemas: no amount passes through a JS number. */
  jobVolume: string | null;
  unitCode: string | null;
  jobPriceSel: string | null;
  jobPrice: string | null;
  jobPriceDis: string | null;
  coinCode: string | null;
  /** The FX rate captured at transaction time, not today's. */
  coinRate: string | null;
  jobPriceSum: string | null;
  /** KRW total. This is revenue. */
  jobPriceKsum: string | null;
  jobSday: string | null;
  jobSdayTime: string | null;
  jobEday: string | null;
  jobEdayTime: string | null;
  jobMemo: string | null;
  jobState: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const jobColumns = (q: string): string => `
  ${q}.id             AS job_id,
  ${q}.job_code       AS job_code,
  ${q}.project_id     AS project_id,
  ${q}.job_name       AS job_name,
  ${q}.work_code      AS work_code,
  ${q}.job_pm_id      AS job_pm_id,
  ${q}.job_pm_name    AS job_pm_name,
  ${q}.job_slang      AS job_slang,
  ${q}.job_elang      AS job_elang,
  ${q}.job_volume     AS job_volume,
  ${q}.unit_code      AS unit_code,
  ${q}.job_price_sel  AS job_price_sel,
  ${q}.job_price      AS job_price,
  ${q}.job_price_dis  AS job_price_dis,
  ${q}.coin_code      AS coin_code,
  ${q}.coin_rate      AS coin_rate,
  ${q}.job_price_sum  AS job_price_sum,
  ${q}.job_price_ksum AS job_price_ksum,
  ${q}.job_sday       AS job_sday,
  ${q}.job_sday_time  AS job_sday_time,
  ${q}.job_eday       AS job_eday,
  ${q}.job_eday_time  AS job_eday_time,
  ${q}.job_memo       AS job_memo,
  ${q}.job_state      AS job_state,
  ${q}.created_at     AS created_at,
  ${q}.updated_at     AS updated_at
`;

/**
 * The project columns a job row carries.
 *
 * Aliased with a `prj_` prefix rather than reusing the project module's aliases, because `job` and
 * `project` both have a `created_at` and a `coin_code`: under `formatRecordsAs: "JSON"` two columns
 * of the same name collapse into one key with the last writer winning, silently. The prefix is what
 * keeps a job's own `coin_code` from being overwritten by its project's.
 */
const JOB_PROJECT_COLUMNS = `
  p.prj_code      AS prj_code,
  p.prj_name      AS prj_name,
  p.cus_code_name AS prj_cus_code_name
`;

export const toJobRow = (row: SqlRow): JobRow => ({
  id: readId(row, "job_id") ?? "",
  jobCode: readText(row, "job_code") ?? "",
  projectId: readId(row, "project_id") ?? "",
  prjCode: readText(row, "prj_code"),
  prjName: readText(row, "prj_name"),
  cusCodeName: readText(row, "prj_cus_code_name"),
  jobName: readText(row, "job_name"),
  workCode: readText(row, "work_code"),
  jobPmId: readId(row, "job_pm_id"),
  jobPmName: readText(row, "job_pm_name"),
  jobSlang: readText(row, "job_slang"),
  jobElang: readText(row, "job_elang"),
  jobVolume: readMoney(row, "job_volume"),
  unitCode: readText(row, "unit_code"),
  jobPriceSel: readText(row, "job_price_sel"),
  jobPrice: readMoney(row, "job_price"),
  jobPriceDis: readMoney(row, "job_price_dis"),
  coinCode: readText(row, "coin_code"),
  coinRate: readMoney(row, "coin_rate"),
  jobPriceSum: readMoney(row, "job_price_sum"),
  jobPriceKsum: readMoney(row, "job_price_ksum"),
  jobSday: readText(row, "job_sday"),
  jobSdayTime: readText(row, "job_sday_time"),
  jobEday: readText(row, "job_eday"),
  jobEdayTime: readText(row, "job_eday_time"),
  jobMemo: readText(row, "job_memo"),
  jobState: readText(row, "job_state"),
  createdAt: readText(row, "created_at"),
  updatedAt: readText(row, "updated_at"),
});

/* -------------------------------------------------------------------------- */
/* Sorting, searching, filtering, scope                                       */
/* -------------------------------------------------------------------------- */

export const JOB_SORTS = {
  created: { column: "j.created_at", cast: "timestamptz" },
  code: { column: "j.job_code" },
  name: { column: "j.job_name" },
  /** Delivery date: the deadline a PM works from, and the business date revenue lands on. */
  due: { column: "j.job_eday", cast: "date" },
  start: { column: "j.job_sday", cast: "date" },
  /** Largest jobs first. Sorted on the KRW total so mixed-currency lists compare meaningfully. */
  amount: { column: "j.job_price_ksum", cast: "numeric" },
} as const satisfies Record<string, SortTarget>;

export type JobSortKey = keyof typeof JOB_SORTS;

/** `j.job_name` and `p.prj_name` are bigm-indexed; the code columns are exact-match helpers. */
const JOB_SEARCH_COLUMNS = [
  "j.job_name",
  "j.job_code",
  "j.job_pm_name",
  "p.prj_name",
  "p.prj_code",
  "p.cus_code_name",
];

const JOB_FILTERS = {
  projectId: { column: "j.project_id", kind: "id" },
  state: { column: "j.job_state", kind: "text" },
  workCode: { column: "j.work_code", kind: "text" },
  slang: { column: "j.job_slang", kind: "text" },
  elang: { column: "j.job_elang", kind: "text" },
  pmId: { column: "j.job_pm_id", kind: "id" },
  /** Filters on the project's customer, which is where the customer actually lives. */
  customerId: { column: "p.customer_id", kind: "id" },
  corpId: { column: "p.corp_id", kind: "id" },
} as const satisfies Record<string, FilterSpec>;

export type JobFilters = Partial<Record<keyof typeof JOB_FILTERS, string>> & {
  dueFrom?: string;
  dueTo?: string;
};

/**
 * All three ownership columns: the job's PM, and the project's sales manager and PM.
 *
 * `scopeClause` ORs them, which is the intended reading - any one of the three is enough. Leaving
 * out the project's two would mean a sales manager could see a project but none of the work in it,
 * and so could not tell what they had sold.
 */
const JOB_SCOPE_COLUMNS = ["j.job_pm_id", "p.prj_mgr_id", "p.prj_pm_id"];

/** The join every read shares. See the module header for why it is an INNER join. */
const JOB_FROM = `
    FROM job j
    JOIN project p ON p.id = j.project_id AND p.deleted = false
`;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One page of jobs.
 *
 * The join to `project` filters on `p.deleted = false` as well as joining, so a job under a
 * soft-deleted project disappears from this list. That is deliberate: the alternative is a job
 * whose project cannot be opened, displayed next to a project name and code that lead nowhere.
 *
 * It does mean a soft-deleted project hides its jobs while they keep contributing to the rollup -
 * which is exactly why `deleteProject` refuses while live jobs exist.
 */
export const JobListOps: (
  caller: NeotmsCaller,
  query: ListQuery<JobSortKey>,
  filters: JobFilters,
) => SqlOps<SqlRow[]> = (caller, query, filters) => {
  const where = mergeClauses(
    scopeClause(caller, JOB_SCOPE_COLUMNS),
    cursorClause(query, "j.id"),
    searchClause(JOB_SEARCH_COLUMNS, query.search),
    filterClause(JOB_FILTERS, filters),
    rangeClause("due", "j.job_eday", filters.dueFrom, filters.dueTo),
  );
  const limit = limitClause(query);
  return {
    sql: `
      SELECT ${jobColumns("j")},
      ${JOB_PROJECT_COLUMNS}
      ${JOB_FROM}
       WHERE j.deleted = false
      ${where.fragment}
      ${orderByClause(query, "j.id")}
      ${limit.fragment}
    `,
    parameters: [...where.parameters, ...limit.parameters],
    mapper: (rows) => rows,
  };
};

export const JobGetOps: (caller: NeotmsCaller, id: string) => SqlOps<JobRow | null> = (
  caller,
  id,
) => {
  const scope = scopeClauseForOne(caller, JOB_SCOPE_COLUMNS);
  return {
    sql: `
      SELECT ${jobColumns("j")},
      ${JOB_PROJECT_COLUMNS}
      ${JOB_FROM}
       WHERE j.id = :id
         AND j.deleted = false
      ${scope.fragment}
       LIMIT 1
    `,
    parameters: [param("id", id, "id"), ...scope.parameters],
    mapper: (rows) => (rows.length > 0 ? toJobRow(rows[0]!) : null),
  };
};

/**
 * Whether this caller may act on this job, and which project it belongs to.
 *
 * Returns the project id because a PO needs it: a PO's `project_id` is derived from its job rather
 * than accepted from the request, so this one query answers "may they" and "where does it go" at
 * the same time. Null means either no such job or not visible - the same answer to both questions
 * being asked.
 */
export const JobProjectOps: (caller: NeotmsCaller, id: string) => SqlOps<string | null> = (
  caller,
  id,
) => {
  const scope = scopeClauseForOne(caller, JOB_SCOPE_COLUMNS);
  return {
    sql: `
      SELECT j.project_id AS project_id
      ${JOB_FROM}
       WHERE j.id = :id
         AND j.deleted = false
      ${scope.fragment}
       LIMIT 1
    `,
    parameters: [param("id", id, "id"), ...scope.parameters],
    mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "project_id") : null),
  };
};

/** How many live POs hang off this job. Asked before a delete, for the 409 message. */
export const JobLivePoCountOps: (id: string) => SqlOps<number> = (id) => ({
  sql: `
    SELECT count(*) AS po_count
      FROM purchase_order po
     WHERE po.job_id = :id
       AND po.deleted = false
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => Number(rows[0]?.["po_count"] ?? 0),
});

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The writable columns.
 *
 * `project_id` is here because the INSERT needs it, but `JobUpdateSchema` omits the field - so an
 * edit can never reach this entry. Moving a job between projects relocates booked revenue between
 * customers and report dimensions; the legacy system journalled it in LOG_JOB, and it belongs in an
 * operation of its own with an audit record, not in a field on the edit form.
 */
const JOB_FIELDS: readonly FieldSpec<JobUpdate & { projectId?: string }>[] = [
  { column: "project_id", kind: "id", read: (i) => i.projectId },
  { column: "job_name", kind: "text", read: (i) => i.jobName },
  { column: "work_code", kind: "text", read: (i) => i.workCode },
  { column: "job_pm_id", kind: "id", read: (i) => i.jobPmId },
  { column: "job_slang", kind: "text", read: (i) => i.jobSlang },
  { column: "job_elang", kind: "text", read: (i) => i.jobElang },
  { column: "job_volume", kind: "money", read: (i) => i.jobVolume },
  { column: "unit_code", kind: "text", read: (i) => i.unitCode },
  { column: "job_price_sel", kind: "text", read: (i) => i.jobPriceSel },
  { column: "job_price", kind: "money", read: (i) => i.jobPrice },
  { column: "job_price_dis", kind: "money", read: (i) => i.jobPriceDis },
  { column: "coin_code", kind: "text", read: (i) => i.coinCode },
  { column: "coin_rate", kind: "money", read: (i) => i.coinRate },
  { column: "job_price_sum", kind: "money", read: (i) => i.jobPriceSum },
  { column: "job_price_ksum", kind: "money", read: (i) => i.jobPriceKsum },
  { column: "job_sday", kind: "date", read: (i) => i.jobSday },
  { column: "job_sday_time", kind: "time", read: (i) => i.jobSdayTime },
  { column: "job_eday", kind: "date", read: (i) => i.jobEday },
  { column: "job_eday_time", kind: "time", read: (i) => i.jobEdayTime },
  { column: "job_memo", kind: "text", read: (i) => i.jobMemo },
  { column: "job_state", kind: "text", read: (i) => i.jobState },
];

const JOB_DERIVED: readonly DerivedSpec<JobUpdate>[] = [
  {
    column: "job_pm_name",
    expression: "(SELECT s.mgr_name FROM staff s WHERE s.id = :job_pm_id AND s.deleted = false)",
    read: (i) => i.jobPmId,
  },
];

/**
 * Create a job.
 *
 * The project is NOT verified here. The caller's right to add work to this project was established
 * before this statement was built - see `ProjectVisibleOps` and the job manager - and repeating the
 * check in the INSERT would need either a second round trip or a conditional INSERT that returns no
 * row for two different reasons, which the manager could not then tell apart.
 */
export const JobCreateOps: (input: JobCreate, ctx: WriteContext) => SqlOps<JobRow | null> = (
  input,
  ctx,
) => {
  const fields = insertFragments(JOB_FIELDS, input);
  const derived = derivedInsert(JOB_DERIVED, input);
  return {
    sql: `
      INSERT INTO job (
        job_code, ${[...fields.columns, ...derived.columns].join(", ")}, created_by, created_ip
      ) VALUES (
        ${codeExpression(JOB_CODE)},
        ${[...fields.placeholders, ...derived.expressions].join(", ")},
        :created_by, :created_ip
      )
      RETURNING ${jobColumns("job")}
    `,
    parameters: [
      ...fields.parameters,
      param("created_by", ctx.actor, "text"),
      param("created_ip", ctx.ip, "text"),
    ],
    // No project columns: RETURNING cannot reach the joined table. The manager re-reads through
    // JobGetOps so a created job and a fetched job are the same shape - a response that is missing
    // the project name only on create is the kind of inconsistency a frontend works around badly.
    mapper: (rows) => (rows.length > 0 ? toJobRow(rows[0]!) : null),
  };
};

/**
 * Edit a job, with the scope enforced inside the statement.
 *
 * The scope needs the project's columns, and an UPDATE has no join - hence `FROM project p`, which
 * is PostgreSQL's way of writing an updating join. The `p.id = j.project_id` condition is in the
 * WHERE clause and is not optional: without it the UPDATE would pair the job with every project
 * row, and the first one to satisfy the scope predicate would authorise the write.
 */
export const JobUpdateOps: (
  caller: NeotmsCaller,
  id: string,
  input: JobUpdate,
  ctx: WriteContext,
) => SqlOps<JobRow | null> = (caller, id, input, ctx) => {
  const fields = updateFragments(JOB_FIELDS, input);
  const derived = derivedUpdate(JOB_DERIVED, input);
  const scope = scopeClauseForOne(caller, JOB_SCOPE_COLUMNS);
  return {
    sql: `
      UPDATE job j
         SET ${[fields.fragment, ...derived].filter((f) => f.length > 0).join(",\n             ")},
             updated_at = now(),
             created_by = :created_by
        FROM project p
       WHERE j.id = :id
         AND j.deleted = false
         AND p.id = j.project_id
         AND p.deleted = false
      ${scope.fragment}
      RETURNING ${jobColumns("j")}
    `,
    parameters: [
      ...fields.parameters,
      ...scope.parameters,
      param("id", id, "id"),
      param("created_by", ctx.actor, "text"),
    ],
    mapper: (rows) => (rows.length > 0 ? toJobRow(rows[0]!) : null),
  };
};

export const JobSoftDeleteOps: (
  caller: NeotmsCaller,
  id: string,
  ctx: WriteContext,
) => SqlOps<string | null> = (caller, id, ctx) => {
  const scope = scopeClauseForOne(caller, JOB_SCOPE_COLUMNS);
  return {
    sql: `
      UPDATE job j
         SET deleted = true, updated_at = now(), created_by = :created_by
        FROM project p
       WHERE j.id = :id
         AND j.deleted = false
         AND p.id = j.project_id
         AND p.deleted = false
      ${scope.fragment}
      RETURNING j.id AS job_id
    `,
    parameters: [
      param("id", id, "id"),
      param("created_by", ctx.actor, "text"),
      ...scope.parameters,
    ],
    mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "job_id") : null),
  };
};
