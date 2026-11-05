// SPDX-License-Identifier: MIT
//
// The reports, aggregated from `job`, `project` and `purchase_order` on every request.
//
// ## Why this is computed live and not read from a rollup
//
// It used to read `report_daily_rollup`, a daily pre-aggregated fact table rebuilt by a nightly
// job. That was replaced, and the reasoning is worth keeping because the rollup is the obvious
// design and it was wrong here for three separate reasons:
//
//   1. A nightly rollup cannot answer the question being asked. A manager opens this screen to see
//      what has happened, including this morning's deliveries and the invoice somebody corrected an
//      hour ago. Data up to midnight is not a slower answer, it is a different and wrong one - and
//      the legacy system this replaces does show today's work, so shipping a report that does not
//      would be a regression dressed up as an optimisation.
//   2. Nothing owned the recompute. No Lambda, no schedule, no application code ever called
//      `report_rollup_recompute`, so the table was created empty and stayed empty: every report
//      returned zeroes while looking perfectly healthy - an empty chart over a valid date range
//      reads as "a quiet quarter", not as "the pipeline does not exist". A cache with no writer is
//      strictly worse than no cache.
//   3. Its premise no longer holds. The rollup was justified by the legacy yearly report, which
//      aggregates the whole history on every page view and parses nvarchar amounts per row. Neither
//      applies to this schema: `job_price_ksum` and `po_price_ksum` are already `numeric(18,2)`, so
//      there is nothing to parse, and `ReportQuerySchema` *requires* both ends of the date range,
//      so `ix_job_eday` turns every report into a bounded index scan. Measured on a database an
//      order of magnitude larger than production (150k jobs, 200k POs, 15 years): 7-10 ms for a
//      month, 66 ms for a year, 673 ms for the entire fifteen years. The rollup's advantage over
//      that is tens of milliseconds a manager cannot perceive, bought with a whole second system
//      of record for revenue that can silently disagree with the first.
//
// What the rollup's existence did leave behind is its *definitions*, and those were right. They are
// preserved exactly here, so a report run today reproduces what the rollup would have computed:
//
//   business date  job.job_eday            - delivery is the point of revenue recognition, so a job
//                                            created in December and delivered in January belongs
//                                            to January. NOT created_at, NOT the project's dates.
//   revenue        JOB_KRW over job        - booked on the JOB
//   cost           PO_KRW over purchase_order - booked on the PO
//   margin         revenue - cost          - derived in SQL, never stored
//
// Both amounts are KRW rather than original-currency totals, because a report row aggregates across
// currencies and those figures have to be comparable.
//
// What produces the KRW figure is `NeotmsMoney.JOB_KRW` / `PO_KRW` rather than the bare
// `*_price_ksum` columns, and the difference shows up in one case out of three: a foreign-currency
// amount NOBODY HAS EXCHANGED YET is valued at today's rate, because its worth in KRW moves with
// the currency until somebody converts it. An amount that HAS been exchanged keeps the figure it was
// booked at, forever - so a report of a closed quarter still reproduces exactly on every run, which
// is the property the captured `job.coin_rate` was introduced to guarantee and which this change
// preserves rather than trades away. The full rule, and why it lives in one module, is in
// NeotmsMoney's header; db/014_fx_rates.sql is the authority on the data model behind it.
//
// ## Revenue lives one level above cost
//
// This is the trap the whole file is shaped around. A job has many POs, so joining `purchase_order`
// directly would fan each job's row out once per PO and multiply its revenue by its PO count - and
// the result does not look wrong, it just quietly overstates the company's income. Cost is
// therefore collapsed to one value per job by `LEFT JOIN LATERAL` *before* anything is summed, so
// every job contributes exactly one row to the aggregate no matter how it was subcontracted.
//
// LEFT, not INNER, in two places and both matter: a job with no POs yet is real revenue that has
// not been subcontracted, and dropping it would overstate margin; a project whose `prj_field` holds
// a retired code with no `sys_code` row must fall through to "(unassigned)" rather than vanish.
//
// ## Unset dimensions keep the rollup's sentinels
//
// `dim_key` reports `0` for an unset id and `?` for an unset language, where the underlying column
// is NULL. That is inherited from the rollup, whose dimension columns were NOT NULL with sentinel
// defaults because NULLs in a composite primary key never match `ON CONFLICT`. The reason to keep
// it now that the table is gone is the client: `dim_key` is what a drill-down sends back as
// `?customerId=...`, and a key of `null` is not a thing a query string can carry. So `0` still
// means "no customer", not "customer 0" - see `dimensionFilters`, which translates it back.
//
// `?` keeps its narrow meaning: a LINGUISTICS job whose languages were never recorded. Work that
// has no language pair to record at all - MICE, IMC, anything else added to the 업무 구분 list later
// - keys as `(비언어)` instead, so the `?` line stays readable as the data-entry gap it is. That
// distinction is the one thing the rollup could not have expressed, because it predates the type.

