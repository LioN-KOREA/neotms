// SPDX-License-Identifier: MIT
//
// `GET /api/v0/fx-rates` - the current rate table, for the console's conversion button.
//
// One endpoint, one statement, no caller. See NeotmsFxRate.dbops.ts for why the client needs the
// rate at all when every reported figure is converted server-side.
//
// ## `anyStaff`, for the same reason `/codes` is
//
// Two routes in this application carry `anyStaff`, and both are things a form cannot render without.
// A PM with the right to create a job must be able to price it in USD; gating the rate on a menu
// right would leave them looking at a 원화로 환산 button that always fails. An exchange rate is also
// not company information - it is published daily by a state bank - so there is nothing here to
// protect that is not already public.
//
// ## Why this is not folded into `GET /api/v0/codes`
//
// Tempting, because the two have the same audience and the job form fetches both. But a code is
// edited by hand perhaps twice a year and a rate changes every business day, so the client caches
// them for very different lengths of time: merging them would force the long-lived list to be
// re-fetched on the short-lived one's schedule, or the short-lived one to go stale on the long one's.
// They are also sourced differently - `sys_code` is the company's own taxonomy, `fx_rate` is an
// upstream feed that can be hours behind - and a single response could not carry the one thing that
// difference requires, which is a per-row `effectiveDate` the console can show.

import { pgQuery } from "../../utils/PostgresUtils.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { ok, runDb } from "../NeotmsResult.js";
import { FxRateLatestOps, type FxRateRow } from "./NeotmsFxRate.dbops.js";

/**
 * The response shape.
 *
 * `{ items }`, like every other listing here, rather than a bare array or a currency-keyed object.
 * A keyed object reads more conveniently on the client but it cannot carry an empty result
 * distinguishably - `{}` and "the fetcher has never run" look identical - and the client has to
 * handle that case explicitly, because it is the state the system is in on day one.
 */
export type FxRateListView = { items: FxRateRow[] };

/**
 * Every currency's newest quote.
 *
 * AN EMPTY LIST IS A VALID ANSWER, not an error, and the client must treat it as one. Before the
 * scheduled fetcher's first successful run `fx_rate` is empty; a currency the fetcher does not
 * collect is permanently absent. In both cases the console's response is to disable the conversion
 * button for that currency rather than to show an error - the user can still record the amount in
 * its original currency, which is precisely what the open/settled model is for. See
 * db/014_fx_rates.sql.
 */
export async function listFxRates(): Promise<ResponseData<FxRateListView | string>> {
  return runDb("list fx rates", async () => {
    const items = (await pgQuery(FxRateLatestOps())).data;
    return ok({ items });
  });
}
