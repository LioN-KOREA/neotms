// SPDX-License-Identifier: MIT
//
// Access control for the NEOTMS API. Three questions, in this order, and none of them is skipped:
//
//   1. Is this token genuine, and was it issued to THIS app?
//      -> verified locally against the account system's public JWKS (NeotmsTokenVerifier). No AWS
//         credentials and no network call beyond the occasional key download.
//
//   2. May this LPX account open NEOTMS at all?
//      -> the coarse tier. The access token does not carry the authority list, so it is read from
//         /lpx/auth/userInfo and cached briefly. Holding the authority means "may open NEOTMS"; it
//         says nothing about which menus or which rows. Two authorities pass - the app authority,
//         and `lpx.admin.access`, which exists only so that a NEOTMS whose `staff` table is still
//         empty has a way in. See `mayOpenNeotms` and `bootstrapSuperuser`.
//
//   3. Who is this person inside NEOTMS, and what may they do?
//      -> the fine tier, and the one the legacy system got wrong. The staff row gives the role, the
//         role gives the 48-menu x 5-action matrix, and the staff row's view scope gives row-level
//         visibility. All three are read from the database on the server. There is no code path in
//         NEOTMS that accepts a role, a permission or a scope from a caller - in LKTMS all three
//         came from an unsigned cookie.
//
// A successful userInfo response is not on its own proof of anything: it says what an account may
// do, not that the token presented is genuine for this client. Step 1 is never skipped.

import { NeotmsEnv, isAuthConfigComplete } from "../env/NeotmsEnv.js";
import type { ResponseData } from "../reqres/RequestResponse.js";
import { exceptionToErrorResponse, pgQuery } from "../utils/PostgresUtils.js";
import { _resetTokenVerifier, verifyAccessToken } from "./NeotmsTokenVerifier.js";
import {
  RoleMenuPermissionsOps,
  StaffBootstrapSuperuserOps,
  StaffByLpxSubOps,
  StaffClaimOps,
  StaffUnclaimedByEmailOps,
  type MenuPermissions,
  type StaffRow,
} from "./NeotmsStaff.dbops.js";

/* -------------------------------------------------------------------------- */
/* What a permitted caller looks like                                         */
/* -------------------------------------------------------------------------- */

/**
 * The five action flags on `sys_role_auth`.
 *
 * UNCONFIRMED MAPPING. The legacy columns are ROLE_1..ROLE_5 and the order below is the likely one,
 * but it has not been verified against the ASP source. Nothing is renamed in the database for the
 * same reason: a wrong rename silently grants or revokes a right, and a silent authorization change
 * is the one bug class with no symptom until it matters.
 *
 * This enum is the single place the guess lives. Confirm against the legacy permission-check
 * includes, correct `ACTION_INDEX` below, and every call site follows.
 */
export type MenuAction = "read" | "create" | "update" | "delete" | "export";

const ACTION_INDEX: Record<MenuAction, 0 | 1 | 2 | 3 | 4> = {
  read: 0,
  create: 1,
  update: 2,
  delete: 3,
  export: 4,
};

/**
 * Row-level visibility, derived from `staff.view_scope` (legacy MGR_VIEW, nvarchar(3)).
 *
 * EXACT SEMANTICS UNCONFIRMED - the width suggests a Y/N flag, but it has not been verified. So
 * this fails closed: only a value in `VIEW_SCOPE_ALL` widens the scope, and anything unrecognised
 * (including NULL, an empty string, or a value the ETL did not expect) means "own rows only".
 *
 * Failing closed here is deliberate and it has a visible failure mode: if the set below is wrong,
 * managers see too few projects and say so on the first day. The alternative - defaulting to "see
 * everything" - would be wrong in the direction nobody reports, because nothing looks broken when
 * you can see more than you should.
 */
const VIEW_SCOPE_ALL = new Set(["Y", "ALL", "A"]);

