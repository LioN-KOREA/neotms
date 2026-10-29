// SPDX-License-Identifier: MIT
//
// The customer master (legacy CUSTB_MAIN). Head of the revenue chain.
//
// Pure statement builders - no client, no credentials, no network - so the SQL these produce can be
// asserted in a unit test. The executors live in PostgresUtils.
//
// Every selected column is aliased, including the ones that could not collide today. That is not
// tidiness: `formatRecordsAs: "JSON"` keys each row by column name, so two same-named columns from
// two joined tables silently collapse into one with the last writer winning. Aliasing the lot means
// a column added to either table later cannot reintroduce the collision by accident.
//
// The column list is a function of the table qualifier because the same list serves both a SELECT
// (where the table is aliased `c`) and a `RETURNING` (where it is not, and must be named in full).
// Writing it out twice is how the two drift until a created record comes back missing a field that
// a read of the same record shows.

import {
  param,
  readBool,
  readId,
  readMoney,
  readText,
  type SortTarget,
  type SqlOps,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import { CUSTOMER_CODE, codeExpression } from "../NeotmsCodes.js";
import {
  cursorClause,
  limitClause,
  mergeClauses,
  orderByClause,
  searchClause,
  type ListQuery,
} from "../NeotmsQuery.js";
import {
  insertFragments,
  updateFragments,
  type FieldSpec,
  type WriteContext,
} from "../NeotmsWrite.js";
import type { CustomerCreate, CustomerUpdate } from "../neotms.schemas.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type CustomerRow = {
  id: string;
  cusCode: string;
  cusName: string | null;
  cusEmail: string | null;
  cusPhone: string | null;
  cusZip: string | null;
  cusAddr: string | null;
  cusNation: string | null;
  cusCoin: string | null;
  /**
   * READ-ONLY. Legacy CUS_UPRO - which CAT tool the customer works in, NOT a grade or rate tier
   * (db/002_tables.sql said tier for a while and was wrong).
   *
   * Still selected, no longer writable: it is absent from CUSTOMER_FIELDS and from
   * CustomerCreateSchema, so no request can set it. It stays on the read path because the ETL will
   * land legacy values here, and a column the API cannot even report is a column whose data is
   * discovered years later by someone querying the database directly. `translator.tranUpro` is the
   * live one - see db/007_codes.sql section 2e for why the question was worth asking of a translator
   * and not of a client.
   */
  cusUpro: string | null;
  /** A decimal string. Never a number - see neotms.schemas. */
  cusMincost: string | null;
  cusField: string | null;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

const customerColumns = (q: string): string => `
  ${q}.id          AS customer_id,
  ${q}.cus_code    AS cus_code,
  ${q}.cus_name    AS cus_name,
  ${q}.cus_email   AS cus_email,
  ${q}.cus_phone   AS cus_phone,
  ${q}.cus_zip     AS cus_zip,
  ${q}.cus_addr    AS cus_addr,
  ${q}.cus_nation  AS cus_nation,
  ${q}.cus_coin    AS cus_coin,
  ${q}.cus_upro    AS cus_upro,
  ${q}.cus_mincost AS cus_mincost,
  ${q}.cus_field   AS cus_field,
  ${q}.active      AS cus_active,
  ${q}.created_at  AS created_at,
  ${q}.updated_at  AS updated_at
`;

export const toCustomerRow = (row: SqlRow): CustomerRow => ({
  id: readId(row, "customer_id") ?? "",
  cusCode: readText(row, "cus_code") ?? "",
  cusName: readText(row, "cus_name"),
  cusEmail: readText(row, "cus_email"),
  cusPhone: readText(row, "cus_phone"),
  cusZip: readText(row, "cus_zip"),
  cusAddr: readText(row, "cus_addr"),
  cusNation: readText(row, "cus_nation"),
  cusCoin: readText(row, "cus_coin"),
  cusUpro: readText(row, "cus_upro"),
  cusMincost: readMoney(row, "cus_mincost"),
  cusField: readText(row, "cus_field"),
  active: readBool(row, "cus_active") ?? false,
  createdAt: readText(row, "created_at"),
  updatedAt: readText(row, "updated_at"),
});

/* -------------------------------------------------------------------------- */
/* Sorting and searching                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The sort allow-list. A security boundary, not a convenience: the sort column is interpolated into
 * the SQL text (PostgreSQL has no parameter where a column name goes), so only values from here
 * ever reach it.
 *
 * Each column is aliased to its bare name above, which is the convention `sortAlias` depends on -
 * see NeotmsQuery. `created` is the default because `created_at` is NOT NULL: a row-value
 * comparison against a NULL sort value is NULL rather than true, so a nullable default sort makes
 * the list appear to end early.
 */
export const CUSTOMER_SORTS = {
  created: { column: "c.created_at", cast: "timestamptz" },
  name: { column: "c.cus_name" },
  code: { column: "c.cus_code" },
} as const satisfies Record<string, SortTarget>;

export type CustomerSortKey = keyof typeof CUSTOMER_SORTS;

/**
 * Columns the free-text search covers.
 *
 * `cus_name` is backed by a PGroonga index (`ix_cus_name_pgrn`), which is what makes a
 * two-character Korean term - 삼성, 네이버 - an index scan rather than a sequential one. The other
 * three have no index and are compared within the rows the name predicate already narrowed; that is
 * fine on a table of a few thousand customers, and it is the reason not to add a fifth column here
 * without an index behind it.
 */
const CUSTOMER_SEARCH_COLUMNS = ["c.cus_name", "c.cus_code", "c.cus_email", "c.cus_phone"];

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One page of customers.
 *
 * No row-level scope clause, and that is a decision rather than an omission: the customer master is
 * reference data every PM needs in order to create a project at all. Access is controlled at the
 * menu level - a role either holds the CUSTOMER menu or does not. The things that ARE scoped per
 * row are the projects, jobs and POs that reference a customer, which is where the commercially
 * sensitive figures live.
 */
export const CustomerListOps: (query: ListQuery<CustomerSortKey>) => SqlOps<SqlRow[]> = (query) => {
  const where = mergeClauses(
    cursorClause(query, "c.id"),
    searchClause(CUSTOMER_SEARCH_COLUMNS, query.search),
  );
  const limit = limitClause(query);
  return {
    sql: `
      SELECT ${customerColumns("c")}
        FROM customer c
       WHERE c.deleted = false
      ${where.fragment}
      ${orderByClause(query, "c.id")}
      ${limit.fragment}
    `,
    parameters: [...where.parameters, ...limit.parameters],
    // Returns raw rows: `paginate` has to see the extra (limit + 1) row to decide whether there is
    // a next page, and mapping to CustomerRow here would hide it.
    mapper: (rows) => rows,
  };
};

export const CustomerGetOps: (id: string) => SqlOps<CustomerRow | null> = (id) => ({
  sql: `
    SELECT ${customerColumns("c")}
      FROM customer c
     WHERE c.id = :id
       AND c.deleted = false
     LIMIT 1
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows.length > 0 ? toCustomerRow(rows[0]!) : null),
});

/**
 * The customer's name, for the denormalised copy a project carries.
 *
 * Read on the server rather than accepted from the request: `project.cus_code_name` is a maintained
 * copy of this value, and a copy supplied by a caller could disagree with the id it sits beside -
 * which the project list would then display as fact. The query doubles as the existence check, so a
 * project cannot be created against a deleted customer.
 */
export const CustomerNameOps: (id: string) => SqlOps<string | null> = (id) => ({
  sql: `
    SELECT c.cus_name AS cus_name
      FROM customer c
     WHERE c.id = :id
       AND c.deleted = false
     LIMIT 1
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows.length > 0 ? (readText(rows[0]!, "cus_name") ?? "") : null),
});

