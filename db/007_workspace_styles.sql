-- =====================================================================
-- NEOTMS :: 007_workspace_styles.sql
-- Layout and styling for 나의 업무, on a database that already has data.
-- =====================================================================
--
-- Four columns added to workspace_column, five to workspace_cell, and one
-- new table. Nothing to migrate and no point of no return: everything
-- here is additive and re-runnable, so a run interrupted halfway can
-- simply be repeated.
--
-- A database built from db/001_schemas.sql has all of it already.
--
-- APPLY THIS BEFORE THE DEPLOY. The sheet selects the new columns on
-- every read, so until they exist GET /api/v0/workspace answers 42703
-- and 나의 업무 renders as an error. Nothing else is affected -- no other
-- screen reads these tables.
--
-- WHAT IT IS FOR
--
-- Three things the first version could not express:
--
--   1. WHERE A COLUMN SITS AND HOW WIDE IT IS, per person. The fourteen
--      fixed columns live in frontend code and had no row here at all, so
--      there was nowhere to record that this person drags 납품일 to the
--      front and makes it narrow. col_key is what gives them a row.
--   2. STYLE ON A FIXED COLUMN'S CELL. workspace_cell.column_id
--      references workspace_column, so before col_key existed a coloured
--      cell in 납품일 had nothing to point at.
--   3. A COLOURED ROW. Marking the two POs you are worried about is the
--      commonest thing done to a sheet like this, and doing it by
--      colouring fourteen cells does not survive the next sort.
--
-- WHY FOUR NAMED COLUMNS AND NOT ONE jsonb
--
-- Because these values end up in a browser's style attribute. Four
-- columns are four CHECKs -- two hex patterns and a bounded integer -- so
-- the database refuses a colour that is not one. A jsonb blob would be
-- validated in TypeScript only, in however many places read it.
--
-- =====================================================================

BEGIN;


-- ---------------------------------------------------------------------
-- 1. workspace_column: identity, layout and style
-- ---------------------------------------------------------------------
-- col_label becomes nullable, because a fixed column has no label of its
-- own -- the code's label is the label. The identity CHECK below is what
-- keeps that from meaning "a custom column with no name".

ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS col_key    text;
ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS col_width  integer;
ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS bg_color   text;
ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS text_color text;
ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS text_size  smallint;
ALTER TABLE workspace_column ADD COLUMN IF NOT EXISTS bold       boolean;
ALTER TABLE workspace_column ALTER COLUMN col_label DROP NOT NULL;

-- ord_no was NOT NULL DEFAULT 0 and becomes nullable, so that "not placed"
-- can be said. Existing custom columns keep the position they have.
ALTER TABLE workspace_column ALTER COLUMN ord_no DROP NOT NULL;
ALTER TABLE workspace_column ALTER COLUMN ord_no DROP DEFAULT;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, hence drop / add NOT
-- VALID / VALIDATE. VALIDATE is a no-op on an already-valid constraint,
-- which is what makes this re-runnable.
ALTER TABLE workspace_column DROP CONSTRAINT IF EXISTS ck_workspace_column_label;
ALTER TABLE workspace_column
  ADD CONSTRAINT ck_workspace_column_label
  CHECK (col_label IS NULL OR char_length(col_label) BETWEEN 1 AND 40) NOT VALID;
ALTER TABLE workspace_column VALIDATE CONSTRAINT ck_workspace_column_label;

ALTER TABLE workspace_column DROP CONSTRAINT IF EXISTS ck_workspace_column_identity;
ALTER TABLE workspace_column
  ADD CONSTRAINT ck_workspace_column_identity
  CHECK ((col_key IS NULL) <> (col_label IS NULL)) NOT VALID;
ALTER TABLE workspace_column VALIDATE CONSTRAINT ck_workspace_column_identity;

ALTER TABLE workspace_column DROP CONSTRAINT IF EXISTS ck_workspace_column_width;
ALTER TABLE workspace_column
  ADD CONSTRAINT ck_workspace_column_width
  CHECK (col_width IS NULL OR col_width BETWEEN 40 AND 800) NOT VALID;
ALTER TABLE workspace_column VALIDATE CONSTRAINT ck_workspace_column_width;

ALTER TABLE workspace_column DROP CONSTRAINT IF EXISTS uq_workspace_column_key;
ALTER TABLE workspace_column ADD CONSTRAINT uq_workspace_column_key UNIQUE (staff_id, col_key);


