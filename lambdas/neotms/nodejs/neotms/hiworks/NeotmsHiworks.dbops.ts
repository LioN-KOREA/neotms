// SPDX-License-Identifier: MIT
//
// `staff_hiworks_credential` - one person's own Hiworks sign-in, sealed.
//
// ## Private by identity, like staff_recent_search and unlike everything else
//
// Every statement here takes a `staffId` and puts it in the WHERE clause, and there is no listing
// op, no "by id" op and no administrative read. `staff.view_scope` does not apply and could not:
// view scope widens access to COMPANY data, and a colleague's Hiworks password is not company data
// at any scope. So the narrowing is identity, the routes are `anyStaff`, and the absence of a
// list-everybody statement is the enforcement rather than a check somewhere.
//
// ## Two reads, and the difference between them matters
//
// `HiworksCredentialStatusOps` selects the hint and the timestamps and NOT ONE of the secret
// columns. It is what the 내 정보 screen calls, which means the common read of this table - a
// person opening their settings page - cannot leak ciphertext even if the response shape were
// wrong, because the ciphertext is not in the result set.
//
// `HiworksCredentialSealedOps` selects the sealed material and is called from exactly one place:
// resolving credentials for a send that is about to happen. Keeping them apart is what lets the
// status read be the one that runs often.

import {
  param,
  readBytes,
  readText,
  type SqlOps,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { SealedSecret } from "../../utils/KmsEnvelopeUtils.js";

/** What the settings screen is told. No secret column is read to build this. */
export type HiworksCredentialStatus = {
  /** The masked id, e.g. `ab***@lionkorea.co.kr`. Never the whole address - see db/013. */
  hiworksIdHint: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export const HiworksCredentialStatusOps: (
  staffId: string,
) => SqlOps<HiworksCredentialStatus | null> = (staffId) => ({
  sql: `
    SELECT hiworks_id_hint,
           created_at,
           updated_at
      FROM staff_hiworks_credential
     WHERE staff_id = :staff_id
  `,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => (rows[0] ? toStatus(rows[0]) : null),
});

const toStatus = (row: SqlRow): HiworksCredentialStatus => ({
  hiworksIdHint: readText(row, "hiworks_id_hint") ?? "",
  createdAt: readText(row, "created_at"),
  updatedAt: readText(row, "updated_at"),
});

/**
 * The sealed credential, for a send.
 *
 * Returns null when there is no row, which is the normal case for anybody who has not opted in -
 * not an error, and the caller falls back to asking for the credentials in the dialog.
 */
export const HiworksCredentialSealedOps: (staffId: string) => SqlOps<SealedSecret | null> = (
  staffId,
) => ({
  sql: `
    SELECT secret_ciphertext,
           secret_iv,
           secret_tag,
           wrapped_data_key,
           kms_key_id
      FROM staff_hiworks_credential
     WHERE staff_id = :staff_id
  `,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => (rows[0] ? toSealed(rows[0]) : null),
});

/**
 * Null when any piece is missing, rather than a half-built object.
 *
 * The CHECK constraints in db/013 make that unreachable through this application, so this is for
 * the row somebody wrote by hand in the SQL editor. The failure to want is "we cannot open this,
 * please enter it again", not a decipher that throws three frames further in.
 */
const toSealed = (row: SqlRow): SealedSecret | null => {
  const ciphertext = readBytes(row, "secret_ciphertext");
  const iv = readBytes(row, "secret_iv");
  const tag = readBytes(row, "secret_tag");
  const wrappedDataKey = readBytes(row, "wrapped_data_key");
  const kmsKeyId = readText(row, "kms_key_id");
  if (!ciphertext || !iv || !tag || !wrappedDataKey || !kmsKeyId) return null;
  return { ciphertext, iv, tag, wrappedDataKey, kmsKeyId };
};

/**
 * Store, or replace, the caller's credential.
 *
 * `ON CONFLICT (staff_id) DO UPDATE` is what makes "register" and "change my password" one
 * endpoint. There is no second row to leave behind, because `staff_id` is the primary key - which
 * is the reason db/013 moved the key there from the surrogate id the first draft had.
 *
 * Every secret column is replaced together, and that is not merely tidy. A save mints a FRESH data
 * key and a fresh nonce (see KmsEnvelopeUtils), so leaving any one of the five behind would pair a
 * new ciphertext with an old key or an old nonce, and GCM's security argument depends on that pair
 * never repeating.
 *
 * `created_at` is deliberately NOT in the update list: it records when this person first stored a
 * Hiworks account, and changing a password is not a new registration.
 */
export const HiworksCredentialSaveOps: (
  staffId: string,
  hiworksIdHint: string,
  sealed: SealedSecret,
) => SqlOps<number> = (staffId, hiworksIdHint, sealed) => ({
  sql: `
    INSERT INTO staff_hiworks_credential (
      staff_id, hiworks_id_hint, secret_ciphertext, secret_iv, secret_tag,
      wrapped_data_key, kms_key_id
    )
    VALUES (
      :staff_id, :hint, :ciphertext, :iv, :tag, :data_key, :kms_key_id
    )
    ON CONFLICT (staff_id) DO UPDATE
       SET hiworks_id_hint   = EXCLUDED.hiworks_id_hint,
           secret_ciphertext = EXCLUDED.secret_ciphertext,
           secret_iv         = EXCLUDED.secret_iv,
           secret_tag        = EXCLUDED.secret_tag,
           wrapped_data_key  = EXCLUDED.wrapped_data_key,
           kms_key_id        = EXCLUDED.kms_key_id,
           updated_at        = now()
    RETURNING staff_id
  `,
  parameters: [
    param("staff_id", staffId, "id"),
    param("hint", hiworksIdHint, "text"),
    param("ciphertext", sealed.ciphertext, "bytea"),
    param("iv", sealed.iv, "bytea"),
    param("tag", sealed.tag, "bytea"),
    param("data_key", sealed.wrappedDataKey, "bytea"),
    param("kms_key_id", sealed.kmsKeyId, "text"),
  ],
  mapper: (rows) => rows.length,
});

/**
 * Forget the caller's credential.
 *
 * A real DELETE, not a `deleted` flag. Every other table in this schema soft-deletes, because a
 * project or a PO is a record of something that happened and is wanted afterwards. This row is the
 * opposite: somebody asking for their password to be forgotten is asking for the bytes to go, and a
 * soft delete would answer that request by keeping them.
 */
export const HiworksCredentialDeleteOps: (staffId: string) => SqlOps<number> = (staffId) => ({
  sql: `
    DELETE FROM staff_hiworks_credential
     WHERE staff_id = :staff_id
    RETURNING staff_id
  `,
  parameters: [param("staff_id", staffId, "id")],
  mapper: (rows) => rows.length,
});
