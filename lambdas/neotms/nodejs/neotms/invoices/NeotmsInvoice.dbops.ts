// SPDX-License-Identifier: MIT
//
// 번역가 인보이스 - the translator invoice / payable (legacy INVTB_TRAN).
//
// ## What this table is FOR, which is not what the PO already does
//
// A purchase order is the agreement with one translator about one job. An invoice is the DOCUMENT
// that bills a translator's work, and the business fact that forced this module to exist is that
// ONE invoice covers SEVERAL POs - a translator who did four jobs in a month sends one invoice for
// all four. That is why the grouping cannot live on the PO as a flag: "which POs are on this
// invoice" is a set, and a set needs a row to hang off.
//
// So the division of responsibility is:
//
//   * `invoice_translator`  - the document. Its code, its date, its totals, and the payment recorded
//                             against it. One row per document.
//   * `purchase_order`      - the work, and the SSOT for payment STATE. `invoice_translator_id`
//                             points at the document, `po_state` and `po_money_state` say how far
//                             the work and the money have got.
//
// The invoice does not own the PO's state, and nothing here writes `po_state`. An invoice being
// issued does not move a PO to 완료 - only money does, and 완료 means paid in full
// (NeotmsPoStates.ts). The settlement route on the PO is what records that.
//
// ## The three columns written by subquery rather than accepted
//
// `tran_name`, `pm_code` and `pm_name` are denormalised copies - see `DerivedSpec` in NeotmsWrite.ts
// for the general argument. On an invoice the argument is sharper than usual, because this row is
// printed and sent: a client that could post `tranName` would decide whose name appears on a
// payment document.
//
// ## Scope
//
// An invoice is visible to its own PM (`inv_pm_id`) OR to anybody who can see one of the POs on it.
// The second half is the one that matters: a PM who raised three of the four POs on an invoice has
// to be able to open the document those POs are on, and `inv_pm_id` alone would hide it from them.
// The PO half reuses `PO_SCOPE_COLUMNS` by import rather than restating the four columns - see
// `invoiceScopeClause`.

