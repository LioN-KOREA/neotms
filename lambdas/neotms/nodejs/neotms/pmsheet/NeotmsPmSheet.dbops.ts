// SPDX-License-Identifier: MIT
//
// The PM work sheet ("나의 업무" v2) - one row per JOB, per-JOB handover, notifications.
//
// See db/009_pm_sheet.sql for the tables and for why this is a parallel model next to the PO-level
// workspace (workspace/) rather than a re-keying of it.
//
// ## Which jobs are on a sheet
//
// A job is on staff S's sheet when either
//   * its LATEST job_handover is to S and was accepted (status 1), or
//   * it has never been handed over per job, its job_pm_id is S and its project was accepted
//     (project.acceptance_status = 1) - the project-level acceptance that predates this module, so
//     every job already on the PO-level workspace is also here from day one.
// A job the PM removed from the sheet (pm_sheet_row.hidden) is left out.
//
// A RE-handover (db/012: job_handover.rehandover - the job was already on the receiver's sheet when
// it was sent) that is still waiting or was sent back for revision does not count as "the latest
// handover": the job stays where it is while the re-handover is only a request to confirm.
//
// ## Changed cells (db/012)
//
// pm_sheet_seen holds, per owner and job, the linked values as the owner last confirmed them
// (`sheetSnapshot`). A row's `changedKeys` are the linked columns whose value differs now.
//
// ## Translator and reviewer
//
// The sheet shows a translator PO and a reviewer PO on the same line. The reviewer PO is the first
// live PO of the job whose work code is '감수'; the translator PO is the first live PO that is not.
// "Live" = not deleted and not cancelled. A job with more POs than that shows the first of each
// kind; the PO screen remains the place for the rest.

import { PO_STATE_CANCELLED } from "../NeotmsPoStates.js";
import { PROJECT_STATE_ACTIVE, PROJECT_STATE_DONE, PROJECT_STATE_HOLD } from "../NeotmsProjectStates.js";
import { PM_STATES } from "./NeotmsPmSheet.schemas.js";
import { param, readBool, readId, readInt, readText, type SqlOps, type SqlRow } from "../../utils/PostgresUtils.js";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type PmPoBrief = {
  poId: string;
  poCode: string;
  translatorId: string | null;
  tranName: string | null;
  volume: string | null;
  eday: string | null;
  edayTime: string | null;
  approved: boolean;
  moneyState: string | null;
  coinCode: string | null;
  state: string | null;
};

export type PmSheetRow = {
  jobId: string;
  jobCode: string;
  jobName: string | null;
  workCode: string | null;
  jobType: string | null;
  slang: string | null;
  elang: string | null;
  jobVolume: string | null;
  jobEday: string | null;
  jobEdayTime: string | null;
  jobState: string | null;
  projectId: string;
  prjCode: string;
  prjName: string | null;
  prjState: string | null;
  customerId: string | null;
  cusCodeName: string | null;
  cusMgrName: string | null;
  prjMgrName: string | null;
  handoverAt: string | null;
  tr: PmPoBrief | null;
  rv: PmPoBrief | null;
  pmState: string | null;
  fields: Record<string, string>;
  rowStyle: Record<string, unknown>;
  ordNo: number | null;
  groupMonthly: boolean;
  mergedInto: string | null;
  /** Linked columns whose value changed since the owner last confirmed them (db/012). */
  changedKeys: string[];
  /** A waiting re-handover of this job to the sheet's owner, if any. */
  rehandoverId: string | null;
};

export type PmSheetCell = {
  jobId: string;
  colKey: string;
  value: string | null;
  style: Record<string, unknown>;
  note: string | null;
};

export type PmHandover = {
  id: string;
  jobId: string;
  status: number;
  message: string | null;
  reply: string | null;
  snapshot: Record<string, unknown>;
  changedKeys: string[];
  fromStaffId: string | null;
  fromName: string | null;
  toStaffId: string;
  toName: string | null;
  createdAt: string;
  answeredAt: string | null;
  /** Sent while the job was already on the receiver's sheet (db/012) - confirm or revise only. */
  rehandover: boolean;
};

export type PmNotice = {
  id: string;
  kind: string;
  jobId: string | null;
  handoverId: string | null;
  message: string | null;
  fromName: string | null;
  createdAt: string;
  read: boolean;
  jobCode: string | null;
  jobName: string | null;
  prjCode: string | null;
};

export type PmStaff = { id: string; name: string; rows: number };

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

const readJson = <T>(row: SqlRow, column: string, fallback: T): T => {
  const raw = row[column];
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
};

const readTs = (row: SqlRow, column: string): string | null => {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString();
  return String(raw);
};

/** A `date` column as `YYYY-MM-DD` whatever the driver handed back. */
const readDate = (row: SqlRow, column: string): string | null => {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, "0");
    const d = String(raw.getDate()).padStart(2, "0");
    return `${String(y)}-${m}-${d}`;
  }
  return String(raw).slice(0, 10);
};

/** A `time` column as `HH:MM`. */
const readTime = (row: SqlRow, column: string): string | null => {
  const raw = readText(row, column);
  return raw ? raw.slice(0, 5) : null;
};

const readNum = (row: SqlRow, column: string): string | null => {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  return String(raw);
};