import {
  param,
  readMoney,
  readText,
  type SqlOps,
  type SqlParameter,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import { mergeClauses, rangeClause, scopeClause, type SqlClause } from "../NeotmsQuery.js";
import { JOB_TYPE_LINGUISTIC } from "../NeotmsJobTypes.js";
import { JOB_KRW, JOB_KRW_JOIN, PO_KRW, PO_KRW_JOIN } from "../NeotmsMoney.js";
import type { ReportQuery } from "../neotms.schemas.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type ReportLine = {
  /** The dimension value: a date, an id, a code, or a language pair. '0' / '?' mean unassigned. */
  key: string;
  /** What to print. Already resolved, including "(unassigned)" for a sentinel. */
  label: string;
  /** Decimal strings. `numeric` arithmetic done in PostgreSQL; see neotms.schemas. */
  revenue: string;
  cost: string;
  margin: string;
};

export type ReportTotals = {
  revenue: string;
  cost: string;
  margin: string;
  /**
   * How many jobs the totals were summed from - not POs and not breakdown lines.
   *
   * A sanity signal rather than a business figure, and it is exactly the job count because the
   * lateral cost join contributes one row per job by construction. If this ever drifts above
   * `SELECT count(*) FROM job ...` for the same range, something has started fanning out and the
   * money is being multiplied.
   */
  rows: number;
};

const toReportLine = (row: SqlRow): ReportLine => ({
  key: readText(row, "dim_key") ?? "",
  label: readText(row, "dim_label") ?? "(unassigned)",
  revenue: readMoney(row, "revenue") ?? "0",
  cost: readMoney(row, "cost") ?? "0",
  margin: readMoney(row, "margin") ?? "0",
});

/* -------------------------------------------------------------------------- */
/* The source rows                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every report reads this, and nothing else reads `purchase_order` for money.
 *
 * One `FROM` shared by the breakdown and the totals, because the two must agree: the totals are
 * deliberately *not* a sum of the returned lines (see `ReportTotalsOps`), so the only thing keeping
 * the grand total consistent with the chart above it is that both were computed from the same rows
 * with the same joins. Two hand-written `FROM` clauses would be two definitions of revenue.
 *
 * `JOIN project` is INNER on purpose: a job with no project cannot be placed on any dimension, so
 * there is nowhere to report it. This does mean orphan jobs are invisible here, and legacy has them
 * - `PRJTB_JOB` had no FK to `PRJTB_MAIN` - so the ETL must reconcile them. Monitor with:
 *
 *     SELECT count(*), sum(job_price_ksum) FROM job j
 *      WHERE NOT j.deleted
 *        AND NOT EXISTS (SELECT 1 FROM project p WHERE p.id = j.project_id);
 *
 * `LEFT JOIN LATERAL` rather than a `GROUP BY job_id` subquery over the whole PO table, because the
 * lateral is correlated: it runs `ix_po_job` once per job already selected by the date range, so a
 * one-month report touches the POs of that month's jobs. The uncorrelated form has to aggregate
 * every PO in the database before the date filter can be applied, which is what made the nightly
 * recompute O(dates x all POs) and eventually time out. The aggregate has no `GROUP BY`, so the
 * subquery returns exactly one row - `ON true` with an aggregate cannot drop or duplicate a job.
 *
 * `deleted = false` and not `NOT deleted`: `ix_job_eday` and `ix_po_job` are both partial indexes,
 * and this is the spelling the rest of the dbops layer uses.
 *
 * The two `fx_rate_latest` joins come from `NeotmsMoney`, and the PO's one is INSIDE the lateral
 * because that is where its `po` alias is in scope. Both are LEFT and both match on a UNIQUE column
 * (`fx_rate_latest` has one row per currency), so neither can drop a row or fan one out - the same
 * reasoning the `sys_code` joins on the dimensions below record. At five currencies the view is a
 * handful of rows the planner will hash once per query.
 */
