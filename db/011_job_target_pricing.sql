-- =====================================================================
-- NEOTMS :: 011_job_target_pricing.sql
-- Per-target-language quantities and pricing on 작업 등록.
-- =====================================================================
--
-- Requested 2026-11-25 (팀장님).
--
-- The 작업 등록 form asks for 물량, 기준, 단가 and 액면 물량 once per
-- target language, and creates one job per target language. The billed
-- quantity (액면 물량) still goes into job_volume exactly as before. What
-- is new is that the raw quantity, the basis and the pricing method that
-- produced it are kept beside it, so the edit form can show them again
-- as they were entered.
--
--   액면 물량 (job_volume)
--     = 원래 물량 (job_raw_volume) / 기준 (job_basis),
--       rounded to one decimal place
--
-- The database does NOT enforce that formula. The billed quantity can be
-- overwritten by hand, and overriding it is a normal thing to do.
--
-- All three columns are nullable. Several thousand existing jobs have
-- none of them, and with them absent the form falls back to 기준 1,
-- 원래 물량 = 액면 물량, and the 단가 pricing method.
--
-- Nothing to migrate, no data touched, and the file is re-runnable.
-- =====================================================================

ALTER TABLE job_detail_linguistic
  ADD COLUMN IF NOT EXISTS job_raw_volume numeric(14,2);
ALTER TABLE job_detail_linguistic
  ADD COLUMN IF NOT EXISTS job_basis numeric(10,2)
    CHECK (job_basis IS NULL OR job_basis > 0);
ALTER TABLE job_detail_linguistic
  ADD COLUMN IF NOT EXISTS job_price_mode text
    CHECK (job_price_mode IS NULL OR job_price_mode IN ('unit', 'fixed', 'free'));

COMMENT ON COLUMN job_detail_linguistic.job_raw_volume IS
  'The volume as counted (e.g. 12,000 words), before dividing by job_basis. job_volume holds the '
  'billable (face) volume that the price multiplies. NULL on jobs entered before db/011.';
COMMENT ON COLUMN job_detail_linguistic.job_basis IS
  'Units per billable unit: 250 or 200 words, 800/700/600/400 characters, otherwise 1. '
  'job_volume = round(job_raw_volume / job_basis, 1) unless the PM typed the face volume by hand.';
COMMENT ON COLUMN job_detail_linguistic.job_price_mode IS
  'How job_price_sum was derived: unit = job_volume x job_price, fixed = job_price is the amount, '
  'free = 0. Before the discount (job_price_dis). NULL = unit (legacy jobs).';
