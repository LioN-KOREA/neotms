-- =====================================================================
-- NEOTMS :: 004_verify_search.sql
-- Run after 003_indexes.sql. Asserts, and fails loudly.
-- =====================================================================
--
-- WHY THIS FILE EXISTS
--   The entire Korean search design rests on one documented PGroonga
--   behaviour: it rewrites `column LIKE '%KEYWORD%'` into
--   `column %% 'KEYWORD'` internally, so the application can keep emitting
--   plain LIKE and the ~20 dbops modules need no changes.
--
--   The failure mode if that rewrite does not fire is the worst kind:
--   nothing errors. The index exists, the query returns the right rows,
--   and PostgreSQL quietly does a sequential scan -- which is precisely
--   the legacy defect this migration exists to remove, reintroduced
--   invisibly. On the ~20 rows of a freshly seeded dev database a Seq Scan
--   is also the CORRECT plan, so a developer checking by hand sees nothing
--   wrong. It only shows up on 310,000 production rows, after go-live.
--
--   So this script builds its own table big enough that the planner has a
--   real choice, and RAISEs if the choice is wrong.
--
-- WHAT IS ACTUALLY UNCERTAIN HERE
--   PGroonga's documentation describes the rewrite for a LIKE against a
--   LITERAL. Two things this application does are not covered by that
--   wording, and both are checked below:
--
--     * The pattern arrives as a BIND PARAMETER ($1), because every search
--       term is user input and is parameterised. See `toPositional` in
--       PostgresUtils.ts.
--     * Historically the predicate carried an explicit `ESCAPE '\'`.
--
--   Case 4 additionally forces a GENERIC plan. An unnamed parameterised
--   statement -- which is what node-postgres sends, since PostgresUtils
--   never names a statement -- is planned with the parameter values in
--   hand, so a custom plan is what production will normally get. The
--   generic case is checked anyway: it is one line, and it is what would
--   bite after someone adds a `name` to a query for a performance win.
--
-- RUN IT
--   PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
--     -U postgres.<project-ref> -d postgres -f db/004_verify_search.sql
--
--   Expect four NOTICEs saying OK, then DO. Any ERROR is a real blocker:
--   do not deploy the search feature over it.
--
--   Safe and idempotent. It creates one table in a dedicated schema and
--   drops the schema at the end, touching nothing in `public`.
-- =====================================================================

\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS neotms_verify CASCADE;
CREATE SCHEMA neotms_verify;

/*
 * `text`, not varchar(n) -- and this is the single most important line in
 * the file.
 *
 * PGroonga cannot use an index against varchar: LIKE and ILIKE on a
 * varchar column are ALWAYS a sequential search, silently. Declaring the
 * probe column as varchar here would make this script fail, which is
 * correct, but the reason to spell it out is the mirror case: every one of
 * the 13 searched columns in 002_tables.sql is `text` on purpose, and a
 * future "tidy-up" that adds a length limit to one of them would break
 * that column's search with no error anywhere.
 */
CREATE TABLE neotms_verify.probe (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL
);

/*
 * 30,000 rows, of which 7 contain the search term.
 *
 * The count is chosen so a sequential scan is genuinely the more expensive
 * plan. Too few rows and PostgreSQL correctly prefers a Seq Scan whatever
 * the index can do, and the assertion below would fail for a reason that
 * has nothing to do with PGroonga -- a false alarm that would get the
 * script deleted rather than the bug fixed.
 *
 * The decoy text is Korean too. With ASCII filler, a Korean term would be
 * absurdly selective and the test would pass for the wrong reason.
 */
INSERT INTO neotms_verify.probe (name)
SELECT CASE WHEN i % 4000 = 0
            THEN '삼성전자 기술문서 번역 ' || i
            ELSE '현대자동차 계약서 검수 작업 ' || i
       END
FROM generate_series(1, 30000) AS g(i);

CREATE INDEX ix_probe_name_pgrn
  ON neotms_verify.probe
  -- Schema-qualified, exactly as in 003_indexes.sql. 001_extensions.sql
  -- installs PGroonga `WITH SCHEMA extensions`, so the operator class is not
  -- in `public` and an unqualified name depends on the caller's search_path.
  -- This probe must mirror the real indexes, or it verifies the wrong thing.
  USING pgroonga (name extensions.pgroonga_text_regexp_ops_v2);

-- Without statistics the planner cannot see the table is large, and would
-- pick a Seq Scan for that reason alone.
ANALYZE neotms_verify.probe;

DO $$
DECLARE
  /*
   * The plan as JSON, not as text.
   *
   * `EXECUTE ... INTO` keeps only the FIRST ROW of the result, and a text
   * EXPLAIN is one row per plan line -- so `INTO plan` would capture
   * nothing but the topmost node, and a `Seq Scan` two lines down would
   * pass this script unnoticed. FORMAT JSON returns the whole plan as a
   * single value, which is also easier to search: a substring check
   * against the JSON text catches a Seq Scan at any depth.
   */
  plan        json;
  row_count   bigint;
  /*
   * A 2-character Korean term, which is the case the whole extension choice
   * was made for: pg_trgm produces no indexable trigram below 3 characters
   * and would fall back to a Seq Scan here without raising anything.
   */
  term        text := '삼성';
  expected    bigint := 7;

  -- Each entry: a label, and the statement to EXPLAIN.
  PROBE_LITERAL constant text :=
    $q$SELECT id FROM neotms_verify.probe WHERE name LIKE '%삼성%'$q$;
  PROBE_ESCAPE constant text :=
    $q$SELECT id FROM neotms_verify.probe WHERE name LIKE '%삼성%' ESCAPE '\'$q$;
