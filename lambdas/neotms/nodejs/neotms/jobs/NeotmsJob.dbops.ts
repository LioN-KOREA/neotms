// SPDX-License-Identifier: MIT
//
// The job (legacy PRJTB_JOB). One deliverable: one service, one price, and - depending on its
// 업무 구분 - either one language pair or one 업무 분류.
//
// REVENUE IS BOOKED HERE. `job_price_ksum` is the column the reports sum, which makes this module's
// correctness a reporting concern rather than a screen concern - a job written wrong is a figure
// wrong on every report that includes its delivery date.
//
// ## The type decides which side table the payload is in
//
// `job.job_type` is the discriminator (LINGUISTICS / MICE / IMC). The columns that only one type has
// live in `job_detail_linguistic` (`job_slang`, `job_elang`) and `job_detail_non_linguistic`
// (`job_category`), keyed one-row-per-job on `job_id`. db/011_job_types.sql has the full reasoning;
// what this module has to honour is three things:
//
//   1. Both joins are LEFT and both detail rows are optional. A job with neither a language nor a
//      category is normal - thousands exist - so nothing here may treat a missing detail row as an
//      error or substitute a default for it.
//   2. The detail columns cannot come from `RETURNING`. They are in another table, which is why
//      `jobColumns` carries only the job's own columns and `JOB_DETAIL_COLUMNS` is added to the
//      SELECTs separately, and why both write paths re-read.
//   3. A detail row's `job_type` is pinned by a composite FK to its parent's. So a type change with
//      a stale detail row still present FAILS (23503) - the stale row has to be deleted first, in
//      the same transaction. `JobDetailClearOps` exists for that and the manager's `updateJob` is
//      written in that order.
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
  type SqlWriteOps,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import { JOB_CODE, codeExpression } from "../NeotmsCodes.js";
import { JOB_KRW, JOB_KRW_JOIN } from "../NeotmsMoney.js";
import {
  JOB_TYPE_LINGUISTIC,
  isLinguistic,
  jobDetailTable,
  type JobDetailTable,
} from "../NeotmsJobTypes.js";
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
  upsertFragments,
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
  /** 업무 구분 - a JOBTYPE code. NOT NULL in the database, so only a create response can lack it. */
  jobType: string | null;
  /** From `job_detail_linguistic`, and null for a job that has no such row. */
  jobSlang: string | null;
  jobElang: string | null;
  /** 업무 분류 - from `job_detail_non_linguistic`. Null on a linguistics job by definition. */
  jobCategory: string | null;
  /**
   * How the amount was derived - also from `job_detail_linguistic`, and null on non-linguistic work.
   *
   * Decimal strings throughout. See neotms.schemas: no amount passes through a JS number.
   *
   * These five moved off `job` in db/012_job_pricing.sql. A MICE or IMC job is not billed per word,
   * so it has no volume and no unit price; what it has is the total below, entered directly.
   */
  jobVolume: string | null;
  unitCode: string | null;
  jobPriceSel: string | null;
  jobPrice: string | null;
  jobPriceDis: string | null;
  /**
   * The amount - on `job` itself, for every 업무 구분.
   *
   * It stays on the parent because a KRW total means the same thing on all three types, and because
   * `job_price_ksum` is what the report sums, what `JOB_SORTS.amount` sorts by and what the project
   * rollup aggregates. Moving it into a detail table would have changed all three at once.
   */
  coinCode: string | null;
  /**
   * The rate this job was EXCHANGED at, or null if it has not been exchanged.
   *
   * Read it as a settlement flag with a value attached: null on a foreign-currency job means an
   * open position, whose KRW worth is `jobPriceKrw` below and moves daily. db/014_fx_rates.sql.
   */
  coinRate: string | null;
  jobPriceSum: string | null;
  /** KRW total as BOOKED. What the form edits, and what an issued invoice says. */
  jobPriceKsum: string | null;
  /**
   * KRW worth as of NOW - revenue. Equal to `jobPriceKsum` unless the job is an unexchanged
   * foreign-currency one, in which case it is `jobPriceSum` at today's rate.
   *
   * Null on a row that came back from `RETURNING` rather than from the select path, because it is
   * computed through a join. Every list and detail read has it.
   */
  jobPriceKrw: string | null;
  jobSday: string | null;
  jobSdayTime: string | null;
  jobEday: string | null;
  jobEdayTime: string | null;
  jobMemo: string | null;
  jobState: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/**
 * The job's OWN columns. Usable in a `RETURNING` clause, which is the constraint that shapes it.
 *
 * The language pair, the category and the five pricing inputs are deliberately absent: they are in
 * the two detail tables, so they can only be selected through a join - see `JOB_DETAIL_COLUMNS`.
 * What IS still here is the money - `coin_code` through `job_price_ksum` - because the amount stays
 * on the parent for every 업무 구분. db/012_job_pricing.sql has the reasoning.
 */
