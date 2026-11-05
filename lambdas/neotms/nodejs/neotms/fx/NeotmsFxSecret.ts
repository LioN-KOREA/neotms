// SPDX-License-Identifier: MIT
//
// Reading the Korea Export-Import Bank API key out of Secrets Manager.
//
// A dozen lines in its own file, for a reason worth stating. `lambdas/common/.../SecretsUtils.ts`
// already does exactly this - `getSecretField(name, field)`, with a 300-second cache - but
// `lambdas/common` is EXCLUDED from tsconfig.app.json (it imports Cognito and KMS SDK packages
// NEOTMS does not install) and is therefore not typechecked by the gate `cdk deploy` runs. Importing
// across that boundary would put untypechecked code in a deployed bundle.
//
// So this is a deliberate re-implementation rather than an oversight, kept as small as the one
// caller needs: one secret, one field, read at most once per container.
//
// ## In the environment: the NAME. In Secrets Manager: the KEY.
//
// `NEOTMS_FX_SECRET_NAME` holds `neotms/erapikey`, which is not sensitive. The key itself is never
// an environment variable, because a Lambda environment variable is readable by anyone with
// `lambda:GetFunction`, appears in the CloudFormation template, and cannot be rotated faster than a
// release. The same rule PostgresUtils follows for the database password.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { NeotmsEnv } from "../../env/NeotmsEnv.js";

/** The field inside the secret document. Set by the user when they created it. */
const FX_SECRET_FIELD = "exchangeRateApiKey";

let client: SecretsManagerClient | null = null;

/**
 * Cached for the container's life rather than for a TTL.
 *
 * SecretsUtils uses 300 seconds because the API Lambda is long-lived and serves thousands of
 * requests between cold starts, so the TTL is the rotation lag. This Lambda runs for a second every
 * five minutes: a container rarely survives to a second invocation, so a TTL would buy nothing, and
 * a rotated key is picked up on the next cold start - which is minutes away, not hours.
 *
 * A FAILURE IS NOT CACHED. Caching `null` would disable the fetcher for the life of a container
 * because of one throttled API call.
 */
let cachedKey: string | null = null;

/**
 * The API key, or null.
 *
 * Null rather than a throw, deliberately, and the caller treats it as "nothing to fetch today"
 * rather than as a fault. An unconfigured key is the state a freshly deployed stack is in before
 * somebody populates the secret, and the correct behaviour then is for every amount to read exactly
 * as it does today - which is what happens, because an open position falls back to its stored KRW
 * figure when `fx_rate` has no quote (see NeotmsMoney.ts). A throw here would instead fill the log
 * with stack traces on a stack that is merely half-configured.
 */
export async function readFxApiKey(): Promise<string | null> {
  if (cachedKey) return cachedKey;

  const secretName = NeotmsEnv.NEOTMS_FX_SECRET_NAME;
  if (!secretName) {
    console.warn("[fxrate] NEOTMS_FX_SECRET_NAME is empty, so there is no API key to read.");
    return null;
  }

  client ??= new SecretsManagerClient({ maxAttempts: 3 });
  let raw: string | undefined;
  try {
    raw = (await client.send(new GetSecretValueCommand({ SecretId: secretName }))).SecretString;
  } catch (err: unknown) {
    /*
     * The error's NAME only, never the error object.
     *
     * An SDK error carries request context, and `ResourceNotFoundException` versus
     * `AccessDeniedException` is the entire diagnostic value here - the first means the secret was
     * never created, the second means the stack's grant is missing.
     */
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error(`[fxrate] could not read the secret "${secretName}": ${name}`);
    return null;
  }
  if (!raw) {
    console.error(`[fxrate] the secret "${secretName}" has no string value; it may never have been populated.`);
    return null;
  }

  /*
   * JSON with one field, as the console writes a key/value secret - `{"exchangeRateApiKey":"..."}`.
   *
   * A non-JSON body is accepted as the bare key, for the same reason `readPassword` accepts one: it
   * is the forgivable mistake of pasting the key in raw, it is a working credential, and refusing it
   * would turn a deployment that is one `put-secret-value` from working into one that logs a parse
   * error every five minutes.
   */
  let value: string | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && FX_SECRET_FIELD in parsed) {
      const field = (parsed as Record<string, unknown>)[FX_SECRET_FIELD];
      if (typeof field === "string" && field.length > 0) value = field;
    }
    if (!value) {
      console.error(
        `[fxrate] the secret "${secretName}" has no non-empty "${FX_SECRET_FIELD}" field.`,
      );
      return null;
    }
  } catch {
    value = raw.trim();
    if (value.length === 0) return null;
  }

  cachedKey = value;
  return cachedKey;
}

/** Test-only: drop the cached client and key. Mirrors `_resetClient` in the common layer. */
export function _resetFxSecret(): void {
  client = null;
  cachedKey = null;
}
