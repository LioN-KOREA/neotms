// SPDX-License-Identifier: MIT
//
// 프로젝트의 '인계' (팀장님 2026-11-25) — 작업을 골라 각 작업의 담당PM 에게 넘기고, 원하면 인계
// 메일까지 PM 마다 보낸다.
//
//   [인계]       작업마다 job_handover 를 만든다(createHandovers 와 같은 길). 메시지는 인계정보
//                입력 창의 답으로 만든 비고 글(handoverRemark) — PM 이 받으면 시트 비고 칸에 들어간다.
//   [인계·발송]  위와 같이 인계한 뒤, 담당PM 마다 그 PM 의 작업만 담은 인계 메일을 보낸다.
//                받는 사람은 PM 의 직원 정보 이메일, 참조는 창에서 적은 주소들.
//
// ## 순서
//
// 프로젝트를 호출자의 범위로 먼저 읽는다(NeotmsHandoverManager 머리말과 같은 이유). 그다음 검사 —
// 담당PM 이 없는 작업, (발송이면) 이메일이 없는 PM — 를 모두 끝내고, 하이웍스 로그인까지 성공한
// 뒤에야 인계를 만든다. 로그인이 틀렸는데 인계만 만들어져 있으면, 다시 누를 때 재인계가 된다.
//
// ## 하이웍스 ID·비밀번호
//
// 로그인에 한 번 쓰이고 끝난다. 저장·기록·응답 어디에도 넣지 않는다.

import { pgExecute, pgQuery, param, readText, type SqlOps, type SqlRow } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { badRequest, notFound, ok, runDb } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import { ProjectGetOps } from "../projects/NeotmsProject.dbops.js";
import type { JobHandoverInput } from "../neotms.schemas.js";
import { createHandovers, type HandoverCreateResult } from "../pmsheet/NeotmsPmSheetManager.js";
import { hiworksLogin, hiworksSendEmail } from "./HiworksClient.js";
import type { HandoverJob } from "./NeotmsHandover.dbops.js";
import { composeHandoverMail } from "./NeotmsHandoverMail.js";
import { composeHandoverRemark } from "./handoverRemark.js";
import { JOB_STATE_IN_PROGRESS, JOB_STATE_WAITING } from "../NeotmsJobStates.js";

/** 고른 작업 하나 — 메일에 들어갈 칸과 받는 PM. */
export type PickedHandoverJob = HandoverJob & {
  jobId: string;
  pmId: string | null;
  pmEmail: string | null;
};

/**
 * 이 프로젝트의 작업 중 고른 것만. 다른 프로젝트의 작업 번호는 걸러진다 — 개수가 모자라면 거절.
 * 범위 절이 없는 이유는 `HandoverJobsOps` 머리말과 같다(프로젝트를 먼저 범위로 읽었다).
 */
export const PickedHandoverJobsOps = (projectId: string, jobIds: string[]): SqlOps<PickedHandoverJob[]> => ({
  sql: `
    SELECT
      j.id            AS job_id,
      j.job_name      AS job_name,
      j.job_type      AS job_type,
      j.job_pm_id     AS pm_id,
      COALESCE(NULLIF(s.mgr_name, ''), j.job_pm_name) AS job_pm_name,
      s.mgr_email     AS pm_email,
      j.job_eday      AS job_eday,
      j.job_eday_time AS job_eday_time,
      jdl.job_slang   AS job_slang,
      jdl.job_elang   AS job_elang
      FROM job j
      LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
      LEFT JOIN staff s ON s.id = j.job_pm_id
     WHERE j.project_id = :project_id
       AND j.id = ANY(:job_ids)
       AND j.deleted = false
     ORDER BY j.id
  `,
  parameters: [param("project_id", projectId, "id"), param("job_ids", jobIds, "idArray")],
  mapper: (rows: SqlRow[]) =>
    rows.map((row) => ({
      jobId: String(row["job_id"]),
      jobName: readText(row, "job_name"),
      jobType: readText(row, "job_type"),
      jobSlang: readText(row, "job_slang"),
      jobElang: readText(row, "job_elang"),
      jobPmName: readText(row, "job_pm_name"),
      jobEday: readText(row, "job_eday"),
      jobEdayTime: readText(row, "job_eday_time"),
      pmId: row["pm_id"] === null || row["pm_id"] === undefined ? null : String(row["pm_id"]),
      pmEmail: readText(row, "pm_email"),
    })),
});

/** 인계한 작업 중 '대기' 인 것을 '진행' 으로 (팀장님 2026-11-25). 다른 상태는 그대로. */
export const StartWaitingJobsOps = (jobIds: string[]): SqlOps<number> => ({
  sql: `
    UPDATE job SET job_state = :next, updated_at = now()
     WHERE id = ANY(:job_ids) AND job_state = :waiting AND deleted = false
  `,
  parameters: [
    param("job_ids", jobIds, "idArray"),
    param("next", JOB_STATE_IN_PROGRESS, "text"),
    param("waiting", JOB_STATE_WAITING, "text"),
  ],
  mapper: (rows) => rows.length,
});