const REPORT_FROM = `
        FROM job j
        JOIN project p ON p.id = j.project_id AND p.deleted = false
        ${JOB_KRW_JOIN}
        LEFT JOIN LATERAL (
               SELECT sum(${PO_KRW}) AS cost
                 FROM purchase_order po
                 ${PO_KRW_JOIN}
                WHERE po.job_id = j.id
                  AND po.deleted = false
             ) poc ON true
`;

/**
 * Revenue, cost and margin over whatever rows the surrounding query selected.
 *
 * Shared between the breakdown and the totals for the same reason `REPORT_FROM` is. `COALESCE` on
 * each sum is not defensive noise: `sum()` of an empty set - or of a group whose every amount is
 * NULL, which happens for a job priced but not yet costed - is NULL, and `NULL - NULL` would make
 * margin NULL rather than zero. The client renders a missing margin as an explanatory note instead
 * of a bar, so a NULL here turns a correct zero-margin line into "unknown".
 */
const REPORT_MEASURES = `
               COALESCE(sum(${JOB_KRW}), 0) AS revenue,
               COALESCE(sum(poc.cost), 0)   AS cost,
               COALESCE(sum(${JOB_KRW}), 0)
                 - COALESCE(sum(poc.cost), 0) AS margin
`;

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One way to break the totals down.
 *
 * `key` and `label` are interpolated into the SQL, and `join` more so - so this map is an
 * allow-list in the strict sense. `ReportQuerySchema.groupBy` is a valibot `picklist`, so a request
 * can only name one of these nine; the object is keyed by those same names and nothing else
 * reaches here.
 *
 * `label` is cast to text in every case because the column it comes from varies - a date, a bigint
 * id, a code string - and a single result shape is worth more to the client than preserving three
 * types across one field.
 *
 * Note which table each dimension comes from, because two of them are easy to transpose: the PM is
 * the one on the JOB (`job_pm_id`), which can differ from the project's own PM, while the sales
 * manager is the project's `prj_mgr_id`. Customer, corp and category are all project-level, so
 * every job in a project shares them.
 *
 * Two more are a level BELOW the job: `langPair` and `jobCategory` read the detail tables
 * db/011_job_types.sql introduced, and each therefore carries its own LEFT JOIN in `join` rather
 * than relying on `REPORT_FROM`. LEFT because a detail row is optional by design - see
 * NeotmsJobTypes.ts - so a job missing one must still be counted at its sentinel, not dropped from
 * the totals. `jobType` itself is on the job row and needs a join only to print its Korean name.
 */
type Dimension = {
  /** The grouping key expression, with unset values mapped to the sentinel. */
  key: string;
  /** The display label expression, with the sentinel already resolved. */
  label: string;
  /** The LEFT JOIN the label needs, if any. */
  join: string;
  /**
   * Which rows survive the `LIMIT`. Written in terms of the output aliases (`dim_key`, `revenue`).
   *
   * Separate from `displayBy` because "which rows matter" and "what order to read them in" are not
   * the same question once there is a limit, and for the time series they are opposites. `LIMIT 10`
   * on a `job_eday ASC` ordering returns the *oldest* ten days in the range - so a user asking
   * for "the last 30 days, top 10" would be shown January while believing they were shown the
   * recent past. Nothing about the result looks wrong: ten rows, correct figures, ascending dates.
   */
  pickBy: string;
  /** What order the surviving rows are returned in: a time series reads chronologically, a
   * breakdown largest-first. */
  displayBy: string;
};

