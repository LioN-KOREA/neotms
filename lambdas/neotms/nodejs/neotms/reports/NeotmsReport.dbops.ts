// SPDX-License-Identifier: MIT
//
// The reports, read from `report_daily_rollup`.
//
// Nothing here aggregates `job` or `purchase_order` directly, and that is the entire point of the
// rollup. The legacy yearly report aggregates the full history on every page view, converting
// nvarchar amounts per row, and it is the slowest screen in the system. These queries read a
// pre-aggregated table over a bounded date range, which is an index scan on the composite primary
// key.
//
// ## Margin is derived, never stored
//
// `revenue - cost`, computed in SQL, in every query in this file. The rollup deliberately does not
// store a margin column so that there is exactly one definition of it - a stored margin that
// disagreed with its own revenue and cost would be unanswerable.
//
// ## The sentinels are translated, not joined
//
// Every dimension column is NOT NULL with a sentinel (0 for ids, '' for text), because NULLs in a
// composite primary key never match `ON CONFLICT` and the nightly recompute would insert duplicates
// forever. The consequence for reads is that `customer_id = 0` means "unset", not "customer 0". The
// label joins here are LEFT joins and the sentinel falls through to "(unassigned)" - which is why
// they are LEFT and not INNER.

import {
  param,
  readMoney,
  readText,
  type SqlOps,
  type SqlParameter,
  type SqlRow,
} from "../../utils/RdsDataUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import { mergeClauses, rangeClause, scopeClause, type SqlClause } from "../NeotmsQuery.js";
import type { ReportQuery } from "../neotms.schemas.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type ReportLine = {
  /** The dimension value: a date, an id, or a language pair. '0' / '' mean unassigned. */
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
  /** How many rollup rows were summed. A freshness/sanity signal, not a business figure. */
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
/* Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One way to break the totals down.
 *
 * `key` and `label` are interpolated into the SQL, and `join` more so - so this map is an
 * allow-list in the strict sense. `ReportQuerySchema.groupBy` is a valibot `picklist`, so a request
 * can only name one of these seven; the object is keyed by those same names and nothing else
 * reaches here.
 *
 * `label` is cast to text in every case because the column it comes from varies - a date, a bigint
 * id, a code string - and a single result shape is worth more to the client than preserving three
 * types across one field.
 */
type Dimension = {
  /** The grouping key expression. */
  key: string;
  /** The display label expression, with the sentinel already resolved. */
  label: string;
  /** The LEFT JOIN the label needs, if any. */
  join: string;
  /** Default ordering: a time series reads chronologically, a breakdown reads largest-first. */
  orderBy: string;
};

const unassigned = (expression: string): string =>
  `COALESCE(NULLIF(${expression}, ''), '(unassigned)')`;

