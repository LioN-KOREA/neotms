-- =====================================================================
-- NEOTMS :: 005_project_acceptance.sql
-- Adds project.acceptance_status and project_acceptance to a database
-- that already has data.
-- =====================================================================
--
-- One column, one table, one index. Nothing to migrate and no point of no
-- return: everything here is additive and re-runnable, so a run
-- interrupted halfway can simply be repeated.
--
-- A database built from db/001_schemas.sql has all of this already.
-- Giving it this file is harmless -- every statement is IF NOT EXISTS or
-- a drop-and-recreate of a constraint -- but it is not needed.
--
-- APPLY THIS BEFORE THE DEPLOY. The application selects
-- project.acceptance_status on every project list and every project
-- detail, so until the column exists those endpoints answer 42703 and
-- the project screens are blank. The same ordering 004 uses, for the same
-- reason.
--
-- WHAT IT IS FOR
--
-- A project is assigned to a PM, and the PM answers: accepted, or
-- rejected. Three values, as specified: 0 assigned and unanswered, 1
-- accepted, -1 rejected. The column carries the current answer; the table
-- carries every answer ever given, because the column is RESET TO 0 when
-- the project is reassigned and that reset would otherwise destroy the
-- previous PM's answer along with the reason they gave.
--
-- There is no un-accept. A PM who accepted and then cannot deliver is
-- handled by reassigning the project, which resets the column and asks
-- the new PM -- so the way out of a wrong answer is an act by somebody
-- else, with a record of its own.
--
-- EXISTING ROWS ARE LEFT AT 0 AND NOT BACKFILLED
--
-- Every project in the database therefore reads as "assigned, unanswered"
-- the moment this applies, including projects delivered and invoiced
-- years ago. That is deliberate. The alternative -- UPDATE project SET
-- acceptance_status = 1 -- claims that somebody accepted them, and there
-- is no project_acceptance row to say who or when, so the claim would be
-- unfalsifiable and false. If the noise is not wanted, the honest fix is
-- a filter on the screens, not a fact in the table.
--
-- =====================================================================

BEGIN;


-- ---------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------
--
-- NOT NULL DEFAULT 0 is rewrite-free on PostgreSQL 11+ (the default is
-- stored in pg_attribute.attmissingval), so this does not take a long
-- exclusive lock on a large project table.
--
-- The DEFAULT STAYS, permanently. The usual playbook drops it after a
-- backfill; here the external LKTMS ETL does not know this column exists,
-- and 0 is the correct answer for anything it inserts -- a freshly loaded
-- project has not been accepted by anybody.
ALTER TABLE project
  ADD COLUMN IF NOT EXISTS acceptance_status smallint NOT NULL DEFAULT 0;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, hence the drop first.
-- NOT VALID then VALIDATE so the existing rows are checked in a second,
-- lighter pass; VALIDATE is a no-op when the constraint is already valid,
-- which is what makes this block re-runnable.
ALTER TABLE project DROP CONSTRAINT IF EXISTS ck_project_acceptance_status;
ALTER TABLE project
  ADD CONSTRAINT ck_project_acceptance_status CHECK (acceptance_status IN (-1, 0, 1)) NOT VALID;
ALTER TABLE project VALIDATE CONSTRAINT ck_project_acceptance_status;

COMMENT ON COLUMN project.acceptance_status IS
  'NEOTMS only, no legacy column. Whether the assigned PM (prj_pm_id) has taken this project on: 0 = assigned and unanswered, 1 = accepted, -1 = rejected. Written ONLY by ProjectAcceptanceOps, which requires the caller to BE prj_pm_id and the current value to be 0 -- there is no un-accept, deliberately. RESET TO 0 whenever prj_pm_id changes, because the answer belonged to the previous PM and the new one has not been asked; that reset is a CASE in ProjectUpdateOps and fires only when the id actually differs, so an edit that re-submits the same PM does not wipe an acceptance. Every non-zero value also has a row in project_acceptance; this column is the CURRENT answer, that table is the history. Existing rows were left at 0 by db/005 rather than backfilled to 1 -- an acceptance nobody gave is not a fact worth inventing.';


-- ---------------------------------------------------------------------
-- 2. The record
-- ---------------------------------------------------------------------
--
-- Identical to the definition in db/001_schemas.sql; the reasoning is
-- there, in full, and the short version is three absences:
--
--   * NO UNIQUE constraint -- a project reassigned after a rejection
--     collects a second row, and that sequence is the thing recorded.
--   * NO 0 rows -- 0 is the absence of an answer, so a row saying 0 would
--     be a record of nothing having happened.
--   * NO updated_at, NO deleted -- an audit row is never edited and never
--     retracted.
CREATE TABLE IF NOT EXISTS project_acceptance (
  id                bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  project_id        bigint NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  staff_id          bigint NOT NULL REFERENCES staff (id) ON DELETE RESTRICT,
  acceptance_status smallint NOT NULL,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  created_ip        inet,
  CONSTRAINT ck_project_acceptance_answer CHECK (acceptance_status IN (-1, 1))
);

-- (project_id, created_at DESC) rather than (project_id): every read of
-- this table is "the answers for this project, newest first", which is
-- the whole index rather than a sort on top of one.
CREATE INDEX IF NOT EXISTS ix_project_acceptance_project
  ON project_acceptance (project_id, created_at DESC);

COMMENT ON TABLE  project_acceptance IS
  'Every accept or reject a PM has given on a project. NEOTMS only -- no legacy table. Append-only and deliberately without a UNIQUE constraint: a project reassigned after a rejection collects a second row, and that sequence is the thing being recorded. project.acceptance_status is the current answer; this is how it was arrived at. A row exists for every non-zero value of that column, and 0 (unanswered) has no row -- see the CHECK.';
COMMENT ON COLUMN project_acceptance.staff_id IS
  'The PM who answered -- the caller, which the write path has already proved equal to project.prj_pm_id at the time. Not a copy of prj_pm_id read afterwards: by the time anybody reads this row the project may have been reassigned, which is precisely why the answer records its own author.';
COMMENT ON COLUMN project_acceptance.acceptance_status IS
  '1 accepted, -1 rejected. Same vocabulary as project.acceptance_status minus 0, which is the absence of an answer.';
COMMENT ON COLUMN project_acceptance.note IS
  'Optional free text the PM gave with the answer. The reason a rejection is actionable: without it the sales manager learns only that the project came back, and has to telephone to find out why. Optional rather than required on rejection because a blank reason given under protest ("-") is worse than none.';


COMMIT;


-- =====================================================================
-- 3. Verification
-- =====================================================================
--
-- Run these after applying. Each one should answer as the comment says;
-- they are cheap and they cover the three things that would be silently
-- wrong rather than loudly broken.

-- (a) Every project is unanswered, and nothing is outside the vocabulary.
--     Expect one row: 0, <every project>.
SELECT acceptance_status, count(*) AS projects
  FROM project
 GROUP BY acceptance_status
 ORDER BY acceptance_status;

-- (b) The record table exists and is empty. Expect 0.
SELECT count(*) AS answers_recorded FROM project_acceptance;

-- (c) The CHECK is VALID rather than NOT VALID -- i.e. VALIDATE ran.
--     A constraint left NOT VALID accepts nothing new but was never
--     checked against the existing rows, and nothing on any screen would
--     show that. Expect convalidated = true.
SELECT conname, convalidated
  FROM pg_constraint
 WHERE conname IN ('ck_project_acceptance_status', 'ck_project_acceptance_answer')
 ORDER BY conname;
