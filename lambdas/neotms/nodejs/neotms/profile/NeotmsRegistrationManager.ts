// SPDX-License-Identifier: MIT
//
// `POST /api/v0/registration` - an employee asking to be let into NEOTMS.
//
// This is the second and last route on the account-only tier, and it exists for the same reason
// `/api/v0/me` is on it: the staff row is what every other endpoint requires, so the endpoint that
// creates one cannot itself require one. See the header of NeotmsProfileManager for the deadlock
// that produced both.
//
// WHAT THIS CREATES IS A REQUEST, NOT AN ACCOUNT. The row arrives with `role_id IS NULL`, which
// means an empty permission matrix, which means every menu-gated route still refuses it. The only
// thing that changes is that `/api/v0/me` starts answering `pending` instead of `unregistered`, so
// the SPA swaps the sign-up form for the waiting notice. Approval is a separate act by a separate
// person on 사용자 관리, and nothing in this file can perform it.
//
// There is deliberately no administrator-facing POST anywhere in the application to pair with this
// one. A staff row is only usable once it carries an `lpx_sub`, and `lpx_sub` is an OIDC subject
// claim - an administrator cannot obtain somebody else's, so an admin-created row would be an
// unclaimed row waiting for the email match to link it, which is a worse version of what this does.
// Self-registration is not a convenience here; it is the only path a new employee has.
//
// The three columns that decide what this row may do - `role_id`, `view_scope`, `active` - are not
// parameters of anything in this file. They are literals inside `staff_self_register()`, in
// db/009_selfservice.sql, next to the constraints that bound them. A self-service form that could
// write any of them would be the unsigned-role-cookie defect rebuilt with better manners.

import { StaffSelfRegisterOps } from "../../auth/NeotmsStaff.dbops.js";
import { resolveRegistration, type LpxIdentity } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { pgQuery } from "../../utils/PostgresUtils.js";
import type { SelfProfile } from "../neotms.schemas.js";
import { runDb } from "../NeotmsResult.js";
import { getProfile, type ProfileView } from "./NeotmsProfileManager.js";

/**
 * Register the calling identity as NEOTMS staff, pending approval.
 *
 * Answers 201 with the same `ProfileView` that `/api/v0/me` would return a moment later - see below
 * for why that is the same code and not a second builder - so the SPA can render the waiting notice
 * from the response it already has, without a round trip whose answer it can predict.
 *
 * Takes the client address as a plain argument rather than a `WriteContext`. `WriteContext.actor` is
 * the caller's `mgrId`, which is built by `callerOf` - and `callerOf` throws on this route, because
 * there is no caller yet. The actor of this write is the row being created, so there is nothing for
 * `created_by` to name; `staff_self_register()` stamps the literal `'self-registration'` instead,
 * which is also the marker that answers "who got in without anybody approving them".
 */
export async function registerSelf(
  identity: LpxIdentity,
  input: SelfProfile,
  ip: string | null,
): Promise<ResponseData<ProfileView | string>> {
  return runDb("self register", async () => {
    /*
     * Look before writing, through the guard's own resolver.
     *
     * Not a cheap duplicate of what the function already does - `staff_self_register()` is
     * idempotent and would answer the existing id - but the two answers mean different things to
     * the person on the other end, and only this side can tell them apart. The function returns an
     * id; it cannot say "you are already approved" or "this account was switched off".
     *
     * Going through `resolveRegistration` and not a fresh query is what keeps those sentences
     * consistent with the rest of the system: it is the same lookup, the same just-in-time email
     * link, and the same cache the full guard uses, so this route and the next request cannot
     * disagree about whether a staff row exists. In particular the JIT link runs here too, which
     * means an employee whose legacy row is still unclaimed gets ADOPTED rather than duplicated -
     * and that is the only place adoption may happen, because it is the only place the row has been
     * checked for being active and undeleted. db/009_selfservice.sql section (b) is about exactly
     * this: by the time the function runs, the email match has already been tried and lost.
     */
    const before = await resolveRegistration(identity);

    if (before.kind === "inactive") {
      /*
       * Word for word what `/api/v0/me` says, and that is not laziness.
       *
       * A deactivated account hitting this endpoint is somebody trying to sign up again after an
       * administrator switched them off - which is precisely the move `staff_self_register()`
       * refuses to let succeed by not adopting their old row. The answer has to be the same on both
       * routes, because two different sentences for one state is how a user concludes that one of
       * the two screens is broken and keeps retrying.
       */
      return {
        status: 403,
        body: "This account has been deactivated in NEOTMS. Please contact an administrator.",
      } satisfies ResponseData<string>;
    }

    if (before.kind === "ok") {
      /*
       * 409 and not a cheerful 200, even though the function would have been idempotent.
       *
       * The SPA never shows the sign-up form to an identity with a staff row, so a POST arriving
       * here means the client's idea of the registration state was stale - an old tab, a replayed
       * request, a back button. Saying so lets it refetch `/api/v0/me` and land on the right screen;
       * answering 200 would tell it the form submission worked and leave it showing a confirmation
       * for something that did not happen.
       *
       * This is NOT the double-click case. Two submissions racing both pass this check, both call
       * the function, and both get 201 with the same row - the function's branch (a) exists for
       * that. Reaching this line requires the first request to have already finished, which makes
       * it a client-state problem rather than a race.
       *
       * The body names which of the two states it is, because they need different things from the
       * user: waiting, or nothing at all.
       */
      return {
        status: 409,
        body:
          before.caller.roleId === null
            ? "A registration request already exists for this account and is awaiting approval."
            : "This account is already registered in NEOTMS.",
      } satisfies ResponseData<string>;
    }

    await pgQuery(StaffSelfRegisterOps(identity.sub, input, ip));

    /*
     * Re-read through `getProfile`, so there is exactly one thing in this codebase that builds a
     * `ProfileView`.
     *
     * The alternative - assembling the response from `input` and the id the function returned -
     * would be a second builder for the same shape, and the two would drift the first time a field
     * is added to `ProfileView`. Worse, it would be a builder that reports what was REQUESTED
     * rather than what was STORED: this function normalises blanks to NULL, mints the `mgr_id`, and
     * fixes `role_id`, `view_scope` and `active` to values the request never mentioned. A response
     * built from the request would show the user their own input echoed back as if it were the
     * stored row, and the first thing anybody would notice is a `mgr_id` that is not the one they
     * have been given.
     *
     * One extra round trip, once per employee, ever. It also means `registration: "pending"` in
     * this response comes from the same `roleId === null` test the waiting screen will see on every
     * poll afterwards, rather than from an assumption made here about what the function did.
     *
     * `getProfile` has its own `runDb`, so a failure of the re-read is caught there and arrives as
     * an already-formed error response. The log line will read "read profile" rather than "self
     * register", which is the accurate half: the INSERT committed, and what failed was looking at
     * it. The row exists either way, and the next `/api/v0/me` finds it.
     */
    const after = await getProfile(identity);

    /*
     * 201 only if the re-read actually produced the profile. A 503 from the re-read must stay a 503:
     * a transient error dressed as 201 is one the browser will not retry.
     *
     * No `Location` header. The created resource is the caller's own staff row, whose only
     * representation is `/api/v0/me` - a URL the client is already using - and a header the CORS
     * configuration would have to be taught to expose, for an address the body makes redundant.
     */
    return after.status === 200 ? { ...after, status: 201 } : after;
  });
}
