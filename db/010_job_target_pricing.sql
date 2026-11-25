-- =====================================================================
-- 010_job_target_pricing.sql — 작업 등록의 언어별 설정 (2026-11-25, 팀장님 요청)
--
-- 작업 등록 창은 도착어마다 물량 · 기준 · 단가 · 액면 물량을 따로 받고, 도착어마다 작업을
-- 하나씩 만든다. 청구 물량(액면 물량)은 지금까지처럼 job_volume 에 들어가고, 그것을 만든
-- 원래 물량과 기준, 가격 방식을 함께 남겨 둔다 — 수정 창에서 그대로 다시 보이게.
--
--   액면 물량(job_volume) = 원래 물량(job_raw_volume) ÷ 기준(job_basis), 소수 첫째 자리 반올림
--   (손으로 고칠 수도 있으므로 DB 는 이 식을 강제하지 않는다)
--
-- 모두 NULL 가능 — 기존 작업 수천 건에는 이 값이 없고, 없으면 화면이 기준 1 · 원래 물량 =
-- 액면 물량 · 단가 방식으로 보여 준다. 다시 실행해도 안전하다.
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
  'billable (face) volume that the price multiplies. NULL on jobs entered before db/010.';
COMMENT ON COLUMN job_detail_linguistic.job_basis IS
  'Units per billable unit: 250 or 200 words, 800/700/600/400 characters, otherwise 1. '
  'job_volume = round(job_raw_volume / job_basis, 1) unless the PM typed the face volume by hand.';
COMMENT ON COLUMN job_detail_linguistic.job_price_mode IS
  'How job_price_sum was derived: unit = job_volume x job_price, fixed = job_price is the amount, '
  'free = 0. Before the discount (job_price_dis). NULL = unit (legacy jobs).';
