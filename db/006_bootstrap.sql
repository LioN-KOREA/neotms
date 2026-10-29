-- =====================================================================
-- NEOTMS :: 006_bootstrap.sql
-- Run after 002_tables.sql. Idempotent -- re-run it as often as you like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   002..005 create an entirely empty database, and an entirely empty
--   database cannot be signed into. The chicken-and-egg is exact:
--
--     * NeotmsAuthGuard refuses any identity with no `staff` row -- 403,
--       "This account is not registered as NEOTMS staff."
--     * The only way to create a `staff` row is through NEOTMS.
--     * There is no admin API route at all (see the route table in
--       neotms.handler.ts: 4 open auth routes, 1 `anyStaff` route, 22
--       menu-gated CRUD routes, and nothing that writes `staff` or
--       `sys_role`).
--
--   So the first administrator has to come from outside the application.
--   This file is that outside: it seeds the navigation tree, creates one
--   superuser role, and installs the function the Lambda calls to
--   provision the first staff row for a holder of LPX's own
--   `lpx.admin.access` authority.
--
--   After that, nothing here is needed again. It stays in the repository
--   because "how do I get back in" is a question that gets asked once a
--   year, at the worst possible moment.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/006_bootstrap.sql
--
--   Every statement is an upsert or a CREATE OR REPLACE, so applying it
--   twice changes nothing. It contains no `:placeholder` -- unlike an
--   application query, this file is written for psql and the Supabase SQL
--   editor and can be pasted into either as-is. (See the note in
--   004_rollup.sql: `:name` is a convention of this application's query
--   layer, not SQL.)
--
--   It also contains no `\set`, no BEGIN and no COMMIT, for the same
--   reason 002..005 do not: `\` is a psql meta-command that the Supabase
--   SQL editor rejects outright, and the editor already runs what you
--   paste in a transaction of its own. Every statement here is
--   independently idempotent, so a partial application is recovered by
--   running the file again rather than by rolling anything back.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   It does not name a person. There is no `INSERT INTO staff` with
--   somebody's email in it, because a seeded credential-shaped row is the
--   thing that gets forgotten and left enabled - and this schema has no
--   passwords to leak precisely so that cannot happen. Instead the staff
--   row is minted at first sign-in, by LPX's own superuser, from LPX's own
--   identity. The authority is the credential; this file only teaches the
--   database what to do when one shows up.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. sys_menu -- the six menus this application actually gates on
-- ---------------------------------------------------------------------
-- Legacy SY_MENU has 48 rows. NEOTMS's route table gates on six menu ids
-- (NeotmsMenus.ts), and those six are the ones seeded here, with the
-- labels and the order the sidebar already uses (frontend/src/shared/
-- permissions.ts -> NEOTMS_NAV).
--
-- Seeding these is NOT optional, and not only for permissions: GET
-- /api/v0/me builds its menu list by reading `sys_menu` and looking each
-- row up in the caller's permission map (NeotmsProfileManager ->
-- MenuTreeOps). With `sys_menu` empty, a successfully signed-in
-- superuser gets `menus: []` and the console renders an empty sidebar --
-- a login that works and an application that appears to have no features.
--
-- ON CONFLICT DO NOTHING, not DO UPDATE: once the ETL or an
-- administrator has edited a label, this file must not quietly reset it.
-- The id is the only part that matters to the code.
--
-- menu_depth is 1 and menu_parent is NULL for all six - this is a flat
-- bar, not a tree. The legacy tree structure arrives with the ETL.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('PROJECT',        '프로젝트', NULL, 1, '/projects',        1, true),
  ('JOB',            '작업',     NULL, 1, '/jobs',            2, true),
  ('PURCHASE_ORDER', '발주',     NULL, 1, '/purchase-orders', 3, true),
  ('CUSTOMER',       '고객사',   NULL, 1, '/customers',       4, true),
  ('TRANSLATOR',     '번역가',   NULL, 1, '/translators',     5, true),
  ('REPORT',         '보고서',   NULL, 1, '/reports',         6, true)
ON CONFLICT (menu_id) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2. sys_role -- 시스템관리자, the NEOTMS superuser
-- ---------------------------------------------------------------------
-- `role_code` is `NEOTMS_SYSADMIN` rather than the obvious `SYSADMIN`,
-- and the ugliness is the point. Legacy SY_ROLE.ROLE_ID values have not
-- been profiled yet, and `role_code` is UNIQUE: if the legacy data
-- happens to contain a role called `SYSADMIN`, this file's upsert would
-- land on THAT row and section 3 below would then grant every right on
-- every menu to whichever staff already hold it. A prefixed code cannot
-- collide with a legacy value, so the ETL and this file cannot fight over
-- one row.
--
-- DO UPDATE rather than DO NOTHING here, unlike the menus above. This row
-- belongs to this file: re-running must reassert that the superuser role
-- exists, is named 시스템관리자 and is active, because an operator
-- re-running a bootstrap script is almost always an operator who has just
-- been locked out.
INSERT INTO sys_role (role_code, role_name, active, created_by)
VALUES ('NEOTMS_SYSADMIN', '시스템관리자', true, 'neotms-bootstrap')
ON CONFLICT (role_code) DO UPDATE
   SET role_name  = EXCLUDED.role_name,
       active     = true,
       updated_at = now();

-- A COLUMN comment, not a replacement for 002_tables.sql's comment on the
-- TABLE. `COMMENT ON` has no append form -- it only takes a literal and it
-- overwrites -- so restating the table comment here would copy a paragraph
-- out of 002 and then let the two drift. `sys_role.role_name` is the one
-- piece of this table 002 leaves uncommented, and it is the right place for
-- this anyway.
COMMENT ON COLUMN sys_role.role_name IS
  'Display label for the role. The row with role_code ''NEOTMS_SYSADMIN'' is labelled 시스템관리자 '
  'and is created by db/006_bootstrap.sql: it is the application''s superuser (every menu, every '
  'action) and the role handed to a holder of LPX''s lpx.admin.access authority on first sign-in, '
  'by staff_bootstrap_superuser(). Do not delete that row, and do not narrow its grants expecting '
  'them to stay narrowed -- re-running the bootstrap restores them.';


-- ---------------------------------------------------------------------
-- 3. sys_role_grant_all_menus() -- "this role may do everything"
-- ---------------------------------------------------------------------
-- A function rather than a flat INSERT, for one reason that only shows up
-- later: `sys_menu` will grow. Today it has the six rows above; after the
-- ETL loads legacy SY_MENU it has 48. A superuser role whose grants were
-- written once as literal rows would silently have no rights on the 42
-- new menus, and "no rights" is the failure mode with no error message --
-- the screens just refuse, with a message blaming the role.
--
-- So the grant is expressed as "every active menu, re-evaluated when
-- asked", and the operating instruction is one line:
--
--   SELECT sys_role_grant_all_menus('NEOTMS_SYSADMIN');
--
-- Run it after any change to `sys_menu`, including the ETL. It is NOT a
-- trigger on sys_menu on purpose: a trigger would grant rights as a side
-- effect of loading a navigation row, and silently widening an
-- authorization matrix is the one behaviour this schema refuses to have.
CREATE OR REPLACE FUNCTION sys_role_grant_all_menus(p_role_code text)
RETURNS integer
LANGUAGE plpgsql
-- Pinned, like every function in db/: the pooler gives out whatever
-- session it has, and a function whose table references depend on the
-- caller's search_path is a function that resolves differently depending
-- on who called it.
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_role_id bigint;
  v_menus   integer;
BEGIN
  SELECT id INTO v_role_id FROM sys_role WHERE role_code = p_role_code;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION
      'sys_role_grant_all_menus: no sys_role row has role_code = %. '
      'Apply db/006_bootstrap.sql, or check the spelling.', p_role_code;
  END IF;

  /*
   * All five action flags true. The five are read / create / update /
   * delete / export (ACTION_INDEX in NeotmsAuthGuard.ts) -- an
   * UNCONFIRMED mapping against legacy ROLE_1..ROLE_5, which is exactly
   * why the superuser grant sets all five rather than naming any of them.
   * Whatever the five turn out to mean, "all of them" is still right for
   * the superuser, so this grant cannot be invalidated by confirming the
   * mapping later.
   */
  INSERT INTO sys_role_auth (role_id, menu_id, role_1, role_2, role_3, role_4, role_5,
                             active, created_by)
  SELECT v_role_id, m.menu_id, true, true, true, true, true, true, 'neotms-bootstrap'
    FROM sys_menu m
   WHERE m.active
  ON CONFLICT (role_id, menu_id) DO UPDATE
     SET role_1 = true,
         role_2 = true,
         role_3 = true,
         role_4 = true,
         role_5 = true,
         active = true;

  GET DIAGNOSTICS v_menus = ROW_COUNT;

  /*
   * sys_role_menu as well, and it is a separate table for a real reason:
   * sys_role_auth says what may be done inside a menu, sys_role_menu says
   * whether the menu is visible at all. Granting one without the other
   * produces a role that is permitted to use a screen it cannot navigate
   * to -- which reads as "the permission did not work".
   */
  INSERT INTO sys_role_menu (role_id, menu_id, active, created_by)
  SELECT v_role_id, m.menu_id, true, 'neotms-bootstrap'
    FROM sys_menu m
   WHERE m.active
  ON CONFLICT (role_id, menu_id) DO UPDATE
     SET active = true;

  RETURN v_menus;
END;
$fn$;

COMMENT ON FUNCTION sys_role_grant_all_menus(text) IS
  'Grants one role every action on every active sys_menu row, and makes every one of them visible. '
  'Idempotent; returns the number of menus granted. Re-run it after anything that adds rows to '
  'sys_menu (notably the legacy ETL), because grants written once do not cover menus added later '
  'and the resulting failure is a silent refusal rather than an error.';

-- Apply it now, to the six menus seeded above.
SELECT sys_role_grant_all_menus('NEOTMS_SYSADMIN') AS menus_granted;


-- ---------------------------------------------------------------------
-- 4. staff_bootstrap_superuser() -- the way back in
-- ---------------------------------------------------------------------
-- Called by NeotmsAuthGuard when, and only when, an authenticated LPX
-- identity holds the bootstrap authority (`lpx.admin.access`, configured
-- as NEOTMS_BOOTSTRAP_AUTHORITY_ID) and has no usable staff row. It
-- returns `staff.id`; the guard then re-reads the row through the same
-- query every other sign-in uses, so there is exactly one mapping from
-- staff row to caller.
--
-- WHY A FUNCTION, AND NOT THREE STATEMENTS IN TYPESCRIPT
--   The pooler is in transaction mode. A function call is one statement
--   and therefore one transaction, atomic without the application having
--   to open one -- and `BEGIN`/`COMMIT` issued from the application is
--   precisely what transaction-mode pooling does not reliably give you.
--   The decision below reads an existing row, may adopt a legacy row, and
--   may insert and retry; as three application statements, two concurrent
--   first sign-ins could interleave into two staff rows for one person.
--
-- WHY IT RETURNS bigint AND NOT THE ROW
--   Tempting to wrap the call in a CTE and join `staff` in the same
--   statement. Don't: every part of a single statement reads from the
--   snapshot taken when the statement began, so the join would be looking
--   for a row this statement has not yet made visible to it. The guard
--   does a second, ordinary SELECT instead.
--
-- THE CONSEQUENCE, STATED PLAINLY
--   A holder of lpx.admin.access cannot be locked out of NEOTMS FROM
--   INSIDE NEOTMS. Deactivating their staff row does not stop them: the
--   next sign-in reactivates it. That is deliberate -- it is what makes
--   this a reliable way back in -- but it means the real revocation is
--   removing the authority on LPX, not editing a row here. Section 5
--   below is how you check who has been let in this way.
CREATE OR REPLACE FUNCTION staff_bootstrap_superuser(
  p_lpx_sub text,
  p_email   text,
  p_name    text
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  /*
   * Every local is `v_`-prefixed and every parameter `p_`-prefixed, and
   * that is not decoration. In PL/pgSQL a variable whose name matches a
   * column of a table the statement touches raises `column reference
   * "..." is ambiguous` -- at CALL time, not at CREATE time, so a plain
   * `lpx_sub` here would compile cleanly and then fail on the first real
   * sign-in. The prefixes make the collision impossible by construction.
   */
  v_role_id    bigint;
  v_staff_id   bigint;
  v_base       text;
  v_mgr_id     text;
  v_attempt    integer;
  v_constraint text;
BEGIN
  IF p_lpx_sub IS NULL OR btrim(p_lpx_sub) = '' THEN
    RAISE EXCEPTION 'staff_bootstrap_superuser: p_lpx_sub must not be blank';
  END IF;

  SELECT id INTO v_role_id FROM sys_role WHERE role_code = 'NEOTMS_SYSADMIN';
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION
      'staff_bootstrap_superuser: the NEOTMS_SYSADMIN role is missing. '
      'Apply db/006_bootstrap.sql in full -- this function is useless without it.';
  END IF;

  /* ------------------------------------------------------------------ *
   * (a) This identity already has a row. Repair it; never downgrade it.
   *
   *     Reached when the row exists but the guard could not use it --
   *     `active = false`, `deleted = true`, or `role_id IS NULL`. Each is
   *     a hard lockout with no screen to fix it from.
   *
   *     COALESCE everywhere, so this REPAIRS and never OVERRIDES. A
   *     deliberately narrow role, or a view_scope of 'N', is a
   *     configuration decision and is left exactly as it was found;
   *     only a blank is filled in. An admin who assigned themselves the
   *     PM role keeps it -- what they get back is the ability to sign
   *     in, which is all that was missing.
   * ------------------------------------------------------------------ */
  SELECT id INTO v_staff_id FROM staff WHERE lpx_sub = p_lpx_sub;
  IF v_staff_id IS NOT NULL THEN
    UPDATE staff
       SET active     = true,
           deleted    = false,
           role_id    = COALESCE(role_id, v_role_id),
           view_scope = COALESCE(NULLIF(btrim(view_scope), ''), 'Y'),
           mgr_name   = COALESCE(NULLIF(btrim(mgr_name), ''),  NULLIF(btrim(p_name), '')),
           mgr_email  = COALESCE(NULLIF(btrim(mgr_email), ''), NULLIF(btrim(p_email), '')),
           updated_at = now()
     WHERE id = v_staff_id;
    RETURN v_staff_id;
  END IF;

  /* ------------------------------------------------------------------ *
   * (b) An unclaimed legacy row with the same email. Adopt it.
   *
   *     The guard's own just-in-time linking (StaffUnclaimedByEmailOps)
   *     already handles the normal case, but it requires `active = true`.
   *     This covers the leftover: an unclaimed row that the ETL loaded
   *     inactive. Adopting it rather than minting a second row matters
   *     because `mgr_id` is what every legacy REG_ID column references --
   *     a duplicate row means one person with two identities and a
   *     project history split between them.
   *
   *     `deleted = false` is required here even though branch (a)
   *     un-deletes. The difference: in (a) the row is provably this
   *     identity's, because it carries their `sub`. Here the only
   *     evidence is a matching email, and reviving a soft-deleted staff
   *     record on that evidence is a step too far -- those rows fall
   *     through to (c) and get a fresh identity instead.
   *
   *     `ORDER BY id` because legacy mgr_email is not unique; oldest
   *     wins, deterministically. FOR UPDATE, and the UPDATE repeats the
   *     `lpx_sub IS NULL` test, so two concurrent sign-ins cannot both
   *     adopt the same row.
   * ------------------------------------------------------------------ */
  IF NULLIF(btrim(COALESCE(p_email, '')), '') IS NOT NULL THEN
    SELECT id INTO v_staff_id
      FROM staff
     WHERE lpx_sub IS NULL
       AND deleted = false
       AND lower(btrim(mgr_email)) = lower(btrim(p_email))
     ORDER BY id
     LIMIT 1
       FOR UPDATE;

    IF v_staff_id IS NOT NULL THEN
      UPDATE staff
         SET lpx_sub    = p_lpx_sub,
             active     = true,
             role_id    = COALESCE(role_id, v_role_id),
             view_scope = COALESCE(NULLIF(btrim(view_scope), ''), 'Y'),
             mgr_name   = COALESCE(NULLIF(btrim(mgr_name), ''), NULLIF(btrim(p_name), '')),
             updated_at = now()
       WHERE id = v_staff_id
         AND lpx_sub IS NULL;
      IF FOUND THEN
        RETURN v_staff_id;
      END IF;
      v_staff_id := NULL;
    END IF;
  END IF;

  /* ------------------------------------------------------------------ *
   * (c) Mint a new staff row.
   *
   *     `mgr_id` is `text NOT NULL UNIQUE` and is the human-readable key
   *     that ends up in `created_by` on every record this person touches,
   *     so it wants to be recognisable rather than a UUID. The email
   *     local part, stripped to the characters a legacy id can hold, is
   *     the best available answer; a Korean-only or missing email leaves
   *     nothing after the strip, hence the 'admin' floor.
   * ------------------------------------------------------------------ */
  v_base := lower(
    regexp_replace(split_part(COALESCE(NULLIF(btrim(p_email), ''), 'admin'), '@', 1),
                   '[^A-Za-z0-9._-]', '', 'g')
  );
  v_base := left(COALESCE(NULLIF(v_base, ''), 'admin'), 40);

  /*
   * Collision handling. The EXISTS-then-INSERT shape would race; this
   * one lets the UNIQUE constraint decide and reacts to which constraint
   * fired, inside a BEGIN..EXCEPTION block (a subtransaction, so a
   * failed attempt rolls back without losing the whole call).
   */
  FOR v_attempt IN 1..10 LOOP
    v_mgr_id := CASE WHEN v_attempt = 1 THEN v_base ELSE v_base || v_attempt::text END;
    BEGIN
      INSERT INTO staff (mgr_id, lpx_sub, mgr_name, mgr_email,
                         role_id, view_scope, active, deleted, created_by)
      VALUES (v_mgr_id,
              p_lpx_sub,
              NULLIF(btrim(COALESCE(p_name, '')), ''),
              NULLIF(btrim(COALESCE(p_email, '')), ''),
              v_role_id,
              -- 'Y' is the value VIEW_SCOPE_ALL recognises as "sees every
              -- row". Anything unrecognised means "own rows only", so a
              -- superuser with a blank view_scope would be able to open
              -- every screen and see nothing on any of them.
              'Y',
              true,
              false,
              -- The audit marker. `created_by` is plain text (historical
              -- rows reference mgr_ids that no longer exist), which makes
              -- it a usable tag: see the review query in section 5.
              'lpx-bootstrap')
      RETURNING id INTO v_staff_id;

      RETURN v_staff_id;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

      /*
       * `staff_lpx_sub_key` is PostgreSQL's generated name for the UNIQUE
       * on staff.lpx_sub (<table>_<column>_key). Hitting it means a
       * concurrent sign-in by this same person -- a double-clicked login,
       * or two tabs -- got there first, so their row is the answer.
       */
      IF v_constraint = 'staff_lpx_sub_key' THEN
        SELECT id INTO v_staff_id FROM staff WHERE lpx_sub = p_lpx_sub;
        IF v_staff_id IS NOT NULL THEN
          RETURN v_staff_id;
        END IF;
        -- The winner has not committed yet, so its row is not visible to
        -- this transaction and there is nothing honest to return. Re-raise
        -- and let the caller retry; the guard reports it as a 503.
        RAISE;
      END IF;

      -- Otherwise it was `staff_mgr_id_key`: the readable id is taken by
      -- a different person. Next suffix.
    END;
  END LOOP;

  RAISE EXCEPTION
    'staff_bootstrap_superuser: could not allocate a free mgr_id from the base "%" '
    'in 10 attempts. Create the staff row by hand and set its lpx_sub to %.',
    v_base, p_lpx_sub;
END;
$fn$;

COMMENT ON FUNCTION staff_bootstrap_superuser(text, text, text) IS
  'Ensures one OIDC identity has a usable NEOTMS staff row holding the NEOTMS_SYSADMIN '
  '(시스템관리자) role, and returns staff.id. Called by NeotmsAuthGuard ONLY for an identity that '
  'holds the LPX bootstrap authority (lpx.admin.access) and has no usable staff row. Atomic and '
  'idempotent. Repairs rather than overrides: an existing explicit role or view_scope is left '
  'alone, only blanks and the active/deleted flags are corrected. CONSEQUENCE: a holder of that '
  'authority cannot be locked out from inside NEOTMS -- revoke the authority on LPX instead.';

COMMENT ON COLUMN staff.created_by IS
  'Legacy REG_ID -- the mgr_id of whoever created the row. Plain text, not an FK, because '
  'historical rows reference mgr_ids that no longer exist. The value ''lpx-bootstrap'' is reserved: '
  'it marks a row MINTED by staff_bootstrap_superuser() for a holder of LPX''s lpx.admin.access '
  'authority, i.e. an account that let itself in. Note it does NOT mark a row that function ADOPTED '
  '-- an adopted legacy row keeps the ETL''s provenance, which is the more useful fact about it. '
  'Review both; see section 5 of db/006_bootstrap.sql.';


-- =====================================================================
-- 5. Verification, and the queries to review this later
-- =====================================================================
--
-- Right after applying, expect 6 menus, 1 role, 6 grants:
--
--   SELECT (SELECT count(*) FROM sys_menu WHERE active)              AS menus,
--          (SELECT count(*) FROM sys_role
--            WHERE role_code = 'NEOTMS_SYSADMIN')                    AS sysadmin_role,
--          (SELECT count(*) FROM sys_role_auth a
--             JOIN sys_role r ON r.id = a.role_id
--            WHERE r.role_code = 'NEOTMS_SYSADMIN'
--              AND a.role_1 AND a.role_2 AND a.role_3
--              AND a.role_4 AND a.role_5)                            AS full_grants;
--
-- WHO LET THEMSELVES IN. The one query worth running on a schedule: every
-- row below is an account that holds the NEOTMS superuser role, or was
-- created by the bootstrap, with nobody in NEOTMS approving it. That is the
-- intended mechanism, not a breach -- but it is also the only privilege in
-- this system that is granted without a NEOTMS administrator acting, so it
-- should be a short and recognisable list.
--
--   SELECT s.mgr_id, s.mgr_name, s.mgr_email, r.role_code,
--          s.view_scope, s.active, s.created_by, s.created_at, s.updated_at
--     FROM staff s
--     LEFT JOIN sys_role r ON r.id = s.role_id
--    WHERE s.created_by = 'lpx-bootstrap'        -- minted by the bootstrap
--       OR r.role_code  = 'NEOTMS_SYSADMIN'      -- superuser, however acquired
--    ORDER BY s.created_at;
--
-- Both halves of that OR are needed, and neither is redundant. The first
-- misses a legacy row the bootstrap ADOPTED, because adoption keeps the
-- ETL's `created_by`. The second misses an adopted row that already had an
-- explicit role, because the bootstrap repairs rather than overrides and so
-- never gave it NEOTMS_SYSADMIN.
--
-- That last case -- reactivated, not escalated -- has no trace in the
-- database at all, which is why the AUTHORITATIVE record of every bootstrap
-- is the Lambda's log, not this query. NeotmsAuthGuard emits one
-- `console.warn` per bootstrap carrying the sub, the email and which branch
-- was taken, and CloudWatch keeps it for 180 days (logRetentionDays).
--
-- TO CLOSE THE DOOR, once a real administrator exists and has created the
-- rest of the staff properly: clear the Lambda's
-- NEOTMS_BOOTSTRAP_AUTHORITY_ID (deploy with `-c bootstrapAuthorityId=`
-- omitted from NeotmsConfig, or set the stage value to ''). Empty disables
-- the whole path -- the guard then behaves exactly as it did before this
-- file existed. Nothing in the database needs changing, and the role and
-- the menus stay where they are.
--
-- AFTER THE LEGACY ETL, when sys_menu grows from 6 rows to 48:
--
--   SELECT sys_role_grant_all_menus('NEOTMS_SYSADMIN');
--
-- =====================================================================
-- END 006_bootstrap.sql
-- =====================================================================
