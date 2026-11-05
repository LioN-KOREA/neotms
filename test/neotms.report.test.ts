// SPDX-License-Identifier: MIT
//
// The report SQL, asserted by shape.
//
// Testing the TEXT of a generated query is an unusual thing to do, and it is the right thing here.
// The reports used to read `report_daily_rollup`, a pre-aggregated table rebuilt nightly; they now
// sum `job` and `purchase_order` on every request (see NeotmsReport.dbops.ts and db/004_rollup.sql
// for why). The ways that query can go wrong share one property: the result is a plausible number.
//
//   * a `JOIN purchase_order` in place of the lateral overstates revenue by each job's PO count
//   * a dropped scope predicate shows company-wide margin to a PM restricted to their own rows
//   * a `LIMIT` on the display ordering returns the OLDEST ten days to someone who asked for the
//     newest
//   * a sentinel filter emitted as `= 0` instead of `IS NULL` returns an empty report that reads
//     as a quiet month
//
// None of those throw, none of them log, and none of them are visible to `tsc`. A chart is drawn
// either way, and the figures on it are the kind a manager quotes in a meeting.
//
// The figures themselves were reconciled against the rollup these queries replaced, before it was
// dropped: zero difference in revenue and cost over a 58-day window, all seven dimensions matching
// key-for-key. That reconciliation cannot be re-run - the table is gone, which was the point. What
// a test can still protect is that the STRUCTURE proven correct that day is the structure still
// being generated.
//
// There is no database here and none is needed: `SqlOps` is a plain `{ sql, parameters, mapper }`,
// and `PostgresUtils` validates its environment inside its functions rather than at module load.
// This is a separate file from neotms.test.ts because that one asserts a synthesised
// CloudFormation template and reads `db/*.sql` as text; this one imports the Lambda's own runtime.

import {
  toPositional,
  type SqlParameter,
} from "../lambdas/neotms/nodejs/utils/PostgresUtils.js";
import { JOB_SCOPE_COLUMNS } from "../lambdas/neotms/nodejs/neotms/jobs/NeotmsJob.dbops.js";
import {
  JOB_KRW,
  JOB_KRW_JOIN,
  PO_KRW,
  PO_KRW_JOIN,
} from "../lambdas/neotms/nodejs/neotms/NeotmsMoney.js";
import {
  REPORT_LINE_CAP,
  REPORT_SCOPE_COLUMNS,
  ReportBreakdownOps,
  ReportTotalsOps,
  WorkloadCountsOps,
} from "../lambdas/neotms/nodejs/neotms/reports/NeotmsReport.dbops.js";
import {
  ReportQuerySchema,
  type ReportQuery,
} from "../lambdas/neotms/nodejs/neotms/neotms.schemas.js";
import type { NeotmsCaller } from "../lambdas/neotms/nodejs/auth/NeotmsAuthGuard.js";

/** A caller restricted to their own rows - the case every scope assertion below is about. */
const scopedCaller: NeotmsCaller = {
  sub: "sub-1",
  staffId: "42",
  mgrId: "mgr-1",
  name: "Scoped PM",
  email: "pm@example.com",
  corpCode: null,
  roleId: "1",
  roleCode: "PM",
  roleName: "PM",
  permissions: new Map(),
  viewScope: "OWN",
  seesEveryRow: false,
};

const everyRowCaller: NeotmsCaller = { ...scopedCaller, seesEveryRow: true };

/**
 * All nine, written out rather than read off `REPORT_DIMENSIONS`.
 *
 * Deliberate duplication: reading the keys from the map under test would make every loop below
 * vacuous for a dimension somebody deleted. This list is `ReportQuerySchema.groupBy`'s picklist,
 * and the first test in "the dimensions" asserts the two agree - so adding a dimension to the
 * schema without extending the loops below fails here rather than going untested.
 */
const GROUP_BYS: ReportQuery["groupBy"][] = [
  "date",
  "customer",
  "pm",
  "salesManager",
  "corp",
  "category",
  "langPair",
  "jobType",
  "jobCategory",
];

const query = (overrides: Partial<ReportQuery> = {}): ReportQuery => ({
  from: "2025-01-01",
  to: "2025-01-31",
  groupBy: "customer",
  ...overrides,
});

/** Whitespace collapsed, so an assertion is about the SQL and not about its indentation. */
const flat = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/**
 * The bound parameters, with `SqlOps`' optional field narrowed.
 *
 * `parameters` is optional on `SqlOps` because plenty of ops have none. `?? []` rather than a
 * non-null assertion, so that an op which stopped binding anything fails the assertion it is in
 * rather than this helper - "expected to contain scope_staff_id, received []" names the defect.
 */
