-- =====================================================================
-- NEOTMS :: 012_job_pricing.sql
-- Run after 011_job_types.sql. Idempotent -- re-run it as often as you like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   011_job_types.sql gave a job and a purchase order a TYPE, and moved
--   the language pair -- the one thing that is meaningless on a MICE or
--   IMC engagement -- off the parent row and into a side table. It left
--   the PRICING MODEL alone, and the pricing model has exactly the same
--   problem.
--
--   Revenue and cost in this schema are recorded as
--
--     volume (words) x unit price, less a discount, times an FX rate
--
--   which is a translation invoice written down as columns. A conference
--   or a marketing campaign is not billed per word. In legacy LKTMS the
--   workaround was to set the language pair to a dummy value (Korean to
--   Korean), the word count to 1, and the unit price to the entire cost
--   of the engagement -- so the system held three fabricated numbers whose
--   only purpose was to make one real number come out right.
--
--   So this file splits the pricing columns in two, along the line that
--   was already there.
--
-- THE LINE: THE DERIVATION MOVES, THE AMOUNT STAYS
--   Of the nine pricing columns on `job`, five describe HOW the amount was
--   arrived at and four ARE the amount:
--
--     derivation -> job_detail_linguistic      the amount -> job stays
--       job_volume                               coin_code
--       unit_code                                coin_rate
--       job_price_sel                            job_price_sum
--       job_price                                job_price_ksum
--       job_price_dis
--
--   and the same split on purchase_order, which has no discount column.
--
--   `job_detail_non_linguistic` GAINS NOTHING. That is what "total only"
--   means literally -- a MICE job has no derivation to record, so its form
--   fills in the amount fields that are already on the parent and there is
--   nothing left over to store. A MICE job then CANNOT carry a word count,
--   not by convention but because `jdl_is_linguistic` (section 4 of 011)
--   already forbids it a linguistic detail row.
--
-- WHY THE TOTALS MUST NOT MOVE
--   `job_price_ksum` is the column the margin report sums as revenue, the
--   column `JOB_SORTS.amount` sorts the job list by, and the column
--   `ProjectRollupOps` aggregates per project. `po_price_ksum` is the same
--   for cost. Moving either into a side table would change REPORT_FROM,
--   all nine report dimensions, both list sorts and the project rollup at
--   once -- for no gain, because a KRW total means precisely the same
--   thing on all three types of work. Foreign currency keeps working on
--   non-linguistic work for the same reason: a MICE job billed in USD
--   still needs coin_code and coin_rate to reach a comparable KRW figure.
--
-- THE PROPERTY THAT MAKES THE LEGACY CLEANUP SAFE
--   The dummy-value rows described above are all LINGUISTICS today and
--   nothing distinguishes them automatically, so they get re-typed by hand
--   in the console. Under this split, re-typing one to MICE deletes its
--   linguistic detail row -- the fabricated pair, the fabricated `1 단어`
--   -- while the money stays on the parent, untouched. No amount is
--   re-entered, so the one field that feeds the report cannot acquire a
--   transcription error during the cleanup.
--
-- IT MUST BE APPLIED WHOLE, AND IN ORDER
--   Section 2 reads `job.job_volume` and section 3 drops it, exactly as
--   011 reads and then drops `job.job_slang`. Every statement is written
--   to be re-runnable, including that backfill -- see the comment on
--   section 2, which exists because believing ON CONFLICT was enough was
--   a real defect in 011.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/012_job_pricing.sql
--
--   As with 002..011: no `\` meta-command, no `:placeholder`, no BEGIN and
--   no COMMIT, so the whole file can be pasted into the Supabase SQL
--   editor as-is.
-- =====================================================================


-- =====================================================================
-- 1. the derivation columns, on the linguistic detail tables
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


-- =====================================================================
-- 2. move the existing derivations into the detail tables
-- =====================================================================
-- ON CONFLICT DO **UPDATE** here, where 011's language backfill used DO
-- NOTHING, and the difference is not a slip. 011 was inserting into an
-- empty table, so a conflict could only mean the application had already
-- written something newer. Here the conflicting row very often exists
-- ALREADY -- 011 created one for every job that had a language -- and its
-- five new pricing columns are necessarily NULL, because this file only
-- just added them. DO NOTHING would therefore skip exactly the rows that
-- need filling and silently lose every price belonging to a job that has
-- a language pair, which is most of them.
--
-- The DO UPDATE is guarded by a WHERE so that it only ever fills in
-- blanks. That guard is what makes a repeat run safe in the one awkward
-- case: this file stops after section 2 but before section 3, somebody
-- edits a unit price in the console, and the file is then re-run. Without
-- the guard the edit would be overwritten by the pre-migration value from
-- the parent; with it, a row that already holds any pricing value is left
-- alone.
--
-- The WHERE on the SELECT restricts to `job_type = 'LINGUISTICS'`, which
-- the CHECK in 011 requires. In a database migrated from LKTMS that is
-- every row. On a database where somebody has ALREADY created MICE jobs
-- through the new console -- which until this file shipped still showed
-- them a 물량 and a 단가 field -- those two inputs are discarded rather
-- than moved, and that is the correct outcome: a MICE job has no word
-- count. Their money is not discarded. job_price_sum and job_price_ksum
-- are on the parent and this file does not touch them, so the amount
-- those fabricated inputs added up to survives intact.
--
-- Wrapped in a DO block for the reason set out at length in section 5 of
-- 011_job_types.sql: section 3 drops `job.job_volume`, so on a second run
-- a plain INSERT naming that column is rejected at PARSE time with 42703,
-- before ON CONFLICT or any WHERE clause could notice there is nothing
-- left to move. Inside EXECUTE the statement is just a string until the IF
-- has established that the column is still there.
DO $backfill_job_pricing$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'job'
       AND column_name  = 'job_volume'
  ) THEN
    EXECUTE $move_job_pricing$
      INSERT INTO job_detail_linguistic
        (job_id, job_type, job_volume, unit_code, job_price_sel, job_price, job_price_dis)
      SELECT id, 'LINGUISTICS',
             job_volume,
             NULLIF(unit_code, ''),
             NULLIF(job_price_sel, ''),
             job_price,
             job_price_dis
        FROM job
       WHERE job_type = 'LINGUISTICS'
         AND (job_volume IS NOT NULL
              OR COALESCE(unit_code, '') <> ''
              OR COALESCE(job_price_sel, '') <> ''
              OR job_price IS NOT NULL
              OR job_price_dis IS NOT NULL)
      ON CONFLICT (job_id) DO UPDATE
         SET job_volume    = EXCLUDED.job_volume,
             unit_code     = EXCLUDED.unit_code,
             job_price_sel = EXCLUDED.job_price_sel,
             job_price     = EXCLUDED.job_price,
             job_price_dis = EXCLUDED.job_price_dis
       WHERE job_detail_linguistic.job_volume    IS NULL
         AND job_detail_linguistic.unit_code     IS NULL
         AND job_detail_linguistic.job_price_sel IS NULL
         AND job_detail_linguistic.job_price     IS NULL
         AND job_detail_linguistic.job_price_dis IS NULL
    $move_job_pricing$;
  ELSE
    RAISE NOTICE
      'job.job_volume is already gone, so the pricing inputs were moved by an earlier run';
  END IF;
END
$backfill_job_pricing$;

DO $backfill_po_pricing$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'purchase_order'
       AND column_name  = 'po_volume'
  ) THEN
    EXECUTE $move_po_pricing$
      INSERT INTO po_detail_linguistic
        (po_id, po_type, po_volume, po_unit_code, po_price_sel, po_price)
      SELECT id, 'LINGUISTICS',
             po_volume,
             NULLIF(po_unit_code, ''),
             NULLIF(po_price_sel, ''),
             po_price
        FROM purchase_order
       WHERE po_type = 'LINGUISTICS'
         AND (po_volume IS NOT NULL
              OR COALESCE(po_unit_code, '') <> ''
              OR COALESCE(po_price_sel, '') <> ''
              OR po_price IS NOT NULL)
      ON CONFLICT (po_id) DO UPDATE
         SET po_volume    = EXCLUDED.po_volume,
             po_unit_code = EXCLUDED.po_unit_code,
             po_price_sel = EXCLUDED.po_price_sel,
             po_price     = EXCLUDED.po_price
       WHERE po_detail_linguistic.po_volume    IS NULL
         AND po_detail_linguistic.po_unit_code IS NULL
         AND po_detail_linguistic.po_price_sel IS NULL
         AND po_detail_linguistic.po_price     IS NULL
    $move_po_pricing$;
  ELSE
    RAISE NOTICE
      'purchase_order.po_volume is already gone, so the pricing inputs were moved by an earlier run';
  END IF;
END
$backfill_po_pricing$;


-- =====================================================================
-- 3. drop the old columns
-- =====================================================================
-- After section 2, and only after it. The application reads the detail
-- tables from here on, so leaving these in place would give the schema two
-- homes for the same fact with no constraint keeping them equal.
--
-- THE EXTERNAL LKTMS ETL WRITES THESE COLUMNS TODAY and must be changed to
-- write job_detail_linguistic / po_detail_linguistic instead, or its next
-- load fails with 42703. This is the second file to move columns out from
-- under it -- 011 took the language pair -- so the two changes belong in
-- the same instruction to whoever maintains the ETL. See README.md.
--
-- NOT TOUCHED, and every one of them easy to drop by accident because the
-- name looks like something above:
--
--   job.coin_code,   job.coin_rate            -- the FX pair. On the
--   job.job_price_sum, job.job_price_ksum        PARENT on purpose; see
--   purchase_order.po_coin_code, po_coin_rate    the header. KSUM is what
--   purchase_order.po_price_sum, po_price_ksum   the reports sum.
--
--   purchase_order.po_cat_*   -- four CAT-TOOL ANALYSIS columns, where
--                                'cat' is Computer-Assisted Translation
--                                and not 'category'. Arguably linguistic
--                                and therefore arguably candidates for
--                                po_detail_linguistic, deliberately left
--                                alone: their meaning is recorded as
--                                UNCONFIRMED in 002_tables.sql, nothing in
--                                the application multiplies by them, and
--                                011's tests assert they survive.
--
--   purchase_order.po_tax*, po_money_*  -- withholding and settlement.
--                                Downstream of the total, not inputs to it.
ALTER TABLE job            DROP COLUMN IF EXISTS job_volume;
ALTER TABLE job            DROP COLUMN IF EXISTS unit_code;
ALTER TABLE job            DROP COLUMN IF EXISTS job_price_sel;
ALTER TABLE job            DROP COLUMN IF EXISTS job_price;
ALTER TABLE job            DROP COLUMN IF EXISTS job_price_dis;

ALTER TABLE purchase_order DROP COLUMN IF EXISTS po_volume;
ALTER TABLE purchase_order DROP COLUMN IF EXISTS po_unit_code;
ALTER TABLE purchase_order DROP COLUMN IF EXISTS po_price_sel;
ALTER TABLE purchase_order DROP COLUMN IF EXISTS po_price;


-- =====================================================================
-- 4. indexes
-- =====================================================================
-- None, and that is a decision rather than an omission. 003_indexes.sql
-- never indexed job_volume, unit_code or job_price either, because nothing
-- filters, sorts or groups by them -- JOB_FILTERS and JOB_SORTS reach for
-- job_price_ksum, which has not moved. The indexes 011 added on the detail
-- tables exist because the language pair and the category ARE filterable
-- from the console; these five columns are not, and an index nothing reads
-- is a write cost with no reader.
--
-- If a 물량 filter is ever added, it belongs on job_detail_linguistic and
-- can be created here with IF NOT EXISTS, same as 011's.


-- =====================================================================
-- 5. Verification
-- =====================================================================
-- The derivation columns are where they should be. Expected: nine rows --
-- five on job_detail_linguistic, four on po_detail_linguistic.
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('job_detail_linguistic', 'po_detail_linguistic')
   AND column_name IN ('job_volume', 'unit_code', 'job_price_sel', 'job_price', 'job_price_dis',
                       'po_volume', 'po_unit_code', 'po_price_sel', 'po_price')
 ORDER BY table_name, column_name;

-- And gone from the parents. Expected: zero rows. A row here means
-- section 3 did not run, the application is reading the detail tables, and
-- the prices in these columns are invisible to it.
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('job', 'purchase_order')
   AND column_name IN ('job_volume', 'unit_code', 'job_price_sel', 'job_price', 'job_price_dis',
                       'po_volume', 'po_unit_code', 'po_price_sel', 'po_price')
 ORDER BY table_name, column_name;

-- The converse, as information: the amount columns must STILL be on the
-- parents. Expected: eight rows -- four on job, four on purchase_order.
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('job', 'purchase_order')
   AND column_name IN ('coin_code', 'coin_rate', 'job_price_sum', 'job_price_ksum',
                       'po_coin_code', 'po_coin_rate', 'po_price_sum', 'po_price_ksum')
 ORDER BY table_name, column_name;

-- How much section 2 moved, next to how much there is to account for. The
-- first count should equal the number of jobs that had any pricing input
-- before the migration; the second is every job, priced or not. The first
-- being SMALLER is correct -- an unpriced job gets no detail row, the same
-- rule section 5 of 011 follows for languages.
SELECT 'jobs with a pricing derivation' AS measure, count(*) AS row_count
  FROM job_detail_linguistic
 WHERE job_volume IS NOT NULL OR job_price IS NOT NULL
UNION ALL
SELECT 'live jobs, all types', count(*) FROM job WHERE NOT deleted
UNION ALL
SELECT 'POs with a pricing derivation', count(*)
  FROM po_detail_linguistic
 WHERE po_volume IS NOT NULL OR po_price IS NOT NULL
UNION ALL
SELECT 'live purchase orders, all types', count(*) FROM purchase_order WHERE NOT deleted
ORDER BY measure;

-- The money did not move. Revenue and cost read exactly as they did before
-- this file ran, which is the claim the whole design rests on -- run these
-- two before and after and compare.
SELECT count(*) AS live_jobs, COALESCE(sum(job_price_ksum), 0) AS revenue_krw
  FROM job
 WHERE NOT deleted;

SELECT count(*) AS live_purchase_orders, COALESCE(sum(po_price_ksum), 0) AS cost_krw
  FROM purchase_order
 WHERE NOT deleted;

-- Non-linguistic work carries no derivation, by construction. These two
-- are unreachable rather than merely unlikely -- a MICE job cannot have a
-- row in job_detail_linguistic at all, because jdl_is_linguistic and the
-- composite foreign key in 011 forbid it. Expected: zero rows. Anything
-- here means a constraint from 011 is missing.
SELECT j.id, j.job_type, d.job_volume, d.job_price
  FROM job j
  JOIN job_detail_linguistic d ON d.job_id = j.id
 WHERE j.job_type <> 'LINGUISTICS';

SELECT po.id, po.po_type, d.po_volume, d.po_price
  FROM purchase_order po
  JOIN po_detail_linguistic d ON d.po_id = po.id
 WHERE po.po_type <> 'LINGUISTICS';
