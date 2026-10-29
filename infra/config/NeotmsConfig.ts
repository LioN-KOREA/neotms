// SPDX-License-Identifier: MIT
//
// Per-stage settings for the NEOTMS stack.
//
// Everything that differs between the development and the production deployment lives here, so the
// constructs themselves never read context or branch on a stage name. Two rules this file exists to
// enforce:
//
//   1. Nothing that is a secret appears here. The OIDC client is public (PKCE, no client secret -
//      see 연동 안내서 §2), the database credential is generated into Secrets Manager by CDK, and the
//      Mailgun key is read at cold start from Secrets Manager by name.
//   2. No wildcard CORS origin, not even in development. An over-broad origin on a cookie-bearing
//      API is a session-theft primitive, and "we will tighten it later" never happens.

/**
 * Aurora Serverless v2 capacity, in ACUs.
 *
 * `0` is a real setting on Aurora Serverless v2 and it is the whole cost argument: the cluster
 * genuinely stops billing compute while idle (storage and backups still bill). The reason the
 * staffed-hours floor is NOT zero is latency, not money - a cluster resuming from zero answers the
 * first statement with `DatabaseResumingException` and takes a handful of seconds to come back. That
 * is acceptable at 03:00 and is not acceptable when a PM opens a project list.
 *
 * The window below is NOT office hours, and the naming is deliberate. Official hours are 09:00-18:00
 * (Q11), but project managers arrive as early as 06:30 and work as late as 23:00, so a floor that
 * tracks the official day stalls real people on both ends of it - and a stall is indistinguishable
 * from a broken system to the person waiting. `staffedHours` is therefore the ENVELOPE of when any
 * human might be working, 06:00-00:00 every day, which costs ~$55/month of compute against ~$73 for
 * a flat floor and ~$20 for the 09:00-18:00 Mon-Fri window it replaces. The $35 is buying the
 * absence of a support call nobody can reproduce.
 *
 * See NeotmsAcuScheduler: EventBridge moves the floor between these two numbers.
 */
export interface NeotmsCapacityConfig {
  /** ACU floor while anyone might be working. 0.5 is the smallest non-zero step. */
  readonly staffedHoursMinAcu: number;
  /** ACU floor outside those hours. 0 lets the cluster pause. */
  readonly offHoursMinAcu: number;
  /** Ceiling. Reached only by reporting queries; the floor is what drives the bill. */
  readonly maxAcu: number;
  /**
   * Idle seconds before a cluster at a zero floor actually pauses. Only meaningful while the floor
   * is 0; Aurora requires 300-86400.
   *
   * Left at 15 minutes rather than the 300-second minimum even though the zero-floor window is now
   * only six hours long. Shortening it would save well under a dollar a month, and it would cost a
   * resume stall to exactly the person least able to absorb one - someone working at 02:00 against a
   * deadline, whose ten-minute gap between saves would no longer keep the cluster warm.
   */
  readonly secondsUntilAutoPause: number;
  /** Cron hour (KST) at which the floor is raised. 6, i.e. ahead of the earliest arrival (06:30). */
  readonly staffedHoursStartHourKst: number;
  /**
   * Cron hour (KST) at which the floor is dropped back to `offHoursMinAcu`.
   *
   * 0, meaning midnight - so the window wraps the date boundary and the two cron expressions are
   * `0 6 * * ? *` and `0 0 * * ? *`. It cannot be written as `24`: EventBridge cron hours are 0-23
   * and the schedule would be rejected at deploy time.
   */
  readonly staffedHoursEndHourKst: number;
}