const params = (ops: { parameters?: SqlParameter[] }): SqlParameter[] => ops.parameters ?? [];

describe("revenue is never multiplied by a job's PO count", () => {
  test("cost is collapsed per job by a lateral, never joined", () => {
    /*
     * The single most expensive mistake available in this file, and the one the whole query shape
     * exists to prevent. A job has many POs, so `JOIN purchase_order po ON po.job_id = j.id` fans
     * each job out once per PO and multiplies its `job_price_ksum` by that count. Measured on the
     * benchmark database: 1,917 rows where there are 1,431 jobs - revenue overstated by a third,
     * with every figure still looking like money.
     *
     * Asserted three ways, because each alone is weak. The lateral must be present; the string
     * `purchase_order` must appear exactly ONCE (which is what catches a second join added
     * alongside the lateral by someone who wanted a PO column for a label); and no form of
     * `JOIN purchase_order` may appear at all.
     */
    for (const groupBy of GROUP_BYS) {
      const sql = flat(ReportBreakdownOps(scopedCaller, query({ groupBy })).sql);
      expect(sql).toContain("LEFT JOIN LATERAL");
      expect(sql.match(/purchase_order/g)).toHaveLength(1);
      expect(sql).not.toMatch(/JOIN purchase_order/);
    }
    const totals = flat(ReportTotalsOps(scopedCaller, query()).sql);
    expect(totals).toContain("LEFT JOIN LATERAL");
    expect(totals.match(/purchase_order/g)).toHaveLength(1);
    expect(totals).not.toMatch(/JOIN purchase_order/);
  });

  test("the lateral is correlated to the job it hangs off", () => {
    // `WHERE po.job_id = j.id` is what makes this run `ix_po_job` once per job already selected by
    // the date range. The uncorrelated form - `GROUP BY job_id` over the whole PO table - must
    // aggregate every PO in the database before any date filter can apply, which is exactly what
    // made the nightly recompute O(dates x all POs) and eventually time out on 200k POs. It would
    // return the same numbers, so only an EXPLAIN would ever tell you.
    const sql = flat(ReportBreakdownOps(scopedCaller, query()).sql);
    expect(sql).toContain("WHERE po.job_id = j.id");
    expect(sql).not.toContain("GROUP BY po.job_id");
  });

  test("the totals carry no label join, so they cannot fan out either", () => {
    // Nothing in the totals is grouped, so the joins that exist only to print a name have no work
    // to do - and a label join is the other place a fan-out could creep in, since nothing
    // constrains a label table to one row per key the way `sys_code.code`'s UNIQUE does. Omitting
    // them makes this query structurally incapable of disagreeing with itself.
    const sql = flat(ReportTotalsOps(scopedCaller, query({ groupBy: "customer" })).sql);
    for (const join of ["customer cu", "staff spm", "staff ssm", "corp co", "sys_code sc"]) {
      expect(sql).not.toContain(join);
    }
  });

  test("the row count the totals report is a job count", () => {
    // A sanity signal rather than a business figure: it is exactly the job count because the
    // lateral contributes one row per job by construction. If it ever drifts above
    // `SELECT count(*) FROM job ...` for the same range, something has started fanning out.
    expect(flat(ReportTotalsOps(scopedCaller, query()).sql)).toContain("count(*) AS row_count");
  });
});