const EMAIL_SHAPE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export type JobHandoverMailResult = { pmName: string; recipient: string; subject: string; sent: boolean; error?: string };
export type JobHandoverResult = HandoverCreateResult & { mails: JobHandoverMailResult[] };

export async function sendJobHandover(
  caller: NeotmsCaller,
  projectId: string,
  input: JobHandoverInput,
  ctx: WriteContext,
): Promise<ResponseData<JobHandoverResult | string>> {
  const formatText = input.formatText.trim();
  const layoutText = input.layoutText.trim();
  if (input.formats.length === 0 && !formatText) return badRequest("편집포맷을 고르거나 직접 입력해 주세요.");
  if (input.layouts.length === 0 && !layoutText) return badRequest("레이아웃을 고르거나 직접 입력해 주세요.");

  return runDb("job handover", async () => {
    const project = (await pgQuery(ProjectGetOps(caller, projectId))).data;
    if (!project) return notFound("project");

    const ids = [...new Set(input.jobIds)];
    const jobs = (await pgQuery(PickedHandoverJobsOps(projectId, ids))).data;
    if (jobs.length !== ids.length) return badRequest("이 프로젝트의 작업이 아닌 것이 섞여 있습니다. 화면을 새로 고쳐 주세요.");

    const noPm = jobs.filter((j) => !j.pmId);
    if (noPm.length > 0) {
      return badRequest(`담당PM 이 비어 있는 작업이 있습니다: ${noPm.map((j) => j.jobName ?? j.jobId).join(", ")}`);
    }

    let login: Awaited<ReturnType<typeof hiworksLogin>>["result"] | null = null;
    if (input.send) {
      const noMail = jobs.filter((j) => !EMAIL_SHAPE.test((j.pmEmail ?? "").trim()));
      if (noMail.length > 0) {
        const names = [...new Set(noMail.map((j) => j.jobPmName ?? j.pmId ?? ""))];
        return badRequest(`이메일 주소가 등록되지 않은 담당PM 이 있습니다: ${names.join(", ")}. 직원 정보에 이메일을 넣거나 '인계' 만 눌러 주세요.`);
      }
      const id = (input.hiworksId ?? "").trim();
      const pw = input.hiworksPassword ?? "";
      if (!id || !pw) return badRequest("메일을 보내려면 하이웍스 ID 와 비밀번호를 넣어 주세요.");
      const signedIn = await hiworksLogin(id, pw);
      if (!signedIn.result) {
        const credentialProblem = signedIn.status === 200 || (signedIn.status >= 400 && signedIn.status < 500);
        return credentialProblem
          ? { status: 400, body: "하이웍스 로그인에 실패했습니다. ID 와 비밀번호를 확인해 주세요. (인계는 하지 않았습니다)" }
          : { status: 502, body: "하이웍스에 연결하지 못했습니다. 잠시 뒤 다시 해 주세요. (인계는 하지 않았습니다)" };
      }
      login = signedIn.result;
    }

    const message = composeHandoverRemark({
      formats: input.formats,
      formatText,
      layouts: input.layouts,
      layoutText,
      note: input.note,
    });
    const created = await createHandovers(caller, { jobIds: ids, message }, ctx);
    if (created.status !== 200 || typeof created.body === "string") return created as ResponseData<string>;
    const result: JobHandoverResult = { ...created.body, mails: [] };
    const skippedIds = new Set(result.skipped.map((s) => s.jobId));
    const handed = ids.filter((jobId) => !skippedIds.has(jobId));
    if (handed.length > 0) await pgExecute(StartWaitingJobsOps(handed));

    if (login) {
      const skipped = new Set(result.skipped.map((s) => s.jobId));
      const byPm = new Map<string, PickedHandoverJob[]>();
      for (const job of jobs) {
        if (skipped.has(job.jobId)) continue;
        const list = byPm.get(job.pmId!) ?? [];
        list.push(job);
        byPm.set(job.pmId!, list);
      }
      for (const group of byPm.values()) {
        const recipient = group[0]!.pmEmail!.trim();
        const pmName = group[0]!.jobPmName ?? recipient;
        const mail = composeHandoverMail(project, group, {
          formats: input.formats,
          layouts: input.layouts,
          note: input.note,
          formatText,
          layoutText,
          deadlineFromJobs: true,
        });
        const sent = await hiworksSendEmail(login, [recipient], [], input.cc, mail.subject, mail.html);
        result.mails.push(
          sent.status === 200
            ? { pmName, recipient, subject: mail.subject, sent: true }
            : { pmName, recipient, subject: mail.subject, sent: false, error: `하이웍스가 발송을 거절했습니다 (HTTP ${sent.status}).` },
        );
      }
    }
    return ok(result);
  });
}
