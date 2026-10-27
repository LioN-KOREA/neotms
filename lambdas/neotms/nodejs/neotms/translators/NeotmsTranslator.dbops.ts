// SPDX-License-Identifier: MIT
//
// The translator / vendor master (legacy TRANTB_MAIN). The cost side of the chain.
//
// Same shape as the customer module - see NeotmsCustomer.dbops.ts for why the column list is a
// function of the table qualifier and why every column is aliased.
//
// One thing is specific to this table: it is the most heavily searched in the application. A PM
// assigning work searches by name, by romanisation, and by the duplicate-check field, and does it
// several times per PO. That is what `ix_tran_name_bigm` is for, and it is the reason the search
// column list here is the longest in the codebase.

import {
  param,
  readBool,
  readId,
  readText,
  type SortTarget,
  type SqlOps,
  type SqlRow,
} from "../../utils/RdsDataUtils.js";
import { TRANSLATOR_CODE, codeExpression } from "../NeotmsCodes.js";
import {
  EMPTY_CLAUSE,
  cursorClause,
  filterClause,
  limitClause,
  mergeClauses,
  orderByClause,
  searchClause,
  type FilterSpec,
  type ListQuery,
} from "../NeotmsQuery.js";
import {
  insertFragments,
  updateFragments,
  type FieldSpec,
  type WriteContext,
} from "../NeotmsWrite.js";
import type { TranslatorCreate, TranslatorUpdate } from "../neotms.schemas.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type TranslatorRow = {
  id: string;
  tranCode: string;
  tranName: string | null;
  tranPhone: string | null;
  tranEmail: string | null;
  tranDup: string | null;
  tranMsg: string | null;
  tranWorkCon: string | null;
  tranCatUse: boolean;
  tranCalc: string | null;
  tranUpro: string | null;
  tranField: string | null;
  tranUnfield: string | null;
  tranCoin: string | null;
  tranGive: string | null;
  /** A string, not a number: the legacy column may hold a rate (3.3) or a classification code. */
  tranIctax: string | null;
  tranBank: string | null;
  tranAcc: string | null;
  tranPaypal: string | null;
  tranRegDay: string | null;
  active: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

const translatorColumns = (q: string): string => `
  ${q}.id            AS translator_id,
  ${q}.tran_code     AS tran_code,
  ${q}.tran_name     AS tran_name,
  ${q}.tran_phone    AS tran_phone,
  ${q}.tran_email    AS tran_email,
  ${q}.tran_dup      AS tran_dup,
  ${q}.tran_msg      AS tran_msg,
  ${q}.tran_work_con AS tran_work_con,
  ${q}.tran_cat_use  AS tran_cat_use,
  ${q}.tran_calc     AS tran_calc,
  ${q}.tran_upro     AS tran_upro,
  ${q}.tran_field    AS tran_field,
  ${q}.tran_unfield  AS tran_unfield,
  ${q}.tran_coin     AS tran_coin,
  ${q}.tran_give     AS tran_give,
  ${q}.tran_ictax    AS tran_ictax,
  ${q}.tran_bank     AS tran_bank,
  ${q}.tran_acc      AS tran_acc,
  ${q}.tran_paypal   AS tran_paypal,
  ${q}.tran_reg_day  AS tran_reg_day,
  ${q}.active        AS tran_active,
  ${q}.created_at    AS created_at,
  ${q}.updated_at    AS updated_at
`;

export const toTranslatorRow = (row: SqlRow): TranslatorRow => ({
  id: readId(row, "translator_id") ?? "",
  tranCode: readText(row, "tran_code") ?? "",
  tranName: readText(row, "tran_name"),
  tranPhone: readText(row, "tran_phone"),
  tranEmail: readText(row, "tran_email"),
  tranDup: readText(row, "tran_dup"),
  tranMsg: readText(row, "tran_msg"),
  tranWorkCon: readText(row, "tran_work_con"),
  tranCatUse: readBool(row, "tran_cat_use") ?? false,
  tranCalc: readText(row, "tran_calc"),
  tranUpro: readText(row, "tran_upro"),
  tranField: readText(row, "tran_field"),
  tranUnfield: readText(row, "tran_unfield"),
  tranCoin: readText(row, "tran_coin"),
  tranGive: readText(row, "tran_give"),
  tranIctax: readText(row, "tran_ictax"),
  tranBank: readText(row, "tran_bank"),
  tranAcc: readText(row, "tran_acc"),
  tranPaypal: readText(row, "tran_paypal"),
  tranRegDay: readText(row, "tran_reg_day"),
  active: readBool(row, "tran_active") ?? false,
  createdAt: readText(row, "created_at"),
  updatedAt: readText(row, "updated_at"),
});

