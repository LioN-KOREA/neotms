-- =====================================================================
-- NEOTMS :: 001_schemas.sql
-- The whole database structure, in one file. Run first, then 002.
-- =====================================================================
--
-- This replaces the sixteen numbered migrations that built the schema a
-- step at a time (001_extensions through 016_project_fields). Every one of
-- them had been applied everywhere, so what they recorded was no longer a
-- plan - it was history, spread across seventeen files, in which the shape
-- of a table could only be worked out by reading four of them in order.
--
-- What that consolidation drops, deliberately:
--
--   * THE DATA MIGRATIONS. The backfills, the two PO state renames, the
--     invoice regrouping and the 분야 reclassification all rewrote rows
--     that had come from the legacy system. Against a fresh database they
--     match nothing, and an UPDATE that touches no rows is worse than
--     absent - it reads as having run and been fine. They remain in git
--     history, which is where a question about what happened to the
--     production data belongs.
--   * THE ROLLUP TEARDOWN. 004 dropped a pre-aggregated report table that
--     an earlier design created. Nothing creates it now.
--
-- SO THIS FILE BUILDS A NEW DATABASE. It does not migrate an existing one,
-- and it cannot rebuild the live schema from legacy data - that path is the
-- old chain, in history.
--
-- The sections, in the order they must run:
--
--   1. EXTENSIONS   pgroonga and pg_trgm, in their own schema.
--   2. SEQUENCES    the document-code counters.
--   3. TABLES       all 32, with their table and column comments.
--   4. VALIDATIONS  the constraints that cannot be written inline.
--   5. FUNCTIONS    the three the application calls by name.
--   6. VIEWS        fx_rate_latest.
--   7. INDEXES      all 82, including the PGroonga and trigram ones.
--
-- Tables come before validations because the composite foreign keys point
-- between two tables; indexes come last because several are partial on
-- columns the later sections add.
--
-- =====================================================================


-- =====================================================================
-- 1. EXTENSIONS
-- =====================================================================
--
-- HOW TO RUN THIS
--   psql, not the Data API. The Aurora variant could not run this file at
--   all without a bastion or a custom resource, because the RDS Data API
--   rejects a payload containing more than one statement and the cluster
--   sat in an isolated subnet. Here it is:
--
--     export NEOTMS_DB_PASSWORD=...      # from Secrets Manager
--     PGPASSWORD=$NEOTMS_DB_PASSWORD psql \
--       -h aws-0-ap-northeast-2.pooler.supabase.com -p 6543 \
--       -U postgres.<project-ref> -d postgres -f db/001_extensions.sql
--
--   Use the exact host from the dashboard's Connect dialog; it is not
--   derivable from the region (the leading index is assigned per project).
--
-- PRE-BUILD CHECK (blocking):
--   PGroonga availability MUST be confirmed on the project before anything
--   is built on top of it:
--       SELECT * FROM pg_available_extensions WHERE name = 'pgroonga';
--   PGroonga is a first-class Supabase extension, so this is a check rather
--   than a risk - but it is NOT available on vanilla RDS/Aurora, which is
--   precisely why this file differs from its counterpart on the other
--   branch. If it is ever missing, STOP: the Korean search strategy in
--   003_indexes.sql has no fallback that works at two characters.
--   Do not silently substitute pg_trgm -- see below.
--
-- =====================================================================

-- ---------------------------------------------------------------------
-- The `extensions` schema, and why it matters here
-- ---------------------------------------------------------------------
-- Supabase keeps extensions out of `public` by convention, and its own
-- documentation installs PGroonga with `WITH SCHEMA extensions`. Doing the
-- same keeps `public` holding only this application's tables.
--
-- The consequence is a search_path dependency: the operators PGroonga
-- defines (`&@~`, `%%`) and the operator CLASSES the indexes in
-- 003_indexes.sql name all live in that schema, not in `public`.
--
-- 003_indexes.sql therefore SCHEMA-QUALIFIES every operator class
-- (`extensions.pgroonga_text_regexp_ops_v2`). This is not defensive
-- styling; applying these files to a PGroonga-enabled Postgres whose role
-- search_path did not include `extensions` failed on the very first index
-- with:
--
--   ERROR: operator class "pgroonga_text_regexp_ops_v2" does not exist
--          for access method "pgroonga"
--
-- which reads as "PGroonga is broken" and mentions nothing about the
-- search_path. Qualifying removes the dependency rather than documenting
-- it, and matters especially over the pooler, where a session-level
-- `SET search_path` is not guaranteed to survive to the next statement.
--
-- The OPERATORS are a separate matter and are NOT qualified anywhere,
-- because nothing in this project names one: the application emits plain
-- `LIKE` and PGroonga rewrites it internally (see below), so there is no
-- `%%` or `&@~` token for the parser to resolve. If a future query ever
-- spells an operator out by hand, it needs `extensions` on the search_path
-- or an OPERATOR(extensions.%%) form.
CREATE SCHEMA IF NOT EXISTS extensions;

-- ---------------------------------------------------------------------
-- PGroonga. REQUIRED for Korean text search.
-- ---------------------------------------------------------------------
-- Korean search terms in LKTMS are very frequently exactly 2 characters
-- (삼성, 번역, 계약 ...). pg_trgm's GIN operator class cannot index a
-- pattern shorter than 3 characters: the LIKE '%ab%' predicate produces no
-- indexable trigram key, the index is skipped, and the planner falls back
-- to a sequential scan WITHOUT raising any error. That silent fallback is
-- exactly the legacy performance defect we are here to remove.
--
-- PGroonga rather than pg_bigm, which is what the Aurora variant used:
-- pg_bigm needs an entry in shared_preload_libraries, which on a managed
-- Supabase project is not ours to set. PGroonga needs no preload, is
-- shipped and supported by Supabase, and is a strictly stronger tool - it
-- tokenises CJK text properly instead of taking every 2-character window,
-- so the index is smaller and the recheck cheaper.
--
-- The property this project depends on is PGroonga's LIKE rewrite: it
-- converts `column LIKE '%KEYWORD%'` into `column %% 'KEYWORD'`
-- internally, which means the search layer in NeotmsQuery.ts keeps
-- emitting ordinary LIKE and the ~20 dbops modules are untouched.
-- Two conditions on that, both load-bearing:
--
--   1. THE COLUMN MUST BE `text`, NOT `varchar`. LIKE on a varchar column
--      is ALWAYS a sequential search - silently, with the index sitting
--      there unused. Every searched column in 002_tables.sql is `text` for
--      this reason, and a test parses the schema to keep it that way.
--
--      The mechanism, since "PGroonga cannot index varchar" invites the
--      reasonable-sounding fix of using a varchar operator class instead:
--      PGroonga DOES ship `pgroonga_varchar_regexp_ops_v2`, and an index
--      built with it on a varchar column is created without complaint. It
--      still is not used, because PostgreSQL resolves `LIKE` on varchar by
--      casting first - the plan reads
--
--        Seq Scan on t
--          Filter: ((name)::text ~~ '%삼성%'::text)
--
--      and that `(name)::text` is an expression, not the indexed column, so
--      there is nothing for the rewrite to attach to. Measured, not
--      inferred: 30,000 rows, index present, ANALYZEd, Seq Scan anyway.
--      Changing a column to varchar(n) re-creates the legacy defect, and no
--      choice of operator class rescues it.
--   2. The index must use a LIKE-capable operator class
--      (`pgroonga_text_regexp_ops_v2` here; see 003_indexes.sql).
--      The default class does not serve LIKE.
CREATE EXTENSION IF NOT EXISTS pgroonga WITH SCHEMA extensions;

-- ---------------------------------------------------------------------
-- pg_trgm. ASCII identifier and contact columns only.
-- ---------------------------------------------------------------------
-- po_code, prj_code, job_code, phone, email - terms always longer than 3
-- characters. Trigram indexes are materially smaller than the equivalent
-- full-text index on the same column, and pg_trgm gives us similarity()
-- for fuzzy ranking.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- ---------------------------------------------------------------------
-- What is deliberately NOT here: aws_s3 / aws_commons
-- ---------------------------------------------------------------------
-- The Aurora variant installed both, for one reason: the RDS Data API
-- caps a single result set at 1 MiB, so any report export larger than
-- that had to leave the database through aws_s3.query_export_to_s3() and
-- be collected from an SSE-KMS bucket. That dragged in an IAM role on the
-- cluster, a KMS key, and a key policy - all of it machinery to work
-- around a transport limit.
--
-- Over a socket there is no such cap, and these extensions do not exist
-- outside RDS anyway. A large report is now rendered by the Lambda and, if
-- it exceeds the 6MB response payload, written to the export bucket by the
-- FUNCTION and handed back as a presigned URL. No database involvement.

-- ---------------------------------------------------------------------
-- Statement timeout, set on the ROLE rather than per session
-- ---------------------------------------------------------------------
-- A runaway query is the legacy system's signature failure, and the
-- backstop against it has to be set here rather than in the application.
-- In transaction mode the pooler returns the server connection to the
-- pool at COMMIT, so session-level state does not survive: a `SET
-- statement_timeout` issued by the function applies to that transaction
-- and is then lost, and a `SET` outside a transaction may not even land on
-- the connection the next statement gets. ALTER ROLE persists in the
-- catalogue, so every backend picks it up at login regardless.
--
-- 30 seconds, matched to the function's own 29-second timeout: a statement
-- the caller can no longer receive should not keep burning database CPU.
-- Run as a superuser/owner; harmless to re-run.
ALTER ROLE postgres SET statement_timeout = '30s';

-- ---------------------------------------------------------------------
-- Post-install verification. Expect 2 rows.
-- ---------------------------------------------------------------------
-- SELECT extname, extversion FROM pg_extension
--  WHERE extname IN ('pgroonga','pg_trgm')
--  ORDER BY extname;
--
-- Smoke-test that PGroonga really indexes a 2-character Korean term.
-- Run AFTER 003_indexes.sql. The plan MUST be a Bitmap Index Scan with a
-- Recheck, not a Seq Scan -- see db/004_verify_search.sql, which asserts
-- this and fails loudly rather than leaving it to be read by eye:
-- EXPLAIN ANALYZE SELECT id FROM project WHERE prj_name LIKE '%삼성%';


-- =====================================================================
-- 2. SEQUENCES
-- =====================================================================
--
-- WHY THESE EXIST
--   Every entity in the revenue chain carries a human-readable natural key
--   that is printed on documents and quoted to customers and translators:
--   customer.cus_code, project.prj_code, job.job_code,
--   purchase_order.po_code (e.g. LPO_149817) and translator.tran_code
--   (e.g. TRAN_xxxxxx). These are NOT the primary keys -- the PK is a
--   surrogate bigint -- but they are externally visible and must never be
--   regenerated for an existing row.
--
--   Legacy generated them in application code: SELECT the current maximum,
--   add one, INSERT. That is a lost-update race. Two PMs creating a PO in
--   the same second get the same PO_CODE, and because PRJTB_PO had no
--   unique constraint on PO_CODE, legacy had no backstop either -- the
--   second write simply produced a duplicate code on a real purchase
--   order. A sequence removes the race: nextval is atomic, never hands the
--   same value out twice, and the UNIQUE constraint declared in
--   002_tables.sql is the second line of defence.
--
--   A sequence deliberately has gaps. A rolled-back INSERT consumes a
--   value and does not give it back, so codes are not contiguous. That is
--   correct and must not be "fixed": making codes contiguous requires
--   serialising every create, and a missing code number is not a missing
--   document.
--
-- ---------------------------------------------------------------------
-- MANDATORY ETL STEP
--
--   These sequences start at 1, which WILL collide with migrated legacy
--   codes. After the ETL loads the legacy rows, every sequence must be
--   advanced past the highest numeric suffix already present, e.g.
--
--     SELECT setval('seq_po_code', (
--       SELECT COALESCE(MAX(NULLIF(regexp_replace(po_code, '\D', '', 'g'), ''))::bigint, 0) + 1
--         FROM purchase_order), false);
--
--   Skipping this does not corrupt anything - the UNIQUE constraint turns
--   it into a failed INSERT - but it fails every create until someone
--   works out why, so it belongs in the ETL runbook rather than in
--   somebody's memory.
-- ---------------------------------------------------------------------
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS seq_customer_code   AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_project_code    AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_job_code        AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_po_code         AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_translator_code AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

COMMENT ON SEQUENCE seq_customer_code IS
  'Numeric suffix for newly created customer.cus_code. The prefix lives in the application (NeotmsCodes.ts), because it is a presentation decision; the sequence lives here, because uniqueness is a database guarantee. ETL must setval past the legacy maximum -- see the header of this file.';
COMMENT ON SEQUENCE seq_project_code IS
  'Numeric suffix for newly created project.prj_code. See seq_customer_code.';
COMMENT ON SEQUENCE seq_job_code IS
  'Numeric suffix for newly created job.job_code. NOTE: the legacy PK was the composite (PRJ_CODE, JOB_CODE), so globally unique JOB_CODE is an ETL assumption that must be verified before 002_tables.sql''s UNIQUE constraint can be created. Codes minted from this sequence are globally unique by construction.';
COMMENT ON SEQUENCE seq_po_code IS
  'Numeric suffix for newly created purchase_order.po_code (legacy form LPO_149817). See seq_customer_code.';
COMMENT ON SEQUENCE seq_translator_code IS
  'Numeric suffix for newly created translator.tran_code (legacy form TRAN_xxxxxx). See seq_customer_code.';

-- END 005_code_sequences.sql
-- =====================================================================

-- ---------------------------------------------------------------------
-- 2b. The translator-invoice code counter
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Prefix POL_, from the live form (POL_026153). Minted the same way every
-- other document code is and for the same reason: legacy read the current
-- maximum and added one, which hands two clerks invoicing in the same
-- second the same invoice number. 005_code_sequences.sql has the argument
-- in full; NeotmsCodes.ts holds the prefix.
--
-- MANDATORY ETL STEP, exactly as 005 says for the other five: this starts
-- at 1 and WILL collide with migrated INV_TRAN_CODE values. After the ETL
-- loads invoice_translator, advance it past the highest numeric suffix
-- present. The setval below does that and is safe to run now -- on an
-- empty table it sets 1 -- so running this file after the ETL is enough.
CREATE SEQUENCE IF NOT EXISTS seq_invoice_tran_code AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

COMMENT ON SEQUENCE seq_invoice_tran_code IS
  'Numeric suffix for newly created invoice_translator.inv_tran_code (legacy form POL_026153). NEW IN 015. See seq_customer_code, and note the setval in section 7 of db/015_payment.sql -- re-running that file re-advances this sequence past whatever the ETL has loaded.';


-- =====================================================================
-- 3. TABLES
-- =====================================================================
--
-- CONVENTIONS APPLIED THROUGHOUT
--   * snake_case, English, singular table names.
--   * Every table has a surrogate PK:
--       id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY
--     GENERATED BY DEFAULT (not ALWAYS) so the ETL can insert explicit ids.
--     Remember to run setval-equivalent after the ETL:
--       SELECT setval(pg_get_serial_sequence('<t>','id'), max(id)) FROM <t>;
--   * The legacy business code is RETAINED as a natural key (cus_code,
--     prj_code, job_code, po_code, tran_code, ...). These strings are
--     printed on purchase orders and invoices that have already been sent
--     to customers and translators, so they are externally visible
--     identifiers and must NEVER be regenerated by the ETL.
--   * DEL_YN  -> deleted boolean NOT NULL DEFAULT false
--   * STATE / USE_YN -> active boolean NOT NULL DEFAULT true
--   * REG_DT -> created_at timestamptz NOT NULL DEFAULT now()
--   * UPD_DT -> updated_at timestamptz
--   * REG_ID -> created_by text (deliberately NOT an FK to staff: legacy
--     rows carry mgr_ids of staff records that have since been deleted)
--   * IP     -> created_ip inet
--   * money -> numeric(18,2); volumes/word counts -> numeric(14,2);
--     rates/percentages -> numeric(6,3); FX rates -> numeric(18,6)
--   * EXCEPTION, where it is not certain whether a legacy nvarchar column
--     holds a RATE or an AMOUNT: numeric(18,3), which accepts either.
--     Applies to purchase_order.po_tax and invoice_customer.inv_vat.
--     numeric(6,3) would be correct under the rate reading and would abort
--     the ETL part-loaded under the other, on a numeric-overflow error that
--     names no column. Widening makes a wrong guess a wrong COMMENT -- a
--     one-line ALTER later -- instead of a failed migration now. Each such
--     column's COMMENT carries the query that settles which it is.
--   * legacy nvarchar date -> date, paired *_TIME -> time, kept as two
--     separate columns because the UI edits them separately and the time
--     part is frequently absent.
--
-- WHAT THIS FILE IS FIXING
--   Legacy stored EVERY date and EVERY monetary amount as nvarchar, and had
--   zero non-clustered indexes across all 31 tables. REG_DT/UPD_DT hold
--   Korean 12-hour strings such as '2026-10-26 오후 2:30:42', which are
--   lexicographically unsortable ('오후 11:30' sorts before '오후 2:30'),
--   so every "latest first" list in the current application is silently
--   wrong. The ETL must parse 오전/오후 into real timestamptz values
--   (Asia/Seoul) rather than casting the string.
--
-- =====================================================================
-- DELIBERATELY NOT MIGRATED -- decision record
-- =====================================================================
--
-- 1. TRANTB_MAIN_TEMP  -> dropped, no NEOTMS equivalent.
--    Dead table. '_TEMP' suffix, abandoned import staging area, no records
--    written since 2019. Nothing in the application reads it. Not migrated.
--
-- 2. COINTB_LOG        -> dropped, replaced by fx_rate (below).
--    The legacy FX history feature was misimplemented: it stores a currency
--    value with NO effective timestamp, even though FX rates move
--    continuously. That makes it impossible to say which rate applied on a
--    given day, so historical reports were never reproducible, and in
--    practice nobody uses the feature. Replaced by fx_rate (currency_code,
--    effective_date) + a live rate API feeding it, plus a per-transaction
--    captured rate on job.coin_rate / purchase_order.po_coin_rate so that a
--    report re-run years later reproduces the original figure.
--
-- 3. SY_MGR.MGR_PASS   -> column NEVER migrated; see COMMENT ON staff.
--    Authentication moves to an external OpenID Connect provider. NEOTMS
--    does not store, hash, verify or transport a password, ever. The column
--    is not created here, and the ETL must not carry it into any staging
--    table either.
--
-- =====================================================================


-- =====================================================================
-- SECTION 1 -- currency, FX, corporate entities
-- =====================================================================

-- ---------------------------------------------------------------------
-- currency  (legacy COINTB_MAIN)
-- ---------------------------------------------------------------------
CREATE TABLE currency (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  coin_code   varchar(20) NOT NULL UNIQUE,
  coin_name   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  created_by  text,
  created_ip  inet
);

COMMENT ON TABLE  currency IS
  'Currency lookup. Legacy COINTB_MAIN ("COIN" = currency in LKTMS naming). Referenced by every monetary row via coin_code.';
COMMENT ON COLUMN currency.coin_code IS
  'Legacy COINTB_MAIN.COIN_CODE. Natural key, referenced by FK from job/purchase_order/customer/translator/invoice tables. ISO-4217 codes are 3 characters, but the legacy column is nvarchar(20) and may contain non-ISO house codes, so the width is kept at 20 and NO length CHECK is applied until the ETL has profiled the actual distinct values.';
COMMENT ON COLUMN currency.coin_name IS
  'Legacy COIN_NAME. Display name, usually Korean.';


