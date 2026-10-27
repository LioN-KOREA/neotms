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

  // -------- Aurora Serverless v2, over the RDS Data API ---------------------
  //
  // Three values and no host, port, user or password: the Data API is addressed by cluster ARN and
  // authorised by SigV4, and it reads the credential itself from the secret named below. That is
  // why this function needs no VPC attachment and the project needs no NAT Gateway.
  NEOTMS_DB_CLUSTER_ARN: v.fallback(v.string(), ""),
  NEOTMS_DB_SECRET_ARN: v.fallback(v.string(), ""),
  NEOTMS_DB_NAME: v.fallback(v.string(), "neotms"),

  /** Session records. DynamoDB rather than the cluster - see NeotmsStorage for why. */
  NEOTMS_SESSION_TABLE_NAME: v.fallback(v.string(), ""),

  /** Quotes, POs, delivered files and reference material. Reached by presigned URL, never proxied. */
  NEOTMS_ATTACHMENT_BUCKET_NAME: v.fallback(v.string(), ""),
  /**
   * Where `aws_s3.query_export_to_s3` writes a report too large for the Data API's 1 MiB result
   * limit, and where the XLSX renderer reads it back from. SSE-KMS, not SSE-S3 - the export fails
   * otherwise, with an error that says nothing about encryption.
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
   * The maximum is a correctness guard, not a nicety: the Data API caps a result set at 1 MiB, and
   * a caller asking for `?limit=100000` would get an error from deep inside the SQL layer rather
   * than a refusal. Clamping here turns that into a predictable answer.
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
 */
export function isAuthConfigComplete(): boolean {
  return (
    NeotmsEnv.NEOTMS_OIDC_ISSUER.length > 0 &&
    NeotmsEnv.NEOTMS_AUTH_CLIENT_ID.length > 0 &&
    NeotmsEnv.NEOTMS_APP_AUTHORITY_ID.length > 0
  );
}

export function isDatabaseConfigComplete(): boolean {
  return NeotmsEnv.NEOTMS_DB_CLUSTER_ARN.length > 0 && NeotmsEnv.NEOTMS_DB_SECRET_ARN.length > 0;
}