import {
  param,
  readId,
  readInt,
  readMoney,
  readText,
  type SortTarget,
  type SqlOps,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import { INVOICE_TRAN_CODE, codeExpression } from "../NeotmsCodes.js";
import {
  EMPTY_CLAUSE,
  cursorClause,
  filterClause,
  limitClause,
  mergeClauses,
  orderByClause,
  rangeClause,
  scopeClause,
  searchClause,
  type FilterSpec,
  type ListQuery,
  type SqlClause,
} from "../NeotmsQuery.js";
import {
  derivedInsert,
  derivedUpdate,
  insertFragments,
  updateFragments,
  type DerivedSpec,
  type FieldSpec,
  type WriteContext,
} from "../NeotmsWrite.js";
import { PO_SCOPE_COLUMNS } from "../purchase-orders/NeotmsPurchaseOrder.dbops.js";
import type { InvoiceTranslatorCreate, InvoiceTranslatorUpdate } from "../neotms.schemas.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type InvoiceRow = {
  id: string;
  /** `POL_000123`. Minted once, quoted to the translator, never regenerated. */
  invTranCode: string;
  coinCode: string | null;
  translatorId: string | null;
  tranName: string | null;
  /** `staff.mgr_id` of the issuing PM - the legacy text copy, kept beside `invPmId`. */
  pmCode: string | null;
  pmName: string | null;
  invPmId: string | null;
  invDay: string | null;
  invSum: string | null;
  invTax: string | null;
  invMoPday: string | null;
  invMoState: string | null;
  invMoGubun: string | null;
  invMoDay: string | null;
  invMoSum: string | null;
  invMoTax: string | null;
  invState: string | null;
  /**
   * How many live POs are on this invoice.
   *
   * Carried on the list row because an invoice with zero POs is the shape of a mistake - a document
   * billing nothing - and the screen cannot see it any other way without a second request per row.
   */
  poCount: number;
  /**
   * The POs' own total, in the POs' own currency, and the same total in KRW.
   *
   * Not the same question as `invSum`, and that is the point of showing both: `invSum` is what the
   * translator ASKED FOR on their document, `poSum` is what the POs SAY the work was worth. They
   * should agree, and the moment to notice they do not is before the money moves - which is why the
   * figure is on the row rather than left to be worked out by hand.
   */
  poSum: string | null;
  poKsum: string | null;
  /**
   * Contact details for the printed LIST OF INVOICE, read live from `translator` and `staff`.
   *
   * The document has an `E-mail` row for the translator and a signature block carrying the PM's
   * phone and address. See the comment on the subqueries in `invoiceColumns` for why these are
   * current values rather than copies frozen at issue time, unlike `tranName` and `pmName`.
   */
  tranEmail: string | null;
  pmEmail: string | null;
  pmPhone: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/**
 * The column list, as a function of the table qualifier - the convention every dbops module here
 * follows (see NeotmsCustomer.dbops.ts) so the same list serves a SELECT and an `INSERT
 * ... RETURNING`.
 *
 * The two PO aggregates are correlated subqueries rather than a `GROUP BY` join. A join to
 * `purchase_order` would fan one invoice out into one row per PO, and then every other column would
 * need aggregating too; with the subquery the statement still returns exactly one row per invoice,
 * which is what keeps the keyset cursor and `paginate` honest.
 */
const invoiceColumns = (q: string): string => `
  ${q}.id             AS invoice_id,
  ${q}.inv_tran_code  AS inv_tran_code,
  ${q}.coin_code      AS coin_code,
  ${q}.translator_id  AS translator_id,
  ${q}.tran_name      AS tran_name,
  ${q}.pm_code        AS pm_code,
  ${q}.pm_name        AS pm_name,
  ${q}.inv_pm_id      AS inv_pm_id,
  ${q}.inv_day        AS inv_day,
  ${q}.inv_sum        AS inv_sum,
  ${q}.inv_tax        AS inv_tax,
  ${q}.inv_mo_pday    AS inv_mo_pday,
  ${q}.inv_mo_state   AS inv_mo_state,
  ${q}.inv_mo_gubun   AS inv_mo_gubun,
  ${q}.inv_mo_day     AS inv_mo_day,
  ${q}.inv_mo_sum     AS inv_mo_sum,
  ${q}.inv_mo_tax     AS inv_mo_tax,
  ${q}.inv_state      AS inv_state,
  ${q}.created_at     AS created_at,
  ${q}.updated_at     AS updated_at,
  (SELECT count(*) FROM purchase_order po
    WHERE po.invoice_translator_id = ${q}.id AND po.deleted = false) AS po_count,
  (SELECT sum(po.po_price_sum) FROM purchase_order po
    WHERE po.invoice_translator_id = ${q}.id AND po.deleted = false) AS po_sum,
  (SELECT sum(po.po_price_ksum) FROM purchase_order po
    WHERE po.invoice_translator_id = ${q}.id AND po.deleted = false) AS po_ksum,
  /*
   * Contact details for the printed LIST OF INVOICE.
   *
   * SUBQUERIES rather than joins, like the three aggregates above and for the same reason: this
   * expression list is interpolated into RETURNING (InvoiceCreateOps, InvoiceUpdateOps) where there
   * is no FROM clause to add a join to. Each is a primary-key lookup returning at most one row, so
   * none of them can fan the invoice out.
   *
   * CURRENT values, not copies frozen at issue time - unlike tran_name and pm_name beside them. The
   * reason is what the two are for: the name on the document records who the invoice was agreed
   * with, while an address exists so a reply reaches someone, and a translator who changed their
   * email wants the reply to arrive. No deleted filter, for the matching reason - an invoice to a
   * translator who has since left still has to print.
   *
   * (No backticks anywhere above. This comment lives INSIDE a template literal, so one would end
   * the string and the file would stop parsing.)
   */
  (SELECT t.tran_email FROM translator t WHERE t.id = ${q}.translator_id) AS tran_email,
  (SELECT s.mgr_email  FROM staff s      WHERE s.id = ${q}.inv_pm_id)     AS pm_email,
  (SELECT s.mgr_phone  FROM staff s      WHERE s.id = ${q}.inv_pm_id)     AS pm_phone
`;

export const toInvoiceRow = (row: SqlRow): InvoiceRow => ({
  id: readId(row, "invoice_id") ?? "",
  invTranCode: readText(row, "inv_tran_code") ?? "",
  coinCode: readText(row, "coin_code"),
  translatorId: readId(row, "translator_id"),
  tranName: readText(row, "tran_name"),
  pmCode: readText(row, "pm_code"),
  pmName: readText(row, "pm_name"),
  invPmId: readId(row, "inv_pm_id"),
  invDay: readText(row, "inv_day"),
  invSum: readMoney(row, "inv_sum"),
  invTax: readMoney(row, "inv_tax"),
  invMoPday: readText(row, "inv_mo_pday"),
  invMoState: readText(row, "inv_mo_state"),
  invMoGubun: readText(row, "inv_mo_gubun"),
  invMoDay: readText(row, "inv_mo_day"),
  invMoSum: readMoney(row, "inv_mo_sum"),
  invMoTax: readMoney(row, "inv_mo_tax"),
  invState: readText(row, "inv_state"),
  poCount: readInt(row, "po_count") ?? 0,
  poSum: readMoney(row, "po_sum"),
  poKsum: readMoney(row, "po_ksum"),
  tranEmail: readText(row, "tran_email"),
  pmEmail: readText(row, "pm_email"),
  pmPhone: readText(row, "pm_phone"),
  createdAt: readText(row, "created_at"),
  updatedAt: readText(row, "updated_at"),
});

/* -------------------------------------------------------------------------- */
/* Sorting, searching, filtering                                              */
/* -------------------------------------------------------------------------- */

/**
 * `paid` sorts by the date the money actually moved, which is NULL for everything unpaid - so
 * `orderByClause` puts those last. That is the right way round for a payables screen read
 * newest-first, but it is worth knowing it is not the same list as "what is outstanding": use the
 * `moneyState` filter for that, because a null `inv_mo_day` is also what a never-to-be-paid voided
 * invoice looks like.
 */
export const INVOICE_SORTS = {
  created: { column: "it.created_at", cast: "timestamptz" },
  code: { column: "it.inv_tran_code" },
  issued: { column: "it.inv_day", cast: "date" },
  paid: { column: "it.inv_mo_day", cast: "date" },
  amount: { column: "it.inv_sum", cast: "numeric" },
} as const satisfies Record<string, SortTarget>;

export type InvoiceSortKey = keyof typeof INVOICE_SORTS;

/**
 * What the payables screen searches by.
 *
 * `inv_tran_code` first because the overwhelmingly common reason to search this list is that
 * somebody is holding a document with a code on it. `tran_name` is the denormalised copy and carries
 * the Korean 2-gram index the DDL comment mentions, so a name search is served by an index rather
 * than by a scan.
 */
const INVOICE_SEARCH_COLUMNS = ["it.inv_tran_code", "it.tran_name", "it.pm_name"];

const INVOICE_FILTERS = {
  translatorId: { column: "it.translator_id", kind: "id" },
  pmId: { column: "it.inv_pm_id", kind: "id" },
  coinCode: { column: "it.coin_code", kind: "text" },
  /** The invoice document's own lifecycle, `inv_state`. Not the PO's `po_state`. */
  invState: { column: "it.inv_state", kind: "text" },
  /** `inv_mo_state` - whether THIS DOCUMENT has been paid. Unconstrained legacy text. */
  moneyState: { column: "it.inv_mo_state", kind: "text" },
} as const satisfies Record<string, FilterSpec>;

export type InvoiceFilters = Partial<Record<keyof typeof INVOICE_FILTERS, string>> & {
  /** `inv_day` range - when the translator dated their invoice. */
  issuedFrom?: string;
  issuedTo?: string;
  /** `inv_mo_day` range - when we actually paid. The range the accounts reconcile by. */
  paidFrom?: string;
  paidTo?: string;
};

/* -------------------------------------------------------------------------- */
/* Scope                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Who may see this invoice: its PM, or anyone who can see a PO on it.
 *
 * The `EXISTS` half is the reason `PO_SCOPE_COLUMNS` is exported from the PO module. Restating those
 * four columns here would be the fourth copy of the list, which is precisely the drift the
 * `REPORT_SCOPE_COLUMNS` equality test exists to catch - and a scope list that has drifted does not
 * fail, it just shows somebody a row they should not have.
 *
 * Both halves bind the SAME parameter name. `toPositional` reuses a repeated name's number
 * (documented there), so this is one `$n`, not two - and the two halves cannot be given different
 * staff ids by accident.
 *
 * The subquery is deliberately NOT restricted to the caller's own POs beyond the scope clause: an
 * invoice is one document, and seeing it means seeing the whole of it. Hiding the other PMs' lines
 * would print a document whose total did not match its rows.
 */
const invoiceScopeClause = (caller: NeotmsCaller): SqlClause => {
  if (caller.seesEveryRow) return EMPTY_CLAUSE;
  const po = scopeClause(caller, PO_SCOPE_COLUMNS);
  return {
    fragment: `AND (
        it.inv_pm_id = :scope_staff_id
        OR EXISTS (
             SELECT 1
               FROM purchase_order po
               JOIN job j ON j.id = po.job_id AND j.deleted = false
               JOIN project p ON p.id = j.project_id AND p.deleted = false
              WHERE po.invoice_translator_id = it.id
                AND po.deleted = false
             ${po.fragment}
           )
      )`,
    parameters: po.parameters,
  };
};

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export const InvoiceListOps: (
  caller: NeotmsCaller,
  query: ListQuery<InvoiceSortKey>,
  filters: InvoiceFilters,
) => SqlOps<SqlRow[]> = (caller, query, filters) => {
  const where = mergeClauses(
    cursorClause(query, "it.id"),
    searchClause(INVOICE_SEARCH_COLUMNS, query.search),
    filterClause(INVOICE_FILTERS, filters),
    rangeClause("issued", "it.inv_day", filters.issuedFrom, filters.issuedTo),
    rangeClause("paid", "it.inv_mo_day", filters.paidFrom, filters.paidTo),
    invoiceScopeClause(caller),
  );
  const limit = limitClause(query);
  return {
    sql: `
      SELECT ${invoiceColumns("it")}
        FROM invoice_translator it
       WHERE it.deleted = false
      ${where.fragment}
      ${orderByClause(query, "it.id")}
      ${limit.fragment}
    `,
    parameters: [...where.parameters, ...limit.parameters],
    mapper: (rows) => rows,
  };
};

export const InvoiceGetOps: (caller: NeotmsCaller, id: string) => SqlOps<InvoiceRow | null> = (
  caller,
  id,
) => {
  const scope = invoiceScopeClause(caller);
  return {
    sql: `
      SELECT ${invoiceColumns("it")}
        FROM invoice_translator it
       WHERE it.id = :id
         AND it.deleted = false
      ${scope.fragment}
       LIMIT 1
    `,
    parameters: [param("id", id, "id"), ...scope.parameters],
    mapper: (rows) => (rows.length > 0 ? toInvoiceRow(rows[0]!) : null),
  };
};

/**
 * The invoice's code, read back so the PO assignment can write its denormalised copy.
 *
 * `purchase_order.inv_code` holds the CODE, not the id - it is the legacy join column, and
 * `PoInvoiceAssignOps` writes both together. The code is minted inside the INSERT (see
 * `codeExpression`), so the only way to know it is to read it, and reading it here rather than
 * passing it around keeps the single source of it the row itself.
 *
 * Unscoped, and only ever called with an id a scoped read or a just-completed INSERT produced.
 */
export const InvoiceCodeOps: (id: string) => SqlOps<string | null> = (id) => ({
  sql: `
    SELECT it.inv_tran_code AS inv_tran_code
      FROM invoice_translator it
     WHERE it.id = :id
       AND it.deleted = false
     LIMIT 1
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows.length > 0 ? readText(rows[0]!, "inv_tran_code") : null),
});

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every column a request may write.
 *
 * `translator_id` is NOT here, and its absence is the enforcement rather than a convention:
 * `InvoiceTranslatorUpdateSchema` omits it, so there is no field for this list to read, and the
 * INSERT names the column explicitly instead. Re-pointing a live invoice at a different translator
 * would re-bill one person's work to another while leaving every PO on it untouched.
 *
 * `inv_tran_code` is not here either - minted once, by the INSERT. See NeotmsCodes.ts.
 *
 * The `inv_mo_*` five are the payment recorded against the DOCUMENT. They are writable through the
 * 결제 menu's update action, which is the same authority that approves a PO: deciding that money
 * went out is not the same job as raising the paperwork that asked for it.
 */
const INVOICE_FIELDS: readonly FieldSpec<InvoiceTranslatorUpdate>[] = [
  { column: "coin_code", kind: "text", read: (i) => i.coinCode },
  { column: "inv_pm_id", kind: "id", read: (i) => i.invPmId },
  { column: "inv_day", kind: "date", read: (i) => i.invDay },
  { column: "inv_sum", kind: "money", read: (i) => i.invSum },
  { column: "inv_tax", kind: "money", read: (i) => i.invTax },
  { column: "inv_mo_pday", kind: "date", read: (i) => i.invMoPday },
  { column: "inv_mo_state", kind: "text", read: (i) => i.invMoState },
  { column: "inv_mo_gubun", kind: "text", read: (i) => i.invMoGubun },
  { column: "inv_mo_day", kind: "date", read: (i) => i.invMoDay },
  { column: "inv_mo_sum", kind: "money", read: (i) => i.invMoSum },
  { column: "inv_mo_tax", kind: "money", read: (i) => i.invMoTax },
  { column: "inv_state", kind: "text", read: (i) => i.invState },
];

/**
 * The PM's name and legacy id, looked up from `inv_pm_id`.
 *
 * `pm_code` is text holding `staff.mgr_id` rather than an FK, because the legacy data names staff
 * who no longer exist (the DDL comment says so). Keeping it beside the real `inv_pm_id` means the
 * old rows stay legible and the new ones are joinable.
 */
const INVOICE_DERIVED: readonly DerivedSpec<InvoiceTranslatorUpdate>[] = [
  {
    column: "pm_code",
    expression: "(SELECT s.mgr_id FROM staff s WHERE s.id = :inv_pm_id AND s.deleted = false)",
    read: (i) => i.invPmId,
  },
  {
    column: "pm_name",
    expression: "(SELECT s.mgr_name FROM staff s WHERE s.id = :inv_pm_id AND s.deleted = false)",
    read: (i) => i.invPmId,
  },
];

/**
 * Create the invoice document.
 *
 * `translator_id` and `tran_name` are written unconditionally, the name by subquery from the id -
 * the same pairing `PoCreateOps` uses for `po_tran_name`, for the same reason: the name on a payment
 * document must be the name of the translator it is addressed to, and a request cannot be allowed a
 * say in that.
 *
 * `poIds` is NOT written here. Attaching the POs is a second statement against a second table
 * (`PoInvoiceAssignOps`), and the manager runs the two inside one transaction - an invoice that
 * exists with none of its POs attached is a document with a total and no lines, which is worse than
 * a failed request.
 */
export const InvoiceCreateOps: (
  input: InvoiceTranslatorCreate,
  ctx: WriteContext,
) => SqlOps<InvoiceRow | null> = (input, ctx) => {
  const fields = insertFragments(INVOICE_FIELDS, input);
  const derived = derivedInsert(INVOICE_DERIVED, input);
  // Assembled as two parallel lists and joined once, rather than interpolated as three groups
  // separated by commas. A body naming none of the optional columns is legitimate - the manager
  // always supplies `invPmId`, but an invoice with only a translator and its POs is a valid
  // document - and the three-group form would then emit `(code, translator_id, tran_name, ,
  // created_by)`, which is a syntax error rather than an empty-but-valid INSERT.
  const columns = [
    "inv_tran_code",
    "translator_id",
    "tran_name",
    ...fields.columns,
    ...derived.columns,
    "created_by",
    "created_ip",
  ];
  const values = [
    codeExpression(INVOICE_TRAN_CODE),
    ":translator_id",
    "(SELECT t.tran_name FROM translator t WHERE t.id = :translator_id AND t.deleted = false)",
    ...fields.placeholders,
    ...derived.expressions,
    ":created_by",
    ":created_ip",
  ];
  return {
    sql: `
      INSERT INTO invoice_translator (${columns.join(", ")})
      VALUES (${values.join(", ")})
      RETURNING ${invoiceColumns("invoice_translator")}
    `,
    parameters: [
      ...fields.parameters,
      param("translator_id", input.translatorId, "id"),
      param("created_by", ctx.actor, "text"),
      param("created_ip", ctx.ip, "text"),
    ],
    mapper: (rows) => (rows.length > 0 ? toInvoiceRow(rows[0]!) : null),
  };
};

/**
 * Edit the invoice document.
 *
 * Scoped, so a PM cannot record a payment against an invoice they cannot see. `inv_tran_code` is
 * untouchable: it is printed on a document somebody is holding.
 */
export const InvoiceUpdateOps: (
  caller: NeotmsCaller,
  id: string,
  input: InvoiceTranslatorUpdate,
  ctx: WriteContext,
) => SqlOps<InvoiceRow | null> = (caller, id, input, ctx) => {
  const fields = updateFragments(INVOICE_FIELDS, input);
  const derived = derivedUpdate(INVOICE_DERIVED, input);
  const scope = invoiceScopeClause(caller);
  // `updated_at` and `created_by` go in the same list rather than after it, because the body may
  // legitimately name no column at all: `{ poIds: [...] }` replaces the set of POs on the invoice
  // and changes nothing on this row. A trailing `SET ${fragment},` would then be `SET ,`.
  const assignments = [
    ...[fields.fragment, ...derived].filter((f) => f.length > 0),
    "updated_at = now()",
    "created_by = :created_by",
  ];
  return {
    sql: `
      UPDATE invoice_translator it
         SET ${assignments.join(",\n             ")}
       WHERE it.id = :id
         AND it.deleted = false
      ${scope.fragment}
      RETURNING ${invoiceColumns("it")}
    `,
    parameters: [
      ...fields.parameters,
      param("id", id, "id"),
      param("created_by", ctx.actor, "text"),
      ...scope.parameters,
    ],
    mapper: (rows) => (rows.length > 0 ? toInvoiceRow(rows[0]!) : null),
  };
};

/**
 * Void an invoice.
 *
 * Soft, like every delete in this schema - the document was sent, and a payable that vanishes is a
 * payable nobody can answer a question about. The POs are detached separately
 * (`PoInvoiceDetachOps`), in the same transaction: a PO still pointing at a voided invoice is a PO
 * that can never be re-invoiced, because `PoInvoiceAssignOps` refuses one already on another
 * invoice. Detaching returns the work to the uninvoiced list, which is where it belongs.
 */
export const InvoiceSoftDeleteOps: (
  caller: NeotmsCaller,
  id: string,
  ctx: WriteContext,
) => SqlOps<string | null> = (caller, id, ctx) => {
  const scope = invoiceScopeClause(caller);
  return {
    sql: `
      UPDATE invoice_translator it
         SET deleted = true, updated_at = now(), created_by = :created_by
       WHERE it.id = :id
         AND it.deleted = false
      ${scope.fragment}
      RETURNING it.id AS invoice_id
    `,
    parameters: [param("id", id, "id"), param("created_by", ctx.actor, "text"), ...scope.parameters],
    mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "invoice_id") : null),
  };
};