const unassigned = (expression: string): string =>
  `COALESCE(NULLIF(${expression}, ''), '(unassigned)')`;

/** An id dimension's key: NULL becomes the sentinel `0`, and the whole thing becomes text. */
const idKey = (column: string): string => `COALESCE(${column}, 0)::text`;

/**
 * The ordering every revenue breakdown uses, for both picking and display.
 *
 * The `dim_label ASC` tie-breaker is not cosmetic. `ORDER BY revenue DESC` alone leaves rows with
 * equal revenue in whatever order the aggregate happened to emit them, and PostgreSQL is free to
 * change that between runs (a different plan, a different worker count under parallel aggregate).
 * With a `LIMIT` in front of it that means the *membership* of a top-10 can change between two
 * identical requests when the 10th and 11th place tie - the chart would shuffle on refresh with no
 * underlying data change. Ties are common here: a dimension value with one small job in the range,
 * or several at the same round price.
 */
const BY_REVENUE = "revenue DESC, dim_label ASC";

/**
 * The language pair, or `(비언어)` for work that has no such thing.
 *
 * Both halves live in `job_detail_linguistic` since db/011_job_types.sql, and a job of any other
 * 업무 구분 has no row there at all - so without the `CASE` every MICE and IMC job would read
 * `? > ?`, which already means something else entirely. `? > ?` is the data-entry gap this file's
 * header documents: a linguistics job somebody delivered without recording the languages. Blending
 * the two would put a growing business line inside a bucket managers are trained to read as "go and
 * fix these records".
 *
 * The `ELSE` is keyed off `j.job_type` rather than off the absence of a `jdl` row, so it mirrors
 * `isLinguistic` in NeotmsJobTypes.ts: a fourth type added later from 유지보수 lands in `(비언어)`,
 * which is the honest answer until someone gives it a dimension of its own.
 *
 * Still no join to `sys_code` for the two codes themselves - resolving them to `code_name` would
 * cost two more joins to print "한국어 > 영어" where the whole company says "KO > EN".
 */
const LANG_PAIR = `CASE WHEN j.job_type = '${JOB_TYPE_LINGUISTIC}'
                  THEN COALESCE(NULLIF(jdl.job_slang, ''), '?') || ' > '
                    || COALESCE(NULLIF(jdl.job_elang, ''), '?')
                  ELSE '(비언어)' END`;

