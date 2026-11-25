// SPDX-License-Identifier: MIT
//
// The PM work sheet ("나의 업무" v2) - rules on top of NeotmsPmSheet.dbops.
//
// ## Whose sheet
//
// Every route takes an optional `staffId`: absent = the caller's own sheet, present = another PM's
// (타PM 업무, the backup view). The specification lets a backup PM EDIT the other sheet, so the
// gate for a write is "is this job on THAT sheet", not "is it the caller's". Every write records
// the caller as `updated_by`, so who changed another person's sheet stays visible.
//
// ## Writes to TMS data do not come through here
//
// Linked columns (languages, translator, volumes, dates) are saved by the frontend through the same
// PATCH /jobs and /purchase-orders endpoints the forms use - one implementation of their validation,
// scope and locking, the same decision the PO-level workspace made. What is written here is the
// sheet's own data, plus ONE derived TMS value: the project's 진행상태, which the PM status drives
// (기획서: 인계 수령~납품 대기 → 진행, 납품 완료 → 완료, 홀딩/캔슬 → 보류).
//
// ## Changed cells and re-handover (db/012)
//
// The linked cells read the job / project / POs live, so an edit anywhere shows on the sheet at
// once. What the owner has not yet SEEN is tracked in pm_sheet_seen: `getPmSheet` reports, per row,
// the linked columns whose value moved since the owner last confirmed it, and `confirmPmSeen`
// accepts them. The owner's own writes through the job / project / PO endpoints are confirmed as
// they are made (`keepOwnEditsSeen`), so only other people's changes are highlighted.
//
// A re-handover (the job was already on the receiver's sheet) keeps the job on that sheet while it
// waits, is answered with confirm or revision (no reject) and does not reset the PM state.

import { pgExecute, pgQuery, pgTransaction } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { badRequest, notFound, ok, runDb } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import {
  HandoverAnswerOps,
  HandoverGetOps,
  HandoverInsertOps,
  JobSnapshotOps,
  NoticeInsertOps,
  NoticesOps,
  NoticesReadOps,
  PendingHandoverCountOps,
  PendingHandoversOps,
  PmProjectStateSyncOps,
  PmSheetCellWriteOps,
  PmSheetCellsOps,
  PmSheetHasJobOps,
  PmSheetPrefWriteOps,
  PmSheetPrefsOps,
  PmSheetRowWriteOps,
  PmSheetRowsOps,
  PmSheetStaffOps,
  PmStaffNameOps,
  PendingRehandoverOps,
  PreviousHandoverOps,
  ProjectHandoversOps,
  SeenBaselineOps,
  SeenJobsOfOps,
  SeenMergeOps,
  SeenReadOps,
  SheetSnapshotRowsOps,
  seenDiff,
  sheetSnapshot,
  TranslatorSuggestionsOps,
  type PmHandover,
  type PmNotice,
  type PmSheetCell,
  type PmSheetRow,
  type PmStaff,
  type PmTranslatorSuggestion,
} from "./NeotmsPmSheet.dbops.js";
import {
  PM_PREF_KINDS,
  type PmCellsInput,
  type PmHandoverAnswer,
  type PmHandoverCreate,
  type PmNoticesRead,
  type PmPrefInput,
  type PmRowOrderInput,
  type PmRowPatch,
  type PmSeenInput,
} from "./NeotmsPmSheet.schemas.js";
import type { PoolClient } from "pg";

const ID = /^\d{1,19}$/;

/** The sheet a request is about: `?staffId=` or the body's `staffId`, else the caller's own. */
function ownerOf(caller: NeotmsCaller, requested: string | undefined | null): string | null {
  if (requested === undefined || requested === null || requested === "") return caller.staffId;
  return ID.test(requested) ? requested : null;
}

export type PmSheetView = {
  staff: { id: string; name: string };
  mine: boolean;
  rows: PmSheetRow[];
  cells: PmSheetCell[];
  prefs: Record<string, unknown>;
  pendingHandovers: number;
};

