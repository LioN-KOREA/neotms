// SPDX-License-Identifier: MIT
//
// Per-stage settings for the NEOTMS stack.
//
// Everything that differs between the development and the production deployment lives here, so the
// constructs themselves never read context or branch on a stage name. Two rules this file exists to
// enforce:
//
//   1. Nothing that is a secret appears here. The OIDC client is public (PKCE, no client secret -
//      see the account-system integration guide §2), the database password is held in and the
//      Mailgun key is read at cold start from Secrets Manager by name.
//   2. No wildcard CORS origin, not even in development. An over-broad origin on a cookie-bearing
//      API is a session-theft primitive, and "we will tighten it later" never happens.

/**
 * Where the Supabase project is and how to address its pooler.
 *
 * Unlike every other block in this file, most of these values are NOT this repo's decisions - they
 * are assigned by Supabase when the project is created, which is why they are on the context
 * override list below alongside the OIDC client. In particular the pooler hostname cannot be
 * computed: the leading index in `aws-0-...` is assigned per project, and Supabase's own
 * documentation says to copy the host out of the dashboard's Connect dialog. Guessing `aws-0` and
 * deploying produces an ENOTFOUND from inside the connection pool, several frames away from the
 * setting that caused it.
 */
export interface NeotmsSupabaseConfig {
  /**
   * The project reference, the 20-character string in the dashboard URL.
   *
   * Not a secret - it is in the project's public API URL - but it is the one value everything else
   * is keyed on, including the pooler username (`postgres.<ref>`) and the secret's name.
   */
  readonly projectRef: string;
  /**
   * The Supavisor host, e.g. `aws-0-ap-northeast-2.pooler.supabase.com`. Copy it from the
   * dashboard; see the note above on why it cannot be derived.
   */
  readonly poolerHost: string;
  /**
   * 6543, the transaction-mode port.
   *
   * A repo decision rather than an override, because it is not really a free choice. Session mode
   * (5432 on the pooler) holds a server connection for the whole life of a client connection, and a
   * Lambda whose reserved concurrency exceeds the project's connection limit would exhaust the pool
   * under load; the direct endpoint, also 5432, resolves to IPv6 only without the paid add-on and a
   * Lambda outside a VPC has no IPv6 egress. Transaction mode is the only option that works here,
   * and the price is paid in PostgresUtils.ts: no prepared statements, no session state.
   */
  readonly poolerPort: number;
  /** `postgres`. Supabase does not create a per-application database; schemas separate concerns. */
  readonly databaseName: string;
  /**
   * PEM of the project CA, to pin TLS. Empty means TLS without certificate verification.
   *
   * Empty is the default because it is what Supabase's own copy-paste connection strings do, and
   * because an expired or rotated CA pinned here fails as a total outage. Download the certificate
   * from the dashboard and paste it in once someone is willing to own that rotation.
   */
  readonly caCertPem: string;
}

/**
 * The pooler username for a project ref.
 *
 * `postgres.<ref>`, not the bare `postgres`: Supavisor routes on the tenant encoded in the
 * username, so the bare name is only valid against the direct endpoint. Returns empty for an empty
 * ref so that `isDatabaseConfigComplete()` in the Lambda fails closed rather than the function
 * attempting to log in as the literal user `postgres.`.
 */
export function poolerUser(projectRef: string): string {
  return projectRef ? `postgres.${projectRef}` : "";
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
   * Also a frontend route (`/auth/logout`), and deliberately not `/`. Landing on the app root
   * after a logout means the app immediately tries to bootstrap a session, fails, and shows the
   * sign-in screen - which on a shared office machine is indistinguishable from "the logout did not
   * work". A dedicated route can say "you are signed out" and nothing else.
   */
  readonly oidcPostLogoutRedirectUri: string;
  /**
   * The coarse authority an LPX account must hold to reach this API at all.
   *
   * This is tier one of two. Holding it means "may open NEOTMS"; it says nothing about which menus
   * or which rows, which is decided from the staff row's role and view scope (see §6.2 and Q9).
   */
  readonly appAuthorityId: string;
  /**
   * The LPX authority that may let itself in and provision the first NEOTMS staff row.
   *
   * NEOTMS ships with an empty database, and an empty database cannot be signed into: the guard
   * refuses an identity that has no `staff` row, and no API route creates one. This authority is
   * the way in - a holder gets a staff row minted with the NEOTMS_SYSADMIN role on first sign-in.
   * See db/006_bootstrap.sql.
   *
   * SET IT TO `""` TO REMOVE THE BACK DOOR once real administrators exist. Empty is a supported
   * value, not a missing one: the Lambda's `isAuthConfigComplete()` does not check this field, so a
   * blank disables the bootstrap without taking the API down. That is the whole reason it is a
   * configured value at all rather than a constant in the Lambda.
   */
  readonly bootstrapAuthorityId: string;
}

