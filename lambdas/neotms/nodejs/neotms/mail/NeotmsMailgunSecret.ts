// SPDX-License-Identifier: MIT
//
// Reading the Mailgun credentials - the API key AND the sending domain - out of Secrets Manager.
//
// ## Both values live in the secret
//
// The secret named by `NEOTMS_MG_SECRET_NAME` (`neotms-dev/mailgun` / `neotms/mailgun`) is a JSON
// document with two fields:
//
//     {"apiKey": "<mailgun api key>", "domain": "<mailgun sending domain>"}
//
// The domain is not a secret, but it is half of one credential: a Mailgun key is scoped to the
// domains of its account, and `https://api.mailgun.net/v3/{domain}/messages` with a key from another
// account is a 401 that reads like a revoked key. Keeping the pair in one document means they are
// rotated, copied between stages and audited together, and a stage can never end up with the key
// from one account and the domain from another because two different places were edited.
// (The domain used to be a CDK config value, `mailgunEmailDomain`; it was removed for this reason.)
//
// ## Why not `lambdas/common/.../SecretsUtils.ts`
//
// Same reason as `fx/NeotmsFxSecret.ts`: `lambdas/common` is LPX base code, excluded from
// tsconfig.app.json and not typechecked by the gate `cdk deploy` runs, and the next refresh from LPX
// replaces it wholesale. NEOTMS code does not import across that boundary.
//
// ## In the environment: the NAME. In Secrets Manager: the VALUES.
//
// A Lambda environment variable is readable by anyone with `lambda:GetFunction`, appears in the
// CloudFormation template, and cannot be rotated faster than a release.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { NeotmsEnv } from "../../env/NeotmsEnv.js";

/** The two fields of the secret document. */
export const MAILGUN_SECRET_FIELDS = { apiKey: "apiKey", domain: "domain" } as const;

export interface MailgunCredentials {
  readonly apiKey: string;
  readonly domain: string;
}

/**
 * Five minutes, like SecretsUtils: the API function is long-lived, so the TTL is how long a rotated
 * key takes to be picked up without a redeploy.
 */
const CACHE_TTL_MS = 300_000;

let client: SecretsManagerClient | null = null;
let cached: { value: MailgunCredentials; expiresAt: number } | null = null;

/**
 * Parse the secret document. Pure, so it can be tested without AWS.
 *
 * Both fields are required. Unlike the FX key, a bare (non-JSON) string is NOT accepted: it could
 * only be the key, and a key without its domain cannot send anything - accepting it would move the
 * failure from "the secret is malformed" to an opaque 404 from Mailgun.
 *
 * A domain given as a URL (`https://lion-korea.com/`) is reduced to its host, because the field is
 * easy to fill in that way and Mailgun wants the bare domain in the request path.
 */
export function parseMailgunSecret(raw: string): MailgunCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const doc = parsed as Record<string, unknown>;

  const apiKey = doc[MAILGUN_SECRET_FIELDS.apiKey];
  const domainField = doc[MAILGUN_SECRET_FIELDS.domain];
  if (typeof apiKey !== "string" || typeof domainField !== "string") return null;

  const domain = domainField
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (apiKey.trim().length === 0 || domain.length === 0) return null;
  return { apiKey: apiKey.trim(), domain };
}

/**
 * The Mailgun API key and sending domain, or null when mail is not configured.
 *
 * Null rather than a throw: the caller answers "mail is not configured" instead of a stack trace.
 * A FAILURE IS NOT CACHED - one throttled call must not disable mail for the life of a container.
 */
export async function readMailgunCredentials(): Promise<MailgunCredentials | null> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const secretName = NeotmsEnv.NEOTMS_MG_SECRET_NAME;
  if (!secretName) {
    console.warn("[mail] NEOTMS_MG_SECRET_NAME is empty, so Mailgun is not configured.");
    return null;
  }

  client ??= new SecretsManagerClient({ maxAttempts: 3 });
  let raw: string | undefined;
  try {
    raw = (await client.send(new GetSecretValueCommand({ SecretId: secretName }))).SecretString;
  } catch (err: unknown) {
    // The error's NAME only: ResourceNotFoundException = never created, AccessDeniedException =
    // the stack's grant is missing. The error object can carry request context.
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error(`[mail] could not read the secret "${secretName}": ${name}`);
    return null;
  }
  if (!raw) {
    console.error(`[mail] the secret "${secretName}" has no string value.`);
    return null;
  }

  const value = parseMailgunSecret(raw);
  if (!value) {
    console.error(
      `[mail] the secret "${secretName}" must be JSON with non-empty ` +
        `"${MAILGUN_SECRET_FIELDS.apiKey}" and "${MAILGUN_SECRET_FIELDS.domain}" fields.`,
    );
    return null;
  }

  cached = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Test-only: drop the cached client and credentials. */
export function _resetMailgunSecret(): void {
  client = null;
  cached = null;
}