export interface NeotmsAuthConfig {
  /**
   * The account system's OIDC issuer, no trailing slash. Discovery, the JWKS and
   * `/lpx/auth/userInfo` all hang off it, and it is asserted as every access token's `iss`.
   */
  readonly oidcIssuer: string;
  /** This app's client id at the account system. Asserted as every access token's `aud`. */
  readonly authClientId: string;
  /**
   * Where the account system sends the browser back with the code. Must be byte-identical to a
   * redirect URI registered on the client - scheme, host, path and trailing slash all count.
   *
   * This is a path the FRONTEND router serves (`/auth/callback`), not an API route. The browser
   * lands there, the SPA reads the query string and posts it to `/api/auth/session`. A redirect URI
   * pointing at the API instead would mean the backend had to answer a top-level navigation with
   * HTML, which is how a single-page app grows a server-rendered page nobody maintains.
   */
  readonly oidcRedirectUri: string;
  /**
   * Where the browser lands after signing out. Must be registered on the client as a logout URL.
   *
   * Also a frontend route (`/auth/logout`), and deliberately not `/`. Landing on the app root after
   * a logout means the app immediately tries to bootstrap a session, fails, and shows the sign-in
   * screen - which on a shared office machine is indistinguishable from "the logout did not work".
   * A dedicated route can say "you are signed out" and nothing else.
   */
  readonly oidcPostLogoutRedirectUri: string;
  /**
   * The coarse authority an LPX account must hold to reach this API at all.
   *
   * This is tier one of two. Holding it means "may open NEOTMS"; it says nothing about which menus
   * or which rows, which is decided from the staff row's role and view scope (see §6.2 and Q9).
   */
  readonly appAuthorityId: string;
}

export interface NeotmsMailConfig {
  /** Secrets Manager secret holding the Mailgun API key. Read at cold start, never an env var. */
  readonly mailgunSecretName: string;
  readonly mailgunEmailDomain: string;
  readonly mailFromAddress: string;
  readonly mailFromName: string;
}

export interface NeotmsStageConfig {
  readonly stage: string;
  /** Prefix for every physical resource name, so two stages can share an account if it comes to that. */
  readonly resourcePrefix: string;
  readonly account?: string;
  readonly region: string;
  /**
   * Origins allowed to call the API with credentials. Exact origins only - no wildcards, ever.
   *
   * This list is what a DEVELOPER's browser is served from. The deployed console's own origin is
   * NOT listed here and does not need to be: NeotmsSite appends the CloudFront domain to the
   * function's environment once the distribution exists, because that domain is only known after
   * synthesis. See the comment on `NeotmsSite.allowOwnOriginOnApi`.
   */
  readonly allowedOriginUrls: string[];
  readonly capacity: NeotmsCapacityConfig;
  readonly auth: NeotmsAuthConfig;
  readonly mail: NeotmsMailConfig;
  /**
   * How long CloudWatch keeps logs before the subscription hands them to S3, and how long S3 keeps
   * them in Standard before Glacier. Q14 asked for six months hot, archive after that.
   */
  readonly logRetentionDays: number;
  readonly logGlacierAfterDays: number;
  /**
   * Whether `RemovalPolicy.RETAIN` plus deletion protection apply. Off in development so a stack can
   * be torn down; on in production so a bad `cdk destroy` cannot take the database with it.
   */
  readonly protectData: boolean;
}

const SEOUL = "ap-northeast-2";

/**
 * The LPX authority an account must hold to open NEOTMS at all.
 *
 * Shared by both stages, which is not an oversight. This is an authority registered on the ACCOUNT
 * system and it names a capability - "may use the TMS" - not a property of a deployment. The same
 * person who may open production is the person who may open the development stack; what differs
 * between stages is the OIDC *client*, because that is what the redirect URIs hang off.
 *
 * Not a secret, and not guessable: it is a UUID issued by LPX. It is also not something this repo
 * may invent - LPX compares it verbatim against the strings in `data.authorities` from
 * `/lpx/auth/userInfo`, so a typo here denies every account with a 403 that looks like a
 * permissions decision. Override it with `-c appAuthorityId=...` if LPX ever reissues it.
 */
const TMS_ACCESS_AUTHORITY_ID = "527c4c39-be80-4f70-8f3e-a334b809ce10";

/**
 * Shared capacity profile.
 *
 * Both stages use the same shape, which is arguably wrong now and is left alone deliberately. At
 * $0.20 per ACU-hour in Seoul an 18-hour floor costs ~$55/month, and the development cluster has no
 * early-arriving PM to protect - 09:00-18:00 Mon-Fri would do, at a third of the price. The reason
 * to keep them identical is that the schedule is the thing most likely to be blamed for a
 * "production is slow" report, and a dev stack that cannot reproduce production's pause behaviour
 * cannot be used to rule it out. Split them if the dev cluster's bill ever becomes the problem.
 */