export type NeotmsCaller = {
  /** The OIDC subject. The only identifier that never changes. */
  sub: string;
  /** `staff.id`. The row every created record is attributed to. */
  staffId: string;
  mgrId: string;
  name: string;
  email: string;
  corpCode: string | null;
  /**
   * `staff.role_id`, or null for a staff row awaiting approval.
   *
   * Carried as well as `roleCode` because null here is a STATE the UI has to name, not just a
   * missing label: a self-registered row starts with no role, and "signed in, waiting to be
   * approved" has to be distinguishable from "approved into a role whose grants are empty". The
   * two look identical through `permissions` alone - both are an empty matrix - and telling the
   * second person to wait for an approval that already happened is the kind of answer that sends
   * them to a colleague instead of to the right screen.
   */
  roleId: string | null;
  roleCode: string | null;
  roleName: string | null;
  /** menu_id -> the five action flags. Absent from the map means no rights on that menu. */
  permissions: Map<string, MenuPermissions>;
  /** Raw `staff.view_scope`, kept for logging and for the admin screens. */
  viewScope: string | null;
  /** Whether this person may see every row, or only the ones they own. */
  seesEveryRow: boolean;
};

/** The outcome of a guard check: either the caller, or the response to send back. */
export type GuardResult =
  | { ok: true; caller: NeotmsCaller }
  | { ok: false; response: ResponseData<string> };

/* -------------------------------------------------------------------------- */
/* The LPX account (coarse tier)                                              */
/* -------------------------------------------------------------------------- */

/** What the account system says about one account. Only what this app uses is kept. */
export type AccountInfo = {
  authorities: string[];
  email: string;
  name: string;
};

/** Account info per `sub`. The TTL doubles as the authority revocation lag. */
const ACCOUNT_TTL_MS = 60_000;
const accountCache = new Map<string, { account: AccountInfo; expiresAt: number }>();

const NO_ACCOUNT: AccountInfo = { authorities: [], email: "", name: "" };

/**
 * What the account system says about one account: its authorities, and the name and email NEOTMS
 * shows and links on.
 *
 * Keyed by `sub`. A failed lookup is never cached: a transient outage would otherwise lock everyone
 * out for the whole TTL and look exactly like a permissions problem. When the lookup fails we fall
 * back to the last known answer if there is one, and to "no authorities" if there is not.
 */
export async function lookupAccount(accessToken: string, sub: string): Promise<AccountInfo> {
  const cached = accountCache.get(sub);
  if (cached && cached.expiresAt > Date.now()) return cached.account;

  const url = `${NeotmsEnv.NEOTMS_OIDC_ISSUER}/lpx/auth/userInfo`;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status !== 200) {
      console.error(
        `The account system answered ${response.status} for the account lookup (${sub})`,
      );
      return cached?.account ?? NO_ACCOUNT;
    }
    const body = (await response.json()) as {
      data?: { authorities?: unknown; lkAccountEmail?: unknown; lkAccountName?: unknown };
    };
    const account: AccountInfo = {
      authorities: Array.isArray(body.data?.authorities)
        ? body.data.authorities.filter((item): item is string => typeof item === "string")
        : [],
      email: typeof body.data?.lkAccountEmail === "string" ? body.data.lkAccountEmail : "",
      name: typeof body.data?.lkAccountName === "string" ? body.data.lkAccountName : "",
    };
    accountCache.set(sub, { account, expiresAt: Date.now() + ACCOUNT_TTL_MS });
    return account;
  } catch (err) {
    console.error(`An error occurred while reading the account (${sub}) : ${err}`);
    return cached?.account ?? NO_ACCOUNT;
  }
}

/**
 * Does this account hold the authority that may bootstrap an empty NEOTMS?
 *
 * That authority is `lpx.admin.access`, LPX's own superuser, supplied as
 * `NEOTMS_BOOTSTRAP_AUTHORITY_ID`. BLANK MEANS NO, for every account - that is how the bootstrap is
 * switched off, and it is the setting production should carry once real administrators exist. So the
 * blank check comes first and is not an error: an unset value here is a deliberate configuration,
 * unlike every other auth setting, which is why `isAuthConfigComplete` ignores it.
 *
 * Holding it does not grant any menu or any row. All it does is make the caller eligible for
 * `bootstrapSuperuser` below, which provisions a real staff row with a real role - so the
 * permissions that follow are read back out of the database like everyone else's.
 */
function holdsBootstrapAuthority(account: AccountInfo): boolean {
  const authority = NeotmsEnv.NEOTMS_BOOTSTRAP_AUTHORITY_ID.trim();
  if (!authority) return false;
  return account.authorities.includes(authority);
}

