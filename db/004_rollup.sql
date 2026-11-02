-- =====================================================================
-- NEOTMS :: 004_rollup.sql
-- TEARDOWN of the reporting rollup. Run after 003_indexes.sql.
-- =====================================================================
--
-- This file used to create `report_daily_rollup`, a daily pre-aggregated
-- fact table, plus six indexes and a `report_rollup_recompute(date)`
-- function meant to rebuild it nightly. All of that is gone. The reports
-- now aggregate `job`, `project` and `purchase_order` on every request --
-- see NeotmsReport.dbops.ts, which carries the full reasoning.
--
-- The file is RETAINED, at this number, on purpose:
--
--   * 005_code_sequences.sql says "run after 004_rollup.sql", and
--     006/008/009 point at the note below. Deleting the file would leave
--     four dangling cross-references and a gap in the bootstrap order.
--   * Any database bootstrapped before this change still HAS the table,
--     its six indexes and the function. On a fresh database the DROPs
--     below do nothing; on an existing one they remove an empty table
--     that nothing reads and a function nothing calls.
--   * It is where a reader who went looking for the rollup will arrive.
--
-- ---------------------------------------------------------------------
-- WHY THE ROLLUP WAS REMOVED
--
--   1. IT ANSWERED THE WRONG QUESTION. A manager opens the report to see
--      what has happened, including this morning's deliveries. Figures
--      that stop at midnight are not a faster answer, they are a
--      different one -- and the legacy TMS this replaces does show
--      today's work, so shipping a nightly report would have been a
--      regression dressed up as an optimisation.
--   2. NOTHING OWNED THE RECOMPUTE. No Lambda, no schedule and no
--      application code ever called report_rollup_recompute. The table
--      was created empty and stayed empty, so every report returned
--      zeroes while looking perfectly healthy: an empty chart over a
--      valid date range reads as "a quiet quarter", not as "the pipeline
--      does not exist". A cache with no writer is worse than no cache.
--   3. ITS PREMISE NO LONGER HELD. The justification was the legacy
--      yearly report, which aggregates the full history on every page
--      view and parses nvarchar amounts per row. Neither applies here:
--      job_price_ksum and po_price_ksum are already numeric(18,2), and
--      ReportQuerySchema REQUIRES both ends of the date range, so
--      ix_job_eday makes every report a bounded index scan. Measured on
--      150k jobs / 200k POs / 15 years -- an order of magnitude above
--      production -- live aggregation runs 7-10 ms for a month, 66 ms
--      for a year, 673 ms for the whole fifteen years.
--   4. IT WAS ALSO WRONG TWICE OVER. Its dimension columns could not
--      express the project-level PM, so the report's row-level scope was
--      narrower than the job list's: a project PM could open every job in
--      their project and then read zero revenue for it. And the
--      recompute's PO subquery was uncorrelated and undated, so it
--      re-aggregated all 200k POs on every single invocation -- a full
--      rebuild timed out.
--
--   The rollup's DEFINITIONS were right, and they are preserved exactly
--   in NeotmsReport.dbops.ts. Live aggregation was verified to reproduce
--   this table figure-for-figure over a 58-day window on the benchmark
--   database: zero difference in revenue and cost, and all seven
--   dimensions matching key-for-key.
--
-- ---------------------------------------------------------------------
-- THE `:name` NOTE (referenced by 006_bootstrap, 008_admin, 009_selfservice)
--
--   `:name` is a convention of THIS APPLICATION'S QUERY LAYER, not SQL.
--   `toPositional` in PostgresUtils.ts rewrites `:name` to `$1` before
--   the driver sees it. psql and the Supabase SQL editor have no such
--   rewrite, so a bootstrap file containing `:placeholder` fails with
--   `syntax error at or near ":"`. A bootstrap file must be applicable
--   as-is, which is why 002..010 contain no placeholders -- and also no
--   `\` meta-commands (the Supabase editor rejects them) and no
--   BEGIN/COMMIT (on the Supavisor pooler in transaction mode a caller
--   gets a different server connection per transaction, so a
--   multi-statement transaction issued as separate round trips is not
--   safe).
--
--   The removed recompute was a FUNCTION for that last reason: a function
--   call is one statement and is atomic by itself.
-- =====================================================================


-- The function first: it reads and writes the table, so dropping it
-- afterwards would leave a window where it exists over a missing table.
DROP FUNCTION IF EXISTS report_rollup_recompute(date);

-- The six indexes went with the table, but they are named here explicitly
-- so that a half-applied older bootstrap cannot leave one behind.
DROP INDEX IF EXISTS ix_rollup_customer;
DROP INDEX IF EXISTS ix_rollup_pm;
DROP INDEX IF EXISTS ix_rollup_sales;
DROP INDEX IF EXISTS ix_rollup_corp;
DROP INDEX IF EXISTS ix_rollup_category;
DROP INDEX IF EXISTS ix_rollup_langpair;

-- Derived data only: everything in it can be recomputed from job +
-- purchase_order, which is now exactly what the reports do. There is
-- nothing here to back up.
DROP TABLE IF EXISTS report_daily_rollup;


-- ---------------------------------------------------------------------
-- RECONCILIATION, now that the reports read the source tables directly.
--
-- The legacy yearly report's grand total is  ₩8,870,363,824
--
-- Any migration MUST reproduce that figure. Treat a mismatch as a
-- blocking defect, not a rounding curiosity, and check these first:
--   * soft-deleted jobs/POs wrongly included (or wrongly excluded)
--   * orphan jobs dropped by the INNER join to project -- the legacy
--     chain has no FKs, so orphans exist and the legacy report may well
--     have counted them
--   * KSUM vs SUM confusion on any currency other than KRW
--   * jobs with a NULL job_eday, which belong to no date range and so
--     appear in no report at all
--
--   -- revenue, which the reports sum from job_price_ksum
--   SELECT sum(j.job_price_ksum)
--     FROM job j
--     JOIN project p ON p.id = j.project_id AND NOT p.deleted
--    WHERE NOT j.deleted;
--
--   -- revenue the reports CANNOT show, for want of a business date
--   SELECT count(*), sum(job_price_ksum)
--     FROM job WHERE NOT deleted AND job_eday IS NULL;
--
--   -- orphan jobs, dropped by the INNER join above
--   SELECT count(*), sum(job_price_ksum) FROM job j
--    WHERE NOT j.deleted
--      AND NOT EXISTS (SELECT 1 FROM project p WHERE p.id = j.project_id);
--
-- Next: 005_code_sequences.sql
-- END 004_rollup.sql
-- =====================================================================
