-- =====================================================================
-- NEOTMS :: 008_admin.sql
-- Run after 006_bootstrap.sql. Idempotent -- re-run it as often as you like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   006 seeded the six menus the application had at the time. Two more
--   exist now, and both are administrative:
--
--     MAINTENANCE (유지보수)   -- CRUD over sys_code, the code tables
--     STAFF       (사용자 관리) -- the staff list and role assignment
--
--   Seeding them is NOT optional, and the failure mode if you skip it is
--   the one that wastes the most time: GET /api/v0/me builds the caller's
--   menu list by reading `sys_menu` (NeotmsProfile.dbops.ts ->
--   MenuTreeOps) and looking each row up in the permission map. A menu
--   with no `sys_menu` row is absent from that list, `mayDo()` returns
--   false for it on the client, and the server's own routeAllows() also
--   refuses -- so the tab is invisible, the API answers 403, and NOTHING
--   anywhere says why. Not even to the superuser.
--
--   So: deploy the Lambda, apply this file, sign out and back in.
--
-- WHY A SEPARATE FILE AND NOT AN EDIT TO 006
--   006 is the lockout recovery file. It is the thing an operator runs at
--   2am having lost access, and the one property it must keep is that it
--   does only what its header says. Growing it every time a menu is added
--   turns "apply the bootstrap" into a decision about which version of the
--   bootstrap, which is exactly the doubt you cannot afford at that
--   moment. New menus land here; 006 stays the way back in.
--
--   The INSERT below is ON CONFLICT DO NOTHING for the same reason 006's
--   menu seed is: once an administrator has renamed a label, this file
--   must not quietly reset it.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/008_admin.sql
--
--   No `:placeholder`, no `\` meta-command, no BEGIN/COMMIT -- same as
--   002..007, so it pastes into the Supabase SQL editor as-is. (`:name` is
--   a convention of this application's query layer, not SQL; see the note
--   in 004_rollup.sql.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. sys_menu -- the two administrative menus
-- ---------------------------------------------------------------------
-- ord_no 7 and 8, continuing 006's 1..6, so these sort to the end of the
-- sidebar. That is deliberate placement, not laziness: the menus a person
-- uses every day should not move because two they touch once a month were
-- added.
--
-- menu_url matches frontend/src/shared/permissions.ts -> NEOTMS_NAV. The
-- application does not navigate by this column -- the router owns the
-- paths and the nav table is static -- but a migrated SY_MENU row carries
-- its legacy `.asp` path here, so leaving it blank on new rows would make
-- the column mean "legacy only" and the next person would have to read
-- two files to find out where /maintenance comes from.
--
-- menu_depth 1, menu_parent NULL: a flat bar, like the other six. The
-- legacy tree arrives with the ETL.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('MAINTENANCE', '유지보수',   NULL, 1, '/maintenance', 7, true),
  ('STAFF',       '사용자 관리', NULL, 1, '/staff',       8, true)
ON CONFLICT (menu_id) DO NOTHING;

COMMENT ON TABLE sys_menu IS
  'Legacy SY_MENU -- the navigation tree, and the unit permissions are granted on. GET /api/v0/me '
  'returns one entry per active row here, so a menu with no row is INVISIBLE AND FORBIDDEN with no '
  'error anywhere: the sidebar omits it and every route gated on it answers 403. The ids the '
  'application gates on are enumerated in lambdas/neotms/nodejs/neotms/NeotmsMenus.ts; the six '
  'business menus are seeded by db/006_bootstrap.sql and the two administrative ones (MAINTENANCE, '
  'STAFF) by db/008_admin.sql. After inserting any row here, re-run '
  'sys_role_grant_all_menus(''NEOTMS_SYSADMIN'') -- grants written earlier do not cover menus added '
  'later.';


-- ---------------------------------------------------------------------
-- 2. Re-grant the superuser role over the new menus
-- ---------------------------------------------------------------------
-- 006 explained why this is a function call and not literal grant rows:
-- `sys_menu` grows, and a superuser whose grants were written once has no
-- rights on anything added afterwards. This file is the first proof of
-- that -- without the line below, the bootstrap superuser can see 유지보수
-- in the sidebar (sys_menu has the row) and gets 403 from every request it
-- makes (sys_role_auth does not).
--
-- Idempotent, and it re-asserts all five action flags on all eight menus.
SELECT sys_role_grant_all_menus('NEOTMS_SYSADMIN') AS menus_granted;


-- =====================================================================
-- 3. Verification
-- =====================================================================
--
-- Expect 8 menus and 8 full grants:
--
--   SELECT (SELECT count(*) FROM sys_menu WHERE active) AS menus,
--          (SELECT count(*) FROM sys_role_auth a
--             JOIN sys_role r ON r.id = a.role_id
--            WHERE r.role_code = 'NEOTMS_SYSADMIN'
--              AND a.role_1 AND a.role_2 AND a.role_3
--              AND a.role_4 AND a.role_5)               AS full_grants;
--
-- And the two new rows specifically, with their grants:
--
--   SELECT m.menu_id, m.menu_name, m.ord_no,
--          a.role_1, a.role_2, a.role_3, a.role_4, a.role_5
--     FROM sys_menu m
--     LEFT JOIN sys_role_auth a
--            ON a.menu_id = m.menu_id
--           AND a.role_id = (SELECT id FROM sys_role WHERE role_code = 'NEOTMS_SYSADMIN')
--    WHERE m.menu_id IN ('MAINTENANCE', 'STAFF');
--
-- A NULL in any role_N column there means section 2 did not run. The
-- symptom is a visible tab that 403s.
--
-- WHO ELSE CAN REACH THESE TWO. Worth checking after any role editing,
-- because STAFF is the menu whose writes change what every other menu
-- permits:
--
-- role_1 is read and role_3 is update per ACTION_INDEX in
-- NeotmsAuthGuard.ts, which is still an UNCONFIRMED mapping against the
-- legacy ROLE_1..ROLE_5 columns -- so read the aliases below as "whatever
-- the first and third flags mean", and if the mapping is corrected there,
-- correct the aliases here.
--
--   SELECT r.role_code, r.role_name, a.menu_id,
--          a.role_1 AS may_read, a.role_3 AS may_update
--     FROM sys_role_auth a
--     JOIN sys_role r ON r.id = a.role_id
--    WHERE a.menu_id IN ('MAINTENANCE', 'STAFF')
--      AND a.active
--    ORDER BY a.menu_id, r.role_code;
--
-- =====================================================================
-- END 008_admin.sql
-- =====================================================================