/**
 * May this LPX account open NEOTMS at all? The coarse tier, and nothing more.
 *
 * Exported because the session manager has to answer the same question for the browser, and the two
 * answers MUST agree. They did not have to agree before this function existed, and the failure that
 * would follow is a bad one: the SPA would render "you do not have access to this system" for an
 * administrator the API is perfectly willing to admit and bootstrap, so the one account that could
 * fix an empty database would be the one told it had no access.
 *
 * Two ways to pass, and the second is strictly a recovery path:
 *
 *   * the app authority - the normal answer for everybody;
 *   * the bootstrap authority - `lpx.admin.access`, which exists so that a NEOTMS with an empty
 *     `staff` table has a way in. See `bootstrapSuperuser`.
 *
 * This decides nothing beyond "may be let as far as the staff lookup". Every request is still
 * checked on its own, and what the caller may DO comes from their role.
 */
export function mayOpenNeotms(account: AccountInfo): boolean {
  return (
    account.authorities.includes(NeotmsEnv.NEOTMS_APP_AUTHORITY_ID) ||
    holdsBootstrapAuthority(account)
  );
}

/* -------------------------------------------------------------------------- */
/* The staff row and the role matrix (fine tier)                              */
/* -------------------------------------------------------------------------- */

/**
 * The resolved caller, per `sub`.
 *
 * Short-lived on purpose. It saves two queries on every request of a burst - which also keeps the
 * cluster idle enough to pause - while bounding how long a revoked role stays usable to about a
 * minute. A longer TTL would make "I removed their access" something an administrator cannot
 * observe, which is the kind of uncertainty that leads to people not using the feature.
 *
 * A failure is never cached, for the same reason as the account lookup. Unlike the account lookup
 * there is no fallback to a stale entry: an authorization decision made from an unreadable database
 * is not a decision, it is a guess.
 */
const CALLER_TTL_MS = 60_000;
const callerCache = new Map<string, { caller: NeotmsCaller; expiresAt: number }>();

const toCaller = (
  sub: string,
  staff: StaffRow,
  account: AccountInfo,
  permissions: Map<string, MenuPermissions>,
): NeotmsCaller => ({
  sub,
  staffId: staff.staffId,
  mgrId: staff.mgrId,
  // The staff row wins for the display name: it is the one the POs and invoices are printed with,
  // and it is the one colleagues recognise. The LPX name is the fallback for a freshly linked row.
  name: staff.name ?? account.name,
  email: staff.email ?? account.email,
  corpCode: staff.corpCode,
  roleId: staff.roleId,
  roleCode: staff.roleCode,
  roleName: staff.roleName,
  permissions,
  viewScope: staff.viewScope,
  seesEveryRow: staff.viewScope !== null && VIEW_SCOPE_ALL.has(staff.viewScope.trim().toUpperCase()),
});

/**
 * Find this identity's staff row, linking it just-in-time on a first sign-in.
 *
 * Returns null when there is no staff row to be had. That is a 403, not a 401: the account is
 * perfectly real and perfectly authenticated, it simply is not a NEOTMS staff member - and an
 * administrator has to create or claim the row. Answering 401 would send the browser back around
 * the sign-in loop, which succeeds, which refuses again, forever.
 */
async function resolveStaff(sub: string, account: AccountInfo): Promise<StaffRow | null> {
  const existing = (await pgQuery(StaffByLpxSubOps(sub))).data;
  if (existing) return existing;

  // Just-in-time linking (Q20): the legacy staff accounts and the LPX accounts have virtually no
  // overlap, so the link is made on first sign-in rather than migrated. Email is all the two
  // systems share, so without one there is nothing to match on.
  if (!account.email) {
    console.warn(`No staff row is linked to ${sub}, and the account system reported no email.`);
    return null;
  }

  const candidate = (await pgQuery(StaffUnclaimedByEmailOps(account.email))).data;
  if (!candidate) {
    console.warn(`No unclaimed staff row matches ${account.email} (${sub}).`);
    return null;
  }

  const claimed = (await pgQuery(StaffClaimOps(candidate.staffId, sub))).data;
  if (!claimed) {
    // Another sign-in claimed it between the two statements. One of them is this same person
    // arriving twice - a double-clicked login, or two tabs - so read back by sub before giving up.
    console.warn(`The staff row ${candidate.staffId} was claimed by someone else; re-reading.`);
    return (await pgQuery(StaffByLpxSubOps(sub))).data;
  }

  console.info(`Linked staff row ${claimed.staffId} (${claimed.mgrId}) to the identity ${sub}.`);
  return claimed;
}