const REPORT_DIMENSIONS = {
  /*
   * The time series, and the only dimension where picking and display disagree.
   *
   * No sentinel and no `unassigned`: a job with a NULL `job_eday` has no business date, so the
   * range predicate has already excluded it - `NULL >= :from` is NULL, which is not true. That is
   * the same rule the rollup applied by skipping those jobs, and it is worth knowing about rather
   * than papering over, because such a job is revenue that appears in no report for any range. It
   * is a data-entry gap (a delivered job nobody dated), not a reporting one, and the place to see
   * it is the job list, not here.
   *
   * `dim_key` is `job_eday::text`, and an ISO date string sorts identically to the date itself
   * (fixed width, most significant field first) - which is why ordering on the alias rather than on
   * `j.job_eday` is safe here and saves repeating the expression.
   */
  date: {
    key: "j.job_eday::text",
    label: "j.job_eday::text",
    join: "",
    pickBy: "dim_key DESC",
    displayBy: "dim_key ASC",
  },
  customer: {
    key: idKey("p.customer_id"),
    label: unassigned("cu.cus_name"),
    join: "LEFT JOIN customer cu ON cu.id = p.customer_id",
    pickBy: BY_REVENUE,
    displayBy: BY_REVENUE,
  },
  pm: {
    key: idKey("j.job_pm_id"),
    label: unassigned("spm.mgr_name"),
    join: "LEFT JOIN staff spm ON spm.id = j.job_pm_id",
    pickBy: BY_REVENUE,
    displayBy: BY_REVENUE,
  },
  salesManager: {
    key: idKey("p.prj_mgr_id"),
    label: unassigned("ssm.mgr_name"),
    join: "LEFT JOIN staff ssm ON ssm.id = p.prj_mgr_id",
    pickBy: BY_REVENUE,
    displayBy: BY_REVENUE,
  },
  corp: {
    key: idKey("p.corp_id"),
    label: unassigned("co.corp_name"),
    join: "LEFT JOIN corp co ON co.id = p.corp_id",
    pickBy: BY_REVENUE,
    displayBy: BY_REVENUE,
  },
  /*
   * The subject domain, resolved from the project's primary field code. `prj_field2` is deliberately
   * not reported on: a job counted under two fields would double the revenue of any breakdown that
   * summed the bars.
   *
   * Joined on `sys_code.code`, which is UNIQUE - so this cannot fan a job out across several code
   * rows the way an unconstrained label join could. A retired code with no row at all falls through
   * to sentinel 0, indistinguishable here from a project with no field set; to tell those two apart,
   * query `project.prj_field` directly.
   */
  category: {
    key: idKey("sc.id"),
    label: unassigned("sc.code_name"),
    join: "LEFT JOIN sys_code sc ON sc.code = p.prj_field",
    pickBy: BY_REVENUE,
    displayBy: BY_REVENUE,
  },
  /*
   * The one composite dimension, and the only one whose key is not an id. `unassigned` cannot catch
   * an empty string inside a concatenation, hence the NULLIF on each half, which also covers the
   * NULL the column may hold. See `LANG_PAIR` for the rest, including why the non-linguistic branch
   * exists.
   */
  langPair: {
    key: LANG_PAIR,
    label: LANG_PAIR,
    join: "LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id",
    pickBy: BY_REVENUE,
    displayBy: BY_REVENUE,
  },
  /*
   * 업무 구분 - which line of business the revenue came from, and the dimension `langPair` can no
   * longer answer now that it folds all three non-linguistic types into one line.
   *
   * Keyed on the CODE, not on `sys_code.id` the way `category` is. The code is what `j.job_type`
   * actually stores and what every other layer - the CHECK constraints, `isLinguistic`, the job
   * list's filter - identifies a type by, so going through the id would add a join to the key
   * expression and a fan-out risk for no gain. The label still resolves through `sys_code` to print
   * "언어 및 통번역" rather than "LINGUISTICS", falling back to the raw code so that a retired code
   * row degrades to `MICE` instead of to "(unassigned)" - the type is NOT NULL, so "(unassigned)"
   * would be a lie here.
   *
   * Alias `sct`, because `sc` is taken by `category` above and two joins to `sys_code` under one
   * alias is a syntax error rather than a wrong number.
   */
  jobType: {
    key: "j.job_type",
    label: "COALESCE(NULLIF(sct.code_name, ''), j.job_type)",
    join: "LEFT JOIN sys_code sct ON sct.code = j.job_type",
    pickBy: BY_REVENUE,
    displayBy: BY_REVENUE,
  },
  /*
   * 업무 분류 - the MICE/IMC equivalent of a language pair, from `job_detail_non_linguistic`.
   *
   * Every linguistics job falls into "(unassigned)" here, and that is correct rather than a gap: a
   * translation job has no 업무 분류 to record. Read this dimension with a 업무 구분 report beside
   * it, or the unassigned bar reads as missing data.
   *
   * Two joins, both LEFT: the detail row is optional by design (a MICE job saved before its category
   * was known has none), and the code row may have been retired.
   */
  jobCategory: {
    key: unassigned("jdn.job_category"),
    label: "COALESCE(NULLIF(sccat.code_name, ''), NULLIF(jdn.job_category, ''), '(unassigned)')",
    join:
      "LEFT JOIN job_detail_non_linguistic jdn ON jdn.job_id = j.id\n" +
      "        LEFT JOIN sys_code sccat ON sccat.code = jdn.job_category",
    pickBy: BY_REVENUE,
    displayBy: BY_REVENUE,
  },
} as const satisfies Record<ReportQuery["groupBy"], Dimension>;

