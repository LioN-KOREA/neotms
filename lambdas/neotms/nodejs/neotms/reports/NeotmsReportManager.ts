// SPDX-License-Identifier: MIT
//
// Report endpoints.
//
// The report parameters arrive as query parameters rather than a body - a report is a GET, so it can
// be bookmarked and shared - but they are validated with the same valibot schema a body would be.
// `ReportQuerySchema` requires both ends of the date range, and this is where that requirement is
// enforced: an unbounded report is the legacy system's slowest screen, and the rollup only helps
// when the range is bounded.

import { rdsQuery } from "../../utils/RdsDataUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { ok, parseBody, runDb } from "../NeotmsResult.js";
import { ReportQuerySchema, type ReportQuery } from "../neotms.schemas.js";
import {
  REPORT_LINE_CAP,
  ReportBreakdownOps,
  ReportFreshnessOps,
  ReportTotalsOps,
  WorkloadCountsOps,
  type ReportLine,
  type ReportTotals,
  type WorkloadCounts,
} from "./NeotmsReport.dbops.js";

export type ReportResult = {
  query: ReportQuery;
  totals: ReportTotals;
  lines: ReportLine[];
  /**
   * True when the breakdown hit `REPORT_LINE_CAP`.
   *
   * Reported rather than silently truncated. A client that shows a table and a grand total needs to
   * know the table is incomplete, because the totals come from a separate unbounded query and would
   * otherwise not add up - and "the numbers do not add up" destroys trust in a report far faster
   * than "showing the top 1000, export for the rest".
   */
  truncated: boolean;
  /** When the rollup was last rebuilt. Shown so a stale report is visibly stale. */
  computedAt: string | null;
};

/**
 * Run a report.
 *
 * Three queries, deliberately: the breakdown, the unbounded totals, and the freshness stamp. The
 * totals are not a sum of the breakdown because the breakdown is capped - see `truncated` - and the
 * freshness stamp is one row from an aggregate nobody filters.
 */
export async function runReport(
  caller: NeotmsCaller,
  request: RequestData,
): Promise<ResponseData<ReportResult | string>> {
  const parsed = parseBody(ReportQuerySchema, {
    from: request.queryParams["from"],
    to: request.queryParams["to"],
    groupBy: request.queryParams["groupBy"],
    customerId: request.queryParams["customerId"],
    pmId: request.queryParams["pmId"],
    salesManagerId: request.queryParams["salesManagerId"],
    corpId: request.queryParams["corpId"],
  });
  if (!parsed.ok) return parsed.response;
  const query = parsed.value;

  if (query.from > query.to) {
    // Both are `YYYY-MM-DD`, so a lexical comparison is a chronological one. Caught here rather
    // than left to return an empty report, which reads as "no work that quarter".
    return { status: 400, body: "The start of the range must not be after its end" };
  }

  return runDb("run report", async () => {
    const lines = (await rdsQuery(ReportBreakdownOps(caller, query))).data;
    const totals = (await rdsQuery(ReportTotalsOps(caller, query))).data;
    const computedAt = (await rdsQuery(ReportFreshnessOps())).data;
    return ok({
      query,
      totals,
      lines,
      truncated: lines.length >= REPORT_LINE_CAP,
      computedAt,
    });
  });
}

/**
 * The dashboard's workload counters.
 *
 * Defaults to the next seven days when no range is given, because that is the window the question
 * "what is coming" means on a Monday morning. The range is still validated, so a client may ask for
 * a different one.
 */
export async function getWorkload(
  caller: NeotmsCaller,
  request: RequestData,
): Promise<ResponseData<WorkloadCounts | string>> {
  const today = new Date();
  const plusDays = (days: number): string => {
    const date = new Date(today.getTime() + days * 86_400_000);
    return date.toISOString().slice(0, 10);
  };
  const from = request.queryParams["from"] ?? plusDays(0);
  const to = request.queryParams["to"] ?? plusDays(7);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { status: 400, body: "The range must be given as two YYYY-MM-DD dates" };
  }
  return runDb("workload counts", async () => {
    const counts = (await rdsQuery(WorkloadCountsOps(caller, from, to))).data;
    return ok(counts);
  });
}
