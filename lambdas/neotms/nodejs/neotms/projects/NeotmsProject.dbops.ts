// SPDX-License-Identifier: MIT
//
// The project header (legacy PRJTB_MAIN). The customer's order.
//
// Two things make this module different from the customer and translator masters, and both are
// load-bearing:
//
// ## It is row-scoped
//
// A project is the first entity in the chain that belongs to somebody. `scopeClause` is applied to
// the list AND to the single-record read, with the same two ownership columns in both. A list that
// hides a row while the detail endpoint returns it on request is not access control, and it is
// invisible in testing because the list screen looks correct.
//
// `prj_mgr_id` and `prj_pm_id` are both ownership: the sales manager owns the relationship and the
// PM delivers the work, and either of them may legitimately open the project. They are different
// people and different report dimensions - see the DDL comment on project.prj_mgr_id.
//
// ## It carries four denormalised names
//
// `cus_code_name`, `prj_mgr_name`, `prj_pm_name` and `cus_mgr_name` are maintained copies of values
// this database already holds, kept so the list screen does not join four tables per row. None of
// them is accepted from the request; each is written by a scalar subquery against the id the request
// did send. See `DerivedSpec` in NeotmsWrite for why.

import {
  param,
  readId,
  readMoney,
  readText,
  type SortTarget,
  type SqlOps,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import { PROJECT_CODE, codeExpression } from "../NeotmsCodes.js";
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
import type { ProjectCreate, ProjectUpdate } from "../neotms.schemas.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type ProjectRow = {
  id: string;
  prjCode: string;
  prjName: string | null;
  corpId: string | null;
  coinCode: string | null;
  /** The sales manager's `staff.id`. Authoritative; `prjMgrName` is the maintained copy. */
  prjMgrId: string | null;
  prjMgrName: string | null;
  /** The delivery PM's `staff.id`. */
  prjPmId: string | null;
  prjPmName: string | null;
  customerId: string | null;
  cusCodeName: string | null;
  customerContactId: string | null;
  cusMgrName: string | null;
  prjField: string | null;
  prjField2: string | null;
  prjState: string | null;
  prjInvoiceState: string | null;
  prjMoneyState: string | null;
  /** Set by the invoicing module, not editable here. */
  invCode: string | null;
  invDt: string | null;
  prjSday: string | null;
  prjSdayTime: string | null;
  prjEday: string | null;
  prjEdayTime: string | null;
  prjContent: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const projectColumns = (q: string): string => `
  ${q}.id                  AS project_id,
  ${q}.prj_code            AS prj_code,
  ${q}.prj_name            AS prj_name,
  ${q}.corp_id             AS corp_id,
  ${q}.coin_code           AS coin_code,
  ${q}.prj_mgr_id          AS prj_mgr_id,
  ${q}.prj_mgr_name        AS prj_mgr_name,
  ${q}.prj_pm_id           AS prj_pm_id,
  ${q}.prj_pm_name         AS prj_pm_name,
  ${q}.customer_id         AS customer_id,
  ${q}.cus_code_name       AS cus_code_name,
  ${q}.customer_contact_id AS customer_contact_id,
  ${q}.cus_mgr_name        AS cus_mgr_name,
  ${q}.prj_field           AS prj_field,
  ${q}.prj_field2          AS prj_field2,
  ${q}.prj_state           AS prj_state,
  ${q}.prj_invoice_state   AS prj_invoice_state,
  ${q}.prj_money_state     AS prj_money_state,
  ${q}.inv_code            AS inv_code,
  ${q}.inv_dt              AS inv_dt,
  ${q}.prj_sday            AS prj_sday,
  ${q}.prj_sday_time       AS prj_sday_time,
  ${q}.prj_eday            AS prj_eday,
  ${q}.prj_eday_time       AS prj_eday_time,
  ${q}.prj_content         AS prj_content,
  ${q}.created_at          AS created_at,
  ${q}.updated_at          AS updated_at
`;

export const toProjectRow = (row: SqlRow): ProjectRow => ({
  id: readId(row, "project_id") ?? "",
  prjCode: readText(row, "prj_code") ?? "",
  prjName: readText(row, "prj_name"),
  corpId: readId(row, "corp_id"),
  coinCode: readText(row, "coin_code"),
  prjMgrId: readId(row, "prj_mgr_id"),
  prjMgrName: readText(row, "prj_mgr_name"),
  prjPmId: readId(row, "prj_pm_id"),
  prjPmName: readText(row, "prj_pm_name"),
  customerId: readId(row, "customer_id"),
  cusCodeName: readText(row, "cus_code_name"),
  customerContactId: readId(row, "customer_contact_id"),
  cusMgrName: readText(row, "cus_mgr_name"),
  prjField: readText(row, "prj_field"),
  prjField2: readText(row, "prj_field2"),
  prjState: readText(row, "prj_state"),
  prjInvoiceState: readText(row, "prj_invoice_state"),
  prjMoneyState: readText(row, "prj_money_state"),
  invCode: readText(row, "inv_code"),
  invDt: readText(row, "inv_dt"),
  prjSday: readText(row, "prj_sday"),
  prjSdayTime: readText(row, "prj_sday_time"),
  prjEday: readText(row, "prj_eday"),
  prjEdayTime: readText(row, "prj_eday_time"),
  prjContent: readText(row, "prj_content"),
  createdAt: readText(row, "created_at"),
  updatedAt: readText(row, "updated_at"),
});

/* -------------------------------------------------------------------------- */
/* Sorting, searching, filtering, scope                                       */
/* -------------------------------------------------------------------------- */

export const PROJECT_SORTS = {
  created: { column: "p.created_at", cast: "timestamptz" },
  code: { column: "p.prj_code" },
  name: { column: "p.prj_name" },
  /** The deadline. Nullable, hence the cast and the nulls-last ordering. */
  due: { column: "p.prj_eday", cast: "date" },
  start: { column: "p.prj_sday", cast: "date" },
  customer: { column: "p.cus_code_name" },
} as const satisfies Record<string, SortTarget>;

export type ProjectSortKey = keyof typeof PROJECT_SORTS;

/**
 * Columns the free-text search covers. Every one of them has a PGroonga index (003_indexes.sql).
 *
 * The denormalised name columns earn their keep here: searching "삼성" finds the project through
 * `cus_code_name` without a join to `customer`, and searching a PM's name finds everything they are
 * on. That is the actual reason the copies exist - an index serves a column, not a join, so a
 * search that had to reach `customer.cus_name` through `prj_cus_id` could not use one at all.
 */
const PROJECT_SEARCH_COLUMNS = [
  "p.prj_name",
  "p.prj_code",
  "p.cus_code_name",
  "p.prj_mgr_name",
  "p.prj_pm_name",
  "p.cus_mgr_name",
];

const PROJECT_FILTERS = {
  state: { column: "p.prj_state", kind: "text" },
  invoiceState: { column: "p.prj_invoice_state", kind: "text" },
  moneyState: { column: "p.prj_money_state", kind: "text" },
  customerId: { column: "p.customer_id", kind: "id" },
  corpId: { column: "p.corp_id", kind: "id" },
  field: { column: "p.prj_field", kind: "text" },
  pmId: { column: "p.prj_pm_id", kind: "id" },
  salesManagerId: { column: "p.prj_mgr_id", kind: "id" },
} as const satisfies Record<string, FilterSpec>;

export type ProjectFilters = Partial<Record<keyof typeof PROJECT_FILTERS, string>> & {
  /** Inclusive deadline range. The filter every project screen is actually used with. */
  dueFrom?: string;
  dueTo?: string;
};

/**
 * The columns that make a project "yours".
 *
 * Both, not either: a salesperson must see the projects they sold and a PM the ones they run, and a
 * project almost always has two different people in those seats. Narrowing this to one column would
 * hide half of each person's work from them.
 */
const PROJECT_SCOPE_COLUMNS = ["p.prj_mgr_id", "p.prj_pm_id"];

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export const ProjectListOps: (
  caller: NeotmsCaller,
  query: ListQuery<ProjectSortKey>,
  filters: ProjectFilters,
) => SqlOps<SqlRow[]> = (caller, query, filters) => {
  const where = mergeClauses(
    scopeClause(caller, PROJECT_SCOPE_COLUMNS),
    cursorClause(query, "p.id"),
    searchClause(PROJECT_SEARCH_COLUMNS, query.search),
    filterClause(PROJECT_FILTERS, filters),
    rangeClause("due", "p.prj_eday", filters.dueFrom, filters.dueTo),
  );
  const limit = limitClause(query);
  return {
    sql: `
      SELECT ${projectColumns("p")}
        FROM project p
       WHERE p.deleted = false
      ${where.fragment}
      ${orderByClause(query, "p.id")}
      ${limit.fragment}
    `,
    parameters: [...where.parameters, ...limit.parameters],
    mapper: (rows) => rows,
  };
};

/**
 * One project, if this caller may see it.
 *
 * The scope predicate is here as well as on the list, and that is the whole point: a row-level rule
 * enforced only on the list endpoint is defeated by typing an id into the URL. The manager reports a
 * miss as 404 rather than 403, so this endpoint cannot be used to discover which ids exist.
 */
export const ProjectGetOps: (caller: NeotmsCaller, id: string) => SqlOps<ProjectRow | null> = (
  caller,
  id,
) => {
  const scope = scopeClauseForOne(caller, PROJECT_SCOPE_COLUMNS);
  return {
    sql: `
      SELECT ${projectColumns("p")}
        FROM project p
       WHERE p.id = :id
         AND p.deleted = false
      ${scope.fragment}
       LIMIT 1
    `,
    parameters: [param("id", id, "id"), ...scope.parameters],
    mapper: (rows) => (rows.length > 0 ? toProjectRow(rows[0]!) : null),
  };
};

/**
 * Whether this caller may act on this project, without fetching it.
 *
 * Used before creating a job under a project and before editing or deleting the project itself.
 * Returns false both when the project does not exist and when it is out of scope, because the two
 * produce the same answer to the only question being asked.
 */
export const ProjectVisibleOps: (caller: NeotmsCaller, id: string) => SqlOps<boolean> = (
  caller,
  id,
) => {
  const scope = scopeClauseForOne(caller, PROJECT_SCOPE_COLUMNS);
  return {
    sql: `
      SELECT 1 AS visible
        FROM project p
       WHERE p.id = :id
         AND p.deleted = false
      ${scope.fragment}
       LIMIT 1
    `,
    parameters: [param("id", id, "id"), ...scope.parameters],
    mapper: (rows) => rows.length > 0,
  };
};

/** How many live jobs hang off this project. Asked before a delete, for the 409 message. */
export const ProjectLiveJobCountOps: (id: string) => SqlOps<number> = (id) => ({
  sql: `
    SELECT count(*) AS job_count
      FROM job j
     WHERE j.project_id = :id
       AND j.deleted = false
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => Number(rows[0]?.["job_count"] ?? 0),
});

/**
 * The project's revenue, cost and margin, computed in SQL.
 *
 * Every figure is `numeric` arithmetic inside PostgreSQL and comes back as a string: nothing here
 * passes through a JS number, because `numeric(18,2)` exceeds float64's integer precision and a
 * margin is the one number on the screen a person will act on.
 *
 * The two sides are summed in separate subqueries rather than by joining jobs to POs. A join would
 * multiply each job's revenue by its number of POs - a job split between three translators would
 * report three times its real revenue - which is the classic fan-out error in exactly this shape of
 * query, and it reads as "our margins improved" rather than as a bug.
 */
export const ProjectTotalsOps: (id: string) => SqlOps<{
  revenue: string;
  cost: string;
  margin: string;
}> = (id) => ({
  sql: `
    SELECT revenue, cost, (revenue - cost) AS margin
      FROM (
        SELECT
          COALESCE((SELECT sum(j.job_price_ksum)
                      FROM job j
                     WHERE j.project_id = :id
                       AND j.deleted = false), 0) AS revenue,
          COALESCE((SELECT sum(po.po_price_ksum)
                      FROM purchase_order po
                     WHERE po.project_id = :id
                       AND po.deleted = false), 0) AS cost
      ) t
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => ({
    revenue: readMoney(rows[0] ?? {}, "revenue") ?? "0",
    cost: readMoney(rows[0] ?? {}, "cost") ?? "0",
    margin: readMoney(rows[0] ?? {}, "margin") ?? "0",
  }),
});

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The writable columns.
 *
 * Absent on purpose: `prj_code` (minted from a sequence, printed on documents, never changes) and
 * `inv_code` / `inv_dt` (written by the invoicing module when an invoice is issued - editable here,
 * they would let someone mark a project invoiced without an invoice existing).
 */
const PROJECT_FIELDS: readonly FieldSpec<ProjectUpdate>[] = [
  { column: "prj_name", kind: "text", read: (i) => i.prjName },
  { column: "customer_id", kind: "id", read: (i) => i.customerId },
  { column: "customer_contact_id", kind: "id", read: (i) => i.customerContactId },
  { column: "corp_id", kind: "id", read: (i) => i.corpId },
  { column: "coin_code", kind: "text", read: (i) => i.coinCode },
  { column: "prj_mgr_id", kind: "id", read: (i) => i.prjMgrId },
  { column: "prj_pm_id", kind: "id", read: (i) => i.prjPmId },
  { column: "prj_field", kind: "text", read: (i) => i.prjField },
  { column: "prj_field2", kind: "text", read: (i) => i.prjField2 },
  { column: "prj_state", kind: "text", read: (i) => i.prjState },
  { column: "prj_invoice_state", kind: "text", read: (i) => i.prjInvoiceState },
  { column: "prj_money_state", kind: "text", read: (i) => i.prjMoneyState },
  { column: "prj_sday", kind: "date", read: (i) => i.prjSday },
  { column: "prj_sday_time", kind: "time", read: (i) => i.prjSdayTime },
  { column: "prj_eday", kind: "date", read: (i) => i.prjEday },
  { column: "prj_eday_time", kind: "time", read: (i) => i.prjEdayTime },
  { column: "prj_content", kind: "text", read: (i) => i.prjContent },
];

/**
 * The four denormalised names, each driven by the id the request supplied.
 *
 * `deleted = false` on the customer subquery is not belt-and-braces. The foreign key only requires
 * that the customer row exists, and a soft-deleted customer still exists - so the FK would accept a
 * project against a customer nobody can see. The subquery returning NULL is the visible symptom; the
 * manager checks the customer up front so the client gets a sentence instead.
 *
 * `staff` is matched without an `active` filter: a project may legitimately be assigned to someone
 * on leave, and an inactive staff member's name is still the right name to print.
 */
const PROJECT_DERIVED: readonly DerivedSpec<ProjectUpdate>[] = [
  {
    column: "cus_code_name",
    expression: "(SELECT c.cus_name FROM customer c WHERE c.id = :customer_id AND c.deleted = false)",
    read: (i) => i.customerId,
  },
  {
    column: "cus_mgr_name",
    expression:
      "(SELECT cc.cus_mgr_name FROM customer_contact cc WHERE cc.id = :customer_contact_id)",
    read: (i) => i.customerContactId,
  },
  {
    column: "prj_mgr_name",
    expression: "(SELECT s.mgr_name FROM staff s WHERE s.id = :prj_mgr_id AND s.deleted = false)",
    read: (i) => i.prjMgrId,
  },
  {
    column: "prj_pm_name",
    expression: "(SELECT s.mgr_name FROM staff s WHERE s.id = :prj_pm_id AND s.deleted = false)",
    read: (i) => i.prjPmId,
  },
];

export const ProjectCreateOps: (
  input: ProjectCreate,
  ctx: WriteContext,
) => SqlOps<ProjectRow | null> = (input, ctx) => {
  const fields = insertFragments(PROJECT_FIELDS, input);
  const derived = derivedInsert(PROJECT_DERIVED, input);
  return {
    sql: `
      INSERT INTO project (
        prj_code, ${[...fields.columns, ...derived.columns].join(", ")}, created_by, created_ip
      ) VALUES (
        ${codeExpression(PROJECT_CODE)},
        ${[...fields.placeholders, ...derived.expressions].join(", ")},
        :created_by, :created_ip
      )
      RETURNING ${projectColumns("project")}
    `,
    parameters: [
      ...fields.parameters,
      param("created_by", ctx.actor, "text"),
      param("created_ip", ctx.ip, "text"),
    ],
    mapper: (rows) => (rows.length > 0 ? toProjectRow(rows[0]!) : null),
  };
};

/**
 * Edit a project, if this caller may see it.
 *
 * The scope predicate is in the UPDATE itself rather than checked beforehand. A check followed by an
 * unscoped write is a race, and more practically it is two places the rule has to be right; putting
 * it in the statement means a project outside the caller's scope matches no row and the edit comes
 * back as a 404, which is the same answer a read of it would give.
 */
export const ProjectUpdateOps: (
  caller: NeotmsCaller,
  id: string,
  input: ProjectUpdate,
  ctx: WriteContext,
) => SqlOps<ProjectRow | null> = (caller, id, input, ctx) => {
  const fields = updateFragments(PROJECT_FIELDS, input);
  const derived = derivedUpdate(PROJECT_DERIVED, input);
  const scope = scopeClauseForOne(caller, PROJECT_SCOPE_COLUMNS);
  return {
    sql: `
      UPDATE project p
         SET ${[fields.fragment, ...derived].filter((f) => f.length > 0).join(",\n             ")},
             updated_at = now(),
             created_by = :created_by
       WHERE p.id = :id
         AND p.deleted = false
      ${scope.fragment}
      RETURNING ${projectColumns("p")}
    `,
    parameters: [
      ...fields.parameters,
      ...scope.parameters,
      param("id", id, "id"),
      param("created_by", ctx.actor, "text"),
    ],
    mapper: (rows) => (rows.length > 0 ? toProjectRow(rows[0]!) : null),
  };
};

export const ProjectSoftDeleteOps: (
  caller: NeotmsCaller,
  id: string,
  ctx: WriteContext,
) => SqlOps<string | null> = (caller, id, ctx) => {
  const scope = scopeClauseForOne(caller, PROJECT_SCOPE_COLUMNS);
  return {
    sql: `
      UPDATE project p
         SET deleted = true, updated_at = now(), created_by = :created_by
       WHERE p.id = :id
         AND p.deleted = false
      ${scope.fragment}
      RETURNING p.id AS project_id
    `,
    parameters: [
      param("id", id, "id"),
      param("created_by", ctx.actor, "text"),
      ...scope.parameters,
    ],
    mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "project_id") : null),
  };
};
