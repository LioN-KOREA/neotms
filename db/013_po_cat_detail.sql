-- =====================================================================
-- 013_po_cat_detail.sql — PO 의 CAT 분량 표 (2026-11-25, 팀장님 요청)
--
-- PO 등록 창의 'CAT 분량' 표: 반복 / 100% / 95% / 85% / 75% / 50% / 일치없음 일곱 구간의 단어 수와,
-- 그때 적용한 가중치(%)를 함께 저장한다. 소계 = round(단어 × 가중치), 합계 = 소계의 합이고, 합계가
-- PO 의 물량(단위 '단어')이 된다.
--
-- 가중치는 화면에서 고칠 수 없다(기본값, 번역가 '[거래처] Taijia' 만 예외). 그래도 저장 당시의 값을
-- 같이 적어 두는 것은, 나중에 기본값이 바뀌어도 이미 발행한 PO 의 계산이 그대로 읽히게 하려는 것이다.
--
--   { "words": [반복, 100, 95, 85, 75, 50, 일치없음], "weights": [10, 0, 30, 30, 30, 30, 100] }
--
-- 기존 po_cat_use / po_cat_word / po_cat_mid / po_cat_stotal 도 계속 채운다(일치없음 단어 / 95~50%
-- 단어 합 / 가중 합계) — 그 칸을 읽는 화면·보고가 그대로 돌아가게.
--
-- 기본값 없는 nullable 열 하나 — 기존 데이터는 바뀌지 않는다. 다시 실행해도 안전하다.
-- =====================================================================

BEGIN;

ALTER TABLE purchase_order
  ADD COLUMN IF NOT EXISTS po_cat_detail jsonb;

COMMENT ON COLUMN purchase_order.po_cat_detail IS
  'CAT analysis table of the PO form: {"words":[rep,100,95,85,75,50,new],"weights":[...%]}. Subtotal per band = round(words * weight / 100), total = sum of subtotals = the PO volume in words. Weights are stored as applied so a later change of the defaults does not alter issued POs. po_cat_word / po_cat_mid / po_cat_stotal keep being filled (new words / 95-50% words / weighted total).';

COMMIT;