export interface NeotmsMailConfig {
  /**
   * Secrets Manager secret holding the Mailgun credentials as JSON: `{"apiKey": "...", "domain": "..."}`.
   * Both the key and the sending domain are read from it at runtime (NeotmsMailgunSecret.ts) - the
   * domain is deliberately not a config value, so the pair is always rotated and copied together.
   * Created by hand, like the KEXIM key; the API function is granted read on exactly this name.
   */
  readonly mailgunSecretName: string;
  /** Envelope sender for system mail. Blank means `no-reply@<domain from the secret>`. */
  readonly mailFromAddress: string;
  readonly mailFromName: string;
}

export interface NeotmsFxConfig {
  /**
   * Secrets Manager secret holding the Korea Export-Import Bank API key.
   *
   * The NAME is configuration; the key never is. See NeotmsFxSecret.ts - a Lambda environment
   * variable is readable by anyone with `lambda:GetFunction` and appears in the CloudFormation
   * template, so the same rule the database password follows applies here.
   *
   * THE SECRET IS CREATED OUT OF BAND, not by this app. It holds one credential issued to a person,
   * not a resource this stack owns, and CDK cannot be given a value it must not see. That is why
   * NeotmsFxRate grants on an ARN it BUILDS from this name rather than on a `Secret` construct, and
   * why an absent secret is a warning in the fetcher's log rather than a failed deploy.
   *
   * Empty is a supported value: it disables the fetcher's read, every amount keeps reading from its
   * stored KRW figure, and nothing else changes. A freshly deployed stack is in exactly that state
   * until somebody populates the secret.
   */
  readonly secretName: string;
  /**
   * Minutes between fetch attempts.
   *
   * Five, which is not about the data - the upstream publishes once per business day, around 11:00
   * KST. It is about RECOVERY. A once-a-day schedule that happens to run while the upstream is down
   * leaves every report a day stale until tomorrow; at five minutes the same outage costs one
   * attempt. The cost of being wrong in this direction is 288 requests a day against a free
   * government API and ~287 upserts that rewrite the same numbers, which is why the write is an
   * upsert (see FxRateUpsertManyOps).
   */
  readonly scheduleMinutes: number;
}

/**
 * Where the CMK that wraps each person's Hiworks sign-in comes from (db/013).
 *
 * Three modes rather than an optional ARN, because an absent ARN would otherwise have to mean two
 * different things depending on the stage - "make your own" in production and "feature off"
 * everywhere else - and the construct would have to re-derive the stage policy to tell them apart.
 * Naming the modes keeps that decision here, and makes `shared` without an ARN unrepresentable.
 *
 *   * `own`    - the stack creates and owns the key. Production, and only production.
 *   * `shared` - the stack imports a key owned by another account and grants its function the two
 *                actions it needs. Non-production, where several deployments in several accounts
 *                share one database.
 *   * `off`    - no key, blank `NEOTMS_HIWORKS_KMS_KEY_ID`, feature disabled. The mail dialogs ask
 *                for credentials exactly as they did before db/013, so nothing degrades.
 *
 * ## Why non-production defaults to `off` rather than to `own`
 *
 * Because `own` is the broken configuration there. The non-production deployments share ONE
 * database, so a per-deployment key means deployment A wraps a data key under its own CMK, writes
 * the row, and deployment B - reading the same row - cannot decrypt it. B's user re-saves, the row
 * is re-wrapped under B's key, and now A is broken. That ping-pong is silent: each save breaks
 * somebody else's stored credential, and the only symptom is being asked to type a password again.
 *
 * So the default for a stage that shares a database is to store nothing at all, and sharing is
 * opt-in by naming the one key every deployment is to use.
 */