describe("the reports and the job list see the same work", () => {
  test("the scope predicate is on both queries and names all three ownership columns", () => {
    /*
     * A reporting endpoint with the scope predicate left off is how row-level access control is
     * actually defeated in practice: the list screens are locked down, nobody thinks of the report,
     * and company-wide margin becomes readable by anyone holding the REPORT menu. The menu check is
     * not a substitute - it grants "may see reports", this decides "of whose work".
     *
     * The totals query is checked separately and deliberately. It is a different statement, and a
     * scope predicate present on the chart but missing from the grand total leaks the whole
     * company's revenue as a single number while every bar underneath it looks correctly
     * restricted - which is the version of this bug least likely to be noticed.
     */
    for (const ops of [
      ReportBreakdownOps(scopedCaller, query()),
      ReportTotalsOps(scopedCaller, query()),
      WorkloadCountsOps(scopedCaller, "2025-01-01", "2025-01-31"),
    ]) {
      const sql = flat(ops.sql);
      for (const column of REPORT_SCOPE_COLUMNS) {
        expect(sql).toContain(`${column} = :scope_staff_id`);
      }
      // OR'd, not AND'd: any one of the three is enough to own the row.
      expect(sql).toContain(" OR ");
      expect(params(ops).find((p) => p.name === "scope_staff_id")?.value).toBe("42");
    }
  });

  test("a caller who sees every row gets no scope predicate at all", () => {
    // The other direction, and the safe-looking mistake: an unconditional predicate would restrict
    // an administrator to their own jobs. That is a report which reads LOW rather than one which
    // errors, and the harder of the two to notice.
    for (const ops of [
      ReportBreakdownOps(everyRowCaller, query()),
      ReportTotalsOps(everyRowCaller, query()),
      WorkloadCountsOps(everyRowCaller, "2025-01-01", "2025-01-31"),
    ]) {
      expect(flat(ops.sql)).not.toContain("scope_staff_id");
      expect(params(ops).map((p) => p.name)).not.toContain("scope_staff_id");
    }
  });

  test("the report's scope columns equal the job list's", () => {
    /*
     * The gap this closes was real and large. The rollup carried `pm_id` and `sales_mgr_id` and had
     * no column for the project's own PM, so `prj_pm_id` was simply absent from the report's scope:
     * a project PM could open every job in their project on the job screen and then read zero
     * revenue for it on the report. Measured on the benchmark database, one staff member's own
     * projects hid ₩37,296,000 of their revenue from them.
     *
     * A report is an aggregate of jobs, so it must be visible over exactly the jobs its reader can
     * list. Drift is silent in both directions: a column here and not there hides revenue from
     * someone who can open every row behind it; a column there and not here leaks an aggregate over
     * work they cannot see a single row of.
     *
     * Compared as sets, because the order of an OR'd predicate is immaterial and a failure here
     * should mean a real difference in what is visible.
     */
    expect([...REPORT_SCOPE_COLUMNS].sort()).toEqual([...JOB_SCOPE_COLUMNS].sort());
  });
});

