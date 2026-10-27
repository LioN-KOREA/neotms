-- =====================================================================
-- NEOTMS :: 001_extensions.sql
-- Target: Aurora Serverless v2, PostgreSQL 16, accessed via RDS Data API.
-- Run once per cluster, before 002_tables.sql.
-- =====================================================================
--
-- PRE-BUILD CHECK (blocking):
--   pg_bigm availability MUST be confirmed on the exact pinned Aurora
--   PostgreSQL engine version before anything is built on top of it.
--   pg_bigm is not in the default Aurora/RDS extension set on every
--   minor version. Verify with:
--       SELECT * FROM pg_available_extensions WHERE name = 'pg_bigm';
--   and confirm 'pg_bigm' appears in the cluster parameter group's
--   shared_preload_libraries / rds.extensions allow-list.
--   If pg_bigm is NOT available on the pinned version, STOP: the Korean
--   search strategy in 003_indexes.sql has no fallback that works at two
--   characters, and the index plan must be redesigned (the realistic
--   alternatives are a self-managed 2-gram tokeniser in a side table, or
--   OpenSearch). Do not silently substitute pg_trgm -- see below.
--
-- =====================================================================

-- 2-gram index support. REQUIRED for Korean text search.
-- Korean search terms in LKTMS are very frequently exactly 2 characters
-- (삼성, 번역, 계약 ...). pg_trgm's GIN operator class cannot index a
-- pattern shorter than 3 characters: the LIKE '%ab%' predicate produces no
-- indexable trigram key, the index is skipped, and the planner falls back
-- to a sequential scan WITHOUT raising any error. That silent fallback is
-- exactly the legacy performance defect we are here to remove, so pg_bigm
-- is not optional and not interchangeable with pg_trgm.
CREATE EXTENSION IF NOT EXISTS pg_bigm;

-- 3-gram index support. Used only for ASCII identifier/contact columns
-- (po_code, prj_code, job_code, phone, email) where terms are always
-- longer than 3 characters. Trigram indexes are materially smaller than
-- bigram indexes on the same column, and pg_trgm additionally gives us
-- similarity() for fuzzy ranking, which pg_bigm does not.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Bulk COPY to/from S3.
-- Needed because the RDS Data API caps a single result set at 1 MiB; any
-- report export, ETL extract or reconciliation dump larger than that must
-- bypass the Data API entirely and stream via aws_s3.query_export_to_s3().
--
-- aws_s3 has two prerequisites beyond CREATE EXTENSION:
--   1. An IAM role attached to the Aurora cluster (aws_rds_role /
--      s3Export + s3Import feature roles) granting s3:GetObject,
--      s3:PutObject and s3:ListBucket on the target prefix.
--   2. The bucket MUST use SSE-KMS, not SSE-S3. With SSE-S3 the export
--      call fails at write time, and the KMS key policy must additionally
--      grant kms:GenerateDataKey + kms:Decrypt to that same cluster role.
CREATE EXTENSION IF NOT EXISTS aws_s3;

-- aws_s3 depends on aws_commons; CREATE EXTENSION aws_s3 normally pulls it
-- in, but declare it explicitly so a partial/manual install still works.
CREATE EXTENSION IF NOT EXISTS aws_commons;

-- ---------------------------------------------------------------------
-- Post-install verification. Expect 4 rows.
-- ---------------------------------------------------------------------
-- SELECT extname, extversion FROM pg_extension
--  WHERE extname IN ('pg_bigm','pg_trgm','aws_s3','aws_commons')
--  ORDER BY extname;
--
-- Smoke-test that pg_bigm really indexes a 2-character Korean term
-- (run AFTER 003_indexes.sql; the plan must be a Bitmap Index Scan, not Seq Scan):
-- EXPLAIN ANALYZE SELECT id FROM project WHERE prj_name LIKE '%삼성%';
