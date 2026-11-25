// SPDX-License-Identifier: MIT
//
// 작업 그룹 (팀장님 2026-11-25, db/014_job_group.sql).
//
// 코드 = 알파벳 한 글자 + 회사 전체에서 이어지는 번호(6000부터). 새 코드는 언제나 DB 함수
// `neotms_next_job_group(만든 사람, 프로젝트)` 가 만든다 — 알파벳 고르기(영업담당 글자 → 프로젝트 영업담당
// 글자 → 'X')와 번호 발급이 한 곳에 있게.
//
// 사용자가 코드를 직접 지어 넣을 수는 없다. 주는 코드는 "같은 프로젝트에 이미 있는 그룹" 이어야 한다.

import { pgExecute, pgQuery, pgTransaction, param, readText, type SqlOps, type SqlRow } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { badRequest, notFound, ok, runDb } from "../NeotmsResult.js";
import { ProjectVisibleOps } from "../projects/NeotmsProject.dbops.js";
import type { JobGroupActionInput } from "../neotms.schemas.js";

/** 같은 프로젝트에 없는 그룹을 주었을 때 — 트랜잭션을 되돌리려고 던진다. */
export class JobGroupRefused extends Error {}
export const JOB_GROUP_REFUSED = "같은 프로젝트에 있는 작업 그룹만 고를 수 있습니다. 화면을 새로 고쳐 주세요.";

/**
 * 작업 하나의 그룹을 정한다. `group` 이 null 이면 새 코드, 있으면 같은 프로젝트의 다른 (살아 있는) 작업이
 * 쓰는 코드일 때만. 정해진 코드를 돌려준다 — 받아들이지 않았으면 null.
 */
export const JobGroupSetOps = (jobId: string, group: string | null, staffId: string | null): SqlOps<string | null> => ({
  sql: `
    UPDATE job j
       SET job_group = CASE
             WHEN CAST(:grp AS text) IS NULL THEN neotms_next_job_group(CAST(:staff AS bigint), j.project_id)
             WHEN EXISTS (SELECT 1 FROM job o
                           WHERE o.project_id = j.project_id AND o.id <> j.id
                             AND o.deleted = false AND o.job_group = CAST(:grp AS text)) THEN CAST(:grp AS text)
             ELSE j.job_group
           END
     WHERE j.id = :id
    RETURNING j.job_group AS job_group,
              (CAST(:grp AS text) IS NULL OR j.job_group = CAST(:grp AS text)) AS accepted
  `,
  parameters: [param("id", jobId, "id"), param("grp", group, "text"), param("staff", staffId, "id")],
  mapper: (rows: SqlRow[]) => {
    const row = rows[0];
    if (!row || row["accepted"] === false) return null;
    return readText(row, "job_group");
  },
});

/** 이 프로젝트의 살아 있는 작업 중 고른 것 — 번호와 그룹. 다른 프로젝트 작업은 빠진다. */
const PickedGroupJobsOps = (projectId: string, jobIds: string[]): SqlOps<{ id: string; group: string | null }[]> => ({
  sql: `
    SELECT id, job_group FROM job
     WHERE project_id = :project_id AND id = ANY(:job_ids) AND deleted = false
  `,
  parameters: [param("project_id", projectId, "id"), param("job_ids", jobIds, "idArray")],
  mapper: (rows: SqlRow[]) => rows.map((r) => ({ id: String(r["id"]), group: readText(r, "job_group") })),
});

const SetGroupOps = (jobIds: string[], group: string): SqlOps<number> => ({
  sql: `UPDATE job SET job_group = :grp, updated_at = now() WHERE id = ANY(:job_ids)`,
  parameters: [param("job_ids", jobIds, "idArray"), param("grp", group, "text")],
  mapper: (rows) => rows.length,
});

const NewGroupOps = (staffId: string | null, projectId: string): SqlOps<string> => ({
  sql: `SELECT neotms_next_job_group(CAST(:staff AS bigint), CAST(:project_id AS bigint)) AS job_group`,
  parameters: [param("staff", staffId, "id"), param("project_id", projectId, "id")],
  mapper: (rows: SqlRow[]) => readText(rows[0] ?? {}, "job_group") ?? "",
});

/** 다음에 만들어질 코드 미리보기 — 번호를 쓰지 않는다 (작업 등록 창의 '예정' 표시). */
const PeekGroupOps = (staffId: string | null, projectId: string): SqlOps<string> => ({
  sql: `
    SELECT coalesce(neotms_staff_group_letter(CAST(:staff AS bigint)),
                    neotms_staff_group_letter((SELECT prj_mgr_id FROM project WHERE id = CAST(:project_id AS bigint))),
                    'X')
           || (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM job_group_seq)::text AS job_group
  `,
  parameters: [param("staff", staffId, "id"), param("project_id", projectId, "id")],
  mapper: (rows: SqlRow[]) => readText(rows[0] ?? {}, "job_group") ?? "",
});

/** 코드의 번호 — 'J6012' → 6012. 모양이 틀리면 아주 큰 수(맨 뒤로). */
export function groupNumber(code: string | null): number {
  const m = /^[A-Z](\d+)$/.exec(code ?? "");
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export async function peekJobGroup(caller: NeotmsCaller, projectId: string): Promise<ResponseData<{ code: string } | string>> {
  return runDb("peek job group", async () => {
    const visible = (await pgQuery(ProjectVisibleOps(caller, projectId))).data;
    if (!visible) return notFound("project");
    return ok({ code: (await pgQuery(PeekGroupOps(caller.staffId, projectId))).data });
  });
}

/**
 * [작업 그룹] 단추.
 *   merge — 고른 작업들을 그중 번호가 가장 낮은 코드 하나로.
 *   new   — 고른 작업들에 새 코드 하나 (분리, 그룹 조정 창).
 */
export async function applyJobGroup(
  caller: NeotmsCaller,
  projectId: string,
  input: JobGroupActionInput,
): Promise<ResponseData<{ code: string; jobIds: string[] } | string>> {
  return runDb("job group", async () => {
    const visible = (await pgQuery(ProjectVisibleOps(caller, projectId))).data;
    if (!visible) return notFound("project");
    const ids = [...new Set(input.jobIds)];
    const jobs = (await pgQuery(PickedGroupJobsOps(projectId, ids))).data;
    if (jobs.length !== ids.length) return badRequest("이 프로젝트의 작업이 아닌 것이 섞여 있습니다. 화면을 새로 고쳐 주세요.");
    return pgTransaction(async (client) => {
      let code: string;
      if (input.mode === "merge") {
        const lowest = jobs.map((j) => j.group).filter((g): g is string => !!g).sort((a, b) => groupNumber(a) - groupNumber(b))[0];
        code = lowest ?? (await pgQuery(NewGroupOps(caller.staffId, projectId), client)).data;
      } else {
        code = (await pgQuery(NewGroupOps(caller.staffId, projectId), client)).data;
      }
      await pgExecute(SetGroupOps(ids, code), client);
      return ok({ code, jobIds: ids });
    });
  });
}