function readPo(row: SqlRow, p: string): PmPoBrief | null {
  const poId = readId(row, `${p}_po_id`);
  if (!poId) return null;
  return {
    poId,
    poCode: readText(row, `${p}_po_code`) ?? "",
    translatorId: readId(row, `${p}_translator_id`),
    tranName: readText(row, `${p}_tran_name`),
    volume: readNum(row, `${p}_volume`),
    eday: readDate(row, `${p}_eday`),
    edayTime: readTime(row, `${p}_eday_time`),
    approved: readBool(row, `${p}_approved`) ?? false,
    moneyState: readText(row, `${p}_money_state`),
    coinCode: readText(row, `${p}_coin_code`),
    state: readText(row, `${p}_state`),
  };
}

export function toPmSheetRow(row: SqlRow): PmSheetRow {
  return {
    jobId: readId(row, "job_id") ?? "",
    jobCode: readText(row, "job_code") ?? "",
    jobName: readText(row, "job_name"),
    workCode: readText(row, "work_code"),
    jobType: readText(row, "job_type"),
    slang: readText(row, "job_slang"),
    elang: readText(row, "job_elang"),
    jobVolume: readNum(row, "job_volume"),
    jobEday: readDate(row, "job_eday"),
    jobEdayTime: readTime(row, "job_eday_time"),
    jobState: readText(row, "job_state"),
    projectId: readId(row, "project_id") ?? "",
    prjCode: readText(row, "prj_code") ?? "",
    prjName: readText(row, "prj_name"),
    prjState: readText(row, "prj_state"),
    customerId: readId(row, "customer_id"),
    cusCodeName: readText(row, "cus_code_name"),
    cusMgrName: readText(row, "cus_mgr_name"),
    prjMgrName: readText(row, "prj_mgr_name"),
    handoverAt: readTs(row, "handover_at"),
    tr: readPo(row, "tr"),
    rv: readPo(row, "rv"),
    pmState: readText(row, "pm_state"),
    fields: readJson<Record<string, string>>(row, "fields", {}),
    rowStyle: readJson<Record<string, unknown>>(row, "row_style", {}),
    ordNo: readInt(row, "ord_no"),
    groupMonthly: readBool(row, "group_monthly") ?? false,
    mergedInto: readId(row, "merged_into"),
    changedKeys: [],
    rehandoverId: readId(row, "rehandover_id"),
  };
}

/**
 * The linked values of a sheet row, keyed by sheet column - what pm_sheet_seen stores and what a
 * changed cell is measured against. Only values that come from the job / project / POs.
 */
export function sheetSnapshot(row: PmSheetRow): Record<string, string> {
  const s = (value: string | null | undefined) => value ?? "";
  return {
    cusCodeName: s(row.cusCodeName),
    cusMgrName: s(row.cusMgrName),
    prjMgrName: s(row.prjMgrName),
    prjCode: s(row.prjCode),
    jobName: s(row.jobName),
    lang: [row.slang, row.elang].filter(Boolean).join("→"),
    translator: s(row.tr?.tranName),
    trVolume: s(row.tr?.volume),
    trPo: row.tr ? "발행" : "-",
    trEday: s(row.tr?.eday),
    trTime: s(row.tr?.edayTime),
    reviewer: s(row.rv?.tranName),
    rvVolume: s(row.rv?.volume),
    rvPo: row.rv ? "발행" : "-",
    rvEday: s(row.rv?.eday),
    rvTime: s(row.rv?.edayTime),
    jobEday: s(row.jobEday),
    jobTime: s(row.jobEdayTime),
  };
}

/** Keys of `now` whose value differs from `seen` (a key `seen` never recorded counts as unchanged). */
export function seenDiff(seen: Record<string, unknown>, now: Record<string, string>): string[] {
  return Object.keys(now)
    .filter((key) => key in seen && String(seen[key] ?? "") !== now[key])
    .sort();
}

