// SPDX-License-Identifier: MIT
//
// Turning a validated request body into an INSERT or an UPDATE.
//
// The tables in this schema are wide - `purchase_order` has 40 columns - and almost every column is
// optional. Writing the INSERT and the UPDATE out by hand for each entity means the same column
// list appears twice per entity, in two different orders, with two different sets of type hints. A
// column added to one and forgotten in the other is a field that silently cannot be edited, and the
// symptom is "the save button does nothing for that one box".
//
// So each entity declares its columns once, as a list of `FieldSpec`, and both statements are
// derived from it. Three properties of that list are what make this safe:
//
//   * The column name and the type hint travel together. A `date` column cannot be sent without
//     `typeHint: "DATE"` by accident, because the hint is declared next to the column, once.
//   * Column names are interpolated into the SQL - they must be, PostgreSQL has no parameter for a
//     column name - but they come from a module-level literal, never from the request. The request
//     only ever decides WHICH of the declared columns are written, never what they are called.
//   * `undefined` means "not provided" and the column is left out; `null` means "clear it" and the
//     column is written as NULL. That distinction is the whole reason a PATCH can clear a due date
//     without also clearing every other field the client did not mention.

import { param, type SqlParamKind, type SqlParameter } from "../utils/PostgresUtils.js";

/**
 * Who is writing, and from where. Stamped onto `created_by` / `created_ip`.
 *
 * `actor` is the staff member's `mgr_id`, not their `staff.id`: it is what the legacy `REG_ID`
 * column holds, so the audit columns stay comparable across migrated and new rows - which is the
 * only thing that makes "who changed this" answerable for a project that predates the rebuild.
 *
 * Both come from the guard and the request context, never from the body. An audit column a caller
 * can set is not an audit column.
 */
export interface WriteContext {
  readonly actor: string;
  readonly ip: string | null;
}

/** One writable column: where it goes, how it is typed, and where to read it from the body. */
export interface FieldSpec<T> {
  readonly column: string;
  readonly kind: SqlParamKind;
  /** Returns `undefined` when the body did not mention this field. */
  readonly read: (input: T) => unknown;
}

/**
 * The client address, if it is one PostgreSQL will accept in an `inet` column.
 *
 * `x-forwarded-for` is a comma-separated chain and only the first entry is the client; the rest are
 * proxies. It is also entirely client-controlled, so it can be anything at all - and an `inet`
 * column rejects "anything at all" by failing the INSERT. Losing the address of a save is a
 * nuisance; failing the save because somebody sent a malformed header is a bug, so an unparseable
 * value becomes NULL rather than an error.
 *
 * The check is a shape check, not a validation: it rejects what would break the statement and does
 * not pretend the value is trustworthy. Nothing in this system makes a decision from it.
 */
export function clientInet(headers: Record<string, string> | undefined): string | null {
  const first = (headers?.["x-forwarded-for"] ?? "").split(",")[0]?.trim() ?? "";
  if (first.length === 0 || first.length > 45) return null;
  const looksLikeAddress = /^[0-9a-fA-F:.]+$/.test(first);
  return looksLikeAddress ? first : null;
}

const provided = <T>(specs: readonly FieldSpec<T>[], input: T): FieldSpec<T>[] =>
  specs.filter((spec) => spec.read(input) !== undefined);

const parametersFor = <T>(specs: readonly FieldSpec<T>[], input: T): SqlParameter[] =>
  // The parameter is named after the column, which is unique within a statement by construction.
  specs.map((spec) => param(spec.column, spec.read(input), spec.kind));

/**
 * The column list, the placeholder list and the parameters for an INSERT.
 *
 * Returned as three pieces rather than a finished statement because every entity's INSERT also
 * writes columns that do not come from the request - the minted document code, `created_by`,
 * `created_ip` - and those are clearer at the call site than behind another layer of configuration.
 */
export function insertFragments<T>(
  specs: readonly FieldSpec<T>[],
  input: T,
): { columns: string[]; placeholders: string[]; parameters: SqlParameter[] } {
  const present = provided(specs, input);
  return {
    columns: present.map((spec) => spec.column),
    placeholders: present.map((spec) => `:${spec.column}`),
    parameters: parametersFor(present, input),
  };
}

/**
 * The `SET` assignments and parameters for an UPDATE.
 *
 * `fragment` is empty when the body mentioned no writable field. Callers must check: an UPDATE with
 * an empty SET is a syntax error, and - more to the point - a request that changes nothing is a
 * request the client got wrong, so it deserves a 400 rather than a cheerful 200.
 */
export function updateFragments<T>(
  specs: readonly FieldSpec<T>[],
  input: T,
): { fragment: string; parameters: SqlParameter[] } {
  const present = provided(specs, input);
  return {
    fragment: present.map((spec) => `${spec.column} = :${spec.column}`).join(",\n           "),
    parameters: parametersFor(present, input),
  };
}

/* -------------------------------------------------------------------------- */
/* Denormalised name columns                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A column whose value the server looks up rather than accepts.
 *
 * Three tables in this schema carry a denormalised copy of a name that lives elsewhere -
 * `project.cus_code_name`, `job.job_pm_name`, `purchase_order.po_tran_name` and several more. The
 * copies exist to spare the list screens two or three joins per row, which is a real saving on a
 * 50-row page, and the DDL comments are explicit that the id is authoritative and the name is a
 * maintained copy.
 *
 * Maintaining them from the request body would be the obvious thing and the wrong one: a client that
 * sent `customerId: 7` with `cusCodeName: "Some Other Company"` would get exactly that, and the list
 * screen would then display the wrong name as fact with no way to tell. So the name is written by a
 * scalar subquery against the id the request DID send.
 *
 * `expression` references the driving field's bind parameter - which, by the naming rule in
 * `parametersFor`, is the column name. That is why a derived column carries no parameters of its
 * own, and why it may only be emitted when its driving field was provided: otherwise the statement
 * would reference a parameter nobody bound.
 *
 * A driving id that arrives as `null` needs no special case. The subquery matches no row, evaluates
 * to NULL, and the name is cleared alongside the id it describes.
 */
export interface DerivedSpec<T> {
  /** The denormalised column being written. */
  readonly column: string;
  /** A scalar subquery, parenthesised, referencing the driving field's parameter. */
  readonly expression: string;
  /** The field whose presence decides whether this column is written at all. */
  readonly read: (input: T) => unknown;
}

/** The extra column names and value expressions for an INSERT. No parameters: see `DerivedSpec`. */
export function derivedInsert<T>(
  specs: readonly DerivedSpec<T>[],
  input: T,
): { columns: string[]; expressions: string[] } {
  const present = specs.filter((spec) => spec.read(input) !== undefined);
  return {
    columns: present.map((spec) => spec.column),
    expressions: present.map((spec) => spec.expression),
  };
}

/** The extra `SET` assignments for an UPDATE. Empty when no driving field was provided. */
export function derivedUpdate<T>(specs: readonly DerivedSpec<T>[], input: T): string[] {
  return specs
    .filter((spec) => spec.read(input) !== undefined)
    .map((spec) => `${spec.column} = ${spec.expression}`);
}
