-- =====================================================================
-- NEOTMS :: 011_job_types.sql
-- Run after 007_codes.sql. Idempotent -- re-run it as often as you like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   Every job and purchase order in this schema assumed the work was
--   interpretation or translation. `job.job_slang` / `job.job_elang` sat
--   on the job row, the console asked for a source and a target language
--   on every job, the job list filtered on them, and the margin report
--   had a 언어쌍별 dimension built out of them.
--
--   The business is no longer only linguistics. It now also sells MICE
--   and IMC, and that work has no language pair at all -- what it has is
--   a 업무 분류 (온라인홍보 / 오프라인홍보 / 온오프라인홍보 / 행사운영).
--   Before this file the only way to record a MICE job was as a
--   linguistics job with both languages blank, which means
--
--     1. it was indistinguishable from a translation job somebody had
--        forgotten to fill in,
--     2. it could not be found by the one thing that identifies it --
--        its category -- because there was nowhere to put it, and
--     3. it landed in the 언어쌍별 report under '? > ?', a bucket whose
--        whole purpose is to mean "somebody did not fill this in".
--
--   So this file adds a TYPE to the job and to the purchase order, and
--   moves the type-specific payload off the parent row into side tables.
--
-- THE SHAPE, AND WHY IT IS THIS SHAPE
--   The discriminator lives on the PARENT (`job.job_type`,
--   `purchase_order.po_type`). That is what keeps it filterable and
--   indexable in one predicate, which is the headline requirement; it is
--   also why no `is_linguistic` flag is needed anywhere -- the type is
--   the flag.
--
--   The payload lives in SIDE TABLES keyed on the parent's id:
--
--     job_detail_linguistic      (job_id PK) -> job_slang, job_elang
--     job_detail_non_linguistic  (job_id PK) -> job_category
--     po_detail_linguistic       (po_id  PK) -> po_slang,  po_elang
--     po_detail_non_linguistic   (po_id  PK) -> po_category
--
--   The foreign key points CHILD -> PARENT, and the child's primary key
--   IS that foreign key. The other direction (a `job_detail_ling_id`
--   column on `job`) was considered and rejected: such a column has no
--   unique constraint, so two jobs could point at one detail row and
--   editing one job's languages would silently change another's. A
--   transaction does not fix that. A key does.
--
--   Side tables rather than four more columns on `job`, because we do not
--   yet know what else non-linguistic work will need, and because the
--   application now writes the parent and its detail row inside one
--   transaction (`pgTransaction` in lambdas/.../utils/PostgresUtils.ts),
--   so a failed create cannot leave a parent row with no detail.
--
-- WHAT THIS FILE DOES *NOT* DO
--   It does not require anything. A linguistics job needs NO detail row
--   at all -- jobs with both languages blank exist by the thousand, which
--   is exactly why the report carries '?' sentinels and why the console
--   renders the language pickers with a 선택 없음 placeholder and no
--   `required`. Every constraint below FORBIDS a wrong combination and
--   none of them REQUIRES a row to be there. A fourth 업무 구분 added
--   from the 유지보수 screen tomorrow gets no detail table, no detail
--   row, and still saves.
--
-- IT MUST BE APPLIED WHOLE, AND IN ORDER
--   Section 5 reads `job.job_slang` and section 6 drops it. Stopping in
--   between leaves the languages in the old columns with the new tables
--   empty; the application reads the new tables, so the languages would
--   appear to have vanished. Every statement is written to be re-runnable
--   (IF NOT EXISTS / IF EXISTS / ON CONFLICT DO NOTHING / a backfill that
--   is a no-op the second time), so if it does stop, run it again.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/011_job_types.sql
--
--   As with 002..010: no `\` meta-command, no `:placeholder`, no BEGIN
--   and no COMMIT, so the whole file can be pasted into the Supabase SQL
--   editor as-is.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1a. two new domain rows
-- ---------------------------------------------------------------------
-- `code_parent` NULL means the row IS a domain -- see 007_codes.sql. The
-- five it seeds hold ord_no 1..5, so these take 6 and 7.
--
-- The application reads these two by their literal codes
-- (NeotmsCodeDomain in NeotmsCode.dbops.ts, CODE_DOMAIN in
-- frontend/src/apis/neotms.codes.ts). Renaming either breaks the
-- dropdown that reads it.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('JOBTYPE', '업무 구분', 'Service line',     NULL, 6, true),
  ('JOBCAT',  '업무 분류', 'Service category', NULL, 7, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 1b. 업무 구분 -- the three service lines
-- ---------------------------------------------------------------------
-- These `code` values are ASCII while most child codes in 007 are
-- Korean, and that is not a deviation. The rule the asymmetry actually
-- follows is "the code is whatever the thing is called": 작업 종류 and
-- 분야 are Korean because legacy LKTMS already stores Korean strings in
-- those columns, while 사용 프로그램 is already ASCII in 007 (Trados,
-- memoQ, XTM, Phrase, DTP) because that is what those tools are called.
-- MICE and IMC are likewise ASCII in the business, and LINGUISTICS is
-- new data with no legacy value to match.
--
-- `code` is UNIQUE across the WHOLE table, not per domain -- a foreign
-- key needs a unique constraint on what it references, and making it
-- (code_parent, code) would mean mirroring code_parent into all
-- twenty-two referencing columns. None of these seven codes is in use,
-- so unlike 007's '기타 언어' none of them needs qualifying.
--
-- `code_name` is what the console shows. `codesToOptions` on the
-- frontend appends the code when the name differs from it, so the
-- dropdown reads '언어 및 통번역 (LINGUISTICS)'; MICE and IMC have
-- `code_name` equal to `code` and so render bare.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('LINGUISTICS', '언어 및 통번역', 'Linguistics', 'JOBTYPE', 1, true),
  ('MICE',        'MICE',           'MICE',        'JOBTYPE', 2, true),
  ('IMC',         'IMC',            'IMC',         'JOBTYPE', 3, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 1c. 업무 분류 -- the four non-linguistic categories
-- ---------------------------------------------------------------------
-- ONE shared list, deliberately: any of the four is valid on a MICE job
-- and on an IMC job alike. There is no type-to-category allow-list
-- anywhere in the schema or in the application, because the business
-- does not have one -- an IMC engagement can be a 행사운영 and a MICE
-- engagement can be 온라인홍보.
--
-- A linguistics job has no category at all. That is an absence, not a
-- fifth category, so nothing is seeded for it.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('online_marketing',          '온라인홍보',     'Online marketing',           'JOBCAT', 1, true),
  ('offline_marketing',         '오프라인홍보',   'Offline marketing',          'JOBCAT', 2, true),
  ('online_offline_marketing',  '온오프라인홍보', 'Online and offline marketing','JOBCAT', 3, true),
  ('event_ceremony_management', '행사운영',       'Event and ceremony management','JOBCAT', 4, true)
ON CONFLICT (code) DO NOTHING;

COMMENT ON COLUMN sys_code.code_parent IS
  'Parent code = the code domain this entry belongs to. NULL for a top-level domain row. '
  'db/007_codes.sql seeds five domain rows -- FIELD, WORK, UNIT, LANG, UPRO -- and '
  'db/011_job_types.sql adds two more -- JOBTYPE, JOBCAT. The application reads all seven by '
  'those literal codes (NeotmsCodeDomain in NeotmsCode.dbops.ts). Renaming one of them breaks '
  'every dropdown that reads it; adding an eighth is free, but nothing will query it until a '
  'NeotmsCodeDomain entry exists too.';


-- =====================================================================
-- 2. the discriminator, on the parent rows
-- =====================================================================
-- NOT NULL with a constant DEFAULT is rewrite-free on PostgreSQL 11 and
-- up (the default is recorded in pg_attribute.attmissingval and handed
-- out on read), so this does not rewrite the table or hold a long
-- exclusive lock.
--
-- THE DEFAULT STAYS FOREVER. The usual playbook drops it once the
-- backfill is done; here the external LKTMS ETL does not know this
-- column exists, so dropping the default would break the next load with
-- a NOT NULL violation on a column the ETL has never heard of. And the
-- default is the correct answer for anything the ETL inserts: all
-- historical work in this company was linguistics.
--
-- The foreign key onto sys_code (code) matches the twenty-two code
-- columns 007 describes, and means a typo'd type is refused on the way
-- in rather than stored and discovered by a report.
ALTER TABLE job            ADD COLUMN IF NOT EXISTS job_type text NOT NULL DEFAULT 'LINGUISTICS';
ALTER TABLE purchase_order ADD COLUMN IF NOT EXISTS po_type  text NOT NULL DEFAULT 'LINGUISTICS';

ALTER TABLE job DROP CONSTRAINT IF EXISTS job_job_type_fkey;
ALTER TABLE job
  ADD CONSTRAINT job_job_type_fkey FOREIGN KEY (job_type)
  REFERENCES sys_code (code) ON DELETE RESTRICT NOT VALID;
ALTER TABLE job VALIDATE CONSTRAINT job_job_type_fkey;

ALTER TABLE purchase_order DROP CONSTRAINT IF EXISTS purchase_order_po_type_fkey;
ALTER TABLE purchase_order
  ADD CONSTRAINT purchase_order_po_type_fkey FOREIGN KEY (po_type)
  REFERENCES sys_code (code) ON DELETE RESTRICT NOT VALID;
ALTER TABLE purchase_order VALIDATE CONSTRAINT purchase_order_po_type_fkey;

COMMENT ON COLUMN job.job_type IS
  '업무 구분. A sys_code child of the JOBTYPE domain -- LINGUISTICS, MICE or IMC. New in NEOTMS; '
  'legacy PRJTB_JOB had no such column, which is why the DEFAULT is LINGUISTICS and why it is kept '
  'permanently (the ETL does not know this column). Decides which detail table carries this job''s '
  'type-specific payload -- see db/011_job_types.sql.';

COMMENT ON COLUMN purchase_order.po_type IS
  '업무 구분 of this purchase order, INDEPENDENT of its job''s. It defaults from the job when the '
  'PO is created and is editable afterwards, because a MICE conference legitimately carries a '
  'LINGUISTICS interpretation PO. Do not confuse with po_lang (the printed PO''s letterhead '
  'language) or with the po_cat_* columns (CAT-tool analysis).';


-- =====================================================================
-- 3. the four detail tables
-- =====================================================================
-- No audit columns. `created_at`, `created_by`, `created_ip` and
-- `deleted` are on the parent and the detail row's lifetime, authorship
-- and deleted-ness ARE the parent's by definition; a second copy would
-- be a second answer to the same question, free to disagree.
--
-- ON DELETE CASCADE, not the RESTRICT this schema uses everywhere else.
-- The rest of the schema restricts because the child has independent
-- meaning (a PO is a record of what was agreed with a translator). A
-- detail row has none -- it is part of the parent row, split out only so
-- the two types can carry different fields. The application soft-deletes
-- the parent, so the cascade fires only on a genuine hard delete.
--
-- `job_type` is repeated in each detail table on purpose. Section 4 uses
-- it to pin the discriminator; see the comment there.
CREATE TABLE IF NOT EXISTS job_detail_linguistic (
  job_id    bigint PRIMARY KEY REFERENCES job (id) ON DELETE CASCADE,
  job_type  text NOT NULL DEFAULT 'LINGUISTICS',
  job_slang text REFERENCES sys_code (code) ON DELETE RESTRICT,
  job_elang text REFERENCES sys_code (code) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS job_detail_non_linguistic (
  job_id       bigint PRIMARY KEY REFERENCES job (id) ON DELETE CASCADE,
  job_type     text NOT NULL,
  job_category text REFERENCES sys_code (code) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS po_detail_linguistic (
  po_id    bigint PRIMARY KEY REFERENCES purchase_order (id) ON DELETE CASCADE,
  po_type  text NOT NULL DEFAULT 'LINGUISTICS',
  po_slang text REFERENCES sys_code (code) ON DELETE RESTRICT,
  po_elang text REFERENCES sys_code (code) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS po_detail_non_linguistic (
  po_id       bigint PRIMARY KEY REFERENCES purchase_order (id) ON DELETE CASCADE,
  po_type     text NOT NULL,
  po_category text REFERENCES sys_code (code) ON DELETE RESTRICT
);

COMMENT ON TABLE job_detail_linguistic IS
  'The language pair of a LINGUISTICS job. One row per job at most, and ABSENT when the job has '
  'neither language set -- thousands of legacy jobs are in exactly that state, so a missing row '
  'here means "not filled in" and is not an error. Formerly job.job_slang / job.job_elang.';

COMMENT ON TABLE job_detail_non_linguistic IS
  'The 업무 분류 of a MICE or IMC job. One row per job at most, and absent when no category has '
  'been chosen. There is no legacy equivalent -- all work before NEOTMS was linguistics.';

COMMENT ON TABLE po_detail_linguistic IS
  'The language pair of a LINGUISTICS purchase order. Formerly purchase_order.po_slang / po_elang. '
  'See job_detail_linguistic -- same rules.';

COMMENT ON TABLE po_detail_non_linguistic IS
  'The 업무 분류 of a MICE or IMC purchase order. See job_detail_non_linguistic.';

COMMENT ON COLUMN job_detail_linguistic.job_type IS
  'A copy of job.job_type, held here only so the composite foreign key in db/011_job_types.sql can '
  'pin it. It cannot drift: the FK onto job (id, job_type) and the CHECK that it equals '
  '''LINGUISTICS'' make any other value unstorable. Read job.job_type, not this.';

COMMENT ON COLUMN job_detail_non_linguistic.job_type IS
  'A copy of job.job_type -- see job_detail_linguistic.job_type. CHECKed to be anything OTHER than '
  '''LINGUISTICS'', so a fourth 업무 구분 added later can use this table without a schema change.';


-- =====================================================================
-- 4. pinning the discriminator
-- =====================================================================
-- This is the one part of the design that is not obvious, so: what it
-- buys is that A MICE JOB CANNOT HAVE A LANGUAGE DETAIL ROW, as a key
-- constraint rather than as a convention somebody has to remember.
--
-- Without it, the stale-row case is silent AND asymmetric. Change a job
-- from LINGUISTICS to MICE without clearing the old side and the job
-- list shows a language pair while the report counts that job under
-- (비언어) -- two screens disagreeing, neither of them looking wrong.
-- With it, forgetting to clear the old side is an error instead.
--
-- How it works: `job` gets a UNIQUE (id, job_type), which lets a detail
-- table reference the PAIR. The detail table's own `job_type` is then
-- CHECKed against the one constant it is allowed to hold. Together those
-- two say "this row may only hang off a job whose type is LINGUISTICS".
--
-- Two consequences the application has to honour, both documented in
-- NeotmsJobManager.ts:
--
--   - Changing job.job_type while a mismatched detail row still exists
--     FAILS (SQLSTATE 23503). So the update path deletes the stale detail
--     row BEFORE updating the job. That deletion is required for
--     correctness either way; this constraint only makes skipping it
--     impossible rather than invisible.
--   - ON DELETE CASCADE on the composite FK as well as on the simple
--     one, or a hard delete of a job would be blocked by the constraint
--     that was supposed to be about types.
--
-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, hence DROP IF EXISTS
-- then ADD NOT VALID then VALIDATE. VALIDATE is a no-op on an already
-- valid constraint, which is what makes this block re-runnable.
--
-- EVERY DROP COMES FIRST, and that order is load-bearing on a re-run.
-- The four composite foreign keys depend on the two UNIQUE constraints,
-- so dropping a UNIQUE while its referencing FK still exists fails with
-- "cannot drop constraint ... because other objects depend on it" -- and
-- it fails on the SECOND run of this file, not the first, which is the
-- worst time to find out.
ALTER TABLE job_detail_linguistic     DROP CONSTRAINT IF EXISTS jdl_job_type_fkey;
ALTER TABLE job_detail_linguistic     DROP CONSTRAINT IF EXISTS jdl_is_linguistic;
ALTER TABLE job_detail_non_linguistic DROP CONSTRAINT IF EXISTS jdn_job_type_fkey;
ALTER TABLE job_detail_non_linguistic DROP CONSTRAINT IF EXISTS jdn_is_not_linguistic;
ALTER TABLE po_detail_linguistic      DROP CONSTRAINT IF EXISTS pdl_po_type_fkey;
ALTER TABLE po_detail_linguistic      DROP CONSTRAINT IF EXISTS pdl_is_linguistic;
ALTER TABLE po_detail_non_linguistic  DROP CONSTRAINT IF EXISTS pdn_po_type_fkey;
ALTER TABLE po_detail_non_linguistic  DROP CONSTRAINT IF EXISTS pdn_is_not_linguistic;

ALTER TABLE job DROP CONSTRAINT IF EXISTS job_id_type_key;
ALTER TABLE job ADD CONSTRAINT job_id_type_key UNIQUE (id, job_type);

ALTER TABLE purchase_order DROP CONSTRAINT IF EXISTS po_id_type_key;
ALTER TABLE purchase_order ADD CONSTRAINT po_id_type_key UNIQUE (id, po_type);

ALTER TABLE job_detail_linguistic
  ADD CONSTRAINT jdl_job_type_fkey FOREIGN KEY (job_id, job_type)
  REFERENCES job (id, job_type) ON DELETE CASCADE NOT VALID;
ALTER TABLE job_detail_linguistic VALIDATE CONSTRAINT jdl_job_type_fkey;

ALTER TABLE job_detail_linguistic
  ADD CONSTRAINT jdl_is_linguistic CHECK (job_type = 'LINGUISTICS') NOT VALID;
ALTER TABLE job_detail_linguistic VALIDATE CONSTRAINT jdl_is_linguistic;

ALTER TABLE job_detail_non_linguistic
  ADD CONSTRAINT jdn_job_type_fkey FOREIGN KEY (job_id, job_type)
  REFERENCES job (id, job_type) ON DELETE CASCADE NOT VALID;
ALTER TABLE job_detail_non_linguistic VALIDATE CONSTRAINT jdn_job_type_fkey;

ALTER TABLE job_detail_non_linguistic
  ADD CONSTRAINT jdn_is_not_linguistic CHECK (job_type <> 'LINGUISTICS') NOT VALID;
ALTER TABLE job_detail_non_linguistic VALIDATE CONSTRAINT jdn_is_not_linguistic;

ALTER TABLE po_detail_linguistic
  ADD CONSTRAINT pdl_po_type_fkey FOREIGN KEY (po_id, po_type)
  REFERENCES purchase_order (id, po_type) ON DELETE CASCADE NOT VALID;
ALTER TABLE po_detail_linguistic VALIDATE CONSTRAINT pdl_po_type_fkey;

ALTER TABLE po_detail_linguistic
  ADD CONSTRAINT pdl_is_linguistic CHECK (po_type = 'LINGUISTICS') NOT VALID;
ALTER TABLE po_detail_linguistic VALIDATE CONSTRAINT pdl_is_linguistic;

ALTER TABLE po_detail_non_linguistic
  ADD CONSTRAINT pdn_po_type_fkey FOREIGN KEY (po_id, po_type)
  REFERENCES purchase_order (id, po_type) ON DELETE CASCADE NOT VALID;
ALTER TABLE po_detail_non_linguistic VALIDATE CONSTRAINT pdn_po_type_fkey;

ALTER TABLE po_detail_non_linguistic
  ADD CONSTRAINT pdn_is_not_linguistic CHECK (po_type <> 'LINGUISTICS') NOT VALID;
ALTER TABLE po_detail_non_linguistic VALIDATE CONSTRAINT pdn_is_not_linguistic;


-- =====================================================================
-- 5. move the existing languages into the detail tables
-- =====================================================================
-- Only rows that actually HAVE a language get a detail row. A job with
-- both blank gets none and reads exactly as it did before -- '? > ?' on
-- the report, '-' on the job list. Inserting an empty row for every job
-- would turn "nobody filled this in" into "somebody filled in nothing",
-- which are different facts, and would require the application to tell
-- them apart for no gain.
--
-- NULLIF(..., '') normalises legacy empty strings to NULL on the way in,
-- so from here on the application has exactly one kind of unset to
-- handle rather than two. (The old columns permitted both, which is why
-- the report's sentinel logic needs NULLIF on each half.)
--
-- ON CONFLICT DO NOTHING, so a second run is a no-op rather than a
-- 23505 -- and so a run that already moved some rows can be repeated.
-- DO NOTHING and not DO UPDATE: if a detail row already exists it is
-- newer than these columns, and overwriting it with pre-migration values
-- is the one thing a re-runnable migration must never do.
--
-- ## Why these two statements are wrapped in DO blocks
--
-- ON CONFLICT alone does NOT make this section re-runnable, and believing
-- it did was a defect caught by the docker rehearsal in README.md rather
-- than by any test. Section 6 drops job_slang; a second run of this file
-- therefore reaches a statement that names a column which no longer
-- exists, and PostgreSQL rejects it at PARSE time with 42703 -- before
-- ON CONFLICT, before the WHERE clause, before anything that could
-- notice there was nothing left to move. The whole file then stops, which
-- for a file whose purpose is to be safe to repeat is the worst outcome
-- available.
--
-- Dynamic SQL is the fix: inside EXECUTE the statement is a string until
-- the IF has already established that the column is there. The guard
-- reads information_schema rather than a sentinel of its own, so it is
-- true of the database rather than of a record this file keeps about it.
--
-- The ELSE branch raises a NOTICE instead of staying silent: "already
-- migrated" and "migrated nothing because the WHERE matched no rows"
-- are different facts, and whoever re-runs this deserves to be told
-- which one they are looking at.
DO $backfill_job$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'job'
       AND column_name  = 'job_slang'
  ) THEN
    EXECUTE $move_job$
      INSERT INTO job_detail_linguistic (job_id, job_type, job_slang, job_elang)
      SELECT id, 'LINGUISTICS', NULLIF(job_slang, ''), NULLIF(job_elang, '')
        FROM job
       WHERE job_type = 'LINGUISTICS'
         AND (COALESCE(job_slang, '') <> '' OR COALESCE(job_elang, '') <> '')
      ON CONFLICT (job_id) DO NOTHING
    $move_job$;
  ELSE
    RAISE NOTICE
      'job.job_slang is already gone, so the language pairs were moved by an earlier run';
  END IF;
END
$backfill_job$;

DO $backfill_po$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'purchase_order'
       AND column_name  = 'po_slang'
  ) THEN
    EXECUTE $move_po$
      INSERT INTO po_detail_linguistic (po_id, po_type, po_slang, po_elang)
      SELECT id, 'LINGUISTICS', NULLIF(po_slang, ''), NULLIF(po_elang, '')
        FROM purchase_order
       WHERE po_type = 'LINGUISTICS'
         AND (COALESCE(po_slang, '') <> '' OR COALESCE(po_elang, '') <> '')
      ON CONFLICT (po_id) DO NOTHING
    $move_po$;
  ELSE
    RAISE NOTICE
      'purchase_order.po_slang is already gone, so the language pairs were moved by an earlier run';
  END IF;
END
$backfill_po$;

-- No non-linguistic backfill. There is no historical MICE or IMC work in
-- this database -- that is the whole reason this file exists.


-- =====================================================================
-- 6. drop the old columns
-- =====================================================================
-- After section 5, and only after it. The application reads the detail
-- tables from here on, so leaving these in place would give the schema
-- two homes for the same fact with no constraint keeping them equal.
--
-- Nothing in this repository breaks. A search for job_slang / po_slang
-- across the whole tree finds only 002_tables.sql, 007_codes.sql, the
-- two dbops modules, NeotmsReport.dbops.ts and the tests -- all of which
-- change in the same commit as this file. THE EXTERNAL LKTMS ETL IS A
-- DIFFERENT MATTER: it writes these columns today and must be changed to
-- write the detail tables instead, or its next load will fail with
-- 42703. See README.md.
--
-- NOT TOUCHED, and easy to touch by accident:
--
--   purchase_order.po_lang    -- the printed PO's letterhead language
--                                (Korean or English). A different fact
--                                with a confusingly similar name.
--   purchase_order.po_cat_*   -- four CAT-TOOL ANALYSIS columns. 'cat'
--                                there is Computer-Assisted Translation,
--                                not 'category'.
ALTER TABLE job            DROP COLUMN IF EXISTS job_slang;
ALTER TABLE job            DROP COLUMN IF EXISTS job_elang;
ALTER TABLE purchase_order DROP COLUMN IF EXISTS po_slang;
ALTER TABLE purchase_order DROP COLUMN IF EXISTS po_elang;


-- =====================================================================
-- 7. indexes
-- =====================================================================
-- These belong here rather than in 003_indexes.sql because that file is
-- NOT idempotent -- seventy-one CREATE INDEX statements, not one of them
-- IF NOT EXISTS -- so appending to it would mean nobody could ever
-- re-run it. IF NOT EXISTS on everything below, same as the rest of this
-- file.
--
-- WHERE NOT deleted on the two parent indexes, matching the partial
-- indexes 003 builds on job and purchase_order: every list query in the
-- application carries `deleted = false`, so indexing the soft-deleted
-- rows only makes the index bigger.
--
-- The detail indexes are NOT partial. A detail table has no `deleted`
-- column (section 3), and the join that reaches it is already restricted
-- by the parent's predicate.
CREATE INDEX IF NOT EXISTS ix_job_type ON job (job_type) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS ix_po_type  ON purchase_order (po_type) WHERE NOT deleted;

CREATE INDEX IF NOT EXISTS ix_jdl_slang    ON job_detail_linguistic (job_slang);
CREATE INDEX IF NOT EXISTS ix_jdl_elang    ON job_detail_linguistic (job_elang);
CREATE INDEX IF NOT EXISTS ix_jdn_category ON job_detail_non_linguistic (job_category);
CREATE INDEX IF NOT EXISTS ix_pdl_slang    ON po_detail_linguistic (po_slang);
CREATE INDEX IF NOT EXISTS ix_pdl_elang    ON po_detail_linguistic (po_elang);
CREATE INDEX IF NOT EXISTS ix_pdn_category ON po_detail_non_linguistic (po_category);


-- =====================================================================
-- 8. Verification
-- =====================================================================
-- The seven codes, as the console will read them. Expected: one JOBTYPE
-- domain row with three children, one JOBCAT domain row with four.
SELECT code_parent, code, code_name, ord_no, active
  FROM sys_code
 WHERE code IN ('JOBTYPE', 'JOBCAT')
    OR code_parent IN ('JOBTYPE', 'JOBCAT')
 ORDER BY code_parent NULLS FIRST, ord_no;

-- Where the work sits now. On a database migrated from LKTMS every row
-- here is LINGUISTICS; a MICE or IMC count above zero means somebody has
-- already used the new screens.
SELECT job_type, count(*) AS jobs
  FROM job
 WHERE NOT deleted
 GROUP BY job_type
 ORDER BY jobs DESC;

SELECT po_type, count(*) AS purchase_orders
  FROM purchase_order
 WHERE NOT deleted
 GROUP BY po_type
 ORDER BY purchase_orders DESC;

-- How many rows section 5 moved. These counts should equal the number of
-- jobs and POs that had at least one language before the migration. They
-- will be SMALLER than the total job count, and that is correct -- see
-- the comment on section 5.
SELECT 'job_detail_linguistic'     AS detail_table, count(*) AS row_count FROM job_detail_linguistic
UNION ALL
SELECT 'job_detail_non_linguistic' AS detail_table, count(*) AS row_count FROM job_detail_non_linguistic
UNION ALL
SELECT 'po_detail_linguistic'      AS detail_table, count(*) AS row_count FROM po_detail_linguistic
UNION ALL
SELECT 'po_detail_non_linguistic'  AS detail_table, count(*) AS row_count FROM po_detail_non_linguistic
ORDER BY detail_table;

-- The check that matters: no job carries BOTH kinds of detail row. The
-- composite foreign keys in section 4 make this unreachable, so this
-- query returning anything at all means a constraint is missing -- which
-- is worth knowing, because the symptom otherwise is two screens quietly
-- disagreeing about the same job. Expected: zero rows.
SELECT l.job_id
  FROM job_detail_linguistic l
  JOIN job_detail_non_linguistic n ON n.job_id = l.job_id;

SELECT l.po_id
  FROM po_detail_linguistic l
  JOIN po_detail_non_linguistic n ON n.po_id = l.po_id;

-- And that the old columns really are gone. Expected: zero rows. A row
-- here means section 6 did not run, the application is reading the
-- detail tables, and the languages in these columns are invisible.
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND column_name IN ('job_slang', 'job_elang', 'po_slang', 'po_elang')
   AND table_name IN ('job', 'purchase_order')
 ORDER BY table_name, column_name;

-- The converse, as information: po_lang and the po_cat_* columns must
-- STILL be there. Expected: five rows (po_lang plus four po_cat_*).
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name = 'purchase_order'
   AND (column_name = 'po_lang' OR column_name LIKE 'po_cat_%')
 ORDER BY column_name;