/**
 * The most lines one report will return.
 *
 * Not pagination - a report is read as a whole or exported, not scrolled - but a ceiling. The Data
 * API caps a result set at 1 MiB and fails the whole call when it is exceeded, from deep inside the
 * SQL layer where the error says nothing useful. A thousand lines of five short fields is far below
 * that, and a breakdown that would exceed it is a breakdown nobody reads on screen: that is what the
 * XLSX export is for.
 */
export const REPORT_LINE_CAP = 1000;

/* -------------------------------------------------------------------------- */
/* Filters and scope                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The dimension filters, as equality predicates on the source columns.
 *
 * Written out rather than built with `filterClause` because of the sentinels. `?customerId=0` is a
 * legitimate request - it is what clicking the "(unassigned)" bar sends, because `dim_key` reports
 * an unset id as `0` - and it means "the jobs whose project has no customer". The underlying column
 * is NULL there, not 0, so the zero has to become `IS NULL` on the way in. `filterClause` has no
 * notion of that and would emit `customer_id = 0`, which matches nothing: the bar would be
 * clickable, return an empty report, and look like a quiet month.
 *
 * `IS NULL` rather than `COALESCE(column, 0) = :id` for both branches, because wrapping the column
 * puts an expression on the indexed side and gives up `ix_prj_cus` for the common case to tidy up
 * the rare one.
 *
 * The one thing this conflates is a real id of 0. `GENERATED BY DEFAULT AS IDENTITY` starts at 1,
 * so one can only exist if the ETL inserted it explicitly - and the rollup conflated them too.
 */
function dimensionFilters(query: ReportQuery): SqlClause {
  const parts: string[] = [];
  const parameters: SqlParameter[] = [];
  const add = (column: string, name: string, value: string | undefined): void => {
    if (value === undefined) return;
    // `IdSchema` is `^\d{1,19}$`, so "0" can also arrive as "00" - match on the value, not the text.
    if (/^0+$/.test(value)) {
      parts.push(`AND ${column} IS NULL`);
      return;
    }
    parts.push(`AND ${column} = :${name}`);
    parameters.push(param(name, value, "id"));
  };
  add("p.customer_id", "f_customer_id", query.customerId);
  add("j.job_pm_id", "f_pm_id", query.pmId);
  add("p.prj_mgr_id", "f_sales_mgr_id", query.salesManagerId);
  add("p.corp_id", "f_corp_id", query.corpId);
  return { fragment: parts.join("\n      "), parameters };
}

/**
 * Row-level scope on the reports, and this is the one that matters most.
 *
 * A reporting endpoint with the scope predicate left off is how row-level access control is
 * actually defeated in practice: the list screens are locked down, nobody thinks of the report, and
 * company-wide margin becomes readable by anyone who can open it. The menu check is NOT a
 * substitute. REPORT is a separate menu from PROJECT for exactly this reason - holding it means
 * "may see reports", and this predicate decides "of whose work".
 *
 * All three ownership columns, identical to `JOB_SCOPE_COLUMNS` in NeotmsJob.dbops.ts, and the
 * match is the point: a report is an aggregate of jobs, so it must be visible over exactly the jobs
 * its reader can list. The rollup could not do this. It carried `pm_id` and `sales_mgr_id` and had
 * no column for the project's own PM, so `prj_pm_id` was simply missing from the predicate - and a
 * project PM who was neither the job's PM nor the sales manager could open every job in their
 * project on the job screen and then read zero revenue for it on the report. Aggregating live means
 * the real columns are in scope and the two screens finally agree.
 *
 * Written out rather than imported from NeotmsJob.dbops.ts, because the two lists are equal by
 * REQUIREMENT, not by definition: a job list column that turned out not to be a reporting dimension
 * would want to stay out of here. A test asserts they are equal, so the day they should differ is a
 * deliberate decision with a failing test to record it, rather than an import somebody widened
 * without noticing which screen they had just changed.
 */
