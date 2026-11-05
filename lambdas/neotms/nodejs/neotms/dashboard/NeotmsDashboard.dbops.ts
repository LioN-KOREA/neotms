// SPDX-License-Identifier: MIT
//
// 대시보드 - "how are MY projects doing", in one query.
//
// Two dashboards, 영업 and PM, differing in exactly one thing: which column on `project` means
// "mine". 영업 reads `prj_mgr_id` (the sales manager who sold the work), PM reads `prj_pm_id` (the
// project manager running it). Everything else - the three state tiles, the three money figures - is
// the same aggregate over whichever set that selects, which is why this is one ops and not two.
//
// ## Why this is not a report with a filter
//
// The reports could almost answer this and the "almost" is the whole problem. Three mismatches, each
// of which would make the dashboard quietly wrong rather than unavailable:
//
//   1. **The report's `pmId` filter is `j.job_pm_id`, the JOB's PM, not the project's.** Those
//      legitimately differ - db/002_tables.sql says so on the column - so filtering the report by
//      `pmId` answers "the jobs I personally run", not "my projects". A project PM who delegates
//      every job would read zero.
//   2. **`ReportQuerySchema` requires both ends of a date range**, and the question here has none.
//      Picking a range for the user ("this month") would silently answer a different question, and
//      the figure a manager compares against their target is their book, not a month of it.
//   3. **Revenue and cost would be scoped by `REPORT_SCOPE_COLUMNS`,** which ORs three ownership
//      columns together. That is correct for a report - it must show exactly the jobs its reader can
//      list - but it is wider than "my projects" and would fold in jobs from other people's
//      projects where the reader happens to be the job PM.
//
// ## Unbounded by date, bounded by ownership
//
// The money here covers every one of the caller's non-deleted projects, with no date range. That is
// a deliberate difference from the reports, where the range is what keeps live aggregation
// affordable, and it is affordable here for a different reason: the set is bounded by
// `prj_mgr_id = me` / `prj_pm_id = me` on `ix_prj_mgr` / `ix_prj_pm` instead - one person's book,
// not the company's history. The client labels the figure 전체 so that an all-time total reads as a
// deliberate all-time total.
//
// ## One row per project, twice over
//
// Revenue is on the job and cost is on the PO, and a project has many of each. Joining both would
// multiply every job's revenue by the project's PO count, which - as NeotmsReport.dbops.ts puts it -
// does not look wrong, it just overstates income. So each side is collapsed in its own
// `LEFT JOIN LATERAL` with no `GROUP BY`, which returns exactly one row and therefore cannot
// duplicate or drop a project. It is the same shape `ProjectTotalsOps` uses for a single project,
// widened from one id to a set.

import { param, readMoney, type SqlOps, type SqlParameter } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import { JOB_KRW, JOB_KRW_JOIN, PO_KRW, PO_KRW_JOIN } from "../NeotmsMoney.js";
import { scopeClause } from "../NeotmsQuery.js";
import {
  PROJECT_STATES,
  PROJECT_STATES_CLOSED,
  PROJECT_STATE_ACTIVE,
  PROJECT_STATE_HOLD,
} from "../NeotmsProjectStates.js";

/* -------------------------------------------------------------------------- */
/* Which column means "mine"                                                  */
/* -------------------------------------------------------------------------- */

/** 영업 or PM. The only axis on which the two dashboards differ. */
export type DashboardRole = "sales" | "pm";

/**
 * The roles, enumerated.
 *
 * Nothing on the request path reads this any more - each route passes its own literal, so the type
 * checker is what keeps a stray value out (see NeotmsDashboardManager.ts's header). It stays
 * exported because it is the list `OWNER_COLUMN` is checked against in the suite, and because
 * whoever adds a third dashboard will add it here first and should find the record waiting.
 */
export const DASHBOARD_ROLES: readonly DashboardRole[] = ["sales", "pm"];

/**
 * The ownership column each dashboard reads.
 *
 * Interpolated into SQL text, so it is returned from this closed record rather than built from the
 * request - the same rule `jobDetailTable` follows in NeotmsJobTypes.ts. The role arrives as a
 * `DashboardRole` from its own route rather than as request text, so there is no path by which a
 * request string becomes a column name; this record keeps that true even if one appears.
 */
const OWNER_COLUMN: Record<DashboardRole, string> = {
  sales: "p.prj_mgr_id",
  pm: "p.prj_pm_id",
};

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type DashboardSummary = {
  /** Echoed back, so a client holding two cached responses can tell them apart. */
  role: DashboardRole;
  /** Every non-deleted project of mine. The denominator the three tiles are read against. */
  projects: number;
  /** 진행 - live work. */
  inProgress: number;
  /**
   * Past its due date and not yet 완료/취소.
   *
   * **Overlaps the other two tiles**, and is meant to: a 진행 project whose date has passed is both
   * in progress and late, and a 보류 one that has passed its date is both parked and late. The three
   * numbers are three questions about the same set, not a partition of it, so they do not sum to
   * `projects` - and the client says so rather than letting a reader discover it by adding them up.
   */
  overdue: number;
  /** 보류 - parked. The legacy screen called this tile "Holding 프로젝트". */
  onHold: number;
  /**
   * Projects whose `prj_state` is not one of the five this build knows.
   *
   * The guard against the failure mode NeotmsProjectStates.ts was written for. A tile reading zero
   * because the production vocabulary differs from ours is indistinguishable from a tile reading
   * zero because there is nothing to count - unless this number is beside it.
   */
  unrecognisedState: number;
  /** Decimal strings. `numeric` arithmetic stays in PostgreSQL; see neotms.schemas. */
  revenue: string;
  cost: string;
  margin: string;
};

