// SPDX-License-Identifier: MIT
//
// Sign-in, refresh and sign-out against the account system's OpenID Connect provider.
//
// The shape follows 연동 안내서 §2-§4: authorization code + PKCE, with the code exchange and every
// refresh done HERE, on the backend. The refresh token is a 24-hour credential, so it never reaches
// the browser - the browser gets a short-lived access token (kept in memory) and an HttpOnly session
// cookie, and comes back to /api/auth/refresh for the next access token.
//
// The protocol itself is left to openid-client (discovery, PKCE, state/nonce checks, the token
// endpoint). What is written out here is what a library cannot know: where this app keeps the
// verifier and the session, and how refreshes are serialised.
//
//   GET  /api/auth/login    -> 302 to /authorize; the PKCE verifier, state and nonce go into a
//                              short-lived HttpOnly cookie.
//   POST /api/auth/session  -> the callback. The browser lands on the registered redirect URI and
//                              posts the query it received; the code is exchanged with the verifier
//                              from the cookie, and a session is created.
//   POST /api/auth/refresh  -> the current access token for this session, rotating if needed.
//   POST /api/auth/logout   -> revoke and forget the session; answers with the /logout URL the
//                              browser must navigate to, so the SSO session ends too.
//
// Deliberately absent from the session response: the staff profile, the role and the menu matrix.
// Those take two queries against the cluster, and /api/auth/refresh is called by every tab every
// time an access token nears expiry. Answering it from DynamoDB alone is what lets the cluster
// pause; the browser asks /api/v0/me once per load for the rest (see NeotmsProfileManager).

import { createHash, randomBytes } from "node:crypto";
import * as client from "openid-client";
import * as v from "valibot";
import { NeotmsEnv, isAuthConfigComplete } from "../env/NeotmsEnv.js";
import type { RequestData, ResponseData, RRSetCookie } from "../reqres/RequestResponse.js";
import {
  dynamoDBDelete,
  dynamoDBGet,
  dynamoDBPut,
  dynamoDBUpdate,
  isConditionalCheckFailure,
} from "../utils/DynamoDBUtils.js";
import { lookupAccount } from "./NeotmsAuthGuard.js";
import { verifyAccessToken } from "./NeotmsTokenVerifier.js";
import {
  NeotmsSessionDeleteOps,
  NeotmsSessionGetOps,
  NeotmsSessionLockOps,
  NeotmsSessionPutOps,
  NeotmsSessionRotateOps,
  NeotmsSessionUnlockOps,
  type NeotmsSession,
} from "./NeotmsSession.dbops.js";

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

/** Holds the PKCE verifier, state and nonce between /login and the callback. */
const FLOW_COOKIE = "neotms_oidc";
/** Holds the session id. */
const SESSION_COOKIE = "neotms_session";
/** Both cookies are only ever needed by the /api/auth routes, so the browser sends them nowhere else. */
const COOKIE_PATH = "/api/auth";

/** A sign-in has to come back within this long. The code itself only lives 60s (§4.1). */
const FLOW_TTL_SEC = 600;
/** The refresh token and the SSO session both last 24 hours (§1). */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** An access token with less than this left is refreshed rather than handed out. */
const REFRESH_AHEAD_MS = 60_000;
/** How long one refresh may hold the lease before another may take it over. */
const LOCK_LEASE_MS = 15_000;
/** While someone else refreshes, look again this often, for at most this long. */
const LOCK_POLL_MS = 250;
const LOCK_WAIT_MS = 5_000;

/** Kept in the account system's own vocabulary (scope=openid). */
const SCOPE = "openid";

/* -------------------------------------------------------------------------- */
/* OIDC client                                                                */
/* -------------------------------------------------------------------------- */

/*
 * The discovered configuration, shared by every request a warm container serves.
 *
 * Held as a promise so concurrent first requests share one discovery fetch. A failed discovery is
 * forgotten, so the next request tries again instead of the container staying broken.
 */
let configPromise: Promise<client.Configuration> | null = null;

function oidcConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    // A public client: there is no secret, PKCE is what ties the code to whoever began the flow.
    // This is also why no client secret appears anywhere in NeotmsEnv - there is none to keep.
    configPromise = client
      .discovery(
        new URL(NeotmsEnv.NEOTMS_OIDC_ISSUER),
        NeotmsEnv.NEOTMS_AUTH_CLIENT_ID,
        undefined,
        client.None(),
      )
      .catch((err) => {
        configPromise = null;
        throw err;
      });
  }
  return configPromise;
}

/* -------------------------------------------------------------------------- */
/* Cookies                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `sameSite: "lax"` and not "none".
 *
 * The browser needs to send the session cookie on the top-level navigation back from the account
 * system, which "lax" allows and "strict" does not. "none" would allow it on any cross-site request
 * including a form post from an attacker's page, which is the CSRF this does not need to accept.
 */
const cookie = (key: string, value: string, maxAge: number): RRSetCookie => ({
  key,
  value,
  maxAge,
  path: COOKIE_PATH,
  sameSite: "lax",
  httpOnly: true,
  secure: true,
});
const clearCookie = (key: string) => cookie(key, "", 0);

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** The table is keyed by this, never by the id the browser holds. */
const hashSessionId = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex");

const FlowSchema = v.object({ state: v.string(), verifier: v.string(), nonce: v.string() });
type Flow = v.InferOutput<typeof FlowSchema>;

