-- =====================================================================
-- NEOTMS :: 010_currency.sql
-- Run after 002_tables.sql. Idempotent -- re-run it as often as you like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   The same wall 007_codes.sql tore down, still standing one table over.
--
--   007 seeded `sys_code` because twenty-two columns reference it and an
--   empty parent table behind a restricting foreign key makes every save
--   fail with SQLSTATE 23503 -- a message that names a constraint and not
--   a field, so on screen it reads as "saving failed" with no indication
--   of which box was wrong. That file's header even says "this is not only
--   the customer-registration fix".
--
--   It was still not the customer-registration fix, because `currency` is
--   a DIFFERENT table with its own restricting foreign key, it was also
--   empty, and nothing in 001..009 ever put a row in it. Ten columns across
--   nine tables point at it:
--
--     customer.cus_coin                 translator.tran_coin
--     customer_rate.cus_co_coin         translator_rate.tran_la_coin
--     project.coin_code                 invoice_customer.coin_code
--     job.coin_code                     invoice_customer_payment.coin_code
--     purchase_order.po_coin_code       invoice_translator.coin_code
--
--   And this one is worse than the `sys_code` wall in one specific way.
--   Every code column is something a user chooses, so an empty `sys_code`
--   produced an empty dropdown -- visibly nothing to pick. Currency is
--   DEFAULTED: all five registration forms in the console open with 'KRW'
--   already selected (`?? 'KRW'` in CustomerFormModal, JobFormModal,
--   ProjectFormModal, PurchaseOrderFormModal, TranslatorFormModal) and
--   send it whether or not anybody touched the field. So the failure was
--   not "fill this in and it still won't save", it was
--
--     EVERY CREATE IN THE SYSTEM FAILED, ON A FIELD NOBODY TOUCHED,
--     NAMING A CONSTRAINT INSTEAD OF A FIELD.
--
--   Reproduced before writing this file:
--
--     INSERT INTO customer (cus_code, cus_name, cus_field, cus_coin, ...)
--     VALUES ('...', '테스트', '의학·제약', 'KRW', ...);
--     ERROR:  insert or update on table "customer" violates foreign key
--             constraint "customer_cus_coin_fkey"
--     DETAIL:  Key (cus_coin)=(KRW) is not present in table "currency".
--
--   The same INSERT with `cus_coin` omitted succeeds. That is the whole
--   bug: the one column the form always fills was the one with no parent
--   row, so the field a reader would suspect (`cus_field`, holding a
--   Korean string that looks like a label) was innocent.
--
-- THE INVARIANT THIS FILE MAINTAINS
--   Every currency the console can submit must exist here. The console's
--   list is hardcoded in frontend/src/apis/neotms.codes.ts as `COIN_CODES`
--   -- there is no GET endpoint for currencies, unlike `sys_code` -- so the
--   two lists are a matched pair and the rows below are exactly its five
--   values. A test asserts that, because the failure mode of drift is that
--   the dropdown offers a value which cannot be saved and the user is told
--   a constraint name.
--
--   Adding MORE rows here is harmless but invisible: nothing reads this
--   table to build a dropdown, so a sixth currency appears nowhere until
--   `COIN_CODES` gains it too. Adding FEWER breaks a save.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/010_currency.sql
--
--   As with 002..009: no `\` meta-command, no `:placeholder`, no BEGIN and
--   no COMMIT, so the whole file can be pasted into the Supabase SQL
--   editor as-is.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. the five currencies the console can send
-- ---------------------------------------------------------------------
-- `coin_code` is the natural key every FK points at, NOT `id`, so these
-- strings are the load-bearing part of the row. ISO-4217 three-letter
-- codes, which is what `COIN_CODES` offers and what the legacy COIN_CODE
-- column held for these five.
--
-- The column is varchar(20) with no length CHECK, deliberately (see the
-- comment on currency.coin_code in 002_tables.sql): legacy COINTB_MAIN is
-- nvarchar(20) and may contain non-ISO house codes that the ETL has not
-- been able to profile yet. Keeping the width means the ETL can load those
-- without a schema change; it does not mean this file should invent any.
--
-- `coin_name` is the Korean display name, per that column's comment. It is
-- not currently rendered anywhere -- the console shows the code and its
-- own label from `COIN_CODES` -- but it is what a report or an outgoing
-- document would join to, and leaving it NULL makes the row look like ETL
-- wreckage rather than a deliberate seed.
--
-- ON CONFLICT DO NOTHING and not DO UPDATE: if a row for 'USD' already
-- exists, it came from the ETL and carries the company's own wording.
-- Overwriting `coin_name` with the literal below would quietly relabel
-- migrated data to match a guess made here, which is the one thing a
-- re-runnable seed must never do.
INSERT INTO currency (coin_code, coin_name, created_by)
VALUES
  ('KRW', '원',        'seed-010'),
  ('USD', '미국 달러', 'seed-010'),
  ('JPY', '일본 엔',   'seed-010'),
  ('EUR', '유로',      'seed-010'),
  ('CNY', '중국 위안', 'seed-010')
ON CONFLICT (coin_code) DO NOTHING;

-- The audit marker, matching 'lpx-bootstrap' in 006 and
-- 'self-registration' in 009. It means "this row was created by a seed
-- file, not by the ETL and not by a person", which is the thing worth
-- being able to query when the ETL later disagrees with it:
--
--   SELECT * FROM currency WHERE created_by = 'seed-010';
COMMENT ON COLUMN currency.created_by IS
  'Who created the row. ''seed-010'' marks a row inserted by '
  'db/010_currency.sql rather than by the ETL or by a user -- these are the '
  'five currencies the console''s hardcoded COIN_CODES list can submit, '
  'seeded because every *_coin / coin_code column is a restricting foreign '
  'key onto this table and all five registration forms default to ''KRW''. '
  'A NULL here on a currency row means the ETL loaded it from legacy '
  'COINTB_MAIN.';


-- =====================================================================
-- 2. Verification
-- =====================================================================
-- Expected: five rows, one per code, and no NULL coin_name among them.
-- A count below five means this file was not applied in full, and the
-- missing code is one the console can still offer -- so the symptom will
-- be a save that fails only when somebody picks that currency, which is
-- considerably harder to recognise than the original fault.
SELECT coin_code, coin_name, created_by
  FROM currency
 ORDER BY coin_code;

-- The check that actually matters, stated as a query rather than left to
-- the eye: every currency the console can submit has a parent row. If this
-- returns anything, that value is selectable in the UI and unsaveable in
-- the database. Keep the list in step with COIN_CODES in
-- frontend/src/apis/neotms.codes.ts.
SELECT c.code AS console_offers_but_db_lacks
  FROM (VALUES ('KRW'), ('USD'), ('JPY'), ('EUR'), ('CNY')) AS c(code)
 WHERE NOT EXISTS (
         SELECT 1 FROM currency cur WHERE cur.coin_code = c.code
       );

-- And the converse, as information rather than as a fault: rows this file
-- did not create. On a fresh project this is empty; after the ETL it is
-- the list of legacy house codes, and any of them that users should be
-- able to pick needs adding to COIN_CODES on the frontend.
SELECT coin_code, coin_name
  FROM currency
 WHERE created_by IS DISTINCT FROM 'seed-010'
 ORDER BY coin_code;