/** How many live projects reference this customer. Asked before a delete, for the 409 message. */
export const CustomerLiveProjectCountOps: (id: string) => SqlOps<number> = (id) => ({
  sql: `
    SELECT count(*) AS project_count
      FROM project p
     WHERE p.customer_id = :id
       AND p.deleted = false
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => Number(rows[0]?.["project_count"] ?? 0),
});

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The writable columns, declared once and used by both the INSERT and the UPDATE.
 *
 * `cus_code` is absent: it is minted from a sequence inside the INSERT and never changes
 * afterwards, because it appears on issued invoices.
 *
 * `cus_upro` is absent too, and for a different reason: the field was removed from the registration
 * screen (most clients of this company do not send translation work, so "which CAT tool do you
 * use?" had no answer), and this list is what makes that removal real rather than cosmetic. Taking
 * the input off the form while leaving the column here would mean every save rewrites the column
 * with the blank the form no longer collects - which is how a legacy value loaded by the ETL
 * disappears the first time somebody edits a phone number.
 */
const CUSTOMER_FIELDS: readonly FieldSpec<CustomerUpdate>[] = [
  { column: "cus_name", kind: "text", read: (i) => i.cusName },
  { column: "cus_email", kind: "text", read: (i) => i.cusEmail },
  { column: "cus_phone", kind: "text", read: (i) => i.cusPhone },
  { column: "cus_zip", kind: "text", read: (i) => i.cusZip },
  { column: "cus_addr", kind: "text", read: (i) => i.cusAddr },
  { column: "cus_nation", kind: "text", read: (i) => i.cusNation },
  { column: "cus_coin", kind: "text", read: (i) => i.cusCoin },
  { column: "cus_mincost", kind: "money", read: (i) => i.cusMincost },
  { column: "cus_field", kind: "text", read: (i) => i.cusField },
  { column: "active", kind: "bool", read: (i) => i.active },
];

export const CustomerCreateOps: (
  input: CustomerCreate,
  ctx: WriteContext,
) => SqlOps<CustomerRow | null> = (input, ctx) => {
  const fields = insertFragments(CUSTOMER_FIELDS, input);
  return {
    sql: `
      INSERT INTO customer (
        cus_code, ${fields.columns.join(", ")}, created_by, created_ip
      ) VALUES (
        ${codeExpression(CUSTOMER_CODE)}, ${fields.placeholders.join(", ")},
        :created_by, :created_ip
      )
      RETURNING ${customerColumns("customer")}
    `,
    parameters: [
      ...fields.parameters,
      param("created_by", ctx.actor, "text"),
      param("created_ip", ctx.ip, "text"),
    ],
    // INSERT ... RETURNING rather than insert-then-select: one round trip, and no window in which
    // another request could change the row in between.
    mapper: (rows) => (rows.length > 0 ? toCustomerRow(rows[0]!) : null),
  };
};

/**
 * Edit a customer.
 *
 * Returns null when no row matched, which is also what a soft-deleted customer produces. The
 * manager turns that into a 404 rather than distinguishing the two - a deleted record and a record
 * that never existed are the same thing from outside.
 *
 * `updated_at` is set here and not by a trigger. A trigger would be less to remember, but it would
 * also fire for the ETL's bulk load and rewrite every migrated row's timestamp to the migration
 * date, erasing the only evidence of when a record was last genuinely touched.
 */
export const CustomerUpdateOps: (
  id: string,
  input: CustomerUpdate,
  ctx: WriteContext,
) => SqlOps<CustomerRow | null> = (id, input, ctx) => {
  const fields = updateFragments(CUSTOMER_FIELDS, input);
  return {
    sql: `
      UPDATE customer
         SET ${fields.fragment},
             updated_at = now(),
             created_by = :created_by
       WHERE id = :id
         AND deleted = false
      RETURNING ${customerColumns("customer")}
    `,
    parameters: [
      ...fields.parameters,
      param("id", id, "id"),
      param("created_by", ctx.actor, "text"),
    ],
    mapper: (rows) => (rows.length > 0 ? toCustomerRow(rows[0]!) : null),
  };
};

/**
 * Soft-delete a customer.
 *
 * `deleted = true`, never a real DELETE. Every project, invoice and report row that ever referenced
 * this customer still does, and the foreign keys are ON DELETE RESTRICT precisely so a hard delete
 * cannot destroy booked revenue. `active` is cleared too, so the customer stops appearing in the
 * pickers a new project is created from.
 */
export const CustomerSoftDeleteOps: (id: string, ctx: WriteContext) => SqlOps<string | null> = (
  id,
  ctx,
) => ({
  sql: `
    UPDATE customer
       SET deleted = true, active = false, updated_at = now(), created_by = :created_by
     WHERE id = :id
       AND deleted = false
    RETURNING customer.id AS customer_id
  `,
  parameters: [param("id", id, "id"), param("created_by", ctx.actor, "text")],
  mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "customer_id") : null),
});
