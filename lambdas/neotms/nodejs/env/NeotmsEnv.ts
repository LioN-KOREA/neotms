// SPDX-License-Identifier: MIT
//
// NEOTMS environment configuration.
//
// Read once at module load and validated by Valibot. A failed parse throws, which fails the cold
// start - deliberately, because the alternative is a function that starts fine and then returns
// confusing 500s from whichever handler happens to be the first to need the missing value.
//
// Two things are NOT here, and their absence is the point:
//
//   * The Mailgun API key. It lives in Secrets Manager and is read at cold start (see
//     utils/SecretsUtils.ts). A Lambda environment variable is readable by anyone with console
//     access to the function, and rotating one means a redeploy.
//   * An OIDC client secret. There isn't one - the LPX client is public and PKCE is what ties the
//     authorization code to whoever began the flow (연동 안내서 §2).

import * as v from "valibot";

const EnvSchema = v.object({
  AWS_REGION: v.fallback(v.string(), "ap-northeast-2"),
  NEOTMS_STAGE: v.fallback(v.string(), "dev"),

  // -------- Supabase Postgres, over the Supavisor pooler --------------------
  //
  // A real socket this time, not the Data API, so there is a host, a port, a user and a password.
  // Only the password is secret; it is read from Secrets Manager at first use rather than passed in
  // an environment variable, because a Lambda environment variable is readable by anyone with
  // console access to the function and rotating one means a redeploy.
  //
  // The function still needs no VPC attachment and the project still needs no NAT Gateway: the
  // pooler is on the public internet, reached over TLS.
  /**
   * The Supavisor host, e.g. `aws-0-ap-northeast-2.pooler.supabase.com`.
   *
   * NOT derivable from the region - the leading index is assigned per project, and Supabase's own
   * documentation says to copy the host out of the dashboard's Connect dialog. So this is a
   * configured value with no sensible default, and `isDatabaseConfigComplete()` below fails closed
   * when it is absent.
   */
  NEOTMS_DB_HOST: v.fallback(v.string(), ""),
  /**
   * 6543, the transaction-mode port - not 5432.
   *
   * Two independent reasons, either one sufficient. First, the direct endpoint
   * (`db.<ref>.supabase.co:5432`) resolves to IPv6 only unless the IPv4 add-on is bought, and a
   * Lambda outside a VPC has no IPv6 egress. Second, transaction mode returns the server connection
   * to the pool at COMMIT rather than at disconnect, which is the only mode that survives a
   * function whose concurrency is a multiple of the database's connection limit.
   *
   * The cost of this choice is paid in PostgresUtils.ts: no prepared statements, no session state,
   * no pipelining, no cursors held across statements.
   */
  NEOTMS_DB_PORT: v.fallback(v.string(), "6543"),
  /** `postgres.<project-ref>` on the pooler - the bare `postgres` is only valid on port 5432. */
  NEOTMS_DB_USER: v.fallback(v.string(), ""),
  /** `postgres` on Supabase. There is no per-application database; schemas separate concerns. */
  NEOTMS_DB_NAME: v.fallback(v.string(), "postgres"),
  /** Secrets Manager ARN of a JSON secret with a `password` key. See NeotmsSupabase. */
  NEOTMS_DB_SECRET_ARN: v.fallback(v.string(), ""),
  /**
   * PEM of the CA to pin, optional.
   *
   * Empty means TLS is still used but the certificate is not verified, which is what Supabase's own
   * connection strings default to and what every pooler client does out of the box. Supplying the
   * Supabase project CA here turns on real verification; it is a string rather than a file path
   * because the Lambda bundle is read-only and a one-line environment variable is easier to rotate
   * than a redeployed asset.
   */
  NEOTMS_DB_CA_CERT: v.fallback(v.string(), ""),

  /** Session records. DynamoDB rather than the cluster - see NeotmsStorage for why. */
  NEOTMS_SESSION_TABLE_NAME: v.fallback(v.string(), ""),

  /** Quotes, POs, delivered files and reference material. Reached by presigned URL, never proxied. */
  NEOTMS_ATTACHMENT_BUCKET_NAME: v.fallback(v.string(), ""),
  /**
   * Where a rendered report lands when it is too large to return in the response body.
   *
   * On the Data API branch this was unavoidable machinery - a result set was capped at 1 MiB, so a
   * large report had to leave the database through `aws_s3.query_export_to_s3` and be picked up
   * from S3. Over a real socket there is no such cap, so the only remaining limit is Lambda's own
   * 6 MB response payload. This bucket is therefore now just a spill target the FUNCTION writes to
   * and hands back as a presigned URL, which is also why it no longer needs a KMS key.
   */
  NEOTMS_EXPORT_BUCKET_NAME: v.fallback(v.string(), ""),

  // -------- CORS -----------------------------------------------------------
  //
  // Comma-separated exact origins. No wildcard, not even as a fallback: this API carries a session
  // cookie, and a permissive origin on a cookie-bearing API is a session-theft primitive. An empty
  // list fails closed (every cross-origin request is refused), which is the correct failure.
  NEOTMS_ALLOWED_ORIGIN_URLS: v.fallback(v.string(), ""),

  // -------- OIDC (연동 안내서 §2-§5) ----------------------------------------
  /** The account system's issuer, no trailing slash. Asserted as every access token's `iss`. */
  NEOTMS_OIDC_ISSUER: v.fallback(v.string(), ""),
  /** This app's client id. Sent as client_id, and asserted as every access token's `aud`. */
  NEOTMS_AUTH_CLIENT_ID: v.fallback(v.string(), ""),
  /**
   * Where the account system sends the browser back with the code. Must be byte-identical to a
   * redirect URI registered on the client - scheme, host, path and trailing slash all count, and a
   * mismatch surfaces as a generic `invalid_request` with no hint as to which character differs.
   */
  NEOTMS_OIDC_REDIRECT_URI: v.fallback(v.string(), ""),
  NEOTMS_OIDC_POST_LOGOUT_REDIRECT_URI: v.fallback(v.string(), ""),
  /**
   * The coarse authority an LPX account must hold to reach this API at all.
   *
   * Tier one of two. Holding it means "may open NEOTMS"; it says nothing about which menus or which
   * rows, which is decided from the staff row (role matrix and view scope - Q9).
   *
   * The fallback is EMPTY, deliberately, and it used to be the string `"neotms.access"`. A non-empty
   * fallback is actively dangerous here: `isAuthConfigComplete()` below only checks that this is
   * non-empty, so a guessed default made an unconfigured deployment look fully configured while
   * `authorities.includes(...)` could never match - every account would be told it lacks access,
   * with a 403 that reads as a permissions decision rather than as a missing setting. Empty means
   * `isAuthConfigComplete()` is false and the guard answers 500 "not configured" instead.
   */
  NEOTMS_APP_AUTHORITY_ID: v.fallback(v.string(), ""),
  /**
   * The LPX authority that may let itself in and provision the first NEOTMS staff row.
   *
   * `lpx.admin.access` - LPX's own global administrator - in both stages. It exists because
   * 002..005 build an entirely empty database and an entirely empty database cannot be signed
   * into: the guard refuses an identity with no `staff` row, the only way to create a `staff` row
   * is through NEOTMS, and NEOTMS has no route that writes one. Holding this authority breaks that
   * cycle; see `bootstrapSuperuser` in NeotmsAuthGuard and `staff_bootstrap_superuser()` in
   * db/006_bootstrap.sql.
   *
   * EMPTY DISABLES THE WHOLE PATH, and that is the one thing to know about this variable. Empty is
   * not a misconfiguration here - it is the setting for a system that has its administrators and no
   * longer wants a back door, and it restores the guard's behaviour exactly as it was before the
   * bootstrap existed. So unlike NEOTMS_APP_AUTHORITY_ID, this is deliberately NOT part of
   * `isAuthConfigComplete()`: a blank must not make the API answer 500.
   *
   * It is also why the value is a real string rather than a UUID. `lpx.admin.access` is a SYSTEM
   * authority in LPX's code-owned registry (lambdas/common/.../LpxAuthorities.ts), which is exactly
   * the set of authorities with stable literal ids - tenant authorities get server-generated UUIDs
   * that no source file may hardcode.
   */
  NEOTMS_BOOTSTRAP_AUTHORITY_ID: v.fallback(v.string(), ""),

  // -------- Mail (Mailgun, not SES) ----------------------------------------
  NEOTMS_MG_SECRET_NAME: v.fallback(v.string(), ""),
  NEOTMS_MG_EMAIL_DOMAIN: v.fallback(v.string(), ""),
  NEOTMS_MAIL_FROM_ADDRESS: v.fallback(v.string(), ""),
  NEOTMS_MAIL_FROM_NAME: v.fallback(v.string(), "라이온코리아 TMS"),

  // -------- Tunables -------------------------------------------------------
  /** How long a presigned upload URL stays valid. Short, because the browser uploads immediately. */
  NEOTMS_UPLOAD_URL_TTL_SEC: v.fallback(v.string(), "120"),
  /** How long a presigned download URL stays valid. Longer, because a human clicks it. */
  NEOTMS_DOWNLOAD_URL_TTL_SEC: v.fallback(v.string(), "300"),
  /**
   * Default and maximum page size for list endpoints.
   *
   * The maximum is a correctness guard, not a nicety. There is no 1 MiB result cap over a socket,
   * which makes this MORE important rather than less: a caller asking for `?limit=100000` now gets
   * a query that succeeds, buffers every row into the function's memory, and either blows the 6 MB
   * response payload limit or the heap. Clamping here turns that into a predictable answer.
   */
  NEOTMS_PAGE_SIZE_DEFAULT: v.fallback(v.string(), "50"),
  NEOTMS_PAGE_SIZE_MAX: v.fallback(v.string(), "200"),
});

