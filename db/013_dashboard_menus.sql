-- =====================================================================
-- NEOTMS :: 013_dashboard_menus.sql
-- Run after 008_admin.sql. Idempotent -- re-run it as often as you like.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   The two 대시보드 screens get a menu id each:
--
--     DASHBOARD_SALES (대시보드-영업) -- projects where I am 영업담당자
--     DASHBOARD_PM    (대시보드-PM)   -- projects where I am PM
--
--   They were gated on PROJECT until now, which made them visible to
--   everyone who could read the project list -- including the half that
--   does not apply to a given person. Two ids make them two separately
--   grantable screens, so a PM holds DASHBOARD_PM, a 영업담당자 holds
--   DASHBOARD_SALES, and whoever runs the system holds both. One id named
--   DASHBOARD could not express that: granting it would hand over both
--   screens and withholding it would take away the one the person needs.
--
--   Seeding them is NOT optional, and the failure is silent, exactly as
--   008 describes: GET /api/v0/me builds the caller's menu list from
--   `sys_menu`, a menu with no row is absent from it, so the client drops
--   the nav entry and the server answers 403 -- an invisible screen and an
--   unexplained refusal, with nothing logged anywhere.
--
--   Without this file the two dashboards are unreachable BY EVERYONE,
--   including the bootstrap superuser. Nothing else breaks: no table, no
--   column and no other route is touched, so the rest of the application
--   is unaffected either way.
--
--   So: deploy the Lambda, apply this file, sign out and back in.
--
-- WHY A SEPARATE FILE AND NOT AN EDIT TO 008
--   Same reason 008 is not an edit to 006. A file that has been applied to
--   a database is a record of what was done to it; growing it afterwards
--   makes "has 008 been applied" a question with two answers. 008's own
--   header says new menus land there, which was true when it was the
--   newest file -- its COMMENT ON TABLE sys_menu has been corrected to
--   name this file, so the final state of that comment does not depend on
--   which order the two were applied in.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/013_dashboard_menus.sql
--
--   No `:placeholder`, no `\` meta-command, no BEGIN/COMMIT -- same as
--   002..012, so it pastes into the Supabase SQL editor as-is.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. sys_menu -- the two dashboards
-- ---------------------------------------------------------------------
-- ord_no 9 and 10, continuing 008's 7..8. The sidebar does NOT sort by
-- this column -- frontend/src/shared/permissions.ts -> NEOTMS_NAV owns the
-- order, and it puts 대시보드 first, because a dashboard that is not the
-- first thing a person sees after signing in is a dashboard they will not
-- open. ord_no stays monotonic anyway so that the legacy menu editor, and
-- anyone reading this table directly, sees rows in the order they were
-- added rather than a gap.
--
-- menu_url matches NEOTMS_NAV's paths, as in 008. The application does not
-- navigate by this column; it is here because a migrated SY_MENU row
-- carries its legacy `.asp` path in it, and leaving it blank on new rows
-- would make the column mean "legacy only".
--
-- menu_name has no parentheses. The client's label is 대시보드(영업) and
-- this is not it -- GET /api/v0/me returns these names, but the sidebar
-- renders NEOTMS_NAV's `label` instead (which is why permissions.ts can
-- carry a `hint` the server knows nothing about). What this column is for
-- is the 사용자 관리 screen's permission editor, where the names appear in
-- a list next to five checkboxes. A hyphen reads better there than nested
-- brackets, and the two rows still sort next to each other.
INSERT INTO sys_menu (menu_id, menu_name, menu_parent, menu_depth, menu_url, ord_no, active)
VALUES
  ('DASHBOARD_SALES', '대시보드-영업', NULL, 1, '/dashboard/sales',  9, true),
  ('DASHBOARD_PM',    '대시보드-PM',   NULL, 1, '/dashboard/pm',    10, true)
ON CONFLICT (menu_id) DO NOTHING;

COMMENT ON TABLE sys_menu IS
  'Legacy SY_MENU -- the navigation tree, and the unit permissions are granted on. GET /api/v0/me '
  'returns one entry per active row here, so a menu with no row is INVISIBLE AND FORBIDDEN with no '
  'error anywhere: the sidebar omits it and every route gated on it answers 403. The ids the '
  'application gates on are enumerated in lambdas/neotms/nodejs/neotms/NeotmsMenus.ts; the six '
  'business menus are seeded by db/006_bootstrap.sql, the two administrative ones (MAINTENANCE, '
  'STAFF) by db/008_admin.sql, and the two dashboards (DASHBOARD_SALES, DASHBOARD_PM) by '
  'db/013_dashboard_menus.sql. After inserting any row here, re-run '
  'sys_role_grant_all_menus(''NEOTMS_SYSADMIN'') -- grants written earlier do not cover menus added '
  'later.';


-- ---------------------------------------------------------------------
-- 2. Re-grant the superuser role over the new menus
-- ---------------------------------------------------------------------
-- As in 008, and for the reason 006 gives: grants written once do not
-- cover menus added afterwards. Without the line below the bootstrap
-- superuser sees both 대시보드 entries in the sidebar (sys_menu has the
-- rows) and gets 403 from both (sys_role_auth does not).
--
-- This re-grants the superuser ONLY. Deciding which other roles hold which
-- dashboard is the point of splitting the menu in two, and it is done on
-- the 사용자 관리 screen rather than here -- a seed file that handed both
-- dashboards to every existing role would undo the split on the way in.
--
-- Idempotent, and it re-asserts all five action flags on all ten menus.
SELECT sys_role_grant_all_menus('NEOTMS_SYSADMIN') AS menus_granted;


-- =====================================================================
-- 3. Verification
-- =====================================================================
--
-- Expect 10 menus and 10 full grants:
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
--   SELECT m.menu_id, m.menu_name, m.menu_url, m.ord_no,
--          a.role_1, a.role_2, a.role_3, a.role_4, a.role_5
--     FROM sys_menu m
--     LEFT JOIN sys_role_auth a
--            ON a.menu_id = m.menu_id
--           AND a.role_id = (SELECT id FROM sys_role WHERE role_code = 'NEOTMS_SYSADMIN')
--    WHERE m.menu_id IN ('DASHBOARD_SALES', 'DASHBOARD_PM');
--
-- A NULL in any role_N column there means section 2 did not run. The
-- symptom is a visible tab that 403s.
--
-- WHO HOLDS WHICH DASHBOARD. The question this file exists to make
-- answerable, so it is worth running after any role editing:
--
-- role_1 is read per ACTION_INDEX in NeotmsAuthGuard.ts, which is still an
-- UNCONFIRMED mapping against the legacy ROLE_1..ROLE_5 columns -- read
-- may_read below as "whatever the first flag means", and if the mapping is
-- corrected there, correct the alias here.
--
--   SELECT r.role_code, r.role_name,
--          bool_or(a.menu_id = 'DASHBOARD_SALES' AND a.role_1) AS sees_sales,
--          bool_or(a.menu_id = 'DASHBOARD_PM'    AND a.role_1) AS sees_pm
--     FROM sys_role r
--     LEFT JOIN sys_role_auth a
--            ON a.role_id = r.id
--           AND a.active
--           AND a.menu_id IN ('DASHBOARD_SALES', 'DASHBOARD_PM')
--    GROUP BY r.role_code, r.role_name
--    ORDER BY r.role_code;
--
-- A role with false in both columns has no dashboard at all. That is a
-- legitimate state -- a 번역가 관리 only account has no book to summarise
-- -- but it is also what an unfinished role edit looks like, so check it
-- against who the role is for rather than assuming either.
--
-- =====================================================================
-- END 013_dashboard_menus.sql
-- =====================================================================
