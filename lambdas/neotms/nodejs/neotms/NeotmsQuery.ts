// SPDX-License-Identifier: MIT
//
// The plumbing every list endpoint shares: page size, cursor, sort, search, and row-level scope.
//
// It is one module rather than a copied block in five dbops files because three of the four things
// here are correctness or security boundaries, and a copy is a place for one of them to drift:
//
//   * the sort allow-list is what stops a `?sort=` parameter reaching the SQL text (the sort column
//     cannot be a bind parameter - PostgreSQL does not allow one where a column name goes);
//   * the row-level scope predicate is the fine-grained half of authorization, and it has to be
//     applied to every query, including the one behind a client-supplied cursor;
//   * the LIKE pattern has to be escaped, or a customer named "50%" searches as a wildcard;
//   * the page size has to be clamped, because the Data API caps a result set at 1 MiB and
//     `?limit=100000` would otherwise fail from deep inside the SQL layer.

import {
  clampLimit,
  decodeCursor,
  keysetWhere,
  param,
  resolveSort,
  type KeysetCursor,
  type SortDirection,
  type SqlParamKind,
  type SortTarget,
  type SqlParameter,
} from "../utils/RdsDataUtils.js";
import { NEOTMS_PAGE_SIZE_DEFAULT, NEOTMS_PAGE_SIZE_MAX } from "../env/NeotmsEnv.js";
import type { NeotmsCaller } from "../auth/NeotmsAuthGuard.js";
import type { RequestData } from "../reqres/RequestResponse.js";

/* -------------------------------------------------------------------------- */
/* Sorting                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The alias a sortable column must be selected under.
 *
 * `keysetWhere` needs the qualified name (`p.prj_sday`) because the query joins several tables;
 * `paginate` needs the key the row arrived under, which is the alias. The convention that makes one
 * allow-list serve both: **every sortable column is aliased to its bare column name**. So
 * `p.prj_sday AS prj_sday`, and this derives the second from the first.
 *
 * If a sortable column is ever aliased to something else, the cursor silently stops advancing - the
 * sort value reads as undefined, the next page repeats the same rows, and nothing errors. Hence the
 * convention rather than two hand-maintained maps.
 */
export const sortAlias = (qualifiedColumn: string): string =>
  qualifiedColumn.slice(qualifiedColumn.indexOf(".") + 1);

/* -------------------------------------------------------------------------- */
/* Request parsing                                                            */
/* -------------------------------------------------------------------------- */

export type ListQuery<K extends string> = {
  /** How many rows the caller gets. Already clamped. */
  limit: number;
  cursor: KeysetCursor | null;
  sort: { key: K } & SortTarget;
  direction: SortDirection;
  /** A trimmed search term, or null. Never an empty string - that would match everything. */
  search: string | null;
};

/**
 * Read the list parameters off a request.
 *
 * `direction` defaults to descending, because every list in this system is read newest-first: the
 * project someone is looking for is almost always one of the last few entered. Ascending exists for
 * the code and name columns, where alphabetical is what a person expects.
 */
export function readListQuery<K extends string>(
  request: RequestData,
  allowedSorts: Record<K, SortTarget>,
  defaultSort: K,
  defaultDirection: SortDirection = "desc",
): ListQuery<K> {
  const rawSearch = (request.queryParams["q"] ?? "").trim();
  const rawDirection = request.queryParams["dir"];
  return {
    limit: clampLimit(
      request.queryParams["limit"],
      NEOTMS_PAGE_SIZE_DEFAULT,
      NEOTMS_PAGE_SIZE_MAX,
    ),
    cursor: decodeCursor(request.queryParams["cursor"]),
    sort: resolveSort(request.queryParams["sort"], allowedSorts, defaultSort),
    direction: rawDirection === "asc" ? "asc" : rawDirection === "desc" ? "desc" : defaultDirection,
    search: rawSearch.length > 0 ? rawSearch : null,
  };
}

/* -------------------------------------------------------------------------- */
/* WHERE building                                                             */
/* -------------------------------------------------------------------------- */

export type SqlClause = { fragment: string; parameters: SqlParameter[] };

export const EMPTY_CLAUSE: SqlClause = { fragment: "", parameters: [] };