/* -------------------------------------------------------------------------- */
/* Sorting, searching, filtering                                              */
/* -------------------------------------------------------------------------- */

export const TRANSLATOR_SORTS = {
  created: { column: "t.created_at", cast: "timestamptz" },
  name: { column: "t.tran_name" },
  code: { column: "t.tran_code" },
  /** The onboarding date. Nullable, so it sorts nulls last - see `orderByClause`. */
  registered: { column: "t.tran_reg_day", cast: "date" },
} as const satisfies Record<string, SortTarget>;

export type TranslatorSortKey = keyof typeof TRANSLATOR_SORTS;

/**
 * `tran_dup` is in here on purpose.
 *
 * It holds alternate spellings and romanisations of the same person, and its whole reason for
 * existing is that a PM searching "Kim Min-su" should find the translator registered as "김민수".
 * Leaving it out of the search would make the column decorative.
 */
const TRANSLATOR_SEARCH_COLUMNS = [
  "t.tran_name",
  "t.tran_dup",
  "t.tran_code",
  "t.tran_email",
  "t.tran_phone",
];

/**
 * The low-cardinality facets the translator search screen offers.
 *
 * All five are `sys_code` values, so all five are text. See `filterClause` in NeotmsQuery for why
 * they come from an allow-list and why an empty value is no filter at all.
 */
const TRANSLATOR_FILTERS = {
  field: { column: "t.tran_field", kind: "text" },
  unfield: { column: "t.tran_unfield", kind: "text" },
  upro: { column: "t.tran_upro", kind: "text" },
  workCon: { column: "t.tran_work_con", kind: "text" },
  coin: { column: "t.tran_coin", kind: "text" },
} as const satisfies Record<string, FilterSpec>;

export type TranslatorFacets = Partial<Record<keyof typeof TRANSLATOR_FILTERS, string>>;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One page of translators.
 *
 * Like the customer master, this is reference data with no row-level scope: a PM cannot assign work
 * to a translator they cannot see. What a translator's row does NOT contain is the commercially
 * sensitive part - the rates are in `translator_rate` and the amounts paid are on the POs, both of
 * which are reached through their own menus.
 *
 * `activeOnly` defaults to true at the call site, because the overwhelmingly common reason to open
 * this list is to assign work, and a departed translator is not a candidate. The inactive ones are
 * still reachable, because a PM looking at a two-year-old PO needs to see who did it.
 */
export const TranslatorListOps: (
  query: ListQuery<TranslatorSortKey>,
  facets: TranslatorFacets,
  activeOnly: boolean,
) => SqlOps<SqlRow[]> = (query, facets, activeOnly) => {
  const where = mergeClauses(
    cursorClause(query, "t.id"),
    searchClause(TRANSLATOR_SEARCH_COLUMNS, query.search),
    filterClause(TRANSLATOR_FILTERS, facets),
    activeOnly ? { fragment: "AND t.active = true", parameters: [] } : EMPTY_CLAUSE,
  );
  const limit = limitClause(query);
  return {
    sql: `
      SELECT ${translatorColumns("t")}
        FROM translator t
       WHERE t.deleted = false
      ${where.fragment}
      ${orderByClause(query, "t.id")}
      ${limit.fragment}
    `,
    parameters: [...where.parameters, ...limit.parameters],
    mapper: (rows) => rows,
  };
};

export const TranslatorGetOps: (id: string) => SqlOps<TranslatorRow | null> = (id) => ({
  sql: `
    SELECT ${translatorColumns("t")}
      FROM translator t
     WHERE t.id = :id
       AND t.deleted = false
     LIMIT 1
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows.length > 0 ? toTranslatorRow(rows[0]!) : null),
});

/**
 * The translator's name, for the denormalised copy a PO carries.
 *
 * `purchase_order.po_tran_name` is a maintained copy, and it is one of the most-searched columns in
 * the system. Read here rather than accepted from the request, so the name on a PO cannot disagree
 * with the translator it was issued to. Doubles as the existence check.
 */
export const TranslatorNameOps: (id: string) => SqlOps<string | null> = (id) => ({
  sql: `
    SELECT t.tran_name AS tran_name
      FROM translator t
     WHERE t.id = :id
       AND t.deleted = false
     LIMIT 1
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows.length > 0 ? (readText(rows[0]!, "tran_name") ?? "") : null),
});

