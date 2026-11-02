// SPDX-License-Identifier: MIT
//
// Report endpoints.
//
// The report parameters arrive as query parameters rather than a body - a report is a GET, so it can
// be bookmarked and shared - but they are validated with the same valibot schema a body would be.
// `ReportQuerySchema` requires both ends of the date range, and this is where that requirement is
// enforced. The range is what makes live aggregation affordable: bounded, it is an index scan on
// `ix_job_eday`, which is why these figures can be computed per request instead of overnight.
// Unbounded, it is the legacy system's slowest screen rebuilt.

import { pgQuery } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { ok, parseBody, runDb } from "../NeotmsResult.js";
import { ReportQuerySchema, type ReportQuery } from "../neotms.schemas.js";
import {
  REPORT_LINE_CAP,
  ReportBreakdownOps,
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
   * True when the breakdown returned as many rows as it was allowed to - either the caller's own
   * `limit` or `REPORT_LINE_CAP`.
   *
   * Reported rather than silently truncated. A client that shows a table and a grand total needs to
   * know the table is incomplete, because the totals come from a separate unbounded query and would
   * otherwise not add up - and "the numbers do not add up" destroys trust in a report far faster
   * than "showing the top 1000, export for the rest".
   *
   * Note the one false positive this shape admits: a breakdown with exactly `limit` distinct values
   * reports `truncated: true` although nothing was left out. Learning otherwise costs a second
   * `count(DISTINCT ...)` query over the same range, and the consequence of the false positive is a
   * client that says "top 10 shown" when the top 10 happens to be all of them - true, if
   * uninformative. The opposite trade (no flag) hides real truncation, which is not recoverable by
   * the reader.
   */
  truncated: boolean;
  /**
   * When these figures were computed, which is now.
   *
   * Kept in the response even though the answer is always "this request". It used to report when the
   * nightly rollup last ran, because a pre-aggregated table is only trustworthy if the reader can
   * see how old it is - a batch that silently stopped three weeks ago otherwise looks exactly like a
   * quiet three weeks. The aggregation is live now, so there is nothing stale to warn about; the
   * stamp stays because "as of 14:32" is what tells a manager the report already includes the
   * delivery they booked at lunchtime, which is the entire reason this stopped being a batch.
   *
   * The Lambda's clock, not `now()` from the database. Those agree to within the round trip, and
   * spending a third query on the difference would be paying for precision nobody reads.
   */
  computedAt: string | null;
};

/**
 * Run a report.
 *
 * Two queries, deliberately: the breakdown and the unbounded totals. The totals are not a sum of
 * the breakdown because the breakdown is capped - see `truncated`.
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
    limit: request.queryParams["limit"],
  });
  if (!parsed.ok) return parsed.response;
  const query = parsed.value;

  if (query.from > query.to) {
    // Both are `YYYY-MM-DD`, so a lexical comparison is a chronological one. Caught here rather
    // than left to return an empty report, which reads as "no work that quarter".
    return { status: 400, body: "The start of the range must not be after its end" };
  }

  return runDb("run report", async () => {
    const lines = (await pgQuery(ReportBreakdownOps(caller, query))).data;
    const totals = (await pgQuery(ReportTotalsOps(caller, query))).data;
    const computedAt = new Date().toISOString();
    return ok({
      query,
      totals,
      lines,
      // Compared against whichever ceiling actually applied. Leaving this at `REPORT_LINE_CAP`
      // after adding `limit` would have made the flag permanently false for every screen request -
      // ten lines is not a thousand - so a top-10 of two hundred customers would have claimed to be
      // the whole picture, with a grand total five times the sum of the bars.
      truncated: lines.length >= Math.min(query.limit ?? REPORT_LINE_CAP, REPORT_LINE_CAP),
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
    const counts = (await pgQuery(WorkloadCountsOps(caller, from, to))).data;
    return ok(counts);
  });
}
