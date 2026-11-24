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
  PreviousHandoverOps,
  ProjectHandoversOps,
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
  type PmRowPatch,
} from "./NeotmsPmSheet.schemas.js";

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
        const id = (
          await pgExecute(
            HandoverInsertOps({
              jobId,
              fromStaffId: caller.staffId,
              toStaffId: job.pmId,
              message,
              snapshot: job.snapshot,
              changedKeys: changed,
              actor: ctx.actor,
            }),
            client,
          )
        ).data;
        await pgExecute(
          NoticeInsertOps({
            staffId: job.pmId,
            kind: previous ? "rehandover" : "handover",
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
    return pgTransaction(async (client) => {
      const changed = (await pgExecute(HandoverAnswerOps(id, status, reply, ctx.actor), client)).data;
      if (changed === 0) {
        return badRequest("이미 처리되었거나 더 새로운 인계가 있는 건입니다. 화면을 새로 고쳐 주세요.");
      }
      if (status === 1) {
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
