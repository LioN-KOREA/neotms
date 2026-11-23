// SPDX-License-Identifier: MIT
//
// `POST /api/v0/registration` - an employee asking to be let into NEOTMS.
//
// This is the second and last route on the account-only tier, and it exists for the same reason
// `/api/v0/me` is on it: the staff row is what every other endpoint requires, so the endpoint that
// creates one cannot itself require one. See the header of NeotmsProfileManager for the deadlock
// that produced both.
//
// FOR ALMOST EVERYBODY, WHAT THIS CREATES IS A REQUEST AND NOT AN ACCOUNT. The row arrives with
// `role_id IS NULL`, which means an empty permission matrix, which means every menu-gated route
// still refuses it. The only thing that changes is that `/api/v0/me` starts answering `pending`
// instead of `unregistered`, so the SPA swaps the sign-up form for the waiting notice. Approval is
// a separate act by a separate person on the staff administration screen, and nothing in this file
// can perform it.
//
// THE ONE EXCEPTION is an account holding the LPX bootstrap authority (`lpx.admin.access`), which
// is approved on submission: `staff_self_register_bootstrap()` writes the NEOTMS_SYSADMIN role and
// a `view_scope` of 'Y', and the same response reports `active` rather than `pending`. It is not a
// shortcut granted as a courtesy. That authority exists so an empty or locked-out NEOTMS has a way
// in, and a way in that queues for an approval from the people who cannot sign in is not one.
//
// Everything about that exception is decided from the TOKEN. `holdsBootstrapAuthority()` reads the
// authority list the account system returned for a verified identity; `SelfProfileSchema` has no
// field that could influence it, and neither SQL function takes a role, a scope or an active flag
// as an argument.
//
// There is deliberately no administrator-facing POST anywhere in the application to pair with this
// one. A staff row is only usable once it carries an `lpx_sub`, and `lpx_sub` is an OIDC subject
// claim - an administrator cannot obtain somebody else's, so an admin-created row would be an
// unclaimed row waiting for the email match to link it, which is a worse version of what this does.
// Self-registration is not a convenience here; it is the only path a new employee has.
//
// The three columns that decide what this row may do - `role_id`, `view_scope`, `active` - are not
// parameters of anything in this file. They are literals inside the two functions, in db/001's
// self-service block, next to the constraints that bound them. That is also why there are TWO
// functions rather than one with a boolean: a flag selecting between two sets of literals is still
// an argument that selects a permission level, and the next person to widen it would have a
// precedent to point at instead of a prohibition. A self-service form that could write any of those
// three columns would be the unsigned-role-cookie defect rebuilt with better manners.

import {
  StaffSelfRegisterBootstrapOps,
  StaffSelfRegisterOps,
} from "../../auth/NeotmsStaff.dbops.js";
import {
  holdsBootstrapAuthority,
  resolveRegistration,
  type LpxIdentity,
} from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { NeotmsEnv } from "../../env/NeotmsEnv.js";
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
 * Takes the client address as a plain argument rather than a `WriteContext`. `WriteContext.actor`
 * is the caller's `mgrId`, which is built by `callerOf` - and `callerOf` throws on this route,
 * because there is no caller yet. The actor of this write is the row being created, so there is
 * nothing for `created_by` to name; `staff_self_register()` stamps the literal
 * `'self-registration'` instead, which is also the marker that answers "who got in without anybody
 * approving them".
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
       * request, a back button. Saying so lets it refetch `/api/v0/me` and land on the right
       * screen; answering 200 would tell it the form submission worked and leave it showing a
       * confirmation for something that did not happen.
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

    /*
     * The one decision this route makes, and it is made from the TOKEN, never from the body.
     *
     * `holdsBootstrapAuthority` reads the authority list the account system returned for this
     * verified identity. `SelfProfileSchema` has no field that could influence it, and neither SQL
     * function takes a role, a scope or an active flag as an argument - so the only way to be
     * approved on arrival is to actually hold `lpx.admin.access` at the moment of submission.
     *
     * Why an administrator is not left in the queue like everybody else: there may be nobody in the
     * queue's other end. This is the authority that exists so an empty or locked-out NEOTMS has a
     * way in, and a way in that waits for an approval from the people who cannot sign in is not one.
     */
    const bootstrapAdmin = holdsBootstrapAuthority(identity.account);
    const staffId = (
      await pgQuery(
        bootstrapAdmin
          ? StaffSelfRegisterBootstrapOps(identity.sub, input, ip)
          : StaffSelfRegisterOps(identity.sub, input, ip),
      )
    ).data;

    if (bootstrapAdmin) {
      /*
       * THE AUDIT RECORD, and the only one that exists for this event.
       *
       * The row itself carries `created_by = 'lpx-bootstrap-signup'`, which a review query can
       * find, but it cannot say WHICH authority let them in or which identity they arrived as.
       * `console.warn` rather than `info` so it survives a log level raised to quiet the request
       * log: this should be a handful of lines at go-live and then never, and a reader who finds a
       * fresh one months later should feel what they would feel at a sudo entry.
       */
      console.warn(
        `NEOTMS BOOTSTRAP: the authority ${NeotmsEnv.NEOTMS_BOOTSTRAP_AUTHORITY_ID} approved the ` +
          `sign-up of staff ${staffId ?? "?"} for the identity ${identity.sub} ` +
          `(${identity.account.email || "no email"}) on submission, with the ` +
          `NEOTMS_SYSADMIN role and no approval by anybody in NEOTMS.`,
      );
    }

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
     * 201 only if the re-read actually produced the profile. A 503 from the re-read must stay a
     * 503: a transient error dressed as 201 is one the browser will not retry.
     *
     * No `Location` header. The created resource is the caller's own staff row, whose only
     * representation is `/api/v0/me` - a URL the client is already using - and a header the CORS
     * configuration would have to be taught to expose, for an address the body makes redundant.
     */
    return after.status === 200 ? { ...after, status: 201 } : after;
  });
}