function toHandover(row: SqlRow): PmHandover {
  return {
    id: readId(row, "id") ?? "",
    jobId: readId(row, "job_id") ?? "",
    status: readInt(row, "status") ?? 0,
    message: readText(row, "message"),
    reply: readText(row, "reply"),
    snapshot: readJson<Record<string, unknown>>(row, "snapshot", {}),
    changedKeys: readJson<string[]>(row, "changed_keys", []),
    fromStaffId: readId(row, "from_staff_id"),
    fromName: readText(row, "from_name"),
    toStaffId: readId(row, "to_staff_id") ?? "",
    toName: readText(row, "to_name"),
    createdAt: readTs(row, "created_at") ?? "",
    answeredAt: readTs(row, "answered_at"),
    rehandover: readBool(row, "rehandover") ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* The sheet                                                                  */
/* -------------------------------------------------------------------------- */

/** The PO columns of one lateral, prefixed. */
const poSelect = (p: string) => `
        ${p}.id AS ${p}_po_id, ${p}.po_code AS ${p}_po_code, ${p}.translator_id AS ${p}_translator_id,
        ${p}.po_tran_name AS ${p}_tran_name, ${p}.po_volume AS ${p}_volume, ${p}.po_eday AS ${p}_eday,
        ${p}.po_eday_time AS ${p}_eday_time, ${p}.po_approved AS ${p}_approved,
        ${p}.po_money_state AS ${p}_money_state, ${p}.po_coin_code AS ${p}_coin_code,
        ${p}.po_state AS ${p}_state`;

const poLateral = (p: string, predicate: string) => `
    LEFT JOIN LATERAL (
      SELECT po.id, po.po_code, po.translator_id, po.po_tran_name, pdl.po_volume, po.po_eday,
             po.po_eday_time, po.po_approved, po.po_money_state, po.po_coin_code, po.po_state
        FROM purchase_order po
        LEFT JOIN po_detail_linguistic pdl ON pdl.po_id = po.id
       WHERE po.job_id = j.id AND po.deleted = false AND po.po_state IS DISTINCT FROM :po_cancelled
         AND ${predicate}
       ORDER BY po.id
       LIMIT 1
    ) ${p} ON true`;

/** The latest handover of each job - the job's current handover state. */
const LATEST_HANDOVER = `
    LEFT JOIN LATERAL (
      SELECT h.id, h.to_staff_id, h.status, h.created_at, h.answered_at
        FROM job_handover h
       WHERE h.job_id = j.id
         AND NOT (h.rehandover AND h.status IN (0, 2))
       ORDER BY h.id DESC
       LIMIT 1
    ) hv ON true`;

/** When the project was accepted by this PM - the 인계일 of a job that was never handed over per job. */
const PROJECT_ACCEPTED = `
    LEFT JOIN LATERAL (
      SELECT pa.created_at
        FROM project_acceptance pa
       WHERE pa.project_id = p.id AND pa.acceptance_status = 1
       ORDER BY pa.id DESC
       LIMIT 1
    ) pacc ON true`;

export const PmSheetRowsOps = (staffId: string): SqlOps<PmSheetRow[]> => ({
  sql: `
    SELECT j.id AS job_id, j.job_code, j.job_name, j.work_code, j.job_type, j.job_eday, j.job_eday_time,
           j.job_state, jdl.job_slang, jdl.job_elang, jdl.job_volume,
           p.id AS project_id, p.prj_code, p.prj_name, p.prj_state, p.customer_id, p.cus_code_name,
           p.cus_mgr_name, p.prj_mgr_name,
           COALESCE(hv.answered_at, hv.created_at, pacc.created_at) AS handover_at,
           ${poSelect("tr")},
           ${poSelect("rv")},
           r.pm_state, r.fields, r.row_style, r.ord_no, r.group_monthly, r.merged_into,
           (SELECT rh.id FROM job_handover rh
             WHERE rh.job_id = j.id AND rh.rehandover AND rh.status = 0 AND rh.to_staff_id = :staff_id
             ORDER BY rh.id DESC LIMIT 1) AS rehandover_id
      FROM job j
      JOIN project p ON p.id = j.project_id AND p.deleted = false
      LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
      ${LATEST_HANDOVER}
      ${PROJECT_ACCEPTED}
      ${poLateral("tr", "po.po_work_code IS DISTINCT FROM '감수'")}
      ${poLateral("rv", "po.po_work_code = '감수'")}
      LEFT JOIN pm_sheet_row r ON r.staff_id = :staff_id AND r.job_id = j.id
     WHERE j.deleted = false
       AND COALESCE(r.hidden, false) = false
       AND (
             (hv.id IS NOT NULL AND hv.to_staff_id = :staff_id AND hv.status = 1)
          OR (hv.id IS NULL AND j.job_pm_id = :staff_id AND p.acceptance_status = 1)
       )
     ORDER BY r.ord_no NULLS LAST, COALESCE(hv.answered_at, hv.created_at, pacc.created_at), j.id
     LIMIT 2000
  `,
  parameters: [param("staff_id", staffId, "id"), param("po_cancelled", PO_STATE_CANCELLED, "text")],
  mapper: (rows) => rows.map(toPmSheetRow),
});

/** Whether a job is on a sheet - the gate for every write to that sheet's row and cells. */
/** 시트 주인의 그 작업 비고 칸 (없으면 null). 재인계 비고를 덧붙일 때 읽는다. */
export const SheetRemarkOps = (staffId: string, jobId: string): SqlOps<string | null> => ({
  sql: `SELECT fields->>'remark' AS remark FROM pm_sheet_row WHERE staff_id = :staff_id AND job_id = :job_id`,
  parameters: [param("staff_id", staffId, "id"), param("job_id", jobId, "id")],
  mapper: (rows) => {
    const v = rows[0]?.["remark"];
    return typeof v === "string" ? v : null;
  },
});

export const PmSheetHasJobOps = (staffId: string, jobId: string): SqlOps<boolean> => ({
  sql: `
    SELECT 1
      FROM job j
      JOIN project p ON p.id = j.project_id AND p.deleted = false
      ${LATEST_HANDOVER}
     WHERE j.id = :job_id AND j.deleted = false
       AND (
             (hv.id IS NOT NULL AND hv.to_staff_id = :staff_id AND hv.status = 1)
          OR (hv.id IS NULL AND j.job_pm_id = :staff_id AND p.acceptance_status = 1)
       )
  `,
  parameters: [param("staff_id", staffId, "id"), param("job_id", jobId, "id")],
  mapper: (rows) => rows.length > 0,
});

export const PmSheetCellsOps = (staffId: string): SqlOps<PmSheetCell[]> => ({
  sql: `
    SELECT job_id, col_key, value, style, note
      FROM pm_sheet_cell
     WHERE staff_id = :staff_id
  `,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) =>
    rows.map((row) => ({
      jobId: readId(row, "job_id") ?? "",
      colKey: readText(row, "col_key") ?? "",
      value: readText(row, "value"),
      style: readJson<Record<string, unknown>>(row, "style", {}),
      note: readText(row, "note"),
    })),
});

export const PmSheetPrefsOps = (staffId: string): SqlOps<Record<string, unknown>> => ({
  sql: `SELECT kind, data FROM pm_sheet_pref WHERE staff_id = :staff_id`,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => {
    const out: Record<string, unknown> = {};
    for (const row of rows) out[readText(row, "kind") ?? ""] = readJson<unknown>(row, "data", {});
    return out;
  },
});

export const PmSheetPrefWriteOps = (staffId: string, kind: string, data: unknown): SqlOps<number> => ({
  sql: `
    INSERT INTO pm_sheet_pref (staff_id, kind, data, updated_at)
    VALUES (:staff_id, :kind, :data, now())
    ON CONFLICT (staff_id, kind) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `,
  parameters: [param("staff_id", staffId, "id"), param("kind", kind, "text"), param("data", data, "json")],
  mapper: (rows) => rows.length,
});

/**
 * Upsert one sheet row. Each field is written only when given (`has_*` flags), so a status change
 * never clears the row's style and a style change never clears its status.
 */
export const PmSheetRowWriteOps = (
  staffId: string,
  jobId: string,
  patch: {
    pmState?: string | null;
    fields?: Record<string, string>;
    rowStyle?: Record<string, unknown>;
    ordNo?: number | null;
    groupMonthly?: boolean;
    mergedInto?: string | null;
    hidden?: boolean;
  },
  actor: string,
): SqlOps<number> => ({
  sql: `
    INSERT INTO pm_sheet_row (staff_id, job_id, pm_state, fields, row_style, ord_no, group_monthly,
                              merged_into, hidden, updated_at, updated_by)
    VALUES (:staff_id, :job_id, :pm_state, COALESCE(:fields, '{}'::jsonb), COALESCE(:row_style, '{}'::jsonb),
            :ord_no, COALESCE(:group_monthly, false), :merged_into, COALESCE(:hidden, false), now(), :actor)
    ON CONFLICT (staff_id, job_id) DO UPDATE SET
      pm_state      = CASE WHEN :has_state THEN EXCLUDED.pm_state ELSE pm_sheet_row.pm_state END,
      fields        = CASE WHEN :has_fields THEN pm_sheet_row.fields || EXCLUDED.fields ELSE pm_sheet_row.fields END,
      row_style     = CASE WHEN :has_style THEN EXCLUDED.row_style ELSE pm_sheet_row.row_style END,
      ord_no        = CASE WHEN :has_ord THEN EXCLUDED.ord_no ELSE pm_sheet_row.ord_no END,
      group_monthly = CASE WHEN :has_monthly THEN EXCLUDED.group_monthly ELSE pm_sheet_row.group_monthly END,
      merged_into   = CASE WHEN :has_merge THEN EXCLUDED.merged_into ELSE pm_sheet_row.merged_into END,
      hidden        = CASE WHEN :has_hidden THEN EXCLUDED.hidden ELSE pm_sheet_row.hidden END,
      updated_at = now(), updated_by = :actor
  `,
  parameters: [
    param("staff_id", staffId, "id"),
    param("job_id", jobId, "id"),
    param("pm_state", patch.pmState ?? null, "text"),
    param("fields", patch.fields ?? null, "json"),
    param("row_style", patch.rowStyle ?? null, "json"),
    param("ord_no", patch.ordNo ?? null, "int"),
    param("group_monthly", patch.groupMonthly ?? null, "bool"),
    param("merged_into", patch.mergedInto ?? null, "id"),
    param("hidden", patch.hidden ?? null, "bool"),
    param("has_state", patch.pmState !== undefined, "bool"),
    param("has_fields", patch.fields !== undefined, "bool"),
    param("has_style", patch.rowStyle !== undefined, "bool"),
    param("has_ord", patch.ordNo !== undefined, "bool"),
    param("has_monthly", patch.groupMonthly !== undefined, "bool"),
    param("has_merge", patch.mergedInto !== undefined, "bool"),
    param("has_hidden", patch.hidden !== undefined, "bool"),
    param("actor", actor, "text"),
  ],
  mapper: (rows) => rows.length,
});

/** Upsert one cell; value/style/note each written only when given. */
export const PmSheetCellWriteOps = (
  staffId: string,
  cell: { jobId: string; colKey: string; value?: string | null; style?: Record<string, unknown>; note?: string | null },
  actor: string,
): SqlOps<number> => ({
  sql: `
    INSERT INTO pm_sheet_cell (staff_id, job_id, col_key, value, style, note, updated_at, updated_by)
    VALUES (:staff_id, :job_id, :col_key, :value, COALESCE(:style, '{}'::jsonb), :note, now(), :actor)
    ON CONFLICT (staff_id, job_id, col_key) DO UPDATE SET
      value = CASE WHEN :has_value THEN EXCLUDED.value ELSE pm_sheet_cell.value END,
      style = CASE WHEN :has_style THEN EXCLUDED.style ELSE pm_sheet_cell.style END,
      note  = CASE WHEN :has_note THEN EXCLUDED.note ELSE pm_sheet_cell.note END,
      updated_at = now(), updated_by = :actor
  `,
  parameters: [
    param("staff_id", staffId, "id"),
    param("job_id", cell.jobId, "id"),
    param("col_key", cell.colKey, "text"),
    param("value", cell.value ?? null, "text"),
    param("style", cell.style ?? null, "json"),
    param("note", cell.note ?? null, "text"),
    param("has_value", cell.value !== undefined, "bool"),
    param("has_style", cell.style !== undefined, "bool"),
    param("has_note", cell.note !== undefined, "bool"),
    param("actor", actor, "text"),
  ],
  mapper: (rows) => rows.length,
});

/** Every PM a sheet can be opened for (타PM 업무), with how many rows each sheet has. */
export const PmSheetStaffOps = (): SqlOps<PmStaff[]> => ({
  sql: `
    SELECT s.id, s.mgr_name,
           (SELECT count(*) FROM job j
              JOIN project p ON p.id = j.project_id AND p.deleted = false
              ${LATEST_HANDOVER}
             WHERE j.deleted = false
               AND ((hv.id IS NOT NULL AND hv.to_staff_id = s.id AND hv.status = 1)
                 OR (hv.id IS NULL AND j.job_pm_id = s.id AND p.acceptance_status = 1))) AS rows
      FROM staff s
     WHERE s.deleted = false AND s.active = true AND s.role_id IS NOT NULL
     ORDER BY s.mgr_name
  `,
  mapper: (rows) =>
    rows.map((row) => ({
      id: readId(row, "id") ?? "",
      name: readText(row, "mgr_name") ?? "",
      rows: readInt(row, "rows") ?? 0,
    })),
});

export const PmStaffNameOps = (staffId: string): SqlOps<string | null> => ({
  sql: `SELECT mgr_name FROM staff WHERE id = :id AND deleted = false`,
  parameters: [param("id", staffId, "id")],
  mapper: (rows) => (rows[0] ? readText(rows[0], "mgr_name") : null),
});

/**
 * Re-derive a project's 진행상태 from the PM statuses of its jobs (기획서: 인계 수령~납품 대기 →
 * 진행, 납품 완료 → 완료, 홀딩/캔슬 → 보류). Any job in progress keeps the project 진행; otherwise
 * any 완료 makes it 완료; otherwise all on hold → 보류. The 별도 관리 markers carry no state.
 * Touches the project only when the derived value differs, so it never bumps updated_at for nothing.
 */
export const PmProjectStateSyncOps = (jobId: string, actor: string): SqlOps<string | null> => ({
  sql: `
    WITH states AS (
      SELECT CASE
               WHEN r.pm_state = '납품 완료' THEN :st_done
               WHEN r.pm_state = '홀딩/캔슬' THEN :st_hold
               WHEN r.pm_state LIKE '별도 관리%' THEN NULL
               WHEN r.pm_state IS NULL THEN NULL
               WHEN r.pm_state = ANY(:builtin) THEN :st_active
               -- a state the PM added: its own mapping (진행/완료/보류, or none) from their settings
               ELSE (SELECT CASE e->>'prj'
                              WHEN :st_active THEN :st_active
                              WHEN :st_done THEN :st_done
                              WHEN :st_hold THEN :st_hold
                            END
                       FROM pm_sheet_pref pf,
                            jsonb_array_elements(CASE WHEN jsonb_typeof(pf.data->'states') = 'array'
                                                      THEN pf.data->'states' ELSE '[]'::jsonb END) e
                      WHERE pf.staff_id = r.staff_id AND pf.kind = 'columns' AND e->>'name' = r.pm_state
                      LIMIT 1)
             END AS s
        FROM pm_sheet_row r
        JOIN job j ON j.id = r.job_id AND j.deleted = false
       WHERE j.project_id = (SELECT project_id FROM job WHERE id = :job_id)
         AND r.hidden = false
    ), derived AS (
      SELECT CASE
               WHEN bool_or(s = :st_active) THEN :st_active
               WHEN bool_or(s = :st_done) THEN :st_done
               WHEN bool_or(s = :st_hold) THEN :st_hold
             END AS s
        FROM states
    )
    UPDATE project p
       SET prj_state = d.s, updated_at = now()
      FROM derived d
     WHERE p.id = (SELECT project_id FROM job WHERE id = :job_id)
       AND d.s IS NOT NULL
       AND p.prj_state IS DISTINCT FROM d.s
    RETURNING p.prj_state
  `,
  parameters: [
    param("job_id", jobId, "id"),
    param("actor", actor, "text"),
    param("st_active", PROJECT_STATE_ACTIVE, "text"),
    param("st_done", PROJECT_STATE_DONE, "text"),
    param("st_hold", PROJECT_STATE_HOLD, "text"),
    param("builtin", [...PM_STATES], "textArray"),
  ],
  mapper: (rows) => (rows[0] ? readText(rows[0], "prj_state") : null),
});

/* -------------------------------------------------------------------------- */
/* Handover                                                                   */
/* -------------------------------------------------------------------------- */

const HANDOVER_COLUMNS = `
    h.id, h.job_id, h.status, h.message, h.reply, h.snapshot, to_jsonb(h.changed_keys) AS changed_keys,
    h.from_staff_id, fs.mgr_name AS from_name, h.to_staff_id, ts.mgr_name AS to_name,
    h.created_at, h.answered_at, h.rehandover`;

/**
 * The job's sheet-relevant values, as the handover sheet shows them and as the diff compares them.
 * Keys match the sheet's column keys so the frontend can paint the changed cells directly.
 */
export const JobSnapshotOps = (jobId: string): SqlOps<{ snapshot: Record<string, unknown>; pmId: string | null; prjCode: string } | null> => ({
  sql: `
    SELECT j.job_pm_id, p.prj_code,
           jsonb_build_object(
             'cusCodeName', p.cus_code_name,
             'cusMgrName', p.cus_mgr_name,
             'prjMgrName', p.prj_mgr_name,
             'prjCode', p.prj_code,
             'prjName', p.prj_name,
             'jobCode', j.job_code,
             'jobName', j.job_name,
             'workCode', j.work_code,
             'lang', concat_ws('→', jdl.job_slang, jdl.job_elang),
             'jobVolume', jdl.job_volume,
             'jobEday', j.job_eday,
             'jobEdayTime', to_char(j.job_eday_time, 'HH24:MI'),
             'jobMemo', j.job_memo
           ) AS snapshot
      FROM job j
      JOIN project p ON p.id = j.project_id AND p.deleted = false
      LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
     WHERE j.id = :job_id AND j.deleted = false
  `,
  parameters: [param("job_id", jobId, "id")],
  mapper: (rows) =>
    rows[0]
      ? {
          snapshot: readJson<Record<string, unknown>>(rows[0], "snapshot", {}),
          pmId: readId(rows[0], "job_pm_id"),
          prjCode: readText(rows[0], "prj_code") ?? "",
        }
      : null,
});

export const PreviousHandoverOps = (jobId: string): SqlOps<PmHandover | null> => ({
  sql: `
    SELECT ${HANDOVER_COLUMNS}
      FROM job_handover h
      LEFT JOIN staff fs ON fs.id = h.from_staff_id
      LEFT JOIN staff ts ON ts.id = h.to_staff_id
     WHERE h.job_id = :job_id
     ORDER BY h.id DESC
     LIMIT 1
  `,
  parameters: [param("job_id", jobId, "id")],
  mapper: (rows) => (rows[0] ? toHandover(rows[0]) : null),
});

export const HandoverInsertOps = (input: {
  jobId: string;
  fromStaffId: string;
  toStaffId: string;
  message: string | null;
  snapshot: Record<string, unknown>;
  changedKeys: string[];
  rehandover: boolean;
  actor: string;
}): SqlOps<string | null> => ({
  sql: `
    INSERT INTO job_handover (job_id, from_staff_id, to_staff_id, status, message, snapshot, changed_keys, rehandover, created_by)
    VALUES (:job_id, :from_id, :to_id, 0, :message, :snapshot, :changed, :rehandover, :actor)
    RETURNING id
  `,
  parameters: [
    param("job_id", input.jobId, "id"),
    param("from_id", input.fromStaffId, "id"),
    param("to_id", input.toStaffId, "id"),
    param("message", input.message, "text"),
    param("snapshot", input.snapshot, "json"),
    param("changed", input.changedKeys, "textArray"),
    param("rehandover", input.rehandover, "bool"),
    param("actor", input.actor, "text"),
  ],
  mapper: (rows) => (rows[0] ? readId(rows[0], "id") : null),
});

export const HandoverGetOps = (id: string): SqlOps<PmHandover | null> => ({
  sql: `
    SELECT ${HANDOVER_COLUMNS}
      FROM job_handover h
      LEFT JOIN staff fs ON fs.id = h.from_staff_id
      LEFT JOIN staff ts ON ts.id = h.to_staff_id
     WHERE h.id = :id
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows[0] ? toHandover(rows[0]) : null),
});

/** Answer a WAITING handover. The status predicate makes a double click a no-op, not a second answer. */
export const HandoverAnswerOps = (id: string, status: number, reply: string | null, actor: string): SqlOps<number> => ({
  sql: `
    UPDATE job_handover
       SET status = :status, reply = :reply, answered_at = now(), answered_by = :actor
     WHERE id = :id AND status = 0
       AND id = (SELECT max(h2.id) FROM job_handover h2 WHERE h2.job_id = job_handover.job_id)
    RETURNING id
  `,
  parameters: [
    param("id", id, "id"),
    param("status", status, "int"),
    param("reply", reply, "text"),
    param("actor", actor, "text"),
  ],
  mapper: (rows) => rows.length,
});

/** The handover sheet: every job whose latest handover is to this PM and still waiting. */
export const PendingHandoversOps = (staffId: string): SqlOps<(PmHandover & { row: PmSheetRow })[]> => ({
  sql: `
    SELECT ${HANDOVER_COLUMNS},
           j.id AS job_id, j.job_code, j.job_name, j.work_code, j.job_type, j.job_eday, j.job_eday_time,
           j.job_state, jdl.job_slang, jdl.job_elang, jdl.job_volume,
           p.id AS project_id, p.prj_code, p.prj_name, p.prj_state, p.customer_id, p.cus_code_name,
           p.cus_mgr_name, p.prj_mgr_name, h.created_at AS handover_at,
           ${poSelect("tr")},
           ${poSelect("rv")},
           NULL::text AS pm_state, '{}'::jsonb AS fields, '{}'::jsonb AS row_style, NULL::int AS ord_no,
           false AS group_monthly, NULL::bigint AS merged_into
      FROM job_handover h
      JOIN job j ON j.id = h.job_id AND j.deleted = false
      JOIN project p ON p.id = j.project_id AND p.deleted = false
      LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
      LEFT JOIN staff fs ON fs.id = h.from_staff_id
      LEFT JOIN staff ts ON ts.id = h.to_staff_id
      ${poLateral("tr", "po.po_work_code IS DISTINCT FROM '감수'")}
      ${poLateral("rv", "po.po_work_code = '감수'")}
     WHERE h.to_staff_id = :staff_id
       AND h.status = 0
       AND h.id = (SELECT max(h2.id) FROM job_handover h2 WHERE h2.job_id = h.job_id)
     ORDER BY h.id
     LIMIT 500
  `,
  parameters: [param("staff_id", staffId, "id"), param("po_cancelled", PO_STATE_CANCELLED, "text")],
  mapper: (rows) => rows.map((row) => ({ ...toHandover(row), row: toPmSheetRow(row) })),
});

export const PendingHandoverCountOps = (staffId: string): SqlOps<number> => ({
  sql: `
    SELECT count(*) AS n
      FROM job_handover h
      JOIN job j ON j.id = h.job_id AND j.deleted = false
     WHERE h.to_staff_id = :staff_id AND h.status = 0
       AND h.id = (SELECT max(h2.id) FROM job_handover h2 WHERE h2.job_id = h.job_id)
  `,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => (rows[0] ? (readInt(rows[0], "n") ?? 0) : 0),
});

/** The latest handover of each job of one project - what the project screen shows next to each job. */
export const ProjectHandoversOps = (projectId: string): SqlOps<PmHandover[]> => ({
  sql: `
    SELECT ${HANDOVER_COLUMNS}
      FROM job_handover h
      JOIN job j ON j.id = h.job_id AND j.deleted = false AND j.project_id = :project_id
      LEFT JOIN staff fs ON fs.id = h.from_staff_id
      LEFT JOIN staff ts ON ts.id = h.to_staff_id
     WHERE h.id = (SELECT max(h2.id) FROM job_handover h2 WHERE h2.job_id = h.job_id)
  `,
  parameters: [param("project_id", projectId, "id")],
  mapper: (rows) => rows.map(toHandover),
});

/* -------------------------------------------------------------------------- */
/* Notices                                                                    */
/* -------------------------------------------------------------------------- */

export const NoticeInsertOps = (input: {
  staffId: string;
  kind: string;
  jobId: string | null;
  handoverId: string | null;
  message: string | null;
  fromName: string | null;
}): SqlOps<number> => ({
  sql: `
    INSERT INTO staff_notice (staff_id, kind, job_id, handover_id, message, from_name)
    VALUES (:staff_id, :kind, :job_id, :handover_id, :message, :from_name)
    RETURNING id
  `,
  parameters: [
    param("staff_id", input.staffId, "id"),
    param("kind", input.kind, "text"),
    param("job_id", input.jobId, "id"),
    param("handover_id", input.handoverId, "id"),
    param("message", input.message, "text"),
    param("from_name", input.fromName, "text"),
  ],
  mapper: (rows) => rows.length,
});

export const NoticesOps = (staffId: string): SqlOps<PmNotice[]> => ({
  sql: `
    SELECT n.id, n.kind, n.job_id, n.handover_id, n.message, n.from_name, n.created_at,
           n.read_at IS NOT NULL AS is_read, j.job_code, j.job_name, p.prj_code
      FROM staff_notice n
      LEFT JOIN job j ON j.id = n.job_id
      LEFT JOIN project p ON p.id = j.project_id
     WHERE n.staff_id = :staff_id
       AND (n.read_at IS NULL OR n.created_at > now() - interval '14 days')
     ORDER BY n.id DESC
     LIMIT 50
  `,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) =>
    rows.map((row) => ({
      id: readId(row, "id") ?? "",
      kind: readText(row, "kind") ?? "",
      jobId: readId(row, "job_id"),
      handoverId: readId(row, "handover_id"),
      message: readText(row, "message"),
      fromName: readText(row, "from_name"),
      createdAt: readTs(row, "created_at") ?? "",
      read: readBool(row, "is_read") ?? false,
      jobCode: readText(row, "job_code"),
      jobName: readText(row, "job_name"),
      prjCode: readText(row, "prj_code"),
    })),
});

export const NoticesReadOps = (staffId: string, ids: string[] | null): SqlOps<number> => ({
  sql: `
    UPDATE staff_notice SET read_at = now()
     WHERE staff_id = :staff_id AND read_at IS NULL
       AND (:all OR id = ANY(:ids))
    RETURNING id
  `,
  parameters: [
    param("staff_id", staffId, "id"),
    param("all", ids === null, "bool"),
    param("ids", ids ?? [], "idArray"),
  ],
  mapper: (rows) => rows.length,
});

/* -------------------------------------------------------------------------- */
/* Translator suggestions                                                     */
/* -------------------------------------------------------------------------- */

export type PmTranslatorSuggestion = {
  translatorId: string;
  name: string;
  lastHandoverAt: string | null;
  prjCode: string | null;
  times: number;
};

/**
 * Translators who worked for the same customer on the same language pair before (기획서: 번역가
 * 추천). Ranked by how recently, then how often. The job itself is excluded so the current
 * translator is not "recommended" to the person who just picked them.
 */
export const TranslatorSuggestionsOps = (jobId: string): SqlOps<PmTranslatorSuggestion[]> => ({
  sql: `
    WITH me AS (
      SELECT p.customer_id, jdl.job_slang, jdl.job_elang
        FROM job j
        JOIN project p ON p.id = j.project_id
        LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
       WHERE j.id = :job_id
    )
    SELECT po.translator_id,
           max(t.tran_name) AS name,
           count(DISTINCT po.id) AS times,
           (array_agg(p.prj_code ORDER BY COALESCE(pa.created_at, p.created_at) DESC))[1] AS prj_code,
           max(COALESCE(pa.created_at, p.created_at)) AS last_at
      FROM purchase_order po
      JOIN job j ON j.id = po.job_id AND j.deleted = false
      JOIN project p ON p.id = j.project_id AND p.deleted = false
      JOIN translator t ON t.id = po.translator_id AND t.deleted = false
      LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
      LEFT JOIN LATERAL (
        SELECT x.created_at FROM project_acceptance x
         WHERE x.project_id = p.id AND x.acceptance_status = 1 ORDER BY x.id DESC LIMIT 1
      ) pa ON true
      CROSS JOIN me
     WHERE po.deleted = false
       AND po.translator_id IS NOT NULL
       AND j.id <> :job_id
       AND p.customer_id IS NOT DISTINCT FROM me.customer_id
       AND jdl.job_slang IS NOT DISTINCT FROM me.job_slang
       AND jdl.job_elang IS NOT DISTINCT FROM me.job_elang
     GROUP BY po.translator_id
     ORDER BY last_at DESC, times DESC
     LIMIT 8
  `,
  parameters: [param("job_id", jobId, "id")],
  mapper: (rows) =>
    rows.map((row) => ({
      translatorId: readId(row, "translator_id") ?? "",
      name: readText(row, "name") ?? "",
      lastHandoverAt: readTs(row, "last_at"),
      prjCode: readText(row, "prj_code"),
      times: readInt(row, "times") ?? 0,
    })),
});

/* -------------------------------------------------------------------------- */
/* Seen values (db/012)                                                       */
/* -------------------------------------------------------------------------- */

/** The linked values of the given jobs, whoever's sheet they are on (for `sheetSnapshot`). */
export const SheetSnapshotRowsOps = (jobIds: readonly string[]): SqlOps<PmSheetRow[]> => ({
  sql: `
    SELECT j.id AS job_id, j.job_code, j.job_name, j.work_code, j.job_type, j.job_eday, j.job_eday_time,
           j.job_state, jdl.job_slang, jdl.job_elang, jdl.job_volume,
           p.id AS project_id, p.prj_code, p.prj_name, p.prj_state, p.customer_id, p.cus_code_name,
           p.cus_mgr_name, p.prj_mgr_name,
           ${poSelect("tr")},
           ${poSelect("rv")}
      FROM job j
      JOIN project p ON p.id = j.project_id
      LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
      ${poLateral("tr", "po.po_work_code IS DISTINCT FROM '감수'")}
      ${poLateral("rv", "po.po_work_code = '감수'")}
     WHERE j.id = ANY(:job_ids)
  `,
  parameters: [param("job_ids", [...jobIds], "idArray"), param("po_cancelled", PO_STATE_CANCELLED, "text")],
  mapper: (rows) => rows.map(toPmSheetRow),
});

export const SeenReadOps = (staffId: string): SqlOps<Map<string, Record<string, unknown>>> => ({
  sql: `SELECT job_id, snapshot FROM pm_sheet_seen WHERE staff_id = :staff_id`,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => new Map(rows.map((row) => [readId(row, "job_id") ?? "", readJson<Record<string, unknown>>(row, "snapshot", {})])),
});

/**
 * Merge values into an owner's seen snapshots. `create` = also start a row for a job that has none
 * (a first sight or an explicit confirm); otherwise only jobs already tracked are touched (an edit
 * the owner made elsewhere must not start tracking a job that is not on their sheet).
 */
export const SeenMergeOps = (
  staffId: string,
  items: readonly { jobId: string; values: Record<string, string> }[],
  create: boolean,
): SqlOps<number> => ({
  sql: create
    ? `
    INSERT INTO pm_sheet_seen (staff_id, job_id, snapshot)
    SELECT :staff_id, (e->>'jobId')::bigint, e->'values'
      FROM jsonb_array_elements(:items) e
    ON CONFLICT (staff_id, job_id)
    DO UPDATE SET snapshot = pm_sheet_seen.snapshot || EXCLUDED.snapshot, updated_at = now()`
    : `
    UPDATE pm_sheet_seen s
       SET snapshot = s.snapshot || e->'values', updated_at = now()
      FROM jsonb_array_elements(:items) e
     WHERE s.staff_id = :staff_id AND s.job_id = (e->>'jobId')::bigint`,
  parameters: [param("staff_id", staffId, "id"), param("items", items, "json")],
  mapper: (rows) => rows.length,
});

/** Start tracking jobs seen for the first time - never overwrites what is already there. */
export const SeenBaselineOps = (staffId: string, items: readonly { jobId: string; values: Record<string, string> }[]): SqlOps<number> => ({
  sql: `
    INSERT INTO pm_sheet_seen (staff_id, job_id, snapshot)
    SELECT :staff_id, (e->>'jobId')::bigint, e->'values'
      FROM jsonb_array_elements(:items) e
    ON CONFLICT (staff_id, job_id) DO NOTHING`,
  parameters: [param("staff_id", staffId, "id"), param("items", items, "json")],
  mapper: (rows) => rows.length,
});

/** Jobs a write may change on a sheet, limited to the ones `staffId` tracks. */
export const SeenJobsOfOps = (staffId: string, target: { jobId?: string; projectId?: string; poId?: string }): SqlOps<string[]> => ({
  sql: `
    SELECT s.job_id
      FROM pm_sheet_seen s
      JOIN job j ON j.id = s.job_id
     WHERE s.staff_id = :staff_id
       AND (   (:job_id IS NOT NULL AND j.id = :job_id)
            OR (:project_id IS NOT NULL AND j.project_id = :project_id)
            OR (:po_id IS NOT NULL AND j.id = (SELECT po.job_id FROM purchase_order po WHERE po.id = :po_id)))
  `,
  parameters: [
    param("staff_id", staffId, "id"),
    param("job_id", target.jobId ?? null, "id"),
    param("project_id", target.projectId ?? null, "id"),
    param("po_id", target.poId ?? null, "id"),
  ],
  mapper: (rows) => rows.map((row) => readId(row, "job_id") ?? "").filter(Boolean),
});

/** The waiting re-handover of a job to `staffId`, if any. */
export const PendingRehandoverOps = (staffId: string, jobId: string): SqlOps<string | null> => ({
  sql: `
    SELECT id FROM job_handover
     WHERE job_id = :job_id AND to_staff_id = :staff_id AND rehandover AND status = 0
     ORDER BY id DESC LIMIT 1`,
  parameters: [param("staff_id", staffId, "id"), param("job_id", jobId, "id")],
  mapper: (rows) => (rows[0] ? readId(rows[0], "id") : null),
});
