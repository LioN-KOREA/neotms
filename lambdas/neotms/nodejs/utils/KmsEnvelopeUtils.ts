// SPDX-License-Identifier: MIT
//
// Envelope encryption over a KMS customer-managed key.
//
// KMS mints a one-use 256-bit data key and hands it back twice - once in the clear, once wrapped
// under the CMK. We encrypt with the clear copy, store the wrapped one, and drop the clear one. To
// read the secret back, KMS unwraps the stored copy. The CMK itself never leaves KMS, so there is
// no key material in this repository, in an environment variable, or in a database column.
//
// ## Why envelope encryption for something as small as a password
//
// A credential is far below KMS's 4 KB direct-encrypt limit, so `Encrypt` / `Decrypt` straight on
// the CMK would work and would need no wrapped-key column. The envelope is used anyway because it
// decouples the key from the ciphertext: rotating or replacing the CMK re-wraps a 32-byte key per
// row, where direct encryption would mean decrypting every stored secret into this process's memory
// to re-encrypt it. The one operation you least want to perform in bulk is the one that briefly
// holds every password at once.
//
// ## The encryption context is the part that is easy to leave out
//
// `EncryptionContext` is additional authenticated data on the KMS call: the same pairs must be
// supplied to unwrap as were supplied to wrap, or KMS refuses. It is not secret - it appears in
// CloudTrail, which is half the point - and it is what stops a row being used in another row's
// place. Move a ciphertext from one person's row to another's and the unwrap fails, instead of
// yielding a password to whoever owns the row it was moved into.
//
// Without it, every wrapped key in the table is interchangeable, and SQL UPDATE access becomes
// read access to any colleague's credential.
//
// ## AES-256-GCM, and why the nonce is never reused
//
// GCM is authenticated, so a tampered ciphertext fails to open rather than decrypting to rubbish
// that then gets typed into somebody's login form. The price is that a nonce must never repeat
// under one key: two messages under the same key and nonce leak their XOR and, worse, the
// authentication subkey. This module sidesteps the question entirely by minting a FRESH data key on
// every seal - the nonce is random, the key is single-use, and so a repeat would need both to
// collide at once.

import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 12 bytes, which is the GCM standard and what every implementation expects by default.
 *
 * Not an arbitrary choice: 96 bits is the only nonce length GCM uses directly. Any other length is
 * hashed into one first, which is legal but means two different lengths can collide.
 */
const GCM_IV_BYTES = 12;
/** 16 bytes. Truncating a GCM tag weakens forgery resistance for no saving worth having. */
const GCM_TAG_BYTES = 16;
const GCM_ALGORITHM = "aes-256-gcm";

let client: KMSClient | null = null;

function getClient(): KMSClient {
  client ??= new KMSClient();
  return client;
}

/** Additional authenticated data for the KMS call. Not secret; see this file's header. */
export type KmsEncryptionContext = Readonly<Record<string, string>>;

/** What a sealed secret is made of. Every field goes to the database; none of them is the key. */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  /** The data key as KMS wrapped it. Useless without the CMK and the same encryption context. */
  readonly wrappedDataKey: Buffer;
  /** Which key KMS used, as KMS reported it - recorded so a rotation can find un-re-wrapped rows. */
  readonly kmsKeyId: string;
}

/**
 * Encrypt `plaintext` under a fresh data key from `keyId`.
 *
 * Returns null rather than throwing, and deliberately says nothing about why in the return value:
 * every caller's correct response is the same ("could not store this"), and the failure detail
 * belongs in CloudTrail and the log line below rather than in a value that might reach a response
 * body.
 */
