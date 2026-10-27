-- =====================================================================
-- NEOTMS :: 004_rollup.sql
-- Nightly-maintained reporting rollup. Run after 003_indexes.sql.
-- =====================================================================
--
-- WHY THIS EXISTS
--   The legacy yearly report aggregates the ENTIRE history on every single
--   page view -- no rollup, no indexes, nvarchar amounts converted per row.
--   It is the slowest screen in the system. This table pre-aggregates the 8
--   report screens and the dashboard counters down to one row per business
--   date per dimension combination, so those screens become indexed
--   lookups over a few tens of thousands of rows instead of a full-history
--   aggregation. This is the largest single performance win available after
--   the index work in 003.
--
-- REVENUE vs COST -- keep this relationship legible:
--   revenue comes from JOB totals   (job.job_price_ksum)
--   cost    comes from PO totals    (purchase_order.po_price_ksum)
--   margin  = revenue - cost        (not stored; derive it, so there is
--                                    exactly one definition of margin)
--   Both use the KRW-converted "KSUM" totals, never the original-currency
--   "SUM" totals, because a rollup row aggregates across currencies and
--   those figures must be comparable. The KRW value was computed with the
--   FX rate CAPTURED AT TRANSACTION TIME (job.coin_rate /
--   purchase_order.po_coin_rate), which is what makes a re-run of a report
--   from three years ago reproduce the original number.
--
-- ---------------------------------------------------------------------
-- VERIFICATION ANCHOR
--
--   The legacy yearly report's grand total is  ₩8,870,363,824
--
--   Any migration, and any recompute of this rollup over the full date
--   range, MUST reproduce that figure. Treat a mismatch as a blocking
--   defect, not a rounding curiosity, and check these causes first:
--     * soft-deleted jobs/POs wrongly included (or wrongly excluded)
--     * orphan jobs/POs dropped by the inner join to project -- the legacy
--       chain has no FKs, so orphans exist and the legacy report may well
--       have counted them
--     * KSUM vs SUM confusion on any currency other than KRW
--     * nvarchar amounts that fail to parse and silently become NULL
--   Reconcile with:
--     SELECT SUM(revenue) FROM report_daily_rollup;
--     SELECT SUM(job_price_ksum) FROM job WHERE NOT deleted;
-- ---------------------------------------------------------------------
-- =====================================================================


-- ---------------------------------------------------------------------
-- report_daily_rollup
-- ---------------------------------------------------------------------
CREATE TABLE report_daily_rollup (
  business_date date   NOT NULL,
  corp_id       bigint NOT NULL DEFAULT 0,
  customer_id   bigint NOT NULL DEFAULT 0,
  pm_id         bigint NOT NULL DEFAULT 0,
  sales_mgr_id  bigint NOT NULL DEFAULT 0,
  slang         text   NOT NULL DEFAULT '',
  elang         text   NOT NULL DEFAULT '',
  category_id   bigint NOT NULL DEFAULT 0,
  revenue       numeric(18,2) NOT NULL DEFAULT 0,
  cost          numeric(18,2) NOT NULL DEFAULT 0,
  computed_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (business_date, corp_id, customer_id, pm_id,
               sales_mgr_id, slang, elang, category_id)
);

COMMENT ON TABLE report_daily_rollup IS
  'Pre-aggregated daily fact table for the 8 report screens and the dashboard counters. One row per business date per combination of the 8 reporting dimensions. Rebuilt nightly, one business date at a time, by the recompute statement at the bottom of this file. Derived data only -- it can be dropped and rebuilt from job + purchase_order at any time, and SHOULD be rebuilt in full whenever the revenue/cost definition changes. revenue comes from JOB totals, cost from PO totals, so margin = revenue - cost.';

COMMENT ON COLUMN report_daily_rollup.business_date IS
  'The date the revenue and cost are attributed to. Sourced from job.job_eday (job delivery date), NOT from created_at: delivery is the point of revenue recognition here, and a job created in December and delivered in January belongs to January. Cost is attributed to the SAME date as its parent job rather than to the PO''s own deadline, so that revenue and cost land on the same row and margin is meaningful at every level of aggregation. Rows whose job has a NULL job_eday are skipped entirely (see the recompute''s WHERE clause) -- they are undated and cannot be placed in a time series.';

