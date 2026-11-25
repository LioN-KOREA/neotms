-- =====================================================================
-- NEOTMS :: 012_pm_sheet_seen.sql
-- Changed-cell highlighting and re-handover for the 나의 업무 sheet.
-- =====================================================================
--
-- Requested 2026-11-25 (팀장님).
--
-- 1. pm_sheet_seen -- what the sheet's owner last acknowledged (확인)
--
--    The sheet's linked cells (업체, 담당, 번역어, 번역가, 감수자, 분량,
--    도착일, 납품일 and so on) are read straight from the job, project
--    and PO records. When somebody else changes one of those values --
--    from the project window, say -- the live value stops matching what
--    is recorded here, and the sheet highlights that cell. When the
--    owner presses 확인, the live values become the new baseline.
--
--    A value the OWNER changed, on the sheet or in the job window, is
--    written here by the same save, so it never highlights. The point is
--    "somebody else moved this", not "this changed".
--
--    The keys of `snapshot` are the sheet's own column keys
--    (cusCodeName, translator, jobEday and so on). A row's snapshot is
--    created from the live values the first time the row appears on the
--    sheet, which is why nothing is highlighted to begin with.
--
-- 2. job_handover.rehandover -- handing over a job the recipient
--    ALREADY has on their sheet
--
--    A re-handover asks for confirmation and nothing else. Job edits
--    reach the sheet as soon as they are saved, so the job stays on the
--    sheet while the re-handover waits (building the sheet skips
--    re-handovers that are waiting or in 수정 요청).
--
--    It accepts only 확인 or 수정 요청 -- there is no rejection, because
--    there is nothing to refuse: the recipient already holds the job.
--    Confirming does NOT send the PM's 진행 상태 back to its first step.
--
-- One new table and one new column with a default. No existing data is
-- touched, and the file is re-runnable.
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
