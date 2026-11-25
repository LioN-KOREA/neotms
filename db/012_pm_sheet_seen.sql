-- =====================================================================
-- 012_pm_sheet_seen.sql — 나의 업무 시트: 바뀐 칸 표시와 재인계 (2026-11-25, 팀장님 요청)
--
-- 1. pm_sheet_seen — 시트 주인이 마지막으로 "확인한" 값.
--
--    시트의 연동 칸(업체·담당·번역어·번역가·감수자·분량·도착일·납품일…)은 작업·프로젝트·PO
--    원본에서 바로 읽는다. 다른 사람이 프로젝트 창 등에서 그 값을 바꾸면, 지금 값이 여기 적힌
--    값과 달라지고 시트가 그 칸을 강조해 보인다. 주인이 '확인' 을 누르면 지금 값이 새 기준이
--    된다. 주인이 직접(시트에서든 작업 창에서든) 바꾼 값은 저장할 때 바로 여기에도 적혀서
--    강조되지 않는다.
--
--    snapshot 의 키는 시트 열 키(cusCodeName, translator, jobEday …)와 같다. 행이 처음 시트에
--    보일 때 지금 값으로 만들어진다 — 그래서 처음에는 아무 칸도 강조되지 않는다.
--
-- 2. job_handover.rehandover — 이미 받는 사람의 시트에 있는 작업을 다시 넘긴 인계.
--
--    재인계는 확인 차원의 인계다: 작업 내용은 저장하는 즉시 시트에 반영되므로, 재인계가
--    기다리는 동안에도 작업은 시트에 그대로 남는다(시트 구성에서 대기·수정 요청 중인 재인계는
--    건너뛴다). 재인계는 '확인' 또는 '수정 요청' 만 받고 반려는 없다. 확인해도 PM 진행 상태는
--    처음으로 돌아가지 않는다.
--
-- 새 표 하나와 기본값 있는 열 하나 — 기존 데이터는 바뀌지 않는다. 다시 실행해도 안전하다.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS pm_sheet_seen (
  staff_id   bigint NOT NULL REFERENCES staff(id),
  job_id     bigint NOT NULL REFERENCES job(id),
  snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, job_id)
);

COMMENT ON TABLE pm_sheet_seen IS
  'The linked values of a PM work-sheet row as its owner last confirmed them. The sheet highlights every linked cell whose current value differs; confirming copies the current value in. Writes by the owner through the job / project / PO screens update it at once, so only other people''s changes are highlighted. Keys are the sheet column keys.';

ALTER TABLE job_handover
  ADD COLUMN IF NOT EXISTS rehandover boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN job_handover.rehandover IS
  'True when the job was already on the receiver''s sheet when this handover was sent. A waiting or revision-requested re-handover does not take the job off that sheet, it can be confirmed or sent back for revision but not rejected, and confirming it keeps the PM state.';

COMMIT;