export async function getPmSheet(
  caller: NeotmsCaller,
  request: RequestData,
): Promise<ResponseData<PmSheetView | string>> {
  const owner = ownerOf(caller, request.queryParams["staffId"]);
  if (!owner) return badRequest("staffId must be a record id");
  return runDb("read pm sheet", async () => {
    const name = (await pgQuery(PmStaffNameOps(owner))).data;
    if (name === null) return notFound("staff");
    const rows = (await pgQuery(PmSheetRowsOps(owner))).data;
    // Changed cells: compare with what the owner last confirmed; start tracking new rows quietly.
    const seen = (await pgQuery(SeenReadOps(owner))).data;
    const first: { jobId: string; values: Record<string, string> }[] = [];
    for (const row of rows) {
      const now = sheetSnapshot(row);
      const before = seen.get(row.jobId);
      if (before) row.changedKeys = seenDiff(before, now);
      else first.push({ jobId: row.jobId, values: now });
    }
    if (first.length > 0) await pgExecute(SeenBaselineOps(owner, first));
    const cells = (await pgQuery(PmSheetCellsOps(owner))).data;
    const prefs = (await pgQuery(PmSheetPrefsOps(owner))).data;
    const pendingHandovers = (await pgQuery(PendingHandoverCountOps(owner))).data;
    return ok({
      staff: { id: owner, name },
      mine: owner === caller.staffId,
      rows,
      cells,
      prefs,
      pendingHandovers,
    });
  });
}

export async function listPmStaff(): Promise<ResponseData<PmStaff[] | string>> {
  return runDb("list pm staff", async () => ok((await pgQuery(PmSheetStaffOps())).data));
}

export async function patchPmRow(
  caller: NeotmsCaller,
  input: PmRowPatch,
  ctx: WriteContext,
): Promise<ResponseData<{ saved: boolean; prjState: string | null } | string>> {
  const owner = ownerOf(caller, input.staffId);
  if (!owner) return badRequest("staffId must be a record id");
  return runDb("write pm sheet row", async () => {
    if (!(await pgQuery(PmSheetHasJobOps(owner, input.jobId))).data) return notFound("sheet row");
    if (input.mergedInto) {
      if (input.mergedInto === input.jobId) return badRequest("행을 자기 자신에 통합할 수 없습니다.");
      if (!(await pgQuery(PmSheetHasJobOps(owner, input.mergedInto))).data) {
        return badRequest("통합할 대상 행이 이 시트에 없습니다.");
      }
    }
    return pgTransaction(async (client) => {
      await pgExecute(
        PmSheetRowWriteOps(
          owner,
          input.jobId,
          {
            pmState: input.pmState,
            fields: input.fields as Record<string, string> | undefined,
            rowStyle: input.rowStyle as Record<string, unknown> | undefined,
            ordNo: input.ordNo,
            groupMonthly: input.groupMonthly,
            mergedInto: input.mergedInto,
            hidden: input.hidden,
          },
          ctx.actor,
        ),
        client,
      );
      let prjState: string | null = null;
      if (input.pmState !== undefined) {
        prjState = (await pgExecute(PmProjectStateSyncOps(input.jobId, ctx.actor), client)).data;
      }
      return ok({ saved: true, prjState });
    });
  });
}

export async function writePmCells(
  caller: NeotmsCaller,
  input: PmCellsInput,
  ctx: WriteContext,
): Promise<ResponseData<{ saved: number } | string>> {
  const owner = ownerOf(caller, input.staffId);
  if (!owner) return badRequest("staffId must be a record id");
  return runDb("write pm sheet cells", async () => {
    const jobs = [...new Set(input.items.map((item) => item.jobId))];
    for (const jobId of jobs) {
      if (!(await pgQuery(PmSheetHasJobOps(owner, jobId))).data) return notFound("sheet row");
    }
    return pgTransaction(async (client) => {
      for (const item of input.items) {
        const value = item.value === undefined ? undefined : item.value === null ? null : item.value.trim() || null;
        const note = item.note === undefined ? undefined : item.note === null ? null : item.note.trim() || null;
        await pgExecute(
          PmSheetCellWriteOps(
            owner,
            {
              jobId: item.jobId,
              colKey: item.colKey,
              value,
              style: item.style as Record<string, unknown> | undefined,
              note,
            },
            ctx.actor,
          ),
          client,
        );
      }
      return ok({ saved: input.items.length });
    });
  });
}

/**
 * The caller's own preference documents, without the sheet. Screens other than the sheet keep
 * small personal settings here too (the job form's language favourites live in `view.langFav`).
 */
