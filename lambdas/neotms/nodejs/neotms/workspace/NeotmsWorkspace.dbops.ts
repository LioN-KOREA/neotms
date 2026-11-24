// SPDX-License-Identifier: MIT
//
// 나의 업무 - one PM's own worksheet, and the columns they have added to it.
//
// ## What a row is
//
// One purchase order, under a job, under a project this caller is the PM of AND has accepted.
// Fourteen columns are fixed and come from those three rows; the rest are the caller's own.
//
// A job with no PO yet is therefore NOT a row, which is a deliberate narrowing of the sheet and the
// one thing about it worth knowing before reading a figure off it: a job whose translator has not
// been engaged is invisible here. `WorkspaceUnplacedJobsOps` counts exactly those so the screen can
// say how many it is not showing - a count is not a substitute for the rows, but it is the
// difference between a sheet that is incomplete and a sheet that is incomplete in silence.
//
// ## The WHERE clause IS the authorization
//
// Every other list in this repository calls `scopeClause` and ORs the caller into the row's
// ownership columns. This one does not, and an omission that is deliberate has to say so.
//
// `p.prj_pm_id = :pm_id` is one of the four columns `PO_SCOPE_COLUMNS` would OR together, and it is
// the narrowest of them. So every row this query can return already satisfies that scope, for every
// caller, whatever their view scope - and `scopeClause` would be a fifth copy of a column list
// whose drift the PO module's own scope comment warns about. The sheet is not "POs I may see"; it
// is "POs I am answerable for", which is a smaller question with a single-column answer.
//
// The consequence to keep in mind: a superuser gets their OWN sheet here, not everybody's. That is
// the intent - 나의 업무 is first-person - and it is why this module takes a staff id rather than a
// `NeotmsCaller`.
//
// ## Why the custom values come back in the row query
//
// As a scalar subquery per row, aggregated into one jsonb object. Three alternatives were worse:
// a join would fan each row out once per annotated column; a second round trip would have to send
// the page's PO ids back up and be merged in TypeScript, which is a second place for a row and its
// values to be paired wrongly; and a document store would put them outside SQL altogether, where
// the scope predicate above cannot reach.

