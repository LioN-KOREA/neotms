// SPDX-License-Identifier: MIT
//
// 인계메일이 프로젝트에서 읽어 가는 것. 한 건의 읽기뿐이고 쓰기는 없다.
//
// 프로젝트 헤더는 `ProjectGetOps` 가 이미 돌려주므로 여기 없다. 이 파일에 있는 것은 그 프로젝트에
// 달린 **작업들**이고, 메일의 언어·납기·담당PM 세 줄이 전부 거기서 나온다.
//
// ## 왜 scope 절이 없는가
//
// 이 저장소의 모든 읽기는 호출자의 행 범위를 SQL 안에 넣는다. 여기만 예외이고, 예외인 이유를
// 적어 두지 않으면 다음 사람이 "빠뜨렸다" 고 읽는다.
//
// 작업의 범위 컬럼은 셋이다 — `j.job_pm_id`, `p.prj_mgr_id`, `p.prj_pm_id`(`JOB_SCOPE_COLUMNS`).
// 호출하는 쪽은 그 직전에 `ProjectGetOps` 로 **같은 프로젝트를 범위 안에서** 읽어 왔고, 그
// 범위 컬럼은 `p.prj_mgr_id`, `p.prj_pm_id` 다. 즉 프로젝트가 보였다는 사실 자체가 이 프로젝트의
// 모든 작업이 세 조건 중 둘을 이미 만족한다는 뜻이다. 여기에 범위 절을 한 번 더 넣으면 결과가
// 달라지지 않으면서 `JOB_SCOPE_COLUMNS` 의 **네 번째 사본**이 생긴다 — `NeotmsJob.dbops` 의
// 범위 주석이 경고하는 바로 그 어긋남이다.
//
// 그래서 호출 순서가 곧 권한 검사다. 프로젝트를 먼저 읽고, 못 읽으면 여기까지 오지 않는다.

import { param, readText, type SqlOps, type SqlRow } from "../../utils/PostgresUtils.js";

/**
 * 메일 한 통을 쓰는 데 필요한 작업 한 건. 작업의 모든 칸이 아니라 **메일에 나오는 칸만** 이다.
 *
 * 금액이 없다. 인계메일은 운영 PM 에게 "무엇을 언제까지 어떤 모양으로" 를 넘기는 문서이고 단가·
 * 매출은 그 사람의 일이 아니다. 돈을 읽지 않는 쿼리는 돈을 샐 수 없다.
 */
export type HandoverJob = {
  jobName: string | null;
  /** 업무 구분. 언어쌍을 가진 작업인지 가리는 값 - `isLinguistic` 이 읽는다. */
  jobType: string | null;
  jobSlang: string | null;
  jobElang: string | null;
  /** 이 작업의 담당 PM. 메일의 담당PM 칸은 이 이름들을 모은 것이다. */
  jobPmName: string | null;
  jobEday: string | null;
  jobEdayTime: string | null;
};

/**
 * 한 프로젝트의 살아 있는 작업 전부. 페이지가 없다.
 *
 * 커서도 상한도 두지 않은 이유는 이 목록이 **한 통의 메일 본문**이기 때문이다. 50건에서 잘린
 * 언어 목록은 잘렸다는 표시가 메일 어디에도 남지 않으므로, 받는 사람은 빠진 언어를 "없는 것"
 * 으로 읽는다. 한 프로젝트의 작업 수는 현실적으로 수십 건이고, 그 크기의 결과를 자르는 것보다
 * 전부 읽는 쪽이 싸다.
 *
 * 정렬은 `j.id` 다. 작업이 등록된 순서이고, 그 순서가 곧 사용자가 상세 화면에서 보는 순서다 —
 * 메일의 언어 나열 순서가 화면과 다르면 두 쪽을 대조하는 사람이 누락을 의심한다.
 */
export const HandoverJobsOps: (projectId: string) => SqlOps<HandoverJob[]> = (projectId) => ({
  sql: `
    SELECT
      j.job_name      AS job_name,
      j.job_type      AS job_type,
      j.job_pm_name   AS job_pm_name,
      j.job_eday      AS job_eday,
      j.job_eday_time AS job_eday_time,
      jdl.job_slang   AS job_slang,
      jdl.job_elang   AS job_elang
      FROM job j
      LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id
     WHERE j.project_id = :project_id
       AND j.deleted = false
     ORDER BY j.id
  `,
  parameters: [param("project_id", projectId, "id")],
  mapper: (rows: SqlRow[]) =>
    rows.map((row) => ({
      jobName: readText(row, "job_name"),
      jobType: readText(row, "job_type"),
      jobSlang: readText(row, "job_slang"),
      jobElang: readText(row, "job_elang"),
      jobPmName: readText(row, "job_pm_name"),
      jobEday: readText(row, "job_eday"),
      jobEdayTime: readText(row, "job_eday_time"),
    })),
});