export async function readMyPmPrefs(caller: NeotmsCaller): Promise<ResponseData<Record<string, unknown> | string>> {
  const owner = ownerOf(caller, undefined);
  if (!owner) return badRequest("no staff record for this account");
  return runDb("read my pm prefs", async () => ok((await pgQuery(PmSheetPrefsOps(owner))).data));
}

export async function writePmPref(
  caller: NeotmsCaller,
  kind: string,
  input: PmPrefInput,
): Promise<ResponseData<{ saved: boolean } | string>> {
  if (!(PM_PREF_KINDS as readonly string[]).includes(kind)) return badRequest("unknown preference kind");
  const owner = ownerOf(caller, input.staffId);
  if (!owner) return badRequest("staffId must be a record id");
  return runDb("write pm sheet pref", async () => {
    await pgExecute(PmSheetPrefWriteOps(owner, kind, input.data ?? {}));
    return ok({ saved: true });
  });
}

/* -------------------------------------------------------------------------- */
/* Handover                                                                   */
/* -------------------------------------------------------------------------- */

export async function listPendingHandovers(
  caller: NeotmsCaller,
  request: RequestData,
): Promise<ResponseData<(PmHandover & { row: PmSheetRow })[] | string>> {
  const owner = ownerOf(caller, request.queryParams["staffId"]);
  if (!owner) return badRequest("staffId must be a record id");
  return runDb("list pending handovers", async () => ok((await pgQuery(PendingHandoversOps(owner))).data));
}

/** Keys whose value differs between two snapshots - what the handover sheet paints yellow. */
export function changedKeys(previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const norm = (value: unknown) => (value === null || value === undefined ? "" : String(value));
  return [...keys].filter((key) => norm(previous[key]) !== norm(next[key])).sort();
}

export type HandoverCreateResult = {
  created: number;
  skipped: { jobId: string; reason: string }[];
};

export async function createHandovers(
  caller: NeotmsCaller,
  input: PmHandoverCreate,
  ctx: WriteContext,
): Promise<ResponseData<HandoverCreateResult | string>> {
  const message = input.message?.trim() ? input.message.trim() : null;
  return runDb("create job handovers", async () =>
    pgTransaction(async (client) => {
      const result: HandoverCreateResult = { created: 0, skipped: [] };
      for (const jobId of [...new Set(input.jobIds)]) {
        const job = (await pgQuery(JobSnapshotOps(jobId), client)).data;
        if (!job) {
          result.skipped.push({ jobId, reason: "작업을 찾을 수 없습니다." });
          continue;
        }
        if (!job.pmId) {
          result.skipped.push({ jobId, reason: "담당 PM 이 지정되지 않은 작업입니다." });
          continue;
        }
        const previous = (await pgQuery(PreviousHandoverOps(jobId), client)).data;
        const changed = previous ? changedKeys(previous.snapshot, job.snapshot) : [];
        // Already on the receiver's sheet → a re-handover: it stays there and only asks to confirm.
        const rehandover = (await pgQuery(PmSheetHasJobOps(job.pmId, jobId), client)).data;
        const id = (
          await pgExecute(
            HandoverInsertOps({
              jobId,
              fromStaffId: caller.staffId,
              toStaffId: job.pmId,
              message,
              snapshot: job.snapshot,
              changedKeys: changed,
              rehandover,
              actor: ctx.actor,
            }),
            client,
          )
        ).data;
        await pgExecute(
          NoticeInsertOps({
            staffId: job.pmId,
            kind: previous || rehandover ? "rehandover" : "handover",
            jobId,
            handoverId: id,
            message,
            fromName: caller.name,
          }),
          client,
        );
        result.created += 1;
      }
      return ok(result);
    }),
  );
}