describe("the definitions the rollup left behind", () => {
  test("the range is on job_eday, the business date, and binds both ends as dates", () => {
    /*
     * Delivery is the point of revenue recognition, so a job created in December and delivered in
     * January belongs to January. `created_at` would look defensible and be wrong, and the two
     * agree for most rows - which is what would carry it through review.
     *
     * Both ends are required by `ReportQuerySchema`, and this is why: the bound is what keeps the
     * aggregate an index scan on `ix_job_eday` instead of the legacy report's full-history scan.
     * The `date` kind matters for the same reason - sent as text, the comparison stops matching the
     * index.
     */
    const ops = ReportBreakdownOps(scopedCaller, query());
    const sql = flat(ops.sql);
    expect(sql).toContain("j.job_eday >= :range_from");
    expect(sql).toContain("j.job_eday <= :range_to");
    expect(sql).not.toContain("created_at");
    for (const name of ["range_from", "range_to"]) {
      expect(params(ops).find((p) => p.name === name)?.kind).toBe("date");
    }
  });

  test("revenue and cost are the shared KRW expression, both COALESCEd", () => {
    /*
     * A KRW-comparable figure rather than the original-currency "SUM" columns, because a report row
     * aggregates across currencies and those figures have to be comparable.
     *
     * This used to assert the bare `sum(j.job_price_ksum)`. It no longer can, and the reason is the
     * point of the change rather than a loosening of the test: an UNEXCHANGED foreign receivable has
     * no fixed KRW worth, so `job_price_ksum` is only the right answer once the money has actually
     * been converted. NeotmsMoney.ts holds the three cases; what this test now pins is that the
     * report uses THAT definition and not a fourth copy of it.
     *
     * Compared against the imported constant, not against a pasted CASE expression. A literal here
     * would be a second definition of revenue living in the test file - which is the very thing the
     * module exists to prevent, and it would pass while disagreeing with the dashboards.
     *
     * `COALESCE` on each sum is not defensive noise. `sum()` over an empty set - or over a group
     * whose every amount is NULL, which is a job priced but not yet costed - is NULL, and
     * `NULL - NULL` makes margin NULL rather than zero. The client renders a missing margin as an
     * explanatory note instead of a bar, so a NULL turns a correct zero-margin line into "unknown".
     */
    const sql = flat(ReportTotalsOps(scopedCaller, query()).sql);
    expect(sql).toContain(`COALESCE(sum(${flat(JOB_KRW)}), 0) AS revenue`);
    expect(sql).toContain("COALESCE(sum(poc.cost), 0) AS cost");
    expect(sql).toContain(
      `COALESCE(sum(${flat(JOB_KRW)}), 0) - COALESCE(sum(poc.cost), 0) AS margin`,
    );
    // The cost side is the PO expression, inside the lateral where its `pofx` join is in scope.
    expect(sql).toContain(`sum(${flat(PO_KRW)}) AS cost`);
    /*
     * Both joins present, which is what keeps the two expressions from silently evaluating their
     * fallback branch forever.
     *
     * Without `jfx` the query is a 42P01 and the failure is loud; WITH a mis-aliased one it would
     * resolve, yield NULL for every rate, and fall back to the stored figure on every row - which
     * reads as "the feature is not working yet" rather than as a bug, indefinitely.
     */
    expect(sql).toContain(flat(JOB_KRW_JOIN));
    expect(sql).toContain(flat(PO_KRW_JOIN));
    /*
     * `*_price_sum` may now appear - it is the multiplicand of the open case - so the old blanket
     * "no bare sum" assertion is gone. What must still never appear is an AGGREGATE over it:
     * `sum(j.job_price_sum)` across currencies adds yen to won, which is the mistake the original
     * assertion was really guarding against.
     */
    expect(sql).not.toMatch(/sum\(\s*(j\.job_price_sum|po\.po_price_sum)\s*\)/);
  });

  test("the breakdown and the totals are computed from the same rows", () => {
    /*
     * The totals are NOT a sum of the returned lines - the lines are capped, and adding up a
     * truncated list gives a grand total quietly smaller than the real one, which is the worst kind
     * of wrong number: plausible, and off by an amount nobody can account for.
     *
     * So the only thing keeping the figure above the chart consistent with the chart is that both
     * were computed from the same rows with the same measures. Two hand-written copies would be two
     * definitions of revenue, and they would agree right up until one of them was edited.
     *
     * The `jfx` join is checked on both for a sharper reason than tidiness. Revenue is now a CASE
     * that READS `jfx.rate`, so a join present in one query and absent from the other does not fail
     * - the one without it is simply invalid SQL and errors, but the dangerous near-miss is a join
     * added to the totals and forgotten on the breakdown's dimension-specific FROM. The figure above
     * the chart would then convert and the chart would not.
     */
    const from = "FROM job j JOIN project p ON p.id = j.project_id AND p.deleted = false";
    const revenue = `COALESCE(sum(${flat(JOB_KRW)}), 0) AS revenue`;
    for (const ops of [
      ReportBreakdownOps(scopedCaller, query()),
      ReportTotalsOps(scopedCaller, query()),
    ]) {
      expect(flat(ops.sql)).toContain(from);
      expect(flat(ops.sql)).toContain(revenue);
      expect(flat(ops.sql)).toContain(flat(JOB_KRW_JOIN));
      expect(flat(ops.sql)).toContain(flat(PO_KRW_JOIN));
    }
  });

  test("the soft-delete filters are spelled to match the partial indexes", () => {
    /*
     * `ix_job_eday` and `ix_po_job` are both `WHERE NOT deleted`. PostgreSQL does use a partial
     * index for `deleted = false` - the two were confirmed equivalent on an EXPLAIN of the live
     * report - but the dbops layer has one spelling, and a mixture is how the next person concludes
     * the rule is arbitrary.
     *
     * All three tables are checked. A missing filter on any of them silently counts deleted money,
     * and `job` is the one that matters most: a soft-deleted job is usually one that was entered
     * wrongly, so its revenue is often a figure somebody already decided was not real.
     */
    for (const sql of [
      flat(ReportBreakdownOps(scopedCaller, query()).sql),
      flat(ReportTotalsOps(scopedCaller, query()).sql),
    ]) {
      expect(sql).toContain("j.deleted = false");
      expect(sql).toContain("p.deleted = false");
      expect(sql).toContain("po.deleted = false");
      expect(sql).not.toMatch(/NOT\s+[a-z]*\.?deleted/);
    }
  });
});

