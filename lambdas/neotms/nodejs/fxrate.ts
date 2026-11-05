// SPDX-License-Identifier: MIT
//
// Entry point for the scheduled rate fetcher.
//
// The SECOND Lambda in this project, and the only one. `NeotmsApi`'s header explains at length why
// the API is one function serving every route; this is not a counter-example to that argument, it is
// a different kind of thing:
//
//   * It has no caller. EventBridge invokes it on a schedule, so there is no request to route, no
//     session to verify and no row-level scope to apply - the three things the monolith's shared
//     machinery exists for.
//   * Its failure must not be the API's failure. A public-sector endpoint that hangs for ten seconds
//     would otherwise consume one of the API function's twenty reserved concurrent executions
//     (`reservedConcurrentExecutions` in NeotmsApi), every five minutes, forever.
//   * Its permissions differ. This function needs `secretsmanager:GetSecretValue` on the KEXIM key
//     and nothing else new; the API function must NOT hold that grant, because nothing it serves
//     needs the key.
//   * Its log group answers a different question. "Did the rate update today" is a question about
//     this schedule, and mixing it into the API's log group would mean searching through every
//     request to find out.
//
// It shares the source tree with the API rather than living under its own `lambdas/` directory,
// which is what lets it import `FxRateUpsertManyOps` and the Postgres pool directly - one dbops
// module, one connection convention, one `tsc` gate. esbuild bundles per entry point, so the two
// functions are still separate artifacts with nothing of each other's code in them.
//
// Nothing here has a retry or a dead-letter queue, deliberately. The next run is five minutes away
// and will do exactly the same work; a retry would only make the failure cost two API calls instead
// of one.

import type { Context } from "aws-lambda";
import { fetchFxRates, type FxFetchOutcome } from "./neotms/fx/NeotmsFxFetcher.js";

/**
 * Invoked by EventBridge; the event is ignored.
 *
 * Returns the outcome rather than nothing, so that `aws lambda invoke` is a usable way to ask "what
 * would happen right now" during a deployment - the one-line answer comes back in the response
 * payload instead of having to be read out of CloudWatch.
 *
 * Every upstream problem is handled inside `fetchFxRates` and arrives here as an outcome with
 * `written: 0` and a sentence saying why. So this catch is for the genuine faults - an unreachable
 * database, a refused secret - and it RETHROWS after logging, which is the opposite of what the API
 * entry point does. The reason for the difference: a caller waiting on an HTTP response must be told
 * something, whereas here a thrown error is the only way the invocation is recorded as a failure in
 * the function's error metric, and that metric is the only thing that will ever notice.
 */
export async function handler(_event: unknown, context: Context): Promise<FxFetchOutcome> {
  try {
    const outcome = await fetchFxRates();
    console.info(`[fxrate] ${outcome.note}`);
    return outcome;
  } catch (err) {
    console.error(`[fxrate] the run failed (${context.awsRequestId}) : ${String(err)}`);
    throw err;
  }
}