const jobColumns = (q: string): string => `
  ${q}.id             AS job_id,
  ${q}.job_code       AS job_code,
  ${q}.project_id     AS project_id,
  ${q}.job_name       AS job_name,
  ${q}.work_code      AS work_code,
  ${q}.job_pm_id      AS job_pm_id,
  ${q}.job_pm_name    AS job_pm_name,
  ${q}.job_type       AS job_type,
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

/**
 * The type-specific columns, from the two detail tables.
 *
 * At most one of the two rows exists for any job and often neither does, so every column here can be
 * null and none of them is aliased to anything but its own name - `toJobRow` reads `job_slang` the
 * same way it did when the column was on `job`, which is what keeps the move invisible above this
 * module.
 *
 * Separate from `jobColumns` because the write paths interpolate that into `RETURNING`, where a
 * joined table is not in scope.
 *
 * The five pricing inputs sit on the linguistic side because only linguistic work is billed per
 * word: a MICE or IMC job carries its total directly, and the total is on `job` itself. So a
 * non-linguistic row reads `job_volume` as null, which is exactly what the 물량/단가 column wants.
 */
const JOB_DETAIL_COLUMNS = `
  jdl.job_slang    AS job_slang,
  jdl.job_elang    AS job_elang,
  jdl.job_volume   AS job_volume,
  jdl.unit_code    AS unit_code,
  jdl.job_price_sel AS job_price_sel,
  jdl.job_price    AS job_price,
  jdl.job_price_dis AS job_price_dis,
  jdn.job_category AS job_category,
  /*
   * The job's worth in KRW RIGHT NOW, which is not always job_price_ksum.
   *
   * It is in this column set rather than in jobColumns for the same reason the detail columns are:
   * it needs a join, and jobColumns goes into RETURNING. So a freshly inserted row reads it as
   * null - harmless, because createJob re-reads the job through the select path before answering
   * (see its comment), which is also where the detail columns come from.
   *
   * Two amounts on one row looks redundant and is not. They answer different questions, and the
   * list screens need both: job_price_ksum is WHAT WAS BOOKED - the figure the form edits and the
   * figure an already-issued invoice carries - while this is WHAT IT IS WORTH, which for an
   * unexchanged foreign-currency job moves with the currency. They are equal for every KRW job and
   * every settled one, i.e. for almost every row. NeotmsMoney's header has the rule.
   */
  ${JOB_KRW} AS job_price_krw
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
  jobType: readText(row, "job_type"),
  jobSlang: readText(row, "job_slang"),
  jobElang: readText(row, "job_elang"),
  jobCategory: readText(row, "job_category"),
  jobVolume: readMoney(row, "job_volume"),
  unitCode: readText(row, "unit_code"),
  jobPriceSel: readText(row, "job_price_sel"),
  jobPrice: readMoney(row, "job_price"),
  jobPriceDis: readMoney(row, "job_price_dis"),
  coinCode: readText(row, "coin_code"),
  coinRate: readMoney(row, "coin_rate"),
  jobPriceSum: readMoney(row, "job_price_sum"),
  jobPriceKsum: readMoney(row, "job_price_ksum"),
  jobPriceKrw: readMoney(row, "job_price_krw"),
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
  /**
   * Largest jobs first. Sorted on the KRW total so mixed-currency lists compare meaningfully.
   *
   * Deliberately the BOOKED figure (`job_price_ksum`) and not the live `job_price_krw` the row
   * displays, so an open position can sort a place or two away from where its shown amount would put
   * it. That is the lesser of two evils: `sortAlias` derives the cursor's row key by slicing after
   * the first dot (NeotmsQuery.ts), so a sort target must be a real qualified column - point this at
   * the `CASE` expression and the keyset cursor stops advancing SILENTLY, repeating the first page
   * forever with no error. A slightly stale ordering is visible; a stalled cursor is not.
   */
  amount: { column: "j.job_price_ksum", cast: "numeric" },
} as const satisfies Record<string, SortTarget>;

export type JobSortKey = keyof typeof JOB_SORTS;

/** `j.job_name` and `p.prj_name` carry PGroonga indexes; the code columns are exact-match helpers. */
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
  /** 업무 구분. The one filter that identifies a MICE or IMC job as such. */
  jobType: { column: "j.job_type", kind: "text" },
  /**
   * The language pair, now read through the detail table.
   *
   * Filtering on `jdl.*` through a LEFT JOIN narrows to jobs that HAVE that language, which is what
   * both the old behaviour and the screen mean by the filter. A job with no detail row drops out,
   * exactly as a job with a NULL `job_slang` used to.
   */
  slang: { column: "jdl.job_slang", kind: "text" },
  elang: { column: "jdl.job_elang", kind: "text" },
  /** 업무 분류 - the language pair's counterpart for the non-linguistic types. */
  jobCategory: { column: "jdn.job_category", kind: "text" },
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
 *
 * Exported only so that a test can assert `REPORT_SCOPE_COLUMNS` still equals it. A report is an
 * aggregate of jobs, so it has to be visible over exactly the jobs its reader can list, and these
 * two lists drifting apart is silent in both directions: a column here and not there hides revenue
 * from someone who can open every job behind it, and a column there and not here leaks an aggregate
 * over work they cannot see a single row of.
 */