/** Join several clauses into one. Fragments already begin with `AND`, so this is a plain concat. */
export function mergeClauses(...clauses: SqlClause[]): SqlClause {
  return {
    fragment: clauses
      .map((c) => c.fragment)
      .filter((f) => f.length > 0)
      .join("\n      "),
    parameters: clauses.flatMap((c) => c.parameters),
  };
}

/** The keyset clause for a resolved list query. A thin wrapper so call sites read in one line. */
export function cursorClause<K extends string>(query: ListQuery<K>, idColumn: string): SqlClause {
  return keysetWhere(
    query.cursor,
    query.sort.column,
    idColumn,
    query.direction,
    query.sort.cast,
  );
}

/**
 * The `LIMIT` for a resolved list query, asking for one row more than the caller wanted.
 *
 * The extra row is never returned. Its only job is to answer "is there a next page" without a
 * second `COUNT(*)`, which on a large filtered table costs about as much as the page itself. See
 * `paginate`, which trims it off and turns its presence into a cursor.
 *
 * Parameterised rather than interpolated. The value is already clamped to a small integer, so
 * interpolating it would be safe today - but "safe because of a check somewhere else" is how an
 * interpolated integer eventually becomes an interpolated string.
 */
export function limitClause<K extends string>(query: ListQuery<K>): SqlClause {
  return {
    fragment: "LIMIT :page_limit",
    parameters: [param("page_limit", query.limit + 1, "int")],
  };
}

/**
 * The `ORDER BY` for a resolved list query.
 *
 * `NULLS LAST` on a descending sort and `NULLS FIRST` on an ascending one - i.e. nulls always at the
 * end - so a list sorted by an optional date puts the rows that have no date where a reader expects
 * them, and the ordering stays the same shape in both directions.
 *
 * It must also match the keyset comparison, or paging and ordering disagree and rows go missing.
 * This is why the ORDER BY is built here from the same resolved target rather than written out at
 * each call site.
 */
export function orderByClause<K extends string>(query: ListQuery<K>, idColumn: string): string {
  const dir = query.direction === "asc" ? "ASC" : "DESC";
  const nulls = query.direction === "asc" ? "NULLS FIRST" : "NULLS LAST";
  return `ORDER BY ${query.sort.column} ${dir} ${nulls}, ${idColumn} ${dir}`;
}

/**
 * Escape a user-supplied search term for use in a `LIKE` pattern.
 *
 * Without this, `%` and `_` typed by a user are wildcards: searching for the customer "50% 할인"
 * matches everything, and searching for "A_B" matches "AxB". The backslash has to be escaped first
 * or it would escape the escapes we add.
 */
const escapeLike = (term: string): string =>
  term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

/**
 * A substring search across one or more columns, answered from a pg_bigm index.
 *
 * `LIKE '%term%'` rather than a tsvector match, and pg_bigm rather than pg_trgm, for a reason that
 * only shows up in Korean: pg_trgm indexes 3-grams, so a two-character term - 삼성, 번역, 계약 - has
 * no trigram at all and the planner falls back to a sequential scan. The index exists and does
 * nothing, silently. pg_bigm indexes 2-grams, which is the shortest term people actually type.
 *
 * `ESCAPE '\'` is explicit because the default escape character is already backslash but relying on
 * the default makes the escaping above look decorative.
 */
export function searchClause(columns: string[], term: string | null): SqlClause {
  if (!term || columns.length === 0) return EMPTY_CLAUSE;
  const predicate = columns
    .map((column) => `${column} LIKE :search ESCAPE '\\'`)
    .join(" OR ");
  return {
    fragment: `AND (${predicate})`,
    parameters: [param("search", `%${escapeLike(term)}%`, "text")],
  };
}

/* -------------------------------------------------------------------------- */
/* Equality filters and date ranges                                           */
/* -------------------------------------------------------------------------- */

/** One filterable column: where it is, and how its value must be typed. */
export type FilterSpec = { column: string; kind: SqlParamKind };