export type NeotmsEnvT = v.InferOutput<typeof EnvSchema>;

function loadEnv(): NeotmsEnvT {
  const result = v.safeParse(EnvSchema, process.env);
  if (!result.success) {
    const issues = result.issues
      .map((i) => `${i.path?.map((p) => p.key).join(".") ?? "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`NeotmsEnv validation failed: ${issues}`);
  }
  return result.output;
}

export const NeotmsEnv: NeotmsEnvT = loadEnv();

/**
 * Origins allowed to call this API with credentials.
 *
 * Parsed once here rather than split at every request, and filtered so a stray trailing comma in
 * the environment variable cannot produce an empty-string entry - which would match a request with
 * no Origin header and quietly widen the policy.
 */
export const NEOTMS_ALLOWED_ORIGINS: string[] = NeotmsEnv.NEOTMS_ALLOWED_ORIGIN_URLS.split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

export const NEOTMS_PAGE_SIZE_DEFAULT = Number(NeotmsEnv.NEOTMS_PAGE_SIZE_DEFAULT);
export const NEOTMS_PAGE_SIZE_MAX = Number(NeotmsEnv.NEOTMS_PAGE_SIZE_MAX);
export const NEOTMS_UPLOAD_URL_TTL_SEC = Number(NeotmsEnv.NEOTMS_UPLOAD_URL_TTL_SEC);
export const NEOTMS_DOWNLOAD_URL_TTL_SEC = Number(NeotmsEnv.NEOTMS_DOWNLOAD_URL_TTL_SEC);

/**
 * Whether the settings the auth path needs are all present.
 *
 * Checked explicitly, and the guard answers 500 rather than 401 when it is false. The distinction
 * matters: a missing setting is an operator error, and if it read as "not allowed" then a
 * misconfigured deployment would look exactly like a correctly refused request - the one failure
 * mode that must never be silent.
 *
 * `NEOTMS_BOOTSTRAP_AUTHORITY_ID` is excluded on purpose: blank there means "no back door", which
 * is a supported mode rather than a missing setting. Including it would make turning the bootstrap
 * off take the entire API down with it.
 */
export function isAuthConfigComplete(): boolean {
  return (
    NeotmsEnv.NEOTMS_OIDC_ISSUER.length > 0 &&
    NeotmsEnv.NEOTMS_AUTH_CLIENT_ID.length > 0 &&
    NeotmsEnv.NEOTMS_APP_AUTHORITY_ID.length > 0
  );
}

/**
 * Whether the settings the database layer needs are all present.
 *
 * Host, user and secret ARN, checked for the same reason as `isAuthConfigComplete()`: an
 * unconfigured deployment must answer 500 "not configured", not a connection error from three
 * frames inside the pool. Port and database name are excluded on purpose - both have real defaults
 * (6543 and `postgres`) that are correct for every Supabase project, so requiring them would only
 * add a way to misconfigure a working stack.
 *
 * `NEOTMS_DB_CA_CERT` is excluded too: empty is a supported mode (TLS without verification), not a
 * missing setting.
 */
export function isDatabaseConfigComplete(): boolean {
  return (
    NeotmsEnv.NEOTMS_DB_HOST.length > 0 &&
    NeotmsEnv.NEOTMS_DB_USER.length > 0 &&
    NeotmsEnv.NEOTMS_DB_SECRET_ARN.length > 0
  );
}