export type NeotmsHiworksKms =
  | { readonly mode: "own" }
  | { readonly mode: "shared"; readonly keyArn: string }
  | { readonly mode: "off" };

export interface NeotmsStageConfig {
  readonly stage: string;
  /** Prefix for every physical resource name, so two stages can share an account if it comes to that. */
  readonly resourcePrefix: string;
  readonly account?: string;
  readonly region: string;
  /**
   * Where the Hiworks credential CMK comes from. See `NeotmsHiworksKms`.
   *
   * Stated per stage rather than derived in the construct, so that "production owns its own key and
   * never takes an override" is visible in this file instead of being a convention in one `if`.
   * `resolveStageConfig` may upgrade a non-production stage from `off` to `shared`; it never
   * touches production's.
   */
  readonly hiworksKms: NeotmsHiworksKms;
  /**
   * Origins allowed to call the API with credentials. Exact origins only - no wildcards, ever.
   *
   * This list is what a DEVELOPER's browser is served from. The deployed console's own origin is
   * NOT listed here and does not need to be: NeotmsSite appends the CloudFront domain to the
   * function's environment once the distribution exists, because that domain is only known after
   * synthesis. See the comment on `NeotmsSite.allowOwnOriginOnApi`.
   */
  readonly allowedOriginUrls: string[];
  readonly supabase: NeotmsSupabaseConfig;
  readonly auth: NeotmsAuthConfig;
  readonly mail: NeotmsMailConfig;
  readonly fx: NeotmsFxConfig;
  /**
   * How long CloudWatch keeps logs before the subscription hands them to S3, and how long S3 keeps
   * them in Standard before Glacier. Q14 asked for six months hot, archive after that.
   */
  readonly logRetentionDays: number;
  readonly logGlacierAfterDays: number;
  /**
   * Whether `RemovalPolicy.RETAIN` plus deletion protection apply. Off in development so a stack
   * can be torn down; on in production so a bad `cdk destroy` cannot take the database with it.
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
 * LPX's own global administrator authority - the account that may bootstrap NEOTMS.
 *
 * A literal string rather than a UUID, unlike the authority above, and the difference is not
 * stylistic. LPX distinguishes SYSTEM authorities, which its own source code has to compare against
 * and which therefore carry stable hand-written ids in the `lpx.` namespace, from TENANT
 * authorities created through its admin API, which get a server-generated UUID precisely so that
 * nothing can hardcode one. `lpx.admin.access` is the first kind.
 *
 * COPIED, NOT IMPORTED, from `LPX_AUTHORITY_ADMIN_ACCESS` in
 * lambdas/common/layers/nodejs/configs/LpxAuthorities.ts. That file is LPX base code that NEOTMS
 * vendors but does not own: tsconfig.app.json excludes `lambdas/common` from the typecheck
 * entirely, because it imports Cognito and KMS SDK packages this project does not install. An
 * import here would therefore either fail to compile or drag those dependencies into a CDK app that
 * has no use for them. The duplication is three words long and the two files reference each other,
 * which is the cheaper trade.
 */
const LPX_ADMIN_ACCESS_AUTHORITY_ID = "lpx.admin.access";

/**
 * The parts of the Supabase block that are the same whatever project is being pointed at.
 *
 * Spread into each stage below, which then fills in `projectRef` and `poolerHost` - the two values
 * Supabase assigns. Both stages ship them EMPTY, for the same reason production's `authClientId` is
 * empty: there is no safe guess, and an empty value makes `isDatabaseConfigComplete()` answer 500
 * "not configured" instead of producing a DNS failure that reads as an outage. Supply them with
 * `-c supabaseProjectRef=... -c supabasePoolerHost=...`, or commit them once the projects exist.
 *
 * Note that the two stages want two different SUPABASE projects, not two schemas in one. Supabase
 * bills compute per project, and the free tier pauses a project after a week of inactivity - which
 * is tolerable for dev and is the whole reason prod is not on it.
 */
const SUPABASE_COMMON = {
  poolerPort: 6543,
  databaseName: "postgres",
  caCertPem: "",
} as const satisfies Partial<NeotmsSupabaseConfig>;

export const NEOTMS_CONFIGS: Record<string, NeotmsStageConfig> = {
  dev: {
    stage: "dev",
    resourcePrefix: "neotms-dev",
    region: SEOUL,
    /*
     * Off unless a shared key is named with `-c hiworksEncKeyArn=...`. See `NeotmsHiworksKms` for
     * why the default is "store nothing" rather than "make your own key": every dev deployment
     * shares one database, so a per-deployment key makes each save break somebody else's stored
     * credential.
     */
    hiworksKms: { mode: "off" },
    allowedOriginUrls: ["http://localhost:5173"],
    supabase: { ...SUPABASE_COMMON, projectRef: "", poolerHost: "" },
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
      bootstrapAuthorityId: LPX_ADMIN_ACCESS_AUTHORITY_ID,
    },
    mail: {
      mailgunSecretName: "neotms-dev/mailgun",
      mailFromAddress: "",
      mailFromName: "라이온코리아 TMS",
    },
    /*
     * The SAME secret name as production, which is deliberate and is the one place in this file
     * where the two stages deliberately share a resource.
     *
     * An FX rate is a fact about a currency, not about a deployment - there is no "development
     * exchange rate" - and the key is read-only against a public government API, so a development
     * stack reading it cannot affect production. The alternative, a second KEXIM registration,
     * means either the development stack has no rates at all (and the convert-to-KRW button cannot
     * be tested) or somebody maintains two keys for one public data feed.
     */
    fx: { secretName: "neotms/erapikey", scheduleMinutes: 5 },
    logRetentionDays: 30,
    logGlacierAfterDays: 90,
    protectData: false,
  },
  prod: {
    stage: "prod",
    resourcePrefix: "neotms",
    region: SEOUL,
    /*
     * Production owns its own key and never imports one. `resolveStageConfig` does not even READ
     * the override context for this stage, so there is no command line that points production at
     * a key in another account - which is the whole point of "definitive for prod". The shared key
     * exists because several non-production deployments share one database; production is the one
     * authoritative deployment against one database, so it has nothing to share with.
     */
    hiworksKms: { mode: "own" },
    // Filled in once the production hostname is decided. Deliberately left empty rather than
    // defaulted to something permissive: an empty list fails closed, a wildcard fails open.
    allowedOriginUrls: [],
    supabase: { ...SUPABASE_COMMON, projectRef: "", poolerHost: "" },
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
      /*
       * On in production too, which deserves a sentence rather than being noticed in review.
       *
       * The argument for leaving it off here is that production is where a back door costs the
       * most. The argument that wins is that production is also where the empty-database lockout is
       * unrecoverable: there is no API route and no screen that writes a `staff` row, so a
       * production stack deployed against a fresh Supabase project with this blank can only be
       * opened by someone with the database password and a psql client. That is not a safety
       * property, it is a different and worse failure.
       *
       * What makes it acceptable is that this grants nothing new. A holder of lpx.admin.access can
       * already read and rewrite LPX's authority tables, including which accounts hold
       * appAuthorityId - so they can already grant themselves NEOTMS access. The bootstrap only
       * saves them the step. Set it to "" once the staff table is populated; see
       * db/006_bootstrap.sql section 5.
       */
      bootstrapAuthorityId: LPX_ADMIN_ACCESS_AUTHORITY_ID,
    },
    mail: {
      mailgunSecretName: "neotms/mailgun",
      mailFromAddress: "",
      mailFromName: "라이온코리아 TMS",
    },
    fx: { secretName: "neotms/erapikey", scheduleMinutes: 5 },
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
 * than chosen here. That is the criterion for being on this list, and it is why the pooler port,
 * log retention and bucket names are not: those are decisions this repo owns, so changing them
 * should be a reviewed commit, not a flag somebody typed once. (The Supabase project ref and pooler
 * host meet the same criterion and have their own list below.)
 *
 * The practical case is a production deploy. Production deliberately ships `authClientId` and both
 * URIs empty, because they depend on a hostname that is not decided yet; without an override the
 * only way to deploy is to commit a value, deploy, and commit it again if it was wrong. Note that
 * `authClientId` and the two URIs only work as a SET - LPX reports any mismatch between them as an
 * opaque `invalid_request` - so overriding one usually means overriding all three.
 *
 * `satisfies` rather than a plain annotation so a typo here is a compile error against
 * `NeotmsAuthConfig` instead of a silently ignored context key.
 *
 * `bootstrapAuthorityId` is NOT on this list, even though it is also an id LPX owns, and the reason
 * is in `readStringOverride` below: it REJECTS a blank value, on the stated grounds that every
 * setting on these lists disables the API when blank. `bootstrapAuthorityId` is the one auth
 * setting where blank is a supported mode - it means "no back door" - so `-c bootstrapAuthorityId=`
 * could never be how the bootstrap gets turned off, and a list entry that cannot express the only
 * operation anybody would reach for is worse than no entry. Closing the door is an edit to the
 * stage value above, which is the reviewed commit we want for removing an administrative bypass
 * anyway. db/006_bootstrap.sql section 5 tells the operator the same thing.
 */
export const NEOTMS_AUTH_CONTEXT_KEYS = [
  "authClientId",
  "appAuthorityId",
  "oidcRedirectUri",
  "oidcPostLogoutRedirectUri",
  "oidcIssuer",
] as const satisfies readonly (keyof NeotmsAuthConfig)[];

export type NeotmsAuthContextKey = (typeof NEOTMS_AUTH_CONTEXT_KEYS)[number];

export type NeotmsHiworksEncAuthContextKey = "hiworksEncKeyArn"

/**
 * The Supabase settings that may be overridden, and the context key each answers to.
 *
 * Prefixed `supabase*` on the command line rather than reusing the field names: `-c projectRef=...`
 * on its own would be ambiguous in a repo that also has a CDK app, an LPX client and an S3 bucket
 * naming scheme, and context keys are a flat global namespace shared with CDK's own feature flags.
 *
 * `satisfies` pins the right-hand sides to real fields of `NeotmsSupabaseConfig`, so renaming a
 * field is a compile error here rather than an override that is silently never applied.
 */
export const NEOTMS_SUPABASE_CONTEXT_KEYS = {
  supabaseProjectRef: "projectRef",
  supabasePoolerHost: "poolerHost",
} as const satisfies Record<string, keyof NeotmsSupabaseConfig>;

export type NeotmsSupabaseContextKey = keyof typeof NEOTMS_SUPABASE_CONTEXT_KEYS;

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
 * Context reaches a CDK app from four places, only one of which is a command line: `-c` flags, the
 * `context` block in cdk.json, cdk.context.json, and `CDK_CONTEXT_JSON`. The cdk.json block is
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
function readStringOverride(
  context: NeotmsContextLookup | undefined,
  key: NeotmsAuthContextKey | NeotmsSupabaseContextKey | NeotmsHiworksEncAuthContextKey ,
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
        `passing a blank - every setting on these lists is one the Lambda treats as "not ` +
        `configured" when blank, so a blank deploys a stack that refuses every request.`,
    );
  }
  return trimmed;
}

