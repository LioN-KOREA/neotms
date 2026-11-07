-- =====================================================================
-- NEOTMS :: 015_payment.sql
-- Run after 014_fx_rates.sql. Idempotent -- re-run it as often as you
-- like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   A purchase order is a promise to pay somebody. Until now this system
--   could record the promise but not the approval of it, and could not
--   record the invoice at all -- there were no screens for either, and
--   `invoice_translator` has sat unused since 002 created it.
--
--   The business process it has to carry:
--
--     1. A PM creates a project, its jobs, and issues POs.
--     2. SOMEBODY WITH THE AUTHORITY approves each PO. Only an approved
--        PO may be printed and sent to a translator.
--     3. The approved PO goes to the translator: what they will be paid,
--        by when, and the confidentiality terms.
--     4. The translator delivers. The PO is flagged 납품.
--     5. An invoice is issued covering one or more of that translator's
--        POs, and is printable from 납품 onwards.
--     6. When the money is actually sent, the PO becomes 완료.
--
-- THE TWO THINGS THIS CHANGES, AND WHY EACH IS SHAPED AS IT IS
--
-- 1. APPROVAL BECOMES A COLUMN, NOT A STATE
--
--   It was expressible before only as the difference between 발주 and
--   수락, which conflates two independent facts: how far the work has got,
--   and whether anyone senior has signed off the money. A PO can be
--   approved and not yet started, and it can be in progress on a sign-off
--   that was never given -- which is precisely the case an approval gate
--   exists to prevent, and precisely the case a single state column
--   cannot represent.
--
--   So `po_approved boolean` plus the two columns that make it auditable:
--   WHO and WHEN. An approval flag with neither is a flag that cannot
--   answer the only question ever asked of it after the fact.
--
--   The workflow states then become what they should always have been --
--   how far the work has got, and nothing else:
--
--     미승인  -> 진행 -> 납품 -> 완료          (and 취소, off to one side)
--
--   발주 is renamed 미승인 because "발주" named the act, not the state,
--   and read as "done" on a screen listing things still to do. 수락 is
--   folded into 진행: it meant "the translator accepted", which is the
--   same screen position as "the translator is working", and the approval
--   it was being used to stand in for is now its own column.
--
--   완료 MEANS PAID IN FULL. A partly-paid PO stays at 납품 with
--   po_money_state = '부분정산'. That is not a free choice: 완료 is what
--   every "is this finished" test in the application reads, and a PO we
--   still owe money on is not finished. Partial payment is therefore a
--   fact about the money (po_money_state), never a workflow stage -- which
--   also keeps 부분정산 in exactly one column instead of two that can
--   disagree.
--
-- 2. THE INVOICE USES THE TABLE THAT ALREADY EXISTS
--
--   One invoice covers SEVERAL POs for one translator. The printed form
--   is headed LIST OF INVOICE, carries its own code (POL_026153) and its
--   own issue date, and sums a Sub Total / Tax / Total across up to ten
--   PO lines. So the invoice cannot be a set of columns on a PO: a PO row
--   has nowhere to put an identity and a total that span several POs.
--
--   `invoice_translator` is already exactly that row (002_tables.sql),
--   and `purchase_order.inv_code` already points back to it by code.
--   This file adds the two things it needs to be writable from an
--   application rather than from an ETL -- `updated_at` and a real
--   foreign key for the grouping -- and nothing else.
--
--   WHAT STAYS ON THE PO. Every amount, and the payment status. The
--   invoice stores its own Sub Total / Tax / Total because those are what
--   was PRINTED AND SENT -- a document is a record of what was claimed,
--   not a live query -- but po_money_state, po_money_day and
--   po_money_price remain the single source of truth for what has
--   actually been paid. Nothing reads the payment state off the invoice.
--
-- WHAT BREAKS WITHOUT THIS FILE
--   Everything in the 결제 section, loudly and immediately:
--
--     * Every PO read selects `po.po_approved` -> 42703 on the PO list,
--       the PO detail, the project detail and the job detail screens.
--       This is the same loud failure 011 and 012 have, and it is the
--       reason this file and the matching Lambda must deploy together.
--     * Every invoice read selects `inv.updated_at` -> 42703.
--     * The 결제 tab is invisible and answers 403 to everybody including
--       the bootstrap superuser, per the sys_menu hazard 008 and 013
--       describe at length.
--
--   The state rename in section 5 is the one part that is NOT loud: skip
--   it and the application still runs, but the PO list filters on 미승인
--   and 진행 while the rows still say 발주 and 수락, so the dropdown finds
--   nothing and reads as "there are none" rather than as an error. That is
--   the quiet-failure shape this schema's comments warn about throughout,
--   so run the whole file.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/015_payment.sql
--
--   No `:placeholder`, no `\` meta-command, no BEGIN/COMMIT -- same as
--   002..014, so it pastes into the Supabase SQL editor as-is.
--
--   Apply it WHOLE AND IN ORDER. Section 5 reads the old state values and
--   section 4 reads po_state to decide what was already approved, so a
--   partial run leaves the two halves disagreeing. Every statement is
--   re-runnable, so an interrupted run is fixed by running it again.
-- =====================================================================


-- ---------------------------------------------------------------------
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
ALTER TABLE purchase_order
  ADD COLUMN IF NOT EXISTS po_approved    boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_order
  ADD COLUMN IF NOT EXISTS po_approved_at timestamptz;
ALTER TABLE purchase_order
  ADD COLUMN IF NOT EXISTS po_approved_by text;

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
ALTER TABLE purchase_order
  ADD COLUMN IF NOT EXISTS invoice_translator_id bigint
    REFERENCES invoice_translator (id) ON DELETE SET NULL;

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
ALTER TABLE invoice_translator
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE invoice_translator
  ADD COLUMN IF NOT EXISTS inv_pm_id  bigint REFERENCES staff (id) ON DELETE RESTRICT;

COMMENT ON COLUMN invoice_translator.updated_at IS
  'Last edit. NEW IN 015 -- 002 created this table as an ETL target, and an ETL only ever inserted. NULL on every migrated row and on any invoice never edited after issue.';
COMMENT ON COLUMN invoice_translator.inv_pm_id IS
  'The PM who issued this invoice -- staff.id. NEW IN 015. pm_code / pm_name are the legacy text pair and are maintained as copies; this is the one with a foreign key, and it is what the printed signature block joins to for the issuer''s phone and email, and what the invoice list''s row scope is resolved against.';

COMMENT ON TABLE invoice_translator IS
  'Translator invoice / payable. Legacy INVTB_TRAN, PK INV_TRAN_CODE. The cost-side counterpart of invoice_customer: GROUPS THE POs BEING SETTLED WITH ONE TRANSLATOR -- one invoice, several POs, which is what the printed LIST OF INVOICE form shows and why the invoice cannot be folded into purchase_order. Unlike the customer side, payment is tracked on this same row via the inv_mo_* columns rather than in a separate table.
WRITTEN BY THE APPLICATION SINCE 015 (the 결제 section), which added updated_at and inv_pm_id and made purchase_order.invoice_translator_id a real FK for the grouping. inv_sum / inv_tax hold WHAT WAS PRINTED on the document that was sent; purchase_order.po_money_state / po_money_day / po_money_price remain the single source of truth for what has actually been PAID. Nothing reads payment status off this table.
ETL NOTE: references to deleted translators must be reconciled before translator_id will validate.';


-- ---------------------------------------------------------------------
-- 4. Backfill the approval flag from the states that implied it
-- ---------------------------------------------------------------------
-- Legacy has no approval column, so the flag has to be inferred, and the
-- only evidence is the state. A PO that reached 수락 or beyond was in the
-- translator's hands, which could only happen after sign-off; a PO sitting
-- at 발주 had not been sent.
--
-- The IN list deliberately names BOTH vocabularies -- 수락 from before
-- section 5 runs and 진행/납품/완료 which exist in both. That is what makes
-- this statement give the same answer whether it runs before section 5, or
-- again afterwards on an already-migrated database. 취소 is absent: a
-- cancelled PO is not an approved one, and leaving it false means nobody
-- can print it.
--
-- `WHERE po_approved = false` is what makes a re-run free: once a row is
-- approved this statement cannot see it again, so a human approval
-- recorded last week is never overwritten by a backfill run today.
UPDATE purchase_order
   SET po_approved    = true,
       po_approved_by = 'backfill-015'
 WHERE po_approved = false
   AND po_state IN ('수락', '진행', '납품', '완료');

-- po_approved_at is left NULL on purpose. See its column comment: the
-- approval date of a legacy PO is not recorded anywhere, and now() would
-- assert that every historical PO was signed off on the day this file was
-- applied.


-- ---------------------------------------------------------------------
-- 5. Rename the two workflow states
-- ---------------------------------------------------------------------
-- 발주 -> 미승인, 수락 -> 진행. See the header for why each.
--
-- No CHECK and no sys_code FK is added on po_state, and that is not an
-- omission. The column's own comment in 002 records that live data holds
-- retired values; constraining it would make rows unsaveable that are
-- already in the table, which is the defect db/010_currency.sql documents
-- in the currency list. The vocabulary lives in the application instead --
-- NeotmsPoStates.ts on the server, PO_STATES in the console -- and a
-- value outside it still saves and still displays, marked unrecognised.
--
-- Re-runnable by construction: after the first run no row matches, so the
-- second run reports UPDATE 0.
UPDATE purchase_order SET po_state = '미승인' WHERE po_state = '발주';
UPDATE purchase_order SET po_state = '진행'   WHERE po_state = '수락';

COMMENT ON COLUMN purchase_order.po_state IS
  'Legacy PO_STATE. HOW FAR THE WORK HAS GOT, and nothing else: 미승인 -> 진행 -> 납품 -> 완료, plus 취소 off to one side. Whether the money was signed off is po_approved (015); whether it has been paid is po_money_state. 완료 MEANS PAID IN FULL -- a partly-paid PO stays at 납품 with po_money_state = ''부분정산'', so 부분정산 lives in one column rather than two that can disagree. 015 renamed 발주 -> 미승인 and folded 수락 into 진행. Still unconstrained text, no CHECK, no sys_code FK -- live data contains retired values; see project.prj_state. The vocabulary is NeotmsPoStates.ts on the server and PO_STATES in the console.';


-- ---------------------------------------------------------------------
-- 6. Backfill the invoice grouping from the legacy code
-- ---------------------------------------------------------------------
-- Migrated POs carry inv_code and no id. Where that code matches a live
-- invoice row, fill the id in; where it does not -- the deleted-invoice
-- case inv_code's comment describes -- leave it NULL and keep the code,
-- which is exactly what those two columns are for.
--
-- A join, not a correlated subquery: inv_tran_code is UNIQUE, so this
-- cannot match two invoices or duplicate a PO. `IS NULL` on the target
-- makes the re-run a no-op and means a grouping corrected by hand is
-- never silently reverted to whatever the legacy code says.
UPDATE purchase_order po
   SET invoice_translator_id = inv.id
  FROM invoice_translator inv
 WHERE po.invoice_translator_id IS NULL
   AND po.inv_code IS NOT NULL
   AND po.inv_code = inv.inv_tran_code
   AND inv.deleted = false;


-- ---------------------------------------------------------------------
-- 7. The invoice code sequence
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

SELECT setval('seq_invoice_tran_code', (
  SELECT COALESCE(MAX(NULLIF(regexp_replace(inv_tran_code, '[^0-9]', '', 'g'), ''))::bigint, 0) + 1
    FROM invoice_translator), false) AS invoice_sequence_set_to;


-- ---------------------------------------------------------------------
-- 8. Indexes
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
-- 9. sys_menu -- the 결제 section
-- ---------------------------------------------------------------------
-- ord_no 11, continuing 013's 9..10.
--
-- WHY A MENU OF ITS OWN AND NOT PART OF PURCHASE_ORDER
--   Because the authority is different, and a single menu id cannot say
--   so. Issuing a PO is a PM's daily work; approving the money on it, and
--   recording that a translator has been paid, is not. Gated on
--   PURCHASE_ORDER, every PM who can raise a PO could approve their own --
--   which is not an approval gate, it is a formality.
--
--   A separate id makes "who may approve" a grant in sys_role_auth:
--   assignable, revocable and auditable by the same mechanism as
--   everything else, and changeable on the 사용자 관리 screen without a
--   deploy. That matters here specifically because who holds this
--   authority is still being decided.
--
--   The five action flags then carry the finer distinctions on their own:
--   `read` sees the 결제 screens and the printable documents, `update`
--   approves a PO and records a payment, `create` issues an invoice,
--   `delete` voids one.
--
-- menu_name has no parentheses, for the reason 013 gives: the 사용자 관리
-- permission editor lists these names next to five checkboxes, and nested
-- brackets read badly there.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('PAYMENT', '결제', NULL, 1, '/payment', 11, true)
ON CONFLICT (menu_id) DO NOTHING;

COMMENT ON TABLE sys_menu IS
  'Legacy SY_MENU -- the navigation tree, and the unit permissions are granted on. GET /api/v0/me '
  'returns one entry per active row here, so a menu with no row is INVISIBLE AND FORBIDDEN with no '
  'error anywhere: the sidebar omits it and every route gated on it answers 403. The ids the '
  'application gates on are enumerated in lambdas/neotms/nodejs/neotms/NeotmsMenus.ts; the six '
  'business menus are seeded by db/006_bootstrap.sql, the two administrative ones (MAINTENANCE, '
  'STAFF) by db/008_admin.sql, the two dashboards (DASHBOARD_SALES, DASHBOARD_PM) by '
  'db/013_dashboard_menus.sql, and 결제 (PAYMENT) by db/015_payment.sql. After inserting any row '
  'here, re-run sys_role_grant_all_menus(''NEOTMS_SYSADMIN'') -- grants written earlier do not cover '
  'menus added later.';


-- ---------------------------------------------------------------------
-- 10. Re-grant the superuser role over the new menu
-- ---------------------------------------------------------------------
-- As in 008 and 013: grants written once do not cover menus added
-- afterwards. Without this line the bootstrap superuser sees the 결제 tab
-- (sys_menu has the row) and gets 403 from it (sys_role_auth does not).
--
-- The superuser ONLY. Deciding which other role holds the approval
-- authority is the entire point of the separate menu, and handing it to
-- every existing role here would undo that on the way in. It is granted on
-- the 사용자 관리 screen, deliberately and per role.
SELECT sys_role_grant_all_menus('NEOTMS_SYSADMIN') AS menus_granted;


-- =====================================================================
-- 11. Verification
-- =====================================================================
--
-- Run these after applying. In the style of 004_rollup.sql's trailing
-- queries: each one has an expected answer, and a surprise means a section
-- did not run.
--
-- a) The new columns exist. Expect 6 rows.
--
--   SELECT table_name, column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE (table_name = 'purchase_order'
--           AND column_name IN ('po_approved', 'po_approved_at',
--                               'po_approved_by', 'invoice_translator_id'))
--       OR (table_name = 'invoice_translator'
--           AND column_name IN ('updated_at', 'inv_pm_id'))
--    ORDER BY table_name, column_name;
--
--   po_approved must read NOT NULL with default false. A nullable one
--   means section 1 ran against a table that already had the column from
--   a hand-made attempt -- ADD COLUMN IF NOT EXISTS does not correct the
--   definition of a column that is already there.
--
-- b) The state vocabulary after the rename. Expect NO rows for 발주 or
--    수락, and the approval flag to line up with the stage:
--
--   SELECT po_state, po_approved, count(*)
--     FROM purchase_order WHERE NOT deleted
--    GROUP BY po_state, po_approved ORDER BY po_state, po_approved;
--
--   Read it as: (미승인, false) is the normal waiting case; (진행|납품|
--   완료, true) is normal; (미승인, true) is legitimate -- approved and
--   not yet started. The row to look at is (진행|납품|완료, false): work
--   in progress on money nobody signed off. Section 4 should have left
--   none of those, so any that appear were created between applying this
--   file and deploying the Lambda, and want a human decision rather than
--   another UPDATE.
--
-- c) 완료 means paid in full. This should return NO rows:
--
--   SELECT id, po_code, po_state, po_money_state, po_price_ksum, po_money_price
--     FROM purchase_order
--    WHERE NOT deleted
--      AND po_state = '완료'
--      AND po_money_state IS DISTINCT FROM '정산완료';
--
--   Rows here are legacy POs closed under the old reading of 완료. They
--   are NOT corrected by this file: whether a given one was really paid is
--   a question for the accounts, not for a guess in a migration. Expect
--   some, review them, and fix them on the 결제 screen.
--
-- d) The invoice grouping agrees with the legacy code. Expect NO rows:
--
--   SELECT po.id, po.po_code, po.inv_code, inv.inv_tran_code
--     FROM purchase_order po
--     JOIN invoice_translator inv ON inv.id = po.invoice_translator_id
--    WHERE po.inv_code IS DISTINCT FROM inv.inv_tran_code;
--
--   A row means the denormalised copy and the foreign key point at
--   different invoices, which is the one way this pair can go wrong.
--
-- e) POs still carrying a code that matched no live invoice. Expect these,
--    and expect them to be the deleted-invoice case inv_code documents:
--
--   SELECT count(*) AS orphaned_inv_codes
--     FROM purchase_order
--    WHERE NOT deleted
--      AND inv_code IS NOT NULL
--      AND invoice_translator_id IS NULL;
--
-- f) The menu and its grant. Expect one row with five trues:
--
--   SELECT m.menu_id, m.menu_name, m.menu_url, m.ord_no,
--          a.role_1, a.role_2, a.role_3, a.role_4, a.role_5
--     FROM sys_menu m
--     LEFT JOIN sys_role_auth a
--            ON a.menu_id = m.menu_id
--           AND a.role_id = (SELECT id FROM sys_role WHERE role_code = 'NEOTMS_SYSADMIN')
--    WHERE m.menu_id = 'PAYMENT';
--
--   A NULL in any role_N means section 10 did not run. The symptom is a
--   visible 결제 tab that 403s.
--
-- g) Who holds the approval authority. The question this menu exists to
--    make answerable, so it is worth re-running after any role editing.
--    role_3 is read as `update` per ACTION_INDEX in NeotmsAuthGuard.ts,
--    which is still an UNCONFIRMED mapping against the legacy ROLE_1..5
--    columns -- if it is corrected there, correct it here.
--
--   SELECT r.role_code, r.role_name, a.role_1 AS may_read, a.role_3 AS may_approve
--     FROM sys_role r
--     LEFT JOIN sys_role_auth a
--            ON a.role_id = r.id AND a.active AND a.menu_id = 'PAYMENT'
--    ORDER BY r.role_code;
--
-- =====================================================================
-- END 015_payment.sql
-- =====================================================================