BEGIN
  /* ---------------------------------------------------------------- *
   * 0. Sanity: the data is what the assertions below assume.
   *    Checked first so a wrong row count is reported as a wrong row
   *    count, rather than surfacing later as a confusing plan.
   * ---------------------------------------------------------------- */
  EXECUTE format('SELECT count(*) FROM (%s) s', PROBE_LITERAL) INTO row_count;
  IF row_count <> expected THEN
    RAISE EXCEPTION
      'probe data is wrong: LIKE ''%%삼성%%'' matched % rows, expected %. '
      'The plan assertions below would be meaningless.', row_count, expected;
  END IF;

  /* ---------------------------------------------------------------- *
   * 1. LIKE against a literal. The documented case.
   *    If this fails, the extension, the operator class or the column
   *    type is wrong -- not the application.
   * ---------------------------------------------------------------- */
  EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON) ' || PROBE_LITERAL INTO plan;
  IF plan::text LIKE '%Seq Scan%' THEN
    -- Only the FIRST literal of an implicitly concatenated string may carry
    -- the E prefix -- a second E'' continuation is a syntax error, so every
    -- \n in these messages has to live in this opening literal.
    RAISE EXCEPTION E'LIKE with a LITERAL pattern did NOT use the PGroonga index.\nPlan: %\n'
      'Check, in this order: (1) the extension is installed and `extensions` is '
      'on the search_path, (2) the index names pgroonga_text_regexp_ops_v2 and not '
      'the default operator class, (3) the column is `text` and not varchar.', plan;
  END IF;
  RAISE NOTICE 'OK 1/4  LIKE with a literal pattern uses the PGroonga index.';

  /* ---------------------------------------------------------------- *
   * 2. LIKE ... ESCAPE '\'.
   *    The application no longer emits this (see `searchClause` in
   *    NeotmsQuery.ts -- the clause was dropped because backslash is
   *    already PostgreSQL's default LIKE escape, so it was redundant and
   *    an unknown risk to the rewrite). Checked anyway, because a
   *    hand-written query or a reinstated clause must not silently cost
   *    the index.
   *
   *    Note `$q$...$q$` quoting above: standard_conforming_strings is on,
   *    so '\' is a complete one-character string and the escape clause is
   *    valid SQL exactly as written.
   * ---------------------------------------------------------------- */
  EXECUTE 'EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON) ' || PROBE_ESCAPE INTO plan;
  IF plan::text LIKE '%Seq Scan%' THEN
    RAISE WARNING E'LIKE ... ESCAPE ''\\'' did NOT use the PGroonga index.\nPlan: %\n'
      'This is a WARNING, not an error: the application does not emit an ESCAPE '
      'clause. But it means nothing may reintroduce one -- not a hand-written '
      'query, and not a "restore the escape for correctness" change to '
      'searchClause.', plan;
  ELSE
    RAISE NOTICE 'OK 2/4  LIKE ... ESCAPE also uses the index (clause is harmless).';
  END IF;

  /* ---------------------------------------------------------------- *
   * 3. LIKE against a BIND PARAMETER, custom plan.
   *    This is the case production actually runs, and the one PGroonga's
   *    documentation does not explicitly cover. The pattern is built by
   *    concatenating the parameter, exactly as `searchClause` does.
   * ---------------------------------------------------------------- */
  EXECUTE $q$PREPARE probe_bound (text) AS
            SELECT id FROM neotms_verify.probe WHERE name LIKE '%' || $1 || '%'$q$;

  EXECUTE format('EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON) EXECUTE probe_bound (%L)', term)
    INTO plan;
  IF plan::text LIKE '%Seq Scan%' THEN
    RAISE EXCEPTION E'LIKE with a BIND PARAMETER did NOT use the PGroonga index.\nPlan: %\n'
      'This is the blocker case: every search term in the application is a bound '
      'parameter, so the index is dead in production even though case 1 passed. '
      'The fix is to stop relying on the LIKE rewrite and emit PGroonga''s own '
      'operator instead -- `col &@~ $1` for a full-text match, or `col %%%% $1` '
      'for a substring match -- in `searchClause` in NeotmsQuery.ts. That is a '
      'one-function change; do it rather than shipping this.', plan;
  END IF;
  RAISE NOTICE 'OK 3/4  LIKE with a bound parameter uses the index (custom plan).';

  /* ---------------------------------------------------------------- *
   * 4. Same, but forced onto a GENERIC plan.
   *    A generic plan is built once with no parameter values at all, so
   *    an optimisation that depends on seeing the pattern would be lost
   *    here and nowhere else. PostgresUtils never names a statement, so
   *    production gets custom plans -- this guards the day someone adds a
   *    name to make a hot query cheaper and makes it 100x more expensive.
   * ---------------------------------------------------------------- */
  SET LOCAL plan_cache_mode = force_generic_plan;
  EXECUTE format('EXPLAIN (ANALYZE, COSTS OFF, FORMAT JSON) EXECUTE probe_bound (%L)', term)
    INTO plan;
  RESET plan_cache_mode;

  IF plan::text LIKE '%Seq Scan%' THEN
    RAISE WARNING E'A GENERIC plan for the bound LIKE falls back to a Seq Scan.\nPlan: %\n'
      'Not a blocker today -- PostgresUtils sends unnamed statements, which are '
      'always planned with the values in hand. It does mean naming a query (`name` '
      'on the pg query config) would silently destroy its search performance after '
      'the fifth execution. Do not add one to a searching query.', plan;
  ELSE
    RAISE NOTICE 'OK 4/4  Even a generic plan uses the index.';
  END IF;

  EXECUTE 'DEALLOCATE probe_bound';
END $$;

DROP SCHEMA neotms_verify CASCADE;

-- =====================================================================
-- END 004_verify_search.sql
-- =====================================================================