export async function answerHandover(
  caller: NeotmsCaller,
  id: string,
  input: PmHandoverAnswer,
  ctx: WriteContext,
): Promise<ResponseData<{ status: number } | string>> {
  const reply = input.reply?.trim() ? input.reply.trim() : null;
  if (input.action !== "accept" && !reply) {
    return badRequest(input.action === "reject" ? "거부 사유를 적어 주세요." : "수정 요청 내용을 적어 주세요.");
  }
  const status = input.action === "accept" ? 1 : input.action === "revision" ? 2 : -1;
  return runDb("answer job handover", async () => {
    const handover = (await pgQuery(HandoverGetOps(id))).data;
    if (!handover) return notFound("handover");
    if (handover.rehandover && status === -1) {
      return badRequest("재인계는 반려할 수 없습니다. 고칠 점이 있으면 수정 요청을 보내 주세요.");
    }
    return pgTransaction(async (client) => {
      const changed = (await pgExecute(HandoverAnswerOps(id, status, reply, ctx.actor), client)).data;
      if (changed === 0) {
        return badRequest("이미 처리되었거나 더 새로운 인계가 있는 건입니다. 화면을 새로 고쳐 주세요.");
      }
      if (status === 1 && handover.rehandover) {
        // A re-handover only asks for confirmation: 진행 상태 stays as it is, and every changed cell counts as 확인.
        await markSeen(handover.toStaffId, [handover.jobId], null, client);
      } else if (status === 1) {
        // On the sheet, starting at the first PM step, and visible even if it was removed before.
        await pgExecute(
          PmSheetRowWriteOps(handover.toStaffId, handover.jobId, { pmState: "인계 수령", hidden: false }, ctx.actor),
          client,
        );
        await pgExecute(PmProjectStateSyncOps(handover.jobId, ctx.actor), client);
      }
      if (handover.fromStaffId) {
        await pgExecute(
          NoticeInsertOps({
            staffId: handover.fromStaffId,
            kind: status === 1 ? "accept" : status === 2 ? "revision" : "reject",
            jobId: handover.jobId,
            handoverId: id,
            message: reply,
            fromName: caller.name,
          }),
          client,
        );
      }
      return ok({ status });
    });
  });
}

export async function listProjectHandovers(projectId: string): Promise<ResponseData<PmHandover[] | string>> {
  return runDb("list project handovers", async () => ok((await pgQuery(ProjectHandoversOps(projectId))).data));
}

/* -------------------------------------------------------------------------- */
/* Notices, suggestions                                                       */
/* -------------------------------------------------------------------------- */

export async function listNotices(
  caller: NeotmsCaller,
): Promise<ResponseData<{ items: PmNotice[]; unread: number; pendingHandovers: number } | string>> {
  return runDb("list notices", async () => {
    const items = (await pgQuery(NoticesOps(caller.staffId))).data;
    const pendingHandovers = (await pgQuery(PendingHandoverCountOps(caller.staffId))).data;
    return ok({ items, unread: items.filter((n) => !n.read).length, pendingHandovers });
  });
}

export async function readNotices(
  caller: NeotmsCaller,
  input: PmNoticesRead,
): Promise<ResponseData<{ read: number } | string>> {
  return runDb("read notices", async () =>
    ok({ read: (await pgExecute(NoticesReadOps(caller.staffId, input.ids ?? null))).data }),
  );
}

export async function translatorSuggestions(
  request: RequestData,
): Promise<ResponseData<PmTranslatorSuggestion[] | string>> {
  const jobId = request.queryParams["jobId"] ?? "";
  if (!ID.test(jobId)) return badRequest("jobId must be a record id");
  return runDb("translator suggestions", async () => ok((await pgQuery(TranslatorSuggestionsOps(jobId))).data));
}

/* -------------------------------------------------------------------------- */
/* Changed cells (db/012)                                                     */
/* -------------------------------------------------------------------------- */

/** Copy the current linked values of `jobIds` (only `keys`, or all) into `staffId`'s seen rows. */
async function markSeen(staffId: string, jobIds: readonly string[], keys: readonly string[] | null, client?: PoolClient) {
  if (jobIds.length === 0) return;
  const rows = (await pgQuery(SheetSnapshotRowsOps(jobIds), client)).data;
  const items = rows.map((row) => {
    const now = sheetSnapshot(row);
    const values = keys ? Object.fromEntries(Object.entries(now).filter(([k]) => keys.includes(k))) : now;
    return { jobId: row.jobId, values };
  });
  await pgExecute(SeenMergeOps(staffId, items, true), client);
}

export type PmSeenResult = { confirmed: number; rehandoversConfirmed: number };

/**
 * 확인 — the owner accepts the changed cells of some rows (`keys`, or all of them). A row with
 * nothing left to confirm also confirms its waiting re-handover: the re-handover only asked the PM
 * to look at what changed.
 */