export const REPORT_SCOPE_COLUMNS = ["j.job_pm_id", "p.prj_mgr_id", "p.prj_pm_id"];

/**
 * The range, the filters and the scope, as one clause.
 *
 * The range is on `j.job_eday` - the business date, see the module header - and both ends are
 * required by `ReportQuerySchema`, which is what keeps this an index scan on `ix_job_eday` rather
 * than the full-history aggregation the legacy report does.
 */
const reportWhere = (caller: NeotmsCaller, query: ReportQuery): SqlClause =>
  mergeClauses(
    rangeClause("range", "j.job_eday", query.from, query.to),
    dimensionFilters(query),
    scopeClause(caller, REPORT_SCOPE_COLUMNS),
  );

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One breakdown of revenue, cost and margin.
 *
 * `HAVING` is deliberately absent. A line with revenue and no cost is real and must be kept - it is
 * a job that has been sold but not yet subcontracted, and dropping it would overstate margin. A
 * line with cost and no revenue is real too, and more interesting: it is work paid for against a
 * job priced at nothing, which is either a data-entry error or a loss, and both want to be seen.
 *
 * Two nested queries rather than one, because the limit has to cut on one ordering and the result
 * has to arrive in another. The inner query aggregates and keeps the rows that matter (`pickBy`);
 * the outer one only re-sorts what survived (`displayBy`). For the six revenue dimensions the two
 * orderings are the same string and the outer sort is a no-op on at most thirty rows - the cost of
 * the wrapper is nothing. For the time series they are opposites, and the wrapper is the whole
 * point: "the last 10 days" must be picked newest-first and then read oldest-first.
 *
 * Doing it in one query is not possible. `ORDER BY ... LIMIT` is evaluated as a unit, so a single
 * statement can only express one of the two orderings, and picking the display one silently returns
 * the wrong *rows* rather than the right rows in the wrong order. Sorting in TypeScript after the
 * fact would work for display but cannot fix the selection - the wrong ten rows have already left
 * the database.
 *
 * `LIMIT` is interpolated rather than bound as a parameter. That is safe here because the value has
 * been through `ReportTopNSchema` (digits only, 1..30) or is the integer literal `REPORT_LINE_CAP`;
 * nothing else can reach this line. It is interpolated because binding it would make the planner
 * choose a plan without knowing the row count, which for a top-N over an aggregate is exactly the
 * information that decides between a sort and a bounded heap sort.
 */
export const ReportBreakdownOps: (
  caller: NeotmsCaller,
  query: ReportQuery,
) => SqlOps<ReportLine[]> = (caller, query) => {
  const dimension: Dimension = REPORT_DIMENSIONS[query.groupBy];
  const where = reportWhere(caller, query);
  const lineLimit = Math.min(query.limit ?? REPORT_LINE_CAP, REPORT_LINE_CAP);
  return {
    sql: `
      SELECT picked.dim_key, picked.dim_label, picked.revenue, picked.cost, picked.margin
        FROM (
              SELECT ${dimension.key}   AS dim_key,
                     ${dimension.label} AS dim_label,
              ${REPORT_MEASURES}
              ${REPORT_FROM}
                ${dimension.join}
               WHERE j.deleted = false
              ${where.fragment}
               GROUP BY ${dimension.key}, ${dimension.label}
               ORDER BY ${dimension.pickBy}
               LIMIT ${String(lineLimit)}
             ) picked
       ORDER BY ${dimension.displayBy}
    `,
    parameters: where.parameters,
    mapper: (rows) => rows.map(toReportLine),
  };
};

