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
//         says nothing about which menus or which rows.
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
import { exceptionToErrorResponse, rdsQuery } from "../utils/RdsDataUtils.js";
import { _resetTokenVerifier, verifyAccessToken } from "./NeotmsTokenVerifier.js";
import {
  RoleMenuPermissionsOps,
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
  const existing = (await rdsQuery(StaffByLpxSubOps(sub))).data;
  if (existing) return existing;

  // Just-in-time linking (Q20): the legacy staff accounts and the LPX accounts have virtually no
  // overlap, so the link is made on first sign-in rather than migrated. Email is all the two
  // systems share, so without one there is nothing to match on.
  if (!account.email) {
    console.warn(`No staff row is linked to ${sub}, and the account system reported no email.`);
    return null;
  }

  const candidate = (await rdsQuery(StaffUnclaimedByEmailOps(account.email))).data;
  if (!candidate) {
    console.warn(`No unclaimed staff row matches ${account.email} (${sub}).`);
    return null;
  }

  const claimed = (await rdsQuery(StaffClaimOps(candidate.staffId, sub))).data;
  if (!claimed) {
    // Another sign-in claimed it between the two statements. One of them is this same person
    // arriving twice - a double-clicked login, or two tabs - so read back by sub before giving up.
    console.warn(`The staff row ${candidate.staffId} was claimed by someone else; re-reading.`);
    return (await rdsQuery(StaffByLpxSubOps(sub))).data;
  }

  console.info(`Linked staff row ${claimed.staffId} (${claimed.mgrId}) to the identity ${sub}.`);
  return claimed;
}

async function resolveCaller(sub: string, account: AccountInfo): Promise<NeotmsCaller | null> {
  const cached = callerCache.get(sub);
  if (cached && cached.expiresAt > Date.now()) return cached.caller;

  const staff = await resolveStaff(sub, account);
  if (!staff) return null;
  // `active` is the "may currently sign in" flag. A departed employee's row is kept because every
  // historical project references it, so the flag is the only thing standing between a kept row
  // and a working login.
  if (!staff.active) {
    console.warn(`The staff row ${staff.staffId} is inactive; refusing ${sub}.`);
    return null;
  }

  const permissions = staff.roleId
    ? (await rdsQuery(RoleMenuPermissionsOps(staff.roleId))).data
    : new Map<string, MenuPermissions>();

  const caller = toCaller(sub, staff, account, permissions);
  callerCache.set(sub, { caller, expiresAt: Date.now() + CALLER_TTL_MS });
  return caller;
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
 *   503 - the cluster is resuming. Try again in a moment; see RdsDataUtils.
 */
export async function requireNeotmsAccess(
  headers: Record<string, string> | undefined,
): Promise<GuardResult> {
  if (!isAuthConfigComplete()) {
    // Refusing is the only safe answer, and 500 is the only honest status.
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
    // Any failure here - bad signature, wrong issuer, wrong client, expired - is a 401.
    console.error(`An access token was rejected : ${err}`);
    return { ok: false, response: UNAUTHENTICATED };
  }

  const account = await lookupAccount(token, sub);
  if (!account.authorities.includes(NeotmsEnv.NEOTMS_APP_AUTHORITY_ID)) {
    return { ok: false, response: { status: 403, body: "Not permitted" } };
  }

  let caller: NeotmsCaller | null;
  try {
    caller = await resolveCaller(sub, account);
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

  if (!caller) {
    return {
      ok: false,
      response: {
        status: 403,
        body: "This account is not registered as NEOTMS staff. Please contact an administrator.",
      },
    };
  }

  return { ok: true, caller };
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