/**
 * Why a staff row cannot be used to administer NEOTMS, or null if it can.
 *
 * Three states, and the point of grouping them is that they are indistinguishable to the person
 * affected - all three produce a NEOTMS nobody can do anything in:
 *
 *   * "missing"  - no row at all. What `db/002..005` leaves behind: the schema applies, the deploy
 *                  succeeds, and the first sign-in is refused as "not registered as NEOTMS staff".
 *   * "inactive" - a row exists and carries this subject, but `active = false`. Note this case can
 *                  only be reached HERE and not through `resolveStaff`'s just-in-time link, which
 *                  requires `active = true` to adopt a candidate at all.
 *   * "no role"  - active, linked, and `role_id IS NULL`, so the permission matrix comes back empty
 *                  and every menu is refused. Just as locked out as "missing", only it looks like a
 *                  working login into an application with no features.
 */
function whyUnusable(staff: StaffRow | null): "missing" | "inactive" | "no role" | null {
  if (!staff) return "missing";
  // `active` is the "may currently sign in" flag. A departed employee's row is kept because every
  // historical project references it, so the flag is the only thing standing between a kept row
  // and a working login.
  if (!staff.active) return "inactive";
  if (!staff.roleId) return "no role";
  return null;
}

/**
 * Provision or repair the staff row of an LPX administrator, so an empty NEOTMS has a way in.
 *
 * THE PROBLEM THIS SOLVES. Immediately after the schema is applied, `staff`, `sys_role` and
 * `sys_menu` are empty. Every sign-in is then refused for want of a staff row - including the
 * sign-in of the person who would have created the staff rows - and NEOTMS has no route that writes
 * one, because staff administration is itself behind the guard. Without this branch the only
 * recovery is the database password and a psql client, which is a worse thing to require than this
 * is to allow.
 *
 * WHY THE AUTHORITY AND NOT AN EMPTY-TABLE TEST. "Allow this while `staff` has no rows" sounds
 * tighter and is worse: the ETL loads the legacy staff rows, the table stops being empty, and the
 * administrators are silently locked out again at the exact moment they are needed - mid-migration,
 * with a half-loaded database. Keying on the authority means the capability is revoked by revoking
 * the authority, which is a deliberate act somebody can see.
 *
 * WHY THIS GRANTS NOTHING NEW. A holder of `lpx.admin.access` can already read and rewrite LPX's
 * authority tables, including which accounts hold the NEOTMS app authority - so they could already
 * grant themselves NEOTMS access and then be adopted by the ordinary path. This only saves the step.
 * The honest consequence, stated here and in db/006_bootstrap.sql section 4: SUCH A HOLDER CANNOT BE
 * LOCKED OUT OF NEOTMS FROM INSIDE NEOTMS. Revocation is on LPX, or by blanking
 * `NEOTMS_BOOTSTRAP_AUTHORITY_ID`.
 *
 * All of the decision is in the SQL function - one statement, therefore atomic under the pooler's
 * transaction mode, therefore immune to two administrators signing in at once and ending up with two
 * staff rows for one person. See StaffBootstrapSuperuserOps. It returns the id only, so the row is
 * re-read: a volatile function and a join in the same statement would read the pre-call snapshot.
 *
 * Returns null rather than throwing on a surprise - a bootstrap that did not take is a 403, same as
 * any other unusable row, and the log says what happened.
 */
