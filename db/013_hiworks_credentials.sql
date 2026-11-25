-- =====================================================================
-- NEOTMS :: 013_hiworks_credentials.sql
-- One person's own Hiworks sign-in, envelope-encrypted, plus the 내 정보 menu.
-- =====================================================================
--
-- Requested 2026-11-25 (팀장님).
--
-- Until now the Hiworks id and password were typed into the send dialog
-- every time and kept nowhere (see handover/NeotmsHandoverManager.ts).
-- That is still supported and still the fallback -- storing them is
-- OPTIONAL, per person, and nobody is required to do it.
--
-- APPLY THIS BEFORE THE DEPLOY. The 내 정보 screen selects this table on
-- every visit, so until it exists GET /api/v0/me/hiworks-credential
-- answers 42P01. Nothing else is affected: the two mail endpoints fall
-- back to credentials typed in the dialog, which is what they did before
-- this file existed.
--
-- ---------------------------------------------------------------------
-- WHY ENVELOPE ENCRYPTION AND NOT A KMS CALL PER FIELD
-- ---------------------------------------------------------------------
-- A password is well under KMS's 4 KB direct-encrypt limit, so Encrypt /
-- Decrypt on the CMK would also work and would need no columns for a key.
-- Envelope encryption is used anyway, for two reasons that outlive the
-- size question:
--
--   1. The CMK can be rotated, or replaced outright, without touching
--      the ciphertext. Re-wrapping a 32-byte data key is one UPDATE per
--      row; re-encrypting the secret would mean decrypting every
--      person's password into application memory to do it.
--   2. `kms_key_id` records WHICH key wrapped each row, so a half-done
--      rotation is a readable state rather than a pile of ciphertext
--      that may or may not still be decryptable.
--
-- The scheme: KMS GenerateDataKey mints a 256-bit key, the application
-- AES-256-GCM encrypts {id, password} with it, the plaintext key is
-- dropped and only its KMS-wrapped form is stored. See
-- lambdas/neotms/nodejs/utils/NeotmsEnvelope.ts.
--
-- The data key is bound to its owner through the KMS encryption context
-- (app, purpose and staff id). That is what makes a stolen row useless
-- in another row's place: moving ciphertext from one staff_id to another
-- makes the unwrap fail rather than yield somebody else's password.
--
-- ---------------------------------------------------------------------
-- WHY THE ID IS ENCRYPTED TOO, AND WHY A HINT COLUMN EXISTS ANYWAY
-- ---------------------------------------------------------------------
-- Both halves go inside the ciphertext, because an account name plus a
-- password is one credential and splitting it would put half of it in
-- plain sight for no gain.
--
-- `hiworks_id_hint` is the deliberate exception and the thing to be
-- careful with. The 내 정보 screen has to answer "which account is
-- stored" without decrypting anything, so a MASKED form of the id is
-- written here at save time -- `ab***@lionkorea.co.kr`, never the whole
-- address. The application writes it (maskHiworksId); nothing reads it
-- back as a credential, and it must never be widened into the full id.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The credential
-- ---------------------------------------------------------------------
-- `staff_id` IS the primary key, which is the one structural thing worth
-- stating plainly: one person has one Hiworks sign-in, and that is a key
-- constraint rather than a convention. A surrogate id with staff_id
-- merely indexed would let a bug leave two rows behind, after which
-- every read is "the most recent one, probably" and the dialog can send
-- from an account the person thought they had replaced.
--
-- ON DELETE CASCADE, following staff_recent_search rather than the
-- RESTRICT this schema uses for company data: a departed employee's own
-- sign-in is not company history, and it is the one thing in this
-- database that should outlive them least.
--
-- No created_by / created_ip audit columns. The row belongs to exactly
-- one person, who is the only one who can write it -- there is no second
-- actor for an audit column to distinguish, and recording the IP a
-- password was entered from adds a fact about somebody's location to the
-- row that holds their password.
CREATE TABLE IF NOT EXISTS staff_hiworks_credential (
  staff_id          bigint PRIMARY KEY REFERENCES staff (id) ON DELETE CASCADE,
  hiworks_id_hint   text NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_iv         bytea NOT NULL,
  secret_tag        bytea NOT NULL,
  wrapped_data_key  bytea NOT NULL,
  kms_key_id        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The two fixed widths AES-256-GCM uses. These are cheap and they fail
-- in the right direction: a 12-byte nonce and a 16-byte tag are what the
-- standard library crypto calls produce, so a row that does not match
-- them was written by something that is not this scheme, and
-- it is better refused at the INSERT than discovered at the Decrypt.
ALTER TABLE staff_hiworks_credential
  DROP CONSTRAINT IF EXISTS ck_hiworks_iv_len;
ALTER TABLE staff_hiworks_credential
  ADD CONSTRAINT ck_hiworks_iv_len CHECK (octet_length(secret_iv) = 12) NOT VALID;
ALTER TABLE staff_hiworks_credential VALIDATE CONSTRAINT ck_hiworks_iv_len;

ALTER TABLE staff_hiworks_credential
  DROP CONSTRAINT IF EXISTS ck_hiworks_tag_len;
ALTER TABLE staff_hiworks_credential
  ADD CONSTRAINT ck_hiworks_tag_len CHECK (octet_length(secret_tag) = 16) NOT VALID;
ALTER TABLE staff_hiworks_credential VALIDATE CONSTRAINT ck_hiworks_tag_len;

-- Nothing may be stored empty. A row's EXISTENCE is what "this person
-- registered their Hiworks account" means, so a row with an empty
-- ciphertext would be a third state -- registered but unusable -- that
-- no screen could explain.
ALTER TABLE staff_hiworks_credential
  DROP CONSTRAINT IF EXISTS ck_hiworks_not_empty;
ALTER TABLE staff_hiworks_credential
  ADD CONSTRAINT ck_hiworks_not_empty CHECK (
    octet_length(secret_ciphertext) > 0
    AND octet_length(wrapped_data_key) > 0
    AND length(btrim(hiworks_id_hint)) > 0
    AND length(btrim(kms_key_id)) > 0
  ) NOT VALID;
ALTER TABLE staff_hiworks_credential VALIDATE CONSTRAINT ck_hiworks_not_empty;

COMMENT ON TABLE staff_hiworks_credential IS
  'One person''s own Hiworks sign-in, so that sending a 인계메일 or a PO 발주 요청 does not ask for '
  'it every time. OPTIONAL per person -- no row means the send dialog asks, which is how the '
  'feature worked before this table existed. NEOTMS only; no legacy counterpart. Private to its '
  'staff_id: the only routes that touch it are under /api/v0/me/, scoped to the caller, and no '
  'administrative screen reads it. Envelope-encrypted -- see db/013_hiworks_credentials.sql.';

COMMENT ON COLUMN staff_hiworks_credential.hiworks_id_hint IS
  'A MASKED form of the Hiworks id, e.g. ''ab***@lionkorea.co.kr'', written by the application at '
  'save time so the 내 정보 screen can say which account is stored without a KMS call. The only '
  'part of the credential outside the ciphertext, deliberately partial, and never to be widened '
  'into the whole address.';

COMMENT ON COLUMN staff_hiworks_credential.secret_ciphertext IS
  'AES-256-GCM over the JSON {"id","password"}, under the data key in wrapped_data_key. Both halves '
  'of the credential are in here; nothing else is.';

COMMENT ON COLUMN staff_hiworks_credential.secret_iv IS
  'The 12-byte GCM nonce. Fresh on every write -- a reused nonce under the same key breaks GCM '
  'outright, which is why a save mints a new data key rather than re-using the stored one.';

COMMENT ON COLUMN staff_hiworks_credential.secret_tag IS
  'The 16-byte GCM authentication tag. Its verification is what makes a tampered ciphertext fail '
  'instead of decrypting to rubbish that is then typed into a Hiworks login form.';

COMMENT ON COLUMN staff_hiworks_credential.wrapped_data_key IS
  'The data key as KMS returns it (CiphertextBlob) -- the plaintext key exists only inside one '
  'request and is never written anywhere. Unwrapping it requires the same KMS encryption context '
  'the wrap used (app, purpose, staff id), so this blob is useless on another person''s row.';

COMMENT ON COLUMN staff_hiworks_credential.kms_key_id IS
  'Which CMK wrapped wrapped_data_key, as KMS reported it at the time. Recorded so a key rotation '
  'or replacement can find the rows it has not re-wrapped yet; the application does not choose a '
  'key from this column, it reads NEOTMS_HIWORKS_KMS_KEY_ID.';


-- ---------------------------------------------------------------------
-- 2. The sidebar row for 내 정보
-- ---------------------------------------------------------------------
-- ord_no 13, continuing 나의 업무 at 12.
--
-- NO PERMISSION IS ADDED, and that is the decision worth recording.
-- Every other menu in this system is gated on a grantable permission
-- name, because every other menu shows company data that somebody must
-- be entitled to see. This screen shows the caller their OWN settings,
-- so a grant would be a way to take away somebody's access to their own
-- account -- and a newly created role would silently not have it.
--
-- The routes are therefore `anyStaff` (the tier /me/recent-searches and
-- /me/notices already use), and the console shows the entry to every
-- approved staff member through an explicit any-staff gate rather than
-- through `may()`. See NEOTMS_NAV in frontend/src/shared/permissions.ts.
--
-- The row still exists because `sys_menu` is what somebody reading the
-- database sees, and because the bootstrap test asserts that every id in
-- NeotmsMenu is seeded -- a menu id with no row is the silent failure
-- db/006_workspace.sql warns about.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('MY_INFO', '내 정보', NULL, 1, '/me', 13, true)
ON CONFLICT (menu_id) DO NOTHING;


-- ---------------------------------------------------------------------
-- 3. No re-grant call, unlike every previous menu file
-- ---------------------------------------------------------------------
-- 006, 008 and 015 all end with sys_role_grant_all_permissions because
-- they added a PERMISSION, and grants written once do not cover
-- permissions added later. This file adds none, so there is nothing to
-- re-grant: the superuser reaches 내 정보 the same way everybody else
-- does, by being registered staff.
--
-- Running the call anyway would be harmless and idempotent. It is left
-- out so that the absence is a statement rather than an oversight.

COMMIT;


-- =====================================================================
-- VERIFICATION
-- =====================================================================
-- Expect one row, with the menu present and no permission invented:
--
--   SELECT count(*) AS credentials FROM staff_hiworks_credential;
--   SELECT menu_id, menu_name, ord_no FROM sys_menu WHERE menu_id = 'MY_INFO';
--   SELECT count(*) AS should_be_zero FROM sys_role_permission
--    WHERE permission LIKE '%MY_INFO%';
--
-- And the thing most worth checking after a deploy -- that no plaintext
-- ever landed here. Both counts must be zero:
--
--   SELECT count(*) AS plaintext_hints FROM staff_hiworks_credential
--    WHERE hiworks_id_hint NOT LIKE '%*%';
--   SELECT count(*) AS short_keys FROM staff_hiworks_credential
--    WHERE octet_length(wrapped_data_key) < 64;
-- =====================================================================