/* -------------------------------------------------------------------------- */
/* The read                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Today, as PostgreSQL sees it in Seoul.
 *
 * `CURRENT_DATE` would be the server's date, and the database runs in UTC: between midnight and
 * 09:00 KST it is still yesterday there. A project due yesterday would then be reported on time by
 * this query while the list screen beside it already paints the date red, because the client's
 * `isOverdue` splits the date in `Asia/Seoul` (frontend/src/shared/utils/format.ts). Nine hours a
 * day of the two screens disagreeing is not a rounding error; it is the overdue tile being wrong
 * every morning, which is precisely when somebody reads it.
 *
 * Computed in SQL rather than passed in from the Lambda clock so that there is one answer to "what
 * day is it" and it is the database's.
 */
const TODAY_KST = "(now() AT TIME ZONE 'Asia/Seoul')::date";

/**
 * The three tiles and the three figures, for one caller and one role.
 *
 * `scopeClause` is applied on top of the ownership filter even though the ownership filter already
 * pins one of `PROJECT_SCOPE_COLUMNS` to this caller, making it strictly redundant today. It stays
 * because the redundancy is cheap - the planner drops a predicate implied by an equality on the same
 * column - and because the day somebody widens the ownership filter (a team dashboard, a
 * "my department" view) the scope predicate is what keeps the widening from also widening who can
 * be read. A scope clause that was never there is not noticed at that moment.
 */
export const DashboardSummaryOps: (
  caller: NeotmsCaller,
  role: DashboardRole,
) => SqlOps<DashboardSummary> = (caller, role) => {
  const owner = OWNER_COLUMN[role];
  const scope = scopeClause(caller, ["p.prj_mgr_id", "p.prj_pm_id"]);

  /*
   * The vocabulary, bound one placeholder per value rather than interpolated.
   *
   * Korean literals in SQL text would work, but they are the one thing in this file that is
   * PROVISIONAL (see NeotmsProjectStates.ts), and binding them means the day they are corrected the
   * change is in one TypeScript array and no statement text moves.
   */
  const states: SqlParameter[] = [];
  const placeholder = (prefix: string, index: number, value: string): string => {
    const name = `${prefix}_${String(index)}`;
    states.push(param(name, value, "text"));
    return `:${name}`;
  };
  const knownList = PROJECT_STATES.map((s, i) => placeholder("st_known", i, s)).join(", ");
  const closedList = PROJECT_STATES_CLOSED.map((s, i) => placeholder("st_closed", i, s)).join(", ");

  return {
    sql: `
      SELECT
        count(*)                                                    AS projects,
        count(*) FILTER (WHERE p.prj_state = :st_active)            AS in_progress,
        count(*) FILTER (WHERE p.prj_state = :st_hold)              AS on_hold,
        count(*) FILTER (
          WHERE p.prj_eday IS NOT NULL
            AND p.prj_eday < ${TODAY_KST}
            AND COALESCE(p.prj_state, '') NOT IN (${closedList})
        )                                                           AS overdue,
        count(*) FILTER (
          WHERE p.prj_state IS NULL
             OR p.prj_state NOT IN (${knownList})
        )                                                           AS unrecognised_state,
        COALESCE(sum(rev.revenue), 0)                               AS revenue,
        COALESCE(sum(cst.cost), 0)                                  AS cost,
        COALESCE(sum(rev.revenue), 0) - COALESCE(sum(cst.cost), 0)  AS margin
        FROM project p
        LEFT JOIN LATERAL (
               SELECT sum(${JOB_KRW}) AS revenue
                 FROM job j
                 ${JOB_KRW_JOIN}
                WHERE j.project_id = p.id
                  AND j.deleted = false
             ) rev ON true
        LEFT JOIN LATERAL (
               SELECT sum(${PO_KRW}) AS cost
                 FROM purchase_order po
                 ${PO_KRW_JOIN}
                WHERE po.project_id = p.id
                  AND po.deleted = false
             ) cst ON true
       WHERE p.deleted = false
         AND ${owner} = :owner_staff_id
      ${scope.fragment}
    `,
    parameters: [
      param("owner_staff_id", caller.staffId, "id"),
      param("st_active", PROJECT_STATE_ACTIVE, "text"),
      param("st_hold", PROJECT_STATE_HOLD, "text"),
      ...states,
      ...scope.parameters,
    ],
    /*
     * `rows[0]` with a fallback, although an aggregate with no `GROUP BY` always returns one row. A
     * caller with no projects gets zeroes from `count(*)` and `COALESCE`, not an empty result - the
     * fallback is for the shape, not for that case.
     */
    mapper: (rows) => {
      const row = rows[0] ?? {};
      const count = (key: string): number => Number(row[key] ?? 0);
      return {
        role,
        projects: count("projects"),
        inProgress: count("in_progress"),
        overdue: count("overdue"),
        onHold: count("on_hold"),
        unrecognisedState: count("unrecognised_state"),
        revenue: readMoney(row, "revenue") ?? "0",
        cost: readMoney(row, "cost") ?? "0",
        margin: readMoney(row, "margin") ?? "0",
      };
    },
  };
};