async function bootstrapSuperuser(
  sub: string,
  account: AccountInfo,
  reason: "missing" | "inactive" | "no role",
): Promise<StaffRow | null> {
  const email = account.email.trim() || null;
  const name = account.name.trim() || null;

  // NULL, not "", when userInfo omitted them: the function distinguishes "no email to adopt by"
  // from an email, and '' stored in `mgr_email` would break every IS NULL test on that column.
  await pgQuery(StaffBootstrapSuperuserOps(sub, email, name));
  const staff = (await pgQuery(StaffByLpxSubOps(sub))).data;

  const stillUnusable = whyUnusable(staff);
  if (!staff || stillUnusable) {
    // Should not happen: the function either returns a usable id or raises. Worth its own message
    // because "it ran and the row is still wrong" and "it failed" need different investigations.
    console.error(
      `The bootstrap ran for ${sub} but the staff row is still unusable (${stillUnusable}).`,
    );
    return null;
  }

  /*
   * THE AUDIT RECORD, and for one case it is the only one that exists.
   *
   * db/006_bootstrap.sql section 5 has a review query over the database, but it cannot see
   * everything: a row that was ADOPTED rather than minted keeps its original `created_by`, and one
   * that already carried an explicit role was reactivated rather than escalated - so it leaves no
   * trace in `staff` distinguishable from ordinary use. This line is therefore the authoritative
   * record, and it carries everything an auditor needs to reconstruct the event: who, which
   * identity, what was wrong before, and what they hold now.
   *
   * `console.warn` and not `info`, so it survives a log level raised to quiet the request log. This
   * should be a rare line - a handful at go-live and then never - and a reader who finds a fresh one
   * months later should feel the same prickle as they would at a sudo entry.
   */
  console.warn(
    `NEOTMS BOOTSTRAP: the authority ${NeotmsEnv.NEOTMS_BOOTSTRAP_AUTHORITY_ID} provisioned ` +
      `staff ${staff.staffId} (${staff.mgrId}, ${staff.email ?? "no email"}) for the identity ` +
      `${sub}; the row was "${reason}" before, and now holds the role ` +
      `${staff.roleCode ?? "none"} with view scope ${staff.viewScope ?? "none"}.`,
  );
  return staff;
}

/**
 * What the staff lookup found, for a caller we have already authenticated as an LPX account.
 *
 * Three outcomes rather than `NeotmsCaller | null`, because the three need three different answers
 * from the API and the old null conflated two of them:
 *
 *   * `ok`           - a usable staff row. Note this INCLUDES a row with no role: that person is
 *                      signed in and can do nothing, which is a real state the UI has to describe
 *                      (see `NeotmsCaller.roleId`), not a refusal.
 *   * `unregistered` - no staff row for this identity, and none to link to. Until self-registration
 *                      existed this was simply a 403; now it is the one state a user can get
 *                      themselves out of, so it has to be reportable rather than only refusable.
 *   * `inactive`     - a row exists and carries this subject, but `active = false`. A refusal, and
 *                      deliberately NOT offered the sign-up form: minting a second row for somebody
 *                      an administrator switched off would hand back the access that was removed,
 *                      and it would split their project history across two `mgr_id`s.
 */
export type CallerState =
  | { kind: "ok"; caller: NeotmsCaller }
  | { kind: "unregistered" }
  | { kind: "inactive" };

async function resolveCallerState(sub: string, account: AccountInfo): Promise<CallerState> {
  const cached = callerCache.get(sub);
  if (cached && cached.expiresAt > Date.now()) return { kind: "ok", caller: cached.caller };

  let staff = await resolveStaff(sub, account);

  /*
   * The bootstrap sits HERE, and not inside `resolveStaff`, for a reason that is easy to get wrong:
   * `resolveStaff` returns a row it found whether or not that row is usable. An `active = false` row
   * carrying this subject is FOUND - `StaffByLpxSubOps` filters only on `deleted` - so an inactive
   * administrator never reaches a null return and a bootstrap hidden behind one would never fire for
   * them. The eligibility test has to see the row, not the absence of one.
   */
  const unusable = whyUnusable(staff);
  if (unusable && holdsBootstrapAuthority(account)) {
    // Only on success, so a bootstrap that did not take leaves the caller exactly where they would
    // have been without it. The "no role" case is the one that matters: that row is active, and
    // overwriting it with a null would turn a session with no permissions into no session at all -
    // a recovery path making things worse than not running.
    const bootstrapped = await bootstrapSuperuser(sub, account, unusable);
    if (bootstrapped) staff = bootstrapped;
  }

  if (!staff) return { kind: "unregistered" };
  if (!staff.active) {
    console.warn(`The staff row ${staff.staffId} is inactive; refusing ${sub}.`);
    return { kind: "inactive" };
  }

  const permissions = staff.roleId
    ? (await pgQuery(RoleMenuPermissionsOps(staff.roleId))).data
    : new Map<string, MenuPermissions>();

  const caller = toCaller(sub, staff, account, permissions);
  callerCache.set(sub, { caller, expiresAt: Date.now() + CALLER_TTL_MS });
  return { kind: "ok", caller };
}