-- ---------------------------------------------------------------------
-- 2. workspace_cell: style beside the value
-- ---------------------------------------------------------------------
-- A row may now exist for style alone, on a fixed column whose value
-- lives elsewhere. Two consequences the application has to honour: the
-- read no longer requires cell_text, and clearing a cell's text deletes
-- the row only when no style is left on it.

ALTER TABLE workspace_cell ADD COLUMN IF NOT EXISTS bg_color   text;
ALTER TABLE workspace_cell ADD COLUMN IF NOT EXISTS text_color text;
ALTER TABLE workspace_cell ADD COLUMN IF NOT EXISTS text_size  smallint;
ALTER TABLE workspace_cell ADD COLUMN IF NOT EXISTS bold       boolean;


-- ---------------------------------------------------------------------
-- 3. workspace_row_style: one colour per PO, per person
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspace_row_style (
  staff_id   bigint NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  po_id      bigint NOT NULL REFERENCES purchase_order (id) ON DELETE CASCADE,
  bg_color   text,
  text_color text,
  text_size  smallint,
  bold       boolean,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, po_id)
);


-- ---------------------------------------------------------------------
-- 4. The style CHECKs, on all three tables
-- ---------------------------------------------------------------------
-- A colour reaches a browser's style attribute, so what counts as one is
-- decided here rather than in whichever module last touched it. Six
-- characters of hex, with the hash: the shortest form every browser and
-- every colour picker agrees on.

DO $styles$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_column', 'workspace_cell', 'workspace_row_style'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS ck_%I_bg', t, t);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT ck_%I_bg '
      'CHECK (bg_color IS NULL OR bg_color ~ ''^#[0-9a-fA-F]{6}$'')', t, t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS ck_%I_fg', t, t);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT ck_%I_fg '
      'CHECK (text_color IS NULL OR text_color ~ ''^#[0-9a-fA-F]{6}$'')', t, t);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS ck_%I_size', t, t);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT ck_%I_size '
      'CHECK (text_size IS NULL OR text_size BETWEEN 8 AND 24)', t, t);
  END LOOP;
END
$styles$;

COMMENT ON COLUMN workspace_column.col_key IS
  'Which fixed column this row is about (''poEday'', ''jobCode'', ...), or NULL for a column this person invented. The fixed columns'' LABELS are not copied here: they live in the frontend, change with the UI''s wording, and a copy would drift. Rows are written lazily -- no row means ship order, ship width, no style.';
COMMENT ON COLUMN workspace_column.ord_no IS
  'Position across ALL columns, default and custom interleaved. NULL sorts after every placed column, in the order the code lists it. A reorder sends the complete list, so in practice a person has either no rows or a full set.';
COMMENT ON COLUMN workspace_column.col_width IS
  'Pixels, as dragged. NULL means the width the code ships for that column.';
COMMENT ON COLUMN workspace_cell.cell_text IS
  'The typed value, for a CUSTOM column only -- a fixed column''s value lives in the project, job or PO row underneath. A row here for a fixed column therefore carries style and nothing else, which is why this is nullable.';
COMMENT ON TABLE  workspace_row_style IS
  'One person''s colour on one purchase order, across every column of that row. NEOTMS only. Separate from workspace_cell because a row style belongs to no column, and (NULL, po_id) cannot be half a primary key. Resolution order is cell, then row, then column: the row and the cell are about this particular work, while the column is a property of the sheet''s shape.';

COMMIT;


-- =====================================================================
-- VERIFY
-- =====================================================================

-- The three tables carry the same four style columns.
SELECT table_name, count(*) AS style_columns
  FROM information_schema.columns
 WHERE table_name IN ('workspace_column', 'workspace_cell', 'workspace_row_style')
   AND column_name IN ('bg_color', 'text_color', 'text_size', 'bold')
 GROUP BY table_name
 ORDER BY table_name;
-- Expect 4, 4, 4.

-- Every existing column row is a custom one, and still legal under the
-- identity CHECK.
SELECT count(*) FILTER (WHERE col_key IS NULL)     AS custom_columns,
       count(*) FILTER (WHERE col_key IS NOT NULL) AS fixed_columns,
       count(*) FILTER (WHERE col_label IS NULL AND col_key IS NULL) AS illegal
  FROM workspace_column;
-- Expect every existing row under custom_columns and 0 illegal. fixed_columns
-- is 0 until somebody drags, resizes or colours one of the fourteen.

-- Nothing is styled yet.
SELECT (SELECT count(*) FROM workspace_cell WHERE bg_color IS NOT NULL) AS styled_cells,
       (SELECT count(*) FROM workspace_row_style)                       AS styled_rows;
-- Expect 0, 0 on a first run.
