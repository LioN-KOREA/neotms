-- =====================================================================
-- NEOTMS :: 002_initial_seeding.sql
-- The rows a new database needs before the application will run at all.
-- Run after 001_schemas.sql.
-- =====================================================================
--
-- Four kinds of row, and each one is load-bearing rather than illustrative:
--
--   1. sys_code   -- the code tables. Twenty-two columns across the schema
--                    are `REFERENCES sys_code (code)`, so with this table
--                    empty every INSERT that carries a code fails 23503 and
--                    every dropdown in the application is empty.
--   2. currency   -- `coin_code` is a foreign key on job and purchase_order,
--                    so no amount can be recorded in any currency until the
--                    rows exist.
--   3. sys_menu   -- the permission system is per menu. A menu that is not
--                    here cannot be granted, so its screens are unreachable.
--   4. sys_role   -- one role, NEOTMS_SYSADMIN, granted every menu. It is
--                    what the first administrator is given at first sign-in.
--
-- WHAT IS NOT HERE: a person. There is no `INSERT INTO staff` carrying
-- somebody's email, because a seeded credential-shaped row is the one that
-- gets forgotten and left enabled. The first staff row is minted at first
-- sign-in by `staff_bootstrap_superuser()`, from the identity the account
-- system vouched for. The authority is the credential; 001 only taught the
-- database what to do when one shows up.
--
-- Every INSERT is `ON CONFLICT DO NOTHING`, so running this file twice is
-- harmless and running it against a database that already has some of these
-- rows adds only what is missing.
--
-- =====================================================================


-- =====================================================================
-- 1. sys_code -- the code tables
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. the domain rows
-- ---------------------------------------------------------------------
-- `sys_code` is self-referencing: `code_parent` points at another row's
-- `code`, and the convention this schema documents is that the parent IS
-- the domain. So the domains have to exist as rows of their own, with
-- `code_parent` NULL, before anything can belong to them -- hence two
-- statements rather than one.
--
-- The five domain codes are ASCII while their children are Korean, and
-- that asymmetry is deliberate in both directions:
--
--   * The domain code travels in a URL. `GET /api/v0/codes?parent=FIELD`
--     is typed into a browser address bar during debugging, pasted into a
--     ticket, and compared against a TypeScript constant
--     (NeotmsCodeDomain in NeotmsCodes.dbops.ts). `?parent=%EB%B6%84%EC%95%BC`
--     is all three of those jobs made harder for no gain.
--   * The children's codes are the values that land in `job.work_code` and
--     friends, and they are already Korean in the frontend and in the
--     legacy data. Renaming them to ASCII here would mean the ETL has to
--     remap every code column -- exactly what 002's decision to FK on
--     `code` rather than `id` exists to avoid.
--
-- No `NEOTMS_` prefix, unlike `sys_role.role_code` in 006. There the
-- prefix was defensive: an upsert landing on a legacy role row would have
-- granted every right on every menu to whoever already held it. Here a
-- collision is harmless in the same way it would be wrong to prevent -- if
-- legacy SY_CODE turns out to contain a row coded 'FIELD', DO NOTHING
-- leaves that row alone and section 2's children simply attach to it,
-- which is the correct outcome. The legacy row wins, and nothing is
-- overwritten.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('FIELD', '분야',          'Subject field',   NULL, 1, true),
  ('WORK',  '작업 종류',     'Service type',    NULL, 2, true),
  ('UNIT',  '단가 단위',     'Billing unit',    NULL, 3, true),
  ('LANG',  '언어',          'Language',        NULL, 4, true),
  ('UPRO',  '사용 프로그램', 'CAT tool',        NULL, 5, true)
ON CONFLICT (code) DO NOTHING;

