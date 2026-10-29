-- =====================================================================
-- NEOTMS :: 007_codes.sql
-- Run after 002_tables.sql. Idempotent -- re-run it as often as you like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   `sys_code` is empty after 002..006, and twenty-two columns across this
--   schema are `text REFERENCES sys_code (code) ON DELETE RESTRICT`. An
--   empty parent table plus a restricting foreign key is not a missing
--   feature, it is a wall: every INSERT that carries a code fails with
--   SQLSTATE 23503, and the message names a constraint rather than a
--   field, so on screen it reads as "saving failed" with no indication of
--   which box was wrong.
--
--   The twenty-two, grouped by what the column means:
--
--     분야   customer.cus_field, project.prj_field, project.prj_field2,
--            translator.tran_field, translator.tran_unfield
--     작업   job.work_code, purchase_order.po_work_code,
--            customer_contract.work_code, translator_lang.work_code,
--            translator.tran_work_con
--     단위   job.unit_code, purchase_order.po_unit_code,
--            translator_lang.tran_la_unit
--     언어   job.job_slang, job.job_elang, purchase_order.po_slang,
--            purchase_order.po_elang, customer_contract.cus_co_slang,
--            customer_contract.cus_co_elang, translator_lang.tran_la_slang,
--            translator_lang.tran_la_elang
--     사용   customer.cus_upro, translator.tran_upro
--     프로그램
--
--   So this is not only the customer-registration fix. Jobs, purchase
--   orders, projects and translators all fail the same way the moment
--   somebody fills in a language or a work type; customers are simply the
--   screen that got tried first.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/007_codes.sql
--
--   As with 002..006: no `\` meta-command, no `:placeholder`, no BEGIN and
--   no COMMIT, so the whole file can be pasted into the Supabase SQL
--   editor as-is.
--
-- THESE VALUES ARE A STARTER SET, NOT A SPECIFICATION
--   Legacy SY_CODE has not been profiled, so the real company taxonomy is
--   not knowable from here -- particularly 분야, which is a business
--   decision and not a technical one. Every row below is editable from the
--   유지보수 screen, and editing it is expected. Two groups are the
--   exception and are marked as such where they appear: 작업 and 단위 must
--   keep matching frontend/src/apis/neotms.codes.ts exactly.
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
SELECT COALESCE(c.code_parent, '(domain rows)') AS domain,
       count(*)                                 AS codes
  FROM sys_code c
 WHERE c.code_parent IN ('FIELD', 'WORK', 'UNIT', 'LANG', 'UPRO')
    OR c.code_parent IS NULL
 GROUP BY COALESCE(c.code_parent, '(domain rows)')
 ORDER BY domain;

-- The two groups that must agree with the frontend, listed for eyeballing
-- against neotms.codes.ts. WORK_CODES: 번역 감수 편집 DTP 감리 기타.
-- UNIT_CODES: 단어 글자 매 시간 건.
SELECT c.code_parent AS domain, string_agg(c.code, ' ' ORDER BY c.ord_no) AS codes
  FROM sys_code c
 WHERE c.code_parent IN ('WORK', 'UNIT')
 GROUP BY c.code_parent
 ORDER BY c.code_parent;