function readFlow(cookies: Record<string, string>): Flow | null {
  const raw = cookies[FLOW_COOKIE];
  if (!raw) return null;
  try {
    const parsed = v.safeParse(
      FlowSchema,
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* What the browser receives                                                  */
/* -------------------------------------------------------------------------- */

export type SessionView = {
  accessToken: string;
  /** When accessToken expires (ms). The browser asks for the next one shortly before. */
  expiresAt: number;
  user: {
    sub: string;
    email: string;
    name: string;
    /**
     * Whether this account may open NEOTMS at all - the coarse tier only.
     *
     * Decides nothing: it is here so the browser can show "you do not have access to this system"
     * instead of a blank screen. Every request is checked again on its own (NeotmsAuthGuard), and
     * what the user may actually *do* comes from /api/v0/me.
     */
    canAccess: boolean;
  };
};

async function toView(accessToken: string, sub: string, expiresAt: number): Promise<SessionView> {
  const account = await lookupAccount(accessToken, sub);
  return {
    accessToken,
    expiresAt,
    user: {
      sub,
      email: account.email,
      name: account.name,
      canAccess: account.authorities.includes(NeotmsEnv.NEOTMS_APP_AUTHORITY_ID),
    },
  };
}

/** "The session is gone; sign in again." Also drops the cookie so the browser stops presenting it. */
const signedOut = (reason: string): ResponseData<string> => ({
  status: 401,
  body: reason,
  cookies: [clearCookie(SESSION_COOKIE)],
});

const NO_STORE = { "Cache-Control": "no-store" };

const NOT_CONFIGURED: ResponseData<string> = {
  status: 500,
  body: "The server is not configured for authentication",
};

/** An OAuth error code, when the account system answered with one. */
function oauthError(err: unknown): string | null {
  if (err instanceof client.ResponseBodyError || err instanceof client.AuthorizationResponseError) {
    return err.error;
  }
  return null;
}

/**
 * The account system failed on its side: `server_error`, or any 5xx. openid-client only reads an
 * OAuth error code out of a 4xx, so a 500 carrying `server_error` arrives as a bare status.
 */
function isServerFailure(err: unknown): boolean {
  if (oauthError(err) === "server_error") return true;
  return (
    err instanceof client.ClientError && err.cause instanceof Response && err.cause.status >= 500
  );
}

/* -------------------------------------------------------------------------- */
/* GET /api/auth/login                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Send the browser to the account system's /authorize.
 *
 * A fresh verifier, state and nonce for every attempt (§9). If the user is already signed in to
 * another Lion Korea app, /authorize comes straight back with a code and no login screen is shown -
 * that is SSO working, not a bug.
 */
export async function startLogin(): Promise<ResponseData<string>> {
  if (!isAuthConfigComplete()) {
    console.error("The authentication settings are incomplete; cannot start a sign-in.");
    return NOT_CONFIGURED;
  }

  let config: client.Configuration;
  try {
    config = await oidcConfig();
  } catch (err) {
    console.error(`The account system's discovery document could not be read : ${err}`);
    // This is a top-level navigation, so a bare 502 would strand the user on an error page. Send
    // them back to the app, which reads the error and offers to try again.
    const back = new URL(NeotmsEnv.NEOTMS_OIDC_REDIRECT_URI);
    back.searchParams.set("error", "temporarily_unavailable");
    return { status: 302, headers: { Location: back.href, ...NO_STORE }, body: "" };
  }

  const flow: Flow = {
    state: client.randomState(),
    verifier: client.randomPKCECodeVerifier(),
    nonce: client.randomNonce(),
  };
  const authorizeUrl = client.buildAuthorizationUrl(config, {
    redirect_uri: NeotmsEnv.NEOTMS_OIDC_REDIRECT_URI,
    scope: SCOPE,
    code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
    code_challenge_method: "S256",
    state: flow.state,
    nonce: flow.nonce,
  });

  return {
    status: 302,
    headers: { Location: authorizeUrl.href, ...NO_STORE },
    body: "",
    cookies: [
      cookie(FLOW_COOKIE, base64url(Buffer.from(JSON.stringify(flow), "utf8")), FLOW_TTL_SEC),
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* POST /api/auth/session                                                     */
/* -------------------------------------------------------------------------- */

const CallbackSchema = v.object({
  /** The query string the browser arrived with on the redirect URI, "?code=…&state=…". */
  callback: v.pipe(v.string(), v.maxLength(4096)),
});

/**
 * Finish a sign-in: exchange the code, and open a session.
 *
 * openid-client checks the state against the one this browser was given (that check is what stops
 * an attacker's code being planted in the callback), sends the verifier, and validates the id
 * token's issuer, audience and nonce.
 *
 * Note what this does NOT do: it does not require a NEOTMS staff row. A signed-in account with no
 * staff row gets a session and a 403 from the first API call, which is the state an administrator
 * can act on. Refusing the session instead would leave the user looping through a sign-in that
 * keeps succeeding and keeps ending nowhere.
 */
export async function completeLogin(
  request: RequestData,
): Promise<ResponseData<SessionView | string>> {
  if (!isAuthConfigComplete()) {
    console.error("The authentication settings are incomplete; cannot complete a sign-in.");
    return NOT_CONFIGURED;
  }

  // The flow is single-use whatever happens: the code it was for can only be exchanged once.
  const clearFlow = clearCookie(FLOW_COOKIE);

  const body = v.safeParse(CallbackSchema, request.body);
  if (!body.success) return { status: 400, body: "The callback is missing", cookies: [clearFlow] };

  const flow = readFlow(request.cookies);
  if (!flow) {
    return {
      status: 400,
      body: "The sign-in attempt has expired. Please try again.",
      cookies: [clearFlow],
    };
  }

  const callbackUrl = new URL(NeotmsEnv.NEOTMS_OIDC_REDIRECT_URI);
  callbackUrl.search = body.output.callback;

  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
  try {
    tokens = await client.authorizationCodeGrant(await oidcConfig(), callbackUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
  } catch (err) {
    console.error(`A sign-in could not be completed : ${err}`);
    const code = oauthError(err);
    return {
      status: isServerFailure(err) || code === "temporarily_unavailable" ? 502 : 400,
      body: code ? `The sign-in failed (${code})` : "The sign-in failed",
      cookies: [clearFlow],
    };
  }

  if (!tokens.refresh_token) {
    console.error("The token response carried no refresh token");
    return { status: 502, body: "The sign-in failed", cookies: [clearFlow] };
  }

  let verified;
  try {
    verified = await verifyAccessToken(tokens.access_token);
  } catch (err) {
    console.error(`The access token from the code exchange was rejected : ${err}`);
    return { status: 502, body: "The sign-in failed", cookies: [clearFlow] };
  }

  const now = Date.now();
  const sessionId = base64url(randomBytes(32));
  const session: NeotmsSession = {
    sub: verified.sub,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessExpiresAt: verified.expiresAt,
    created: now,
    lockUntil: 0,
  };
  await dynamoDBPut(NeotmsSessionPutOps(hashSessionId(sessionId), session, now + SESSION_TTL_MS));

  return {
    status: 200,
    headers: NO_STORE,
    body: await toView(session.accessToken, session.sub, session.accessExpiresAt),
    cookies: [clearFlow, cookie(SESSION_COOKIE, sessionId, Math.floor(SESSION_TTL_MS / 1000))],
  };
}

/* -------------------------------------------------------------------------- */
/* POST /api/auth/refresh                                                     */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isFresh = (session: NeotmsSession, now: number) =>
  session.accessExpiresAt - now > REFRESH_AHEAD_MS;

/**
 * The current access token for this session, rotating the refresh token when it runs short.
 *
 * Also how a reloaded page signs back in: the access token lived only in that page's memory, but
 * the session cookie survives the reload.
 *
 * Refreshes are serialised per session (§4.3): a token still fresh enough is handed out as-is, so
 * tabs share one; otherwise one caller takes the lease and rotates, and anyone else waits for the
 * token it stores.
 */
export async function refreshSession(
  request: RequestData,
): Promise<ResponseData<SessionView | string>> {
  const sessionId = request.cookies[SESSION_COOKIE];
  if (!sessionId) return signedOut("Not signed in");
  if (!isAuthConfigComplete()) {
    console.error("The authentication settings are incomplete; cannot refresh.");
    return NOT_CONFIGURED;
  }
  const sessionHash = hashSessionId(sessionId);

  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const session = (await dynamoDBGet(NeotmsSessionGetOps(sessionHash))).data;
    if (!session) return signedOut("The session has ended");

    const now = Date.now();
    if (isFresh(session, now)) {
      return {
        status: 200,
        headers: NO_STORE,
        body: await toView(session.accessToken, session.sub, session.accessExpiresAt),
      };
    }

    try {
      await dynamoDBUpdate(NeotmsSessionLockOps(sessionHash, now, now + LOCK_LEASE_MS));
    } catch (err) {
      if (!isConditionalCheckFailure(err)) throw err;
      // Someone else is rotating (or the session just ended - the next read tells which).
      if (Date.now() > deadline) {
        return {
          status: 503,
          headers: { "Retry-After": "1" },
          body: "A refresh is already in progress",
        };
      }
      await sleep(LOCK_POLL_MS);
      continue;
    }

    // The lease is ours. The session read above may predate a rotation that finished just before we
    // took it, so read again rather than rotating a token that is already gone.
    const current = (await dynamoDBGet(NeotmsSessionGetOps(sessionHash))).data;
    if (!current) return signedOut("The session has ended");
    if (isFresh(current, Date.now())) {
      await dynamoDBUpdate(NeotmsSessionUnlockOps(sessionHash));
      return {
        status: 200,
        headers: NO_STORE,
        body: await toView(current.accessToken, current.sub, current.accessExpiresAt),
      };
    }
    return rotate(sessionHash, current);
  }
}

async function rotate(
  sessionHash: string,
  session: NeotmsSession,
): Promise<ResponseData<SessionView | string>> {
  let tokens: Awaited<ReturnType<typeof client.refreshTokenGrant>> | null = null;
  // Only server_error is worth one more try (§4.3). invalid_grant never is.
  for (let attempt = 0; attempt < 2 && !tokens; attempt++) {
    try {
      tokens = await client.refreshTokenGrant(await oidcConfig(), session.refreshToken);
    } catch (err) {
      const code = oauthError(err);
      if (code === "invalid_grant") {
        // Expired, revoked, signed out elsewhere, or the account was evicted. Sign out. Retrying
        // would present the same spent token again, which the account system reads as theft.
        await dynamoDBDelete(NeotmsSessionDeleteOps(sessionHash));
        return signedOut("The session has ended");
      }
      if (isServerFailure(err) && attempt === 0) continue;
      console.error(`A refresh failed : ${err}`);
      await dynamoDBUpdate(NeotmsSessionUnlockOps(sessionHash)).catch(() => undefined);
      return { status: 502, body: "The refresh failed" };
    }
  }
  if (!tokens) {
    await dynamoDBUpdate(NeotmsSessionUnlockOps(sessionHash)).catch(() => undefined);
    return { status: 502, body: "The refresh failed" };
  }

  let verified;
  try {
    verified = await verifyAccessToken(tokens.access_token);
  } catch (err) {
    console.error(`The access token from a refresh was rejected : ${err}`);
    await dynamoDBUpdate(NeotmsSessionUnlockOps(sessionHash)).catch(() => undefined);
    return { status: 502, body: "The refresh failed" };
  }

  // Every refresh rotates the refresh token; the old one is now spent, so the new one must be the
  // one stored. (Should a response ever omit it, the old one is all there is.)
  const refreshToken = tokens.refresh_token ?? session.refreshToken;
  await dynamoDBUpdate(
    NeotmsSessionRotateOps(sessionHash, refreshToken, tokens.access_token, verified.expiresAt),
  );
  return {
    status: 200,
    headers: NO_STORE,
    body: await toView(tokens.access_token, verified.sub, verified.expiresAt),
  };
}

/* -------------------------------------------------------------------------- */
/* POST /api/auth/logout                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Forget the session here, and hand back the URL that ends the SSO session.
 *
 * Clearing our own cookie is not a logout (§4.5): the SSO session would survive, and the next
 * /authorize would sign the user straight back in with no prompt - which, on a shared machine in an
 * office, is the whole problem. The browser has to navigate to /logout, which ends the session for
 * every integrated app and returns to the registered logout URL.
 */
export async function endSession(
  request: RequestData,
): Promise<ResponseData<{ logoutUrl: string }>> {
  const sessionId = request.cookies[SESSION_COOKIE];
  let config: client.Configuration | null = null;
  try {
    config = await oidcConfig();
  } catch (err) {
    console.error(`The account system's discovery document could not be read : ${err}`);
  }

  if (sessionId) {
    const sessionHash = hashSessionId(sessionId);
    const session = (await dynamoDBGet(NeotmsSessionGetOps(sessionHash))).data;
    if (session && config) {
      // Revoking is tidy rather than essential - /logout ends the chain too - so a failure here
      // must not stand in the way of signing out.
      await client
        .tokenRevocation(config, session.refreshToken, { token_type_hint: "refresh_token" })
        .catch((err) => console.error(`The refresh token could not be revoked : ${err}`));
    }
    await dynamoDBDelete(NeotmsSessionDeleteOps(sessionHash));
  }

  const logoutUrl = config
    ? client.buildEndSessionUrl(config, {
        post_logout_redirect_uri: NeotmsEnv.NEOTMS_OIDC_POST_LOGOUT_REDIRECT_URI,
      })
    : (() => {
        // Without discovery, fall back to the documented endpoint (§11) so logout still works.
        const url = new URL(`${NeotmsEnv.NEOTMS_OIDC_ISSUER}/lpx/oauth/logout`);
        url.searchParams.set("client_id", NeotmsEnv.NEOTMS_AUTH_CLIENT_ID);
        url.searchParams.set(
          "post_logout_redirect_uri",
          NeotmsEnv.NEOTMS_OIDC_POST_LOGOUT_REDIRECT_URI,
        );
        return url;
      })();

  return {
    status: 200,
    headers: NO_STORE,
    body: { logoutUrl: logoutUrl.href },
    cookies: [clearCookie(SESSION_COOKIE)],
  };
}

/** Test-only: forget the discovered configuration. */
export function _resetSessionManager(): void {
  configPromise = null;
}