COMMENT ON COLUMN sys_code.code_parent IS
  'Parent code = the code domain this entry belongs to. NULL for a top-level domain row. '
  'db/007_codes.sql seeds five domain rows -- FIELD, WORK, UNIT, LANG, UPRO -- and the application '
  'reads them by those literal codes (NeotmsCodeDomain in NeotmsCodes.dbops.ts). Renaming one of '
  'those five breaks every dropdown that reads it; adding a sixth is free, but nothing will query it '
  'until a NeotmsCodeDomain entry exists too.';


-- ---------------------------------------------------------------------
-- 2a. 분야 -- subject fields
-- ---------------------------------------------------------------------
-- The one group here that is purely a guess. It exists so the 고객사
-- registration screen has a dropdown instead of a free-text box asking
-- the user to remember a code, and the expectation is that an
-- administrator opens 유지보수 on day one and rewrites it to match how
-- this company actually categorises work.
--
-- Note '일반·기타' rather than the obvious '기타'. `sys_code.code` is
-- UNIQUE across the WHOLE table, not per domain -- a consequence of the
-- legacy design that this schema keeps, because the twenty-two foreign
-- keys above reference `sys_code (code)` and a composite key would have to
-- be mirrored into all of them. So '기타' can exist exactly once in this
-- database, 작업 below has the stronger claim on it (the frontend already
-- sends the literal string '기타' as a work type), and the other three
-- domains qualify theirs: '일반·기타', '기타 언어', '기타 프로그램'.
--
-- This is also the one sharp edge of the 유지보수 screen: adding a code
-- that another domain already uses fails with a unique violation rather
-- than being accepted into its own domain. The screen reports that in
-- those terms; see NeotmsCodes.dbops.ts.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('IT·소프트웨어',      'IT·소프트웨어',      'IT / Software',             'FIELD',  1, true),
  ('의학·제약',          '의학·제약',          'Medical / Pharmaceutical',  'FIELD',  2, true),
  ('법률·계약',          '법률·계약',          'Legal / Contracts',         'FIELD',  3, true),
  ('금융·회계',          '금융·회계',          'Finance / Accounting',      'FIELD',  4, true),
  ('기계·장비',          '기계·장비',          'Machinery / Equipment',     'FIELD',  5, true),
  ('전자·반도체',        '전자·반도체',        'Electronics / Semiconductor','FIELD', 6, true),
  ('화학·소재',          '화학·소재',          'Chemicals / Materials',     'FIELD',  7, true),
  ('건설·플랜트',        '건설·플랜트',        'Construction / Plant',      'FIELD',  8, true),
  ('자동차',             '자동차',             'Automotive',                'FIELD',  9, true),
  ('에너지·환경',        '에너지·환경',        'Energy / Environment',      'FIELD', 10, true),
  ('게임·엔터테인먼트',  '게임·엔터테인먼트',  'Game / Entertainment',      'FIELD', 11, true),
  ('마케팅·홍보',        '마케팅·홍보',        'Marketing / PR',            'FIELD', 12, true),
  ('특허·지식재산',      '특허·지식재산',      'Patent / IP',               'FIELD', 13, true),
  ('학술·논문',          '학술·논문',          'Academic / Research',       'FIELD', 14, true),
  ('문학·출판',          '문학·출판',          'Literature / Publishing',   'FIELD', 15, true),
  ('방송·영상',          '방송·영상',          'Broadcast / Audiovisual',   'FIELD', 16, true),
  ('공공·행정',          '공공·행정',          'Public / Government',       'FIELD', 17, true),
  ('일반·기타',          '일반·기타',          'General / Other',           'FIELD', 18, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2b. 작업 -- service types
-- ---------------------------------------------------------------------
-- DO NOT EDIT THE `code` VALUES IN THIS BLOCK WITHOUT EDITING
-- frontend/src/apis/neotms.codes.ts -> WORK_CODES TO MATCH.
--
-- These six strings are already hardcoded in the frontend as the options
-- of the 작업 종류 dropdown, and they are posted to the API verbatim. If
-- the two lists differ by one character, that dropdown offers a value the
-- foreign key rejects -- which is the bug this whole file is fixing,
-- reintroduced one row at a time.
--
-- The English names matter more than they look: purchase_order.po_lang
-- selects which label a generated PO renders, and a 감수 line item on an
-- English PO that says '감수' has not been rendered in English.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('번역', '번역', 'Translation',    'WORK', 1, true),
  ('감수', '감수', 'Review',         'WORK', 2, true),
  ('편집', '편집', 'Editing',        'WORK', 3, true),
  ('DTP',  'DTP',  'DTP',            'WORK', 4, true),
  ('감리', '감리', 'Quality audit',  'WORK', 5, true),
  ('기타', '기타', 'Other',          'WORK', 6, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2c. 단위 -- billing units
-- ---------------------------------------------------------------------
-- DO NOT EDIT THE `code` VALUES IN THIS BLOCK WITHOUT EDITING
-- frontend/src/apis/neotms.codes.ts -> UNIT_CODES TO MATCH. Same reason as
-- 작업 above.
--
-- '매' is the Korean counter for a sheet/page of source text; the frontend
-- labels it '매(장)' while sending '매'. The label is display-only, so
-- only the `code` column has to agree.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('단어', '단어', 'Word',      'UNIT', 1, true),
  ('글자', '글자', 'Character', 'UNIT', 2, true),
  ('매',   '매',   'Page',      'UNIT', 3, true),
  ('시간', '시간', 'Hour',      'UNIT', 4, true),
  ('건',   '건',   'Job',       'UNIT', 5, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2d. 언어 -- languages
-- ---------------------------------------------------------------------
-- Eight columns FK here, and until now every one of them was fed by a
-- free-text <input> in the frontend: 작업 등록 and 발주 등록 asked the
-- user to type a language and then failed the insert whatever they typed,
-- because no value satisfied the foreign key. Those inputs become
-- dropdowns over this list.
--
-- Korean language names rather than ISO 639 codes ('ko', 'en'), for the
-- same reason the 작업 codes are Korean: these columns are populated by
-- the legacy data too, where they hold whatever SY_CODE held, and that was
-- not ISO. `code_eng_name` carries the English label for English POs.
--
-- Chinese is split simplified/traditional because the price differs and
-- because a translator qualified for one is not qualified for the other --
-- collapsing them into '중국어' would make translator_lang unable to
-- express the distinction at all.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('한국어',        '한국어',        'Korean',               'LANG',  1, true),
  ('영어',          '영어',          'English',              'LANG',  2, true),
  ('일본어',        '일본어',        'Japanese',             'LANG',  3, true),
  ('중국어(간체)',  '중국어(간체)',  'Chinese (Simplified)', 'LANG',  4, true),
  ('중국어(번체)',  '중국어(번체)',  'Chinese (Traditional)','LANG',  5, true),
  ('독일어',        '독일어',        'German',               'LANG',  6, true),
  ('프랑스어',      '프랑스어',      'French',               'LANG',  7, true),
  ('스페인어',      '스페인어',      'Spanish',              'LANG',  8, true),
  ('러시아어',      '러시아어',      'Russian',              'LANG',  9, true),
  ('포르투갈어',    '포르투갈어',    'Portuguese',           'LANG', 10, true),
  ('이탈리아어',    '이탈리아어',    'Italian',              'LANG', 11, true),
  ('베트남어',      '베트남어',      'Vietnamese',           'LANG', 12, true),
  ('태국어',        '태국어',        'Thai',                 'LANG', 13, true),
  ('인도네시아어',  '인도네시아어',  'Indonesian',           'LANG', 14, true),
  ('몽골어',        '몽골어',        'Mongolian',            'LANG', 15, true),
  ('아랍어',        '아랍어',        'Arabic',               'LANG', 16, true),
  ('기타 언어',     '기타 언어',     'Other language',       'LANG', 17, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2e. 사용 프로그램 -- CAT tools
-- ---------------------------------------------------------------------
-- 'UPRO' is legacy shorthand, and 002_tables.sql guessed at it wrongly:
-- it documented CUS_UPRO as a grade or tier selecting a default rate band.
-- It is not. It is which translation application the counterparty
-- primarily works in -- Trados, memoQ and so on. Section 3 below corrects
-- the comment on an already-created database; 002_tables.sql is corrected
-- too, for installations created after this.
--
-- The domain is seeded even though `customer.cus_upro` is no longer
-- written by the application. Two columns reference it and only one was
-- dropped from the UI:
--
--   * `translator.tran_upro` is the useful one, and now the only one a
--     screen writes. Which CAT tool a translator owns decides whether they
--     can take a job at all -- a Trados package handed to somebody running
--     OmegaT comes back unopened.
--   * `customer.cus_upro` keeps its column purely as the ETL's landing
--     place for legacy CUS_UPRO. Not every client sends translation work,
--     so asking every new client which CAT tool they use was a question
--     with no answer most of the time, and a required-looking box with no
--     answer is how a registration screen stops being used.
--
-- '사용 안 함' is a real answer for a translator, distinct from NULL: NULL
-- means nobody asked, '사용 안 함' means they were asked and work without
-- a CAT tool, which is a reason not to send them a 100-file package.
INSERT INTO sys_code (code, code_name, code_eng_name, code_parent, ord_no, active)
VALUES
  ('Trados',         'Trados',         'SDL / RWS Trados Studio', 'UPRO',  1, true),
  ('memoQ',          'memoQ',          'memoQ',                   'UPRO',  2, true),
  ('Phrase',         'Phrase',         'Phrase (Memsource)',      'UPRO',  3, true),
  ('XTM',            'XTM',            'XTM Cloud',               'UPRO',  4, true),
  ('Smartcat',       'Smartcat',       'Smartcat',                'UPRO',  5, true),
  ('Wordfast',       'Wordfast',       'Wordfast',                'UPRO',  6, true),
  ('OmegaT',         'OmegaT',         'OmegaT',                  'UPRO',  7, true),
  ('CafeTran',       'CafeTran',       'CafeTran Espresso',       'UPRO',  8, true),
  ('MS Office',      'MS Office',      'Microsoft Office only',   'UPRO',  9, true),
  ('사용 안 함',     '사용 안 함',     'None',                    'UPRO', 10, true),
  ('기타 프로그램',  '기타 프로그램',  'Other tool',              'UPRO', 11, true)
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------------------
-- 3. correct the two UPRO column comments
-- ---------------------------------------------------------------------
-- `COMMENT ON` overwrites and has no append form, so these restate the
-- whole comment. They are repeated here, rather than only fixed in
-- 002_tables.sql, because a database that has already been created never
-- re-reads 002 -- and a wrong comment on a security-adjacent-looking
-- column is worse than no comment: the next person to read it designs
-- against "grade/class selects the rate band" and builds a pricing rule
-- out of a field holding the string 'Trados'.
COMMENT ON COLUMN customer.cus_upro IS
  'Legacy CUS_UPRO. "UPRO" = 사용 프로그램: which translation (CAT) application this customer '
  'primarily works in -- Trados, memoQ and so on. FK to sys_code(code), domain ''UPRO''. '
  'NOT A GRADE OR RATE TIER; an earlier comment here said that and it was wrong. '
  'RETAINED BUT NOT WRITTEN BY THE APPLICATION: the customer registration screen dropped this '
  'field, because most clients of this company do not send translation work and so have no answer. '
  'The column stays as the ETL''s landing place for legacy values. translator.tran_upro is the live '
  'one.';

COMMENT ON COLUMN translator.tran_upro IS
  'Legacy TRAN_UPRO. "UPRO" = 사용 프로그램: which translation (CAT) application this translator '
  'works in. FK to sys_code(code), domain ''UPRO''. Load-bearing for dispatch rather than for '
  'pricing -- a Trados package sent to a translator who does not run Trados comes back unopened. '
  'NULL means never asked; the code ''사용 안 함'' means asked, and works without one.';


-- ---------------------------------------------------------------------
-- 4. verify
-- ---------------------------------------------------------------------
-- Expected: FIELD 18, LANG 17, UPRO 11, WORK 6, UNIT 5, and 5 domain rows.
-- A domain showing 0 children means section 1 did not run before section
-- 2 -- apply the whole file in order.

-- ---------------------------------------------------------------------
-- 1b. 업무 구분 and 업무 분류
-- ---------------------------------------------------------------------


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

-- ---------------------------------------------------------------------
-- 1c. 프로젝트 분야 -- the coarse project field list
-- ---------------------------------------------------------------------


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


-- =====================================================================
-- 2. currency
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. the seven currencies the console can send, plus retired CNY
-- ---------------------------------------------------------------------
-- `coin_code` is the natural key every FK points at, NOT `id`, so these
-- strings are the load-bearing part of the row. ISO-4217 three-letter
-- codes, which is what `COIN_CODES` offers and what the legacy COIN_CODE
-- column held for the original five.
--
-- The column is varchar(20) with no length CHECK, deliberately (see the
-- comment on currency.coin_code in 002_tables.sql): legacy COINTB_MAIN is
-- nvarchar(20) and may contain non-ISO house codes that the ETL has not
-- been able to profile yet. Keeping the width means the ETL can load those
-- without a schema change; it does not mean this file should invent any.
--
-- `coin_name` is the Korean display name, per that column's comment. It is
-- not currently rendered anywhere -- the console shows the code and its
-- own label from `COIN_CODES` -- but it is what a report or an outgoing
-- document would join to, and leaving it NULL makes the row look like ETL
-- wreckage rather than a deliberate seed.
--
-- ON CONFLICT DO NOTHING and not DO UPDATE: if a row for 'USD' already
-- exists, it came from the ETL and carries the company's own wording.
-- Overwriting `coin_name` with the literal below would quietly relabel
-- migrated data to match a guess made here, which is the one thing a
-- re-runnable seed must never do.
INSERT INTO currency (coin_code, coin_name, created_by)
VALUES
  ('KRW', '원',             'seed-010'),
  ('USD', '미국 달러',      'seed-010'),
  ('EUR', '유로',           'seed-010'),
  ('JPY', '일본 엔',        'seed-010'),
  ('CNH', '중국 위안(역외)', 'seed-010'),
  ('GBP', '영국 파운드',    'seed-010'),
  ('HKD', '홍콩 달러',      'seed-010'),
  -- Retired, and seeded anyway -- see the header. Not offered by the
  -- console and never quoted by the bank, but possibly a parent row.
  ('CNY', '중국 위안',      'seed-010')
ON CONFLICT (coin_code) DO NOTHING;

-- The audit marker, matching 'lpx-bootstrap' in 006 and
-- 'self-registration' in 009. It means "this row was created by a seed
-- file, not by the ETL and not by a person", which is the thing worth
-- being able to query when the ETL later disagrees with it:
--
--   SELECT * FROM currency WHERE created_by = 'seed-010';
COMMENT ON COLUMN currency.created_by IS
  'Who created the row. ''seed-010'' marks a row inserted by '
  'db/010_currency.sql rather than by the ETL or by a user -- these are the '
  'seven currencies the console''s hardcoded COIN_CODES list can submit '
  '(plus retired CNY, kept only as a possible parent row), seeded because '
  'every *_coin / coin_code column is a restricting foreign key onto this '
  'table and all five registration forms default to ''KRW''. '
  'A NULL here on a currency row means the ETL loaded it from legacy '
  'COINTB_MAIN.';


-- =====================================================================
-- 3. sys_menu -- the screens the permission system knows
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. sys_menu -- the six menus this application actually gates on
-- ---------------------------------------------------------------------
-- Legacy SY_MENU has 48 rows. NEOTMS's route table gates on six menu ids
-- (NeotmsMenus.ts), and those six are the ones seeded here, with the
-- labels and the order the sidebar already uses (frontend/src/shared/
-- permissions.ts -> NEOTMS_NAV).
--
-- Seeding these is NOT optional, and not only for permissions: GET
-- /api/v0/me builds its menu list by reading `sys_menu` and looking each
-- row up in the caller's permission map (NeotmsProfileManager ->
-- MenuTreeOps). With `sys_menu` empty, a successfully signed-in
-- superuser gets `menus: []` and the console renders an empty sidebar --
-- a login that works and an application that appears to have no features.
--
-- ON CONFLICT DO NOTHING, not DO UPDATE: once the ETL or an
-- administrator has edited a label, this file must not quietly reset it.
-- The id is the only part that matters to the code.
--
-- menu_depth is 1 and menu_parent is NULL for all six - this is a flat
-- bar, not a tree. The legacy tree structure arrives with the ETL.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('PROJECT',        '프로젝트', NULL, 1, '/projects',        1, true),
  ('JOB',            '작업',     NULL, 1, '/jobs',            2, true),
  ('PURCHASE_ORDER', '발주',     NULL, 1, '/purchase-orders', 3, true),
  ('CUSTOMER',       '고객사',   NULL, 1, '/customers',       4, true),
  ('TRANSLATOR',     '번역가',   NULL, 1, '/translators',     5, true),
  ('REPORT',         '보고서',   NULL, 1, '/reports',         6, true)
ON CONFLICT (menu_id) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2. sys_role -- 시스템관리자, the NEOTMS superuser
-- ---------------------------------------------------------------------
-- `role_code` is `NEOTMS_SYSADMIN` rather than the obvious `SYSADMIN`,
-- and the ugliness is the point. Legacy SY_ROLE.ROLE_ID values have not
-- been profiled yet, and `role_code` is UNIQUE: if the legacy data
-- happens to contain a role called `SYSADMIN`, this file's upsert would
-- land on THAT row and section 3 below would then grant every right on
-- every menu to whichever staff already hold it. A prefixed code cannot
-- collide with a legacy value, so the ETL and this file cannot fight over
-- one row.
--
-- DO UPDATE rather than DO NOTHING here, unlike the menus above. This row
-- belongs to this file: re-running must reassert that the superuser role
-- exists, is named 시스템관리자 and is active, because an operator
-- re-running a bootstrap script is almost always an operator who has just
-- been locked out.

-- ---------------------------------------------------------------------
-- 3b. 유지보수
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. sys_menu -- the two administrative menus
-- ---------------------------------------------------------------------
-- ord_no 7 and 8, continuing 006's 1..6, so these sort to the end of the
-- sidebar. That is deliberate placement, not laziness: the menus a person
-- uses every day should not move because two they touch once a month were
-- added.
--
-- menu_url matches frontend/src/shared/permissions.ts -> NEOTMS_NAV. The
-- application does not navigate by this column -- the router owns the
-- paths and the nav table is static -- but a migrated SY_MENU row carries
-- its legacy `.asp` path here, so leaving it blank on new rows would make
-- the column mean "legacy only" and the next person would have to read
-- two files to find out where /maintenance comes from.
--
-- menu_depth 1, menu_parent NULL: a flat bar, like the other six. The
-- legacy tree arrives with the ETL.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('MAINTENANCE', '유지보수',   NULL, 1, '/maintenance', 7, true),
  ('STAFF',       '사용자 관리', NULL, 1, '/staff',       8, true)
ON CONFLICT (menu_id) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2. Re-grant the superuser role over the new menus
-- ---------------------------------------------------------------------
-- 006 explained why this is a function call and not literal grant rows:
-- `sys_menu` grows, and a superuser whose grants were written once has no
-- rights on anything added afterwards. This file is the first proof of
-- that -- without the line below, the bootstrap superuser can see 유지보수
-- in the sidebar (sys_menu has the row) and gets 403 from every request it
-- makes (the permission list does not).
--
-- Idempotent, and it re-asserts all five action flags on every menu that
-- exists when it runs.

-- ---------------------------------------------------------------------
-- 3c. The two dashboards
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. sys_menu -- the two dashboards
-- ---------------------------------------------------------------------
-- ord_no 9 and 10, continuing 008's 7..8. The sidebar does NOT sort by
-- this column -- frontend/src/shared/permissions.ts -> NEOTMS_NAV owns the
-- order, and it puts 대시보드 first, because a dashboard that is not the
-- first thing a person sees after signing in is a dashboard they will not
-- open. ord_no stays monotonic anyway so that the legacy menu editor, and
-- anyone reading this table directly, sees rows in the order they were
-- added rather than a gap.
--
-- menu_url matches NEOTMS_NAV's paths, as in 008. The application does not
-- navigate by this column; it is here because a migrated SY_MENU row
-- carries its legacy `.asp` path in it, and leaving it blank on new rows
-- would make the column mean "legacy only".
--
-- menu_name has no parentheses. The client's label is 대시보드(영업) and
-- this is not it -- GET /api/v0/me returns these names, but the sidebar
-- renders NEOTMS_NAV's `label` instead (which is why permissions.ts can
-- carry a `hint` the server knows nothing about). What this column is for
-- is the 사용자 관리 screen's permission editor, where the names appear in
-- a list next to five checkboxes. A hyphen reads better there than nested
-- brackets, and the two rows still sort next to each other.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('DASHBOARD_SALES', '대시보드-영업', NULL, 1, '/dashboard/sales',  9, true),
  ('DASHBOARD_PM',    '대시보드-PM',   NULL, 1, '/dashboard/pm',    10, true)
ON CONFLICT (menu_id) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2. Re-grant the superuser role over the new menus
-- ---------------------------------------------------------------------
-- As in 008, and for the reason 006 gives: grants written once do not
-- cover menus added afterwards. Without the line below the bootstrap
-- superuser sees both 대시보드 entries in the sidebar (sys_menu has the
-- rows) and gets 403 from both (the permission list does not).
--
-- This re-grants the superuser ONLY. Deciding which other roles hold which
-- dashboard is the point of splitting the menu in two, and it is done on
-- the 사용자 관리 screen rather than here -- a seed file that handed both
-- dashboards to every existing role would undo the split on the way in.
--
-- Idempotent, and it re-asserts all five action flags on all ten menus.

-- ---------------------------------------------------------------------
-- 3d. 결제
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- ord_no 11, continuing 013's 9..10.
--
-- WHY A MENU OF ITS OWN AND NOT PART OF PURCHASE_ORDER
--   Because the authority is different, and a single menu id cannot say
--   so. Issuing a PO is a PM's daily work; approving the money on it, and
--   recording that a translator has been paid, is not. Gated on
--   PURCHASE_ORDER, every PM who can raise a PO could approve their own --
--   which is not an approval gate, it is a formality.
--
--   A separate permission makes "who may approve" grantable on its own:
--   assignable, revocable and auditable by the same mechanism as
--   everything else, and changeable on the 사용자 관리 screen without a
--   deploy. That matters here specifically because who holds this
--   authority is still being decided.
--
--   The five action flags then carry the finer distinctions on their own:
--   `read` sees the 결제 screens and the printable documents, `update`
--   approves a PO and records a payment, `create` issues an invoice,
--   `delete` voids one.
--
-- menu_name has no parentheses, for the reason 013 gives: the 사용자 관리
-- permission editor lists these names next to five checkboxes, and nested
-- brackets read badly there.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('PAYMENT', '결제', NULL, 1, '/payment', 11, true)
ON CONFLICT (menu_id) DO NOTHING;


-- ---------------------------------------------------------------------
-- 3e. 나의 업무
-- ---------------------------------------------------------------------
-- ord_no 12, continuing 11. The PM's own worksheet: every PO under a
-- project they have accepted, as a spreadsheet they can type into.
--
-- Its own menu and its own permission (NEOTMS_PERMISSION_WORKSPACE_READ)
-- rather than a second screen behind 대시보드-PM, for the reason the two
-- dashboards were split in the first place: a grant should name one
-- screen. This one is also not read-only -- its cells write through to
-- the job and PO rows underneath -- so folding it into a read permission
-- would make that permission mean two different things.
--
-- The WRITES are not gated here. Editing a default column goes through
-- the same /api/v0/jobs and /api/v0/purchase-orders endpoints the forms
-- use, so it needs the same JOB_UPDATE / PO_UPDATE the forms need. This
-- permission opens the sheet and the person's own custom columns.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('WORKSPACE', '나의 업무', NULL, 1, '/workspace', 12, true)
ON CONFLICT (menu_id) DO NOTHING;


-- ---------------------------------------------------------------------


-- =====================================================================
-- 4. sys_role -- NEOTMS_SYSADMIN, and its grants
-- =====================================================================
INSERT INTO sys_role (role_code, role_name, active, created_by)
VALUES ('NEOTMS_SYSADMIN', '시스템관리자', true, 'neotms-bootstrap')
ON CONFLICT (role_code) DO UPDATE
   SET role_name  = EXCLUDED.role_name,
       active     = true,
       updated_at = now();

-- A COLUMN comment, not a replacement for 002_tables.sql's comment on the
-- TABLE. `COMMENT ON` has no append form -- it only takes a literal and it
-- overwrites -- so restating the table comment here would copy a paragraph
-- out of 002 and then let the two drift. `sys_role.role_name` is the one
-- piece of this table 002 leaves uncommented, and it is the right place for
-- this anyway.
COMMENT ON COLUMN sys_role.role_name IS
  'Display label for the role. The row with role_code ''NEOTMS_SYSADMIN'' is labelled 시스템관리자 '
  'and is created by db/006_bootstrap.sql: it is the application''s superuser (every menu, every '
  'action) and the role handed to a holder of LPX''s lpx.admin.access authority on first sign-in, '
  'by staff_bootstrap_superuser(). Do not delete that row, and do not narrow its grants expecting '
  'them to stay narrowed -- re-running the bootstrap restores them.';


-- ---------------------------------------------------------------------
-- 3. sys_role_grant_all_permissions() -- "this role may do everything"
-- ---------------------------------------------------------------------
-- A function rather than a flat INSERT, for one reason that only shows up
-- later: `sys_menu` will grow. Today it has the six rows above; after the
-- ETL loads legacy SY_MENU it has 48. A superuser role whose grants were
-- written once as literal rows would silently have no rights on the 42
-- new menus, and "no rights" is the failure mode with no error message --
-- the screens just refuse, with a message blaming the role.
--
-- So the grant is expressed as "every active menu, re-evaluated when
-- asked", and the operating instruction is one line:
--
--   SELECT sys_role_grant_all_permissions('NEOTMS_SYSADMIN');
--
-- Run it after any change to `sys_menu`, including the ETL. It is NOT a
-- trigger on sys_menu on purpose: a trigger would grant rights as a side
-- effect of loading a navigation row, and silently widening an
-- authorization matrix is the one behaviour this schema refuses to have.

-- Grant the superuser role every permission this build knows. The function is
-- defined in 001 and reads the vocabulary out of the CHECK on sys_role_permission,
-- so this one call cannot fall behind the list the application compares against.
--
-- Menus are NOT granted here any more: sys_menu is navigation, and a screen is shown
-- when its read permission is held. There is nothing left that could disagree with
-- the permission set about whether a screen is reachable.
SELECT sys_role_grant_all_permissions('NEOTMS_SYSADMIN') AS permissions_granted;
