-- =====================================================================
-- NEOTMS :: 008_workspace_text.sql
-- Italic, underline, strikethrough and alignment for 나의 업무.
-- =====================================================================
--
-- Four columns on each of the three style tables. Nothing to migrate and
-- no point of no return: everything here is additive and re-runnable.
--
-- A database built from db/001_schemas.sql has all of it already.
--
-- APPLY THIS BEFORE THE DEPLOY. The sheet selects the new columns on
-- every read, so until they exist GET /api/v0/workspace answers 42703
-- and 나의 업무 renders as an error. Nothing else is affected.
--
-- WHY FOUR MORE NAMED COLUMNS
--
-- The same reason the first four are named rather than a jsonb blob: a
-- CHECK can refuse a value the browser would otherwise be handed. Three
-- of these are booleans and need none; text_align is three literal words
-- and gets one.
--
-- WHAT ALIGNMENT ACTUALLY IS ON SCREEN
--
-- justify-content, not text-align. A ReactGrid cell is a flex row
-- (display: flex; flex-direction: row), so text-align does nothing to it
-- -- the kind of thing that looks right in the source and is only
-- visible in a browser.
--
-- =====================================================================

BEGIN;


-- ---------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------

ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS italic     boolean;
ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS underline  boolean;
ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS strike     boolean;
ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS text_align text;

ALTER TABLE workspace_cell ADD COLUMN IF NOT EXISTS italic     boolean;
ALTER TABLE workspace_cell ADD COLUMN IF NOT EXISTS underline  boolean;
ALTER TABLE workspace_cell ADD COLUMN IF NOT EXISTS strike     boolean;
ALTER TABLE workspace_cell ADD COLUMN IF NOT EXISTS text_align text;

ALTER TABLE workspace_row_style ADD COLUMN IF NOT EXISTS italic     boolean;
ALTER TABLE workspace_row_style ADD COLUMN IF NOT EXISTS underline  boolean;
ALTER TABLE workspace_row_style ADD COLUMN IF NOT EXISTS strike     boolean;
ALTER TABLE workspace_row_style ADD COLUMN IF NOT EXISTS text_align text;


-- ---------------------------------------------------------------------
-- 2. The alignment CHECK, on all three tables
-- ---------------------------------------------------------------------
-- What counts as an alignment is decided here rather than in whichever
-- module last touched it, for the same reason the colour pattern is.

DO $align$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_column', 'workspace_cell', 'workspace_row_style'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS ck_%I_align', t, t);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT ck_%I_align '
      'CHECK (text_align IS NULL OR text_align IN (''left'', ''center'', ''right''))', t, t);
  END LOOP;
END
$align$;

COMMENT ON COLUMN workspace_cell.text_align IS
  'left, center or right -- NULL means inherit, like every other style property. Applied as justify-content rather than text-align, because a ReactGrid cell is a flex row.';

COMMIT;


-- =====================================================================
-- VERIFY
-- =====================================================================

-- All three tables carry the four new columns.
SELECT table_name, count(*) AS added
  FROM information_schema.columns
 WHERE table_name IN ('workspace_column', 'workspace_cell', 'workspace_row_style')
   AND column_name IN ('italic', 'underline', 'strike', 'text_align')
 GROUP BY table_name
 ORDER BY table_name;
-- Expect 4, 4, 4.

-- And the CHECK refuses anything else.
SELECT conrelid::regclass AS table_name, conname
  FROM pg_constraint
 WHERE conname LIKE 'ck_workspace%_align'
 ORDER BY 1;
-- Expect three rows.

-- Nothing is aligned yet.
SELECT (SELECT count(*) FROM workspace_cell WHERE text_align IS NOT NULL)  AS aligned_cells,
       (SELECT count(*) FROM workspace_column WHERE text_align IS NOT NULL) AS aligned_columns;
-- Expect 0, 0 on a first run.
