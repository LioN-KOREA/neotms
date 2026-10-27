// SPDX-License-Identifier: MIT
//
// Thin wrapper around AWS Secrets Manager.
//
// Deliberately env-free: the caller names the secret, so this module is reusable and the secret
// is chosen at the call site.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

let client: SecretsManagerClient | null = null;

function getClient(): SecretsManagerClient {
  if (!client) {
    client = new SecretsManagerClient();
  }
  return client;
}

/**
 * How long a fetched secret stays cached in the execution environment.
 *
 * Secrets Manager charges per API call and a Lambda can serve thousands of requests between cold
 * starts, so caching is not optional. The TTL is the rotation lag: a rotated secret keeps failing
 * for up to this long on already-warm instances, which is why it is minutes rather than hours.
 */
const SECRET_CACHE_TTL_MS = 300_000;

const cache = new Map<string, { value: string; expiresAt: number }>();

/**
 * Read a secret's string value, cached per execution environment.
 *
 * Returns null rather than throwing when the secret is missing, unreadable or empty: the caller
 * knows what it is for and can decide whether that is fatal. A failure is never cached — a
 * transient error would otherwise disable the feature for the whole TTL.
 */
export async function getSecretString(secretName: string): Promise<string | null> {
  if (!secretName) return null;

  const now = Date.now();
  const hit = cache.get(secretName);
  if (hit && hit.expiresAt > now) return hit.value;

  try {
    const out = await getClient().send(new GetSecretValueCommand({ SecretId: secretName }));
    // A secret can hold either a string or binary. Only the string form is supported here; binary
    // would be a configuration mistake rather than something to guess at.
    const value = out.SecretString;
    if (!value) {
      console.error(`SecretsUtils: secret "${secretName}" has no string value.`);
      return null;
    }
    cache.set(secretName, { value, expiresAt: now + SECRET_CACHE_TTL_MS });
    return value;
  } catch (err: any) {
    // Never log the secret name's value, and never log the error object wholesale — an SDK error
    // can carry request context. The name and the error name are enough to diagnose.
    console.error(`SecretsUtils: could not read secret "${secretName}": ${err?.name ?? "UnknownError"}`);
    return null;
  }
}

/**
 * Read a secret stored as JSON and return one field from it.
 *
 * Secrets Manager's console writes key/value secrets as a JSON document, so a secret created
 * through the UI needs this rather than getSecretString.
 */
export async function getSecretField(secretName: string, field: string): Promise<string | null> {
  const raw = await getSecretString(secretName);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    console.error(`SecretsUtils: secret "${secretName}" is not valid JSON, so field "${field}" cannot be read.`);
    return null;
  }
}

/** Test-only: drop the cached client and every cached secret. Mirrors S3Utils._resetClient. */
export function _resetClient(): void {
  client = null;
  cache.clear();
}