export async function sealSecret(
  keyId: string,
  context: KmsEncryptionContext,
  plaintext: string,
): Promise<SealedSecret | null> {
  if (!keyId) {
    console.error("sealSecret: no KMS key configured.");
    return null;
  }

  let dataKey: Buffer | null = null;
  try {
    const minted = await getClient().send(new GenerateDataKeyCommand({
      KeyId: keyId,
      KeySpec: "AES_256",
      EncryptionContext: { ...context },
    }));
    if (!minted.Plaintext || !minted.CiphertextBlob || !minted.KeyId) {
      console.error("sealSecret: KMS returned an incomplete data key.");
      return null;
    }
    dataKey = Buffer.from(minted.Plaintext);
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv(GCM_ALGORITHM, dataKey, iv, { authTagLength: GCM_TAG_BYTES });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ciphertext,
      iv,
      tag: cipher.getAuthTag(),
      wrappedDataKey: Buffer.from(minted.CiphertextBlob),
      kmsKeyId: minted.KeyId,
    };
  } catch (err) {
    /*
     * The message names the KMS failure and the KEY, and nothing else. The key ARN is not a secret
     * - it is in the function's environment - and it is the single most useful fact when the cause
     * is "this deployment cannot use that key", which is the common failure in a multi-account
     * arrangement where several deployments share one database.
     *
     * `AccessDeniedException` means the grant or the key policy; `NotFoundException` means the ARN
     * names nothing reachable from this account; `DisabledException` and `KMSInvalidStateException`
     * mean the key exists but is off or pending deletion. All four are configuration, and all four
     * are distinguishable here by name.
     */
    console.error(
      `sealSecret: KMS GenerateDataKey failed on ${keyId}: ${err instanceof Error ? err.name : "unknown"}`,
    );
    return null;
  } finally {
    // Best effort, and honestly labelled as such: this clears the one copy we hold, but Node may
    // have made others while decoding the response, and a garbage collector can relocate a buffer
    // at any time. It is worth doing because it shortens the window in a heap dump, not because it
    // makes one safe.
    dataKey?.fill(0);
  }
}

/**
 * Unwrap the data key and decrypt.
 *
 * Fails - returns null - when the CMK is gone, when the caller is not allowed to use it, when the
 * encryption context does not match what the seal used, and when the tag does not verify. Those are
 * four different problems with one correct response, which is to treat the stored credential as
 * unusable and ask for it to be entered again.
 */
export async function openSecret(
  context: KmsEncryptionContext,
  sealed: SealedSecret,
): Promise<string | null> {
  if (sealed.iv.length !== GCM_IV_BYTES || sealed.tag.length !== GCM_TAG_BYTES) {
    console.error("openSecret: stored nonce or tag is the wrong length.");
    return null;
  }

  /*
   * TWO try blocks, not one, and the split is the point.
   *
   * Unwrapping the data key and decrypting the payload fail for completely different reasons, and
   * one combined catch reports them identically - which is useless precisely when it matters. A
   * `Decrypt` failure means the KEY is unusable from here: the grant, the key policy, the wrong
   * account, the wrong region, a disabled key, or an encryption context that no longer matches.
   * A decipher failure means the KEY WORKED and the stored BYTES are wrong: a tampered or
   * truncated ciphertext, or a tag that does not verify.
   *
   * "Was it the key or was it something else" is the first question asked when this feature
   * misbehaves, and these two messages answer it without anybody having to reason about it.
   */
  let dataKey: Buffer | null = null;
  try {
    try {
      const unwrapped = await getClient().send(new DecryptCommand({
        CiphertextBlob: sealed.wrappedDataKey,
        EncryptionContext: { ...context },
        // Named explicitly although a symmetric blob carries its own key id. Passing it makes KMS
        // refuse a blob wrapped under a DIFFERENT key rather than quietly succeeding, which is what
        // turns "somebody swapped a column" into an error.
        KeyId: sealed.kmsKeyId || undefined,
      }));
      if (!unwrapped.Plaintext) {
        console.error(`openSecret: KMS returned no key material for key ${sealed.kmsKeyId}.`);
        return null;
      }
      dataKey = Buffer.from(unwrapped.Plaintext);
    } catch (err) {
      console.error(
        `openSecret: KMS Decrypt of the stored data key failed on ${sealed.kmsKeyId}: ` +
          `${err instanceof Error ? err.name : "unknown"}. The KEY is unusable from this ` +
          `deployment - check the grant, the key policy and the account the key lives in.`,
      );
      return null;
    }

    try {
      const decipher = createDecipheriv(GCM_ALGORITHM, dataKey, sealed.iv, {
        authTagLength: GCM_TAG_BYTES,
      });
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
    } catch (err) {
      console.error(
        `openSecret: the data key unwrapped but the payload did not decrypt ` +
          `(${err instanceof Error ? err.name : "unknown"}). The key is fine; the stored bytes ` +
          `are not - the row was altered, truncated, or written by something else.`,
      );
      return null;
    }
  } finally {
    dataKey?.fill(0);
  }
}
