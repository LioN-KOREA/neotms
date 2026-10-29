-- =====================================================================
-- NEOTMS :: 003_indexes.sql
-- Run after 002_tables.sql. Requires pgroonga and pg_trgm (001).
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

-- Job schedule. job_eday is the delivery date and the business date used
-- for revenue recognition in report_daily_rollup, so it is also the driver
-- for the nightly recompute's single-date filter.
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
-- NOT indexed: sys_role_auth.menu_id / sys_role_menu.menu_id. role_id leads
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
