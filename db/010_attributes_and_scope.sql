-- =====================================================================
-- NEOTMS :: 010_attributes_and_scope.sql
-- Three more staff attributes, and row-level scope recorded as dormant.
-- =====================================================================
--
-- One CHECK and two comments. Nothing to migrate, no data touched, and no
-- point of no return -- the whole file is re-runnable.
--
-- A database built from db/001_schemas.sql has both already.
--
-- APPLY THIS BEFORE THE DEPLOY. Until the CHECK accepts them, granting
-- one of the three new attributes on 사용자 관리 fails with 23514 and the
-- screen reports a constraint name. Nothing else changes: an attribute
-- nobody holds affects nothing.
--
-- 1. THREE ATTRIBUTES THAT GATE NOTHING, ON PURPOSE
--
-- 경영지원부, IMC 매니저, MICE 매니저. Unlike SALES_MANAGER and PM they
-- are NOT in NEOTMS_ASSIGNABLE_ATTRIBUTES, because that list is what the
-- project form's two pickers are built from and what the server checks
-- before writing prj_mgr_id / prj_pm_id. There is no column asking "who
-- is the IMC manager", so putting them in that list would offer them in a
-- picker that writes the PM column.
--
-- They are a fact about a person, readable from profile.attributes. When
-- a column or a screen needs one, the refusal belongs next to that
-- column, where the other two already are.
--
-- 2. ROW-LEVEL SCOPE IS NO LONGER ENFORCED
--
-- staff.view_scope is still loaded, still read onto the caller and still
-- logged -- but the guard now reports seesEveryRow = true for everybody,
-- so scopeClause() adds nothing to any statement. Whoever may open a
-- screen sees every row on it.
--
-- THE COLUMN IS DELIBERATELY NOT DROPPED AND NOT BACKFILLED. It holds the
-- legacy MGR_VIEW value, which is the only record of who used to be
-- restricted; overwriting it with 'Y' would destroy that while gaining
-- nothing, since nothing reads it. Re-enabling later is one line in
-- NeotmsAuthGuard plus restoring the control on 사용자 관리.
--
-- What changes here is therefore only the COMMENT -- so that the next
-- person to read the schema is not told the column is load-bearing when
-- it is not.
--
-- =====================================================================

BEGIN;


-- ---------------------------------------------------------------------
-- 1. The attribute vocabulary
-- ---------------------------------------------------------------------
-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, hence drop / add NOT
-- VALID / VALIDATE. VALIDATE is a no-op on an already-valid constraint,
-- which is what makes the block re-runnable. The list is the whole
-- vocabulary because a CHECK cannot be extended in place.

ALTER TABLE staff_attribute DROP CONSTRAINT IF EXISTS ck_staff_attribute;
ALTER TABLE staff_attribute
  ADD CONSTRAINT ck_staff_attribute CHECK (attribute IN (
    'NEOTMS_USER_ATTRIBUTE_SALES_MANAGER',
    'NEOTMS_USER_ATTRIBUTE_PM',
    'NEOTMS_USER_ATTRIBUTE_HR_MANAGEMENT',
    'NEOTMS_USER_ATTRIBUTE_IMC',
    'NEOTMS_USER_ATTRIBUTE_MICE',
    'NEOTMS_USER_ATTRIBUTE_SUPERUSER'
  )) NOT VALID;
ALTER TABLE staff_attribute VALIDATE CONSTRAINT ck_staff_attribute;


-- ---------------------------------------------------------------------
-- 2. The comments
-- ---------------------------------------------------------------------

COMMENT ON TABLE  staff_attribute IS
  'What a person may be named as, what part of the business they belong to, and whether they override the permission system. Not legacy -- NEOTMS only. SALES_MANAGER and PM gate who may appear in a project''s 영업담당 / PM pickers and who the server will accept in prj_mgr_id / prj_pm_id. HR_MANAGEMENT, IMC and MICE gate nothing today -- they record which part of the business somebody belongs to, and no column asks for them yet; see NEOTMS_ASSIGNABLE_ATTRIBUTES in NeotmsAuthorities.ts for why they are deliberately not assignable. SUPERUSER overrides every permission check and must only be held by accounts carrying lpx.admin.access.';

COMMENT ON COLUMN staff.view_scope IS
  'Legacy MGR_VIEW, nvarchar(3). NOT ENFORCED AT PRESENT. The value is still loaded, still read onto the caller and still logged, but NeotmsAuthGuard reports seesEveryRow = true for everybody, so the scope clauses narrow nothing: anyone who may open a screen sees every row on it. That is a deliberate decision, not a defect -- row-level visibility is not wanted for now, and the 사용자 관리 screen no longer offers it. The column is kept rather than dropped because it carries the legacy intent, which is the only record of who used to be restricted; re-enabling is one line in NeotmsAuthGuard plus putting the control back.';

COMMIT;


-- =====================================================================
-- VERIFY
-- =====================================================================

-- The six attributes are accepted and nothing else is.
SELECT pg_get_constraintdef(oid) AS attribute_check
  FROM pg_constraint
 WHERE conname = 'ck_staff_attribute';
-- Expect the six NEOTMS_USER_ATTRIBUTE_* names.

-- Who holds what, now. The three new ones are held by nobody until an
-- administrator grants them on 사용자 관리.
SELECT attribute, count(*) AS holders
  FROM staff_attribute
 GROUP BY attribute
 ORDER BY attribute;

-- And the state of the column that is no longer enforced. These numbers
-- are now descriptive only -- every one of these people sees every row.
SELECT COALESCE(NULLIF(btrim(view_scope), ''), '(unset)') AS view_scope,
       count(*) AS staff
  FROM staff
 WHERE NOT deleted
 GROUP BY 1
 ORDER BY 1;
