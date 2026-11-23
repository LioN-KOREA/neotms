// SPDX-License-Identifier: MIT
//
// `staff_recent_search` - the last few search terms each person used on each list screen.
//
// ## The only private table in the schema
//
// Every other table holds company data, narrowed by `staff.view_scope` to "rows I own" or "all
// rows". This one is narrowed by identity: a row belongs to one person, nobody else may read it,
// and there is no view scope that widens it. So every statement below takes `staffId` and puts it
// in the WHERE clause - there is no listing of everybody's searches, and no endpoint that could
// ask for one.
//
// That is also why the routes sit on `anyStaff` rather than behind a permission. Reading your own
// recent searches is not a privilege a role grants; it is something every signed-in person does on
// their own data, like `/api/v0/me`.
//
// ## Why five rows, enforced by the write rather than the read
//
// The read could simply `LIMIT 5` and let the table grow, and that would be correct but unbounded:
// a person who searches twenty times a day accumulates rows forever, for a feature that shows five.
// So the write prunes, and the read takes what is there. The two together mean the table's size is
// a function of the number of people and screens, not of how much anybody uses it.

import {
  param,
  readInt,
  readText,
  type SqlOps,
  type SqlRow,
} from "../../utils/PostgresUtils.js";

/** How many terms are kept, and offered, per person per screen. */
export const RECENT_SEARCH_LIMIT = 5;

export type RecentSearchRow = {
  scope: string;
  terms: string[];
};

/**
 * Every scope's recent terms for one person, newest first.
 *
 * One request returns all of them rather than one scope at a time. The alternative is a request
 * per list screen, and somebody moving between 프로젝트 and 작업 and PO in a minute would make
 * three - for a payload that is at most thirty-five short strings. It is also read once when the
 * shell loads and cached, so the common case is no request at all.
 *
 * `row_number()` rather than a lateral `LIMIT 5` per scope: the prune on write already keeps the
 * table at five, so this is belt and braces for the window between a write and its prune - and it
 * costs nothing, because the index is on exactly this ordering.
 */
export const RecentSearchListOps: (staffId: string) => SqlOps<RecentSearchRow[]> = (staffId) => ({
  sql: `
    SELECT scope,
           array_agg(term ORDER BY used_at DESC, id DESC) AS terms
      FROM (
        SELECT scope,
               term,
               used_at,
               id,
               row_number() OVER (PARTITION BY scope ORDER BY used_at DESC, id DESC) AS rank
          FROM staff_recent_search
         WHERE staff_id = :staff_id
      ) ranked
     WHERE rank <= ${String(RECENT_SEARCH_LIMIT)}
     GROUP BY scope
     ORDER BY scope
  `,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => rows.map(toRecentSearchRow),
});

const toRecentSearchRow = (row: SqlRow): RecentSearchRow => {
  const terms = row["terms"];
  return {
    scope: readText(row, "scope") ?? "",
    terms: Array.isArray(terms) ? terms.filter((t): t is string => typeof t === "string") : [],
  };
};

/**
 * Record one search, or move it back to the top if it has been used before.
 *
 * `ON CONFLICT ... DO UPDATE SET used_at = now()` is what makes repeating a search a reorder rather
 * than a duplicate - without it the five slots fill with one term somebody ran five times, which is
 * the opposite of useful.
 *
 * No `RETURNING` and no read-back. The caller does not need the row, and a CTE that joined
 * `staff_recent_search` back to its own INSERT would return nothing anyway: a data-modifying CTE
 * and the query around it share one pre-statement snapshot. That mistake cost a day on
 * `RoleCreateOps`; the shape to reach for here is two statements in a transaction.
 */
export const RecentSearchRecordOps: (
  staffId: string,
  scope: string,
  term: string,
) => SqlOps<number> = (staffId, scope, term) => ({
  sql: `
    INSERT INTO staff_recent_search (staff_id, scope, term)
    VALUES (:staff_id, :scope, :term)
    ON CONFLICT (staff_id, scope, term) DO UPDATE
       SET used_at = now()
  `,
  parameters: [
    param("staff_id", staffId, "id"),
    param("scope", scope, "text"),
    param("term", term, "text"),
  ],
  mapper: (rows) => rows.length,
});

/**
 * Drop everything past the newest five for one person and one scope.
 *
 * Runs in the same transaction as the record above, as a SEPARATE statement - which is what makes
 * it correct. Within a transaction each statement sees the previous one's effects, so this one can
 * see the row just inserted; folded into the INSERT as a CTE it could not, and it would prune the
 * old five while the new sixth survived.
 *
 * `used_at DESC, id DESC` matches the index and the read. The `id` tiebreak matters: two searches
 * in the same instant tie on `used_at`, and a prune with a tie keeps an arbitrary one of them -
 * which would show up as a suggestion list that reorders itself for no reason.
 */
export const RecentSearchPruneOps: (staffId: string, scope: string) => SqlOps<number> = (
  staffId,
  scope,
) => ({
  sql: `
    DELETE FROM staff_recent_search
     WHERE staff_id = :staff_id
       AND scope = :scope
       AND id NOT IN (
         SELECT id
           FROM staff_recent_search
          WHERE staff_id = :staff_id
            AND scope = :scope
          ORDER BY used_at DESC, id DESC
          LIMIT ${String(RECENT_SEARCH_LIMIT)}
       )
    RETURNING id
  `,
  parameters: [param("staff_id", staffId, "id"), param("scope", scope, "text")],
  mapper: (rows) => rows.length,
});

/**
 * Forget one term, or every term in one scope when `term` is null.
 *
 * The feature records what somebody typed, so it needs a way to unrecord it. A mistyped search sits
 * in the suggestion list otherwise, and the only alternative - searching five other things to push
 * it out - is not an instruction anybody should have to be given.
 */
export const RecentSearchForgetOps: (
  staffId: string,
  scope: string,
  term: string | null,
) => SqlOps<number> = (staffId, scope, term) => ({
  sql: `
    DELETE FROM staff_recent_search
     WHERE staff_id = :staff_id
       AND scope = :scope
       AND (:term IS NULL OR term = :term)
    RETURNING id
  `,
  parameters: [
    param("staff_id", staffId, "id"),
    param("scope", scope, "text"),
    param("term", term, "text"),
  ],
  mapper: (rows) => rows.length,
});

/** How many rows one person holds, for the listing's own sanity check in tests. */
export const RecentSearchCountOps: (staffId: string) => SqlOps<number> = (staffId) => ({
  sql: `SELECT count(*) AS kept FROM staff_recent_search WHERE staff_id = :staff_id`,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => (rows.length > 0 ? (readInt(rows[0]!, "kept") ?? 0) : 0),
});