/** How many live POs reference this translator. Asked before a delete, for the 409 message. */
export const TranslatorLivePoCountOps: (id: string) => SqlOps<number> = (id) => ({
  sql: `
    SELECT count(*) AS po_count
      FROM purchase_order po
     WHERE po.translator_id = :id
       AND po.deleted = false
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => Number(rows[0]?.["po_count"] ?? 0),
});

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

const TRANSLATOR_FIELDS: readonly FieldSpec<TranslatorUpdate>[] = [
  { column: "tran_name", kind: "text", read: (i) => i.tranName },
  { column: "tran_phone", kind: "text", read: (i) => i.tranPhone },
  { column: "tran_email", kind: "text", read: (i) => i.tranEmail },
  { column: "tran_dup", kind: "text", read: (i) => i.tranDup },
  { column: "tran_msg", kind: "text", read: (i) => i.tranMsg },
  { column: "tran_work_con", kind: "text", read: (i) => i.tranWorkCon },
  { column: "tran_cat_use", kind: "bool", read: (i) => i.tranCatUse },
  { column: "tran_calc", kind: "text", read: (i) => i.tranCalc },
  { column: "tran_upro", kind: "text", read: (i) => i.tranUpro },
  { column: "tran_field", kind: "text", read: (i) => i.tranField },
  { column: "tran_unfield", kind: "text", read: (i) => i.tranUnfield },
  { column: "tran_coin", kind: "text", read: (i) => i.tranCoin },
  { column: "tran_give", kind: "text", read: (i) => i.tranGive },
  { column: "tran_ictax", kind: "text", read: (i) => i.tranIctax },
  { column: "tran_bank", kind: "text", read: (i) => i.tranBank },
  { column: "tran_acc", kind: "text", read: (i) => i.tranAcc },
  { column: "tran_paypal", kind: "text", read: (i) => i.tranPaypal },
  { column: "tran_reg_day", kind: "date", read: (i) => i.tranRegDay },
  { column: "active", kind: "bool", read: (i) => i.active },
];

export const TranslatorCreateOps: (
  input: TranslatorCreate,
  ctx: WriteContext,
) => SqlOps<TranslatorRow | null> = (input, ctx) => {
  const fields = insertFragments(TRANSLATOR_FIELDS, input);
  return {
    sql: `
      INSERT INTO translator (
        tran_code, ${fields.columns.join(", ")}, created_by, created_ip
      ) VALUES (
        ${codeExpression(TRANSLATOR_CODE)}, ${fields.placeholders.join(", ")},
        :created_by, :created_ip
      )
      RETURNING ${translatorColumns("translator")}
    `,
    parameters: [
      ...fields.parameters,
      param("created_by", ctx.actor, "text"),
      param("created_ip", ctx.ip, "text"),
    ],
    mapper: (rows) => (rows.length > 0 ? toTranslatorRow(rows[0]!) : null),
  };
};

export const TranslatorUpdateOps: (
  id: string,
  input: TranslatorUpdate,
  ctx: WriteContext,
) => SqlOps<TranslatorRow | null> = (id, input, ctx) => {
  const fields = updateFragments(TRANSLATOR_FIELDS, input);
  return {
    sql: `
      UPDATE translator
         SET ${fields.fragment},
             updated_at = now(),
             created_by = :created_by
       WHERE id = :id
         AND deleted = false
      RETURNING ${translatorColumns("translator")}
    `,
    parameters: [
      ...fields.parameters,
      param("id", id, "id"),
      param("created_by", ctx.actor, "text"),
    ],
    mapper: (rows) => (rows.length > 0 ? toTranslatorRow(rows[0]!) : null),
  };
};

/**
 * Soft-delete a translator.
 *
 * Never a hard delete: every PO ever issued to this person references the row, and `ON DELETE
 * RESTRICT` on `purchase_order.translator_id` would refuse anyway. In practice a translator is
 * usually deactivated rather than deleted - `active = false` takes them out of the assignment
 * pickers while leaving the history legible, which is what "we no longer work with them" actually
 * means.
 */
export const TranslatorSoftDeleteOps: (id: string, ctx: WriteContext) => SqlOps<string | null> = (
  id,
  ctx,
) => ({
  sql: `
    UPDATE translator
       SET deleted = true, active = false, updated_at = now(), created_by = :created_by
     WHERE id = :id
       AND deleted = false
    RETURNING translator.id AS translator_id
  `,
  parameters: [param("id", id, "id"), param("created_by", ctx.actor, "text")],
  mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "translator_id") : null),
});
