-- =====================================================================
-- NEOTMS :: 014_fx_rates.sql
-- Run after 012_job_pricing.sql. Idempotent -- re-run it as often as you
-- like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   Until now a job's KRW figure was frozen the moment it was typed: the
--   console asked for an "적용 환율", multiplied by it, and stored the
--   product in job_price_ksum. Every report then summed that column.
--
--   That is right for money that has actually been exchanged and wrong for
--   money that has not. An invoice denominated in USD that nobody has
--   converted yet is an OPEN POSITION -- its worth in KRW moves with the
--   dollar until the day it is settled, and a report that keeps quoting
--   the rate from the day the job was booked is quoting a number that
--   stopped being true.
--
--   So the rate column stops being "the rate someone typed" and becomes
--   the answer to a different question.
--
-- THE MODEL -- SETTLED VERSUS OPEN
--   Read job.coin_rate (and purchase_order.po_coin_rate) as "has this been
--   exchanged, and at what rate".
--
--     coin_code = 'KRW' (or NULL)
--         Already KRW. job_price_sum IS the KRW figure. Frozen.
--
--     coin_code <> 'KRW' AND coin_rate IS NOT NULL
--         SETTLED. It was exchanged at coin_rate, and job_price_ksum is
--         the figure that was booked -- possibly hand-adjusted, possibly
--         already invoiced. Frozen, and deliberately so.
--
--     coin_code <> 'KRW' AND coin_rate IS NULL
--         OPEN. Nothing has been exchanged. The KRW figure is
--         job_price_sum times TODAY's rate, computed when the report runs
--         rather than stored.
--
--   Converting an open row is therefore not a new column and not a flag.
--   The console's "원화로 환산" button rewrites the row in place --
--   coin_code becomes 'KRW', job_price_sum becomes the converted amount,
--   coin_rate becomes 1 -- which lands it in the first case above and
--   freezes it. Exchanging and freezing are the same act, which is the
--   whole reason this model needs no extra state to represent.
--
--   What this does NOT do is make history move. Every pre-existing row
--   carries a coin_rate, so every pre-existing row is SETTLED and reads
--   exactly as it did before. Section 2 extends that guarantee to the
--   handful of legacy rows that have a KRW figure but no rate on it.
--
-- WHAT BREAKS WITHOUT THIS FILE
--   The view in section 1. Every report, every dashboard and every
--   project's rollup joins `fx_rate_latest`, so without it they all fail
--   with 42P01 -- the same loud failure 011 and 012 have. The comment
--   corrections in section 3 are documentation only; the backfill in
--   section 2 is a correctness fix for legacy rows and affects nothing
--   that was entered through this console.
--
--   Note that nothing here populates fx_rate. That is the scheduled
--   rate-fetcher Lambda's job (lambdas/neotms/nodejs/fxrate.ts), and
--   an empty fx_rate is not fatal -- an open row falls back to its
--   stored job_price_ksum, so the figures stay where they were until
--   the first quote lands.
--
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
--                             genuinely unconverted and SHOULD float.
UPDATE job
   SET coin_rate = round(job_price_ksum / job_price_sum, 6)
 WHERE deleted = false
   AND coin_rate IS NULL
   AND coin_code IS NOT NULL
   AND coin_code <> 'KRW'
   AND job_price_sum IS NOT NULL
   AND job_price_sum <> 0
   AND job_price_ksum IS NOT NULL;

UPDATE purchase_order
   SET po_coin_rate = round(po_price_ksum / po_price_sum, 6)
 WHERE deleted = false
   AND po_coin_rate IS NULL
   AND po_coin_code IS NOT NULL
   AND po_coin_code <> 'KRW'
   AND po_price_sum IS NOT NULL
   AND po_price_sum <> 0
   AND po_price_ksum IS NOT NULL;


-- ---------------------------------------------------------------------
-- 3. Comment corrections
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


-- =====================================================================
-- VERIFICATION
-- =====================================================================
--
-- SETTLED VERSUS OPEN, which is the one count that matters here. Run it
-- before and after section 2 -- `legacy_floating` must be 0 afterwards,
-- and `open` should equal the number of foreign-currency jobs nobody has
-- exchanged yet.
--
--   SELECT CASE WHEN COALESCE(coin_code, 'KRW') = 'KRW' THEN 'krw'
--               WHEN coin_rate IS NOT NULL             THEN 'settled'
--               ELSE 'open' END                         AS position,
--          count(*)                                     AS jobs,
--          count(*) FILTER (WHERE job_price_ksum IS NOT NULL)
--                                                       AS with_krw_figure
--     FROM job
--    WHERE deleted = false
--    GROUP BY 1
--    ORDER BY 1;
--
-- The assertion section 2 exists to make true. Expect zero rows: an open
-- position must not already carry a booked KRW figure, because that figure
-- would be the one the reports stop quoting.
--
--   SELECT id, job_code, coin_code, job_price_sum, job_price_ksum
--     FROM job
--    WHERE deleted = false
--      AND COALESCE(coin_code, 'KRW') <> 'KRW'
--      AND coin_rate IS NULL
--      AND job_price_ksum IS NOT NULL;
--
-- Same two for purchase_order, substituting po_coin_code / po_coin_rate /
-- po_price_sum / po_price_ksum.
--
-- WHAT THE VIEW CURRENTLY SAYS. Empty until the fetcher has run once,
-- which is not an error -- see the header.
--
--   SELECT currency_code, rate, effective_date, source,
--          current_date - effective_date AS days_stale
--     FROM fx_rate_latest
--    ORDER BY currency_code;
--
-- STALENESS. More than about four days is a dead fetcher rather than a
-- long weekend; check the Lambda's log group and whether the API key
-- secret still holds a working key.
--
--   SELECT max(effective_date)                   AS newest_quote,
--          current_date - max(effective_date)    AS days_stale,
--          count(DISTINCT currency_code)         AS currencies
--     FROM fx_rate_latest;
--
-- CURRENCIES IN USE WITH NO QUOTE. Every row here is a currency some job
-- or PO is denominated in that the fetcher is not collecting, which means
-- an open position in it falls back to its stored ksum forever. Either add
-- it to the fetcher's list or settle those rows.
--
--   SELECT c.coin_code, count(j.id) AS open_jobs
--     FROM currency c
--     LEFT JOIN job j
--            ON j.coin_code = c.coin_code
--           AND j.deleted = false
--           AND j.coin_rate IS NULL
--    WHERE c.coin_code <> 'KRW'
--      AND NOT EXISTS (SELECT 1 FROM fx_rate_latest f
--                       WHERE f.currency_code = c.coin_code)
--    GROUP BY c.coin_code
--    ORDER BY c.coin_code;
--
-- =====================================================================
-- END 014_fx_rates.sql
-- =====================================================================
