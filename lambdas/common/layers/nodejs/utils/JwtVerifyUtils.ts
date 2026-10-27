// SPDX-License-Identifier: MIT
//
// Verifying the JWTs we issue ourselves, against public keys supplied as configuration.
//
// Why not a JWKS-fetching library: the authorizer runs on every request, and our public keys are
// already in its environment. Fetching our own JWKS over HTTP would add a cold-start network call,
// a cache to reason about, and a failure mode where the API cannot authorise requests because it
// cannot reach itself. Local verification against configured keys has none of that.
//
// The checks below are the ones that matter, in the order they matter:
//
//   1. `alg` must be RS256. The algorithm is NEVER taken from the token — a verifier that trusts
//      the header's alg is how "alg: none" and HMAC-confusion attacks work.
//   2. `kid` must name a configured key. An unknown kid is a rejection, not a reason to try them
//      all, which would make key withdrawal meaningless.
//   3. The signature must verify over the exact `header.payload` bytes as received.
//   4. Only then are the claims read. Reading claims from an unverified token and deciding later
//      is the other classic mistake.

import { createPublicKey, createVerify } from "node:crypto";
import type { JsonWebKey } from "./KmsJwtUtils.js";

/**
 * Tolerance for clock drift between the signer and the verifier, in seconds.
 *
 * Exported because it bounds more than this file: anything that has to outlive every token we have
 * issued — a revocation gate, a withdrawn signing key — has to allow for a verifier whose clock is
 * behind ours by this much.
 */
export const CLOCK_SKEW_LEEWAY_SEC = 60;

export interface VerifiedJwt {
    header: { alg: string; kid?: string; typ?: string };
    payload: Record<string, unknown>;
}

export type JwtRejection =
    | "MALFORMED"
    | "BAD_ALGORITHM"
    | "UNKNOWN_KEY"
    | "BAD_SIGNATURE"
    | "EXPIRED"
    | "NOT_YET_VALID"
    | "BAD_ISSUER"
    | "BAD_AUDIENCE"
    | "BAD_TOKEN_USE";

export interface JwtVerifyResult {
    ok: boolean;
    rejection?: JwtRejection;
    data?: VerifiedJwt;
}

export interface JwtVerifyOptions {
    /** Every key we are currently willing to accept a signature from. */
    keys: JsonWebKey[];
    expectedIssuer: string;
    /** When given, `aud` must match. Omit for an authorizer that serves many clients. */
    expectedAudience?: string;
    /** When given, the `token_use` claim must match — "access" or "id". */
    expectedTokenUse?: string;
}

/**
 * Keys are imported once per execution environment: converting a JWK to a KeyObject parses the
 * modulus and exponent, and doing that per request would be pure waste on the hottest path we have.
 */
const keyCache = new Map<string, ReturnType<typeof createPublicKey>>();

function keyObjectFor(jwk: JsonWebKey): ReturnType<typeof createPublicKey> | null {
    const cached = keyCache.get(jwk.kid);
    if (cached) return cached;
    try {
        const key = createPublicKey({ key: jwk as any, format: "jwk" });
        keyCache.set(jwk.kid, key);
        return key;
    } catch (err: any) {
        console.error(`JwtVerifyUtils: a configured JWK (kid=${jwk.kid}) could not be imported: ${err?.name ?? "UnknownError"}`);
        return null;
    }
}