/* -------------------------------------------------------------------------- */
/* The guard                                                                  */
/* -------------------------------------------------------------------------- */

/** Pull the bearer token out of the request headers, whatever case they arrived in. */
function bearerToken(headers: Record<string, string> | undefined): string | null {
  const raw = headers?.authorization ?? headers?.Authorization ?? null;
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1]!.trim() : null;
}

const UNAUTHENTICATED: ResponseData<string> = { status: 401, body: "Unauthenticated" };

/* -------------------------------------------------------------------------- */
/* Tier two on its own: a verified account, no staff row required             */
/* -------------------------------------------------------------------------- */

/** A caller we know the identity of, before asking who they are inside NEOTMS. */
export type LpxIdentity = {
  /** The OIDC subject. */
  sub: string;
  /** What the account system says about them - including the name and email a sign-up prefills. */
  account: AccountInfo;
};

export type IdentityResult =
  | { ok: true; identity: LpxIdentity }
  | { ok: false; response: ResponseData<string> };

/**
 * Steps 1 and 2 of the three at the top of this file: a genuine token for this app, held by an
 * account that may open NEOTMS. Step 3 - who they are inside NEOTMS - is not asked.
 *
 * TWO ROUTES AND ONLY TWO MAY USE THIS, and both exist because of the same chicken-and-egg:
 *
 *   * `GET /api/v0/me` - has to be able to answer "you have no staff row, here is the form". Behind
 *     `requireNeotmsAccess` that answer is a 403 with no body the SPA can act on, so the person who
 *     could register gets the one screen that does not mention registering.
 *   * `POST /api/v0/registration` - creates the staff row. It cannot require one.
 *
 * Nothing else should take this tier, and the reason is worth stating because the flag is one word
 * in a route table: an endpoint on this tier is reachable by EVERY employee with the NEOTMS app
 * authority, approved or not. That is the correct audience for "tell me my own status" and "put me
 * in the queue" and for nothing else. The two handlers that use it must therefore treat the account
 * as an identity only - never as a permission - and neither reads or writes a business table.
 *
 * Statuses match `requireNeotmsAccess` exactly, minus the ones that come from the staff lookup:
 * 500 for a missing setting, 401 for an identity we cannot establish, 403 for an account refused by
 * the coarse tier.
 */
export async function requireLpxAccountOnly(
  headers: Record<string, string> | undefined,
): Promise<IdentityResult> {
  if (!isAuthConfigComplete()) {
    console.error("The authentication settings are incomplete; refusing every request.");
    return {
      ok: false,
      response: { status: 500, body: "The server is not configured for authentication" },
    };
  }

  const token = bearerToken(headers);
  if (!token) return { ok: false, response: UNAUTHENTICATED };

  let sub: string;
  try {
    sub = (await verifyAccessToken(token)).sub;
  } catch (err) {
    console.error(`An access token was rejected : ${err}`);
    return { ok: false, response: UNAUTHENTICATED };
  }

  const account = await lookupAccount(token, sub);
  if (!mayOpenNeotms(account)) {
    // The same 403 the full guard gives, and for the same reason: this account may not open NEOTMS
    // at all, so offering it a sign-up form would be offering a queue it can never be let out of.
    return { ok: false, response: { status: 403, body: "Not permitted" } };
  }

  return { ok: true, identity: { sub, account } };
}

/**
 * Who this identity is inside NEOTMS, for a caller `requireLpxAccountOnly` has already admitted.
 *
 * Exported for `GET /api/v0/me`, which is the one endpoint that has to describe all three outcomes
 * rather than refuse two of them. Throws on a database failure rather than inventing a state - the
 * caller wraps it in `runDb`, which is the same translation `requireNeotmsAccess` does inline.
 */
export async function resolveRegistration(identity: LpxIdentity): Promise<CallerState> {
  return resolveCallerState(identity.sub, identity.account);
}

