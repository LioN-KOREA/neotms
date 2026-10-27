-- =====================================================================
-- NEOTMS :: 005_code_sequences.sql
-- Document-code sequences. Run after 004_rollup.sql.
-- =====================================================================
--
-- WHY THESE EXIST
--   Every entity in the revenue chain carries a human-readable natural key
--   that is printed on documents and quoted to customers and translators:
--   customer.cus_code, project.prj_code, job.job_code,
--   purchase_order.po_code (e.g. LPO_149817) and translator.tran_code
--   (e.g. TRAN_xxxxxx). These are NOT the primary keys -- the PK is a
--   surrogate bigint -- but they are externally visible and must never be
--   regenerated for an existing row.
--
--   Legacy generated them in application code: SELECT the current maximum,
--   add one, INSERT. That is a lost-update race. Two PMs creating a PO in
--   the same second get the same PO_CODE, and because PRJTB_PO had no
--   unique constraint on PO_CODE, legacy had no backstop either -- the
--   second write simply produced a duplicate code on a real purchase
--   order. A sequence removes the race: nextval is atomic, never hands the
--   same value out twice, and the UNIQUE constraint declared in
--   002_tables.sql is the second line of defence.
--
--   A sequence deliberately has gaps. A rolled-back INSERT consumes a
--   value and does not give it back, so codes are not contiguous. That is
--   correct and must not be "fixed": making codes contiguous requires
--   serialising every create, and a missing code number is not a missing
--   document.
--
-- ---------------------------------------------------------------------
-- MANDATORY ETL STEP
--
--   These sequences start at 1, which WILL collide with migrated legacy
--   codes. After the ETL loads the legacy rows, every sequence must be
--   advanced past the highest numeric suffix already present, e.g.
--
--     SELECT setval('seq_po_code', (
--       SELECT COALESCE(MAX(NULLIF(regexp_replace(po_code, '\D', '', 'g'), ''))::bigint, 0) + 1
--         FROM purchase_order), false);
--
--   Skipping this does not corrupt anything - the UNIQUE constraint turns
--   it into a failed INSERT - but it fails every create until someone
--   works out why, so it belongs in the ETL runbook rather than in
--   somebody's memory.
-- ---------------------------------------------------------------------
-- =====================================================================

CREATE SEQUENCE IF NOT EXISTS seq_customer_code   AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_project_code    AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_job_code        AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_po_code         AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS seq_translator_code AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

COMMENT ON SEQUENCE seq_customer_code IS
  'Numeric suffix for newly created customer.cus_code. The prefix lives in the application (NeotmsCodes.ts), because it is a presentation decision; the sequence lives here, because uniqueness is a database guarantee. ETL must setval past the legacy maximum -- see the header of this file.';
COMMENT ON SEQUENCE seq_project_code IS
  'Numeric suffix for newly created project.prj_code. See seq_customer_code.';
COMMENT ON SEQUENCE seq_job_code IS
  'Numeric suffix for newly created job.job_code. NOTE: the legacy PK was the composite (PRJ_CODE, JOB_CODE), so globally unique JOB_CODE is an ETL assumption that must be verified before 002_tables.sql''s UNIQUE constraint can be created. Codes minted from this sequence are globally unique by construction.';
COMMENT ON SEQUENCE seq_po_code IS
  'Numeric suffix for newly created purchase_order.po_code (legacy form LPO_149817). See seq_customer_code.';
COMMENT ON SEQUENCE seq_translator_code IS
  'Numeric suffix for newly created translator.tran_code (legacy form TRAN_xxxxxx). See seq_customer_code.';

-- END 005_code_sequences.sql
-- =====================================================================