const CAPACITY: NeotmsCapacityConfig = {
  staffedHoursMinAcu: 0.5,
  offHoursMinAcu: 0,
  maxAcu: 4,
  secondsUntilAutoPause: 900,
  staffedHoursStartHourKst: 6,
  staffedHoursEndHourKst: 0,
};

export const NEOTMS_CONFIGS: Record<string, NeotmsStageConfig> = {
  dev: {
    stage: "dev",
    resourcePrefix: "neotms-dev",
    region: SEOUL,
    allowedOriginUrls: ["http://localhost:5173"],
    capacity: CAPACITY,
    auth: {
      oidcIssuer: "https://accounts.lion-korea.it.kr",
      /*
       * Registered on the LPX server against the two localhost URIs below.
       *
       * A client id is not a secret - it travels in the query string of every /authorize, which is
       * why a public PKCE client has no secret at all - so it belongs in version control next to
       * the URIs it was registered with. Keeping the three together is the point: they only work as
       * a set, and a mismatch between them is reported by the account system as an opaque
       * `invalid_request`.
       */
      authClientId: "QP6B8rMvAnw8fOWXHP3A3qTGz",
      oidcRedirectUri: "http://localhost:5173/auth/callback",
      oidcPostLogoutRedirectUri: "http://localhost:5173/auth/logout",
      appAuthorityId: TMS_ACCESS_AUTHORITY_ID,
    },
    mail: {
      mailgunSecretName: "neotms-dev/mailgun",
      mailgunEmailDomain: "",
      mailFromAddress: "",
      mailFromName: "라이온코리아 TMS",
    },
    logRetentionDays: 30,
    logGlacierAfterDays: 90,
    protectData: false,
  },
  prod: {
    stage: "prod",
    resourcePrefix: "neotms",
    region: SEOUL,
    // Filled in once the production hostname is decided. Deliberately left empty rather than
    // defaulted to something permissive: an empty list fails closed, a wildcard fails open.
    allowedOriginUrls: [],
    capacity: CAPACITY,
    auth: {
      oidcIssuer: "https://accounts.lion-korea.it.kr",
      /*
       * Production needs its OWN client registration, not the development one.
       *
       * The development client's redirect URIs are both `http://localhost:5173/...`. Adding the
       * production CloudFront URI to that same client would mean an attacker who can get a code
       * issued to it could redeem it against a redirect URI on localhost - which is a real attack
       * on any developer machine running the dev server. Two clients, two URI sets.
       *
       * Left empty until the production hostname is decided, because `isAuthConfigComplete()` in
       * the Lambda refuses to start a sign-in with blanks. That is the right failure: a 500 that
       * says "the server is not configured for authentication" beats a sign-in that silently
       * redirects to the wrong app.
       */
      authClientId: "",
      oidcRedirectUri: "",
      oidcPostLogoutRedirectUri: "",
      /*
       * The authority is the one thing in this block that is already known for production.
       *
       * It is the same capability regardless of stage (see TMS_ACCESS_AUTHORITY_ID), so leaving it
       * blank here would mean a production deploy that is correctly configured in every other
       * respect still answers 500 "not configured" - for a value nobody has to decide.
       */
      appAuthorityId: TMS_ACCESS_AUTHORITY_ID,
    },
    mail: {
      mailgunSecretName: "neotms/mailgun",
      mailgunEmailDomain: "",
      mailFromAddress: "",
      mailFromName: "라이온코리아 TMS",
    },
    // Six months hot in CloudWatch, then the archive copy ages into Glacier (Q14).
    logRetentionDays: 180,
    logGlacierAfterDays: 180,
    protectData: true,
  },
};

/* -------------------------------------------------------------------------- */
/* Context overrides                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The auth settings that may be overridden at synth time with `-c key=value`.
 *
 * These five are exactly the values that are REGISTERED SOMEWHERE ELSE - on the LPX server - rather
 * than chosen here. That is the criterion for being on this list, and it is why capacity, log
 * retention and bucket names are not: those are decisions this repo owns, so changing them should be
 * a reviewed commit, not a flag somebody typed once.
 *
 * The practical case is a production deploy. Production deliberately ships `authClientId` and both
 * URIs empty, because they depend on a hostname that is not decided yet; without an override the
 * only way to deploy is to commit a value, deploy, and commit it again if it was wrong. Note that
 * `authClientId` and the two URIs only work as a SET - LPX reports any mismatch between them as an
 * opaque `invalid_request` - so overriding one usually means overriding all three.
 *
 * `satisfies` rather than a plain annotation so a typo here is a compile error against
 * `NeotmsAuthConfig` instead of a silently ignored context key.
 */
