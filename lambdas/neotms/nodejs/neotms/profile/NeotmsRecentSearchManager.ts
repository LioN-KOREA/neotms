// SPDX-License-Identifier: MIT
//
// Recent searches: read your own, record one, forget one.
//
// Three endpoints, all on the caller's own rows. The caller is never a parameter the client can
// influence - it comes from the guard - so there is no request shape that reads somebody else's
// searches, and none that needs checking for one.
//
// ## Why a failed write is not an error the user sees
//
// Recording a search is a side effect of searching. If it fails, the search itself still worked
// and the only consequence is that one term is missing from a suggestion list - so a 500 here
// would turn a working search into a visible failure, which is a worse outcome than the lost row.
// `recordSearch` therefore answers 204 either way and logs the failure. That is the opposite of
// how every other write in this codebase behaves, which is why it is argued rather than assumed.

import { pgExecute, pgQuery, pgTransaction } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { ok, runDb } from "../NeotmsResult.js";
import type { RecentSearchForget, RecentSearchRecord } from "../neotms.schemas.js";
import {
  RecentSearchForgetOps,
  RecentSearchListOps,
  RecentSearchPruneOps,
  RecentSearchRecordOps,
  type RecentSearchRow,
} from "./NeotmsRecentSearch.dbops.js";

export type RecentSearchView = { items: RecentSearchRow[] };

/** Every scope's recent terms for the caller. */
export async function listRecentSearches(
  caller: NeotmsCaller,
): Promise<ResponseData<RecentSearchView | string>> {
  return runDb("list recent searches", async () => {
    const items = (await pgQuery(RecentSearchListOps(caller.staffId))).data;
    return ok({ items });
  });
}

/**
 * Record one search for the caller, and prune that scope back to five.
 *
 * Two statements in one transaction, and the order is the point: the prune has to see the row the
 * record just wrote, or it keeps the previous five and leaves a sixth behind. Separate statements
 * within a transaction do see each other - a data-modifying CTE would not, which is the mistake
 * `RoleCreateOps` made.
 *
 * ## It answers 204 even when it fails
 *
 * The caller is a list screen that has already run the search the user asked for. A 500 here would
 * surface as an error on a screen where nothing the user wanted had failed, and the thing actually
 * lost is one row in a suggestion list. So the failure is logged and swallowed. Nothing downstream
 * depends on the row existing: the next read simply returns what is there.
 */
export async function recordSearch(
  caller: NeotmsCaller,
  input: RecentSearchRecord,
): Promise<ResponseData<string>> {
  const term = input.term.trim();
  /*
   * An empty term is not an error either. Submitting the search box with nothing in it is a normal
   * thing to do - it clears the filter - and there is nothing to record.
   */
  if (term.length === 0) return { status: 204, body: "" };

  try {
    await pgTransaction(async (client) => {
      await pgExecute(RecentSearchRecordOps(caller.staffId, input.scope, term), client);
      await pgExecute(RecentSearchPruneOps(caller.staffId, input.scope), client);
    });
  } catch (err) {
    console.warn(
      `Could not record the search ${JSON.stringify(term)} on ${input.scope} for ` +
        `${caller.mgrId}; the search itself was unaffected.`,
      err,
    );
  }

  /*
   * 204 and no body, whether or not the write landed. The client does not read a response - it
   * refetches the list of terms - so a body would be a payload nobody parses.
   */
  return { status: 204, body: "" };
}

/**
 * Forget one term, or a whole scope's worth.
 *
 * Unlike the record, this one reports failure. The user asked for the term to go, so "it is gone"
 * has to be true when the screen says so - a swallowed error here would leave the suggestion
 * sitting there after they removed it, and they would remove it again.
 */
export async function forgetSearch(
  caller: NeotmsCaller,
  input: RecentSearchForget,
): Promise<ResponseData<{ forgotten: number } | string>> {
  return runDb("forget recent search", async () => {
    const term = input.term?.trim() || null;
    const forgotten = (await pgExecute(RecentSearchForgetOps(caller.staffId, input.scope, term)))
      .data;
    return ok({ forgotten });
  });
}