/**
 * The totals for the same range and filters, independent of the breakdown.
 *
 * A separate query rather than a sum of the returned lines, because the lines are capped: adding up
 * a truncated list would produce a grand total quietly smaller than the real one, which is the worst
 * kind of wrong number - plausible, and off by an amount nobody can account for.
 *
 * No `dimension.join`, because there is no dimension: the label joins exist to print a name and
 * nothing here is grouped. Leaving them out is not just tidiness - a label join is the one place a
 * fan-out could creep in, and omitting it makes this query's total structurally incapable of
 * disagreeing with itself.
 */
export const ReportTotalsOps: (
  caller: NeotmsCaller,
  query: ReportQuery,
) => SqlOps<ReportTotals> = (caller, query) => {
  const where = reportWhere(caller, query);
  return {
    sql: `
      SELECT
      ${REPORT_MEASURES},
             count(*) AS row_count
      ${REPORT_FROM}
       WHERE j.deleted = false
      ${where.fragment}
    `,
    parameters: where.parameters,
    mapper: (rows) => ({
      revenue: readMoney(rows[0] ?? {}, "revenue") ?? "0",
      cost: readMoney(rows[0] ?? {}, "cost") ?? "0",
      margin: readMoney(rows[0] ?? {}, "margin") ?? "0",
      rows: Number(rows[0]?.["row_count"] ?? 0),
    }),
  };
};

export type WorkloadCounts = {
  /** Jobs whose delivery date falls in the window. */
  jobsDue: number;
  /** Purchase orders whose translator deadline falls in the window. */
  posDue: number;
  /** Jobs due in the window with no purchase order yet: work sold but not subcontracted. */
  jobsWithoutPo: number;
};

/**
 * The dashboard's workload counters, for a date window.
 *
 * ## Why there is no "overdue" or "in progress" counter here
 *
 * Both would need the `job_state` vocabulary, and the legacy state values are UNCONFIRMED - the
 * column is free text and the code set has not been profiled. A counter built on a guessed literal
 * ('DONE', 'COMPLETE', '완료') does not fail; it silently reads zero, and a dashboard tile that
 * always shows zero is read as good news. So these three counters are defined purely by dates,
 * which need no vocabulary, and the state-based tiles wait until the real values are known.
 *
 * `jobsWithoutPo` is the one worth watching: a job due this week with nothing subcontracted is
 * either work about to be done in-house or work nobody has started, and both are things a PM wants
 * to be asked about.
 *
 * These are counts of upcoming work rather than money, so they do not share `REPORT_FROM`: there is
 * no cost to collapse, and `NOT EXISTS` answers "has no PO" more directly than a sum would.
 */
export const WorkloadCountsOps: (
  caller: NeotmsCaller,
  from: string,
  to: string,
) => SqlOps<WorkloadCounts> = (caller, from, to) => {
  const scope = scopeClause(caller, REPORT_SCOPE_COLUMNS);
  return {
    sql: `
      SELECT
        count(*) FILTER (WHERE j.job_eday BETWEEN :from AND :to) AS jobs_due,
        count(*) FILTER (
          WHERE j.job_eday BETWEEN :from AND :to
            AND NOT EXISTS (SELECT 1
                              FROM purchase_order po
                             WHERE po.job_id = j.id
                               AND po.deleted = false)
        ) AS jobs_without_po,
        COALESCE(sum((SELECT count(*)
                        FROM purchase_order po
                       WHERE po.job_id = j.id
                         AND po.deleted = false
                         AND po.po_eday BETWEEN :from AND :to)), 0) AS pos_due
        FROM job j
        JOIN project p ON p.id = j.project_id AND p.deleted = false
       WHERE j.deleted = false
      ${scope.fragment}
    `,
    parameters: [
      param("from", from, "date"),
      param("to", to, "date"),
      ...scope.parameters,
    ],
    mapper: (rows) => ({
      jobsDue: Number(rows[0]?.["jobs_due"] ?? 0),
      posDue: Number(rows[0]?.["pos_due"] ?? 0),
      jobsWithoutPo: Number(rows[0]?.["jobs_without_po"] ?? 0),
    }),
  };
};