/**
 * A full KMS key or alias ARN in one region.
 *
 * `arn:aws:kms:<region>:<12-digit account>:key/<id>` or `.../alias/<name>`. The partition is left
 * loose (`aws`, `aws-cn`, `aws-us-gov`) because that costs nothing; everything after it is pinned.
 */
const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):(\d{12}):(key|alias)\/(.+)$/;

/**
 * Turn the `hiworksEncKeyArn` override into a mode, or throw.
 *
 * ## Why a FULL arn is required, and not a key id or a bare alias
 *
 * Because the key is in another account. `GenerateDataKey` and `Decrypt` resolve a bare key id or
 * `alias/name` against the CALLER's account, so either one would silently look for a key that does
 * not exist there - and the failure arrives at runtime, as a user being asked to retype their
 * password, rather than at deploy time where it belongs.
 *
 * ## Why the region is checked
 *
 * A cross-REGION key is a different failure from a cross-account one, with the same symptom, and
 * the check is free: the ARN carries its region and the stage config states the stack's. Catching
 * it here turns a runtime `NotFoundException` into a deploy-time sentence naming both regions.
 *
 * The ACCOUNT in the arn is deliberately not checked against anything. Cross-account is the normal
 * case here, and the deploying account is not known to this module - it comes from the ambient
 * credentials in NeotmsApp.
 */
