-- =====================================================================
-- NEOTMS :: 016_project_fields.sql
-- Run after 007_codes.sql. Idempotent -- re-run it as often as you like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   `project.prj_field` (분야) and `project.prj_field2` (세부 분야) are two
--   columns that mean two different things, and until now both dropdowns
--   were filled from ONE list -- the FIELD domain in `sys_code`. So the
--   two boxes offered the same eighteen options, and the second one could
--   only ever repeat or contradict the first. The 세부 분야 box had a hint
--   under it that said as much, in so many words: "분야가 둘에 걸칠 때만
--   채웁니다. 같은 분야 목록에서 고릅니다."
--
--   In the legacy app these were separate lists, and the eighteen values
--   currently seeded under FIELD are the DETAILED ones -- legacy
--   PRJ_FIELD2. IT·소프트웨어, 의학·제약, 특허·지식재산 are specific
--   subject areas, not top-level groupings. Which means the list that was
--   missing is the coarse one, and `prj_field` -- the column the margin
--   report's 분야별 dimension groups on -- has been holding detailed
--   values all along.
--
--   That matters beyond tidiness. The report breaks revenue down by
--   `prj_field`, so a company with eighteen fine-grained fields gets
--   eighteen thin bars and no answer to "which part of the business is
--   this". The coarse list is the one that dimension wants.
--
-- WHAT IT DOES
--   1. Adds a PRJCAT domain to `sys_code` with a starter set of seven
--      coarse fields, and leaves FIELD exactly as it is.
--   2. Moves each project's existing `prj_field` value into `prj_field2`,
--      where it belonged, and derives the new coarse `prj_field` from it.
--   3. Points the 분야 dropdown at PRJCAT and the 세부 분야 dropdown at
--      FIELD (that part is application code, not SQL -- see
--      frontend/src/apis/neotms.codes.ts).
--
-- WHY NOT TWO NEW TABLES
--   The request this implements asked for two new tables, `prj_category`
--   and `prj_subcategory`, with `prj_field` and `prj_field2` referencing
--   them. Two `sys_code` domains deliver the same outcome, and the reason
--   to prefer them is not brevity -- it is that `sys_code` is not merely
--   where code lists are stored, it is the thing an entire subsystem is
--   built around:
--
--     * `GET /api/v0/codes` returns every domain in one response, which is
--       why a form with four dropdowns makes one request and not four
--       (NeotmsCode.dbops.ts, `CodeAllOps`).
--     * The 유지보수 screen builds its tabs from `code_parent IS NULL`
--       rows, so a new domain becomes an editable tab the day it is
--       seeded, with no new screen and no new CRUD path
--       (MaintenanceView.tsx). A separate table would have had none of
--       that, and the promise in 007's header -- "every row below is
--       editable from the 유지보수 screen, and editing it is expected" --
--       would not hold for the two lists that most need editing, since
--       the taxonomy of a translation company's subject fields IS the
--       business decision here.
--     * `CodeSelect` takes a domain and needs no new component.
--
--   There is one thing dedicated tables would buy that this does not:
--   `prj_field text REFERENCES prj_category (code)` would make it
--   IMPOSSIBLE to store a 세부 분야 code in the 분야 column, whereas an FK
--   to `sys_code (code)` only guarantees "some registered code". That
--   weakness is real, it is shared by all twenty-two code columns in this
--   schema, and 002_tables.sql took it knowingly -- the FKs point at
--   `code` rather than at a composite key precisely so the legacy string
--   survives the ETL untouched. Pinning one column and not the other
--   twenty-one would be the inconsistency, not the fix. If hard
--   enforcement is wanted later it is its own migration, and the pattern
--   to copy is already in this repository: a UNIQUE (code, code_parent) on
--   `sys_code` plus a composite FK, the same trick db/011_job_types.sql
--   uses to pin a detail row to one `job_type`.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/016_project_fields.sql
--
--   As with every file here: no `\` meta-command, no colon placeholder, no
--   BEGIN and no COMMIT, so it can be pasted into the Supabase SQL editor
--   whole. Apply it whole and in order -- section 3 reads `prj_field` and
--   rewrites it, so running section 3 twice must be harmless, and it is
--   (the backfill is keyed on values that only exist before it runs).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. the PRJCAT domain row
-- ---------------------------------------------------------------------
-- `ord_no` 8. Existing domains occupy 1-5 (FIELD, WORK, UNIT, LANG, UPRO
-- from 007) and 6-7 (JOBTYPE, JOBCAT from 011), so this is the next free
-- slot and the 유지보수 tabs stay in the order they were added.
--
-- `code_name` is what the 유지보수 screen titles the tab with -- the
-- frontend's CODE_DOMAIN_LABELS is only a fallback for when this column is
-- empty (MaintenanceView.tsx). '프로젝트 분야' rather than '분야' because
-- FIELD is still called 분야 and still is one: a customer's 분야 and a
-- translator's 가능 분야 read that list too. Two tabs both titled 분야
-- would leave an administrator guessing which one feeds which screen.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('PRJCAT', '프로젝트 분야', 'Project field', NULL, 8, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2. 프로젝트 분야 -- the coarse list
-- ---------------------------------------------------------------------
-- A STARTER SET, NOT A SPECIFICATION. Same standing as 007's 분야 block
-- and for the same reason: how this company groups its work is a business
-- decision, and nothing in the legacy schema records it (LKTMS's
-- PRJ_FIELD was nvarchar(20) free text, and SY_CODE has not been
-- profiled). These seven are a grouping OF THE EIGHTEEN already seeded
-- under FIELD, chosen so that section 3's backfill has somewhere to put
-- every existing value. An administrator is expected to open 유지보수 and
-- rewrite them.
--
-- The codes do not collide with any existing row, which is a requirement
-- and not a coincidence: `sys_code.code` is UNIQUE across the WHOLE table,
-- not per domain (see 007's header). So '의학·생명' and not '의학·제약',
-- which FIELD already holds; '일반' and not '일반·기타', likewise. Picking
-- a name a different domain already uses fails with 23505.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('기술·공학',   '기술·공학',   'Technology / Engineering',  'PRJCAT', 1, true),
  ('의학·생명',   '의학·생명',   'Medical / Life sciences',   'PRJCAT', 2, true),
  ('법률·행정',   '법률·행정',   'Legal / Public affairs',    'PRJCAT', 3, true),
  ('금융·경영',   '금융·경영',   'Finance / Business',        'PRJCAT', 4, true),
  ('문화·미디어', '문화·미디어', 'Culture / Media',           'PRJCAT', 5, true),
  ('학술·교육',   '학술·교육',   'Academic / Education',      'PRJCAT', 6, true),
  ('일반',        '일반',        'General',                   'PRJCAT', 7, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 3. backfill -- the detailed value moves down, the coarse one is derived
-- ---------------------------------------------------------------------
-- Every `prj_field` value in the database right now is a FIELD code, i.e.
-- a DETAILED field, because that was the only list the dropdown offered.
-- Leaving them where they are would mean the 분야 column holds values that
-- are no longer in its list -- the dropdown would render them as
-- '(등록되지 않은 값)' and the report's 분야별 breakdown would keep its
-- eighteen thin bars. So the value moves to the column it describes, and
-- the column it vacates gets the group that value belongs to.
--
-- Two UPDATEs rather than one, in this order, because the second reads
-- what the first wrote.

-- 3a. the detailed value moves into 세부 분야, but only where that column
--     is free. A project with BOTH columns set already has two detailed
--     values (the only thing it could have had), and the second one is
--     the more specific statement of the two -- overwriting it would
--     destroy the only information `prj_field2` ever carried. In that case
--     `prj_field` is simply reclassified in place by 3b.
UPDATE project
   SET prj_field2 = prj_field
 WHERE prj_field IS NOT NULL
   AND prj_field2 IS NULL;

-- 3b. 분야 is derived from 세부 분야 by the grouping section 2 encodes.
--     Rows whose `prj_field` is already a PRJCAT code are left alone,
--     which is what makes a second run of this file a no-op rather than a
--     second reclassification.
--
--     `ELSE '일반'` for anything unrecognised. A legacy or ETL value that
--     is in neither list has to land somewhere, and NULL is the wrong
--     somewhere: the report prints an unset field as '(unassigned)',
--     which reads as a data-entry gap, while '일반' reads as what it is --
--     work nobody has grouped yet. The row is still findable either way,
--     because `prj_field2` kept the original string.
UPDATE project
   SET prj_field = CASE
         WHEN prj_field2 IN ('IT·소프트웨어', '기계·장비', '전자·반도체', '화학·소재',
                             '건설·플랜트', '자동차', '에너지·환경')       THEN '기술·공학'
         WHEN prj_field2 IN ('의학·제약')                                  THEN '의학·생명'
         WHEN prj_field2 IN ('법률·계약', '특허·지식재산', '공공·행정')    THEN '법률·행정'
         WHEN prj_field2 IN ('금융·회계')                                  THEN '금융·경영'
         WHEN prj_field2 IN ('게임·엔터테인먼트', '마케팅·홍보',
                             '문학·출판', '방송·영상')                     THEN '문화·미디어'
         WHEN prj_field2 IN ('학술·논문')                                  THEN '학술·교육'
         ELSE '일반'
       END
 WHERE prj_field IS NOT NULL
   AND prj_field NOT IN (SELECT code FROM sys_code WHERE code_parent = 'PRJCAT');


-- ---------------------------------------------------------------------
-- 4. the column comments, rewritten
-- ---------------------------------------------------------------------
-- 002_tables.sql describes both columns as subject domains drawn from the
-- same place, and says of `prj_field2` only that legacy declared it first.
-- That is now wrong in the way that matters: it does not say which list
-- each column is chosen from, which is the entire point of this file.
COMMENT ON COLUMN project.prj_field IS
  'Legacy PRJ_FIELD. The COARSE subject field, chosen from the PRJCAT domain of sys_code '
  '(db/016_project_fields.sql). This is the column the reports'' 분야별 dimension resolves, by LEFT '
  'JOIN to sys_code.code, and the coarse list exists so that breakdown has usably few buckets. '
  'prj_field2 is deliberately NOT reported on: a job counted under two fields would double the '
  'revenue of any breakdown that summed the bars. A retired code with no sys_code row falls through '
  'to "(unassigned)" rather than dropping the job, so unset and retired are indistinguishable on the '
  'report -- query this column directly to tell them apart. The FK is to sys_code (code) and so does '
  'not by itself forbid a FIELD code here; the domain is enforced by the dropdown. See the header of '
  'db/016_project_fields.sql for why, and for what to do if that is not enough.';
COMMENT ON COLUMN project.prj_field2 IS
  'Legacy PRJ_FIELD2. The DETAILED subject field, chosen from the FIELD domain of sys_code -- the '
  'same eighteen-value list that customer.cus_field and translator.tran_field read, which is why '
  'those values stay under FIELD and only the coarse list was added. Until '
  'db/016_project_fields.sql both columns offered this one list, so a pre-016 database has detailed '
  'values in prj_field; that file moves them here. Legacy declared FIELD2 before FIELD in the table; '
  'the ordering in 002_tables.sql puts the primary first, which is harmless but worth knowing when '
  'diffing against the old DDL.';


-- ---------------------------------------------------------------------
-- 5. verification
-- ---------------------------------------------------------------------
-- Run these after applying the file. In the style of the queries at the
-- foot of 004_rollup.sql: each one has an expected answer, and a surprise
-- here is cheaper to find now than on the 분야별 report.

-- 5a. the two lists, side by side. Expect 7 under PRJCAT and 18 under
--     FIELD, and no value appearing in both (which `code` being globally
--     unique already guarantees, so a row here would mean a failed seed).
SELECT code_parent AS domain, count(*) AS codes
  FROM sys_code
 WHERE code_parent IN ('PRJCAT', 'FIELD')
 GROUP BY code_parent
 ORDER BY code_parent;

-- 5b. how the projects were regrouped. Every row's 분야 must be one of the
--     seven. A NULL 분야 is fine -- it means the project never had one.
SELECT p.prj_field AS coarse, count(*) AS projects
  FROM project p
 WHERE NOT p.deleted
 GROUP BY p.prj_field
 ORDER BY count(*) DESC;

-- 5c. the assertion. Expect ZERO rows: no live project may hold a 분야
--     that is not in the PRJCAT list. A row here means the backfill did
--     not reach it -- most likely because the file was applied in pieces.
SELECT p.id, p.prj_code, p.prj_field, p.prj_field2
  FROM project p
 WHERE NOT p.deleted
   AND p.prj_field IS NOT NULL
   AND p.prj_field NOT IN (SELECT code FROM sys_code WHERE code_parent = 'PRJCAT')
 ORDER BY p.id;