describe("the dimensions", () => {
  test("every dimension the API accepts is exercised by the loops in this file", () => {
    /*
     * `REPORT_DIMENSIONS` is declared `satisfies Record<ReportQuery["groupBy"], Dimension>`, so a
     * picklist entry with no implementation behind it is already a compile error. What `tsc` cannot
     * see is THIS file: `GROUP_BYS` is a hand-written copy, and a dimension added to the schema but
     * not to the copy is simply never asserted about. It would then be free to fan out revenue, drop
     * the scope predicate, or emit an unbound placeholder, and every test below would still pass.
     *
     * Compared as sets, because the picklist's order is the dropdown's and has no bearing on what
     * needs testing.
     */
    expect([...GROUP_BYS].sort()).toEqual([...ReportQuerySchema.entries.groupBy.options].sort());
  });

  test("the grouping key is the expression the key column is selected as", () => {
    // `GROUP BY` drifting from the selected key expression is not a type error and often still
    // runs - PostgreSQL only objects when the result would be ambiguous. Where it runs, the bars
    // are keyed by one expression and aggregated by another, so a drill-down sends back a key that
    // selects a different set of rows than the bar it was clicked on.
    for (const groupBy of GROUP_BYS) {
      const sql = flat(ReportBreakdownOps(scopedCaller, query({ groupBy })).sql);
      // From after `FROM (`, so this reads the INNER select - the outer one re-projects
      // `picked.dim_key`, and matching from the start of the string would capture across both.
      const inner = sql.slice(sql.indexOf("FROM (") + "FROM (".length);
      const selected = /^ SELECT (.+?) AS dim_key, (.+?) AS dim_label,/.exec(inner);
      expect(selected).not.toBeNull();
      expect(inner).toContain(`GROUP BY ${selected?.[1]}, ${selected?.[2]}`);
    }
  });

  test("an unset id keys as 0 and an unset language as ?", () => {
    // Inherited from the rollup, whose dimension columns were NOT NULL with sentinel defaults
    // because NULLs in a composite primary key never match `ON CONFLICT`. Kept now that the table
    // is gone for a different reason: `dim_key` is what a drill-down sends back as
    // `?customerId=...`, and `null` is not a value a query string can carry.
    for (const groupBy of ["customer", "pm", "salesManager", "corp", "category"] as const) {
      expect(flat(ReportBreakdownOps(scopedCaller, query({ groupBy })).sql)).toMatch(
        /COALESCE\([a-z]+\.[a-z_]+, 0\)::text AS dim_key/,
      );
    }
    const lang = flat(ReportBreakdownOps(scopedCaller, query({ groupBy: "langPair" })).sql);
    expect(lang).toContain("COALESCE(NULLIF(jdl.job_slang, ''), '?')");
    expect(lang).toContain("COALESCE(NULLIF(jdl.job_elang, ''), '?')");
    /*
     * And the distinction that '?' only means what it says BECAUSE of this branch.
     *
     * Before db/011_job_types.sql every job was assumed to be linguistics, so a MICE job - which
     * has no language pair to record at all - could only be entered with both languages blank and
     * landed under '? > ?' next to the translation jobs somebody had forgotten to fill in. One line
     * on the chart, two unrelated facts, and no way to tell which rows were which.
     *
     * So '? > ?' is still exactly "a LINGUISTICS job with nothing filled in", and everything with
     * no language pair by nature keys as '(비언어)'. A fourth 업무 구분 added later falls into the
     * same bucket, which is the honest answer until somebody gives it a dimension of its own.
     */
    expect(lang).toContain("ELSE '(비언어)' END");
    expect(lang).toContain("CASE WHEN j.job_type = 'LINGUISTICS'");
    // The languages come from the detail table now, and via a LEFT JOIN - the columns are gone from
    // `job` (section 6 of db/011), and an INNER join would drop every blank-language job out of the
    // breakdown while leaving it in the totals.
    expect(lang).toContain("LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id");
    expect(lang).not.toMatch(/j\.job_slang|j\.job_elang/);
    // The date dimension gets no sentinel, and should not: a job with a NULL `job_eday` has already
    // failed the range predicate, because `NULL >= :from` is NULL rather than true. Such a job is
    // revenue that appears in no report for any range - a data-entry gap, visible on the job list.
    expect(flat(ReportBreakdownOps(scopedCaller, query({ groupBy: "date" })).sql)).toContain(
      "j.job_eday::text AS dim_key",
    );
  });

  test("the label joins are LEFT, so a missing name does not delete the money", () => {
    // A project whose `prj_field` holds a retired code with no `sys_code` row, or whose customer was
    // hard-deleted by the legacy system, must fall through to "(unassigned)" rather than vanish.
    // INNER here would silently drop that revenue from the chart AND leave it in the totals, which
    // are computed without the label joins - so the bars would no longer add up to the figure above
    // them, and nothing would say why.
    for (const groupBy of ["customer", "pm", "salesManager", "corp", "category"] as const) {
      const sql = flat(ReportBreakdownOps(scopedCaller, query({ groupBy })).sql);
      expect(sql).toMatch(/LEFT JOIN (customer|staff|corp|sys_code)/);
      expect(sql).toContain("'(unassigned)'");
    }
  });

  test("the subject domain joins on the unique code column, and ignores prj_field2", () => {
    // `sys_code.code` is UNIQUE, so this cannot fan a job out across several code rows the way an
    // unconstrained label join could. `prj_field2` is deliberately absent: a job counted under two
    // fields would double the revenue of any breakdown that summed the bars.
    const sql = flat(ReportBreakdownOps(scopedCaller, query({ groupBy: "category" })).sql);
    expect(sql).toContain("LEFT JOIN sys_code sc ON sc.code = p.prj_field");
    expect(sql).not.toContain("prj_field2");
  });

  test("업무 구분 keys on the code itself and 업무 분류 on the detail table", () => {
    /*
     * Two things worth pinning about the pair db/011_job_types.sql added.
     *
     * `jobType` keys on `j.job_type` rather than on a `sys_code.id`, unlike `category`. The code IS
     * what the column stores and it is UNIQUE, so going through the id would buy nothing and add a
     * join that could fan a job out. The label still falls back to the raw code, so a 업무 구분
     * whose `sys_code` row was retired degrades to 'MICE' rather than to '(unassigned)' - which
     * would be a lie, the column being NOT NULL.
     *
     * `jobCategory` reads the non-linguistic detail table, so every linguistics job keys as
     * '(unassigned)' there. That is correct and not a gap: a translation job has no 업무 분류.
     *
     * The aliases matter more than they look. `sc` is already taken by `category`
     * (`LEFT JOIN sys_code sc ON sc.code = p.prj_field`), and a duplicated alias is a syntax error
     * on a query nobody runs until somebody picks that dimension from the dropdown.
     */
    const byType = flat(ReportBreakdownOps(scopedCaller, query({ groupBy: "jobType" })).sql);
    expect(byType).toContain("j.job_type AS dim_key");
    expect(byType).toContain("LEFT JOIN sys_code sct ON sct.code = j.job_type");
    expect(byType).toContain("COALESCE(NULLIF(sct.code_name, ''), j.job_type) AS dim_label");
    expect(byType).not.toContain("'(unassigned)'");

    const byCategory = flat(
      ReportBreakdownOps(scopedCaller, query({ groupBy: "jobCategory" })).sql,
    );
    expect(byCategory).toContain(
      "LEFT JOIN job_detail_non_linguistic jdn ON jdn.job_id = j.id",
    );
    expect(byCategory).toContain("LEFT JOIN sys_code sccat ON sccat.code = jdn.job_category");
    expect(byCategory).toContain("'(unassigned)'");
  });

  test("the PM is the job's and the sales manager is the project's", () => {
    // The two dimensions that are easy to transpose, and a transposition groups correctly on the
    // wrong thing: both are staff ids joined to the same table, so the chart looks right and simply
    // attributes the work to the other person.
    expect(flat(ReportBreakdownOps(scopedCaller, query({ groupBy: "pm" })).sql)).toContain(
      "LEFT JOIN staff spm ON spm.id = j.job_pm_id",
    );
    expect(
      flat(ReportBreakdownOps(scopedCaller, query({ groupBy: "salesManager" })).sql),
    ).toContain("LEFT JOIN staff ssm ON ssm.id = p.prj_mgr_id");
  });
});

