// SPDX-License-Identifier: MIT
//
// hg project environment configuration.
// Read once at module load, validated by Valibot. A failed parse throws so the
// cold-start fails loudly rather than the Lambda returning confusing 500s.

import * as v from "valibot";

const EnvSchema = v.object({
  AWS_REGION: v.fallback(v.string(), "ap-northeast-2"),
  PROJECT_NAME: v.fallback(v.string(), "lpx"),
  LPX_TABLE_NAME: v.fallback(v.string(), "LKAuthData"),
  LPX_LOG_TABLE_NAME: v.fallback(v.string(), "LPXLogger"),
  LPX_USER_POOL_ID: v.fallback(v.string(), "LKUserPool"),
  LPX_LOG_QUEUE_URL: v.fallback(v.string(), ""),
  LPX_TABLE_GSI1_NAME : v.fallback(v.string(), "LKAuthData_GSI1"),
  // Default home client used by the authentication manager to call the Cognito APIs.
  // Configured with ADMIN_USER_PASSWORD_AUTH enabled and NO OAuth flows / callback URLs —
  // For tenants, the API is called with their client IDs.
  LPX_AUTH_HOME_CLIENT_ID: v.fallback(v.string(), ""),
  // CORS configuration - for the home client
  // DO NOT allow wildcards, even as a fallback - the cases where this value is invalid should be treated as emergencies that must be immediately taken care of
  LPX_AUTH_HOME_CLIENT_CORS_ALLOWED_ORIGINS: v.fallback(v.string(), ""),
  // -------- OAuth 2.0 / OIDC authorization server --------------------------
  //
  // See lpxauth/layers/nodejs/oauth/LKOAuthObjects.ts for why we issue our own tokens.
  /**
   * Our issuer, and the origin every public endpoint is addressed by. No trailing slash.
   *
   * Apps embed this and the JWKS URL in their verification config, so changing it is a breaking
   * change for every integration — which is why it is the custom domain where one exists rather
   * than the CloudFront hostname.
   */
  LPX_ISSUER_URL: v.fallback(v.string(), ""),
  /** Where to send a browser to authenticate. The console's origin. */
  LPX_CONSOLE_BASE_URL: v.fallback(v.string(), ""),
  /** KMS key ARN that tokens are signed with right now. */
  LPX_OAUTH_ACTIVE_KEY_ARN: v.fallback(v.string(), ""),
  /**
   * Every key ARN whose public half should appear in JWKS, comma-separated — normally the active
   * key AND the spare.
   *
   * Publishing the spare from the first deploy is deliberate: consumers get used to selecting a key
   * by `kid` from a multi-key document, so a promotion is never the first time that path runs.
   * Withdrawing a key from this list is how a compromised key's tokens are revoked.
   */
  LPX_OAUTH_PUBLISHED_KEY_ARNS: v.fallback(v.string(), ""),

  // -------- Mail (Mailgun) ------------------------------------------------
  //
  // The API key is deliberately NOT here. It lives in Secrets Manager and is read at cold start
  // (see utils/SecretsUtils.ts): a Lambda environment variable is readable by anyone with console
  // access to the function, and rotating one means a redeploy.
  LPX_MG_SECRET_NAME: v.fallback(v.string(), ""),
  LPX_MG_EMAIL_DOMAIN: v.fallback(v.string(), ""),
  /** Envelope sender for mail the system sends on its own behalf (notifications, recovery). */
  LPX_MAIL_FROM_ADDRESS: v.fallback(v.string(), ""),
  LPX_MAIL_FROM_NAME: v.fallback(v.string(), "라이온코리아 IT 서비스"),
  /** Bucket holding staged uploads, retained attachments and rendered mail bodies. */
  LPX_MAIL_BUCKET_NAME: v.fallback(v.string(), ""),
  /**
   * Absolute base URL used to build large-attachment download links inside a mail body. The link
   * has to work from the recipient's mail client, so a relative path is useless here.
   */
  LPX_MAIL_DOWNLOAD_BASE_URL: v.fallback(v.string(), ""),
  /**
   * Retention, in days. These MUST match the S3 lifecycle rules on the mail bucket — the same
   * numbers are passed to both from the stack, because the DynamoDB TTL and the lifecycle rule
   * expire the record and the object it points at. Drift leaves either a row pointing at a deleted
   * object or an object nobody can reach.
   */
  LPX_MAIL_STAGING_RETENTION_DAYS: v.fallback(v.string(), "1"),
  LPX_MAIL_ATTACHMENT_RETENTION_DAYS: v.fallback(v.string(), "21"),
  /**
   * Largest attachment, in bytes, that is sent inline in the message. Anything bigger is retained
   * in the bucket and linked from the body instead. Mailgun rejects messages over 25MB in total,
   * so this is well under that even with several attachments.
   */
  LPX_MAIL_INLINE_ATTACHMENT_MAX_BYTES: v.fallback(v.string(), "10485760"),
});

export type LpxEnvT = v.InferOutput<typeof EnvSchema>;

function loadEnv(): LpxEnvT {
  const result = v.safeParse(EnvSchema, process.env);
  if (!result.success) {
    const issues = result.issues
      .map((i) => `${i.path?.map((p) => p.key).join(".") ?? "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`LPXEnv validation failed: ${issues}`);
  }
  return result.output;
}

export const LpxEnv: LpxEnvT = loadEnv();