/* -------------------------------------------------------------------------- */
/* The full guard                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Let the request through only for a verified LPX account that holds the app authority and has a
 * usable NEOTMS staff row.
 *
 * Returns the response to send on refusal rather than throwing, so the caller stays a plain
 * handler. The status codes are chosen to be distinguishable, because an operator looking at a
 * refusal needs to know which of four different things went wrong:
 *
 *   500 - a setting is missing, or the database could not be read. An operator error or an outage,
 *         never the caller's fault. It must not read as "not allowed", or a misconfigured deploy
 *         would look exactly like a correctly refused request.
 *   401 - we cannot tell who this is. Signing in again is the right response.
 *   403 - we can tell, and they may not. Signing in again will not help, and an administrator has
 *         to act. This covers both "no NEOTMS authority" and "no staff row".
 *   503 - a transient database failure that outlived the retries: the pooler refused a connection,
 *         or the connection dropped mid-statement. Try again in a moment; see PostgresUtils.
 */
export async function requireNeotmsAccess(
  headers: Record<string, string> | undefined,
): Promise<GuardResult> {
  // Steps 1 and 2, shared with the account-only tier above so the two cannot drift apart. A
  // difference between them would be the worst kind: one endpoint admitting a token the next
  // refuses, with nothing in either log saying why.
  const identity = await requireLpxAccountOnly(headers);
  if (!identity.ok) return { ok: false, response: identity.response };
  const { sub, account } = identity.identity;

  let state: CallerState;
  try {
    state = await resolveCallerState(sub, account);
  } catch (err) {
    // A database failure is not a permission decision. Reporting it as one would be the legacy
    // system's defining mistake repeated: nobody could tell a deployment problem from a refusal.
    const detail = exceptionToErrorResponse(err);
    console.error(`The staff row for ${sub} could not be read : ${detail.name} ${detail.message}`);
    return {
      ok: false,
      response: {
        status: detail.status,
        body:
          detail.status === 503
            ? "The database is waking up. Please try again in a moment."
            : "The caller could not be identified",
        ...(detail.status === 503 && { headers: { "Retry-After": "2" } }),
      },
    };
  }

  if (state.kind !== "ok") {
    /*
     * One 403 for both refusals, and the wording is unchanged from before self-registration existed.
     *
     * It is tempting to say "register yourself at /signup" here. Don't: this body is what an API
     * client sees, and the SPA never shows it - it asks `GET /api/v0/me`, which reports the state
     * properly and renders either the sign-up form or the waiting notice. Naming the two cases
     * differently in this string would also tell an unauthorized caller whether a given LPX account
     * has a NEOTMS staff row, which is a fact worth nobody's while.
     */
    return {
      ok: false,
      response: {
        status: 403,
        body: "This account is not registered as NEOTMS staff. Please contact an administrator.",
      },
    };
  }

  return { ok: true, caller: state.caller };
}

/* -------------------------------------------------------------------------- */
/* Per-menu checks, for handlers                                              */
/* -------------------------------------------------------------------------- */

/**
 * May this caller take this action on this menu?
 *
 * The guard answers "may they be here at all". This answers "may they do this", and it has to be
 * asked per route because that is the granularity the matrix has. A menu the role has no row for is
 * refused - absent means no rights, not unrestricted.
 */
export function hasPermission(caller: NeotmsCaller, menuId: string, action: MenuAction): boolean {
  const flags = caller.permissions.get(menuId);
  if (!flags) return false;
  return flags[ACTION_INDEX[action]];
}

/** The 403 to return when `hasPermission` says no. Phrased so a user knows who to ask. */
export function permissionRefusal(menuId: string, action: MenuAction): ResponseData<string> {
  return {
    status: 403,
    body: `Your role does not permit this action (${menuId}: ${action}). Please contact an administrator.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Test seams                                                                 */
/* -------------------------------------------------------------------------- */

/** Test-only: forget the cached key set, account info and resolved callers. */
export function _resetAuthGuard(): void {
  _resetTokenVerifier();
  accountCache.clear();
  callerCache.clear();
}

/**
 * Test-only: age every cached entry out without discarding it.
 *
 * Expiring is not the same as clearing: an expired account entry is still the last known answer,
 * which is what a failed lookup falls back to. Clearing would hide exactly the behaviour worth
 * testing.
 */
export function _expireAuthCaches(): void {
  for (const entry of accountCache.values()) entry.expiresAt = 0;
  for (const entry of callerCache.values()) entry.expiresAt = 0;
}