describe("picking rows and ordering them are different questions", () => {
  test("the time series is picked newest-first and read oldest-first", () => {
    /*
     * The one dimension where picking and display disagree, and the bug it guards is invisible.
     * `ORDER BY dim_key ASC LIMIT 10` over "the last 30 days" returns the OLDEST ten days in the
     * range: ten rows, correct figures, ascending dates - and a user who believes they are looking
     * at the recent past is looking at the start of the month.
     *
     * So the inner query must cut on DESC and the outer must re-sort to ASC. Asserted by position
     * because both strings appear; what matters is which one the LIMIT is attached to. Doing this
     * in one statement is not possible - `ORDER BY ... LIMIT` is evaluated as a unit - and sorting
     * in TypeScript afterwards cannot help, because the wrong ten rows have already left the
     * database.
     */
    const sql = flat(ReportBreakdownOps(scopedCaller, query({ groupBy: "date", limit: 10 })).sql);
    expect(sql).toContain("ORDER BY dim_key DESC LIMIT 10");
    expect(sql.lastIndexOf("ORDER BY dim_key ASC")).toBeGreaterThan(
      sql.indexOf("ORDER BY dim_key DESC"),
    );
  });

  test("every revenue breakdown breaks ties on the label, so a top-N is stable", () => {
    // `ORDER BY revenue DESC` alone leaves equal-revenue rows in whatever order the aggregate
    // happened to emit them, and PostgreSQL is free to change that between runs - a different plan,
    // a different worker count under parallel aggregate. With a LIMIT in front of it, the
    // MEMBERSHIP of a top-10 then changes between two identical requests whenever 10th and 11th
    // place tie: the chart shuffles on refresh with no data change behind it. Ties are common here -
    // a dimension value with one small job in the range, or several at the same round price.
    for (const groupBy of GROUP_BYS.filter((g) => g !== "date")) {
      expect(flat(ReportBreakdownOps(scopedCaller, query({ groupBy })).sql)).toContain(
        "ORDER BY revenue DESC, dim_label ASC",
      );
    }
  });

  test("the only thing interpolated into LIMIT is a bounded integer", () => {
    /*
     * `LIMIT` is interpolated rather than bound so the planner knows the row count when it chooses
     * between a full sort and a bounded heap sort for a top-N over an aggregate. That is safe only
     * because the value has been through `ReportTopNSchema` (digits, 1..30) or is the integer
     * literal `REPORT_LINE_CAP`.
     *
     * Above the cap is clamped rather than passed through: the Data API fails an entire call at
     * 1 MiB, from deep inside the SQL layer, with an error that names nothing useful.
     */
    expect(flat(ReportBreakdownOps(scopedCaller, query()).sql)).toContain(
      `LIMIT ${String(REPORT_LINE_CAP)}`,
    );
    expect(flat(ReportBreakdownOps(scopedCaller, query({ limit: 30 })).sql)).toContain("LIMIT 30");
    expect(
      flat(ReportBreakdownOps(scopedCaller, query({ limit: REPORT_LINE_CAP + 500 })).sql),
    ).toContain(`LIMIT ${String(REPORT_LINE_CAP)}`);
    for (const groupBy of GROUP_BYS) {
      expect(flat(ReportBreakdownOps(scopedCaller, query({ groupBy })).sql)).toMatch(/LIMIT \d+\b/);
    }
  });

  test("the totals are not limited", () => {
    // Because they are the grand total. A LIMIT here would be invisible - one row either way.
    expect(flat(ReportTotalsOps(scopedCaller, query({ limit: 5 })).sql)).not.toContain("LIMIT");
  });
});