/**
 * The equality filters a list screen's dropdowns produce.
 *
 * Built from an allow-list rather than from whatever the request contained, for the same reason the
 * sort is: the column name is interpolated into the SQL text. The VALUES are parameterised, so the
 * request decides only WHICH of the declared columns are filtered, never what they are called - the
 * same division of labour as `FieldSpec` on the write side.
 *
 * An absent or empty value is no filter. `?state=` is what a cleared dropdown sends, and treating it
 * as "equals the empty string" would match the many rows where these optional columns are blank -
 * i.e. clearing a filter would appear to apply a new one.
 *
 * Parameters are prefixed `f_` so they cannot collide with the page limit, the cursor, the search
 * term or a column-named write parameter in the same statement.
 */
export function filterClause<K extends string>(
  specs: Record<K, FilterSpec>,
  // `NoInfer` so the key set comes from the allow-list and only from it. Without it, a filter type
  // that also carries non-equality members - a date range, say - would widen `K` to include them
  // and the allow-list would then look incomplete.
  values: Partial<Record<NoInfer<K>, string>>,
): SqlClause {
  const present = (Object.keys(specs) as K[]).filter((key) => {
    const value = values[key];
    return typeof value === "string" && value.length > 0;
  });
  if (present.length === 0) return EMPTY_CLAUSE;
  return {
    fragment: present.map((key) => `AND ${specs[key].column} = :f_${key}`).join("\n      "),
    parameters: present.map((key) => param(`f_${key}`, values[key], specs[key].kind)),
  };
}

/**
 * An inclusive `from`/`to` range on one column.
 *
 * Either end may be omitted, which is what makes "everything due before Friday" expressible without
 * a second endpoint. Both ends are inclusive because that is what a user means by a date range on a
 * screen: "1st to 31st" includes the 31st.
 *
 * The column is NOT cast here. A cast on the column would make the index unusable - the same trap
 * `keysetWhere` avoids by casting the parameter instead - so the type hint on the parameter is what
 * makes the comparison work.
 */
export function rangeClause(
  name: string,
  column: string,
  from: string | undefined,
  to: string | undefined,
  kind: SqlParamKind = "date",
): SqlClause {
  const parts: string[] = [];
  const parameters: SqlParameter[] = [];
  if (from) {
    parts.push(`AND ${column} >= :${name}_from`);
    parameters.push(param(`${name}_from`, from, kind));
  }
  if (to) {
    parts.push(`AND ${column} <= :${name}_to`);
    parameters.push(param(`${name}_to`, to, kind));
  }
  if (parts.length === 0) return EMPTY_CLAUSE;
  return { fragment: parts.join("\n      "), parameters };
}

/* -------------------------------------------------------------------------- */
/* Row-level scope (the fine tier of authorization)                           */
/* -------------------------------------------------------------------------- */

/**
 * Restrict a list to the rows this caller owns, unless their view scope says otherwise.
 *
 * `columns` are the staff-id columns that count as ownership for the entity being listed - a project
 * is "yours" if you are either its sales manager or its PM, so both columns are passed. A caller
 * with the wide view scope gets an empty clause and sees everything.
 *
 * Three things about this are deliberate:
 *
 *   * It takes the whole `NeotmsCaller`, not a boolean. A boolean at the call site is a value
 *     someone can compute from a request parameter; a caller can only come from the guard.
 *   * It is applied to the list query itself rather than filtering results afterwards. Filtering
 *     after the fact breaks pagination (a page of 50 becomes a page of 3) and leaks the total.
 *   * There is no "scope off" switch. Reporting endpoints that legitimately aggregate across
 *     everyone read the rollup table, which is a different query with its own permission check -
 *     not this one with the predicate omitted.
 */
export function scopeClause(caller: NeotmsCaller, columns: string[]): SqlClause {
  if (caller.seesEveryRow || columns.length === 0) return EMPTY_CLAUSE;
  const predicate = columns.map((column) => `${column} = :scope_staff_id`).join(" OR ");
  return {
    fragment: `AND (${predicate})`,
    parameters: [param("scope_staff_id", caller.staffId, "id")],
  };
}

/**
 * The same restriction, for a single-record read.
 *
 * A list endpoint that hides a row and a detail endpoint that happily returns it when asked by id
 * is the most common way row-level access control is defeated, and it is invisible in testing
 * because the list screen looks right. Every `get by id` in this codebase takes the caller and
 * passes it here.
 */
export const scopeClauseForOne = scopeClause;