const REPORT_DIMENSIONS = {
  date: {
    key: "r.business_date::text",
    label: "r.business_date::text",
    join: "",
    orderBy: "r.business_date ASC",
  },
  customer: {
    key: "r.customer_id::text",
    label: unassigned("cu.cus_name"),
    join: "LEFT JOIN customer cu ON cu.id = r.customer_id",
    orderBy: "revenue DESC",
  },
  pm: {
    key: "r.pm_id::text",
    label: unassigned("spm.mgr_name"),
    join: "LEFT JOIN staff spm ON spm.id = r.pm_id",
    orderBy: "revenue DESC",
  },
  salesManager: {
    key: "r.sales_mgr_id::text",
    label: unassigned("ssm.mgr_name"),
    join: "LEFT JOIN staff ssm ON ssm.id = r.sales_mgr_id",
    orderBy: "revenue DESC",
  },
  corp: {
    key: "r.corp_id::text",
    label: unassigned("co.corp_name"),
    join: "LEFT JOIN corp co ON co.id = r.corp_id",
    orderBy: "revenue DESC",
  },
  category: {
    key: "r.category_id::text",
    label: unassigned("sc.code_name"),
    join: "LEFT JOIN sys_code sc ON sc.id = r.category_id",
    orderBy: "revenue DESC",
  },
  /*
   * The one composite dimension. Both halves are already code strings on the rollup row - the DDL
   * keeps them as codes rather than ids precisely so this reads without a join - so the pair is
   * concatenated for the key and the label alike. A missing half shows as the sentinel's empty
   * string, which `unassigned` cannot catch inside a concatenation; hence the NULLIF on each half.
   */
  langPair: {
    key: "(COALESCE(NULLIF(r.slang, ''), '?') || ' > ' || COALESCE(NULLIF(r.elang, ''), '?'))",
    label: "(COALESCE(NULLIF(r.slang, ''), '?') || ' > ' || COALESCE(NULLIF(r.elang, ''), '?'))",
    join: "",
    orderBy: "revenue DESC",
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
 * The dimension filters, as equality predicates on the rollup's own columns.
 *
 * Written out rather than built with `filterClause` because of the sentinels: `?customerId=0` is a
 * legitimate request meaning "the rows with no customer", so an id of "0" must be kept where
 * `filterClause` would treat any value as a filter and the empty string as none. The behaviour is
 * the same; the distinction is that here "0" has meaning.
 */
function dimensionFilters(query: ReportQuery): SqlClause {
  const parts: string[] = [];
  const parameters: SqlParameter[] = [];
  const add = (column: string, name: string, value: string | undefined): void => {
    if (value === undefined) return;
    parts.push(`AND ${column} = :${name}`);
    parameters.push(param(name, value, "id"));
  };
  add("r.customer_id", "f_customer_id", query.customerId);
  add("r.pm_id", "f_pm_id", query.pmId);
  add("r.sales_mgr_id", "f_sales_mgr_id", query.salesManagerId);
  add("r.corp_id", "f_corp_id", query.corpId);
  return { fragment: parts.join("\n      "), parameters };
}

/**
 * Row-level scope on the reports, and this is the one that matters most.
 *
 * A reporting endpoint with the scope predicate left off is how row-level access control is
 * actually defeated in practice: the list screens are locked down, nobody thinks of the report, and
 * company-wide margin becomes readable by anyone who can open it. The rollup carries `pm_id` and
 * `sales_mgr_id`, which are the same `staff.id` values the project and job scopes use, so the same
 * rule applies here unchanged.
 *
 * The menu check is NOT a substitute. REPORT is a separate menu from PROJECT for exactly this
 * reason - holding it means "may see reports", and this predicate decides "of whose work".
 */
const REPORT_SCOPE_COLUMNS = ["r.pm_id", "r.sales_mgr_id"];

const reportWhere = (caller: NeotmsCaller, query: ReportQuery): SqlClause =>
  mergeClauses(
    rangeClause("range", "r.business_date", query.from, query.to),
    dimensionFilters(query),
    scopeClause(caller, REPORT_SCOPE_COLUMNS),
  );

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One breakdown of revenue, cost and margin.
 *
 * `HAVING` is deliberately absent: a dimension value with zero revenue and zero cost would not
 * produce a rollup row at all, so there is nothing to filter out. A line with revenue and no cost
 * is real and must be kept - it is a job that has been sold but not yet subcontracted, and dropping
 * it would overstate margin.
 */
export const ReportBreakdownOps: (
  caller: NeotmsCaller,
  query: ReportQuery,
) => SqlOps<ReportLine[]> = (caller, query) => {
  const dimension: Dimension = REPORT_DIMENSIONS[query.groupBy];
  const where = reportWhere(caller, query);
  return {
    sql: `
      SELECT ${dimension.key}   AS dim_key,
             ${dimension.label} AS dim_label,
             sum(r.revenue)                  AS revenue,
             sum(r.cost)                     AS cost,
             sum(r.revenue) - sum(r.cost)    AS margin
        FROM report_daily_rollup r
        ${dimension.join}
       WHERE true
      ${where.fragment}
       GROUP BY ${dimension.key}, ${dimension.label}
       ORDER BY ${dimension.orderBy}
       LIMIT ${REPORT_LINE_CAP}
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
 */
export const ReportTotalsOps: (
  caller: NeotmsCaller,
  query: ReportQuery,
) => SqlOps<ReportTotals> = (caller, query) => {
  const where = reportWhere(caller, query);
  return {
    sql: `
      SELECT COALESCE(sum(r.revenue), 0)                      AS revenue,
             COALESCE(sum(r.cost), 0)                         AS cost,
             COALESCE(sum(r.revenue), 0) - COALESCE(sum(r.cost), 0) AS margin,
             count(*)                                         AS row_count
        FROM report_daily_rollup r
       WHERE true
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

/**
 * When the rollup was last rebuilt.
 *
 * Shown on the report screens, because a pre-aggregated table is only trustworthy if the reader can
 * see how old it is. A nightly job that silently stopped three weeks ago otherwise looks exactly
 * like a quiet three weeks.
 */
export const ReportFreshnessOps: () => SqlOps<string | null> = () => ({
  sql: `SELECT max(r.computed_at) AS computed_at FROM report_daily_rollup r`,
  parameters: [],
  mapper: (rows) => (rows.length > 0 ? readText(rows[0]!, "computed_at") : null),
});

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
 * Read from `job` and `purchase_order` rather than from the rollup, which is not an inconsistency:
 * the rollup is organised around money and skips any job with no delivery date, while these are
 * counts of upcoming work.
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
 */
export const WorkloadCountsOps: (
  caller: NeotmsCaller,
  from: string,
  to: string,
) => SqlOps<WorkloadCounts> = (caller, from, to) => {
  const scope = scopeClause(caller, ["j.job_pm_id", "p.prj_mgr_id", "p.prj_pm_id"]);
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