export const NEOTMS_AUTH_CONTEXT_KEYS = [
  "authClientId",
  "appAuthorityId",
  "oidcRedirectUri",
  "oidcPostLogoutRedirectUri",
  "oidcIssuer",
] as const satisfies readonly (keyof NeotmsAuthConfig)[];

export type NeotmsAuthContextKey = (typeof NEOTMS_AUTH_CONTEXT_KEYS)[number];

/**
 * Anything that can answer a context lookup.
 *
 * `app.node` satisfies this. Declaring the one method instead of importing `constructs.Node` keeps
 * this file free of a CDK import, so it stays readable as plain configuration and is trivial to
 * exercise from a test with an object literal.
 */
export interface NeotmsContextLookup {
  tryGetContext(key: string): unknown;
}

/**
 * One context value, or `undefined` to keep the stage default.
 *
 * Context reaches a CDK app from four places, only one of which is a command line: `-c` flags,
 * the `context` block in cdk.json, cdk.context.json, and `CDK_CONTEXT_JSON`. The cdk.json block is
 * where the type check earns its keep - it is a wall of feature flags whose values are all `true`,
 * so a key added there by analogy with its neighbours is a realistic mistake. Written into the
 * Lambda's environment a boolean arrives as the string `"true"`, which is non-empty, so
 * `isAuthConfigComplete()` would pass and every account would then be refused access.
 *
 * Note what this canNOT catch: `cdk deploy -c appAuthorityId` with the `=value` forgotten. The CLI
 * drops a valueless flag entirely (verified against aws-cdk 2.1146), so it arrives here as
 * `undefined` and is indistinguishable from not passing it at all - the stage default applies. That
 * is quiet, but it is also the safe direction, since the committed default is a real authority.
 */
function readAuthOverride(
  context: NeotmsContextLookup | undefined,
  key: NeotmsAuthContextKey,
): string | undefined {
  const raw = context?.tryGetContext(key);
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw !== "string") {
    throw new Error(
      `Context "${key}" must be a string but was ${typeof raw} (${JSON.stringify(raw)}). ` +
        `Write it as -c ${key}=VALUE; "-c ${key}" on its own sets it to true.`,
    );
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(
      `Context "${key}" was empty. Omit it entirely to use the stage default, rather than ` +
        `passing a blank - a blank would disable authentication checks that depend on it.`,
    );
  }
  return trimmed;
}

/**
 * The config for a stage, with any `-c` overrides applied to the auth block.
 *
 *   cdk deploy                                     dev, as committed
 *   cdk deploy -c stage=prod \                      production, auth supplied at deploy time
 *     -c authClientId=... \
 *     -c oidcRedirectUri=https://tms.example/auth/callback \
 *     -c oidcPostLogoutRedirectUri=https://tms.example/auth/logout
 *
 * Returns a COPY. `NEOTMS_CONFIGS` is module state shared by every caller including the tests, so
 * applying overrides in place would make one synth leak into the next.
 */
export function resolveStageConfig(
  stage: string | undefined,
  context?: NeotmsContextLookup,
): NeotmsStageConfig {
  const key = stage ?? "dev";
  const config = NEOTMS_CONFIGS[key];
  if (!config) {
    throw new Error(
      `Unknown stage "${key}". Pass one of: ${Object.keys(NEOTMS_CONFIGS).join(", ")} (cdk deploy -c stage=prod).`,
    );
  }

  // `-readonly` so the loop below can assign; every field of NeotmsAuthConfig is a string, so one
  // keyed assignment covers all of them without a cast.
  const auth: { -readonly [K in keyof NeotmsAuthConfig]: NeotmsAuthConfig[K] } = { ...config.auth };
  for (const contextKey of NEOTMS_AUTH_CONTEXT_KEYS) {
    const override = readAuthOverride(context, contextKey);
    if (override !== undefined) auth[contextKey] = override;
  }

  return { ...config, auth };
}
