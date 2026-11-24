-- =====================================================================
-- NEOTMS :: 009_pm_sheet.sql
-- The PM work sheet ("나의 업무" v2): JOB-level handover, the PM's own
-- per-JOB sheet rows, cells, preferences and notifications.
-- =====================================================================
--
-- ADDITIVE ONLY. Five new tables; no existing table, column, constraint
-- or row is touched, so the PO-level workspace from 006-008 keeps working
-- side by side. Every statement is IF NOT EXISTS / re-runnable.
--
-- APPLY THIS BEFORE THE DEPLOY: /api/v0/pm-sheet reads all five tables.
--
-- WHY A SECOND SHEET MODEL AND NOT AN EXTENSION OF workspace_*
--
-- The specification (기획서 "TMS 운영 PM 업무시트") makes a ROW one JOB -
-- translator and reviewer, each with their PO flag, volume and arrival
-- date, on one line - and makes the HANDOVER per JOB, with accept /
-- request-revision / reject. workspace_cell and workspace_row_style are
-- keyed by po_id, and project_acceptance is per project. Re-keying them
-- would be a destructive migration of tables another branch is actively
-- developing; a parallel model is additive and can absorb or replace
-- them when the two are folded before production.
--
-- WHY jsonb FOR STYLE AND PREFERENCES
--
-- 006-008 name every style property as a column with a CHECK. The sheet
-- now also carries borders, vertical alignment, number decimals, cell
-- notes, conditional-format rules, filter favourites and shortcut maps -
-- all of it the caller's own presentation, none of it read by any other
-- query, report or join. The API validates the shapes (neotms.schemas),
-- and the database bounds the size. If any of it is ever queried across
-- users it should be promoted to columns then.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. job_handover - one row per handover EVENT of one JOB to one PM.
--
-- Append-only, like project_acceptance: a re-handover after a revision
-- request is a new row, and the latest row per job is the current state.
--   status  0 = 대기 (waiting for the PM)
--           1 = 인계 받음 (accepted; the job is on the PM's sheet)
--           2 = 수정 요청 (PM asked the sales PM to fix something)
--          -1 = 거부 (PM refused it)
-- snapshot holds the job's sheet-relevant values at handover time, and
-- changed_keys the keys that differ from the previous handover of the
-- same job - what the handover sheet paints yellow.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_handover (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id        bigint NOT NULL REFERENCES job(id),
  from_staff_id bigint REFERENCES staff(id),
  to_staff_id   bigint NOT NULL REFERENCES staff(id),
  status        smallint NOT NULL DEFAULT 0 CHECK (status IN (-1, 0, 1, 2)),
  message       text CHECK (message IS NULL OR length(message) <= 2000),
  reply         text CHECK (reply IS NULL OR length(reply) <= 2000),
  snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_keys  text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text,
  answered_at   timestamptz,
  answered_by   text
);
CREATE INDEX IF NOT EXISTS job_handover_job_idx ON job_handover (job_id, id DESC);
CREATE INDEX IF NOT EXISTS job_handover_to_idx  ON job_handover (to_staff_id, status);

-- ---------------------------------------------------------------------
-- 2. pm_sheet_row - one PM's own facts about one JOB on their sheet.
--
-- (staff_id, job_id): the row belongs to a SHEET, not to the job, so a
-- backup PM editing another PM's sheet writes that PM's row.
--   pm_state     the 19-step PM status (인계 수령 ... 홀딩/캔슬, 별도 관리
--                프로젝트(시작)/(종료)). Free text bounded here; the
--                vocabulary is the API's, so adding a step needs no DDL.
--   fields       sheet-only values of fixed columns (업무, 비고, 백업, 경로).
--   row_style    the row's own style (jsonb, see header).
--   ord_no       manual order (rows moved into a 별도 관리 group).
--   group_monthly 별도 관리(시작) row: add monthly header rows by 인계일.
--   merged_into  multi-language merge: this row is shown inside that
--                job's row (same project; see the API for the conditions).
--   hidden       the PM removed the row from the sheet (it stays here so
--                the sheet's cells and notes are not lost).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm_sheet_row (
  staff_id      bigint NOT NULL REFERENCES staff(id),
  job_id        bigint NOT NULL REFERENCES job(id),
  pm_state      text CHECK (pm_state IS NULL OR length(pm_state) <= 50),
  fields        jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_style     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ord_no        integer,
  group_monthly boolean NOT NULL DEFAULT false,
  merged_into   bigint REFERENCES job(id),
  hidden        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  updated_by    text,
  PRIMARY KEY (staff_id, job_id),
  CHECK (merged_into IS NULL OR merged_into <> job_id),
  CHECK (pg_column_size(fields) <= 16384 AND pg_column_size(row_style) <= 4096)
);

-- ---------------------------------------------------------------------
-- 3. pm_sheet_cell - one cell of one sheet: a custom column's value, and
-- the style and note of ANY cell (fixed or custom).
--   col_key   a fixed column's key, or 'c:<id>' for a custom column.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm_sheet_cell (
  staff_id   bigint NOT NULL REFERENCES staff(id),
  job_id     bigint NOT NULL REFERENCES job(id),
  col_key    text NOT NULL CHECK (length(col_key) BETWEEN 1 AND 64),
  value      text CHECK (value IS NULL OR length(value) <= 2000),
  style      jsonb NOT NULL DEFAULT '{}'::jsonb,
  note       text CHECK (note IS NULL OR length(note) <= 2000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (staff_id, job_id, col_key),
  CHECK (pg_column_size(style) <= 4096)
);

-- ---------------------------------------------------------------------
-- 4. pm_sheet_pref - one PM's sheet preferences, one document per kind.
--   kind 'columns'    order, widths, column styles/formats, custom columns
--        'cf'         conditional-format rules
--        'filters'    filter favourites (max 3)
--        'shortcuts'  custom shortcut map
--        'view'       frozen rows/columns and the like
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pm_sheet_pref (
  staff_id   bigint NOT NULL REFERENCES staff(id),
  kind       text NOT NULL CHECK (kind IN ('columns', 'cf', 'filters', 'shortcuts', 'view')),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, kind),
  CHECK (pg_column_size(data) <= 65536)
);

-- ---------------------------------------------------------------------
-- 5. staff_notice - in-app notifications (handover arrived, revision
-- requested, rejected, re-handed over). read_at NULL = unread.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff_notice (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_id   bigint NOT NULL REFERENCES staff(id),
  kind       text NOT NULL CHECK (kind IN ('handover', 'rehandover', 'revision', 'reject', 'accept')),
  job_id     bigint REFERENCES job(id),
  handover_id bigint REFERENCES job_handover(id),
  message    text CHECK (message IS NULL OR length(message) <= 2000),
  from_name  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX IF NOT EXISTS staff_notice_unread_idx ON staff_notice (staff_id, id DESC) WHERE read_at IS NULL;

COMMIT;