export async function confirmPmSeen(
  caller: NeotmsCaller,
  input: PmSeenInput,
  ctx: WriteContext,
): Promise<ResponseData<PmSeenResult | string>> {
  const owner = ownerOf(caller, input.staffId);
  if (!owner) return badRequest("staffId must be a record id");
  const jobIds = [...new Set(input.jobIds)];
  return runDb("confirm pm sheet changes", async () => {
    for (const jobId of jobIds) {
      if (!(await pgQuery(PmSheetHasJobOps(owner, jobId))).data) return notFound("sheet row");
    }
    return pgTransaction(async (client) => {
      await markSeen(owner, jobIds, input.keys ?? null, client);
      const seen = (await pgQuery(SeenReadOps(owner), client)).data;
      const rows = (await pgQuery(SheetSnapshotRowsOps(jobIds), client)).data;
      let rehandovers = 0;
      for (const row of rows) {
        if (seenDiff(seen.get(row.jobId) ?? {}, sheetSnapshot(row)).length > 0) continue;
        const pending = (await pgQuery(PendingRehandoverOps(owner, row.jobId), client)).data;
        if (!pending) continue;
        const handover = (await pgQuery(HandoverGetOps(pending), client)).data;
        if ((await pgExecute(HandoverAnswerOps(pending, 1, null, ctx.actor), client)).data === 0) continue;
        rehandovers += 1;
        if (handover?.fromStaffId) {
          await pgExecute(
            NoticeInsertOps({
              staffId: handover.fromStaffId,
              kind: "accept",
              jobId: row.jobId,
              handoverId: pending,
              message: null,
              fromName: caller.name,
            }),
            client,
          );
        }
      }
      return ok({ confirmed: jobIds.length, rehandoversConfirmed: rehandovers });
    });
  });
}

/**
 * Runs a job / project / PO write and, when it succeeded, records the values it changed as already
 * seen by the caller on their own sheet - so the owner's own edits are not highlighted back at them.
 * Best effort: the write has already happened, so a failure here is logged and swallowed.
 */
export async function keepOwnEditsSeen<T>(
  caller: NeotmsCaller,
  target: { jobId?: string; projectId?: string; poId?: string },
  write: () => Promise<ResponseData<T>>,
): Promise<ResponseData<T>> {
  let jobIds: string[] = [];
  let before = new Map<string, Record<string, string>>();
  try {
    jobIds = (await pgQuery(SeenJobsOfOps(caller.staffId, target))).data;
    if (jobIds.length > 0) {
      before = new Map((await pgQuery(SheetSnapshotRowsOps(jobIds))).data.map((row) => [row.jobId, sheetSnapshot(row)]));
    }
  } catch (err) {
    console.error(`[neotms] pm sheet seen (before) failed : ${String(err)}`);
    jobIds = [];
  }
  const result = await write();
  if (jobIds.length === 0 || result.status < 200 || result.status >= 300) return result;
  try {
    const after = (await pgQuery(SheetSnapshotRowsOps(jobIds))).data;
    const items = after
      .map((row) => {
        const now = sheetSnapshot(row);
        const old = before.get(row.jobId) ?? {};
        return { jobId: row.jobId, values: Object.fromEntries(Object.entries(now).filter(([k, v]) => old[k] !== v)) };
      })
      .filter((item) => Object.keys(item.values).length > 0);
    if (items.length > 0) await pgExecute(SeenMergeOps(caller.staffId, items, false));
  } catch (err) {
    console.error(`[neotms] pm sheet seen (after) failed : ${String(err)}`);
  }
  return result;
}

/** Row positions in one go (inserting or deleting a row moves every row below it). */
export async function orderPmRows(
  caller: NeotmsCaller,
  input: PmRowOrderInput,
  ctx: WriteContext,
): Promise<ResponseData<{ saved: number } | string>> {
  const owner = ownerOf(caller, input.staffId);
  if (!owner) return badRequest("staffId must be a record id");
  return runDb("order pm sheet rows", async () =>
    pgTransaction(async (client) => {
      let saved = 0;
      for (const item of input.items) {
        if (!(await pgQuery(PmSheetHasJobOps(owner, item.jobId), client)).data) continue;
        await pgExecute(PmSheetRowWriteOps(owner, item.jobId, { ordNo: item.ordNo }, ctx.actor), client);
        saved += 1;
      }
      return ok({ saved });
    }),
  );
}