-- Why every dimension is NOT NULL with a sentinel default
COMMENT ON COLUMN report_daily_rollup.corp_id IS
  'Group entity dimension, from project.corp_id. SENTINEL 0 = "not set on the source row". NULLs are forbidden in all 8 dimension columns for one specific reason: they are part of the composite PRIMARY KEY, and in Postgres NULL is not equal to NULL, so a NULL-containing key would (a) never collide with itself and therefore never match ON CONFLICT, causing the nightly job to insert a duplicate row on every run instead of updating, and (b) not be deduplicated by the unique index at all. The recompute therefore wraps every dimension in COALESCE to a sentinel -- 0 for ids, '''' for text. Reports must translate sentinel 0 / '''' back to "(unassigned)" for display; do NOT join it to corp/customer/staff and expect a row.';
COMMENT ON COLUMN report_daily_rollup.customer_id IS
  'Customer dimension, from project.customer_id. Sentinel 0 when unset -- see corp_id.';
COMMENT ON COLUMN report_daily_rollup.pm_id IS
  'Project-manager dimension, from job.job_pm_id -- the PM on the JOB, which can differ from the project-level PM (project.prj_pm_id). Sentinel 0 when unset.';
COMMENT ON COLUMN report_daily_rollup.sales_mgr_id IS
  'Sales-manager dimension, from project.prj_mgr_id (legacy PRJ_MGR), the manager who owns the customer relationship -- as opposed to pm_id, who delivers the work. Sentinel 0 when unset. NOTE: the sales-vs-delivery reading of PRJ_MGR vs PRJ_PM is an inference; if the legacy screens label them otherwise, only this mapping changes, not the table.';
COMMENT ON COLUMN report_daily_rollup.slang IS
  'Source-language dimension, from job.job_slang. Held as the sys_code code string rather than an id, because that is the form the job row carries and it keeps the rollup readable without a join. Sentinel '''' when unset.';
COMMENT ON COLUMN report_daily_rollup.elang IS
  'Target-language dimension, from job.job_elang ("ELANG" = end language). Sentinel '''' when unset.';
COMMENT ON COLUMN report_daily_rollup.category_id IS
  'Subject-domain dimension, resolved from project.prj_field (the primary field; prj_field2 is NOT rolled up) to sys_code.id. This is the one dimension carried as an id rather than a code, matching the agreed rollup contract. Sentinel 0 both when prj_field is unset AND when it holds a retired code with no sys_code row -- the two cases are indistinguishable here, so investigate unset-category volume against project.prj_field directly.';
COMMENT ON COLUMN report_daily_rollup.revenue IS
  'Sum of job.job_price_ksum (KRW-converted job totals) for non-deleted jobs in this dimension combination on this business date. Revenue is booked on the JOB.';
COMMENT ON COLUMN report_daily_rollup.cost IS
  'Sum of purchase_order.po_price_ksum (KRW-converted PO totals) for non-deleted POs belonging to those jobs. Cost is booked on the PO. A job with no POs yet contributes revenue with zero cost, which is correct and must not be filtered out -- hence the LEFT JOIN in the recompute.';
COMMENT ON COLUMN report_daily_rollup.computed_at IS
  'When this row was last recomputed. Not part of the rollup contract; added so the dashboard can show data freshness and so a half-finished nightly run is detectable.';


-- ---------------------------------------------------------------------
-- Supporting indexes.
-- The composite PK already serves anything that leads with business_date,
-- which covers the date-range reports. These cover the drill-downs that
-- lead with a dimension instead.
-- ---------------------------------------------------------------------
CREATE INDEX ix_rollup_customer ON report_daily_rollup (customer_id, business_date);
CREATE INDEX ix_rollup_pm       ON report_daily_rollup (pm_id,       business_date);
CREATE INDEX ix_rollup_sales    ON report_daily_rollup (sales_mgr_id, business_date);
CREATE INDEX ix_rollup_corp     ON report_daily_rollup (corp_id,     business_date);
CREATE INDEX ix_rollup_category ON report_daily_rollup (category_id, business_date);
CREATE INDEX ix_rollup_langpair ON report_daily_rollup (slang, elang, business_date);


