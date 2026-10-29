// SPDX-License-Identifier: MIT
//
// The purchase order (legacy PRJTB_PO). What we pay a translator.
//
// COST IS BOOKED HERE. `po_price_ksum` is what the reports sum as cost, and margin is the job's
// revenue minus the sum of its POs' cost - so a PO on the wrong job is a margin wrong on two rows of
// every report at once.
//
// ## `project_id` is derived, never accepted
//
// The column exists - the legacy table carries it and the reports read it - but it is written from
// the PO's job rather than from the request. Accepting both would allow a PO whose project
// disagrees with its job's project, which puts the revenue and the cost on different rollup rows.
// The manager reads the job's project id (see `JobProjectOps`) and passes it in as context.
//
// ## The scope reaches two tables up
//
// A PO is visible to its own PM, to its job's PM, and to the project's sales manager and PM - four
// columns across three tables, all ORed. Both joins are therefore on every read, including the
// single-record one.

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
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import { PO_CODE, codeExpression } from "../NeotmsCodes.js";
import {
  cursorClause,
  filterClause,
  limitClause,
  mergeClauses,
  orderByClause,
  rangeClause,
  scopeClause,
  scopeClauseForOne,
  searchClause,
  type FilterSpec,
  type ListQuery,
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
import type { PurchaseOrderCreate, PurchaseOrderUpdate } from "../neotms.schemas.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type PurchaseOrderRow = {
  id: string;
  poCode: string;
  jobId: string;
  projectId: string | null;
  /** Carried from the joined job and project, so a PO list shows what it is paying for. */
  jobCode: string | null;
  jobName: string | null;
  prjCode: string | null;
  prjName: string | null;
  poName: string | null;
  poWorkCode: string | null;
  poCatUse: boolean;
  poCatWord: string | null;
  poCatMid: string | null;
  poCatStotal: string | null;
  poPmId: string | null;
  poPmName: string | null;
  translatorId: string | null;
  poTranName: string | null;
  poSlang: string | null;
  poElang: string | null;
  poVolume: string | null;
  poUnitCode: string | null;
  poPriceSel: string | null;
  poPrice: string | null;
  poCoinCode: string | null;
  poCoinRate: string | null;
  poPriceSum: string | null;
  /** KRW total. This is cost. */
  poPriceKsum: string | null;
  poTax: string | null;
  poTaxPrice: string | null;
  poTaxSum: string | null;
  poSday: string | null;
  poSdayTime: string | null;
  poEday: string | null;
  poEdayTime: string | null;
  poLang: string | null;
  poContent: string | null;
  poState: string | null;
  /** When the state last changed. Written by the server, not by the client. */
  poStateDt: string | null;
  poInvoiceState: string | null;
  poMoneyState: string | null;
  poMoneyDay: string | null;
  poMoneyPrice: string | null;
  poMoneyGubun: string | null;
  invCode: string | null;
  invDt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const poColumns = (q: string): string => `
  ${q}.id               AS po_id,
  ${q}.po_code          AS po_code,
  ${q}.job_id           AS po_job_id,
  ${q}.project_id       AS po_project_id,
  ${q}.po_name          AS po_name,
  ${q}.po_work_code     AS po_work_code,
  ${q}.po_cat_use       AS po_cat_use,
  ${q}.po_cat_word      AS po_cat_word,
  ${q}.po_cat_mid       AS po_cat_mid,
  ${q}.po_cat_stotal    AS po_cat_stotal,
  ${q}.po_pm_id         AS po_pm_id,
  ${q}.po_pm_name       AS po_pm_name,
  ${q}.translator_id    AS translator_id,
  ${q}.po_tran_name     AS po_tran_name,
  ${q}.po_slang         AS po_slang,
  ${q}.po_elang         AS po_elang,
  ${q}.po_volume        AS po_volume,
  ${q}.po_unit_code     AS po_unit_code,
  ${q}.po_price_sel     AS po_price_sel,
  ${q}.po_price         AS po_price,
  ${q}.po_coin_code     AS po_coin_code,
  ${q}.po_coin_rate     AS po_coin_rate,
  ${q}.po_price_sum     AS po_price_sum,
  ${q}.po_price_ksum    AS po_price_ksum,
  ${q}.po_tax           AS po_tax,
  ${q}.po_tax_price     AS po_tax_price,
  ${q}.po_tax_sum       AS po_tax_sum,
  ${q}.po_sday          AS po_sday,
  ${q}.po_sday_time     AS po_sday_time,
  ${q}.po_eday          AS po_eday,
  ${q}.po_eday_time     AS po_eday_time,
  ${q}.po_lang          AS po_lang,
  ${q}.po_content       AS po_content,
  ${q}.po_state         AS po_state,
  ${q}.po_state_dt      AS po_state_dt,
  ${q}.po_invoice_state AS po_invoice_state,
  ${q}.po_money_state   AS po_money_state,
  ${q}.po_money_day     AS po_money_day,
  ${q}.po_money_price   AS po_money_price,
  ${q}.po_money_gubun   AS po_money_gubun,
  ${q}.inv_code         AS po_inv_code,
  ${q}.inv_dt           AS po_inv_dt,
  ${q}.created_at       AS po_created_at,
  ${q}.updated_at       AS po_updated_at
`;

/**
 * The job and project columns a PO row carries.
 *
 * Every one is prefixed, and the PO's own columns above are prefixed `po_` even where the column
 * name already starts with it - `created_at` becomes `po_created_at`. Three tables in one row means
 * three `created_at`s, three `inv_code`s and three id columns; under `formatRecordsAs: "JSON"` the
 * duplicates collapse into one key, last writer wins, no error. Prefixing everything is what makes
 * that impossible rather than merely unlikely.
 */
const PO_PARENT_COLUMNS = `
  j.job_code      AS job_code,
  j.job_name      AS job_name,
  p.prj_code      AS prj_code,
  p.prj_name      AS prj_name
`;

export const toPurchaseOrderRow = (row: SqlRow): PurchaseOrderRow => ({
  id: readId(row, "po_id") ?? "",
  poCode: readText(row, "po_code") ?? "",
  jobId: readId(row, "po_job_id") ?? "",
  projectId: readId(row, "po_project_id"),
  jobCode: readText(row, "job_code"),
  jobName: readText(row, "job_name"),
  prjCode: readText(row, "prj_code"),
  prjName: readText(row, "prj_name"),
  poName: readText(row, "po_name"),
  poWorkCode: readText(row, "po_work_code"),
  poCatUse: readBool(row, "po_cat_use") ?? false,
  poCatWord: readMoney(row, "po_cat_word"),
  poCatMid: readMoney(row, "po_cat_mid"),
  poCatStotal: readMoney(row, "po_cat_stotal"),
  poPmId: readId(row, "po_pm_id"),
  poPmName: readText(row, "po_pm_name"),
  translatorId: readId(row, "translator_id"),
  poTranName: readText(row, "po_tran_name"),
  poSlang: readText(row, "po_slang"),
  poElang: readText(row, "po_elang"),
  poVolume: readMoney(row, "po_volume"),
  poUnitCode: readText(row, "po_unit_code"),
  poPriceSel: readText(row, "po_price_sel"),
  poPrice: readMoney(row, "po_price"),
  poCoinCode: readText(row, "po_coin_code"),
  poCoinRate: readMoney(row, "po_coin_rate"),
  poPriceSum: readMoney(row, "po_price_sum"),
  poPriceKsum: readMoney(row, "po_price_ksum"),
  poTax: readMoney(row, "po_tax"),
  poTaxPrice: readMoney(row, "po_tax_price"),
  poTaxSum: readMoney(row, "po_tax_sum"),
  poSday: readText(row, "po_sday"),
  poSdayTime: readText(row, "po_sday_time"),
  poEday: readText(row, "po_eday"),
  poEdayTime: readText(row, "po_eday_time"),
  poLang: readText(row, "po_lang"),
  poContent: readText(row, "po_content"),
  poState: readText(row, "po_state"),
  poStateDt: readText(row, "po_state_dt"),
  poInvoiceState: readText(row, "po_invoice_state"),
  poMoneyState: readText(row, "po_money_state"),
  poMoneyDay: readText(row, "po_money_day"),
  poMoneyPrice: readMoney(row, "po_money_price"),
  poMoneyGubun: readText(row, "po_money_gubun"),
  invCode: readText(row, "po_inv_code"),
  invDt: readText(row, "po_inv_dt"),
  createdAt: readText(row, "po_created_at"),
  updatedAt: readText(row, "po_updated_at"),
});

/* -------------------------------------------------------------------------- */
/* Sorting, searching, filtering, scope                                       */
/* -------------------------------------------------------------------------- */

/**
 * Sort keys.
 *
 * Note that `created` aliases to `po_created_at`, not `created_at` - which breaks the convention
 * `sortAlias` relies on, so it is handled explicitly: see `PO_SORT_ALIASES` below.
 */
export const PO_SORTS = {
  created: { column: "po.created_at", cast: "timestamptz" },
  code: { column: "po.po_code" },
  name: { column: "po.po_name" },
  /** The translator's deadline. */
  due: { column: "po.po_eday", cast: "date" },
  start: { column: "po.po_sday", cast: "date" },
  amount: { column: "po.po_price_ksum", cast: "numeric" },
  /** When the money was paid. The column the settlement screen is read by. */
  paid: { column: "po.po_money_day", cast: "date" },
} as const satisfies Record<string, SortTarget>;

export type PoSortKey = keyof typeof PO_SORTS;

/**
 * The row key each sort column arrives under.
 *
 * `sortAlias` derives the alias from the column name, which works everywhere else because every
 * sortable column is aliased to its bare name. Here it cannot be: a PO row carries three tables'
 * columns and `created_at` had to be prefixed to avoid collapsing into the job's. So the mapping is
 * written out, and `paginate` is given a value from this map rather than from `sortAlias`.
 *
 * If a sort key is added to `PO_SORTS` and not here, TypeScript fails the build - the record is
 * exhaustive by type, not by diligence. That matters because the failure mode is silent: the cursor
 * would read as undefined and the next page would repeat the first.
 */
export const PO_SORT_ALIASES: Record<PoSortKey, string> = {
  created: "po_created_at",
  code: "po_code",
  name: "po_name",
  due: "po_eday",
  start: "po_sday",
  amount: "po_price_ksum",
  paid: "po_money_day",
};

/** `po.po_name` and `po.po_tran_name` carry PGroonga indexes, as do the job and project names. */
const PO_SEARCH_COLUMNS = [
  "po.po_name",
  "po.po_tran_name",
  "po.po_code",
  "po.po_pm_name",
  "j.job_name",
  "p.prj_name",
  "p.cus_code_name",
];

const PO_FILTERS = {
  jobId: { column: "po.job_id", kind: "id" },
  projectId: { column: "po.project_id", kind: "id" },
  translatorId: { column: "po.translator_id", kind: "id" },
  state: { column: "po.po_state", kind: "text" },
  invoiceState: { column: "po.po_invoice_state", kind: "text" },
  moneyState: { column: "po.po_money_state", kind: "text" },
  pmId: { column: "po.po_pm_id", kind: "id" },
  workCode: { column: "po.po_work_code", kind: "text" },
  slang: { column: "po.po_slang", kind: "text" },
  elang: { column: "po.po_elang", kind: "text" },
  customerId: { column: "p.customer_id", kind: "id" },
  corpId: { column: "p.corp_id", kind: "id" },
} as const satisfies Record<string, FilterSpec>;

export type PoFilters = Partial<Record<keyof typeof PO_FILTERS, string>> & {
  dueFrom?: string;
  dueTo?: string;
  /** Settlement date range. The accounts screen's primary filter. */
  paidFrom?: string;
  paidTo?: string;
};

const PO_SCOPE_COLUMNS = ["po.po_pm_id", "j.job_pm_id", "p.prj_mgr_id", "p.prj_pm_id"];

const PO_FROM = `
    FROM purchase_order po
    JOIN job j     ON j.id = po.job_id      AND j.deleted = false
    JOIN project p ON p.id = j.project_id   AND p.deleted = false
`;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One page of purchase orders.
 *
 * The project is joined through the JOB, not through `po.project_id`. Both would usually give the
 * same row, and that is the point: joining through the job makes the job the single authority for
 * which project a PO belongs to, so a `po.project_id` that somehow disagreed - a legacy row, a bad
 * migration - cannot change which project's scope and which customer's filter apply to this PO. The
 * denormalised column is returned for reference and never relied on.
 */
export const PoListOps: (
  caller: NeotmsCaller,
  query: ListQuery<PoSortKey>,
  filters: PoFilters,
) => SqlOps<SqlRow[]> = (caller, query, filters) => {
  const where = mergeClauses(
    scopeClause(caller, PO_SCOPE_COLUMNS),
    cursorClause(query, "po.id"),
    searchClause(PO_SEARCH_COLUMNS, query.search),
    filterClause(PO_FILTERS, filters),
    rangeClause("due", "po.po_eday", filters.dueFrom, filters.dueTo),
    rangeClause("paid", "po.po_money_day", filters.paidFrom, filters.paidTo),
  );
  const limit = limitClause(query);
  return {
    sql: `
      SELECT ${poColumns("po")},
      ${PO_PARENT_COLUMNS}
      ${PO_FROM}
       WHERE po.deleted = false
      ${where.fragment}
      ${orderByClause(query, "po.id")}
      ${limit.fragment}
    `,
    parameters: [...where.parameters, ...limit.parameters],
    mapper: (rows) => rows,
  };
};

export const PoGetOps: (caller: NeotmsCaller, id: string) => SqlOps<PurchaseOrderRow | null> = (
  caller,
  id,
) => {
  const scope = scopeClauseForOne(caller, PO_SCOPE_COLUMNS);
  return {
    sql: `
      SELECT ${poColumns("po")},
      ${PO_PARENT_COLUMNS}
      ${PO_FROM}
       WHERE po.id = :id
         AND po.deleted = false
      ${scope.fragment}
       LIMIT 1
    `,
    parameters: [param("id", id, "id"), ...scope.parameters],
    mapper: (rows) => (rows.length > 0 ? toPurchaseOrderRow(rows[0]!) : null),
  };
};

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The writable columns.
 *
 * Absent on purpose: `po_code` (minted, printed on the PO the translator receives), `inv_code` /
 * `inv_dt` (the invoicing module's), `po_state_dt` (set in SQL whenever the state changes - a
 * client-supplied "when did this change" is not an audit trail), and `project_id`, which is written
 * from the job. See the module header.
 */
const PO_FIELDS: readonly FieldSpec<PurchaseOrderUpdate & { jobId?: string }>[] = [
  { column: "job_id", kind: "id", read: (i) => i.jobId },
  { column: "po_name", kind: "text", read: (i) => i.poName },
  { column: "po_work_code", kind: "text", read: (i) => i.poWorkCode },
  { column: "po_cat_use", kind: "bool", read: (i) => i.poCatUse },
  { column: "po_cat_word", kind: "money", read: (i) => i.poCatWord },
  { column: "po_cat_mid", kind: "money", read: (i) => i.poCatMid },
  { column: "po_cat_stotal", kind: "money", read: (i) => i.poCatStotal },
  { column: "po_pm_id", kind: "id", read: (i) => i.poPmId },
  { column: "translator_id", kind: "id", read: (i) => i.translatorId },
  { column: "po_slang", kind: "text", read: (i) => i.poSlang },
  { column: "po_elang", kind: "text", read: (i) => i.poElang },
  { column: "po_volume", kind: "money", read: (i) => i.poVolume },
  { column: "po_unit_code", kind: "text", read: (i) => i.poUnitCode },
  { column: "po_price_sel", kind: "text", read: (i) => i.poPriceSel },
  { column: "po_price", kind: "money", read: (i) => i.poPrice },
  { column: "po_coin_code", kind: "text", read: (i) => i.poCoinCode },
  { column: "po_coin_rate", kind: "money", read: (i) => i.poCoinRate },
  { column: "po_price_sum", kind: "money", read: (i) => i.poPriceSum },
  { column: "po_price_ksum", kind: "money", read: (i) => i.poPriceKsum },
  { column: "po_tax", kind: "money", read: (i) => i.poTax },
  { column: "po_tax_price", kind: "money", read: (i) => i.poTaxPrice },
  { column: "po_tax_sum", kind: "money", read: (i) => i.poTaxSum },
  { column: "po_sday", kind: "date", read: (i) => i.poSday },
  { column: "po_sday_time", kind: "time", read: (i) => i.poSdayTime },
  { column: "po_eday", kind: "date", read: (i) => i.poEday },
  { column: "po_eday_time", kind: "time", read: (i) => i.poEdayTime },
  { column: "po_lang", kind: "text", read: (i) => i.poLang },
  { column: "po_content", kind: "text", read: (i) => i.poContent },
  { column: "po_state", kind: "text", read: (i) => i.poState },
  { column: "po_invoice_state", kind: "text", read: (i) => i.poInvoiceState },
  { column: "po_money_state", kind: "text", read: (i) => i.poMoneyState },
  { column: "po_money_day", kind: "date", read: (i) => i.poMoneyDay },
  { column: "po_money_price", kind: "money", read: (i) => i.poMoneyPrice },
  { column: "po_money_gubun", kind: "text", read: (i) => i.poMoneyGubun },
];

/**
 * The two denormalised names.
 *
 * `po_tran_name` is the one that matters: it is among the most-searched columns in the application
 * (an accounts clerk looking up what a translator is owed searches by name), and a copy that
 * disagreed with `translator_id` would make that search return the wrong person's POs.
 */
const PO_DERIVED: readonly DerivedSpec<PurchaseOrderUpdate>[] = [
  {
    column: "po_tran_name",
    expression:
      "(SELECT t.tran_name FROM translator t WHERE t.id = :translator_id AND t.deleted = false)",
    read: (i) => i.translatorId,
  },
  {
    column: "po_pm_name",
    expression: "(SELECT s.mgr_name FROM staff s WHERE s.id = :po_pm_id AND s.deleted = false)",
    read: (i) => i.poPmId,
  },
];

/**
 * Create a purchase order.
 *
 * `projectId` is a separate argument rather than part of `input`, which is the type system carrying
 * the rule: `PurchaseOrderCreateSchema` has no `projectId` field, so there is no way to pass a
 * client-supplied one here even by mistake. The manager obtains it from the job.
 *
 * `po_state_dt` is stamped with `now()` on creation, because a PO's first state is a state change.
 */
export const PoCreateOps: (
  input: PurchaseOrderCreate,
  projectId: string | null,
  ctx: WriteContext,
) => SqlOps<PurchaseOrderRow | null> = (input, projectId, ctx) => {
  const fields = insertFragments(PO_FIELDS, input);
  const derived = derivedInsert(PO_DERIVED, input);
  return {
    sql: `
      INSERT INTO purchase_order (
        po_code, project_id,
        ${[...fields.columns, ...derived.columns].join(", ")},
        po_state_dt, created_by, created_ip
      ) VALUES (
        ${codeExpression(PO_CODE)}, :project_id,
        ${[...fields.placeholders, ...derived.expressions].join(", ")},
        now(), :created_by, :created_ip
      )
      RETURNING ${poColumns("purchase_order")}
    `,
    parameters: [
      ...fields.parameters,
      param("project_id", projectId, "id"),
      param("created_by", ctx.actor, "text"),
      param("created_ip", ctx.ip, "text"),
    ],
    mapper: (rows) => (rows.length > 0 ? toPurchaseOrderRow(rows[0]!) : null),
  };
};

/**
 * Edit a purchase order.
 *
 * `po_state_dt` is advanced only when `po_state` is part of this edit. A CASE expression rather than
 * a conditional fragment, so the column is always assigned and the statement shape does not depend
 * on the body: when the state is unchanged it is assigned its own value, which PostgreSQL treats as
 * a no-op write.
 *
 * Why it matters: `po_state_dt` is how long a PO has sat unacknowledged, which is the number a PM
 * chases translators by. Touching it on every edit - a typo fixed in the memo - would reset that
 * clock and make the oldest problems look new.
 */
export const PoUpdateOps: (
  caller: NeotmsCaller,
  id: string,
  input: PurchaseOrderUpdate,
  ctx: WriteContext,
) => SqlOps<PurchaseOrderRow | null> = (caller, id, input, ctx) => {
  const fields = updateFragments(PO_FIELDS, input);
  const derived = derivedUpdate(PO_DERIVED, input);
  const scope = scopeClauseForOne(caller, PO_SCOPE_COLUMNS);
  const stateTouched = input.poState !== undefined;
  return {
    sql: `
      UPDATE purchase_order po
         SET ${[fields.fragment, ...derived].filter((f) => f.length > 0).join(",\n             ")},
             ${stateTouched ? "po_state_dt = now()," : ""}
             updated_at = now(),
             created_by = :created_by
        FROM job j, project p
       WHERE po.id = :id
         AND po.deleted = false
         AND j.id = po.job_id
         AND j.deleted = false
         AND p.id = j.project_id
         AND p.deleted = false
      ${scope.fragment}
      RETURNING ${poColumns("po")}
    `,
    parameters: [
      ...fields.parameters,
      ...scope.parameters,
      param("id", id, "id"),
      param("created_by", ctx.actor, "text"),
    ],
    // No job or project columns - RETURNING cannot reach the tables in the FROM clause of an
    // UPDATE. The manager re-reads, as it does after a create.
    mapper: (rows) => (rows.length > 0 ? toPurchaseOrderRow(rows[0]!) : null),
  };
};

export const PoSoftDeleteOps: (
  caller: NeotmsCaller,
  id: string,
  ctx: WriteContext,
) => SqlOps<string | null> = (caller, id, ctx) => {
  const scope = scopeClauseForOne(caller, PO_SCOPE_COLUMNS);
  return {
    sql: `
      UPDATE purchase_order po
         SET deleted = true, updated_at = now(), created_by = :created_by
        FROM job j, project p
       WHERE po.id = :id
         AND po.deleted = false
         AND j.id = po.job_id
         AND j.deleted = false
         AND p.id = j.project_id
         AND p.deleted = false
      ${scope.fragment}
      RETURNING po.id AS po_id
    `,
    parameters: [
      param("id", id, "id"),
      param("created_by", ctx.actor, "text"),
      ...scope.parameters,
    ],
    mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "po_id") : null),
  };
};