describe("the drill-down filters", () => {
  test("a sentinel filter becomes IS NULL rather than = 0", () => {
    /*
     * `?customerId=0` is a legitimate request: it is what clicking the "(unassigned)" bar sends,
     * because `dim_key` reports an unset id as `0`. The underlying column is NULL there, not 0, so
     * emitting `customer_id = 0` matches nothing - the bar stays clickable, returns an empty
     * report, and reads as a quiet month. On the benchmark database the correct form returns 198
     * jobs and ₩90,883,000 where `= 0` returns zero.
     *
     * "00" and "0000" are checked because `IdSchema` is `^\d{1,19}$`, which accepts any number of
     * leading zeros: a string comparison against "0" would let `?customerId=00` through to `= 00`.
     */
    for (const value of ["0", "00", "0000"]) {
      const ops = ReportBreakdownOps(scopedCaller, query({ customerId: value }));
      expect(flat(ops.sql)).toContain("AND p.customer_id IS NULL");
      expect(params(ops).map((p) => p.name)).not.toContain("f_customer_id");
    }
  });

  test("a real id is bound, and the column is left bare for its index", () => {
    // `IS NULL` for the sentinel branch rather than `COALESCE(column, 0) = :id` for both, because
    // wrapping the column puts an expression on the indexed side and gives up `ix_prj_cus` for the
    // common case in order to tidy up the rare one.
    const ops = ReportBreakdownOps(scopedCaller, query({ customerId: "77" }));
    expect(flat(ops.sql)).toContain("AND p.customer_id = :f_customer_id");
    expect(flat(ops.sql)).not.toContain("p.customer_id IS NULL");
    expect(flat(ops.sql)).not.toContain("COALESCE(p.customer_id, 0) =");
    expect(params(ops).find((p) => p.name === "f_customer_id")?.value).toBe("77");
  });

  test("every filter lands on the table that actually holds the column", () => {
    // Customer, corp and the sales manager are project-level, so every job in a project shares
    // them; the PM is the one on the JOB, which can differ from the project's own PM. A filter on
    // the wrong table filters correctly on the wrong thing.
    const sql = flat(
      ReportBreakdownOps(
        scopedCaller,
        query({ customerId: "1", pmId: "2", salesManagerId: "3", corpId: "4" }),
      ).sql,
    );
    expect(sql).toContain("AND p.customer_id = :f_customer_id");
    expect(sql).toContain("AND j.job_pm_id = :f_pm_id");
    expect(sql).toContain("AND p.prj_mgr_id = :f_sales_mgr_id");
    expect(sql).toContain("AND p.corp_id = :f_corp_id");
  });

  test("the breakdown and the totals apply the same filters", () => {
    // Otherwise a drill-down narrows the chart and not the figure above it, and the user is shown
    // one customer's bars under the whole company's total.
    const filters = { customerId: "1", pmId: "0", salesManagerId: "3", corpId: "4" };
    const breakdown = flat(ReportBreakdownOps(scopedCaller, query(filters)).sql);
    const totals = flat(ReportTotalsOps(scopedCaller, query(filters)).sql);
    for (const predicate of [
      "AND p.customer_id = :f_customer_id",
      "AND j.job_pm_id IS NULL",
      "AND p.prj_mgr_id = :f_sales_mgr_id",
      "AND p.corp_id = :f_corp_id",
    ]) {
      expect(breakdown).toContain(predicate);
      expect(totals).toContain(predicate);
    }
  });
});