-- ---------------------------------------------------------------------
-- fx_rate  (NEW -- no legacy equivalent; replaces COINTB_LOG)
-- ---------------------------------------------------------------------
CREATE TABLE fx_rate (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  currency_code  varchar(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  effective_date date NOT NULL,
  rate           numeric(18,6) NOT NULL CHECK (rate > 0),
  source         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_fx_rate_ccy_date UNIQUE (currency_code, effective_date)
);

COMMENT ON TABLE  fx_rate IS
  'Dated FX rate table. NEW in NEOTMS; fixes the legacy defect of a single global rate with no effective date, which made every historical report irreproducible. One row per currency per business day. Populated by a scheduled job from a live rate API.';
COMMENT ON COLUMN fx_rate.currency_code IS
  'ISO-4217 alphabetic code. This is a NEW table fully under our control, so the 3-character business rule IS enforced here by CHECK -- unlike currency.coin_code, which must stay permissive for the ETL.';
COMMENT ON COLUMN fx_rate.effective_date IS
  'Business date the rate applies to. The rate used by an individual transaction is ALSO captured on that transaction (job.coin_rate, purchase_order.po_coin_rate); this table is the reference series, not the system of record for a booked amount.';
COMMENT ON COLUMN fx_rate.rate IS
  'Units of KRW per 1 unit of currency_code. numeric(18,6): six decimals, because low-value currencies (JPY, VND) need them.';
COMMENT ON COLUMN fx_rate.source IS
  'Provenance of the quote (API vendor name, or ''manual'' for an operator override). Free text on purpose.';


-- ---------------------------------------------------------------------
-- corp  (legacy CORPTB_MAIN)
-- ---------------------------------------------------------------------
CREATE TABLE corp (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  corp_code   text NOT NULL UNIQUE,
  corp_name   text,
  active      boolean NOT NULL DEFAULT true,
  deleted     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  created_by  text,
  created_ip  inet
);

COMMENT ON TABLE  corp IS
  'Legal entity / billing company of the agency group. Legacy CORPTB_MAIN. A project is booked to one corp, which decides which letterhead and bank details appear on the invoice (see corp_profile_kor / corp_profile_eng).';
COMMENT ON COLUMN corp.corp_code IS
  'Legacy CORPTB_MAIN.CORP_CODE. Natural key, externally visible on issued documents.';
COMMENT ON COLUMN corp.active IS 'Legacy STATE (Y/N).';


-- ---------------------------------------------------------------------
-- corp_profile_kor  (legacy CORPTB_KOR)
-- ---------------------------------------------------------------------
CREATE TABLE corp_profile_kor (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  corp_id         bigint NOT NULL UNIQUE
                    REFERENCES corp (id) ON DELETE CASCADE,
  corp_kor_name   text,
  corp_kor_no     text,
  corp_kor_ceo    text,
  corp_kor_phone  text,
  corp_kor_fax    text,
  corp_kor_email  text,
  corp_kor_hphone text,
  corp_kor_zip    text,
  corp_kor_addr   text,
  corp_kor_bank   text,
  corp_kor_bank_h text,
  corp_kor_acc    text,
  corp_kor_paypal text,
  tax_code        text,
  deleted         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  created_by      text,
  created_ip      inet
);

COMMENT ON TABLE  corp_profile_kor IS
  'Korean-language letterhead/remittance profile for a corp. Legacy CORPTB_KOR, which was keyed on CORP_CODE alone (one profile per corp) -- the UNIQUE on corp_id preserves that. Owned child of corp, hence ON DELETE CASCADE. ETL NOTE: the legacy chain has no FKs, so orphan profiles pointing at missing CORPTB_MAIN rows must be reconciled before this FK will validate.';
COMMENT ON COLUMN corp_profile_kor.corp_kor_no IS
  'Business registration number (사업자등록번호). Kept as text -- it is formatted with hyphens on printed invoices.';
COMMENT ON COLUMN corp_profile_kor.corp_kor_hphone IS
  'Legacy CORP_KOR_HPHONE. Mobile ("hand phone") number, as opposed to corp_kor_phone (landline).';
COMMENT ON COLUMN corp_profile_kor.corp_kor_bank_h IS
  'Legacy CORP_KOR_BANK_H. Account holder name (예금주) on the bank account in corp_kor_acc. The "_H" suffix is "holder" -- inferred from the nvarchar(20) width and its pairing with corp_kor_bank/corp_kor_acc; UNCONFIRMED.';
COMMENT ON COLUMN corp_profile_kor.tax_code IS
  'Legacy TAX_CODE. Tax treatment classification for invoices issued by this corp. Left as unconstrained text: it is a code-table value but legacy data may contain retired codes absent from sys_code.';


-- ---------------------------------------------------------------------
-- corp_profile_eng  (legacy CORPTB_ENG)
-- ---------------------------------------------------------------------
CREATE TABLE corp_profile_eng (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  corp_id         bigint NOT NULL UNIQUE
                    REFERENCES corp (id) ON DELETE CASCADE,
  corp_eng_name   text,
  corp_eng_no     text,
  corp_eng_ceo    text,
  corp_eng_phone  text,
  corp_eng_fax    text,
  corp_eng_email  text,
  corp_eng_hphone text,
  corp_eng_zip    text,
  corp_eng_addr   text,
  corp_eng_bank   text,
  corp_eng_bank_h text,
  corp_eng_acc    text,
  corp_eng_paypal text,
  tax_code        text,
  deleted         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  created_by      text,
  created_ip      inet
);

COMMENT ON TABLE  corp_profile_eng IS
  'English-language letterhead/remittance profile for a corp, used on invoices to overseas customers and on POs to overseas translators. Legacy CORPTB_ENG, same shape as CORPTB_KOR. Owned child of corp, ON DELETE CASCADE. ETL NOTE: orphan rows must be reconciled before this FK will validate.';
COMMENT ON COLUMN corp_profile_eng.corp_eng_bank_h IS
  'Account holder name on corp_eng_acc. See corp_profile_kor.corp_kor_bank_h -- same unconfirmed "_H" = holder inference.';
COMMENT ON COLUMN corp_profile_eng.tax_code IS
  'Legacy TAX_CODE. See corp_profile_kor.tax_code.';


-- ---------------------------------------------------------------------
-- corp_code_seq  (legacy CORPTB_CODE)
-- ---------------------------------------------------------------------
CREATE TABLE corp_code_seq (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  corp_id         bigint NOT NULL REFERENCES corp (id) ON DELETE CASCADE,
  corp_code_gubun text NOT NULL,
  corp_code_name  text,
  ord_no          integer,
  CONSTRAINT uq_corp_code_seq UNIQUE (corp_id, corp_code_gubun)
);

COMMENT ON TABLE  corp_code_seq IS
  'Per-corp document-code configuration. Legacy CORPTB_CODE, PK (CORP_CODE, CORP_CODE_GUBUN). Owned child of corp, ON DELETE CASCADE. ETL NOTE: orphan rows must be reconciled before this FK will validate. CAUTION: the exact role of this table is UNCONFIRMED -- the table name was chosen on the reading that it holds the code prefix/sequence per document type for a corp. Verify against the ASP code before any application logic depends on it.';
COMMENT ON COLUMN corp_code_seq.corp_code_gubun IS
  'Legacy CORP_CODE_GUBUN. "GUBUN" = type/classification: which kind of document code this row configures. Left as text, not an FK -- the legacy value set is not known to live in SY_CODE.';
COMMENT ON COLUMN corp_code_seq.corp_code_name IS
  'Legacy CORP_CODE_NAME, nvarchar(20). Purpose UNCONFIRMED: plausibly the code prefix string, or the display label for the gubun. Kept verbatim as text rather than guessed at.';
COMMENT ON COLUMN corp_code_seq.ord_no IS
  'Display sort order. Already an int in legacy.';


-- =====================================================================
-- SECTION 2 -- system code tables, menus, roles
-- =====================================================================

-- ---------------------------------------------------------------------
-- sys_code  (legacy SY_CODE)
-- ---------------------------------------------------------------------
CREATE TABLE sys_code (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  code_name     text,
  code_eng_name text,
  code_parent   text REFERENCES sys_code (code) ON DELETE RESTRICT,
  ord_no        integer,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  sys_code IS
  'Generic code table maintained through the application''s code-table admin screen. Legacy SY_CODE. Self-referencing hierarchy via code_parent: the parent code acts as the "domain" (e.g. a parent for service types, one for billing units, one for languages, one for subject fields). Most *_code columns elsewhere in this schema FK to sys_code(code) rather than sys_code(id), so the legacy string survives untouched and the ETL does not have to remap every code column. ETL NOTE: code_parent is self-referencing, so load parents first, or defer the constraint; orphan parents must be reconciled before it will validate.';
COMMENT ON COLUMN sys_code.code IS
  'Legacy SY_CODE.CODE. Natural key and the FK target used across the schema.';
COMMENT ON COLUMN sys_code.code_eng_name IS
  'English label, used when a document is rendered in English (see purchase_order.po_lang).';
COMMENT ON COLUMN sys_code.code_parent IS
  'Parent code = the code domain this entry belongs to. NULL for a top-level domain row.';
COMMENT ON COLUMN sys_code.active IS 'Legacy USE_YN (Y/N).';


-- ---------------------------------------------------------------------
-- sys_menu  (legacy SY_MENU)
-- ---------------------------------------------------------------------
CREATE TABLE sys_menu (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  menu_id     text NOT NULL UNIQUE,
  menu_name   text,
  menu_parent text REFERENCES sys_menu (menu_id) ON DELETE RESTRICT,
  menu_depth  smallint,
  menu_url    text,
  ord_no      integer,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  sys_menu IS
  'Navigation tree. Legacy SY_MENU, 48 menus. Navigation only: it carries each screen''s label, parent and order. It is NOT the unit permissions are granted on -- that is sys_role_permission, a flat list of permission names -- and visibility is derived from it, a menu being shown when its read permission is held. Self-referencing via menu_parent -- load parents first. ETL NOTE: orphan menu_parent values must be reconciled before the FK will validate.';
COMMENT ON COLUMN sys_menu.menu_id IS
  'Legacy SY_MENU.MENU_ID. Natural key and FK target for the permission tables.';
COMMENT ON COLUMN sys_menu.menu_depth IS
  'Nesting level in the navigation tree. Legacy MENU_DEPTH was nvarchar(2); narrowed to smallint since it is an integer level.';
COMMENT ON COLUMN sys_menu.menu_url IS
  'Legacy MENU_URL. Still holds the old .asp paths in migrated data; the rebuild maps these to new routes.';
COMMENT ON COLUMN sys_menu.active IS 'Legacy USE_YN (Y/N).';


-- ---------------------------------------------------------------------
-- sys_role  (legacy SY_ROLE)
-- ---------------------------------------------------------------------
CREATE TABLE sys_role (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  role_code  text NOT NULL UNIQUE,
  role_name  text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  created_by text,
  created_ip inet
);

COMMENT ON TABLE  sys_role IS
  'Permission role. Legacy SY_ROLE. A staff member has exactly one role (staff.role_id), and the role determines what they may do (sys_role_permission). What they may BE named as is separate and per-person -- see staff_attribute.';
COMMENT ON COLUMN sys_role.role_code IS
  'Legacy SY_ROLE.ROLE_ID, renamed to role_code to avoid colliding with the surrogate id. Natural key; staff rows and the permission tables were keyed on this string in legacy. NOT typed in by anybody any more: a role created through the 역할 관리 screen gets a minted code (newRoleCode() in NeotmsRoleAdmin.dbops.ts -- ''ROLE_'' plus a UUID), because the value is a surrogate and asking an administrator for one asked them to follow rules they had no reason to know, permanently. Only the RESERVED codes carry meaning -- NEOTMS_SYSADMIN, which two functions and the seed resolve by name, and the codes the ETL carried over from legacy. Nothing can rename one; the human-readable label is role_name.';
COMMENT ON COLUMN sys_role.active IS 'Legacy STATE (Y/N).';


-- ---------------------------------------------------------------------
-- sys_role_permission
-- ---------------------------------------------------------------------
-- Replaces legacy SY_ROLE_AUTH, the 48-menu x 5-flag matrix, and
-- SY_ROLE_DETAIL, which decided menu visibility separately.
--
-- WHY A LIST OF STRINGS AND NOT A MATRIX
--
-- The matrix could not express two rights this application has. Approving
-- the money on a purchase order had to borrow the payment menu's update
-- bit, so "may sign off an amount" and "may record that it was paid" were
-- one grant. Sending a project handover mail had to borrow PROJECT read,
-- so anyone who could open a project could mail its contents out. Both are
-- a permission of their own here.
--
-- It also carried a fifth flag nobody could name: the legacy columns are
-- ROLE_1..ROLE_5 and the mapping to read/create/update/delete/export was a
-- documented guess that was never confirmed against the ASP source. A
-- permission that cannot be named cannot be granted deliberately.
--
-- Menu VISIBILITY is no longer stored at all. The console derives it: a
-- menu is shown when its read permission is held. Two tables that could
-- disagree about whether a screen is reachable are one table too many --
-- the old pair could, and when they did the symptom was a menu that
-- appears and then refuses every action inside it.
--
-- The CHECK is generated from NEOTMS_PERMISSIONS in
-- lambdas/neotms/nodejs/auth/NeotmsAuthorities.ts, and a test asserts the
-- two lists are equal. Without it a typo stores a grant that silently
-- matches nothing, which is indistinguishable from not having granted it.
CREATE TABLE sys_role_permission (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  role_id    bigint NOT NULL REFERENCES sys_role (id) ON DELETE CASCADE,
  permission text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CONSTRAINT uq_sys_role_permission UNIQUE (role_id, permission),
  CONSTRAINT ck_sys_role_permission CHECK (permission IN (
    'NEOTMS_PERMISSION_PROJECT_READ',
    'NEOTMS_PERMISSION_PROJECT_CREATE',
    'NEOTMS_PERMISSION_PROJECT_UPDATE',
    'NEOTMS_PERMISSION_PROJECT_DELETE',
    'NEOTMS_PERMISSION_PROJECT_EMAIL',
    'NEOTMS_PERMISSION_JOB_READ',
    'NEOTMS_PERMISSION_JOB_CREATE',
    'NEOTMS_PERMISSION_JOB_UPDATE',
    'NEOTMS_PERMISSION_JOB_DELETE',
    'NEOTMS_PERMISSION_PO_READ',
    'NEOTMS_PERMISSION_PO_CREATE',
    'NEOTMS_PERMISSION_PO_UPDATE',
    'NEOTMS_PERMISSION_PO_DELETE',
    'NEOTMS_PERMISSION_PO_APPROVE',
    'NEOTMS_PERMISSION_PO_EMAIL',
    'NEOTMS_PERMISSION_TRANSLATOR_READ',
    'NEOTMS_PERMISSION_TRANSLATOR_CREATE',
    'NEOTMS_PERMISSION_TRANSLATOR_UPDATE',
    'NEOTMS_PERMISSION_TRANSLATOR_DELETE',
    'NEOTMS_PERMISSION_INVOICE_READ',
    'NEOTMS_PERMISSION_INVOICE_CREATE',
    'NEOTMS_PERMISSION_INVOICE_UPDATE',
    'NEOTMS_PERMISSION_INVOICE_DELETE',
    'NEOTMS_PERMISSION_CUSTOMER_READ',
    'NEOTMS_PERMISSION_CUSTOMER_CREATE',
    'NEOTMS_PERMISSION_CUSTOMER_UPDATE',
    'NEOTMS_PERMISSION_CUSTOMER_DELETE',
    'NEOTMS_PERMISSION_REPORT_READ',
    'NEOTMS_PERMISSION_DASHBOARD_SALES_READ',
    'NEOTMS_PERMISSION_DASHBOARD_PM_READ',
    'NEOTMS_PERMISSION_MAINTENANCE_READ',
    'NEOTMS_PERMISSION_MAINTENANCE_CREATE',
    'NEOTMS_PERMISSION_MAINTENANCE_UPDATE',
    'NEOTMS_PERMISSION_MAINTENANCE_DELETE',
    'NEOTMS_PERMISSION_STAFF_READ',
    'NEOTMS_PERMISSION_STAFF_UPDATE',
    'NEOTMS_PERMISSION_WORKSPACE_READ'
  ))
);

COMMENT ON TABLE  sys_role_permission IS
  'What a role may do, as a list of permission names. Replaces the legacy SY_ROLE_AUTH matrix (48 menus x ROLE_1..ROLE_5) and SY_ROLE_DETAIL. SECURITY: server-authoritative. Resolved from staff.role_id on the server for every request; no client-supplied role or permission is ever trusted -- in legacy the role came from an unsigned cookie, and that is the defect being closed. The permitted values are the CHECK above, generated from NEOTMS_PERMISSIONS in NeotmsAuthorities.ts.';
COMMENT ON COLUMN sys_role_permission.permission IS
  'One NEOTMS_PERMISSION_* name. A row here IS the grant -- there is no active flag, because revoking is deleting the row, and a disabled grant that still exists is a second way to say the same thing.';


-- ---------------------------------------------------------------------
CREATE TABLE cat_tool (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cat_tool_code text NOT NULL UNIQUE,
  name          text,
  ord_no        integer,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  created_by    text,
  created_ip    inet
);

COMMENT ON TABLE  cat_tool IS
  'CAT-tool lookup, one row per tool (Trados, memoQ, ...). Legacy SY_CATTOOL stored the whole list as a repeating group CAT_0..CAT_6 on a single row keyed by CAT_TOOL_CODE -- a hard 7-slot ceiling. Normalised here to one row per tool. ETL NOTE: the loader must PIVOT the legacy CAT_0..CAT_6 columns into rows and discard blanks; the numbered columns are NOT carried over. Referenced from translator_cat_tool.';
COMMENT ON COLUMN cat_tool.cat_tool_code IS
  'Stable code for the tool. Legacy had no per-tool code (only the slot position), so the ETL must mint one per distinct tool name and record the mapping.';
COMMENT ON COLUMN cat_tool.ord_no IS
  'Display order. Seed from the legacy slot index (CAT_0 -> 0 ... CAT_6 -> 6) to preserve the current UI ordering.';


-- =====================================================================
-- SECTION 3 -- translators (the cost side of the business)
-- =====================================================================

-- ---------------------------------------------------------------------
-- translator  (legacy TRANTB_MAIN)
-- ---------------------------------------------------------------------
CREATE TABLE translator (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tran_code      text NOT NULL UNIQUE,
  tran_name      text,
  tran_phone     text,
  tran_email     text,
  tran_dup       text,
  tran_msg       text,
  tran_work_con  text REFERENCES sys_code (code) ON DELETE RESTRICT,
  tran_cat_use   boolean NOT NULL DEFAULT false,
  tran_calc      text,
  tran_upro      text REFERENCES sys_code (code) ON DELETE RESTRICT,
  tran_field     text REFERENCES sys_code (code) ON DELETE RESTRICT,
  tran_unfield   text REFERENCES sys_code (code) ON DELETE RESTRICT,
  tran_coin      varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  tran_give      text,
  tran_ictax     text,
  tran_bank      text,
  tran_acc       text,
  tran_paypal    text,
  tran_reg_day   date,
  active         boolean NOT NULL DEFAULT true,
  deleted        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz,
  created_by     text,
  created_ip     inet
);

COMMENT ON TABLE  translator IS
  'Freelance translator / vendor master. Legacy TRANTB_MAIN. The cost side of the chain: CUSTOMER -> PROJECT -> JOB -> PURCHASE_ORDER -> TRANSLATOR. Cost is booked on purchase_order, never here. The repeating groups TRAN_CAT_0..TRAN_CAT_6 and TRAN_FILE_1..TRAN_FILE_5 are NOT carried over; they are normalised into translator_cat_tool and translator_file. ETL NOTE: the sys_code/currency FKs below will not validate until retired code values present in legacy rows are reconciled.';
COMMENT ON COLUMN translator.tran_code IS
  'Legacy TRANTB_MAIN.TRAN_CODE, e.g. TRAN_xxxxxx. Natural key, printed on purchase orders sent to the translator -- never regenerate.';
COMMENT ON COLUMN translator.tran_dup IS
  'Legacy TRAN_DUP. Duplicate-check / alias field: alternate spellings and romanisations of the same person, used to stop the same translator being registered twice. Free text, searched with LIKE.';
COMMENT ON COLUMN translator.tran_msg IS
  'Legacy TRAN_MSG. Internal note shown to PMs when assigning this translator (availability caveats, quality warnings).';
COMMENT ON COLUMN translator.tran_work_con IS
  'Legacy TRAN_WORK_CON. Work condition: the terms under which this translator accepts work (e.g. full-time freelance / part-time / agency). One of the four low-cardinality facets on the translator search screen.';
COMMENT ON COLUMN translator.tran_cat_use IS
  'Legacy TRAN_CAT_USE (Y/N): does this translator work with CAT tools at all. Converted to boolean. Kept even though translator_cat_tool exists, because it is a search facet and because "uses CAT tools but has not told us which" is a real state.';
COMMENT ON COLUMN translator.tran_calc IS
  'Legacy TRAN_CALC, nvarchar(10). "CALC" = calculation method -- how this translator''s fee is computed (e.g. source-word vs target-word basis, or gross vs net CAT weighting). INTENT NOT CONFIRMED, so left as unconstrained text with no FK and no CHECK rather than guessing an enum.';
COMMENT ON COLUMN translator.tran_upro IS
  'Legacy TRAN_UPRO. "UPRO" = 사용 프로그램: which translation (CAT) application this translator works in. FK to sys_code(code), domain ''UPRO'' (see db/007_codes.sql). Load-bearing for dispatch rather than for pricing -- a Trados package sent to a translator who does not run Trados comes back unopened. NULL means never asked; the code ''사용 안 함'' means asked, and works without one. Search facet.';
COMMENT ON COLUMN translator.tran_field IS
  'Legacy TRAN_FIELD. Subject domain this translator handles (legal, medical, IT, ...). Search facet.';
COMMENT ON COLUMN translator.tran_unfield IS
  'Legacy TRAN_UNFIELD. The INVERSE of tran_field: subject domain this translator will NOT take / is excluded from. Note legacy stores a single value, so only one excluded domain can be recorded.';
COMMENT ON COLUMN translator.tran_coin IS
  'Legacy TRAN_COIN. Default settlement currency for this translator.';
COMMENT ON COLUMN translator.tran_give IS
  'Legacy TRAN_GIVE. Payment method / remittance channel (bank transfer, PayPal, ...). Left as text with no FK: it is probably a SY_CODE value but that is UNCONFIRMED, and a wrong FK would block the ETL.';
COMMENT ON COLUMN translator.tran_ictax IS
  'Legacy TRAN_ICTAX. "ICTAX" = income tax withholding (원천징수). AMBIGUOUS: at nvarchar(20) this could be either a withholding RATE (e.g. 3.3) or a withholding CLASSIFICATION code (business income vs other income). Deliberately kept as text rather than typed as numeric(6,3) -- numeric would hard-fail the ETL if the data turns out to be codes. Profile the distinct values, then retype in a follow-up migration.';
COMMENT ON COLUMN translator.tran_bank IS 'Bank name for remittance.';
COMMENT ON COLUMN translator.tran_acc IS
  'Bank account number. Text, not numeric -- leading zeros and hyphens are significant.';
COMMENT ON COLUMN translator.tran_reg_day IS
  'Legacy TRAN_REG_DT, nvarchar(30). The date the translator was ONBOARDED, which is a business fact maintained by staff -- distinct from created_at (legacy REG_DT), the row-insert audit timestamp. Renamed to tran_reg_day and typed date to stop the two being confused, since legacy kept both.';
COMMENT ON COLUMN translator.active IS 'Legacy STATE (Y/N): currently usable for assignment.';
COMMENT ON COLUMN translator.deleted IS 'Legacy DEL_YN (Y/N). Soft delete; appears in nearly every application predicate, hence the partial indexes in 003_indexes.sql.';


-- ---------------------------------------------------------------------
-- translator_rate  (legacy TRANTB_LANG)
-- ---------------------------------------------------------------------
CREATE TABLE translator_rate (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  translator_id  bigint NOT NULL
                   REFERENCES translator (id) ON DELETE CASCADE,
  tran_la_seq    text NOT NULL,
  work_code      text REFERENCES sys_code (code) ON DELETE RESTRICT,
  tran_la_slang  text REFERENCES sys_code (code) ON DELETE RESTRICT,
  tran_la_elang  text REFERENCES sys_code (code) ON DELETE RESTRICT,
  tran_la_unit   text REFERENCES sys_code (code) ON DELETE RESTRICT,
  tran_la_coin   varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  tran_la_cost   numeric(18,2),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz,
  created_by     text,
  created_ip     inet,
  CONSTRAINT uq_translator_rate UNIQUE (translator_id, tran_la_seq)
);

COMMENT ON TABLE  translator_rate IS
  'Agreed rate card per translator, per language pair, per service type, per billing unit. Legacy TRANTB_LANG, PK (TRAN_CODE, TRAN_LA_SEQ). "LA" = language. Owned child rate line, ON DELETE CASCADE. Changes are journalled into translator_rate_log. ETL NOTE: legacy has no FKs here, so rate lines referencing missing TRANTB_MAIN rows must be reconciled before translator_id will validate.';
COMMENT ON COLUMN translator_rate.tran_la_seq IS
  'Legacy TRAN_LA_SEQ, the per-translator line number. Kept as text (legacy nvarchar(20)) and retained in the UNIQUE constraint so the ETL can map (TRAN_CODE, TRAN_LA_SEQ) to this row.';
COMMENT ON COLUMN translator_rate.work_code IS
  'Legacy WORK_CODE. Service type: translation, proofreading, DTP, etc.';
COMMENT ON COLUMN translator_rate.tran_la_slang IS 'Source language ("SLANG").';
COMMENT ON COLUMN translator_rate.tran_la_elang IS 'Target language ("ELANG" = end language).';
COMMENT ON COLUMN translator_rate.tran_la_unit IS
  'Billing unit: per source word, per page, per hour, flat fee, ...';
COMMENT ON COLUMN translator_rate.tran_la_cost IS
  'Cost per unit in tran_la_coin. Legacy TRAN_LA_COST was nvarchar(50); now numeric(18,2).';
COMMENT ON COLUMN translator_rate.active IS 'Legacy STATE (Y/N).';


-- ---------------------------------------------------------------------
-- translator_rate_log  (legacy LOG_TRANTB)
-- ---------------------------------------------------------------------
CREATE TABLE translator_rate_log (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  tran_la_seq    text,
  tran_code      text,
  work_code      text,
  tran_la_slang  text,
  tran_la_elang  text,
  tran_la_unit   text,
  tran_la_coin   text,
  tran_la_cost   numeric(18,2),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text,
  created_ip     inet
);

COMMENT ON TABLE  translator_rate_log IS
  'Append-only journal of translator rate-card changes. Legacy LOG_TRANTB (SEQ int IDENTITY PK). Deliberately has NO foreign keys: an audit log must survive the deletion of the translator and the sys_code entries it refers to, and translator_rate rows are CASCADE-deleted with their parent. tran_code is therefore a denormalised snapshot of the code at the time of the change, not a live reference.';
COMMENT ON COLUMN translator_rate_log.tran_code IS
  'Snapshot of translator.tran_code at change time. Not an FK, on purpose -- see table comment. Join on tran_code when the translator still exists.';
COMMENT ON COLUMN translator_rate_log.tran_la_cost IS
  'The cost value recorded by this log entry. Legacy nvarchar(50) -> numeric(18,2).';
COMMENT ON COLUMN translator_rate_log.created_at IS
  'Legacy REG_DT. Queried almost exclusively as "most recent first", which was silently broken in legacy because REG_DT was an unsortable Korean 12-hour string.';


-- ---------------------------------------------------------------------
-- translator_cat_tool  (NEW -- replaces TRANTB_MAIN.TRAN_CAT_0..6)
-- ---------------------------------------------------------------------
CREATE TABLE translator_cat_tool (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  translator_id bigint NOT NULL
                  REFERENCES translator (id) ON DELETE CASCADE,
  cat_tool_id   bigint NOT NULL
                  REFERENCES cat_tool (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_translator_cat_tool UNIQUE (translator_id, cat_tool_id)
);

COMMENT ON TABLE  translator_cat_tool IS
  'Which CAT tools a translator can work in. NEW table. Replaces the repeating group TRANTB_MAIN.TRAN_CAT_0..TRAN_CAT_6, which imposed a hard 7-tool ceiling and made "which translators have memoQ" an unindexable 7-column OR. ETL NOTE: pivot the seven numbered columns into rows, resolve each value against cat_tool, drop blanks, and de-duplicate -- legacy had no constraint preventing the same tool appearing in two slots. ON DELETE CASCADE on translator_id (owned link row); RESTRICT on cat_tool_id so a tool still in use cannot be deleted.';


-- ---------------------------------------------------------------------
-- translator_file  (NEW -- replaces TRANTB_MAIN.TRAN_FILE_1..5)
-- ---------------------------------------------------------------------
CREATE TABLE translator_file (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  translator_id bigint NOT NULL
                  REFERENCES translator (id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  s3_key        text NOT NULL,
  file_name     text,
  content_type  text,
  byte_size     bigint CHECK (byte_size >= 0 AND byte_size <= 104857600),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_translator_file_seq UNIQUE (translator_id, seq)
);

COMMENT ON TABLE  translator_file IS
  'Attachments held against a translator (CV, NDA, tax residency certificate, ...). NEW table. Replaces the repeating group TRANTB_MAIN.TRAN_FILE_1..TRAN_FILE_5, a hard 5-file ceiling. Owned child rows, ON DELETE CASCADE -- note that deleting a row here does NOT delete the S3 object; an S3 lifecycle/cleanup job must reconcile orphaned objects.';
COMMENT ON COLUMN translator_file.seq IS
  'Display order within the translator''s file list. Seed from the legacy slot number (TRAN_FILE_1 -> 1 ... TRAN_FILE_5 -> 5).';
COMMENT ON COLUMN translator_file.s3_key IS
  'S3 object key. Files now live in S3, not on the IIS filesystem as in legacy, where TRAN_FILE_n held an nvarchar(100) server path. ETL NOTE: the legacy path must be rewritten to an S3 key as the bytes are copied; a migrated path that was never uploaded is a broken download.';
COMMENT ON COLUMN translator_file.content_type IS
  'MIME type recorded at upload, used to set Content-Type on presigned download.';
COMMENT ON COLUMN translator_file.byte_size IS
  'Object size in bytes. CHECK caps an individual file at 100 MB (104857600); in practice almost every file is under 10 MB. The cap is enforced here as a backstop -- the presigned-upload policy is the primary control.';


-- =====================================================================
-- SECTION 4 -- staff / identity
-- =====================================================================

-- ---------------------------------------------------------------------
-- staff  (legacy SY_MGR)
-- ---------------------------------------------------------------------
CREATE TABLE staff (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  mgr_id         text NOT NULL UNIQUE,
  lpx_sub        text UNIQUE,
  mgr_name       text,
  mgr_name_eng   text,
  mgr_phone      text,
  mgr_email      text,
  mgr_position   text,
  role_id        bigint REFERENCES sys_role (id) ON DELETE RESTRICT,
  view_scope     text,
  mgr_tran       text REFERENCES translator (tran_code) ON DELETE SET NULL,
  mgr_tran_name  text,
  corp_code      text REFERENCES corp (corp_code) ON DELETE RESTRICT,
  active         boolean NOT NULL DEFAULT true,
  deleted        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz,
  created_by     text,
  created_ip     inet
);

COMMENT ON TABLE  staff IS
  'Internal staff: PMs, sales managers, administrators. Legacy SY_MGR.
PASSWORDS: SY_MGR.MGR_PASS (nvarchar(500)) IS NOT MIGRATED AND NOT RECREATED HERE. Authentication moves entirely to an external OpenID Connect provider; NEOTMS never stores, hashes, verifies or transports a password again. Do not add a password column to this table.
ETL NOTE: mgr_tran / corp_code / role_id FKs will not validate until references to deleted translators, corps and roles are reconciled.';
COMMENT ON COLUMN staff.mgr_id IS
  'Legacy SY_MGR.MGR_ID. Natural key. This is the value stored in every REG_ID column across the legacy database, which is why created_by is plain text rather than an FK -- historical rows reference mgr_ids that no longer exist.';
COMMENT ON COLUMN staff.lpx_sub IS
  'OIDC "sub" claim from the external identity provider -- the stable external identity key. NULLABLE BY DESIGN: accounts are linked just-in-time on first successful sign-in, because the legacy staff accounts and the identity provider''s accounts have virtually no overlap. The ETL MUST NOT attempt to populate this column; it is written by the JIT-linking path at first sign-in. A NULL here means "legacy staff record not yet claimed by a real identity", which is a normal, expected state after migration.';
COMMENT ON COLUMN staff.mgr_name_eng IS
  'Romanised/English name, used on English-language POs and invoices.';
COMMENT ON COLUMN staff.mgr_position IS
  'Job title (직위). Printed on outgoing documents.';
COMMENT ON COLUMN staff.role_id IS
  'Legacy MGR_AUTH_CODE (which held SY_ROLE.ROLE_ID), now an FK to sys_role. LOAD-BEARING SECURITY COLUMN: menu and action permissions are resolved server-side from this column only. In the legacy system the role was read from an unsigned cookie and was therefore trivially forgeable -- that is the defect being closed. Never accept a role from the client.';
COMMENT ON COLUMN staff.view_scope IS
  'Legacy MGR_VIEW, nvarchar(3). LOAD-BEARING SECURITY COLUMN: row-level visibility (whether this user sees only their own projects/jobs or the whole company''s) is derived from this value server-side, never from a client-supplied parameter. EXACT SEMANTICS UNCONFIRMED: the nvarchar(3) width suggests a Y/N flag ("see everything" vs "see own only"), but it has not been verified against the ASP source, so it is kept as unconstrained text with no CHECK and no boolean conversion. Confirm the distinct values before writing the authorisation predicate.';
COMMENT ON COLUMN staff.mgr_tran IS
  'Legacy MGR_TRAN. Links a staff member to their own translator record, for in-house staff who also take translation work. FK to translator(tran_code) with ON DELETE SET NULL -- removing the translator record must not remove the employee.';
COMMENT ON COLUMN staff.mgr_tran_name IS
  'Denormalised copy of translator.tran_name for the staff list screen. mgr_tran is authoritative; this is a maintained copy that must be rewritten whenever the translator is renamed.';
COMMENT ON COLUMN staff.corp_code IS
  'Legacy MGR_CORP. Which group entity employs this person.';
COMMENT ON COLUMN staff.active IS 'Legacy STATE (Y/N): may currently sign in / be assigned work.';
COMMENT ON COLUMN staff.deleted IS 'Legacy DEL_YN (Y/N). Soft delete -- staff rows are never hard-deleted because historical projects reference them.';


-- =====================================================================
-- SECTION 5 -- customers (the revenue side of the business)
-- =====================================================================

-- ---------------------------------------------------------------------
-- staff_attribute
-- ---------------------------------------------------------------------
-- What a person may BE, as distinct from what they may DO.
--
-- This is the question the old schema could not answer at all, and its
-- absence is why the project form has no 담당영업 or 담당PM input: nothing
-- recorded who was eligible to be named in those columns, so the form
-- declined to offer a picker rather than offer every staff row.
--
-- A permission is a right over a screen. An attribute is a property of the
-- person: NEOTMS_USER_ATTRIBUTE_PM does not let its holder do anything, it
-- lets somebody else put their name in project.prj_pm_id. They are not
-- mutually exclusive -- holding both is how one person sells the work and
-- then runs it, which this business does.
--
-- A table rather than two booleans on `staff`, because the set grows: a
-- third attribute is a row here and an entry in NEOTMS_USER_ATTRIBUTES,
-- where it would otherwise be an ALTER TABLE on the busiest table in the
-- schema plus a column every SELECT has to learn about.
CREATE TABLE staff_attribute (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  staff_id   bigint NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  attribute  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  CONSTRAINT uq_staff_attribute UNIQUE (staff_id, attribute),
  CONSTRAINT ck_staff_attribute CHECK (attribute IN (
    'NEOTMS_USER_ATTRIBUTE_SALES_MANAGER',
    'NEOTMS_USER_ATTRIBUTE_PM',
    'NEOTMS_USER_ATTRIBUTE_SUPERUSER'
  ))
);

COMMENT ON TABLE  staff_attribute IS
  'What a person may be named as, and whether they override the permission system. Not legacy -- NEOTMS only. SALES_MANAGER and PM gate who may appear in a project''s 담당영업 / 담당PM pickers and who the server will accept in prj_mgr_id / prj_pm_id. SUPERUSER overrides every permission check and must only be held by accounts carrying lpx.admin.access. It does NOT widen row scope: which rows a person sees is staff.view_scope, a separate question.';
COMMENT ON COLUMN staff_attribute.attribute IS
  'One NEOTMS_USER_ATTRIBUTE_* name, from NEOTMS_USER_ATTRIBUTES in NeotmsAuthorities.ts. Held or not held -- there is no active flag, for the reason sys_role_permission gives.';
-- ---------------------------------------------------------------------
-- staff_recent_search  (NEOTMS only)
-- ---------------------------------------------------------------------
CREATE TABLE staff_recent_search (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  staff_id   bigint NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  scope      text NOT NULL,
  term       text NOT NULL,
  used_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_recent_search UNIQUE (staff_id, scope, term),
  /*
   * The screens that have a search box, named by their own route path so there is no second
   * naming scheme to keep in step. A CHECK rather than a free text column because the scope
   * arrives from the client: without it, a typo'd or invented scope writes rows that no screen
   * ever reads back, and the symptom is "my recent searches are empty" with data in the table.
   */
  CONSTRAINT ck_staff_recent_search_scope CHECK (scope IN (
    'projects',
    'jobs',
    'purchase-orders',
    'customers',
    'translators',
    'payment/purchase-orders',
    'payment/invoices'
  )),
  /*
   * Bounded here as well as in the request schema. This column exists to be offered back to the
   * person as a suggestion, and a 4,000-character "search term" pasted by accident would be a
   * suggestion nobody can read and a row nobody can get rid of from the UI.
   */
  CONSTRAINT ck_staff_recent_search_term CHECK (char_length(term) BETWEEN 1 AND 100)
);

COMMENT ON TABLE  staff_recent_search IS
  'The last few search terms each person used on each list screen, offered back to them as suggestions. Convenience data, and the only table in this schema that is private to one person: every row is read and written through /api/v0/me/recent-searches, scoped to the caller''s own staff id, and nothing else joins it. Five rows per person per scope are kept -- the write prunes the rest, so this table does not grow with use. Safe to truncate: the consequence is an empty suggestion list.';
COMMENT ON COLUMN staff_recent_search.scope IS
  'Which list the term was typed on, named by that screen''s route path (''projects'', ''payment/invoices''). The permitted values are the CHECK above.';
COMMENT ON COLUMN staff_recent_search.term IS
  'The search term as typed, trimmed. UNIQUE per person and scope, so re-running the same search moves it to the top (used_at is bumped) rather than filling the list with one term.';
COMMENT ON COLUMN staff_recent_search.used_at IS
  'When it was last searched. The suggestion order, and what the five-row prune keeps.';

-- cat_tool  (legacy SY_CATTOOL -- de-repeating-grouped)

-- ---------------------------------------------------------------------
-- customer  (legacy CUSTB_MAIN)
-- ---------------------------------------------------------------------
CREATE TABLE customer (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cus_code      text NOT NULL UNIQUE,
  cus_name      text,
  cus_email     text,
  cus_phone     text,
  cus_zip       text,
  cus_addr      text,
  cus_nation    text,
  cus_coin      varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  cus_upro      text REFERENCES sys_code (code) ON DELETE RESTRICT,
  cus_mincost   numeric(18,2),
  cus_field     text REFERENCES sys_code (code) ON DELETE RESTRICT,
  active        boolean NOT NULL DEFAULT true,
  deleted       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  created_by    text,
  created_ip    inet
);

COMMENT ON TABLE  customer IS
  'Customer (client company) master. Legacy CUSTB_MAIN. Head of the revenue chain: CUSTOMER -> PROJECT -> JOB -> PURCHASE_ORDER -> TRANSLATOR. Revenue is booked on job, cost on purchase_order, so margin = job total - PO total. ETL NOTE: the currency and sys_code FKs will not validate until retired code values in legacy rows are reconciled.';
COMMENT ON COLUMN customer.cus_code IS
  'Legacy CUSTB_MAIN.CUS_CODE. Natural key, appears on issued invoices -- never regenerate.';
COMMENT ON COLUMN customer.cus_nation IS
  'Country. Legacy nvarchar(100) free text, not a code -- deliberately NOT converted to an ISO country code or given a CHECK, because the legacy values are inconsistent Korean/English country names and a CHECK would block the ETL.';
COMMENT ON COLUMN customer.cus_coin IS
  'Legacy CUS_COIN. Default billing currency for this customer.';
COMMENT ON COLUMN customer.cus_upro IS
  'Legacy CUS_UPRO. "UPRO" = 사용 프로그램: which translation (CAT) application this customer primarily works in -- Trados, memoQ and so on. FK to sys_code(code), domain ''UPRO'' (see db/007_codes.sql). NOT A GRADE OR RATE TIER; the comment here used to say that and it was wrong.
RETAINED BUT NOT WRITTEN BY THE APPLICATION: the customer registration screen dropped this field, because most clients of this company do not send translation work and so have no answer to the question. The column stays as the ETL''s landing place for legacy values. translator.tran_upro is the live one.';
COMMENT ON COLUMN customer.cus_mincost IS
  'Legacy CUS_MINCOST. "MINCOST" = minimum charge: the floor amount billed for a job regardless of computed volume, expressed in cus_coin. Legacy nvarchar(30) -> numeric(18,2).';
COMMENT ON COLUMN customer.cus_field IS
  'Legacy CUS_FIELD. Subject domain the customer mainly orders in.';
COMMENT ON COLUMN customer.active IS 'Legacy STATE (Y/N).';
COMMENT ON COLUMN customer.deleted IS 'Legacy DEL_YN (Y/N). Soft delete.';


-- ---------------------------------------------------------------------
-- customer_contact  (legacy CUSTB_MGR)
-- ---------------------------------------------------------------------
CREATE TABLE customer_contact (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id     bigint NOT NULL
                    REFERENCES customer (id) ON DELETE CASCADE,
  cus_mgr_seq     text NOT NULL,
  cus_mgr_name    text,
  cus_mgr_ori     text,
  cus_mgr_posi    text,
  cus_mgr_hphone  text,
  cus_mgr_phone   text,
  cus_mgr_email   text,
  cus_mgr_lang    text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  created_by      text,
  created_ip      inet,
  CONSTRAINT uq_customer_contact UNIQUE (customer_id, cus_mgr_seq)
);

COMMENT ON TABLE  customer_contact IS
  'Contact person at a customer. Legacy CUSTB_MGR, PK (CUS_CODE, CUS_MGR_SEQ). "MGR" here means the client-side contact, not internal staff. Owned child rows, ON DELETE CASCADE. project.customer_contact_id points at the contact who ordered a given project. ETL NOTE: contacts whose CUS_CODE has no CUSTB_MAIN row must be reconciled before customer_id will validate.';
COMMENT ON COLUMN customer_contact.cus_mgr_seq IS
  'Legacy CUS_MGR_SEQ, the per-customer contact line number. Retained so the ETL can resolve the legacy composite key (CUS_CODE, CUS_MGR_SEQ) -- and so it can resolve PRJTB_MAIN.CUS_MGR, which stores this seq, into project.customer_contact_id.';
COMMENT ON COLUMN customer_contact.cus_mgr_ori IS
  'Legacy CUS_MGR_ORI. "ORI" = organisation/department (소속) within the customer company.';
COMMENT ON COLUMN customer_contact.cus_mgr_posi IS
  'Legacy CUS_MGR_POSI. "POSI" = position/job title.';
COMMENT ON COLUMN customer_contact.cus_mgr_hphone IS
  'Mobile ("hand phone") number, as opposed to cus_mgr_phone (desk line).';
COMMENT ON COLUMN customer_contact.cus_mgr_lang IS
  'Legacy CUS_MGR_LANG, nvarchar(200). The language pair(s) this contact orders, held as a legacy delimited string. Kept verbatim as text and NOT normalised: the delimiter and value format are UNCONFIRMED, and no application logic in the rebuild depends on parsing it.';
COMMENT ON COLUMN customer_contact.active IS 'Legacy STATE (Y/N).';


-- ---------------------------------------------------------------------
-- customer_rate  (legacy CUSTB_COST)
-- ---------------------------------------------------------------------
CREATE TABLE customer_rate (
  id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id      bigint NOT NULL
                     REFERENCES customer (id) ON DELETE CASCADE,
  cus_co_seq       text NOT NULL,
  work_code        text REFERENCES sys_code (code) ON DELETE RESTRICT,
  cus_co_slang     text REFERENCES sys_code (code) ON DELETE RESTRICT,
  cus_co_elang     text REFERENCES sys_code (code) ON DELETE RESTRICT,
  cus_co_cate      text,
  cus_co_divi      text,
  cus_co_divi_sel  text,
  cus_co_coin      varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  cus_co_price     numeric(18,2),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  created_by       text,
  created_ip       inet,
  CONSTRAINT uq_customer_rate UNIQUE (customer_id, cus_co_seq)
);

COMMENT ON TABLE  customer_rate IS
  'Agreed price list per customer, per language pair, per service type. Legacy CUSTB_COST, PK (CUS_CODE, CUS_CO_SEQ) -- "CO" = cost. Owned child rate line, ON DELETE CASCADE. Changes are journalled into customer_rate_log. This is the revenue-side mirror of translator_rate. ETL NOTE: orphan rate lines must be reconciled before customer_id will validate.';
COMMENT ON COLUMN customer_rate.cus_co_seq IS
  'Legacy CUS_CO_SEQ, per-customer line number. Retained for ETL key resolution and referenced by customer_rate_log.';
COMMENT ON COLUMN customer_rate.work_code IS 'Service type: translation, proofreading, DTP, ...';
COMMENT ON COLUMN customer_rate.cus_co_cate IS
  'Legacy CUS_CO_CATE, "CATE" = category. INTENT NOT CONFIRMED -- it is some further subdivision of the rate line beyond work_code and the language pair. Left as unconstrained text with no FK rather than guessed at.';
COMMENT ON COLUMN customer_rate.cus_co_divi IS
  'Legacy CUS_CO_DIVI. INTENT NOT CONFIRMED. Most plausibly the billing unit or a discount/surcharge classification; the legacy width differs between CUSTB_COST (nvarchar(20)) and LOG_CUSTB (nvarchar(10)), which is itself a warning sign. Left as text.';
COMMENT ON COLUMN customer_rate.cus_co_divi_sel IS
  'Legacy CUS_CO_DIVI_SEL, nvarchar(10). INTENT NOT CONFIRMED -- a selector that modifies how cus_co_divi is applied. Left as text.';
COMMENT ON COLUMN customer_rate.cus_co_price IS
  'Price per unit charged to the customer, in cus_co_coin. Legacy nvarchar(100) -> numeric(18,2).';
COMMENT ON COLUMN customer_rate.active IS 'Legacy STATE (Y/N).';


-- ---------------------------------------------------------------------
-- customer_rate_log  (legacy LOG_CUSTB)
-- ---------------------------------------------------------------------
CREATE TABLE customer_rate_log (
  id               bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cus_co_seq       text,
  cus_code         text,
  work_code        text,
  cus_co_slang     text,
  cus_co_elang     text,
  cus_co_cate      text,
  cus_co_divi      text,
  cus_co_divi_sel  text,
  cus_co_coin      text,
  cus_co_price     numeric(18,2),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  created_ip       inet
);

COMMENT ON TABLE  customer_rate_log IS
  'Append-only journal of customer price-list changes. Legacy LOG_CUSTB (SEQ int IDENTITY PK). Deliberately has NO foreign keys -- an audit trail must outlive the customer, the rate line (which is CASCADE-deleted) and the sys_code entries it names. cus_code is a snapshot value, not a live reference.';
COMMENT ON COLUMN customer_rate_log.cus_code IS
  'Snapshot of customer.cus_code at change time. Not an FK, on purpose -- see table comment.';
COMMENT ON COLUMN customer_rate_log.cus_co_price IS
  'The price recorded by this log entry. Legacy nvarchar(100) -> numeric(18,2).';
COMMENT ON COLUMN customer_rate_log.created_at IS
  'Legacy REG_DT. Queried as "most recent first" -- which was silently wrong in legacy, where REG_DT was an unsortable Korean 12-hour string.';


-- =====================================================================
-- SECTION 6 -- the core chain: project -> job -> purchase_order
--
-- This is the chain that had NO foreign keys whatsoever in legacy
-- (PRJTB_MAIN -> PRJTB_JOB -> PRJTB_PO were joined on nvarchar codes with
-- nothing enforcing them), which is why orphan rows exist today. Every FK
-- below is declared, but the ETL MUST reconcile orphans first or the
-- constraints will not validate. Revenue is booked on job, cost on
-- purchase_order; margin = SUM(job totals) - SUM(PO totals).
-- =====================================================================

-- ---------------------------------------------------------------------
-- project  (legacy PRJTB_MAIN)
-- ---------------------------------------------------------------------
CREATE TABLE project (
  id                  bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  prj_code            text NOT NULL UNIQUE,
  corp_id             bigint REFERENCES corp (id) ON DELETE RESTRICT,
  coin_code           varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  prj_name            text,
  prj_mgr_id          bigint REFERENCES staff (id) ON DELETE RESTRICT,
  prj_mgr_name        text,
  prj_pm_id           bigint REFERENCES staff (id) ON DELETE RESTRICT,
  prj_pm_name         text,
  customer_id         bigint REFERENCES customer (id) ON DELETE RESTRICT,
  cus_code_name       text,
  customer_contact_id bigint REFERENCES customer_contact (id) ON DELETE SET NULL,
  cus_mgr_name        text,
  prj_field           text REFERENCES sys_code (code) ON DELETE RESTRICT,
  prj_field2          text REFERENCES sys_code (code) ON DELETE RESTRICT,
  prj_state           text,
  prj_invoice_state   text,
  prj_money_state     text,
  inv_code            text,
  inv_dt              date,
  prj_sday            date,
  prj_sday_time       time,
  prj_eday            date,
  prj_eday_time       time,
  prj_content         text,
  deleted             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  created_by          text,
  created_ip          inet,
  -- Has the assigned PM taken this project on. 0 assigned, 1 accepted, -1 rejected.
  --
  -- AFTER the audit tail, which is not where it belongs by meaning -- it belongs
  -- next to prj_pm_id, whose change resets it. It is here because db/005 adds it
  -- to an existing database with ALTER TABLE ADD COLUMN, which always appends:
  -- putting it mid-table here would make a database built from this file and one
  -- migrated by 005 differ in column order, and that equivalence is the claim
  -- db/003's rehearsal is checked against (see the README).
  acceptance_status   smallint NOT NULL DEFAULT 0,
  CONSTRAINT ck_project_acceptance_status CHECK (acceptance_status IN (-1, 0, 1))
);

COMMENT ON TABLE  project IS
  'Customer order / project header. Legacy PRJTB_MAIN, PK PRJ_CODE. One project contains one or more jobs; revenue lives on the jobs, not here. ETL NOTE: legacy PRJTB_MAIN has no FKs at all, so rows referencing missing corps, customers, contacts and staff are expected -- all of them must be reconciled before the FKs declared here will validate. ON DELETE RESTRICT throughout the revenue chain so a project cannot be orphaned by deleting a customer or a staff member.';
COMMENT ON COLUMN project.prj_code IS
  'Legacy PRJ_CODE. Natural key, quoted to the customer and printed on documents -- never regenerate.';
COMMENT ON COLUMN project.corp_id IS
  'Legacy CORP_CODE. Which group entity invoices this project, and therefore which corp_profile_* letterhead is used.';
COMMENT ON COLUMN project.coin_code IS
  'Legacy COIN_CODE. Billing currency agreed for the project. Individual jobs carry their own coin_code and captured coin_rate.';
COMMENT ON COLUMN project.prj_mgr_id IS
  'Legacy PRJ_MGR (held SY_MGR.MGR_ID). The SALES manager who owns the customer relationship, as distinct from prj_pm_id, the project manager who delivers the work. This is the column the reports'' "sales manager" dimension groups on, and it is also one of the three ownership columns the reports'' row-level scope ORs together (with job.job_pm_id and prj_pm_id). The sales-vs-delivery split is inferred from the report dimensions; if the legacy screens label PRJ_MGR differently, only this comment and the dimension''s label change, not the column.';
COMMENT ON COLUMN project.prj_mgr_name IS
  'Denormalised copy of staff.mgr_name for prj_mgr_id. Deliberate denormalisation that serves the project list screen (avoids two staff joins per row). prj_mgr_id is AUTHORITATIVE; this is a maintained copy and must be rewritten when the staff member is renamed.';
COMMENT ON COLUMN project.prj_pm_id IS
  'Legacy PRJ_PM. The project manager responsible for delivery. NOT the reports'' "PM" dimension -- that groups on the job-level PM (job.job_pm_id), which can differ from this one. This column IS part of the reports'' row-level scope, however: a project PM sees their project''s revenue even on jobs assigned to another PM, which is what keeps the report visible over exactly the jobs its reader can list.';
COMMENT ON COLUMN project.prj_pm_name IS
  'Denormalised copy of staff.mgr_name for prj_pm_id. prj_pm_id is authoritative; see prj_mgr_name.';
COMMENT ON COLUMN project.customer_id IS 'Legacy CUS_CODE, resolved to customer.id by the ETL.';
COMMENT ON COLUMN project.cus_code_name IS
  'Legacy CUS_CODE_NAME. Denormalised copy of customer.cus_name. customer_id is authoritative; this is a maintained copy that the project list screen reads and that the Korean 2-gram search index covers.';
COMMENT ON COLUMN project.customer_contact_id IS
  'Legacy CUS_MGR, which held CUSTB_MGR.CUS_MGR_SEQ -- i.e. a sequence number that was only meaningful together with CUS_CODE. The ETL must resolve the pair (CUS_CODE, CUS_MGR) to customer_contact.id. ON DELETE SET NULL: losing the contact must not block deleting them, and must not destroy the project.';
COMMENT ON COLUMN project.cus_mgr_name IS
  'Legacy CUS_MGR_NAME. Denormalised copy of customer_contact.cus_mgr_name. customer_contact_id is authoritative.';
COMMENT ON COLUMN project.prj_field IS
  'Legacy PRJ_FIELD. Primary subject domain (legal, medical, IT, ...). This is the column the reports'' "category" dimension resolves, by LEFT JOIN to sys_code.code. prj_field2 is deliberately NOT reported on: a job counted under two fields would double the revenue of any breakdown that summed the bars. A retired code with no sys_code row falls through to "(unassigned)" rather than dropping the job, so unset and retired are indistinguishable on the report -- query this column directly to tell them apart.';
COMMENT ON COLUMN project.prj_field2 IS
  'Legacy PRJ_FIELD2. Secondary subject domain. Legacy declared FIELD2 before FIELD in the table; the ordering here puts the primary first, which is harmless but worth knowing when diffing against the old DDL.';
COMMENT ON COLUMN project.prj_state IS
  'Legacy PRJ_STATE. Workflow status of the project. Left as unconstrained text with NO CHECK and NO FK to sys_code on purpose: live data contains retired status values that no longer exist in SY_CODE, so either a CHECK or an FK would hard-fail the ETL. Profile the distinct values post-migration, then add a constraint.';
COMMENT ON COLUMN project.prj_invoice_state IS
  'Legacy PRJ_INVOICE_STATE. Has the project been invoiced yet. Unconstrained text -- see prj_state.';
COMMENT ON COLUMN project.prj_money_state IS
  'Legacy PRJ_MONEY_STATE. Has payment been received. Unconstrained text -- see prj_state.';
COMMENT ON COLUMN project.inv_code IS
  'Legacy INV_CODE. The customer invoice this project was billed on; corresponds to invoice_customer.inv_cus_code. NOT declared as an FK: legacy rows reference invoice codes for invoices that were subsequently deleted, and the relationship is informational on this table.';
COMMENT ON COLUMN project.inv_dt IS 'Legacy INV_DT, nvarchar(30) -> date. Date the project was invoiced.';
COMMENT ON COLUMN project.prj_sday IS
  'Legacy PRJ_SDAY. Project start date. nvarchar(30) holding ''2026-10-26'' -> real date; this is the single most-filtered column in the application.';
COMMENT ON COLUMN project.prj_sday_time IS
  'Legacy PRJ_SDAY_TIME, e.g. ''18:00''. Kept as a SEPARATE time column rather than merged into prj_sday: the UI edits date and time independently and the time is frequently absent (NULL), which a timestamp could not represent.';
COMMENT ON COLUMN project.prj_eday IS 'Legacy PRJ_EDAY. Project due/end date.';
COMMENT ON COLUMN project.prj_eday_time IS 'Legacy PRJ_EDAY_TIME. Due time; see prj_sday_time for why it is separate.';
COMMENT ON COLUMN project.prj_content IS
  'Legacy PRJ_CONTENT, nvarchar(3000). Free-text project instructions. Length limit dropped -- text costs nothing extra in Postgres.';
COMMENT ON COLUMN project.deleted IS 'Legacy DEL_YN (Y/N). Soft delete; drives the WHERE NOT deleted partial indexes.';
COMMENT ON COLUMN project.acceptance_status IS
  'NEOTMS only, no legacy column. Whether the assigned PM (prj_pm_id) has taken this project on: 0 = assigned and unanswered, 1 = accepted, -1 = rejected. Written ONLY by ProjectAcceptanceOps, which requires the caller to BE prj_pm_id and the current value to be 0 -- there is no un-accept, deliberately. RESET TO 0 whenever prj_pm_id changes, because the answer belonged to the previous PM and the new one has not been asked; that reset is a CASE in ProjectUpdateOps and fires only when the id actually differs, so an edit that re-submits the same PM does not wipe an acceptance. Every non-zero value also has a row in project_acceptance; this column is the CURRENT answer, that table is the history. Existing rows were left at 0 by db/005 rather than backfilled to 1 -- an acceptance nobody gave is not a fact worth inventing.';


-- ---------------------------------------------------------------------
-- project_acceptance  (NEOTMS only)
-- ---------------------------------------------------------------------
-- One row per answer a PM gave about a project. Append-only.
--
-- WHY A TABLE AND NOT JUST THE COLUMN
--   project.acceptance_status says what the answer is NOW. It cannot say
--   who gave it, when, or what the previous PM said before the project was
--   moved -- and the reset on reassignment deliberately destroys that. A
--   rejected project is reassigned and accepted by somebody else; the
--   question "who turned this down, and why" is then unanswerable from the
--   column alone, and it is the question somebody asks.
--
-- NO UNIQUE CONSTRAINT, on purpose. A project can collect several rows:
--   assigned to A who rejected, reassigned to B who accepted, and -- if it
--   comes back to A later -- answered by A a second time. A UNIQUE on
--   (project_id) or (project_id, staff_id) would turn the history into one
--   row and lose exactly what this table exists for.
--
-- NO 0 ROWS. The CHECK allows only 1 and -1: 0 means "not yet answered",
--   which is the ABSENCE of an answer and therefore the absence of a row.
--   A row saying 0 would be a record of nothing having happened.
--
-- NO updated_at, NO deleted. An audit row is never edited and never
--   retracted. ON DELETE CASCADE on the project because this is part of
--   that project's history and has no meaning without it; the application
--   only ever soft-deletes a project, so the cascade fires only on a
--   genuine hard delete. ON DELETE RESTRICT on the staff member, like
--   every other staff reference -- somebody who answered cannot be erased.
CREATE TABLE project_acceptance (
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

CREATE INDEX ix_project_acceptance_project ON project_acceptance (project_id, created_at DESC);

COMMENT ON TABLE  project_acceptance IS
  'Every accept or reject a PM has given on a project. NEOTMS only -- no legacy table. Append-only and deliberately without a UNIQUE constraint: a project reassigned after a rejection collects a second row, and that sequence is the thing being recorded. project.acceptance_status is the current answer; this is how it was arrived at. A row exists for every non-zero value of that column, and 0 (unanswered) has no row -- see the CHECK.';
COMMENT ON COLUMN project_acceptance.staff_id IS
  'The PM who answered -- the caller, which the write path has already proved equal to project.prj_pm_id at the time. Not a copy of prj_pm_id read afterwards: by the time anybody reads this row the project may have been reassigned, which is precisely why the answer records its own author.';
COMMENT ON COLUMN project_acceptance.acceptance_status IS
  '1 accepted, -1 rejected. Same vocabulary as project.acceptance_status minus 0, which is the absence of an answer.';
COMMENT ON COLUMN project_acceptance.note IS
  'Optional free text the PM gave with the answer. The reason a rejection is actionable: without it the sales manager learns only that the project came back, and has to telephone to find out why. Optional rather than required on rejection because a blank reason given under protest ("-") is worse than none.';


-- ---------------------------------------------------------------------
-- job  (legacy PRJTB_JOB)  -- REVENUE is booked here
-- ---------------------------------------------------------------------
CREATE TABLE job (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  job_code        text NOT NULL UNIQUE,
  project_id      bigint NOT NULL REFERENCES project (id) ON DELETE RESTRICT,
  job_name        text,
  work_code       text REFERENCES sys_code (code) ON DELETE RESTRICT,
  job_pm_id       bigint REFERENCES staff (id) ON DELETE RESTRICT,
  job_pm_name     text,
  -- 업무 구분. The discriminator; the payload it selects lives in one of the two
  -- job_detail_* tables below. NOT NULL with a DEFAULT because the external LKTMS
  -- ETL does not know this column exists, and all historical work is linguistics.
  job_type        text NOT NULL DEFAULT 'LINGUISTICS'
                    REFERENCES sys_code (code) ON DELETE RESTRICT,
  -- The amount stays on the parent for every 업무 구분: a KRW total means the same
  -- thing on all three, and it is what the reports sum and the rollup aggregates.
  -- The five PRICING INPUTS that produce it are linguistic-only and live in
  -- job_detail_linguistic.
  coin_code       varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  coin_rate       numeric(18,6),
  job_price_sum   numeric(18,2),
  job_price_ksum  numeric(18,2),
  job_sday        date,
  job_sday_time   time,
  job_eday        date,
  job_eday_time   time,
  job_memo        text,
  job_state       text,
  deleted         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  created_by      text,
  created_ip      inet,
  -- Pins a detail row to its parent's 업무 구분; see the VALIDATIONS section.
  CONSTRAINT job_id_type_key UNIQUE (id, job_type)
);

COMMENT ON TABLE  job IS
  'A single deliverable within a project: one language pair, one service type, one price. Legacy PRJTB_JOB, PK (PRJ_CODE, JOB_CODE).
REVENUE IS BOOKED HERE. job_price_sum (original currency) and job_price_ksum (KRW) are what the reports sum as revenue; the matching cost sits on purchase_order. Margin for a job = job.job_price_ksum - SUM(purchase_order.po_price_ksum) over its POs.
ETL NOTE: legacy had no FK from PRJTB_JOB to PRJTB_MAIN, so jobs whose PRJ_CODE has no project row are expected and must be reconciled before project_id will validate. A job can also be MOVED between projects -- see job_move_log.';
COMMENT ON COLUMN job.job_code IS
  'Legacy JOB_CODE. Natural key, externally visible. CAUTION: the legacy PK was the COMPOSITE (PRJ_CODE, JOB_CODE), so global uniqueness of JOB_CODE alone is an ASSUMPTION -- supported by the fact that LOG_JOB records moving a job between projects while keeping its code, but the ETL MUST verify it and report duplicates before this UNIQUE constraint can be created.';
COMMENT ON COLUMN job.project_id IS
  'Legacy PRJ_CODE. RESTRICT: a project with jobs cannot be deleted, because deleting it would silently destroy booked revenue.';
COMMENT ON COLUMN job.work_code IS 'Service type (translation, proofreading, DTP, ...).';
COMMENT ON COLUMN job.job_pm_id IS
  'Legacy JOB_PM (held SY_MGR.MGR_ID). The PM accountable for this job. This is the column the reports'' "PM" dimension groups on -- the JOB-level PM, which can differ from project.prj_pm_id -- and one of the three ownership columns the reports'' row-level scope ORs together.';
COMMENT ON COLUMN job.job_pm_name IS
  'Legacy JOB_PM_NAME. Denormalised copy of staff.mgr_name. job_pm_id is AUTHORITATIVE; this is a maintained copy for the job list screen and is covered by a 2-gram search index.';
COMMENT ON COLUMN job.coin_code IS 'Transaction currency for this job.';
COMMENT ON COLUMN job.coin_rate IS
  'Legacy COIN_RATE. The FX rate CAPTURED AT TRANSACTION TIME, i.e. the rate actually used to compute job_price_ksum from job_price_sum. Stored per transaction on purpose: a report re-run years later must reproduce the original figure, which it cannot do by looking up today''s rate. fx_rate is the reference series; THIS column is the system of record for this job''s conversion. numeric(18,6).';
COMMENT ON COLUMN job.job_price_sum IS
  'Total revenue for this job in the ORIGINAL currency (coin_code). Legacy JOB_PRICE_SUM, nvarchar(200) -> numeric(18,2).';
COMMENT ON COLUMN job.job_price_ksum IS
  'Legacy JOB_PRICE_KSUM. "KSUM" = KRW-converted total (= job_price_sum * coin_rate), as opposed to job_price_sum, the original-currency total. This is the column the reports sum as REVENUE, because totals must be comparable across currencies. Margin is revenue minus the sum of the job''s POs'' po_price_ksum, derived per query and never stored, so that there is exactly one definition of it.';
COMMENT ON COLUMN job.job_sday IS 'Job start date. Legacy nvarchar(30) -> date.';
COMMENT ON COLUMN job.job_sday_time IS 'Start time; kept separate from the date because the UI edits them separately and it is often absent.';
COMMENT ON COLUMN job.job_eday IS
  'Job delivery/due date, and the BUSINESS DATE of every report: delivery is when revenue is recognised, so a job is counted in the period it was delivered in, not the one it was created or invoiced in. Every report range is a range over this column (ix_job_eday), which makes it the one date the reports cannot do without -- a job with a NULL job_eday belongs to no period and therefore appears in no report at all.';
COMMENT ON COLUMN job.job_eday_time IS 'Delivery time; see job_sday_time.';
COMMENT ON COLUMN job.job_memo IS 'Legacy JOB_MEMO, nvarchar(max). Internal working notes.';
COMMENT ON COLUMN job.job_state IS
  'Legacy JOB_STATE. Workflow status. Unconstrained text with no CHECK and no sys_code FK -- live data contains retired status values; see project.prj_state.';
COMMENT ON COLUMN job.deleted IS 'Legacy DEL_YN (Y/N). Soft delete. IMPORTANT for reporting: deleted jobs must be excluded from revenue, which is why every report query carries `j.deleted = false` -- written as `= false` rather than `NOT deleted` so it matches the WHERE NOT deleted predicate of ix_job_eday and the report stays an index scan.';


-- ---------------------------------------------------------------------
-- purchase_order  (legacy PRJTB_PO)  -- COST is booked here
-- ---------------------------------------------------------------------
CREATE TABLE purchase_order (
  id                 bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  po_code            text NOT NULL UNIQUE,
  project_id         bigint REFERENCES project (id) ON DELETE RESTRICT,
  job_id             bigint NOT NULL REFERENCES job (id) ON DELETE RESTRICT,
  po_name            text,
  po_work_code       text REFERENCES sys_code (code) ON DELETE RESTRICT,
  -- CAT-tool analysis. Nothing to do with 업무 분류, which is po_category on the
  -- detail table.
  po_cat_use         boolean NOT NULL DEFAULT false,
  po_cat_word        numeric(14,2),
  po_cat_mid         numeric(14,2),
  po_cat_stotal      numeric(14,2),
  po_pm_id           bigint REFERENCES staff (id) ON DELETE RESTRICT,
  po_pm_name         text,
  translator_id      bigint REFERENCES translator (id) ON DELETE RESTRICT,
  po_tran_name       text,
  -- 업무 구분. Independent of its job's: a MICE conference legitimately carries a
  -- Linguistics interpretation PO.
  po_type            text NOT NULL DEFAULT 'LINGUISTICS'
                       REFERENCES sys_code (code) ON DELETE RESTRICT,
  po_coin_code       varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  po_coin_rate       numeric(18,6),
  po_price_sum       numeric(18,2),
  po_price_ksum      numeric(18,2),
  po_tax             numeric(18,3),
  po_tax_price       numeric(18,2),
  po_tax_sum         numeric(18,2),
  po_sday            date,
  po_sday_time       time,
  po_eday            date,
  po_eday_time       time,
  po_lang            text,
  po_content         text,
  po_state           text,
  po_state_dt        timestamptz,
  -- The approval gate. Separate from po_state on purpose: the state says how far
  -- the work has got, these three say whether the money was signed off and by whom.
  po_approved        boolean NOT NULL DEFAULT false,
  po_approved_at     timestamptz,
  po_approved_by     text,
  po_invoice_state   text,
  po_money_state     text,
  po_money_day       date,
  po_money_price     numeric(18,2),
  po_money_gubun     text,
  -- Which translator invoice this PO was billed on. The foreign key is added in the
  -- VALIDATIONS section rather than here, because `invoice_translator` is created
  -- further down this file and a forward reference is not resolvable inline.
  invoice_translator_id bigint,
  inv_code           text,
  inv_dt             date,
  deleted            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz,
  created_by         text,
  created_ip         inet,
  CONSTRAINT po_id_type_key UNIQUE (id, po_type)
);

COMMENT ON TABLE  purchase_order IS
  'Purchase order issued to a translator for part or all of a job. Legacy PRJTB_PO, PK (PRJ_CODE, JOB_CODE, PO_CODE).
COST IS BOOKED HERE. po_price_sum (original currency) / po_price_ksum (KRW) are what the reports sum as cost. Margin = job revenue - PO cost, so one job may carry several POs (translation + proofreading, or a split delivery) and the sum of their costs is the job''s cost.
ETL NOTE: legacy had NO FK from PRJTB_PO to PRJTB_JOB or PRJTB_MAIN, so POs whose JOB_CODE or PRJ_CODE has no parent row are expected and must be reconciled before job_id / project_id will validate. ON DELETE RESTRICT: a job carrying POs cannot be deleted, because that would silently destroy booked cost.';
COMMENT ON COLUMN purchase_order.po_code IS
  'Legacy PO_CODE, e.g. LPO_149817. Natural key. PRINTED ON THE PURCHASE ORDER SENT TO THE TRANSLATOR and quoted on their invoice -- never regenerate. Globally unique in practice even though the legacy PK was composite; the ETL must verify.';
COMMENT ON COLUMN purchase_order.project_id IS
  'Legacy PRJ_CODE, denormalised onto the PO in legacy (it is derivable via job_id -> project_id). RETAINED because the PO list and report screens filter on it directly and the extra join is avoidable. The ETL must ensure it agrees with job.project_id; they can disagree after a job move (see job_move_log).';
COMMENT ON COLUMN purchase_order.job_id IS 'Legacy JOB_CODE. The job whose cost this PO represents.';
COMMENT ON COLUMN purchase_order.po_work_code IS 'Service type purchased (translation, proofreading, ...).';
COMMENT ON COLUMN purchase_order.po_cat_use IS
  'Legacy PO_CAT_USE (Y/N) -> boolean. Was a CAT-tool analysis used to price this PO (weighted word counts) rather than a flat volume.';
COMMENT ON COLUMN purchase_order.po_cat_word IS
  'Legacy PO_CAT_WORD, nvarchar(200) -> numeric(14,2). A word count from the CAT-tool analysis. PRECISE MEANING UNCONFIRMED: most plausibly the new/no-match word count. Treat the three po_cat_* columns as "CAT analysis figures of unverified breakdown" until the analysis template is checked.';
COMMENT ON COLUMN purchase_order.po_cat_mid IS
  'Legacy PO_CAT_MID. MEANING UNCONFIRMED -- plausibly the fuzzy-match ("middle") band word count. See po_cat_word.';
COMMENT ON COLUMN purchase_order.po_cat_stotal IS
  'Legacy PO_CAT_STOTAL. MEANING UNCONFIRMED -- plausibly the weighted total word count after applying CAT match discounts ("sum total"). This is the figure most likely multiplied by po_price. See po_cat_word.';
COMMENT ON COLUMN purchase_order.po_pm_id IS 'Legacy PO_PM. The PM who issued this PO.';
COMMENT ON COLUMN purchase_order.po_pm_name IS
  'Legacy PO_PM_NAME. Denormalised copy of staff.mgr_name; po_pm_id is authoritative.';
COMMENT ON COLUMN purchase_order.translator_id IS
  'Legacy PO_TRAN (held TRANTB_MAIN.TRAN_CODE). The vendor being paid. RESTRICT: a translator with POs cannot be deleted.';
COMMENT ON COLUMN purchase_order.po_tran_name IS
  'Legacy PO_TRAN_NAME. Denormalised copy of translator.tran_name. translator_id is AUTHORITATIVE; this is a maintained copy that the PO list screen displays and that carries a Korean 2-gram search index -- it is one of the most-searched columns in the application.';
COMMENT ON COLUMN purchase_order.po_coin_rate IS
  'Legacy PO_COIN_RATE. The FX rate CAPTURED AT TRANSACTION TIME -- the rate actually used to derive po_price_ksum from po_price_sum. Stored per transaction so a report re-run years later reproduces the original figure; fx_rate is the reference series, this column is the system of record for this PO. numeric(18,6).';
COMMENT ON COLUMN purchase_order.po_price_sum IS
  'Total cost of this PO in the ORIGINAL currency (po_coin_code). Legacy nvarchar(200) -> numeric(18,2).';
COMMENT ON COLUMN purchase_order.po_price_ksum IS
  'Legacy PO_PRICE_KSUM. "KSUM" = KRW-converted total (= po_price_sum * po_coin_rate). This is the column the reports sum as COST, so that cost is comparable across currencies and against job_price_ksum. Note that cost sits one level BELOW revenue -- a job has many POs -- so the reports sum it through a LATERAL subquery per job rather than a join, which would otherwise multiply the job''s revenue by its number of POs.';
COMMENT ON COLUMN purchase_order.po_tax IS
  'Legacy PO_TAX, nvarchar(200) -> numeric(18,3). READ AS a RATE/PERCENTAGE (3.300 = Korean 3.3% withholding), on the inference that po_tax (rate) x base = po_tax_price (amount) with po_tax_sum the gross. That reading is NOT confirmed: all three legacy tax columns were nvarchar(200), so any of them could hold an amount instead.
   WIDTH IS DELIBERATELY WIDER THAN THE READING NEEDS. A rate needs numeric(6,3); this is numeric(18,3) so that the column also accepts a tax AMOUNT in KRW or JPY without overflowing. The point is to make a wrong guess a LABELLING problem (the column means something other than the comment says) rather than an ETL problem (the load aborts on the first row over 999.999, mid-migration, with a numeric overflow that names no column value). Narrowing it later is a one-line ALTER; re-running a half-loaded migration is not.
   TO CONFIRM AFTER THE LOAD: SELECT max(po_tax), count(*) FILTER (WHERE po_tax > 100) FROM purchase_order WHERE po_tax IS NOT NULL. A max at or below 100 with no outliers means it is a rate, and this comment stands. Any sizeable count above 100 means it is an amount: change the reading here, retype to numeric(18,2), and switch PurchaseOrderCreateSchema.poTax from RateSchema to MoneySchema.
   Counter-evidence worth weighing: invoice_translator.inv_tax is typed as an amount, and its legacy width was nvarchar(30) rather than 200 -- the two tax columns may not follow the same convention.';
COMMENT ON COLUMN purchase_order.po_tax_price IS
  'Legacy PO_TAX_PRICE. Tax AMOUNT (withholding or VAT) on this PO. See po_tax for the uncertainty caveat.';
COMMENT ON COLUMN purchase_order.po_tax_sum IS
  'Legacy PO_TAX_SUM. Total INCLUDING tax, i.e. the amount actually remitted to the translator. See po_tax for the uncertainty caveat.';
COMMENT ON COLUMN purchase_order.po_sday IS 'PO start date (when the translator may begin).';
COMMENT ON COLUMN purchase_order.po_sday_time IS 'Start time; separate column because the UI edits it separately and it is often absent.';
COMMENT ON COLUMN purchase_order.po_eday IS
  'PO deadline -- the date the translator must deliver by. Heavily filtered, and indexed together with translator_id for the "what does this translator owe us" screen.';
COMMENT ON COLUMN purchase_order.po_eday_time IS 'Deadline time; see po_sday_time.';
COMMENT ON COLUMN purchase_order.po_lang IS
  'Legacy PO_LANG, nvarchar(10). The LANGUAGE THE PO DOCUMENT IS RENDERED IN (Korean vs English letterhead for an overseas translator) -- NOT a translation language; po_slang/po_elang carry those. Inference from the width and its position after the date fields; UNCONFIRMED. Left as text.';
COMMENT ON COLUMN purchase_order.po_content IS 'Legacy PO_CONTENT, nvarchar(600). Instructions to the translator, reproduced on the PO.';
COMMENT ON COLUMN purchase_order.po_state IS
  'Legacy PO_STATE. Workflow status (issued / accepted / delivered / ...). Unconstrained text, no CHECK, no sys_code FK -- live data contains retired values; see project.prj_state.';
COMMENT ON COLUMN purchase_order.po_state_dt IS
  'Legacy PO_STATE_DT, nvarchar(30). Timestamp of the most recent po_state transition. Typed timestamptz rather than date (unlike the other legacy date columns) because it is an event timestamp and the legacy strings carry a time part. ETL must parse the Korean 오전/오후 form.';
COMMENT ON COLUMN purchase_order.po_invoice_state IS
  'Legacy PO_INVOICE_STATE. Has the translator invoiced us for this PO. Unconstrained text; see po_state.';
COMMENT ON COLUMN purchase_order.po_money_state IS
  'Legacy PO_MONEY_STATE. Have we PAID the translator for this PO. Unconstrained text; see po_state.';
COMMENT ON COLUMN purchase_order.po_money_day IS 'Legacy PO_MONEY_DAY, nvarchar(30) -> date. Date the translator was paid.';
COMMENT ON COLUMN purchase_order.po_money_price IS
  'Legacy PO_MONEY_PRICE. Amount actually paid, which can differ from po_tax_sum after adjustments. numeric(18,2).';
COMMENT ON COLUMN purchase_order.po_money_gubun IS
  'Legacy PO_MONEY_GUBUN. "GUBUN" = type/classification: payment method or payment batch type. Left as text, no FK -- value set UNCONFIRMED.';
COMMENT ON COLUMN purchase_order.inv_code IS
  'Legacy INV_CODE. The translator invoice (invoice_translator.inv_tran_code) this PO was settled on. NOT an FK -- legacy references invoices that were later deleted.';
COMMENT ON COLUMN purchase_order.inv_dt IS 'Legacy INV_DT -> date. Date of that translator invoice.';
COMMENT ON COLUMN purchase_order.deleted IS
  'Legacy DEL_YN (Y/N). Soft delete. Deleted POs must be excluded from cost, which is why the reports'' cost LATERAL filters `po.deleted = false` -- spelled `= false` to match the WHERE NOT deleted predicate of ix_po_job.';


-- =====================================================================
-- SECTION 7 -- linguist tasks and invoicing
-- =====================================================================

-- ---------------------------------------------------------------------
-- linguist_task  (legacy LINGTB_MAIN)
-- ---------------------------------------------------------------------
CREATE TABLE linguist_task (
  id            bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ling_code     text NOT NULL UNIQUE,
  prj_log       text,
  ling_eday     date,
  ling_etime    time,
  ling_pm_id    bigint REFERENCES staff (id) ON DELETE RESTRICT,
  ling_tran_id  bigint REFERENCES translator (id) ON DELETE RESTRICT,
  ling_word     numeric(14,2),
  ling_memo     text,
  ling_chk      text,
  ling_state    text,
  ling_id       text,
  ling_name     text,
  deleted       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text
);

COMMENT ON TABLE  linguist_task IS
  'In-house linguist work queue. Legacy LINGTB_MAIN, PK LING_CODE. "LING" = linguist. Tracks internal linguistic work (review, QA, terminology) with a deadline and a word count, separately from the project/job/PO chain. CAUTION: this table''s role is the least well understood of the migrated set -- several columns below could not be identified with confidence. It has no legacy FKs; references to missing staff/translator rows must be reconciled before the FKs here will validate.';
COMMENT ON COLUMN linguist_task.ling_code IS 'Legacy LING_CODE. Natural key.';
COMMENT ON COLUMN linguist_task.prj_log IS
  'Legacy PRJ_LOG, nvarchar(200). PURPOSE NOT DETERMINED. The name suggests a project reference or a free-text activity log; at nvarchar(200) it is too wide for a PRJ_CODE and too narrow for a real log. Carried over verbatim as text, with no FK, pending inspection of the ASP screen that writes it.';
COMMENT ON COLUMN linguist_task.ling_eday IS 'Legacy LING_EDAY -> date. Deadline for the linguist task.';
COMMENT ON COLUMN linguist_task.ling_etime IS
  'Legacy LING_ETIME -> time. Deadline time, kept as a separate column from ling_eday per the date/time convention.';
COMMENT ON COLUMN linguist_task.ling_pm_id IS 'Legacy LING_PM. The PM who raised the task.';
COMMENT ON COLUMN linguist_task.ling_tran_id IS
  'Legacy LING_TRAN. The linguist/translator the task is assigned to, resolved to translator.id.';
COMMENT ON COLUMN linguist_task.ling_word IS 'Legacy LING_WORD, nvarchar(30) -> numeric(14,2). Word count for the task.';
COMMENT ON COLUMN linguist_task.ling_chk IS
  'Legacy LING_CHK. "CHK" = checked flag. NOT converted to boolean: the legacy column is nvarchar(30), far too wide for Y/N, which suggests it holds something other than a flag (possibly a checker''s name or a check result code). INTENT NOT CONFIRMED -- left as text.';
COMMENT ON COLUMN linguist_task.ling_state IS
  'Legacy LING_STATE. Workflow status. Unconstrained text; see project.prj_state.';
COMMENT ON COLUMN linguist_task.ling_id IS
  'Legacy LING_ID, nvarchar(30). PURPOSE NOT DETERMINED -- it is NOT the PK (ling_code is) and it is NOT the audit REG_ID (that is created_by). Possibly the mgr_id of the person who performed the check. Carried over verbatim; do not build logic on it until confirmed.';
COMMENT ON COLUMN linguist_task.ling_name IS
  'Legacy LING_NAME, nvarchar(30). PURPOSE NOT DETERMINED; most likely the display name paired with ling_id. Carried over verbatim.';
COMMENT ON COLUMN linguist_task.deleted IS 'Legacy DEL_YN (Y/N). Soft delete.';
COMMENT ON COLUMN linguist_task.created_at IS
  'Legacy REG_DT. Note LINGTB_MAIN had no UPD_DT, so there is no updated_at column here.';


-- ---------------------------------------------------------------------
-- invoice_customer  (legacy INVTB_CUS)
-- ---------------------------------------------------------------------
CREATE TABLE invoice_customer (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  inv_cus_code   text NOT NULL UNIQUE,
  customer_id    bigint REFERENCES customer (id) ON DELETE RESTRICT,
  cus_name       text,
  mgr_code       text,
  mgr_name       text,
  inv_mgr        text,
  inv_mgr_name   text,
  inv_gubun      text,
  inv_day        date,
  inv_last_day   date,
  inv_mo_state   text,
  inv_state      text,
  inv_total      numeric(18,2),
  inv_vat        numeric(18,3),
  inv_memo       text,
  coin_code      varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  inv_p_job      numeric(18,2),
  inv_p_dis      numeric(18,2),
  inv_p_vat      numeric(18,2),
  inv_p_total    numeric(18,2),
  deleted        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text,
  created_ip     inet
);

COMMENT ON TABLE  invoice_customer IS
  'Customer invoice (receivable). Legacy INVTB_CUS, PK INV_CUS_CODE. Groups the billable jobs for a customer over a billing period; project.inv_code / purchase_order.inv_code point back here by code. ETL NOTE: references to deleted customers must be reconciled before customer_id will validate.';
COMMENT ON COLUMN invoice_customer.inv_cus_code IS
  'Legacy INV_CUS_CODE. Natural key. PRINTED ON THE INVOICE SENT TO THE CUSTOMER -- never regenerate.';
COMMENT ON COLUMN invoice_customer.cus_name IS
  'Denormalised copy of customer.cus_name AS AT ISSUE TIME. customer_id is authoritative for the relationship, but note that on an invoice the historical name is arguably the correct thing to display -- do not "fix" this value on a customer rename.';
COMMENT ON COLUMN invoice_customer.mgr_code IS
  'Legacy MGR_CODE with its paired MGR_NAME. The customer-side contact for this invoice. Kept as text, NOT an FK: the legacy value could be either a CUSTB_MGR seq or a SY_MGR id and the two cannot be told apart without profiling. MAPPING UNCONFIRMED.';
COMMENT ON COLUMN invoice_customer.mgr_name IS 'Display name paired with mgr_code.';
COMMENT ON COLUMN invoice_customer.inv_mgr IS
  'Legacy INV_MGR with its paired INV_MGR_NAME. The internal staff member who ISSUED the invoice (holds a SY_MGR.MGR_ID). Left as text rather than an FK to staff for the same reason as created_by -- legacy rows name staff who have since been deleted.';
COMMENT ON COLUMN invoice_customer.inv_mgr_name IS 'Display name paired with inv_mgr.';
COMMENT ON COLUMN invoice_customer.inv_gubun IS
  'Legacy INV_GUBUN. "GUBUN" = type/classification of invoice (e.g. monthly consolidated vs per-project). Unconstrained text, value set UNCONFIRMED.';
COMMENT ON COLUMN invoice_customer.inv_day IS 'Legacy INV_DAY -> date. Invoice issue date.';
COMMENT ON COLUMN invoice_customer.inv_last_day IS
  'Legacy INV_LAST_DAY -> date. Read as the payment DUE date (last day to pay). Could alternatively be the closing date of the billing period; UNCONFIRMED.';
COMMENT ON COLUMN invoice_customer.inv_mo_state IS
  'Legacy INV_MO_STATE. "MO" denotes the payment/settlement side throughout the invoice tables: payment status for this invoice. Unconstrained text.';
COMMENT ON COLUMN invoice_customer.inv_state IS 'Legacy INV_STATE. Invoice lifecycle status (draft / issued / cancelled). Unconstrained text.';
COMMENT ON COLUMN invoice_customer.inv_total IS
  'Legacy INV_TOTAL, nvarchar(200) -> numeric(18,2). Headline invoice total. Note the invoice also carries the inv_p_* breakdown below; where they disagree the breakdown is the more granular record.';
COMMENT ON COLUMN invoice_customer.inv_vat IS
  'Legacy INV_VAT, nvarchar(10) -> numeric(18,3). READ AS a VAT RATE (Korean VAT is 10), on two pieces of circumstantial evidence: the narrow legacy width (10, against 200 for the amount columns) and the existence of inv_p_vat, which plainly holds the amount. Stronger evidence than the po_tax case, but still not confirmation.
   WIDTH IS DELIBERATELY WIDER THAN THE READING NEEDS, for the reason given at length on purchase_order.po_tax: nvarchar(10) will hold "1234567.89" just as happily as "10", and a numeric(6,3) column turns the wrong guess into an ETL that aborts part-loaded rather than a comment that needs correcting.
   TO CONFIRM AFTER THE LOAD: SELECT max(inv_vat), count(*) FILTER (WHERE inv_vat > 100) FROM invoice_customer WHERE inv_vat IS NOT NULL. Values clustered at 10 confirm the rate reading; anything large means it duplicates inv_p_vat and should be retyped numeric(18,2).';
COMMENT ON COLUMN invoice_customer.inv_memo IS 'Legacy INV_MEMO, nvarchar(4000). Free-text note; length limit dropped.';
COMMENT ON COLUMN invoice_customer.inv_p_job IS
  'Legacy INV_P_JOB. The "P" prefix marks the price breakdown block: sum of job charges before discount and tax.';
COMMENT ON COLUMN invoice_customer.inv_p_dis IS 'Legacy INV_P_DIS. Discount amount applied to the invoice.';
COMMENT ON COLUMN invoice_customer.inv_p_vat IS 'Legacy INV_P_VAT. VAT amount (as opposed to inv_vat, read as the rate).';
COMMENT ON COLUMN invoice_customer.inv_p_total IS
  'Legacy INV_P_TOTAL. Final payable = inv_p_job - inv_p_dis + inv_p_vat. This is the figure the customer pays and the one invoice_customer_payment reconciles against.';
COMMENT ON COLUMN invoice_customer.deleted IS 'Legacy DEL_YN (Y/N). Soft delete; invoices are never hard-deleted.';


-- ---------------------------------------------------------------------
-- invoice_customer_payment  (legacy INVTB_CUS_MO)
-- ---------------------------------------------------------------------
CREATE TABLE invoice_customer_payment (
  id                  bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  invoice_customer_id bigint NOT NULL UNIQUE
                        REFERENCES invoice_customer (id) ON DELETE CASCADE,
  inv_cus_code        text NOT NULL UNIQUE,
  customer_id         bigint REFERENCES customer (id) ON DELETE RESTRICT,
  cus_name            text,
  coin_code           varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  mgr_code            text,
  mgr_name            text,
  inv_mgr_code        text,
  inv_mgr_name        text,
  inv_gubun           text,
  inv_day             date,
  inv_m_state         text,
  inv_p_total         numeric(18,2),
  inv_p_res           numeric(18,2),
  inv_m_gubun         text,
  inv_p_req           numeric(18,2),
  inv_m_day           date,
  reg_name            text,
  deleted             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text,
  created_ip          inet
);

COMMENT ON TABLE  invoice_customer_payment IS
  'Receipt/settlement record against a customer invoice. Legacy INVTB_CUS_MO ("MO" = 입금, money in), PK INV_CUS_CODE.
DESIGN NOTE: the legacy PK was INV_CUS_CODE ALONE, so the legacy model allows only ONE payment row per invoice -- partial payments cannot be represented. That restriction is preserved faithfully by the UNIQUE constraints on invoice_customer_id and inv_cus_code. If instalment/partial payments become a requirement, DROP those two UNIQUE constraints and add a payment sequence column; nothing else in the schema needs to change.
Owned child of invoice_customer, ON DELETE CASCADE. ETL NOTE: payment rows whose INV_CUS_CODE has no INVTB_CUS row must be reconciled before invoice_customer_id will validate.';
COMMENT ON COLUMN invoice_customer_payment.inv_cus_code IS
  'Legacy INV_CUS_CODE, retained alongside invoice_customer_id so the ETL and any legacy report can still join by code.';
COMMENT ON COLUMN invoice_customer_payment.inv_m_state IS
  'Legacy INV_M_STATE. Settlement status of this receipt. Unconstrained text.';
COMMENT ON COLUMN invoice_customer_payment.inv_p_total IS
  'Legacy INV_P_TOTAL. Invoiced total being settled, copied from invoice_customer.inv_p_total at receipt time.';
COMMENT ON COLUMN invoice_customer_payment.inv_p_res IS
  'Legacy INV_P_RES. Read as the RESIDUAL/outstanding balance after this receipt (inv_p_total - amount received). UNCONFIRMED; "RES" could also be "received". Typed numeric(18,2) either way, so the typing is safe even if the label is wrong.';
COMMENT ON COLUMN invoice_customer_payment.inv_m_gubun IS
  'Legacy INV_M_GUBUN. Receipt method/classification (bank transfer, card, offset). Unconstrained text.';
COMMENT ON COLUMN invoice_customer_payment.inv_p_req IS
  'Legacy INV_P_REQ. Read as the amount REQUESTED/claimed. UNCONFIRMED.';
COMMENT ON COLUMN invoice_customer_payment.inv_m_day IS 'Legacy INV_M_DAY -> date. Date the money was received.';
COMMENT ON COLUMN invoice_customer_payment.reg_name IS
  'Legacy REG_NAME, nvarchar(30). Display name of the person who recorded the receipt -- the name paired with created_by (REG_ID). Kept because created_by is not an FK and the staff row may be gone.';


-- ---------------------------------------------------------------------
-- invoice_translator  (legacy INVTB_TRAN)
-- ---------------------------------------------------------------------
CREATE TABLE invoice_translator (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  inv_tran_code   text NOT NULL UNIQUE,
  coin_code       varchar(20) REFERENCES currency (coin_code) ON DELETE RESTRICT,
  translator_id   bigint REFERENCES translator (id) ON DELETE RESTRICT,
  tran_name       text,
  pm_code         text,
  pm_name         text,
  -- The PM the invoice is filed under, as a real foreign key. pm_code/pm_name are
  -- the legacy text copies and are kept for what the ETL already wrote.
  inv_pm_id       bigint REFERENCES staff (id) ON DELETE RESTRICT,
  inv_day         date,
  inv_sum         numeric(18,2),
  inv_tax         numeric(18,2),
  inv_mo_pday     date,
  inv_mo_state    text,
  inv_mo_gubun    text,
  inv_mo_day      date,
  inv_mo_sum      numeric(18,2),
  inv_mo_tax      numeric(18,2),
  inv_state       text,
  deleted         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz,
  created_by      text,
  created_ip      inet
);

COMMENT ON TABLE  invoice_translator IS
  'Translator invoice / payable. Legacy INVTB_TRAN, PK INV_TRAN_CODE. The cost-side counterpart of invoice_customer: groups the POs being settled with one translator. purchase_order.inv_code points back here by code. Unlike the customer side, payment is tracked on this same row via the inv_mo_* columns rather than in a separate table. ETL NOTE: references to deleted translators must be reconciled before translator_id will validate.';
COMMENT ON COLUMN invoice_translator.inv_tran_code IS
  'Legacy INV_TRAN_CODE. Natural key, quoted to the translator -- never regenerate.';
COMMENT ON COLUMN invoice_translator.tran_name IS
  'Denormalised copy of translator.tran_name as at issue time; translator_id is authoritative for the relationship. Carries a Korean 2-gram search index for the payables screen.';
COMMENT ON COLUMN invoice_translator.pm_code IS
  'The PM who approved the payable (holds a SY_MGR.MGR_ID). Text, not an FK -- legacy names deleted staff.';
COMMENT ON COLUMN invoice_translator.pm_name IS 'Display name paired with pm_code.';
COMMENT ON COLUMN invoice_translator.inv_day IS 'Legacy INV_DAY -> date. Date of the translator''s invoice.';
COMMENT ON COLUMN invoice_translator.inv_sum IS
  'Legacy INV_SUM, nvarchar(200) -> numeric(18,2). Gross amount invoiced by the translator, in coin_code.';
COMMENT ON COLUMN invoice_translator.inv_tax IS
  'Legacy INV_TAX, nvarchar(30) -> numeric(18,2). Withholding tax AMOUNT on this invoice. Typed as an amount (not a rate) because the paired inv_mo_tax is clearly an amount; the narrow legacy width is a mild counter-indication, so VERIFY.';
COMMENT ON COLUMN invoice_translator.inv_mo_pday IS
  'Legacy INV_MO_PDAY -> date. Read as the PLANNED payment date (the "P" being planned/promised), as distinct from inv_mo_day, the actual payment date. UNCONFIRMED.';
COMMENT ON COLUMN invoice_translator.inv_mo_state IS 'Legacy INV_MO_STATE. Payment status. Unconstrained text.';
COMMENT ON COLUMN invoice_translator.inv_mo_gubun IS 'Legacy INV_MO_GUBUN. Payment method/classification. Unconstrained text.';
COMMENT ON COLUMN invoice_translator.inv_mo_day IS 'Legacy INV_MO_DAY -> date. Date the translator was actually paid.';
COMMENT ON COLUMN invoice_translator.inv_mo_sum IS 'Legacy INV_MO_SUM. Amount actually paid.';
COMMENT ON COLUMN invoice_translator.inv_mo_tax IS 'Legacy INV_MO_TAX. Tax actually withheld at payment.';
COMMENT ON COLUMN invoice_translator.inv_state IS 'Legacy INV_STATE. Invoice lifecycle status. Unconstrained text.';


-- =====================================================================
-- SECTION 8 -- audit logs
--
-- None of these tables declare foreign keys, deliberately. An audit trail
-- must remain readable after the rows it describes have been deleted, so
-- every reference here is a SNAPSHOT of the legacy code string at the time
-- of the event, not a live relationship. All of them are queried
-- "most recent first", which was silently broken in legacy because REG_DT
-- was an unsortable Korean 12-hour string -- see the header of this file.
-- =====================================================================

-- ---------------------------------------------------------------------
-- job_move_log  (legacy LOG_JOB)
-- ---------------------------------------------------------------------
CREATE TABLE job_move_log (
  id              bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  log_job_seq     text,
  job_code        text,
  log_job_work    text,
  log_job_pm      text,
  pre_prj_code    text,
  aft_prj_code    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text,
  created_ip      inet
);

COMMENT ON TABLE  job_move_log IS
  'Journal of jobs being MOVED between projects. Legacy LOG_JOB, PK LOG_JOB_SEQ. This is the evidence that job_code is stable across a project change (the code survives, only the parent project differs), which is what justifies the global UNIQUE on job.job_code. No FKs -- snapshot values only.';
COMMENT ON COLUMN job_move_log.log_job_seq IS
  'Legacy LOG_JOB_SEQ, the legacy primary key, nvarchar(20). Retained for traceability back to the source row; the surrogate id is the real key here.';
COMMENT ON COLUMN job_move_log.job_code IS 'Legacy LOG_JOB_CODE. Snapshot of the job code that was moved.';
COMMENT ON COLUMN job_move_log.log_job_work IS
  'Legacy LOG_JOB_WORK. Snapshot of the job''s service type (WORK_CODE) at move time.';
COMMENT ON COLUMN job_move_log.log_job_pm IS
  'Legacy LOG_JOB_PM. Snapshot of the job''s PM (a SY_MGR.MGR_ID) at move time -- note this is the job''s PM, not necessarily the person who performed the move; that is created_by.';
COMMENT ON COLUMN job_move_log.pre_prj_code IS
  'Legacy LOG_PRE_PRJ. The project the job was moved FROM ("pre").';
COMMENT ON COLUMN job_move_log.aft_prj_code IS
  'Legacy LOG_AFT_PRJ. The project the job was moved TO ("aft" = after).';


-- ---------------------------------------------------------------------
-- workspace_column, workspace_cell  (NEOTMS only)
-- ---------------------------------------------------------------------
-- The columns one person has added to their own 나의 업무 sheet, and the
-- values they have typed into them. The second personal pair in this
-- schema after staff_recent_search, and personal in the same strict
-- sense: every row is read and written through /api/v0/workspace scoped
-- to the caller's own staff id, and nothing else in the application
-- joins to either table.
--
-- WHY THIS IS RELATIONAL AND NOT A JSON DOCUMENT
--
-- A per-user JSON blob was the alternative considered, and the deciding
-- requirement was "a value disappears when its PO does". Here that is
-- one foreign key. In a document store it is an orphan-reaping job that
-- has to be written, scheduled and watched, and until it runs the values
-- of deleted POs are still being paid for in every user's document.
--
-- Three more followed from the same place: the sheet's rows are already
-- scoped by SQL, so the values can come back attached to their row in
-- the same statement; a spreadsheet writes ONE cell at a time, which is
-- one row here against a read-modify-write of the whole document (two
-- open tabs silently overwriting each other); and a document has a size
-- ceiling that a sheet grows into, failing at save time, when the person
-- has just typed something.
CREATE TABLE workspace_column (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  staff_id   bigint NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  col_label  text NOT NULL,
  -- Position among the custom columns, left to right. Not UNIQUE per
  -- staff member: a reorder rewrites every row's ord_no in one statement
  -- and a unique constraint would make the intermediate state of that
  -- rewrite illegal. Ties break on id, so a duplicate is untidy rather
  -- than broken.
  ord_no     integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz,
  created_by text,
  created_ip inet,
  -- Bounded here as well as in the request schema, for the reason
  -- staff_recent_search.term is: this string becomes a column heading,
  -- and a 4,000-character heading is one nobody can read and one the
  -- grid cannot lay out.
  CONSTRAINT ck_workspace_column_label CHECK (char_length(col_label) BETWEEN 1 AND 40)
);

CREATE TABLE workspace_cell (
  column_id  bigint NOT NULL REFERENCES workspace_column (id) ON DELETE CASCADE,
  po_id      bigint NOT NULL REFERENCES purchase_order (id) ON DELETE CASCADE,
  cell_text  text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (column_id, po_id),
  CONSTRAINT ck_workspace_cell_text CHECK (char_length(cell_text) <= 2000)
);

COMMENT ON TABLE  workspace_column IS
  'One custom column on one person''s 나의 업무 sheet. NEOTMS only -- no legacy table. Private to its staff_id: every read and write goes through /api/v0/workspace scoped to the caller, and no other screen reads this table. ON DELETE CASCADE to staff for the reason staff_recent_search gives -- a departed employee''s private annotations are not company history the way their projects are.';
COMMENT ON COLUMN workspace_column.col_label IS
  'The column heading the person typed. Free text on purpose: the request was "freely editable", and a typed column (date, number) would mean a spreadsheet that refuses what was typed into it.';
COMMENT ON COLUMN workspace_column.ord_no IS
  'Left-to-right position among the custom columns. The fourteen default columns are not in this table and always come first.';
COMMENT ON TABLE  workspace_cell IS
  'One value in one custom column, against one purchase order. NEOTMS only. The composite primary key IS the "one value per column per row" rule, so a save is an upsert rather than a read-then-insert. ON DELETE CASCADE on both sides: deleting a column destroys its values, which is what the feature promises, and a hard-deleted PO takes its annotations with it.';
COMMENT ON COLUMN workspace_cell.po_id IS
  'The purchase order this value is attached to. NOTE -- NEOTMS soft-deletes, so a deleted PO''s values stop being VISIBLE because the sheet no longer has that row, not because this cascade fired; the cascade covers a hard delete or an ETL purge. A PO that is undeleted brings its values back, which is the intended behaviour rather than an accident of the design.';
COMMENT ON COLUMN workspace_cell.cell_text IS
  'The value, always as text. One column rather than a typed triple because the sheet treats every custom column as free text -- see workspace_column.col_label.';


-- ---------------------------------------------------------------------
-- purchase_order_log  (legacy LOG_PO)
-- ---------------------------------------------------------------------
CREATE TABLE purchase_order_log (
  id             bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  prj_code       text,
  job_code       text,
  po_code        text,
  po_name        text,
  po_coin_code   text,
  po_volume      numeric(14,2),
  po_unit_code   text,
  po_price_sum   numeric(18,2),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text,
  created_ip     inet
);

COMMENT ON TABLE  purchase_order_log IS
  'Journal of purchase-order changes, capturing the cost figures as they stood. Legacy LOG_PO (SEQ int IDENTITY PK). This is the audit trail for the cost side of margin, so it is the table auditors read; no FKs, snapshot values only. Always queried by created_at DESC, optionally narrowed by created_by.';
COMMENT ON COLUMN purchase_order_log.po_volume IS 'Snapshot volume. Legacy nvarchar(100) -> numeric(14,2).';
COMMENT ON COLUMN purchase_order_log.po_price_sum IS
  'Snapshot of the PO total in the original currency. Legacy nvarchar(100) -> numeric(18,2). Note the legacy log did NOT capture PO_PRICE_KSUM or the FX rate, so KRW figures cannot be reconstructed from this log alone -- only from purchase_order.po_coin_rate on the live row.';


-- ---------------------------------------------------------------------
-- modify_log  (legacy LOG_MoDel)
-- ---------------------------------------------------------------------
CREATE TABLE modify_log (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  item        text,
  contents    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  created_ip  inet
);

COMMENT ON TABLE  modify_log IS
  'Generic modify/delete audit trail. Legacy LOG_MoDel (note the legacy mixed-case name; "MoDel" = modify/delete, not "model"). SEQ int IDENTITY PK. Catch-all table written by assorted screens, with no typed reference to the row that changed -- which is why it is of limited forensic value.';
COMMENT ON COLUMN modify_log.item IS
  'Legacy Item, nvarchar(20). What was changed. The 20-character legacy width means this is a terse label, not a qualified record reference.';
COMMENT ON COLUMN modify_log.contents IS
  'Legacy Contents, nvarchar(20). The change detail. NOTE: at nvarchar(20) the legacy column TRUNCATED almost everything written to it, so migrated values are frequently cut off mid-word and cannot be recovered. Widened to text here so new entries are complete.';


-- =====================================================================
-- END 002_tables.sql
--
-- Table count: 32 (29 migrated from legacy + fx_rate, translator_cat_tool,
-- translator_file; cat_tool is both a legacy port and a de-normalisation).
-- Two legacy tables (TRANTB_MAIN_TEMP, COINTB_LOG) and one legacy column
-- (SY_MGR.MGR_PASS) are intentionally absent -- see the decision record at
-- the top of this file.
--
-- Next: 003_indexes.sql, then 004_rollup.sql (which no longer creates
-- anything -- it tears the old reporting rollup down and records why).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 3b. The four type-detail tables
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 3c. The pricing inputs on the linguistic detail tables
-- ---------------------------------------------------------------------
-- =====================================================================
-- Same types as the columns they replace (002_tables.sql) -- volumes are
-- numeric(14,2) because fractional pages and hours occur, money is
-- numeric(18,2).
--
-- `unit_code` and `po_unit_code` keep their foreign key onto
-- sys_code (code), so a typo'd billing unit is still refused on the way
-- in. The UNIT domain itself is seeded by 007_codes.sql and is unchanged.
--
-- The column names are unchanged too, including `unit_code`'s missing
-- `job_` prefix. Renaming on the way across would have been tidier and
-- was rejected: the two dbops modules alias every detail column to its
-- bare name precisely so that `toJobRow` reads `job_volume` exactly as it
-- did when the column was on `job`, which keeps the move invisible above
-- the ops layer. A rename here would be a second, unrelated change
-- arriving in the same commit.
ALTER TABLE job_detail_linguistic
  ADD COLUMN IF NOT EXISTS job_volume numeric(14,2);
ALTER TABLE job_detail_linguistic
  ADD COLUMN IF NOT EXISTS unit_code text REFERENCES sys_code (code) ON DELETE RESTRICT;
ALTER TABLE job_detail_linguistic
  ADD COLUMN IF NOT EXISTS job_price_sel text;
ALTER TABLE job_detail_linguistic
  ADD COLUMN IF NOT EXISTS job_price numeric(18,2);
ALTER TABLE job_detail_linguistic
  ADD COLUMN IF NOT EXISTS job_price_dis numeric(18,2);

ALTER TABLE po_detail_linguistic
  ADD COLUMN IF NOT EXISTS po_volume numeric(14,2);
ALTER TABLE po_detail_linguistic
  ADD COLUMN IF NOT EXISTS po_unit_code text REFERENCES sys_code (code) ON DELETE RESTRICT;
ALTER TABLE po_detail_linguistic
  ADD COLUMN IF NOT EXISTS po_price_sel text;
ALTER TABLE po_detail_linguistic
  ADD COLUMN IF NOT EXISTS po_price numeric(18,2);

-- The COMMENTs have to be re-stated, not inherited -- 002_tables.sql's
-- COMMENT ON COLUMN job.job_volume dies with the column in section 3. The
-- two "unconfirmed" warnings are carried across verbatim, because they are
-- the most valuable sentences in the original comments and the kind of
-- thing a move quietly loses.
COMMENT ON TABLE job_detail_linguistic IS
  'The language pair AND the per-word pricing of a LINGUISTICS job. One row per job at most, and '
  'ABSENT when the job has neither a language nor a volume set -- thousands of legacy jobs have no '
  'language, so a missing row here means "not filled in" and is not an error. Formerly '
  'job.job_slang / job_elang (moved by db/011_job_types.sql) and job.job_volume / unit_code / '
  'job_price_sel / job_price / job_price_dis (moved by db/012_job_pricing.sql). THE AMOUNT ITSELF '
  'IS NOT HERE -- coin_code, coin_rate, job_price_sum and job_price_ksum stay on job, because a KRW '
  'total means the same thing on every 업무 구분 and the reports sum it from there.';

COMMENT ON COLUMN job_detail_linguistic.job_volume IS
  'Billable volume in unit_code units (word count, page count, hours). Legacy nvarchar(20) -> '
  'numeric(14,2); fractional pages and hours occur. Was job.job_volume until '
  'db/012_job_pricing.sql. A MICE or IMC job has no volume at all -- it cannot have a row in this '
  'table, so the absence is a key constraint rather than a convention.';
COMMENT ON COLUMN job_detail_linguistic.unit_code IS
  'Billing unit: per source word, per page, per hour, flat fee, ... A sys_code child of the UNIT '
  'domain. Keeps its unprefixed name from job.unit_code so the ops layer reads the same alias.';
COMMENT ON COLUMN job_detail_linguistic.job_price_sel IS
  'Legacy JOB_PRICE_SEL, nvarchar(10). A selector controlling how the price was arrived at -- most '
  'plausibly "use the customer rate card" vs "manually overridden". INTENT NOT CONFIRMED; left as '
  'unconstrained text rather than converted to a boolean or an enum, since guessing wrong would '
  'misprice jobs.';
COMMENT ON COLUMN job_detail_linguistic.job_price IS
  'Unit price charged, in job.coin_code. Legacy nvarchar(50) -> numeric(18,2). The TOTAL it feeds '
  'is job.job_price_sum, which the console computes and stores -- the server never recomputes it '
  'from this column, because legacy data holds hand-adjusted totals that have already been '
  'invoiced.';
COMMENT ON COLUMN job_detail_linguistic.job_price_dis IS
  'Legacy JOB_PRICE_DIS. Discount applied. AMBIGUOUS whether this is a discount AMOUNT or a '
  'discount PERCENTAGE; typed as numeric(18,2) (amount) because it sat beside JOB_PRICE in the same '
  'nvarchar(50) form, but VERIFY before relying on it in any calculation. If it turns out to be a '
  'percentage, retype to numeric(6,3).';

COMMENT ON TABLE po_detail_linguistic IS
  'The language pair AND the per-word pricing of a LINGUISTICS purchase order. See '
  'job_detail_linguistic -- same rules, same split. Note that purchase_order keeps po_coin_code, '
  'po_coin_rate, po_price_sum and po_price_ksum, and also keeps the four po_cat_* CAT-tool '
  'analysis columns, which are not part of this derivation.';

COMMENT ON COLUMN po_detail_linguistic.po_volume IS
  'Volume purchased, in po_unit_code units. Legacy nvarchar(50) -> numeric(14,2). Was '
  'purchase_order.po_volume until db/012_job_pricing.sql.';
COMMENT ON COLUMN po_detail_linguistic.po_unit_code IS
  'Billing unit for po_volume. A sys_code child of the UNIT domain.';
COMMENT ON COLUMN po_detail_linguistic.po_price_sel IS
  'Legacy PO_PRICE_SEL, nvarchar(10). Selector for how the unit price was derived (translator rate '
  'card vs manual override). INTENT NOT CONFIRMED -- left as text; see '
  'job_detail_linguistic.job_price_sel.';
COMMENT ON COLUMN po_detail_linguistic.po_price IS
  'Unit price paid, in purchase_order.po_coin_code. Legacy nvarchar(100) -> numeric(18,2).';

-- And a pointer on each parent column that stayed, so the next person to
-- read `job` finds out where the other half went without grepping.
COMMENT ON COLUMN job.job_price_sum IS
  'Total revenue for this job in the ORIGINAL currency (coin_code). Legacy JOB_PRICE_SUM, '
  'nvarchar(200) -> numeric(18,2). STAYS ON THE PARENT for every 업무 구분: on a LINGUISTICS job '
  'the console derives it from job_detail_linguistic.job_volume x job_price less job_price_dis, '
  'and on a MICE or IMC job the user enters it directly, because that work is not billed per unit. '
  'The server stores what it is given either way -- db/012_job_pricing.sql.';

COMMENT ON COLUMN purchase_order.po_price_sum IS
  'Total cost of this PO in the ORIGINAL currency (po_coin_code). Legacy PO_PRICE_SUM, '
  'nvarchar(200) -> numeric(18,2). STAYS ON THE PARENT for every 업무 구분 -- see '
  'job.job_price_sum.';

-- ---------------------------------------------------------------------
-- 3d. Comments the later migrations added
-- ---------------------------------------------------------------------
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

COMMENT ON COLUMN purchase_order.po_state IS
  'Legacy PO_STATE. HOW FAR THE WORK HAS GOT, and nothing else: 미승인 -> 진행 -> 납품 -> 완료, plus 취소 off to one side. Whether the money was signed off is po_approved (015); whether it has been paid is po_money_state. 완료 MEANS PAID IN FULL -- a partly-paid PO stays at 납품 with po_money_state = ''부분정산'', so 부분정산 lives in one column rather than two that can disagree. 015 renamed 발주 -> 미승인 and folded 수락 into 진행. Still unconstrained text, no CHECK, no sys_code FK -- live data contains retired values; see project.prj_state. The vocabulary is NeotmsPoStates.ts on the server and PO_STATES in the console.';

-- 1. purchase_order -- the approval gate
-- ---------------------------------------------------------------------
-- NOT NULL DEFAULT false is rewrite-free on PG 11+ (the default is stored
-- in pg_attribute.attmissingval), so this does not take a long exclusive
-- lock on a table with a decade of POs in it.
--
-- The DEFAULT STAYS, permanently. The usual playbook drops it after the
-- backfill; here the external LKTMS ETL does not know this column exists,
-- and false is the right answer for anything it inserts -- an unapproved
-- PO is refused by the print screen, which is the safe direction to be
-- wrong in. Dropping the default would instead make every ETL insert fail.

COMMENT ON COLUMN purchase_order.po_approved IS
  'Has this PO been signed off for payment. NEW IN 015 -- no legacy counterpart; legacy expressed it as the 발주/수락 state difference, which conflated sign-off with progress. Independent of po_state on purpose: a PO can be approved before work starts and can be in progress without sign-off, and only an approved PO may be printed and sent (the console refuses, and the 결제 screen is the only place this column is writable). Gated on the PAYMENT menu, NOT on PURCHASE_ORDER -- issuing a PO and approving one are different authorities, which is the whole reason for the separate menu id.';
COMMENT ON COLUMN purchase_order.po_approved_at IS
  'When po_approved was last set true. Server-stamped with now(); never accepted from a client, for the reason po_state_dt is not either -- a client-supplied "when did this happen" is not an audit trail. NULL on every unapproved PO and on legacy rows approved by section 4 (nothing knows when those were signed off, and inventing a timestamp would be worse than admitting it).';
COMMENT ON COLUMN purchase_order.po_approved_by IS
  'Who approved it -- staff.mgr_id, matching the convention created_by uses across this schema rather than a staff FK, because it must survive the approver leaving. Reads ''backfill-015'' on rows approved by section 4, so "approved by somebody we cannot name" is distinguishable from "approved by a person" in one glance.';


-- ---------------------------------------------------------------------
-- 2. purchase_order -> invoice_translator, as a real foreign key
-- ---------------------------------------------------------------------
-- WHY A NEW COLUMN RATHER THAN AN FK ON inv_code
--   `inv_code` is text and deliberately unconstrained: its DDL comment
--   records that legacy rows reference invoices which were subsequently
--   deleted, so an FK on it would refuse to validate against the migrated
--   data. That reasoning still holds and the column is left alone.
--
--   But it cannot be what NEW invoices group by. The grouping decides
--   which POs appear on a printed document and therefore what the
--   document totals -- so a mistyped or orphaned code does not produce an
--   error, it produces an invoice that is quietly short by one PO, sent to
--   a translator who is then underpaid. That is the exact class of silent
--   arithmetic failure this schema's comments keep warning about.
--
--   So: an id column with a real FK for the grouping, and `inv_code` kept
--   beside it as the denormalised copy -- the same pattern as po_pm_id
--   with po_pm_name, and project_id with the job's project. The id is
--   authoritative; the code is what the ETL and any legacy report join by.
--
-- ON DELETE SET NULL, not RESTRICT and not CASCADE. An invoice is
-- soft-deleted in practice (invoice_translator.deleted), so this fires
-- only on a genuine hard delete -- and if one ever happens, the POs must
-- survive it. They carry the cost; the invoice is only a document about
-- them. CASCADE would delete booked cost to tidy up a piece of paper.

COMMENT ON COLUMN purchase_order.invoice_translator_id IS
  'The translator invoice this PO is billed on. NEW IN 015. AUTHORITATIVE for the grouping -- the printed invoice lists the POs that point here, so this column decides what the document totals. inv_code beside it is the denormalised copy kept for the ETL and legacy reports (see its own comment for why IT has no FK). NULL means not yet invoiced, which is every PO before 납품 and the normal state of most of the table.';


-- ---------------------------------------------------------------------
-- 3. invoice_translator -- the two columns it needs to be writable
-- ---------------------------------------------------------------------
-- Created by 002 as an ETL target and never written by this application
-- until now. Two gaps show up the moment it is:
--
--   updated_at -- every other table in this schema has it and every
--     manager's update path assigns it. Without it the UPDATE is a 42703.
--
--   inv_pm_id -- the invoice's signature block prints the issuing PM's
--     name, phone and email, and `pm_code`/`pm_name` are legacy text with
--     no FK, so there is nothing to join to reach the phone number. Added
--     alongside rather than replacing them, exactly as po_pm_id sits
--     beside po_pm_name: the id is authoritative, the text is the copy.
--     It is also what the invoice list scopes a PM's own book by.
--
-- RESTRICT on the staff FK, matching po_pm_id: a staff row carrying
-- invoices cannot be deleted. Staff are deactivated, never deleted (see
-- the no-DELETE note on the 사용자 관리 routes).

COMMENT ON COLUMN invoice_translator.updated_at IS
  'Last edit. NEW IN 015 -- 002 created this table as an ETL target, and an ETL only ever inserted. NULL on every migrated row and on any invoice never edited after issue.';
COMMENT ON COLUMN invoice_translator.inv_pm_id IS
  'The PM who issued this invoice -- staff.id. NEW IN 015. pm_code / pm_name are the legacy text pair and are maintained as copies; this is the one with a foreign key, and it is what the printed signature block joins to for the issuer''s phone and email, and what the invoice list''s row scope is resolved against.';

COMMENT ON TABLE invoice_translator IS
  'Translator invoice / payable. Legacy INVTB_TRAN, PK INV_TRAN_CODE. The cost-side counterpart of invoice_customer: GROUPS THE POs BEING SETTLED WITH ONE TRANSLATOR -- one invoice, several POs, which is what the printed LIST OF INVOICE form shows and why the invoice cannot be folded into purchase_order. Unlike the customer side, payment is tracked on this same row via the inv_mo_* columns rather than in a separate table.
WRITTEN BY THE APPLICATION SINCE 015 (the 결제 section), which added updated_at and inv_pm_id and made purchase_order.invoice_translator_id a real FK for the grouping. inv_sum / inv_tax hold WHAT WAS PRINTED on the document that was sent; purchase_order.po_money_state / po_money_day / po_money_price remain the single source of truth for what has actually been PAID. Nothing reads payment status off this table.
ETL NOTE: references to deleted translators must be reconciled before translator_id will validate.';


-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
--
-- 002_tables.sql states the opposite of the model above -- it had to, it
-- was written when the rate was always captured. Corrected in place, so
-- that whoever inspects the column descriptions in psql or in the Supabase
-- table editor is not told the old rule by the database itself.
--
-- The substance of the old comments survives, because it is still true for
-- a settled row: that is exactly what "frozen" means below.

COMMENT ON COLUMN job.coin_rate IS
  'The FX rate this job was EXCHANGED at, or NULL if it has not been exchanged. Read it as a settlement flag with a value attached. NULL + a non-KRW coin_code = an OPEN position, whose KRW figure the reports compute from fx_rate_latest when they run; NOT NULL = SETTLED, and job_price_ksum is then the frozen booked figure, which a report re-run years later must reproduce and does. Set to 1 by the console''s 원화로 환산 button, which simultaneously rewrites coin_code to KRW. See db/014_fx_rates.sql.';
COMMENT ON COLUMN job.job_price_ksum IS
  'Legacy JOB_PRICE_KSUM. "KSUM" = KRW-converted total, as opposed to job_price_sum, the original-currency total. AUTHORITATIVE FOR A SETTLED ROW (coin_code = KRW, or coin_rate IS NOT NULL) -- it may have been hand-adjusted after a negotiation and invoiced at that figure, so nothing recomputes it. For an OPEN row (non-KRW currency, coin_rate IS NULL) the reports IGNORE it in favour of job_price_sum x fx_rate_latest.rate, and it serves only as the fallback for a currency fx_rate has never carried a quote for. Margin is revenue minus the sum of the job''s POs'' KRW cost, derived per query and never stored. See db/014_fx_rates.sql.';

COMMENT ON COLUMN purchase_order.po_coin_rate IS
  'The FX rate this purchase order was EXCHANGED at, or NULL if it has not been exchanged. Identical semantics to job.coin_rate -- NULL on a non-KRW PO means an OPEN position converted at read time, NOT NULL means SETTLED and po_price_ksum is frozen. See db/014_fx_rates.sql.';
COMMENT ON COLUMN purchase_order.po_price_ksum IS
  'Legacy PO_PRICE_KSUM. "KSUM" = KRW-converted total (po_price_sum x po_coin_rate for a SETTLED PO). Authoritative while settled; ignored in favour of po_price_sum x fx_rate_latest.rate while the PO is OPEN, exactly as job.job_price_ksum is. Note that cost sits one level BELOW revenue -- a job has many POs -- so the reports sum it through a LATERAL subquery per job rather than a join, which would otherwise multiply the job''s revenue by its number of POs.';

COMMENT ON TABLE fx_rate IS
  'Dated FX rate table. NEW in NEOTMS; fixes the legacy defect of a single global rate with no effective date, which made every historical report irreproducible. One row per currency per business day. Populated by the scheduled rate-fetcher Lambda (lambdas/neotms/nodejs/fxrate.ts) from the Korea Export-Import Bank open API. This is now a LIVE INPUT to reporting, not merely a reference series -- see fx_rate_latest and db/014_fx_rates.sql.';
COMMENT ON COLUMN fx_rate.effective_date IS
  'Business date the rate applies to, in KST. The upstream publishes one table per business day, so weekends and holidays simply have no row and the newest row stays newest. For a SETTLED transaction the rate actually used is captured on the transaction itself (job.coin_rate, purchase_order.po_coin_rate) and this table is not consulted; for an OPEN one, fx_rate_latest IS the figure.';
COMMENT ON COLUMN fx_rate.source IS
  'Provenance of the quote. ''koreaexim'' for the scheduled fetcher, ''manual'' for an operator override. Free text on purpose. A manual row wins over an API row for the same day only by being inserted later with a later created_at -- fx_rate_latest orders by effective_date alone, so an override for a day that already has a quote must UPDATE it rather than insert a second one. uq_fx_rate_ccy_date enforces that.';

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


-- =====================================================================
-- 4. VALIDATIONS
-- =====================================================================
-- ---------------------------------------------------------------------
-- 4a. The purchase order's link to its translator invoice
-- ---------------------------------------------------------------------
--
-- ON DELETE SET NULL rather than RESTRICT: voiding an invoice has to release the POs
-- that were billed on it, not be refused by them.

ALTER TABLE purchase_order
  ADD CONSTRAINT purchase_order_invoice_translator_id_fkey
  FOREIGN KEY (invoice_translator_id)
  REFERENCES invoice_translator (id) ON DELETE SET NULL;

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
-- 5. FUNCTIONS
-- =====================================================================
-- later: `sys_menu` will grow. Today it has the six rows above; after the
-- ETL loads legacy SY_MENU it has 48. A superuser role whose grants were
-- written once as literal rows would silently have no rights on the 42
-- ---------------------------------------------------------------------
-- neotms_known_permissions()
-- ---------------------------------------------------------------------
-- The permission vocabulary, read back out of the CHECK that enforces it.
--
-- There are two copies of this list and there must not be a third: the
-- constant in NeotmsAuthorities.ts, which the application compares
-- against, and the CHECK on sys_role_permission, which the database
-- enforces. A test asserts those two are equal. Anything else in SQL that
-- needs the list asks this function, so a stale copy cannot develop where
-- nobody is watching -- and the copy that goes stale is always the one
-- that grants too little, which presents as a screen refusing somebody
-- who was given everything.
CREATE OR REPLACE FUNCTION neotms_known_permissions()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT m[1]
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([A-Z_]+)''', 'g') AS m
   WHERE c.conrelid = 'sys_role_permission'::regclass
     AND c.conname  = 'ck_sys_role_permission';
$fn$;

COMMENT ON FUNCTION neotms_known_permissions() IS
  'Every permission name the CHECK on sys_role_permission allows, one per row. The single SQL-side '
  'reading of the vocabulary; sys_role_grant_all_permissions() grants from it.';

-- new permissions, and "no rights" is the failure mode with no error
-- message -- the screens just refuse, with a message blaming the role.
--
-- So the grant is expressed as "every permission this build knows,
-- re-evaluated when asked", and the operating instruction is one line:
--
--   SELECT sys_role_grant_all_permissions('NEOTMS_SYSADMIN');
--
-- Run it after any change to the permission vocabulary. It is NOT a
-- trigger on anything: a trigger would widen an authorization set as a
-- side effect of some other write, and silently widening authorization is
-- the one behaviour this schema refuses to have.
--
-- The list it grants from is the CHECK on sys_role_permission, read out of
-- the catalogue rather than repeated here. Repeating it would be a third
-- copy of the vocabulary -- after NeotmsAuthorities.ts and the CHECK --
-- and the copy that goes stale is always the one that grants too little,
-- which presents as a screen refusing somebody who was given everything.
CREATE OR REPLACE FUNCTION sys_role_grant_all_permissions(p_role_code text)
RETURNS integer
LANGUAGE plpgsql
-- Pinned, like every function in db/: the pooler gives out whatever
-- session it has, and a function whose table references depend on the
-- caller's search_path is a function that resolves differently depending
-- on who called it.
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_role_id bigint;
  v_count   integer;
BEGIN
  SELECT id INTO v_role_id FROM sys_role WHERE role_code = p_role_code;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION
      'sys_role_grant_all_permissions: no sys_role row has role_code = %. '
      'Apply db/002_initial_seeding.sql, or check the spelling.', p_role_code;
  END IF;

  INSERT INTO sys_role_permission (role_id, permission, created_by)
  SELECT v_role_id, p.permission, 'neotms-bootstrap'
    FROM neotms_known_permissions() AS p(permission)
  ON CONFLICT (role_id, permission) DO NOTHING;

  SELECT count(*) INTO v_count
    FROM sys_role_permission
   WHERE role_id = v_role_id;

  RETURN v_count;
END;
$fn$;

COMMENT ON FUNCTION sys_role_grant_all_permissions(text) IS
  'Grants one role every permission this build knows. Idempotent; returns the number the role now '
  'holds. Re-run it after anything that adds to the permission vocabulary, because grants written '
  'once do not cover permissions added later and the resulting failure is a silent refusal rather '
  'than an error.';

-- Apply it now, to the six menus seeded above.



-- ---------------------------------------------------------------------
-- 4. staff_bootstrap_superuser() -- the way back in
-- ---------------------------------------------------------------------
-- Called by NeotmsAuthGuard when, and only when, an authenticated LPX
-- identity holds the bootstrap authority (`lpx.admin.access`, configured
-- as NEOTMS_BOOTSTRAP_AUTHORITY_ID) and has no usable staff row. It
-- returns `staff.id`; the guard then re-reads the row through the same
-- query every other sign-in uses, so there is exactly one mapping from
-- staff row to caller.
--
-- WHY A FUNCTION, AND NOT THREE STATEMENTS IN TYPESCRIPT
--   The pooler is in transaction mode. A function call is one statement
--   and therefore one transaction, atomic without the application having
--   to open one -- and `BEGIN`/`COMMIT` issued from the application is
--   precisely what transaction-mode pooling does not reliably give you.
--   The decision below reads an existing row, may adopt a legacy row, and
--   may insert and retry; as three application statements, two concurrent
--   first sign-ins could interleave into two staff rows for one person.
--
-- WHY IT RETURNS bigint AND NOT THE ROW
--   Tempting to wrap the call in a CTE and join `staff` in the same
--   statement. Don't: every part of a single statement reads from the
--   snapshot taken when the statement began, so the join would be looking
--   for a row this statement has not yet made visible to it. The guard
--   does a second, ordinary SELECT instead.
--
-- THE CONSEQUENCE, STATED PLAINLY
--   A holder of lpx.admin.access cannot be locked out of NEOTMS FROM
--   INSIDE NEOTMS. Deactivating their staff row does not stop them: the
--   next sign-in reactivates it. That is deliberate -- it is what makes
--   this a reliable way back in -- but it means the real revocation is
--   removing the authority on LPX, not editing a row here. Section 5
--   below is how you check who has been let in this way.
--
-- WHICH BRANCHES THE APPLICATION STILL REACHES
--   Only (a). The guard calls this for a row that EXISTS and cannot be
--   used -- inactive, or no role -- because an identity with NO row is now
--   offered the sign-up form instead and approved there, through
--   staff_self_register_bootstrap() in section 2 of the next block. So (b)
--   adopt-by-email and (c) mint are reachable only BY HAND, from psql,
--   which is also what makes this function the documented manual way in
--   when the console cannot be loaded at all. Do not delete them on the
--   grounds that nothing calls them.
CREATE OR REPLACE FUNCTION staff_bootstrap_superuser(
  p_lpx_sub text,
  p_email   text,
  p_name    text
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  /*
   * Every local is `v_`-prefixed and every parameter `p_`-prefixed, and
   * that is not decoration. In PL/pgSQL a variable whose name matches a
   * column of a table the statement touches raises `column reference
   * "..." is ambiguous` -- at CALL time, not at CREATE time, so a plain
   * `lpx_sub` here would compile cleanly and then fail on the first real
   * sign-in. The prefixes make the collision impossible by construction.
   */
  v_role_id    bigint;
  v_staff_id   bigint;
  v_base       text;
  v_mgr_id     text;
  v_attempt    integer;
  v_constraint text;
BEGIN
  IF p_lpx_sub IS NULL OR btrim(p_lpx_sub) = '' THEN
    RAISE EXCEPTION 'staff_bootstrap_superuser: p_lpx_sub must not be blank';
  END IF;

  SELECT id INTO v_role_id FROM sys_role WHERE role_code = 'NEOTMS_SYSADMIN';
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION
      'staff_bootstrap_superuser: the NEOTMS_SYSADMIN role is missing. '
      'Apply db/006_bootstrap.sql in full -- this function is useless without it.';
  END IF;

  /* ------------------------------------------------------------------ *
   * (a) This identity already has a row. Repair it; never downgrade it.
   *
   *     Reached when the row exists but the guard could not use it --
   *     `active = false`, `deleted = true`, or `role_id IS NULL`. Each is
   *     a hard lockout with no screen to fix it from.
   *
   *     COALESCE everywhere, so this REPAIRS and never OVERRIDES. A
   *     deliberately narrow role, or a view_scope of 'N', is a
   *     configuration decision and is left exactly as it was found;
   *     only a blank is filled in. An admin who assigned themselves the
   *     PM role keeps it -- what they get back is the ability to sign
   *     in, which is all that was missing.
   * ------------------------------------------------------------------ */
  SELECT id INTO v_staff_id FROM staff WHERE lpx_sub = p_lpx_sub;
  IF v_staff_id IS NOT NULL THEN
    UPDATE staff
       SET active     = true,
           deleted    = false,
           role_id    = COALESCE(role_id, v_role_id),
           view_scope = COALESCE(NULLIF(btrim(view_scope), ''), 'Y'),
           mgr_name   = COALESCE(NULLIF(btrim(mgr_name), ''),  NULLIF(btrim(p_name), '')),
           mgr_email  = COALESCE(NULLIF(btrim(mgr_email), ''), NULLIF(btrim(p_email), '')),
           updated_at = now()
     WHERE id = v_staff_id;
    RETURN v_staff_id;
  END IF;

  /* ------------------------------------------------------------------ *
   * (b) An unclaimed legacy row with the same email. Adopt it.
   *
   *     The guard's own just-in-time linking (StaffUnclaimedByEmailOps)
   *     already handles the normal case, but it requires `active = true`.
   *     This covers the leftover: an unclaimed row that the ETL loaded
   *     inactive. Adopting it rather than minting a second row matters
   *     because `mgr_id` is what every legacy REG_ID column references --
   *     a duplicate row means one person with two identities and a
   *     project history split between them.
   *
   *     `deleted = false` is required here even though branch (a)
   *     un-deletes. The difference: in (a) the row is provably this
   *     identity's, because it carries their `sub`. Here the only
   *     evidence is a matching email, and reviving a soft-deleted staff
   *     record on that evidence is a step too far -- those rows fall
   *     through to (c) and get a fresh identity instead.
   *
   *     `ORDER BY id` because legacy mgr_email is not unique; oldest
   *     wins, deterministically. FOR UPDATE, and the UPDATE repeats the
   *     `lpx_sub IS NULL` test, so two concurrent sign-ins cannot both
   *     adopt the same row.
   * ------------------------------------------------------------------ */
  IF NULLIF(btrim(COALESCE(p_email, '')), '') IS NOT NULL THEN
    SELECT id INTO v_staff_id
      FROM staff
     WHERE lpx_sub IS NULL
       AND deleted = false
       AND lower(btrim(mgr_email)) = lower(btrim(p_email))
     ORDER BY id
     LIMIT 1
       FOR UPDATE;

    IF v_staff_id IS NOT NULL THEN
      UPDATE staff
         SET lpx_sub    = p_lpx_sub,
             active     = true,
             role_id    = COALESCE(role_id, v_role_id),
             view_scope = COALESCE(NULLIF(btrim(view_scope), ''), 'Y'),
             mgr_name   = COALESCE(NULLIF(btrim(mgr_name), ''), NULLIF(btrim(p_name), '')),
             updated_at = now()
       WHERE id = v_staff_id
         AND lpx_sub IS NULL;
      IF FOUND THEN
        RETURN v_staff_id;
      END IF;
      v_staff_id := NULL;
    END IF;
  END IF;

  /* ------------------------------------------------------------------ *
   * (c) Mint a new staff row.
   *
   *     `mgr_id` is `text NOT NULL UNIQUE` and is the human-readable key
   *     that ends up in `created_by` on every record this person touches,
   *     so it wants to be recognisable rather than a UUID. The email
   *     local part, stripped to the characters a legacy id can hold, is
   *     the best available answer; a Korean-only or missing email leaves
   *     nothing after the strip, hence the 'admin' floor.
   * ------------------------------------------------------------------ */
  v_base := lower(
    regexp_replace(split_part(COALESCE(NULLIF(btrim(p_email), ''), 'admin'), '@', 1),
                   '[^A-Za-z0-9._-]', '', 'g')
  );
  v_base := left(COALESCE(NULLIF(v_base, ''), 'admin'), 40);

  /*
   * Collision handling. The EXISTS-then-INSERT shape would race; this
   * one lets the UNIQUE constraint decide and reacts to which constraint
   * fired, inside a BEGIN..EXCEPTION block (a subtransaction, so a
   * failed attempt rolls back without losing the whole call).
   */
  FOR v_attempt IN 1..10 LOOP
    v_mgr_id := CASE WHEN v_attempt = 1 THEN v_base ELSE v_base || v_attempt::text END;
    BEGIN
      INSERT INTO staff (mgr_id, lpx_sub, mgr_name, mgr_email,
                         role_id, view_scope, active, deleted, created_by)
      VALUES (v_mgr_id,
              p_lpx_sub,
              NULLIF(btrim(COALESCE(p_name, '')), ''),
              NULLIF(btrim(COALESCE(p_email, '')), ''),
              v_role_id,
              -- 'Y' is the value VIEW_SCOPE_ALL recognises as "sees every
              -- row". Anything unrecognised means "own rows only", so a
              -- superuser with a blank view_scope would be able to open
              -- every screen and see nothing on any of them.
              'Y',
              true,
              false,
              -- The audit marker. `created_by` is plain text (historical
              -- rows reference mgr_ids that no longer exist), which makes
              -- it a usable tag: see the review query in section 5.
              'lpx-bootstrap')
      RETURNING id INTO v_staff_id;

      RETURN v_staff_id;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

      /*
       * `staff_lpx_sub_key` is PostgreSQL's generated name for the UNIQUE
       * on staff.lpx_sub (<table>_<column>_key). Hitting it means a
       * concurrent sign-in by this same person -- a double-clicked login,
       * or two tabs -- got there first, so their row is the answer.
       */
      IF v_constraint = 'staff_lpx_sub_key' THEN
        SELECT id INTO v_staff_id FROM staff WHERE lpx_sub = p_lpx_sub;
        IF v_staff_id IS NOT NULL THEN
          RETURN v_staff_id;
        END IF;
        -- The winner has not committed yet, so its row is not visible to
        -- this transaction and there is nothing honest to return. Re-raise
        -- and let the caller retry; the guard reports it as a 503.
        RAISE;
      END IF;

      -- Otherwise it was `staff_mgr_id_key`: the readable id is taken by
      -- a different person. Next suffix.
    END;
  END LOOP;

  RAISE EXCEPTION
    'staff_bootstrap_superuser: could not allocate a free mgr_id from the base "%" '
    'in 10 attempts. Create the staff row by hand and set its lpx_sub to %.',
    v_base, p_lpx_sub;
END;
$fn$;

COMMENT ON FUNCTION staff_bootstrap_superuser(text, text, text) IS
  'Ensures one OIDC identity has a usable NEOTMS staff row holding the NEOTMS_SYSADMIN '
  '(시스템관리자) role, and returns staff.id. Called by NeotmsAuthGuard ONLY for an identity that '
  'holds the LPX bootstrap authority (lpx.admin.access) and has no usable staff row. Atomic and '
  'idempotent. Repairs rather than overrides: an existing explicit role or view_scope is left '
  'alone, only blanks and the active/deleted flags are corrected. CONSEQUENCE: a holder of that '
  'authority cannot be locked out from inside NEOTMS -- revoke the authority on LPX instead.';

COMMENT ON COLUMN staff.created_by IS
  'Legacy REG_ID -- the mgr_id of whoever created the row. Plain text, not an FK, because '
  'historical rows reference mgr_ids that no longer exist. The value ''lpx-bootstrap'' is reserved: '
  'it marks a row MINTED by staff_bootstrap_superuser() for a holder of LPX''s lpx.admin.access '
  'authority, i.e. an account that let itself in. Note it does NOT mark a row that function ADOPTED '
  '-- an adopted legacy row keeps the ETL''s provenance, which is the more useful fact about it. '
  'Review both; see section 5 of db/006_bootstrap.sql.';


-- ---------------------------------------------------------------------
-- 1. staff_self_register() -- a new employee puts themselves in the queue
-- ---------------------------------------------------------------------
-- Called by POST /api/v0/registration for a verified LPX account that
-- holds the NEOTMS app authority and has NO staff row. Returns staff.id;
-- the application then re-reads the row through the same query every
-- sign-in uses, so there is one mapping from staff row to caller.
--
-- WHY A FUNCTION, AND NOT AN INSERT IN TYPESCRIPT
--   The same three reasons as staff_bootstrap_superuser (006 section 4),
--   and the first is the one that bites:
--
--     1. The pooler is in transaction mode, so one statement is the only
--        unit that is reliably atomic. The mgr_id collision loop below is
--        a write-then-react sequence; as application statements it would
--        be spread across backends, and a double-clicked sign-up button
--        could produce two staff rows for one person -- which splits their
--        project history, because `mgr_id` is what every legacy REG_ID
--        points at.
--     2. The `unique_violation` handler needs a subtransaction. There is
--        no equivalent in the application.
--     3. `role_id`, `view_scope` and `active` are the three values this
--        codebase refuses to let a caller influence. This is the ONE write
--        path in the system that an unapproved account can reach, so the
--        decision belongs in the same place as the constraints that bound
--        it -- not in a parameter list where a future refactor could widen
--        it by adding an argument.
--
-- WHAT THE CALLER MAY SAY ABOUT THEMSELVES
--   The five `p_name..p_position` parameters, and nothing else. They are
--   prefilled in the form from LPX's /userInfo and all five are editable,
--   including the name: `mgr_name` is what gets printed on a purchase
--   order, and the name on an SSO account is not always the name a person
--   works under. See SelfProfileSchema in neotms.schemas.ts.
--
--   What the caller CANNOT say: role_id, view_scope, active, mgr_id,
--   corp_code, lpx_sub. The first three are the permission system and are
--   literals below; the last three are identity -- `lpx_sub` comes from a
--   verified token, `mgr_id` is minted here, and `corp_code` is left NULL
--   for an administrator to set, because which group entity employs
--   somebody is not a self-reported fact.
CREATE OR REPLACE FUNCTION staff_self_register(
  p_lpx_sub  text,
  p_name     text,
  p_name_eng text,
  p_email    text,
  p_phone    text,
  p_position text,
  p_ip       text
)
RETURNS bigint
LANGUAGE plpgsql
-- Pinned, like every function in db/: the pooler gives out whatever
-- session it has, and a function whose table references depend on the
-- caller's search_path is a function that resolves differently depending
-- on who called it.
SET search_path = public, pg_temp
AS $fn$
DECLARE
  /*
   * `p_`/`v_` prefixes throughout, and not for tidiness. In PL/pgSQL a
   * variable whose name matches a column of a table the statement touches
   * raises `column reference "..." is ambiguous` -- at CALL time, not at
   * CREATE time. A plain `lpx_sub` here would compile cleanly and then
   * fail on the first real sign-up.
   */
  v_staff_id   bigint;
  v_base       text;
  v_mgr_id     text;
  v_ip         inet;
  v_attempt    integer;
  v_constraint text;
BEGIN
  IF p_lpx_sub IS NULL OR btrim(p_lpx_sub) = '' THEN
    RAISE EXCEPTION 'staff_self_register: p_lpx_sub must not be blank';
  END IF;

  IF NULLIF(btrim(COALESCE(p_name, '')), '') IS NULL THEN
    -- The schema allows a NULL mgr_name (the ETL loads some), but a row
    -- created here must have one: it is the 담당자 printed on every
    -- document this person will issue, and nobody will ever go back and
    -- fill it in. SelfProfileSchema requires it too; this is the backstop.
    RAISE EXCEPTION 'staff_self_register: p_name must not be blank';
  END IF;

  /* ------------------------------------------------------------------ *
   * (a) This identity already has a row. Return it, change nothing.
   *
   *     The application checks for this first and answers 409, so
   *     reaching here means a RACE -- a double-clicked button, or two
   *     tabs submitting the form at once. Returning the existing id makes
   *     the loser of that race indistinguishable from the winner, which
   *     is the right outcome for a button somebody pressed twice.
   *
   *     Deliberately not an UPDATE. A second sign-up must not be able to
   *     rewrite the name on a row an administrator may already have
   *     approved -- that would be a self-service edit of an approved
   *     record arriving through the one endpoint unapproved accounts can
   *     reach. Correcting your own details later is a different feature
   *     with a different route.
   * ------------------------------------------------------------------ */
  SELECT id INTO v_staff_id FROM staff WHERE lpx_sub = p_lpx_sub;
  IF v_staff_id IS NOT NULL THEN
    RETURN v_staff_id;
  END IF;

  /* ------------------------------------------------------------------ *
   * (b) THERE IS NO ADOPT-BY-EMAIL BRANCH, and that is the single most
   *     important difference between this function and
   *     staff_bootstrap_superuser.
   *
   *     The bootstrap has one (006 section 4b): it finds an unclaimed
   *     legacy row with a matching email and takes it over. Doing the same
   *     here would be a privilege escalation anybody could perform, and
   *     the reason is that by the time this function runs, THE EMAIL MATCH
   *     HAS ALREADY BEEN TRIED AND LOST.
   *
   *     NeotmsAuthGuard's just-in-time linking (StaffUnclaimedByEmailOps)
   *     runs on every sign-in and adopts an unclaimed row whose email
   *     matches, provided it is `active` and not `deleted`. The
   *     application only calls this function when that lookup came back
   *     empty. So the unclaimed rows still matching this email are exactly
   *     the ones the guard refused to link:
   *
   *       * `active = false` -- a departed or suspended employee. Adopting
   *         it would hand back access an administrator removed, and the
   *         new person would inherit that row's `role_id`, which may be a
   *         director's. Sign up with an address matching a former
   *         manager's record and you are that manager.
   *       * `deleted = true`  -- same, with less evidence.
   *
   *     An email is also not proof of identity here. LPX accounts and
   *     legacy SY_MGR rows were populated independently, addresses get
   *     reused when people leave, and nobody reviews this: the whole point
   *     of the endpoint is that it runs with no administrator present.
   *
   *     The cost of not adopting is a duplicate row for a returning
   *     employee whose old record was deactivated, which an administrator
   *     resolves by hand with the history in front of them. That is the
   *     cheaper mistake by a wide margin.
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * (c) The client address, defensively.
   *
   *     `created_ip` is inet and the value arrives from
   *     `x-forwarded-for`, which is client-controlled. clientInet() in
   *     NeotmsWrite.ts already shape-checks it, but the check is a
   *     character-class test: "1.2.3.4.5" passes it and inet rejects it.
   *     Everywhere else in the application a bad cast loses one save.
   *     Here it would lose the registration -- permanently, for anybody
   *     behind whatever proxy produced the value, with the screen saying
   *     only that it could not be saved. So the cast gets its own
   *     subtransaction and a bad address becomes NULL.
   * ------------------------------------------------------------------ */
  BEGIN
    v_ip := NULLIF(btrim(COALESCE(p_ip, '')), '')::inet;
  EXCEPTION WHEN invalid_text_representation THEN
    v_ip := NULL;
  END;

  /* ------------------------------------------------------------------ *
   * (d) Mint the row.
   *
   *     `mgr_id` is `text NOT NULL UNIQUE` and is the human-readable key
   *     that ends up in `created_by` on every record this person touches,
   *     so it wants to be recognisable rather than a UUID. The email local
   *     part, stripped to the characters a legacy id can hold, is the best
   *     available answer; a Korean-only or missing email leaves nothing
   *     after the strip, hence the 'user' floor.
   * ------------------------------------------------------------------ */
  v_base := lower(
    regexp_replace(split_part(COALESCE(NULLIF(btrim(p_email), ''), 'user'), '@', 1),
                   '[^A-Za-z0-9._-]', '', 'g')
  );
  v_base := left(COALESCE(NULLIF(v_base, ''), 'user'), 40);

  /*
   * Collision handling. The EXISTS-then-INSERT shape would race; this one
   * lets the UNIQUE constraint decide and reacts to which constraint
   * fired, inside a BEGIN..EXCEPTION block (a subtransaction, so a failed
   * attempt rolls back without losing the whole call).
   */
  FOR v_attempt IN 1..10 LOOP
    v_mgr_id := CASE WHEN v_attempt = 1 THEN v_base ELSE v_base || v_attempt::text END;
    BEGIN
      INSERT INTO staff (mgr_id, lpx_sub,
                         mgr_name, mgr_name_eng, mgr_email, mgr_phone, mgr_position,
                         role_id, view_scope, active, deleted, created_by, created_ip)
      VALUES (v_mgr_id,
              p_lpx_sub,
              btrim(p_name),
              NULLIF(btrim(COALESCE(p_name_eng, '')), ''),
              NULLIF(btrim(COALESCE(p_email, '')),    ''),
              NULLIF(btrim(COALESCE(p_phone, '')),    ''),
              NULLIF(btrim(COALESCE(p_position, '')), ''),
              -- THE THREE SECURITY COLUMNS, as literals.
              --
              -- NULL role_id is what makes this a request rather than an
              -- account: RoleMenuPermissionsOps is not even called for a
              -- NULL role, the permission matrix is empty, and every
              -- menu-gated route refuses. GET /api/v0/me reports it as
              -- `registration: "pending"` and the SPA shows the waiting
              -- notice.
              NULL,
              -- 'N' and not NULL. Both mean "own rows only" to the server
              -- (anything outside VIEW_SCOPE_ALL does), so this is not a
              -- security difference -- it is so the 사용자 관리 radio shows
              -- a DECIDED value. A NULL there renders as "본인 담당분만"
              -- indistinguishably from a deliberate 'N', and the admin
              -- cannot tell whether anyone has thought about it.
              'N',
              -- Active, and this one is easy to get wrong in the safe-
              -- looking direction. `false` would make whyUnusable() return
              -- "inactive", which is a 403 -- so the person who just
              -- submitted the form would be told their account has been
              -- DEACTIVATED, having never had one. Approval is withheld by
              -- the NULL role above; `active` is not the gate.
              true,
              false,
              -- The audit marker, matching 'lpx-bootstrap' in 006. This
              -- one means "nobody in NEOTMS approved this row's creation",
              -- which is true of every row it marks and is the thing worth
              -- being able to query. `created_by` is plain text, not an FK
              -- (historical rows reference mgr_ids that no longer exist),
              -- which is what makes it usable as a tag.
              'self-registration',
              v_ip)
      RETURNING id INTO v_staff_id;

      RETURN v_staff_id;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

      /*
       * `staff_lpx_sub_key` is PostgreSQL's generated name for the UNIQUE
       * on staff.lpx_sub (<table>_<column>_key). Hitting it means a
       * concurrent sign-up by this same person got there first, so their
       * row is the answer -- the same race branch (a) covers when the
       * winner has already committed.
       */
      IF v_constraint = 'staff_lpx_sub_key' THEN
        SELECT id INTO v_staff_id FROM staff WHERE lpx_sub = p_lpx_sub;
        IF v_staff_id IS NOT NULL THEN
          RETURN v_staff_id;
        END IF;
        -- The winner has not committed yet, so its row is not visible to
        -- this transaction and there is nothing honest to return. Re-raise
        -- and let the caller retry.
        RAISE;
      END IF;

      -- Otherwise it was `staff_mgr_id_key`: the readable id is taken by a
      -- different person. Next suffix.
    END;
  END LOOP;

  RAISE EXCEPTION
    'staff_self_register: could not allocate a free mgr_id from the base "%" in 10 attempts. '
    'Create the staff row by hand and set its lpx_sub to %.',
    v_base, p_lpx_sub;
END;
$fn$;

COMMENT ON FUNCTION staff_self_register(text, text, text, text, text, text, text) IS
  'Creates a NEOTMS staff row for one verified OIDC identity that has none, and returns staff.id. '
  'Called by POST /api/v0/registration -- one of two routes that run without a staff row. ALWAYS '
  'writes role_id = NULL, view_scope = ''N'', active = true: what it creates is an APPROVAL REQUEST, '
  'and a role is assigned afterwards by an administrator on the 사용자 관리 screen. Atomic. Called '
  'twice for the same subject it returns the same id and changes nothing. Unlike '
  'staff_bootstrap_superuser() it NEVER adopts an unclaimed legacy row by email: the guard''s '
  'just-in-time linking has already tried that and lost, so the only rows left matching are '
  'inactive or deleted ones, and adopting those would inherit a departed employee''s role and '
  'history. See section 1(b) of db/009_selfservice.sql.';

-- A restatement, not an addition. `COMMENT ON` takes a literal and
-- overwrites -- there is no append form -- so recording the second
-- reserved `created_by` value means repeating 006's sentence about the
-- first. CONSEQUENCE: applying 006 again after this file silently drops
-- the self-registration half. That is recovered the way everything else in
-- db/ is, by running this file again; it is also why 009 is the last file
-- in the numbering and not an edit to 006.
COMMENT ON COLUMN staff.created_by IS
  'Legacy REG_ID -- the mgr_id of whoever created the row. Plain text, not an FK, because '
  'historical rows reference mgr_ids that no longer exist. Two values are reserved, and both mark a '
  'row created with NO NEOTMS ADMINISTRATOR INVOLVED: ''lpx-bootstrap'' for a row MINTED by '
  'staff_bootstrap_superuser() for a holder of LPX''s lpx.admin.access authority (db/006_bootstrap.'
  'sql), and ''self-registration'' for a row created by staff_self_register() (db/009_selfservice.'
  'sql). The two are not equivalent risks: the first arrives holding the superuser role, the second '
  'arrives with role_id = NULL and can do nothing until somebody approves it. Note ''lpx-bootstrap'' '
  'does NOT mark a row that function ADOPTED -- an adopted legacy row keeps the ETL''s provenance, '
  'which is the more useful fact about it. Review both; see section 5 of db/006_bootstrap.sql and '
  'section 2 of db/009_selfservice.sql.';


-- ---------------------------------------------------------------------
-- 2. staff_self_register_bootstrap() -- an LPX admin signs up, and is
--    approved on the spot
-- ---------------------------------------------------------------------
-- Called by POST /api/v0/registration INSTEAD of staff_self_register()
-- when, and only when, the verified LPX account holds the bootstrap
-- authority (`lpx.admin.access`, NEOTMS_BOOTSTRAP_AUTHORITY_ID). Returns
-- staff.id, like its sibling.
--
-- WHY A SECOND FUNCTION AND NOT A FLAG ON THE FIRST
--   The obvious shape is `staff_self_register(..., p_bootstrap boolean)`.
--   It is refused here, and the reason is written down in section 1 and
--   pinned by a test: staff_self_register() is THE ONE WRITE PATH AN
--   UNAPPROVED ACCOUNT CAN REACH, and the three columns that decide what
--   a row may do -- role_id, view_scope, active -- are literals in its
--   body precisely so that no argument can influence them. A boolean that
--   selects between two sets of literals is still an argument that
--   selects a permission level, and the next person to widen it would
--   have a precedent rather than a prohibition to argue with.
--
--   So the two paths are two functions, each with its own literals, and
--   the choice between them is made in TypeScript from a verified
--   authority list that SQL cannot see.
--
-- WHY IT WRAPS RATHER THAN COPIES
--   Everything hard about minting a staff row -- the mgr_id collision
--   loop, the unique_violation handler, the double-submit race -- lives
--   in staff_self_register(). Copying it would make a third copy (the
--   second is in staff_bootstrap_superuser) of logic whose bugs are
--   invisible until two people sign up in the same second. This calls it
--   and then finishes the row, all inside one function, therefore one
--   statement, therefore one transaction under the pooler.
--
-- WHAT "APPROVED ON THE SPOT" MEANS, EXACTLY
--   role_id = the NEOTMS_SYSADMIN role, view_scope = 'Y'. The same two
--   values staff_bootstrap_superuser() hands out, for the same reason: a
--   superuser whose view_scope is not 'Y' can open every screen and see
--   nothing on any of them.
--
--   It does NOT write staff_attribute. The superuser OVERRIDE already
--   follows the authority at request time -- see `isSuperuser` in
--   NeotmsAuthGuard -- so storing it here would outlive the authority and
--   turn "revoke it on LPX" into a revocation that no longer revokes.
--
-- THE CONSEQUENCE, STATED PLAINLY
--   An account that holds lpx.admin.access can give itself a NEOTMS
--   administrator account by filling in a form. That is not new -- such a
--   holder can already grant themselves the NEOTMS app authority on LPX,
--   and staff_bootstrap_superuser() has let them in silently since day
--   one. What changes is that it now leaves a form submission and the row
--   below, instead of happening invisibly at sign-in.
CREATE OR REPLACE FUNCTION staff_self_register_bootstrap(
  p_lpx_sub  text,
  p_name     text,
  p_name_eng text,
  p_email    text,
  p_phone    text,
  p_position text,
  p_ip       text
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  /* `p_`/`v_` prefixes, for the reason section 1 gives -- a local named
   * like a column raises "column reference is ambiguous" at CALL time,
   * not at CREATE time. */
  v_role_id  bigint;
  v_existing bigint;
  v_staff_id bigint;
BEGIN
  SELECT id INTO v_role_id FROM sys_role WHERE role_code = 'NEOTMS_SYSADMIN';
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION
      'staff_self_register_bootstrap: the NEOTMS_SYSADMIN role is missing. '
      'Apply db/002_initial_seeding.sql -- an administrator cannot be '
      'approved into a role that does not exist.';
  END IF;

  /* ------------------------------------------------------------------ *
   * Was there a row before this call? The question has to be asked HERE,
   * because the next line creates one.
   *
   * It decides between finishing a row this call made -- which is ours to
   * set, nobody has configured it -- and repairing one that already
   * existed, where an explicit role or view_scope is somebody's decision
   * and must not be overwritten by a sign-up form.
   * ------------------------------------------------------------------ */
  SELECT id INTO v_existing FROM staff WHERE lpx_sub = p_lpx_sub;

  v_staff_id := staff_self_register(
                  p_lpx_sub, p_name, p_name_eng, p_email, p_phone, p_position, p_ip);

  IF v_existing IS NULL THEN
    /* The row was minted a line ago with role_id NULL and view_scope 'N'
     * -- an approval request. Finish it as an administrator's account.
     *
     * created_by gets its own marker rather than reusing 'lpx-bootstrap'.
     * Both mean "this account let itself in", but they are different
     * events: 'lpx-bootstrap' is a row minted SILENTLY at sign-in, this
     * one is a form somebody filled in. An auditor reading the column
     * should be able to tell which, because only one of them has a name,
     * a phone number and a position that a person typed. */
    UPDATE staff
       SET role_id    = v_role_id,
           view_scope = 'Y',
           created_by = 'lpx-bootstrap-signup',
           updated_at = now()
     WHERE id = v_staff_id;
  ELSE
    /* A row already existed, so this is a RACE or a stale tab -- the
     * application answers 409 before calling anything when it can see the
     * row, and the console never shows the form to an identity that has
     * one. Repair it the way the sign-in path would, which COALESCEs and
     * therefore never overrides a deliberate role or scope. */
    PERFORM staff_bootstrap_superuser(p_lpx_sub, p_email, p_name);
  END IF;

  RETURN v_staff_id;
END;
$fn$;

COMMENT ON FUNCTION staff_self_register_bootstrap(text, text, text, text, text, text, text) IS
  'Creates a NEOTMS staff row for one verified OIDC identity that has none, ALREADY APPROVED -- '
  'role_id = NEOTMS_SYSADMIN, view_scope = ''Y'' -- and returns staff.id. Called by '
  'POST /api/v0/registration only for an account holding the LPX bootstrap authority '
  '(lpx.admin.access), which the application establishes from a verified authority list; SQL '
  'cannot see it. Wraps staff_self_register() rather than copying its mgr_id minting, and finishes '
  'only a row this call created -- a pre-existing row is repaired through '
  'staff_bootstrap_superuser(), which never overrides a deliberate role or view_scope. Does not '
  'write staff_attribute: the superuser override follows the LPX authority at request time, so '
  'storing it would survive revoking the authority.';

-- A restatement, not an addition -- `COMMENT ON` takes a literal and
-- overwrites. The third reserved value is the one this section adds.
COMMENT ON COLUMN staff.created_by IS
  'Legacy REG_ID -- the mgr_id of whoever created the row. Plain text, not an FK, because '
  'historical rows reference mgr_ids that no longer exist. THREE values are reserved, and all '
  'three mark a row created with NO NEOTMS ADMINISTRATOR INVOLVED. ''lpx-bootstrap'': MINTED at '
  'sign-in by staff_bootstrap_superuser() for a holder of LPX''s lpx.admin.access authority, '
  'silently, holding the superuser role. ''lpx-bootstrap-signup'': the same authority, but through '
  'the sign-up form -- staff_self_register_bootstrap() -- so the row carries a name, a phone '
  'number and a position somebody typed, and is likewise approved on arrival. '
  '''self-registration'': staff_self_register(), which arrives with role_id = NULL and can do '
  'nothing until somebody approves it -- the only one of the three that is not immediate access. '
  'Note ''lpx-bootstrap'' does NOT mark a row that function ADOPTED: an adopted legacy row keeps '
  'the ETL''s provenance, which is the more useful fact about it. Review all three.';


-- =====================================================================
-- 6. VIEWS
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. fx_rate_latest -- the most recent quote per currency
-- ---------------------------------------------------------------------
--
-- One row per currency, newest effective_date wins. DISTINCT ON rather
-- than a window function or a correlated MAX because it is the form that
-- walks ix_fx_rate_lookup -- (currency_code, effective_date DESC) -- and
-- stops at the first row of each group.
--
-- A VIEW rather than a SQL fragment repeated in three dbops modules. The
-- three callers (report, dashboard, project rollup) have to agree on what
-- "the current rate" means or they report different revenue for the same
-- job, and the way to make them agree is to give them one name to join
-- rather than one expression to copy.
--
-- DELIBERATELY NOT CAPPED BY AGE. A quote from last Friday is the correct
-- answer on a Monday morning -- the upstream publishes once per business
-- day -- and a quote from a month ago, left behind by a fetcher that has
-- been failing unnoticed, is still a better answer than NULL. Staleness is
-- handled by SHOWING it instead: effective_date is in the view, the API
-- hands it to the console, and the console prints it next to the converted
-- amount. See the staleness query at the foot of this file.
--
-- KRW is not expected here and is not needed. Nothing quotes KRW against
-- itself, and every consumer special-cases coin_code = 'KRW' before it
-- looks at a rate at all.
CREATE OR REPLACE VIEW fx_rate_latest AS
SELECT DISTINCT ON (currency_code)
       currency_code,
       rate,
       effective_date,
       source,
       created_at
  FROM fx_rate
 ORDER BY currency_code, effective_date DESC;

COMMENT ON VIEW fx_rate_latest IS
  'The most recent fx_rate row per currency -- "today''s rate", as the reports mean it. Joined by NeotmsReport/NeotmsDashboard/NeotmsProject dbops to convert OPEN (unexchanged) foreign-currency amounts to KRW at read time. Not capped by age on purpose: the upstream quotes once per business day, so the newest row is the right answer even when it is a few days old, and a stale rate beats no rate. Staleness is surfaced through effective_date rather than hidden by filtering.';


-- ---------------------------------------------------------------------
-- 2. Backfill -- pin the rate on legacy rows that already have a KRW
--    figure
-- ---------------------------------------------------------------------
--
-- The invariant this file wants to be able to state without qualification
-- is: A ROW THAT ALREADY HAS A BOOKED KRW FIGURE NEVER FLOATS.
--
-- Rows entered through this console satisfy it already -- the form always
-- wrote a rate. The legacy data may not: a nvarchar COIN_RATE that held
-- '' or '-' arrives as NULL, and such a row would start floating the
-- moment section 1's view goes live, silently restating a figure that has
-- already been invoiced.
--
-- So where both totals are present and the rate is not, derive the rate
-- the row was actually converted at and store it. That is not an
-- estimate; ksum divided by sum IS the rate that produced ksum, and
-- writing it down changes no reported figure -- it only stops the figure
-- from changing later.
--
-- Guards, each for a case that genuinely occurs in the legacy data:
--   coin_rate IS NULL      -- idempotence. A second run matches nothing.
--   coin_code <> 'KRW'     -- a KRW row needs no rate; it is frozen by its
--                             currency.
--   price_sum <> 0 / NULL  -- division. A row with no original-currency
--                             total has no rate to recover.
--   price_ksum IS NOT NULL -- there is no booked KRW figure to protect, so
--                             there is nothing to pin. Such a row is


-- =====================================================================
-- 7. INDEXES
-- =====================================================================
--
-- WHY THIS FILE IS THE BIGGEST WIN IN THE MIGRATION
--   The legacy database has ZERO non-clustered indexes across all 31
--   tables -- only clustered primary keys. Combined with every date and
--   every amount being stored as nvarchar, that means every search, every
--   date-range filter and every report is a full table scan with a
--   per-row CONVERT(). This file, not the move to a managed Postgres, is
--   expected to deliver the larger share of the speed-up.
--
-- DESIGN RULES APPLIED
--   1. WHERE NOT deleted on anything the application filters. Soft delete
--      (legacy DEL_YN) appears in very nearly every predicate, so the
--      partial index is both smaller and more selective than a full one.
--      NOTE: a partial index is only usable when the query also carries a
--      matching "NOT deleted" (or "deleted = false") predicate. Any new
--      query that omits it silently gets a seq scan -- the exact failure
--      mode we are removing. Keep the predicate in the repository layer.
--   2. PGroonga for Korean text. Korean search terms here are frequently
--      exactly 2 characters; pg_trgm cannot index below 3 and falls back to
--      a seq scan WITHOUT error. The operator class must be a LIKE-capable
--      one -- see section 1 -- and the column must be `text`, never
--      varchar, or LIKE is a sequential search no matter what is indexed.
--   3. gin_trgm_ops (3-gram) for ASCII identifier/contact columns, where
--      terms are always 3+ characters and trigram indexes are smaller.
--   4. An index on every FK column that is not already the leading column
--      of a PK or UNIQUE constraint (Postgres does not create these
--      automatically, and an unindexed FK makes the parent's delete /
--      update checks a scan of the child).
--
-- SIZE CONTEXT: ~310,000 rows / ~605 MB total. Small. Deliberately NO
-- partitioning and no sharding. GIN indexes on this volume are cheap.
--
-- COUNT NOTE -- READ THIS, IT IS A DELIBERATE DEVIATION.
--   This file creates 71 indexes, roughly double the 25-35 estimate in the
--   brief. That estimate cannot be met while also following the brief's own
--   coverage rules, and the arithmetic is worth stating plainly:
--       14  Korean PGroonga indexes (mandated: every searchable name column,
--                                   including the denormalised *_NAME copies)
--        6  ASCII 3-gram indexes   (code / phone / email infix search)
--       16  date indexes           (mandated: one per selectable date
--                                   column, + 2 "latest first" list sorts)
--       22  FK / hierarchy indexes (mandated: index every FK column)
--        7  facet and status filters
--        6  audit-log indexes
--   = 71, across 32 tables -- a little over two indexes per table, which is
--   unremarkable. The brief's starter set covered 4 tables; extending the
--   same rules to all 32 is simply more indexes than the estimate assumed.
--   Every index below names the screen or access pattern it serves, and
--   where an obvious candidate was REJECTED it is recorded as a "NOT
--   indexed" comment with the reason, so the omissions are reviewable too.
--   Total index footprint is expected to stay well under the 605 MB of
--   table data; re-measure with pg_total_relation_size after the ETL and
--   drop anything that pg_stat_user_indexes shows as never scanned after a
--   full month of real use.
--
-- GIN maintenance: set gin_pending_list_limit modestly and keep autovacuum
-- on these tables at default aggressiveness; the pending list is what makes
-- bulk ETL inserts tolerable. Build these AFTER the ETL load, not before.
-- =====================================================================


-- =====================================================================
-- 1. Korean-text substring search (PGroonga)
--    Serves: the search box on the project list, job list, PO list,
--    customer list, translator list, staff list and both invoice screens.
--    Every one of these is LIKE '%term%' on an operator-chosen column
--    today, and the term is very often 2 Korean characters (삼성, 번역).
-- =====================================================================
--
-- THE OPERATOR CLASS IS THE WHOLE POINT OF THIS SECTION.
--   `USING pgroonga (col)` with no operator class builds an index that
--   serves PGroonga's own operators (&@~ and friends) and does NOT serve
--   LIKE. Since the application emits LIKE '%term%' -- deliberately, so
--   that the ~20 dbops modules and the legacy query shapes are unchanged
--   -- that index would be built, reported as healthy, never used, and
--   every search would be a sequential scan. Exactly the defect being
--   removed.
--
--   `pgroonga_text_regexp_ops_v2` is the class chosen here. PGroonga
--   documents three LIKE-capable classes; this one is picked over
--   `pgroonga_text_full_text_search_ops_v2` because full-text search
--   tokenises, so it can only match on token boundaries -- which means a
--   term that lands mid-token (a partial alphanumeric code, or a Korean
--   substring the tokeniser did not split there) silently misses rows.
--   The regexp class indexes for arbitrary substring matching, which is
--   what LIKE '%term%' actually means.
--
--   PGroonga rewrites `col LIKE '%KEYWORD%'` into `col %% 'KEYWORD'`
--   internally. The resulting plan is a Bitmap Index Scan WITH a Recheck
--   (the rewrite is approximate, so the recheck re-applies the real LIKE);
--   that recheck is normal and is not a sign the index is being ignored.
--   db/004_verify_search.sql asserts the plan is not a Seq Scan.
--
--   COLUMN TYPE: every column below is `text` in 002_tables.sql. If any is
--   ever changed to varchar(n), PGroonga cannot use an index against it
--   and LIKE becomes a sequential search -- with no error and no plan
--   warning. This is the single sharpest edge in the file.
--
--   THE OPERATOR CLASS IS SCHEMA-QUALIFIED, and must stay that way.
--   001_extensions.sql installs PGroonga and pg_trgm `WITH SCHEMA
--   extensions`, following Supabase's own convention, so the operator
--   classes those extensions define live in `extensions` -- not in
--   `public`. An unqualified `pgroonga_text_regexp_ops_v2` is resolved
--   against the search_path, and a role whose search_path does not include
--   `extensions` gets:
--
--     ERROR: operator class "pgroonga_text_regexp_ops_v2" does not exist
--            for access method "pgroonga"
--
--   which reads as "PGroonga is broken / this class does not exist" and
--   says nothing whatsoever about the search_path. It is also the FIRST
--   statement in this file, so with ON_ERROR_STOP the whole index build
--   stops there. Qualifying the name removes the dependency outright:
--   this file then applies identically from psql, from the Supabase SQL
--   editor, from a migration runner, and over the pooler -- where a
--   session-level `SET search_path` would not reliably survive to the next
--   statement anyway (transaction mode hands out a different server
--   connection per transaction).

-- Core chain names
CREATE INDEX ix_prj_name_pgrn       ON project          USING pgroonga (prj_name      extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_job_name_pgrn       ON job              USING pgroonga (job_name      extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_po_name_pgrn        ON purchase_order   USING pgroonga (po_name       extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_cus_name_pgrn       ON customer         USING pgroonga (cus_name      extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_tran_name_pgrn      ON translator       USING pgroonga (tran_name     extensions.pgroonga_text_regexp_ops_v2);

-- Denormalised *_NAME copies. These are maintained copies of the
-- authoritative *_id relationship (see the column comments in 002), and the
-- list screens search them directly rather than joining -- so they need
-- their own indexes or the denormalisation buys nothing.
CREATE INDEX ix_prj_mgr_name_pgrn   ON project          USING pgroonga (prj_mgr_name  extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_prj_pm_name_pgrn    ON project          USING pgroonga (prj_pm_name   extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_prj_cus_name_pgrn   ON project          USING pgroonga (cus_code_name extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_prj_cus_mgr_pgrn    ON project          USING pgroonga (cus_mgr_name  extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_job_pm_name_pgrn    ON job              USING pgroonga (job_pm_name   extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_po_tran_name_pgrn   ON purchase_order   USING pgroonga (po_tran_name  extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_po_pm_name_pgrn     ON purchase_order   USING pgroonga (po_pm_name    extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_cus_mgr_name_pgrn   ON customer_contact USING pgroonga (cus_mgr_name  extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_staff_name_pgrn     ON staff            USING pgroonga (mgr_name      extensions.pgroonga_text_regexp_ops_v2);

-- Invoice screens search on the name snapshot held on the invoice itself,
-- not on the live customer/translator row.
CREATE INDEX ix_inv_cus_name_pgrn   ON invoice_customer   USING pgroonga (cus_name  extensions.pgroonga_text_regexp_ops_v2);
CREATE INDEX ix_inv_tran_name_pgrn  ON invoice_translator USING pgroonga (tran_name extensions.pgroonga_text_regexp_ops_v2);

-- NOT indexed: translator.tran_dup (the duplicate-check alias field). It is
-- substring-matched when registering a new vendor, but that happens a few
-- times a day against 310k rows -- not worth the write cost.


-- =====================================================================
-- 2. ASCII identifier / contact search (3-gram)
--    Serves: "find by code" lookups where an operator pastes a partial
--    code off a printed PO or invoice, and phone/email lookup.
--    These columns are never 2-character Korean, so trgm is correct here
--    and its index is materially smaller than a PGroonga index would be.
-- =====================================================================

CREATE INDEX ix_po_code_trgm        ON purchase_order    USING gin (po_code       extensions.gin_trgm_ops);
CREATE INDEX ix_prj_code_trgm       ON project           USING gin (prj_code      extensions.gin_trgm_ops);
CREATE INDEX ix_job_code_trgm       ON job               USING gin (job_code      extensions.gin_trgm_ops);
-- The UNIQUE constraints on these code columns already give an exact-match
-- btree; the trigram indexes above exist purely for partial/infix match.
-- NOT indexed for infix match: translator.tran_code, invoice_customer
-- .inv_cus_code, invoice_translator.inv_tran_code -- these are looked up
-- whole (scanned off a document, or followed from a link), so the UNIQUE
-- btree already serves them.

CREATE INDEX ix_tran_phone_trgm     ON translator        USING gin (tran_phone    extensions.gin_trgm_ops);
CREATE INDEX ix_tran_email_trgm     ON translator        USING gin (tran_email    extensions.gin_trgm_ops);
-- NOT indexed: customer.cus_email -- customers are found by name or code,
-- never by partial email, unlike translators.


-- =====================================================================
-- 3. Date ranges -- one per date column the UI exposes as a filter.
--    Serves: every list screen's date-range picker and all 8 report
--    screens. In legacy these were nvarchar(30) compared with CONVERT(),
--    so none of them could ever use an index even if one had existed.
-- =====================================================================

-- Project schedule
CREATE INDEX ix_prj_sday ON project (prj_sday) WHERE NOT deleted;
CREATE INDEX ix_prj_eday ON project (prj_eday) WHERE NOT deleted;

-- Job schedule. job_eday is the delivery date AND the business date the
-- reports recognise revenue on, which makes this the most load-bearing
-- index in the schema: every report is a range scan on it. The reports
-- aggregate job + purchase_order live on each request -- there is no
-- rollup, see 004_rollup.sql -- and that is affordable only because
-- ReportQuerySchema requires both ends of the range and this index turns
-- the range into a bitmap index scan. Drop it and the reports degrade
-- into the legacy system's slowest screen.
CREATE INDEX ix_job_eday ON job (job_eday) WHERE NOT deleted;
-- NOT indexed: job.job_sday. The job list screen filters on the delivery
-- date, and the project-level start date (ix_prj_sday) covers the "work
-- started in period" question. Add it if a screen turns out to need it.

-- PO schedule and settlement
CREATE INDEX ix_po_sday      ON purchase_order (po_sday)      WHERE NOT deleted;
CREATE INDEX ix_po_eday      ON purchase_order (po_eday)      WHERE NOT deleted;
CREATE INDEX ix_po_money_day ON purchase_order (po_money_day) WHERE NOT deleted;

-- Invoice / receivable / payable dates
CREATE INDEX ix_inv_cus_day      ON invoice_customer         (inv_day)     WHERE NOT deleted;
CREATE INDEX ix_inv_cus_last_day ON invoice_customer         (inv_last_day) WHERE NOT deleted;
CREATE INDEX ix_inv_cus_pay_day  ON invoice_customer_payment (inv_m_day)   WHERE NOT deleted;
CREATE INDEX ix_inv_tran_day     ON invoice_translator       (inv_day)      WHERE NOT deleted;
CREATE INDEX ix_inv_tran_mo_day  ON invoice_translator       (inv_mo_day)   WHERE NOT deleted;

-- Linguist work queue, always sorted by deadline
CREATE INDEX ix_ling_eday ON linguist_task (ling_eday) WHERE NOT deleted;

-- "Latest first" list defaults. created_at is now a real timestamptz, so
-- DESC ordering is finally correct -- in legacy REG_DT was a Korean
-- 12-hour string and '오후 11:30' sorted before '오후 2:30'.
CREATE INDEX ix_prj_created ON project        (created_at DESC) WHERE NOT deleted;
CREATE INDEX ix_po_created  ON purchase_order (created_at DESC) WHERE NOT deleted;


-- =====================================================================
-- 4. Hierarchy traversal -- the CUSTOMER -> PROJECT -> JOB -> PO -> TRANSLATOR
--    chain. Entirely unindexed AND unconstrained in legacy: these joins
--    are the reason the project detail screen and every margin
--    calculation are slow today.
-- =====================================================================

CREATE INDEX ix_job_prj ON job            (project_id) WHERE NOT deleted;
-- ix_po_job is the second half of every report, after ix_job_eday. Cost is
-- collapsed to one value per job by a LEFT JOIN LATERAL, which runs this
-- index once per job already selected by the date range -- so a one-month
-- report touches only that month's POs. Without it the lateral degrades to
-- a sequential scan per job.
CREATE INDEX ix_po_job  ON purchase_order (job_id)     WHERE NOT deleted;
CREATE INDEX ix_po_prj  ON purchase_order (project_id) WHERE NOT deleted;
CREATE INDEX ix_prj_cus ON project        (customer_id) WHERE NOT deleted;

-- "What does this translator currently owe us", sorted by deadline.
-- Composite so the deadline range is satisfied from the index, not a sort.
CREATE INDEX ix_po_tran ON purchase_order (translator_id, po_eday) WHERE NOT deleted;


-- =====================================================================
-- 5. Remaining foreign-key columns.
--
--    SCOPE NOTE -- a deliberate, documented deviation from "an index on
--    every FK column": the FK columns pointing at sys_code and currency
--    are NOT given individual indexes. There are roughly 30 of them, they
--    reference effectively immutable lookup rows (a code or currency is
--    deactivated, never deleted -- hence ON DELETE RESTRICT), and the
--    dimensional ones that screens actually filter on are already covered
--    by the composite facet indexes in section 6. Indexing all 30 would
--    roughly double the index count for no measurable query benefit and
--    would slow every ETL insert. Indexed below are the FK columns whose
--    parent rows DO get mutated, plus the ones screens filter on.
-- =====================================================================

-- Project dimension FKs (also the report group-by dimensions)
CREATE INDEX ix_prj_corp    ON project (corp_id)             WHERE NOT deleted;
CREATE INDEX ix_prj_mgr     ON project (prj_mgr_id)          WHERE NOT deleted;
CREATE INDEX ix_prj_pm      ON project (prj_pm_id)           WHERE NOT deleted;
CREATE INDEX ix_prj_contact ON project (customer_contact_id) WHERE NOT deleted;

-- Job / PO staff FKs ("my jobs" / "my POs" dashboard tabs)
CREATE INDEX ix_job_pm ON job            (job_pm_id) WHERE NOT deleted;
CREATE INDEX ix_po_pm  ON purchase_order (po_pm_id)  WHERE NOT deleted;

-- Owned child rows: needed both for the parent's detail screen and so the
-- ON DELETE CASCADE does not scan the child table.
CREATE INDEX ix_cus_contact_cus ON customer_contact    (customer_id);
CREATE INDEX ix_cus_rate_cus    ON customer_rate       (customer_id);
CREATE INDEX ix_tran_rate_tran  ON translator_rate     (translator_id);
CREATE INDEX ix_tran_cat_tool   ON translator_cat_tool (cat_tool_id);
CREATE INDEX ix_tran_file_tran  ON translator_file     (translator_id);
-- (translator_cat_tool.translator_id and translator_file.translator_id are
--  the leading columns of their UNIQUE constraints, so they are already
--  covered -- as are corp_profile_kor/eng.corp_id and corp_code_seq.corp_id.)

-- staff FKs
CREATE INDEX ix_staff_role ON staff (role_id)   WHERE NOT deleted;
CREATE INDEX ix_staff_corp ON staff (corp_code) WHERE NOT deleted;
-- NOT indexed: staff.mgr_tran. Tiny table (tens of rows), and the FK's
-- ON DELETE SET NULL scan is trivially cheap at that size.
--
-- The two access-control lookups. Both are read on every authenticated request:
-- the permission set from the caller's role, and the attributes from their staff
-- row. Each is a handful of rows, but "a handful per request" is still the hottest
-- read in the system, and an unindexed one is a sequential scan of the whole grant
-- table behind every API call.
CREATE INDEX ix_role_permission_role ON sys_role_permission (role_id);
CREATE INDEX ix_staff_attribute_staff ON staff_attribute (staff_id);
-- Who holds an attribute, for the project form's two pickers: "every staff member
-- who may be named as a PM" reads this one from the other end.
CREATE INDEX ix_staff_attribute_attr ON staff_attribute (attribute);

-- One person's recent searches on one screen, newest first -- which is the only way this table is
-- ever read, and the order the five-row prune needs. `id DESC` after `used_at DESC` because two
-- searches in the same instant would otherwise tie, and a prune with a tie can keep the wrong five.
CREATE INDEX ix_recent_search_recent
  ON staff_recent_search (staff_id, scope, used_at DESC, id DESC);

-- One person's custom columns in sheet order, which is the only way the
-- 나의 업무 screen reads them.
CREATE INDEX ix_workspace_column_staff ON workspace_column (staff_id, ord_no, id);
-- The other direction: every custom value on one PO. The primary key leads with
-- column_id, so "what is annotated on this PO" would otherwise scan.
CREATE INDEX ix_workspace_cell_po ON workspace_cell (po_id);

-- NOT indexed: sys_role_permission.permission. role_id leads
-- both UNIQUE constraints, which is the direction permission checks query
-- in; the reverse ("which roles grant this menu") is an admin screen over
-- at most 48 menus x a handful of roles. role_id is the hot path and it is
-- already covered.

-- Invoice FKs
CREATE INDEX ix_inv_cus_customer   ON invoice_customer   (customer_id)   WHERE NOT deleted;
CREATE INDEX ix_inv_tran_translator ON invoice_translator (translator_id) WHERE NOT deleted;

-- Linguist queue FKs ("my linguist tasks")
CREATE INDEX ix_ling_pm   ON linguist_task (ling_pm_id)   WHERE NOT deleted;
CREATE INDEX ix_ling_tran ON linguist_task (ling_tran_id) WHERE NOT deleted;

-- FX lookup: "the rate for this currency on or before date X".
-- DESC on effective_date so the newest qualifying row is the first entry.
CREATE INDEX ix_fx_rate_lookup ON fx_rate (currency_code, effective_date DESC);


-- =====================================================================
-- 6. Faceted search and status filters
-- =====================================================================

-- Translator search screen. These four low-cardinality facets are selected
-- together in the UI, so one composite index serves the whole filter
-- combination. Column order is most-selective-first: subject domain, then
-- work condition, then professional grade, then the CAT-tool flag (which is
-- boolean and therefore least selective, but free to carry at the tail).
-- Note this index also serves a prefix-only query on tran_field alone.
CREATE INDEX ix_tran_facet ON translator
  (tran_field, tran_work_con, tran_upro, tran_cat_use)
  WHERE NOT deleted;

-- Workflow status filters. Low cardinality, but these are the default
-- landing filters on the list screens ("show me everything in progress"),
-- so they are worth indexing at this table size.
CREATE INDEX ix_prj_state      ON project        (prj_state)        WHERE NOT deleted;
CREATE INDEX ix_job_state      ON job            (job_state)        WHERE NOT deleted;
CREATE INDEX ix_po_state       ON purchase_order (po_state)         WHERE NOT deleted;
-- NOT indexed: linguist_task.ling_state -- the queue is read by deadline
-- (ix_ling_eday) and the table is small.

-- Unbilled / unpaid worklists -- the AR and AP chase screens.
CREATE INDEX ix_prj_money_state ON project        (prj_invoice_state, prj_money_state) WHERE NOT deleted;
CREATE INDEX ix_po_settle_state ON purchase_order (po_invoice_state, po_money_state)   WHERE NOT deleted;


-- =====================================================================
-- 7. Audit logs.
--    Always read "most recent first", optionally narrowed by actor. The
--    DESC ordering is only trustworthy now that created_at is a real
--    timestamptz instead of a Korean 12-hour string.
-- =====================================================================

CREATE INDEX ix_log_po_dt     ON purchase_order_log  (created_at DESC);
CREATE INDEX ix_log_po_actor  ON purchase_order_log  (created_by, created_at DESC);
CREATE INDEX ix_log_po_code   ON purchase_order_log  (po_code);
CREATE INDEX ix_log_job_dt    ON job_move_log        (created_at DESC);
CREATE INDEX ix_log_modify_dt ON modify_log          (created_at DESC);
CREATE INDEX ix_log_cus_rate  ON customer_rate_log   (cus_code, created_at DESC);
CREATE INDEX ix_log_tran_rate ON translator_rate_log (tran_code, created_at DESC);


-- =====================================================================
-- POST-BUILD -- NOT OPTIONAL
--   1. ANALYZE every table before benchmarking. GIN and PGroonga indexes
--      are invisible to the planner without statistics, and the ETL leaves
--      none behind.
--   2. Run db/004_verify_search.sql. It asserts that the Korean
--      2-character LIKE really reaches the PGroonga index, and RAISEs if
--      it does not. Reading the plan by eye is not good enough here: the
--      failure mode of this whole design is a search that works and is
--      slow, which looks like nothing at all on 20 seed rows and looks
--      like the legacy system on 310,000.
-- =====================================================================
-- ANALYZE;
-- \i db/004_verify_search.sql
--
-- END 003_indexes.sql

-- ---------------------------------------------------------------------
-- 7b. Indexes for the type-detail tables
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 7c. Indexes for the approval gate and invoice grouping
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- IF NOT EXISTS, and here rather than in 003_indexes.sql, because 003 is
-- NOT idempotent -- 71 bare CREATE INDEX statements -- so re-running it to
-- pick up an addition fails on the first index it already made.
--
-- Partial on `NOT deleted`, matching every existing PO and invoice index,
-- so the planner can use them under the `deleted = false` predicate every
-- read in this application carries.
--
-- ix_po_approval is composite and in that order on purpose: the 결제
-- screen's first question is "what is waiting for approval", which is
-- po_approved = false AND po_state = '미승인'. Leading on the boolean also
-- serves the printable check (approved, any state) on its own.
CREATE INDEX IF NOT EXISTS ix_po_approval
  ON purchase_order (po_approved, po_state) WHERE NOT deleted;

-- The grouping, from the invoice's side: "which POs are on this invoice"
-- is what the printed document is built from, and it runs once per render.
CREATE INDEX IF NOT EXISTS ix_po_invoice_tran
  ON purchase_order (invoice_translator_id) WHERE NOT deleted;

-- The invoice list's own scope column. ix_inv_tran_day, ix_inv_tran_mo_day
-- and ix_inv_tran_translator already exist from 003.
CREATE INDEX IF NOT EXISTS ix_inv_tran_pm
  ON invoice_translator (inv_pm_id) WHERE NOT deleted;


-- ---------------------------------------------------------------------
