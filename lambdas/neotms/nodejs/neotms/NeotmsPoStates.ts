// SPDX-License-Identifier: MIT
//
// 발주 상태 - the purchase-order workflow vocabulary, written down once.
//
// `purchase_order.po_state` is unconstrained `text`: no CHECK, no `sys_code` FK, no default. The same
// decision as `project.prj_state` and for the same recorded reason - the legacy column is free-text
// `nvarchar` whose value set lived hardcoded in ASP pages, so pinning it would make migrated rows
// unsaveable. db/015_payment.sql restates that and declines to constrain the column. So the meaning
// of a state lives here, in the application, and nowhere in the database.
//
// ## The ladder, and what each rung is actually asserting
//
//     미승인  ->  진행  ->  납품  ->  완료            (and 취소, off to one side)
//
// This column answers ONE question: how far the work has got. It deliberately does not answer the
// other two, which have their own columns:
//
//   * whether the money was signed off  ->  `purchase_order.po_approved`  (015)
//   * whether the money has been paid    ->  `purchase_order.po_money_state`
//
// That separation is the whole point of 015. A single state column conflated progress with sign-off:
// 발주 vs 수락 was being read as "approved or not", which cannot represent a PO that is approved
// before work starts, nor one that is in progress on a sign-off nobody gave - the exact case an
// approval gate exists to catch.
//
// ## 완료 MEANS PAID IN FULL
//
// Not "delivered", not "invoiced". A partly-paid PO stays at 납품 with `po_money_state = '부분정산'`.
// This is a business rule stated by the people who run the process, and it has one practical
// consequence worth stating plainly here: 부분정산 lives in exactly ONE column. Had partial payment
// been given its own rung, every screen would have two columns that can disagree about the same
// money, and nothing would say which one wins.
//
// ## Why this module exists rather than three inline literals
//
// The hazard NeotmsProjectStates.ts documents, repeated verbatim because it is repeated verbatim in
// practice:
//
//     A counter built on a guessed literal ('DONE', 'COMPLETE', '완료') does not fail; it silently
//     reads zero, and a dashboard tile that always shows zero is read as good news.
//
// 015 renames two of these values in live data (발주 -> 미승인, 수락 -> 진행). A rename is precisely
// the event that leaves a guessed literal matching nothing, so the literals are collected here, where
// correcting them is one edit. The client's own copy is `PO_STATES` in
// frontend/src/apis/neotms.codes.ts - the dropdown every saved row was chosen from - and the two
// lists are kept in the same order so they can be compared by eye.
//
// These values are PROVISIONAL in the same sense the project ones are: they must be checked against
// production data. Section 11b of db/015_payment.sql is the query that does it.

/**
 * 미승인 - raised, and waiting for somebody with the authority to sign off the amount.
 *
 * Renamed from 발주 by db/015_payment.sql. 발주 named the ACT of raising the order rather than the
 * state the order is in, and on a list of things still to be done it read as "done".
 *
 * A PO here is normally `po_approved = false`, but the two are independent and the other combination
 * is legitimate: approved, not yet started.
 */
export const PO_STATE_UNAPPROVED = "미승인";

/**
 * 진행 - with the translator, being worked on.
 *
 * Absorbed the legacy 수락 in db/015_payment.sql. 수락 meant "the translator accepted", which
 * occupies the same position on every screen as "the translator is working", and the approval it was
 * being used to stand in for is now `po_approved`.
 */
export const PO_STATE_ACTIVE = "진행";

/**
 * 납품 - delivered. The translator has done the work and is owed the money.
 *
 * The rung an invoice becomes printable from, and the rung a PARTLY paid PO sits at
 * (`po_money_state = '부분정산'`). It is not a terminal state: money is still outstanding, so
 * anything that asks "is this finished" must answer no.
 */
export const PO_STATE_DELIVERED = "납품";

/**
 * 완료 - settled. The translator has been paid in full.
 *
 * Reached only when `po_money_state` is 정산완료. See the module header: this is the rung every "is
 * this closed" test in the application reads, which is why a PO with money still owing on it must
 * not be put here.
 *
 * Section 11c of db/015_payment.sql lists the legacy rows that are 완료 without 정산완료 - POs closed
 * under the old, looser reading. They are deliberately NOT corrected by the migration: whether a
 * given one was really paid is a question for the accounts.
 */
export const PO_STATE_DONE = "완료";

/** 취소 - called off. Never approved, never printable, never paid. Off the ladder, not on the end. */
export const PO_STATE_CANCELLED = "취소";

/**
 * Every state this build knows, in the order the client's dropdown offers them.
 *
 * Kept aligned with `PO_STATES` in the console so the two can be compared by eye. The order is the
 * ladder itself, with 취소 last, so "later in the list" reads as "further along" for the four that
 * are a sequence.
 */
export const PO_STATES: readonly string[] = [
  PO_STATE_UNAPPROVED,
  PO_STATE_ACTIVE,
  PO_STATE_DELIVERED,
  PO_STATE_DONE,
  PO_STATE_CANCELLED,
];

/**
 * The states that end a PO: nothing about it can be late or outstanding any more.
 *
 * Framed negatively - what is CLOSED, so everything else is live - for the reason
 * `PROJECT_STATES_CLOSED` gives. A sixth state added later is then treated as still-live and can
 * appear in an overdue or outstanding count, which is the safe direction to be wrong in: a finished
 * PO showing as late gets its state corrected, whereas the other spelling hides a genuinely
 * outstanding payable behind a word nothing recognises.
 *
 * 납품 is NOT here, and that is the rule this list exists to state. A delivered PO still owes money
 * until it is 완료, so it is outstanding - including the partly-paid case.
 */
export const PO_STATES_CLOSED: readonly string[] = [PO_STATE_DONE, PO_STATE_CANCELLED];

/**
 * The states from which a translator invoice may be issued.
 *
 * "Printable from 납품 onwards" - the work exists to be billed. Deliberately includes 완료: an
 * already-settled PO's invoice must stay reprintable, because the document is a record of what was
 * sent and somebody will ask for a copy of it long after the money moved.
 *
 * 미승인 and 진행 are excluded because there is nothing yet to bill, and 취소 because there never
 * will be.
 */
export const PO_STATES_INVOICEABLE: readonly string[] = [PO_STATE_DELIVERED, PO_STATE_DONE];