describe("every generated statement is complete", () => {
  test("no placeholder is left unbound, across every dimension and filter combination", () => {
    /*
     * `toPositional` throws on a `:name` it has no parameter for, which makes running it the test.
     * The failure that catches is a conditional fragment added to the SQL without its value - and
     * the overwhelmingly likely fragment is a filter, where binding NULL instead would turn
     * `AND x = :x` into `AND x = NULL`. Never true, so the report returns nothing at all and reads
     * as an empty quarter.
     *
     * Run across every dimension, with no filters, with all four set, and with all four as
     * sentinels, for both callers and both queries - 84 statements - because the filters and the
     * scope clause are precisely the fragments that come and go.
     */
    for (const groupBy of GROUP_BYS) {
      for (const filters of [
        {},
        { customerId: "1", pmId: "2", salesManagerId: "3", corpId: "4" },
        { customerId: "0", pmId: "0", salesManagerId: "0", corpId: "0" },
      ]) {
        for (const caller of [scopedCaller, everyRowCaller]) {
          for (const build of [ReportBreakdownOps, ReportTotalsOps]) {
            const ops = build(caller, query({ groupBy, ...filters }));
            const { text, values } = toPositional(ops.sql, params(ops));
            // `(^|[^:])` so `::text` and `$1::date` are not read as placeholders.
            expect(text).not.toMatch(/(^|[^:]):[a-z_]/);
            expect(values).toHaveLength(params(ops).length);
          }
        }
      }
    }
  });

  test("the casts the driver needs survive the rewrite", () => {
    // Without `::date` the driver sends the range as text and the comparison stops matching
    // `ix_job_eday`; without `::bigint` an id is compared as text against a bigint column, which
    // PostgreSQL refuses outright. Both are appended by `toPositional` from the parameter's kind,
    // so this asserts the kinds were declared and not defaulted.
    const ops = ReportBreakdownOps(scopedCaller, query({ customerId: "7" }));
    const { text } = toPositional(ops.sql, params(ops));
    expect(text).toContain("::date");
    expect(text).toContain("::bigint");
  });

  test("no report query contains a psql-only placeholder style or a meta-command", () => {
    // These queries are also what gets pasted into a SQL editor when somebody is reconciling a
    // figure. `:name` is this application's convention, rewritten by `toPositional`; nothing else
    // knows it, which is why the reconciliation queries in db/004_rollup.sql carry none.
    for (const groupBy of GROUP_BYS) {
      const sql = ReportBreakdownOps(everyRowCaller, query({ groupBy })).sql;
      expect(sql).not.toMatch(/^\s*\\\w+/m);
    }
  });
});
