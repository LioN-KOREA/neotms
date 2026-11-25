// SPDX-License-Identifier: MIT
//
// `job.job_state` 의 값 중 서버가 직접 쓰는 것 — 화면의 JOB_STATES(neotms.codes.ts)와 같은 글자.
//
// 프로젝트·PO 상태와 같은 단어('진행')가 있지만 다른 열의 다른 질문이라 모듈을 따로 둔다
// (NeotmsProjectStates · NeotmsPoStates 머리말과 같은 이유). 지금은 인계할 때 '대기' → '진행'
// 하나뿐이다 (팀장님 2026-11-25).

export const JOB_STATE_WAITING = "대기";
export const JOB_STATE_IN_PROGRESS = "진행";