function resolveHiworksKms(
  config: NeotmsStageConfig,
  override: string | undefined,
): NeotmsHiworksKms {
  if (override === undefined) return config.hiworksKms;

  const parsed = KMS_KEY_ARN.exec(override);
  if (!parsed) {
    throw new Error(
      `Context "hiworksEncKeyArn" must be a full KMS key or alias ARN, but was "${override}". ` +
        `Expected arn:aws:kms:${config.region}:<account>:key/<id>. A bare key id or alias resolves ` +
        `against the DEPLOYING account, which is not where the shared key lives - so it would fail ` +
        `at runtime rather than here. Omit the flag entirely to leave the Hiworks credential ` +
        `feature switched off for this deployment.`,
    );
  }

  const [, region] = parsed;
  if (region !== config.region) {
    throw new Error(
      `Context "hiworksEncKeyArn" names a key in ${String(region)}, but this stage deploys to ` +
        `${config.region}. A KMS key cannot be used across regions; create the shared key in ` +
        `${config.region} or deploy this stage to ${String(region)}.`,
    );
  }

  return { mode: "shared", keyArn: override };
}

/**
 * The config for a stage, with any `-c` overrides applied to the auth block.
 *
 *   cdk deploy -c supabaseProjectRef=abcdefghijklmnopqrst \ dev, pointed at a Supabase project
 *     -c supabasePoolerHost=aws-0-ap-northeast-2.pooler.supabase.com
 *   cdk deploy -c stage=prod \ production, auth supplied at deploy time
 *     -c authClientId=... \ -c oidcRedirectUri=https://tms.example/auth/callback \ -c
 *     oidcPostLogoutRedirectUri=https://tms.example/auth/logout \ -c supabaseProjectRef=... -c
 *     supabasePoolerHost=...
 *
 * Returns a COPY, two levels deep. `NEOTMS_CONFIGS` is module state shared by every caller
 * including the tests, so applying overrides in place would make one synth leak into the next - and
 * a shallow copy is not enough, because `auth` and `supabase` are the objects being mutated.
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
    const override = readStringOverride(context, contextKey);
    if (override !== undefined) auth[contextKey] = override;
  }

  const supabase: { -readonly [K in keyof NeotmsSupabaseConfig]: NeotmsSupabaseConfig[K] } = {
    ...config.supabase,
  };
  for (const [contextKey, field] of Object.entries(NEOTMS_SUPABASE_CONTEXT_KEYS) as [
    NeotmsSupabaseContextKey,
    "projectRef" | "poolerHost",
  ][]) {
    const override = readStringOverride(context, contextKey);
    if (override !== undefined) supabase[field] = override;
  }

  /*
   * The Hiworks CMK override, for non-production stages only.
   *
   * The stage guard is the enforcement of "definitive for prod": the context is not read at all
   * when the stage is production, so `cdk deploy -c stage=prod -c hiworksEncKeyArn=...` ignores the
   * flag rather than honouring it. A test synthesises exactly that command line.
   *
   * Omitting the flag leaves the stage default, which for a shared-database stage is `off` - the
   * feature simply does not appear, and no row is written that another deployment would later fail
   * to open. Passing a MALFORMED arn throws instead, because the two are different mistakes:
   * omitting it is a choice, and mistyping it is an operator error that would otherwise present as
   * "I configured the key and the feature is still off", with nothing anywhere saying why.
   */
  const hiworksKms =
    key === "prod" ? config.hiworksKms : resolveHiworksKms(config, readStringOverride(context, "hiworksEncKeyArn"));

  return { ...config, hiworksKms, auth, supabase };
}