export const JOB_SCOPE_COLUMNS = ["j.job_pm_id", "p.prj_mgr_id", "p.prj_pm_id"];

/**
 * The joins every read shares. See the module header for why `project` is an INNER join.
 *
 * The two detail joins are LEFT and that is not a precaution - at most one of them matches, and for
 * a job with neither a language nor a category neither does. An INNER join to either would make the
 * job list silently drop rows.
 *
 * Both are one-row-at-most by key: `job_id` is the primary key of each detail table, so neither can
 * fan a job out into duplicates the way a join to a list table would.
 *
 * `JOB_KRW_JOIN` is here for the same reason and with the same guarantee - LEFT, and matching on
 * `fx_rate_latest.currency_code`, which the view makes unique by construction. It is what
 * `job_price_krw` reads; see NeotmsMoney.ts.
 */
const JOB_FROM = `
    FROM job j
    JOIN project p ON p.id = j.project_id AND p.deleted = false
    LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
    LEFT JOIN job_detail_non_linguistic jdn ON jdn.job_id = j.id
    ${JOB_KRW_JOIN}
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
 * It does mean a soft-deleted project hides its jobs from this list, which is exactly why
 * `deleteProject` refuses while live jobs exist. The reports agree either way: they join `project`
 * on `p.deleted = false` too, so a soft-deleted project's revenue leaves the list and the totals at
 * the same moment instead of lingering in one of them.
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
      ${JOB_PROJECT_COLUMNS},
      ${JOB_DETAIL_COLUMNS}
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
      ${JOB_PROJECT_COLUMNS},
      ${JOB_DETAIL_COLUMNS}
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

/** What `JobProjectOps` answers: the job exists, is visible, and is this project's and this type's. */
export type JobIdentity = {
  projectId: string;
  /** 업무 구분. Never null - the column is NOT NULL - but defaulted here against a pre-011 row. */
  jobType: string;
};

/**
 * Whether this caller may act on this job, which project it belongs to, and what type it is.
 *
 * Returns the project id because a PO needs it: a PO's `project_id` is derived from its job rather
 * than accepted from the request, so this one query answers "may they" and "where does it go" at
 * the same time. Null means either no such job or not visible - the same answer to both questions
 * being asked.
 *
 * It returns the type for two reasons, both of them about not writing a second scoped read:
 *
 *   - a new PO defaults its own 업무 구분 from its job's, and
 *   - `updateJob` needs the CURRENT type to know whether the type is changing and therefore which
 *     stale detail row to delete first.
 *
 * Being scoped, it also authorizes those writes. That matters more than it looks: the alternative
 * was a fourth copy of `JOB_SCOPE_COLUMNS`, which is the drift this file's scope comment warns
 * about.
 */
export const JobProjectOps: (caller: NeotmsCaller, id: string) => SqlOps<JobIdentity | null> = (
  caller,
  id,
) => {
  const scope = scopeClauseForOne(caller, JOB_SCOPE_COLUMNS);
  return {
    sql: `
      SELECT j.project_id AS project_id,
             j.job_type   AS job_type
      ${JOB_FROM}
       WHERE j.id = :id
         AND j.deleted = false
      ${scope.fragment}
       LIMIT 1
    `,
    parameters: [param("id", id, "id"), ...scope.parameters],
    mapper: (rows) => {
      const row = rows[0];
      if (!row) return null;
      const projectId = readId(row, "project_id");
      if (projectId === null) return null;
      return { projectId, jobType: readText(row, "job_type") ?? JOB_TYPE_LINGUISTIC };
    },
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
  /**
   * 업무 구분. Seven columns are NOT here any more and must not be re-added, because a spec for a
   * column `job` no longer has makes EVERY save fail with 42703:
   *
   * - `job_slang`, `job_elang` (db/011_job_types.sql) and `job_volume`, `unit_code`,
   *   `job_price_sel`, `job_price`, `job_price_dis` (db/012_job_pricing.sql) belong to
   *   `job_detail_linguistic` and are written by `JobLinguisticUpsertOps`;
   * - `job_category` belongs to `job_detail_non_linguistic` and is written by the other upsert.
   *
   * The four money columns below DID stay, and are the reason the split works: a MICE job records
   * no word count but still records a total.
   */
  { column: "job_type", kind: "text", read: (i) => i.jobType },
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

/* -------------------------------------------------------------------------- */
/* The type-specific detail rows                                              */
/* -------------------------------------------------------------------------- */

/**
 * `job_detail_linguistic`'s writable columns - the language pair and how the amount was derived.
 *
 * The five pricing inputs are here and not in `JOB_FIELDS` because only linguistic work is billed
 * per word (db/012_job_pricing.sql). A MICE or IMC job submits `job_price_sum` and
 * `job_price_ksum` directly, and those two never left `job`.
 *
 * Consequence worth knowing: re-typing a job to MICE drops this row, so the word count and unit
 * price go with it while the total survives on the parent. That is the point - the legacy
 * workaround stored a fabricated 한국어 > 한국어 pair and `1 단어` to make a non-linguistic job fit
 * a linguistic form, and clearing it must not disturb the one number the report reads.
 */
const JOB_LINGUISTIC_FIELDS: readonly FieldSpec<JobUpdate>[] = [
  { column: "job_slang", kind: "text", read: (i) => i.jobSlang },
  { column: "job_elang", kind: "text", read: (i) => i.jobElang },
  { column: "job_volume", kind: "money", read: (i) => i.jobVolume },
  { column: "unit_code", kind: "text", read: (i) => i.unitCode },
  { column: "job_price_sel", kind: "text", read: (i) => i.jobPriceSel },
  { column: "job_price", kind: "money", read: (i) => i.jobPrice },
  { column: "job_price_dis", kind: "money", read: (i) => i.jobPriceDis },
];

/** `job_detail_non_linguistic`'s writable columns. */
const JOB_NON_LINGUISTIC_FIELDS: readonly FieldSpec<JobUpdate>[] = [
  { column: "job_category", kind: "text", read: (i) => i.jobCategory },
];

/**
 * Write the detail row for a job of this type - or return null, meaning there is nothing to write.
 *
 * Null rather than a statement that writes nothing, because "nothing to write" is the common case
 * and it is also the CORRECT case: a job with no language pair and no category needs no detail row,
 * and inserting an all-NULL one would turn "nobody has filled this in" into a row that exists.
 * db/011_job_types.sql puts it as "constraints forbid, never require".
 *
 * `job_type` is written alongside the payload and is not optional in the statement. The detail
 * table's composite FK to `job (id, job_type)` is what makes a language pair on a MICE job
 * impossible, and the FK can only check a value that is actually stored.
 *
 * The caller must have established that it may write this job. There is no scope predicate here -
 * see `JobDetailClearOps` for why that is a decision rather than an omission.
 */
export const JobDetailUpsertOps = (
  jobId: string,
  jobType: string,
  input: JobUpdate,
): SqlWriteOps | null => {
  const linguistic = isLinguistic(jobType);
  const table: JobDetailTable = jobDetailTable(jobType);
  const fields = upsertFragments(
    linguistic ? JOB_LINGUISTIC_FIELDS : JOB_NON_LINGUISTIC_FIELDS,
    input,
  );
  if (fields.columns.length === 0) return null;
  return {
    sql: `
      INSERT INTO ${table} (job_id, job_type, ${fields.columns.join(", ")})
      VALUES (:job_id, :job_type, ${fields.placeholders.join(", ")})
      ON CONFLICT (job_id) DO UPDATE
         SET job_type = EXCLUDED.job_type,
             ${fields.assignments.join(",\n             ")}
    `,
    parameters: [
      param("job_id", jobId, "id"),
      param("job_type", jobType, "text"),
      ...fields.parameters,
    ],
  };
};

/**
 * Delete a job's row from one detail table.
 *
 * Run before a type change, and required for correctness independently of any constraint: a job
 * edited from LINGUISTICS to MICE and back would otherwise resurface its old language pair, having
 * apparently remembered something the user cleared. The composite FK only makes forgetting this
 * impossible - it turns a silent wrong answer into a 23503.
 *
 * DELIBERATELY UNSCOPED, and that is worth a sentence. Every other write in this module carries
 * `JOB_SCOPE_COLUMNS`, and adding it here would need the project join an UPDATE-style `FROM` would
 * give - a fourth copy of the predicate this file's scope comment names as the hazard. Instead this
 * only ever runs after `JobProjectOps` has returned a row for this caller, inside the same
 * transaction: the authorization is one statement earlier and cannot be skipped, because the id
 * being deleted is the id that read proved.
 *
 * `table` is a closed union, not a string from anywhere near a request - see `jobDetailTables`.
 */
export const JobDetailClearOps = (jobId: string, table: JobDetailTable): SqlWriteOps => ({
  sql: `DELETE FROM ${table} WHERE job_id = :job_id`,
  parameters: [param("job_id", jobId, "id")],
});

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
