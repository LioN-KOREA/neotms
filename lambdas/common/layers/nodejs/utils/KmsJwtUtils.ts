// SPDX-License-Identifier: MIT
//
// Signing JWTs with a KMS asymmetric key.
//
// Why KMS rather than a key file or a Secrets Manager entry: the private half never exists outside
// KMS. We send the signing input and get a signature back, so there is nothing for this process to
// leak, nothing to scrub from memory, and no code path that could log it. An attacker who
// compromises the function can USE the key while they hold the role, but cannot take it with them —
// and every use is recorded in CloudTrail with the calling identity.
//
// Deliberately env-free: the caller names the key, so this module is reusable and the key is chosen
// at the call site.

import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { createHash, createPublicKey } from "node:crypto";

let client: KMSClient | null = null;

function getClient(): KMSClient {
  if (!client) {
    client = new KMSClient();
  }
  return client;
}

/**
 * RS256 — RSASSA-PKCS1-v1_5 with SHA-256.
 *
 * The KMS key must be RSA (we use RSA_2048) with KeyUsage SIGN_VERIFY. RS256 rather than the
 * shorter ES256 purely for consumer compatibility: every JWT library supports RS256 without
 * configuration, and the integration guide should not have to explain a curve.
 */
const KMS_SIGNING_ALGORITHM = "RSASSA_PKCS1_V1_5_SHA_256";
export const JWT_ALG = "RS256";

const b64url = (input: Buffer | string): string =>
  (Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8")).toString("base64url");

/**
 * Sign a JWT with a KMS key.
 *
 * `kid` goes in the header so a verifier can select the right key from a multi-key JWKS. That is
 * what makes rotation possible without a flag day: publish both keys, sign with the new one, and
 * withdraw the old only once the longest token lifetime has elapsed.
 */
export async function signJwtWithKms(
  keyId: string,
  kid: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (!keyId) {
    console.error("signJwtWithKms: no key id supplied.");
    return null;
  }
  const header = { alg: JWT_ALG, typ: "JWT", kid };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

  try {
    const out = await getClient().send(new SignCommand({
      KeyId: keyId,
      // MessageType RAW lets KMS do the hashing. Passing a DIGEST would mean hashing here and
      // keeping both sides in agreement about which hash — one more thing to get wrong.
      Message: Buffer.from(signingInput, "utf8"),
      MessageType: "RAW",
      SigningAlgorithm: KMS_SIGNING_ALGORITHM,
    }));
    if (!out.Signature) {
      console.error("signJwtWithKms: KMS returned no signature.");
      return null;
    }
    return `${signingInput}.${Buffer.from(out.Signature).toString("base64url")}`;
  } catch (err: any) {
    // Never log the payload — it carries identity claims.
    console.error(`signJwtWithKms: KMS Sign failed: ${err?.name ?? "UnknownError"}`);
    return null;
  }
}

export interface JsonWebKey {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  use: "sig";
  alg: string;
}

/**
 * The `kid` a key ARN publishes under.
 *
 * Derived from the ARN rather than stored, so it is stable for the life of the key and identical
 * everywhere without coordination: withdrawing a key and later re-publishing it restores the same
 * `kid`, and no two components can disagree about what to call a key.
 *
 * It MUST stay byte-identical. Changing the derivation changes every published `kid` at once, which
 * invalidates every token in flight and every JWK row already persisted — there is no migration,
 * only an outage. This lives here, in the one module that already owns the KMS-to-JWT mapping, so
 * that the authorization server and the key-health check cannot drift apart on it.
 *
 * Truncated to 32 hex characters: a `kid` is an opaque label, not a security control, and the full
 * digest only makes log lines harder to read.
 */
export function kidForKeyArn(keyArn: string): string {
  return createHash("sha256").update(keyArn, "utf8").digest("hex").slice(0, 32);
}

/**
 * Read a KMS key's public half and convert it to JWK form.
 *
 * Used at DEPLOY time (or by a one-off script), not on the request path — see the note on
 * configured JWKS in LKOAuthObjects. KMS hands back DER-encoded SubjectPublicKeyInfo; Node's
 * KeyObject imports that and exports JWK directly, which avoids hand-rolling an ASN.1 parse to
 * pull out the modulus and exponent.
 */
export async function fetchKmsPublicJwk(keyId: string, kid: string): Promise<JsonWebKey | null> {
  if (!keyId) {
    console.error("fetchKmsPublicJwk: no key id supplied.");
    return null;
  }
  try {
    const out = await getClient().send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!out.PublicKey) {
      console.error("fetchKmsPublicJwk: KMS returned no public key.");
      return null;
    }
    return derSpkiToJwk(Buffer.from(out.PublicKey), kid);
  } catch (err: any) {
    console.error(`fetchKmsPublicJwk: KMS GetPublicKey failed: ${err?.name ?? "UnknownError"}`);
    return null;
  }
}

/** Convert a DER SubjectPublicKeyInfo RSA public key into a JWK. */
export function derSpkiToJwk(der: Buffer, kid: string): JsonWebKey | null {
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const jwk = key.export({ format: "jwk" }) as { kty?: string; n?: string; e?: string };
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) {
      console.error("derSpkiToJwk: the exported JWK is not a complete RSA key.");
      return null;
    }
    return { kty: "RSA", n: jwk.n, e: jwk.e, kid, use: "sig", alg: JWT_ALG };
  } catch (err: any) {
    console.error(`derSpkiToJwk: could not import the public key: ${err?.name ?? "UnknownError"}`);
    return null;
  }
}

/** Test-only: drop the cached client. Mirrors S3Utils._resetClient. */
export function _resetClient(): void {
  client = null;
}