import {
  param,
  readBool,
  readId,
  readInt,
  readMoney,
  readText,
  type SortTarget,
  type SqlOps,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import {
  cursorClause,
  limitClause,
  mergeClauses,
  orderByClause,
  type ListQuery,
} from "../NeotmsQuery.js";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** One custom column on one person's sheet. */
export type WorkspaceColumn = {
  id: string;
  label: string;
  ordNo: number;
};

/**
 * One row of the sheet: a PO, with its job and project denormalised onto it.
 *
 * `poApproved` and `poMoneyState` are here although no column displays them. The 번역가 cell has to
 * be locked on an approved or settled PO - an approval record is a statement about one particular
 * person, and a payment record is a statement about where money went - and the grid decides that
 * with the same two fields `mayChangeTranslator` reads on the PO screens. Shipping the verdict
 * instead of the facts would be a second implementation of that rule.
 *
 * `jobType` is here for the same kind of reason: a MICE or IMC job has no language pair at all, so
 * the 출발어 and 도착어 cells have nothing to edit on those rows.
 */
export type WorkspaceRow = {
  poId: string;
  poCode: string;
  jobId: string;
  jobCode: string;
  jobName: string | null;
  projectId: string;
  prjCode: string;
  prjName: string | null;
  /** 인계일 - when this PM accepted the project. See `WORKSPACE_FROM`. */
  handoverAt: string | null;
  cusCodeName: string | null;
  cusMgrName: string | null;
  prjMgrName: string | null;
  prjField: string | null;
  jobType: string | null;
  jobSlang: string | null;
  jobElang: string | null;
  translatorId: string | null;
  poTranName: string | null;
  poVolume: string | null;
  poUnitCode: string | null;
  poEday: string | null;
  poState: string | null;
  poApproved: boolean;
  poMoneyState: string | null;
  /**
   * The PO's currency. On the sheet it is not a column.
   *
   * It is here because the 번역가 cell opens `TranslatorSwapModal`, which names the currency when
   * warning that a new translator may settle in a different one. Sending it is what lets that
   * dialog be reused whole rather than reimplemented against a row that lacks one of its fields.
   */
  poCoinCode: string | null;
  /** The caller's own columns, keyed by column id. Absent keys are empty cells. */
  cells: Record<string, string>;
};

/* -------------------------------------------------------------------------- */
/* The sheet                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 인계일, as a lateral rather than a join.
 *
 * `project_acceptance` is append-only and a reassigned project collects more than one row, so a
 * plain join would multiply every PO of a twice-answered project. `LIMIT 1` inside the lateral is
 * what keeps one row one row - the same shape the dashboard's acceptance panel uses, and for the
 * same reason.
 *
 * The latest ACCEPTING answer, specifically. A rejection is not a handover, and the sheet only
 * shows accepted projects anyway, so every row has one of these - a null here means the project's
 * acceptance predates this table, which a legacy load can produce.
 */
const HANDOVER_LATERAL = `
    LEFT JOIN LATERAL (
      SELECT pa.created_at
        FROM project_acceptance pa
       WHERE pa.project_id = p.id
         AND pa.acceptance_status = 1
       ORDER BY pa.created_at DESC
       LIMIT 1
    ) acc ON true
`;

const WORKSPACE_FROM = `
    FROM purchase_order po
    JOIN job j ON j.id = po.job_id AND j.deleted = false
    JOIN project p ON p.id = j.project_id AND p.deleted = false
    LEFT JOIN po_detail_linguistic pdl ON pdl.po_id = po.id
    LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
${HANDOVER_LATERAL}
`;

/**
 * The caller's own cell values for one row, as `{"<column id>": "<value>"}`.
 *
 * Joined to `workspace_column` rather than read from `workspace_cell` alone, because the staff id
 * lives on the column: without it this would return every user's annotations on this PO, which is
 * the one way this feature could leak something. The predicate is the privacy boundary.
 *
 * `cell_text IS NOT NULL` because a cleared cell is deleted rather than stored as a null (see
 * `WorkspaceCellWriteOps`), so a null here would be a row nothing can produce - and
 * `jsonb_object_agg` would turn it into a JSON null the client then has to tell apart from "".
 */
const WORKSPACE_CELLS = `
  (SELECT jsonb_object_agg(wc.column_id::text, wc.cell_text)
     FROM workspace_cell wc
     JOIN workspace_column wcol ON wcol.id = wc.column_id
    WHERE wc.po_id = po.id
      AND wcol.staff_id = :pm_id
      AND wc.cell_text IS NOT NULL) AS cells
`;

export const WORKSPACE_SORTS = {
  /** The deadline. Default, ascending: the sheet is a queue, and a queue starts with what is next. */
  due: { column: "po.po_eday", cast: "date" },
  code: { column: "po.po_code" },
  project: { column: "p.prj_code" },
  created: { column: "po.created_at", cast: "timestamptz" },
} as const satisfies Record<string, SortTarget>;

export type WorkspaceSortKey = keyof typeof WORKSPACE_SORTS;

/**
 * Every PO the caller is answerable for, newest deadline first.
 *
 * `p.acceptance_status = 1` is half the specification and not an optimisation: a project the PM has
 * not answered, or has rejected, is not their work yet. Those projects are on the PM dashboard,
 * which is where they are accepted - so the two screens hand off to each other rather than
 * overlapping.
 */
export const WorkspaceSheetOps: (
  staffId: string,
  query: ListQuery<WorkspaceSortKey>,
) => SqlOps<SqlRow[]> = (staffId, query) => {
  const where = mergeClauses(cursorClause(query, "po.id"));
  const limit = limitClause(query);
  return {
    sql: `
      SELECT
        po.id             AS po_id,
        po.po_code        AS po_code,
        po.translator_id  AS translator_id,
        po.po_tran_name   AS po_tran_name,
        po.po_state       AS po_state,
        po.po_eday        AS po_eday,
        po.po_approved    AS po_approved,
        po.po_money_state AS po_money_state,
        po.po_coin_code   AS po_coin_code,
        po.created_at     AS created_at,
        pdl.po_volume     AS po_volume,
        pdl.po_unit_code  AS po_unit_code,
        j.id              AS job_id,
        j.job_code        AS job_code,
        j.job_name        AS job_name,
        j.job_type        AS job_type,
        jdl.job_slang     AS job_slang,
        jdl.job_elang     AS job_elang,
        p.id              AS project_id,
        p.prj_code        AS prj_code,
        p.prj_name        AS prj_name,
        p.cus_code_name   AS cus_code_name,
        p.cus_mgr_name    AS cus_mgr_name,
        p.prj_mgr_name    AS prj_mgr_name,
        p.prj_field       AS prj_field,
        acc.created_at    AS handover_at,
      ${WORKSPACE_CELLS}
      ${WORKSPACE_FROM}
       WHERE po.deleted = false
         AND p.prj_pm_id = :pm_id
         AND p.acceptance_status = 1
      ${where.fragment}
      ${orderByClause(query, "po.id")}
      ${limit.fragment}
    `,
    parameters: [param("pm_id", staffId, "id"), ...where.parameters, ...limit.parameters],
    mapper: (rows) => rows,
  };
};

/** The jsonb object from `WORKSPACE_CELLS`, defended against anything that is not one. */
const readCells = (row: SqlRow): Record<string, string> => {
  const raw = row["cells"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
};

export const toWorkspaceRow = (row: SqlRow): WorkspaceRow => ({
  poId: readId(row, "po_id") ?? "",
  poCode: readText(row, "po_code") ?? "",
  jobId: readId(row, "job_id") ?? "",
  jobCode: readText(row, "job_code") ?? "",
  jobName: readText(row, "job_name"),
  projectId: readId(row, "project_id") ?? "",
  prjCode: readText(row, "prj_code") ?? "",
  prjName: readText(row, "prj_name"),
  handoverAt: readText(row, "handover_at"),
  cusCodeName: readText(row, "cus_code_name"),
  cusMgrName: readText(row, "cus_mgr_name"),
  prjMgrName: readText(row, "prj_mgr_name"),
  prjField: readText(row, "prj_field"),
  jobType: readText(row, "job_type"),
  jobSlang: readText(row, "job_slang"),
  jobElang: readText(row, "job_elang"),
  translatorId: readId(row, "translator_id"),
  poTranName: readText(row, "po_tran_name"),
  poVolume: readMoney(row, "po_volume"),
  poUnitCode: readText(row, "po_unit_code"),
  poEday: readText(row, "po_eday"),
  poState: readText(row, "po_state"),
  poApproved: readBool(row, "po_approved") ?? false,
  poMoneyState: readText(row, "po_money_state"),
  poCoinCode: readText(row, "po_coin_code"),
  cells: readCells(row),
});

/**
 * How many of this PM's jobs have no live PO, and so no row on the sheet.
 *
 * The sheet is one row per PO by specification. This count is what keeps that from being a silent
 * omission: a job with no PO is usually a job whose translator has not been engaged, which is work
 * the PM still owns and the one thing a worksheet must not hide without saying so.
 */
export const WorkspaceUnplacedJobsOps: (staffId: string) => SqlOps<number> = (staffId) => ({
  sql: `
    SELECT count(*) AS unplaced
      FROM job j
      JOIN project p ON p.id = j.project_id AND p.deleted = false
     WHERE j.deleted = false
       AND p.prj_pm_id = :pm_id
       AND p.acceptance_status = 1
       AND NOT EXISTS (
             SELECT 1
               FROM purchase_order po
              WHERE po.job_id = j.id
                AND po.deleted = false
           )
  `,
  parameters: [param("pm_id", staffId, "id")],
  mapper: (rows) => readInt(rows[0] ?? {}, "unplaced") ?? 0,
});

/* -------------------------------------------------------------------------- */
/* The caller's own columns                                                   */
/* -------------------------------------------------------------------------- */

const COLUMN_RETURNING = "id AS column_id, col_label AS col_label, ord_no AS ord_no";

const toWorkspaceColumn = (row: SqlRow): WorkspaceColumn => ({
  id: readId(row, "column_id") ?? "",
  label: readText(row, "col_label") ?? "",
  ordNo: readInt(row, "ord_no") ?? 0,
});

/**
 * One person's custom columns, in sheet order.
 *
 * `staff_id = :staff_id` on every statement in this section, and it is never a pre-check followed
 * by an unscoped write. That is the rule the whole repository follows for row-level authority: the
 * predicate travels inside the statement, so a request naming somebody else's column affects zero
 * rows and is reported as "not found" rather than being refused by a check somebody could forget.
 */
export const WorkspaceColumnsOps: (staffId: string) => SqlOps<WorkspaceColumn[]> = (staffId) => ({
  sql: `
    SELECT ${COLUMN_RETURNING}
      FROM workspace_column
     WHERE staff_id = :staff_id
     ORDER BY ord_no, id
  `,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => rows.map(toWorkspaceColumn),
});

/**
 * Add a column, at the right-hand end.
 *
 * `ord_no` is computed in the statement from the caller's own maximum rather than sent by the
 * client. A client-chosen position would have to be unique to mean anything, and two tabs adding a
 * column at the same time would then collide on a constraint the user never heard of; computing it
 * here makes "last" the only position a new column can have, which is also where the user is
 * looking when they press the button.
 */
export const WorkspaceColumnCreateOps: (
  staffId: string,
  label: string,
  actor: string | null,
  ip: string | null,
) => SqlOps<WorkspaceColumn | null> = (staffId, label, actor, ip) => ({
  sql: `
    INSERT INTO workspace_column (staff_id, col_label, ord_no, created_by, created_ip)
    SELECT :staff_id,
           :col_label,
           COALESCE(
             (SELECT max(ord_no) + 1 FROM workspace_column WHERE staff_id = :staff_id),
             0
           ),
           :actor,
           :ip
    RETURNING ${COLUMN_RETURNING}
  `,
  parameters: [
    param("staff_id", staffId, "id"),
    param("col_label", label, "text"),
    param("actor", actor, "text"),
    param("ip", ip, "text"),
  ],
  mapper: (rows) => (rows[0] ? toWorkspaceColumn(rows[0]) : null),
});

/** Rename a column. Returns null when the id is not one of this caller's - see `WorkspaceColumnsOps`. */
export const WorkspaceColumnRenameOps: (
  staffId: string,
  id: string,
  label: string,
) => SqlOps<WorkspaceColumn | null> = (staffId, id, label) => ({
  sql: `
    UPDATE workspace_column
       SET col_label  = :col_label,
           updated_at = now()
     WHERE id = :id
       AND staff_id = :staff_id
    RETURNING ${COLUMN_RETURNING}
  `,
  parameters: [
    param("id", id, "id"),
    param("staff_id", staffId, "id"),
    param("col_label", label, "text"),
  ],
  mapper: (rows) => (rows[0] ? toWorkspaceColumn(rows[0]) : null),
});

/**
 * Delete a column, and with it every value anybody typed into it.
 *
 * No soft delete and no confirmation here - the cascade is the feature. What the person is promised
 * is that deleting a column destroys its data, so a `deleted` flag would be a promise broken
 * quietly: the values would still be in the table, and a column added later could not reuse the
 * name without a reader wondering which rows belonged to which.
 *
 * The screen asks before calling this. That is the right place for the question, because it is the
 * only place that knows how many values are about to go.
 */
export const WorkspaceColumnDeleteOps: (staffId: string, id: string) => SqlOps<number> = (
  staffId,
  id,
) => ({
  sql: `
    DELETE FROM workspace_column
     WHERE id = :id
       AND staff_id = :staff_id
    RETURNING id AS column_id
  `,
  parameters: [param("id", id, "id"), param("staff_id", staffId, "id")],
  mapper: (rows) => rows.length,
});

/**
 * Rewrite the order of every custom column, from one list of ids.
 *
 * One statement rather than a request per column. A drag that moves a column three places to the
 * left changes four positions, and sending four PATCHes makes the sheet's order briefly wrong in
 * three different ways - with no way to put it back if the third one fails.
 *
 * `WITH ORDINALITY` is what turns the array's order into the stored order, so the client sends what
 * it means ("this is the order") rather than arithmetic on `ord_no`. Ids that are not the caller's
 * match nothing, and ids the caller owns but left out keep their old position - which is why the
 * manager sends the complete list.
 */
export const WorkspaceColumnOrderOps: (staffId: string, ids: string[]) => SqlOps<number> = (
  staffId,
  ids,
) => ({
  sql: `
    UPDATE workspace_column c
       SET ord_no     = o.ord - 1,
           updated_at = now()
      FROM unnest(:ids) WITH ORDINALITY AS o(id, ord)
     WHERE c.id = o.id
       AND c.staff_id = :staff_id
    RETURNING c.id AS column_id
  `,
  parameters: [param("ids", ids, "idArray"), param("staff_id", staffId, "id")],
  mapper: (rows) => rows.length,
});

/* -------------------------------------------------------------------------- */
/* Cells                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The two things that have to be true before a value is stored, as one EXISTS each.
 *
 * The column must be the caller's, and the PO must be a row of the caller's own sheet - the same
 * predicate `WorkspaceSheetOps` selects on, repeated here because a write authorized by "the client
 * sent this id" is not authorized at all. Without the second, somebody could annotate a PO that
 * their sheet does not show and never will; nothing would be visible, but their notes would be
 * keyed to another PM's work.
 *
 * Both sit INSIDE the statement, so an id that fails either writes zero rows and the manager
 * answers 404 - rather than a pre-check that a later edit to this file could skip.
 */
const CELL_OWNERSHIP = `
    EXISTS (
      SELECT 1 FROM workspace_column c
       WHERE c.id = :column_id
         AND c.staff_id = :staff_id
    )
    AND EXISTS (
      SELECT 1
        FROM purchase_order po
        JOIN job j ON j.id = po.job_id AND j.deleted = false
        JOIN project p ON p.id = j.project_id AND p.deleted = false
       WHERE po.id = :po_id
         AND po.deleted = false
         AND p.prj_pm_id = :staff_id
         AND p.acceptance_status = 1
    )
`;

/**
 * Store one value, or remove it when the cell was cleared.
 *
 * An emptied cell is DELETED rather than stored as an empty string. The sheet reads an absent key
 * as an empty cell either way, so the two would be indistinguishable on screen while one of them
 * keeps a row per cell anybody has ever typed into and then cleared.
 */
export const WorkspaceCellWriteOps: (
  staffId: string,
  columnId: string,
  poId: string,
  value: string,
) => SqlOps<number> = (staffId, columnId, poId, value) => ({
  sql: `
    INSERT INTO workspace_cell (column_id, po_id, cell_text)
    SELECT :column_id, :po_id, :cell_text
     WHERE ${CELL_OWNERSHIP}
    ON CONFLICT (column_id, po_id) DO UPDATE
       SET cell_text  = EXCLUDED.cell_text,
           updated_at = now()
    RETURNING column_id
  `,
  parameters: [
    param("column_id", columnId, "id"),
    param("po_id", poId, "id"),
    param("cell_text", value, "text"),
    param("staff_id", staffId, "id"),
  ],
  mapper: (rows) => rows.length,
});

export const WorkspaceCellClearOps: (
  staffId: string,
  columnId: string,
  poId: string,
) => SqlOps<number> = (staffId, columnId, poId) => ({
  sql: `
    DELETE FROM workspace_cell
     WHERE column_id = :column_id
       AND po_id = :po_id
       AND ${CELL_OWNERSHIP}
    RETURNING column_id
  `,
  parameters: [
    param("column_id", columnId, "id"),
    param("po_id", poId, "id"),
    param("staff_id", staffId, "id"),
  ],
  mapper: (rows) => rows.length,
});