-- =====================================================================
-- NIGHTLY RECOMPUTE -- one business date per invocation.
--
-- Parameterised as :business_date, which is what the scheduled job binds.
-- Run it for yesterday, and re-run it for a trailing window (say the last
-- 30 days) to pick up back-dated edits; it is idempotent.
--
-- Two statements, in this order, inside ONE transaction:
--
--   1. DELETE for the date. Required because a dimension combination can
--      DISAPPEAR between runs (a job is reassigned to another PM, or soft
--      deleted). The INSERT alone would leave the stale row behind
--      forever, overstating revenue -- ON CONFLICT can only correct rows
--      that still exist in the new result set.
--   2. INSERT ... SELECT ... ON CONFLICT DO UPDATE. The ON CONFLICT clause
--      is retained even though the DELETE makes a collision unlikely, so
--      that the INSERT is safe to run on its own (ad-hoc backfill, or a
--      concurrent run) without raising a duplicate-key error.
--
-- COALESCE is mandatory on every dimension: see the comment on
-- report_daily_rollup.corp_id for why a NULL in a composite PK breaks
-- ON CONFLICT.
-- =====================================================================

BEGIN;

DELETE FROM report_daily_rollup
 WHERE business_date = :business_date;

INSERT INTO report_daily_rollup (
  business_date, corp_id, customer_id, pm_id, sales_mgr_id,
  slang, elang, category_id, revenue, cost, computed_at
)
SELECT
  j.job_eday                                      AS business_date,
  COALESCE(p.corp_id,      0)                     AS corp_id,
  COALESCE(p.customer_id,  0)                     AS customer_id,
  COALESCE(j.job_pm_id,    0)                     AS pm_id,
  COALESCE(p.prj_mgr_id,   0)                     AS sales_mgr_id,
  COALESCE(j.job_slang,   '')                     AS slang,
  COALESCE(j.job_elang,   '')                     AS elang,
  COALESCE(cat.id,         0)                     AS category_id,
  COALESCE(SUM(j.job_price_ksum),      0)         AS revenue,
  COALESCE(SUM(po.po_cost_ksum),       0)         AS cost,
  now()                                           AS computed_at
FROM job j
-- INNER join: a job with no project cannot be placed on any dimension.
-- Legacy has orphan jobs (PRJTB_JOB had no FK to PRJTB_MAIN), so this join
-- CAN silently drop revenue. Reconcile orphans during the ETL and then
-- monitor with:
--   SELECT count(*), SUM(job_price_ksum) FROM job j
--    WHERE NOT j.deleted AND NOT EXISTS (SELECT 1 FROM project p WHERE p.id = j.project_id);
JOIN project p
  ON p.id = j.project_id
 AND NOT p.deleted
-- Resolve the project's primary subject field to a sys_code id for the
-- category dimension. LEFT JOIN: retired field codes with no sys_code row
-- must fall through to sentinel 0, not drop the job.
LEFT JOIN sys_code cat
  ON cat.code = p.prj_field
-- Pre-aggregate PO cost per job BEFORE joining, so that a job with several
-- POs does not fan out and multiply its own revenue across the rows.
-- This is the classic double-count trap in this schema: revenue lives one
-- level up the hierarchy from cost.
LEFT JOIN (
  SELECT job_id, SUM(po_price_ksum) AS po_cost_ksum
    FROM purchase_order
   WHERE NOT deleted
   GROUP BY job_id
) po
  ON po.job_id = j.id
WHERE NOT j.deleted
  AND j.job_eday = :business_date
GROUP BY
  j.job_eday,
  COALESCE(p.corp_id,     0),
  COALESCE(p.customer_id, 0),
  COALESCE(j.job_pm_id,   0),
  COALESCE(p.prj_mgr_id,  0),
  COALESCE(j.job_slang,  ''),
  COALESCE(j.job_elang,  ''),
  COALESCE(cat.id,        0)
ON CONFLICT (business_date, corp_id, customer_id, pm_id,
             sales_mgr_id, slang, elang, category_id)
DO UPDATE SET
  revenue     = EXCLUDED.revenue,
  cost        = EXCLUDED.cost,
  computed_at = EXCLUDED.computed_at;

COMMIT;


-- =====================================================================
-- FULL REBUILD (initial load after the ETL, and after any change to the
-- revenue/cost definition). Loop the statement above over every distinct
-- job_eday rather than writing a second, divergent aggregation -- one
-- definition of revenue, in one place:
--
--   DO $$
--   DECLARE d date;
--   BEGIN
--     FOR d IN SELECT DISTINCT job_eday FROM job
--               WHERE NOT deleted AND job_eday IS NOT NULL ORDER BY 1
--     LOOP
--       -- execute the DELETE + INSERT above with :business_date := d
--     END LOOP;
--   END $$;
--
-- Then reconcile against the verification anchor at the top of this file:
--   SELECT to_char(SUM(revenue), 'FM999,999,999,999') FROM report_daily_rollup;
--   -- expected: 8,870,363,824
--
-- END 004_rollup.sql
-- =====================================================================