/**
 * RETAINED DELIBERATELY — it currently has no caller.
 *
 * This existed to route a token to one of two verifiers while the authorizer trusted both our own
 * issuer and the Cognito user pool. That branch is gone (one issuer as of 2026-10-26), so nothing
 * calls this today. It is kept, with its tests, for one reason:
 *
 * The bug it was written to fix is subtle and would be made again. The first version of that
 * routing inferred "is this token ours?" from the REJECTION CODE, which does not work: verifyJwtRs256
 * looks up the `kid` BEFORE it examines `iss`, so a foreign token fails as UNKNOWN_KEY and never as
 * BAD_ISSUER. Every Cognito-authenticated request 401'd while the logs blamed an unknown key.
 *
 * If a second trusted issuer is ever introduced — a partner IdP, a migration, a staging pool — this
 * is the correct primitive to route with, and the tests covering it encode why. Deleting it would
 * mean rediscovering that from the symptom.
 *
 * Read the `iss` claim WITHOUT verifying anything.
 *
 * Used to choose which verifier a token belongs to when more than one issuer is trusted — not to
 * decide anything about the token. That distinction is what makes it safe: the verifier it routes
 * to still performs every check, so a mis-routed token can only be REJECTED, never accepted. The
 * alternative, inferring the issuer from a verification failure code, is what this replaces: a
 * foreign token fails at the `kid` lookup long before `iss` is ever examined, so the failure code
 * says nothing about who minted it.
 */
export function unverifiedIssuer(token: string): string | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        return typeof payload?.iss === "string" ? payload.iss : null;
    } catch {
        return null;
    }
}

export function verifyJwtRs256(token: string, options: JwtVerifyOptions): JwtVerifyResult {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, rejection: "MALFORMED" };
    const [rawHeader, rawPayload, rawSignature] = parts;

    let header: { alg?: string; kid?: string; typ?: string };
    let payload: Record<string, unknown>;
    try {
        header = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8"));
        payload = JSON.parse(Buffer.from(rawPayload, "base64url").toString("utf8"));
    } catch {
        return { ok: false, rejection: "MALFORMED" };
    }
    if (!payload || typeof payload !== "object") return { ok: false, rejection: "MALFORMED" };

    // 1. Pinned algorithm. Not negotiated with the token.
    if (header.alg !== "RS256") return { ok: false, rejection: "BAD_ALGORITHM" };

    // 2. A named key, and only a named key.
    const jwk = options.keys.find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, rejection: "UNKNOWN_KEY" };
    const keyObject = keyObjectFor(jwk);
    if (!keyObject) return { ok: false, rejection: "UNKNOWN_KEY" };

    // 3. Signature over the bytes as received — re-serialising the header or payload first would
    //    verify something the signer never signed.
    let signatureValid = false;
    try {
        signatureValid = createVerify("RSA-SHA256")
            .update(Buffer.from(`${rawHeader}.${rawPayload}`, "utf8"))
            .verify(keyObject, Buffer.from(rawSignature, "base64url"));
    } catch {
        return { ok: false, rejection: "BAD_SIGNATURE" };
    }
    if (!signatureValid) return { ok: false, rejection: "BAD_SIGNATURE" };

    // 4. Claims, now that the token is known to be ours.
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = typeof payload.exp === "number" ? payload.exp : null;
    const nbf = typeof payload.nbf === "number" ? payload.nbf : null;
    // A token with no exp never expires. Refuse it rather than honour it.
    if (exp === null || nowSec > exp + CLOCK_SKEW_LEEWAY_SEC) return { ok: false, rejection: "EXPIRED" };
    if (nbf !== null && nowSec + CLOCK_SKEW_LEEWAY_SEC < nbf) return { ok: false, rejection: "NOT_YET_VALID" };
    if (payload.iss !== options.expectedIssuer) return { ok: false, rejection: "BAD_ISSUER" };
    if (options.expectedTokenUse && payload.token_use !== options.expectedTokenUse) {
        // Without this an ID token would be accepted where an access token is required. They carry
        // different audiences and different lifetimes, and conflating them is a real escalation.
        return { ok: false, rejection: "BAD_TOKEN_USE" };
    }
    if (options.expectedAudience) {
        const aud = payload.aud;
        const matches = Array.isArray(aud)
            ? aud.includes(options.expectedAudience)
            : aud === options.expectedAudience;
        if (!matches) return { ok: false, rejection: "BAD_AUDIENCE" };
    }

    return { ok: true, data: { header: { alg: header.alg, kid: header.kid, typ: header.typ }, payload } };
}

/** Test-only: drop the imported-key cache. */
export function _resetKeyCache(): void {
    keyCache.clear();
}
