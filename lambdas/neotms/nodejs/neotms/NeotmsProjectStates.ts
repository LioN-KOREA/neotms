// SPDX-License-Identifier: MIT
//
// The project workflow vocabulary, written down once.
//
// `project.prj_state` is unconstrained `text`: no CHECK, no `sys_code` FK, no default. That is
// deliberate and documented in db/002_tables.sql - the legacy column is free-text `nvarchar` whose
// value set lived hardcoded in ASP pages, so pinning it would make half the migrated rows
// unsaveable. Everything that needs to know what a state MEANS therefore has to carry the
// vocabulary itself.
//
// ## Why this module exists, and the exact hazard it answers
//
// NeotmsReport.dbops.ts refused to build state-based dashboard counters for a precise reason, and
// the reason is still true:
//
//     A counter built on a guessed literal ('DONE', 'COMPLETE', or a mistyped state word) does not
//     fail; it silently reads zero, and a dashboard tile that always shows zero is read as good
//     news.
//
// The dashboard asks for exactly those counters, so the hazard has to be answered rather than
// avoided. It is answered in two parts:
//
//   1. **One definition.** The literals live here and nowhere else on the server. They already
//      existed in the client (`PROJECT_STATES` in frontend/src/apis/neotms.codes.ts, which fills
//      the state dropdown and is what every saved row was chosen from) and in three screens' "not
//      finished" overdue tests. Two independent guesses drift; one guess can be corrected in one
//      place.
//   2. **The count of rows it could not classify.** `DashboardSummary.unrecognisedState` reports
//      how many of the caller's projects hold a state that is not in this list. That is what turns
//      the silent failure loud: a tile reading zero next to "3 states were not recognised" is a
//      vocabulary problem, and a tile reading zero with nothing beside it is genuinely zero.
//      Without that number the two are the same screen.
//
// So these values are still PROVISIONAL - they must be checked against production data - but being
// wrong is now visible instead of flattering.

/** Quoted, not yet won. Counted in neither the in-progress nor the overdue tile. */
export const PROJECT_STATE_QUOTE = "견적";

/** Live work. The in-progress projects tile. */
export const PROJECT_STATE_ACTIVE = "진행";

/** Delivered. */
export const PROJECT_STATE_DONE = "완료";

/** Parked. The screenshot's "Holding" tile. */
export const PROJECT_STATE_HOLD = "보류";

/** Called off. */
export const PROJECT_STATE_CANCELLED = "취소";

/**
 * Every state this build knows, in the order the client's dropdown offers them.
 *
 * The order is not load-bearing anywhere; it is kept aligned with the client so the two lists can
 * be compared by eye when production values are finally profiled.
 */
export const PROJECT_STATES: readonly string[] = [
  PROJECT_STATE_QUOTE,
  PROJECT_STATE_ACTIVE,
  PROJECT_STATE_DONE,
  PROJECT_STATE_HOLD,
  PROJECT_STATE_CANCELLED,
];

/**
 * The states that end a project: nothing about it can be late any more.
 *
 * Used as the negative half of "overdue", and negative on purpose - the same reasoning as
 * `isLinguistic` in NeotmsJobTypes.ts. A sixth state added later ("under discussion", say) is then
 * treated as still-live and can appear in the overdue tile, which is the safe direction: a project
 * that is actually finished shows up as late and somebody corrects its state, whereas the other
 * spelling would hide a genuinely late project behind an unrecognised word.
 *
 * It matches the test the three list screens already make inline - the state is neither done nor
 * cancelled - in ProjectDetailView, JobsView and PurchaseOrdersView. Which is why those two and not
 * the quoted state: a quoted project has a due date that can pass, and a sales manager wants to be
 * told.
 */
export const PROJECT_STATES_CLOSED: readonly string[] = [
  PROJECT_STATE_DONE,
  PROJECT_STATE_CANCELLED,
];
