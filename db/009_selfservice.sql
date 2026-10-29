-- =====================================================================
-- NEOTMS :: 009_selfservice.sql
-- Run after 006_bootstrap.sql. Idempotent -- re-run it as often as you like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   Before it, there were exactly two ways to become a NEOTMS staff
--   member, and neither works for an ordinary new employee:
--
--     * the legacy ETL, which loads the people who already existed; and
--     * staff_bootstrap_superuser() (006 section 4), which only admits a
--       holder of LPX's own lpx.admin.access authority.
--
--   An administrator cannot make the row either -- there is no POST on
--   /api/v0/admin/staff, and the route table says why: a staff row needs
--   an `lpx_sub` to be usable, and an admin has no way to obtain somebody
--   else's OIDC subject. Invent one and the row is either dead weight or
--   claimable by whoever next signs in with a matching email.
--
--   So the row has to be created BY the person it belongs to, on a request
--   that carries their verified token. That is what the function below is
--   for: it is called by POST /api/v0/registration, which is one of only
--   two routes in the API that run without a staff row at all (see the
--   `account` flag in neotms.handler.ts).
--
--   What it creates is a REQUEST, not an account: `role_id` is NULL, so the
--   permission matrix comes back empty and every menu-gated route refuses.
--   The row becomes usable when an administrator assigns a role on the
--   사용자 관리 screen. Approval is a human act, here as everywhere in this
--   schema.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/009_selfservice.sql
--
--   No `:placeholder`, no `\` meta-command, no BEGIN/COMMIT -- same as
--   002..008, so it pastes into the Supabase SQL editor as-is. (`:name` is
--   a convention of this application's query layer, not SQL; see the note
--   in 004_rollup.sql.)
--
--   IF YOU SKIP THIS FILE the symptom is specific and silent: the sign-up
--   form appears, the user fills it in, and the POST answers 500 with
--   `function staff_self_register(...) does not exist` -- in the Lambda's
--   log, not on the screen. The screen says the registration could not be
--   saved. Nothing says a migration is missing. It is the same trap 008
--   has with its menu rows, and it is worth checking first whenever
--   sign-up "does nothing".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. staff_self_register() -- a new employee puts themselves in the queue
-- ---------------------------------------------------------------------
-- Called by POST /api/v0/registration for a verified LPX account that
-- holds the NEOTMS app authority and has NO staff row. Returns staff.id;
-- the application then re-reads the row through the same query every
-- sign-in uses, so there is one mapping from staff row to caller.
--
-- WHY A FUNCTION, AND NOT AN INSERT IN TYPESCRIPT
--   The same three reasons as staff_bootstrap_superuser (006 section 4),
--   and the first is the one that bites:
--
--     1. The pooler is in transaction mode, so one statement is the only
--        unit that is reliably atomic. The mgr_id collision loop below is
--        a write-then-react sequence; as application statements it would
--        be spread across backends, and a double-clicked sign-up button
--        could produce two staff rows for one person -- which splits their
--        project history, because `mgr_id` is what every legacy REG_ID
--        points at.
--     2. The `unique_violation` handler needs a subtransaction. There is
--        no equivalent in the application.
--     3. `role_id`, `view_scope` and `active` are the three values this
--        codebase refuses to let a caller influence. This is the ONE write
--        path in the system that an unapproved account can reach, so the
--        decision belongs in the same place as the constraints that bound
--        it -- not in a parameter list where a future refactor could widen
--        it by adding an argument.
--
-- WHAT THE CALLER MAY SAY ABOUT THEMSELVES
--   The five `p_name..p_position` parameters, and nothing else. They are
--   prefilled in the form from LPX's /userInfo and all five are editable,
--   including the name: `mgr_name` is what gets printed on a purchase
--   order, and the name on an SSO account is not always the name a person
--   works under. See SelfProfileSchema in neotms.schemas.ts.
--
--   What the caller CANNOT say: role_id, view_scope, active, mgr_id,
--   corp_code, lpx_sub. The first three are the permission system and are
--   literals below; the last three are identity -- `lpx_sub` comes from a
--   verified token, `mgr_id` is minted here, and `corp_code` is left NULL
--   for an administrator to set, because which group entity employs
--   somebody is not a self-reported fact.
CREATE OR REPLACE FUNCTION staff_self_register(
  p_lpx_sub  text,
  p_name     text,
  p_name_eng text,
  p_email    text,
  p_phone    text,
  p_position text,
  p_ip       text
)
RETURNS bigint
LANGUAGE plpgsql
-- Pinned, like every function in db/: the pooler gives out whatever
-- session it has, and a function whose table references depend on the
-- caller's search_path is a function that resolves differently depending
-- on who called it.
SET search_path = public, pg_temp
AS $fn$
DECLARE
  /*
   * `p_`/`v_` prefixes throughout, and not for tidiness. In PL/pgSQL a
   * variable whose name matches a column of a table the statement touches
   * raises `column reference "..." is ambiguous` -- at CALL time, not at
   * CREATE time. A plain `lpx_sub` here would compile cleanly and then
   * fail on the first real sign-up.
   */
  v_staff_id   bigint;
  v_base       text;
  v_mgr_id     text;
  v_ip         inet;
  v_attempt    integer;
  v_constraint text;
BEGIN
  IF p_lpx_sub IS NULL OR btrim(p_lpx_sub) = '' THEN
    RAISE EXCEPTION 'staff_self_register: p_lpx_sub must not be blank';
  END IF;

  IF NULLIF(btrim(COALESCE(p_name, '')), '') IS NULL THEN
    -- The schema allows a NULL mgr_name (the ETL loads some), but a row
    -- created here must have one: it is the 담당자 printed on every
    -- document this person will issue, and nobody will ever go back and
    -- fill it in. SelfProfileSchema requires it too; this is the backstop.
    RAISE EXCEPTION 'staff_self_register: p_name must not be blank';
  END IF;

  /* ------------------------------------------------------------------ *
   * (a) This identity already has a row. Return it, change nothing.
   *
   *     The application checks for this first and answers 409, so
   *     reaching here means a RACE -- a double-clicked button, or two
   *     tabs submitting the form at once. Returning the existing id makes
   *     the loser of that race indistinguishable from the winner, which
   *     is the right outcome for a button somebody pressed twice.
   *
   *     Deliberately not an UPDATE. A second sign-up must not be able to
   *     rewrite the name on a row an administrator may already have
   *     approved -- that would be a self-service edit of an approved
   *     record arriving through the one endpoint unapproved accounts can
   *     reach. Correcting your own details later is a different feature
   *     with a different route.
   * ------------------------------------------------------------------ */
  SELECT id INTO v_staff_id FROM staff WHERE lpx_sub = p_lpx_sub;
  IF v_staff_id IS NOT NULL THEN
    RETURN v_staff_id;
  END IF;

  /* ------------------------------------------------------------------ *
   * (b) THERE IS NO ADOPT-BY-EMAIL BRANCH, and that is the single most
   *     important difference between this function and
   *     staff_bootstrap_superuser.
   *
   *     The bootstrap has one (006 section 4b): it finds an unclaimed
   *     legacy row with a matching email and takes it over. Doing the same
   *     here would be a privilege escalation anybody could perform, and
   *     the reason is that by the time this function runs, THE EMAIL MATCH
   *     HAS ALREADY BEEN TRIED AND LOST.
   *
   *     NeotmsAuthGuard's just-in-time linking (StaffUnclaimedByEmailOps)
   *     runs on every sign-in and adopts an unclaimed row whose email
   *     matches, provided it is `active` and not `deleted`. The
   *     application only calls this function when that lookup came back
   *     empty. So the unclaimed rows still matching this email are exactly
   *     the ones the guard refused to link:
   *
   *       * `active = false` -- a departed or suspended employee. Adopting
   *         it would hand back access an administrator removed, and the
   *         new person would inherit that row's `role_id`, which may be a
   *         director's. Sign up with an address matching a former
   *         manager's record and you are that manager.
   *       * `deleted = true`  -- same, with less evidence.
   *
   *     An email is also not proof of identity here. LPX accounts and
   *     legacy SY_MGR rows were populated independently, addresses get
   *     reused when people leave, and nobody reviews this: the whole point
   *     of the endpoint is that it runs with no administrator present.
   *
   *     The cost of not adopting is a duplicate row for a returning
   *     employee whose old record was deactivated, which an administrator
   *     resolves by hand with the history in front of them. That is the
   *     cheaper mistake by a wide margin.
   * ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ *
   * (c) The client address, defensively.
   *
   *     `created_ip` is inet and the value arrives from
   *     `x-forwarded-for`, which is client-controlled. clientInet() in
   *     NeotmsWrite.ts already shape-checks it, but the check is a
   *     character-class test: "1.2.3.4.5" passes it and inet rejects it.
   *     Everywhere else in the application a bad cast loses one save.
   *     Here it would lose the registration -- permanently, for anybody
   *     behind whatever proxy produced the value, with the screen saying
   *     only that it could not be saved. So the cast gets its own
   *     subtransaction and a bad address becomes NULL.
   * ------------------------------------------------------------------ */
  BEGIN
    v_ip := NULLIF(btrim(COALESCE(p_ip, '')), '')::inet;
  EXCEPTION WHEN invalid_text_representation THEN
    v_ip := NULL;
  END;

  /* ------------------------------------------------------------------ *
   * (d) Mint the row.
   *
   *     `mgr_id` is `text NOT NULL UNIQUE` and is the human-readable key
   *     that ends up in `created_by` on every record this person touches,
   *     so it wants to be recognisable rather than a UUID. The email local
   *     part, stripped to the characters a legacy id can hold, is the best
   *     available answer; a Korean-only or missing email leaves nothing
   *     after the strip, hence the 'user' floor.
   * ------------------------------------------------------------------ */
  v_base := lower(
    regexp_replace(split_part(COALESCE(NULLIF(btrim(p_email), ''), 'user'), '@', 1),
                   '[^A-Za-z0-9._-]', '', 'g')
  );
  v_base := left(COALESCE(NULLIF(v_base, ''), 'user'), 40);

  /*
   * Collision handling. The EXISTS-then-INSERT shape would race; this one
   * lets the UNIQUE constraint decide and reacts to which constraint
   * fired, inside a BEGIN..EXCEPTION block (a subtransaction, so a failed
   * attempt rolls back without losing the whole call).
   */
  FOR v_attempt IN 1..10 LOOP
    v_mgr_id := CASE WHEN v_attempt = 1 THEN v_base ELSE v_base || v_attempt::text END;
    BEGIN
      INSERT INTO staff (mgr_id, lpx_sub,
                         mgr_name, mgr_name_eng, mgr_email, mgr_phone, mgr_position,
                         role_id, view_scope, active, deleted, created_by, created_ip)
      VALUES (v_mgr_id,
              p_lpx_sub,
              btrim(p_name),
              NULLIF(btrim(COALESCE(p_name_eng, '')), ''),
              NULLIF(btrim(COALESCE(p_email, '')),    ''),
              NULLIF(btrim(COALESCE(p_phone, '')),    ''),
              NULLIF(btrim(COALESCE(p_position, '')), ''),
              -- THE THREE SECURITY COLUMNS, as literals.
              --
              -- NULL role_id is what makes this a request rather than an
              -- account: RoleMenuPermissionsOps is not even called for a
              -- NULL role, the permission matrix is empty, and every
              -- menu-gated route refuses. GET /api/v0/me reports it as
              -- `registration: "pending"` and the SPA shows the waiting
              -- notice.
              NULL,
              -- 'N' and not NULL. Both mean "own rows only" to the server
              -- (anything outside VIEW_SCOPE_ALL does), so this is not a
              -- security difference -- it is so the 사용자 관리 radio shows
              -- a DECIDED value. A NULL there renders as "본인 담당분만"
              -- indistinguishably from a deliberate 'N', and the admin
              -- cannot tell whether anyone has thought about it.
              'N',
              -- Active, and this one is easy to get wrong in the safe-
              -- looking direction. `false` would make whyUnusable() return
              -- "inactive", which is a 403 -- so the person who just
              -- submitted the form would be told their account has been
              -- DEACTIVATED, having never had one. Approval is withheld by
              -- the NULL role above; `active` is not the gate.
              true,
              false,
              -- The audit marker, matching 'lpx-bootstrap' in 006. This
              -- one means "nobody in NEOTMS approved this row's creation",
              -- which is true of every row it marks and is the thing worth
              -- being able to query. `created_by` is plain text, not an FK
              -- (historical rows reference mgr_ids that no longer exist),
              -- which is what makes it usable as a tag.
              'self-registration',
              v_ip)
      RETURNING id INTO v_staff_id;

      RETURN v_staff_id;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;

      /*
       * `staff_lpx_sub_key` is PostgreSQL's generated name for the UNIQUE
       * on staff.lpx_sub (<table>_<column>_key). Hitting it means a
       * concurrent sign-up by this same person got there first, so their
       * row is the answer -- the same race branch (a) covers when the
       * winner has already committed.
       */
      IF v_constraint = 'staff_lpx_sub_key' THEN
        SELECT id INTO v_staff_id FROM staff WHERE lpx_sub = p_lpx_sub;
        IF v_staff_id IS NOT NULL THEN
          RETURN v_staff_id;
        END IF;
        -- The winner has not committed yet, so its row is not visible to
        -- this transaction and there is nothing honest to return. Re-raise
        -- and let the caller retry.
        RAISE;
      END IF;

      -- Otherwise it was `staff_mgr_id_key`: the readable id is taken by a
      -- different person. Next suffix.
    END;
  END LOOP;

  RAISE EXCEPTION
    'staff_self_register: could not allocate a free mgr_id from the base "%" in 10 attempts. '
    'Create the staff row by hand and set its lpx_sub to %.',
    v_base, p_lpx_sub;
END;
$fn$;

COMMENT ON FUNCTION staff_self_register(text, text, text, text, text, text, text) IS
  'Creates a NEOTMS staff row for one verified OIDC identity that has none, and returns staff.id. '
  'Called by POST /api/v0/registration -- one of two routes that run without a staff row. ALWAYS '
  'writes role_id = NULL, view_scope = ''N'', active = true: what it creates is an APPROVAL REQUEST, '
  'and a role is assigned afterwards by an administrator on the 사용자 관리 screen. Atomic. Called '
  'twice for the same subject it returns the same id and changes nothing. Unlike '
  'staff_bootstrap_superuser() it NEVER adopts an unclaimed legacy row by email: the guard''s '
  'just-in-time linking has already tried that and lost, so the only rows left matching are '
  'inactive or deleted ones, and adopting those would inherit a departed employee''s role and '
  'history. See section 1(b) of db/009_selfservice.sql.';

-- A restatement, not an addition. `COMMENT ON` takes a literal and
-- overwrites -- there is no append form -- so recording the second
-- reserved `created_by` value means repeating 006's sentence about the
-- first. CONSEQUENCE: applying 006 again after this file silently drops
-- the self-registration half. That is recovered the way everything else in
-- db/ is, by running this file again; it is also why 009 is the last file
-- in the numbering and not an edit to 006.
COMMENT ON COLUMN staff.created_by IS
  'Legacy REG_ID -- the mgr_id of whoever created the row. Plain text, not an FK, because '
  'historical rows reference mgr_ids that no longer exist. Two values are reserved, and both mark a '
  'row created with NO NEOTMS ADMINISTRATOR INVOLVED: ''lpx-bootstrap'' for a row MINTED by '
  'staff_bootstrap_superuser() for a holder of LPX''s lpx.admin.access authority (db/006_bootstrap.'
  'sql), and ''self-registration'' for a row created by staff_self_register() (db/009_selfservice.'
  'sql). The two are not equivalent risks: the first arrives holding the superuser role, the second '
  'arrives with role_id = NULL and can do nothing until somebody approves it. Note ''lpx-bootstrap'' '
  'does NOT mark a row that function ADOPTED -- an adopted legacy row keeps the ETL''s provenance, '
  'which is the more useful fact about it. Review both; see section 5 of db/006_bootstrap.sql and '
  'section 2 of db/009_selfservice.sql.';


-- =====================================================================
-- 2. Verification, and the queries to review this later
-- =====================================================================
--
-- Right after applying, expect one row:
--
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname = 'staff_self_register';
--
-- WHO IS WAITING. The one query worth running on a schedule, because this
-- system has no mail: a sign-up notifies nobody, and the only thing
-- standing between a new colleague and an indefinite wait is an
-- administrator opening 사용자 관리 and seeing the request at the top of
-- the list (which is why NeotmsStaffAdmin.dbops.ts sorts role_id IS NULL
-- first). This is the same list, from the database side:
--
--   SELECT s.mgr_id, s.mgr_name, s.mgr_email, s.mgr_position,
--          s.created_by, s.created_ip, s.created_at,
--          now() - s.created_at AS waiting
--     FROM staff s
--    WHERE s.role_id IS NULL
--      AND s.active
--      AND NOT s.deleted
--    ORDER BY s.created_at;
--
-- A row in there with `created_by = 'self-registration'` and a `waiting`
-- measured in days is somebody who filled in a form and was never told
-- anything. There is no screen anywhere that will raise its voice about
-- that.
--
-- WHO LET THEMSELVES IN. Every row either function created without a
-- NEOTMS administrator approving it, with what it holds NOW:
--
--   SELECT s.mgr_id, s.mgr_name, s.mgr_email, s.created_by, s.created_at,
--          r.role_code, s.view_scope, s.active
--     FROM staff s
--     LEFT JOIN sys_role r ON r.id = s.role_id
--    WHERE s.created_by IN ('self-registration', 'lpx-bootstrap')
--    ORDER BY s.created_at;
--
-- The `role_code` column is the one to read. A 'self-registration' row
-- SHOULD be NULL or a modest role somebody chose for it; the function
-- cannot produce anything else, so a superuser role on one of these rows
-- means an administrator granted it -- which is fine, but it is the
-- grant worth knowing about.
--
-- TO CLOSE THE DOOR, if self-service sign-up turns out to be the wrong
-- policy for this company:
--
--   DROP FUNCTION staff_self_register(text, text, text, text, text, text, text);
--
-- The route then answers 500 with "function does not exist" and the
-- sign-up form stays visible and broken, so this is a stopgap rather than
-- a setting -- unlike the bootstrap, which is switched off properly by
-- blanking NEOTMS_BOOTSTRAP_AUTHORITY_ID. If the policy question is real,
-- remove the route.
--
-- =====================================================================
-- END 009_selfservice.sql
-- =====================================================================
