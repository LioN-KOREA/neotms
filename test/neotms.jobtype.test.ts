// SPDX-License-Identifier: MIT
//
// 업무 구분 - the job and PO SQL, asserted by shape.
//
// db/011_job_types.sql moved four columns out of two tables. `job.job_slang`, `job.job_elang`,
// `purchase_order.po_slang` and `purchase_order.po_elang` are gone; the language pair now lives in
// `job_detail_linguistic` / `po_detail_linguistic`, the 업무 분류 in the two `*_non_linguistic`
// tables, and the discriminator that decides which of the two a row may have sits on the parent as
// `job_type` / `po_type`.
//
// Reverting any one of the five edit sites per module is accepted by `tsc` and most of them are
// silent at runtime too, which is what this file is for:
//
//   * a `job_slang` entry left in `JOB_FIELDS` emits a column that no longer exists, so EVERY job
//     save fails with 42703 - loud, but only once the database has been migrated
//   * a missing `LEFT JOIN job_detail_linguistic` drops the language pair from the list and the
//     detail screen without an error: every job reads as having no languages
//   * that join written as an INNER one is worse - the job list silently loses every job that has
//     no detail row, which is most of them
//   * a detail upsert that omits `job_type` builds a row the composite FK cannot check, so a
//     language pair on a MICE job becomes storable again
//   * a detail upsert that writes an all-NULL row when the body mentioned neither side turns
//     "nobody filled this in" into a row that exists, which is the one thing db/011's "constraints
//     forbid, never require" rule is about
//
// No database, and none needed: `SqlOps` is a plain `{ sql, parameters, mapper }` and
// `PostgresUtils` validates its environment inside its functions rather than at module load. This
// is a separate file from neotms.test.ts for the same reason neotms.report.test.ts is - that one
// asserts a synthesised CloudFormation template and reads `db/*.sql` as text, this one imports the
// Lambda's own runtime. The migration FILE's own assertions live there, next to the other SQL text.

import type { SqlParameter } from "../lambdas/neotms/nodejs/utils/PostgresUtils.js";
import {
  JOB_TYPE_LINGUISTIC,
  isLinguistic,
  jobDetailTable,
  poDetailTable,
  typeMismatchMessage,
} from "../lambdas/neotms/nodejs/neotms/NeotmsJobTypes.js";
import {
  JobCreateOps,
  JobDetailClearOps,
  JobDetailUpsertOps,
  JobGetOps,
  JobListOps,
  JobProjectOps,
  JobUpdateOps,
  type JobFilters,
  type JobSortKey,
} from "../lambdas/neotms/nodejs/neotms/jobs/NeotmsJob.dbops.js";
import {
  PoCreateOps,
  PoDetailClearOps,
  PoDetailUpsertOps,
  PoGetOps,
  PoListOps,
  PoUpdateOps,
  type PoFilters,
  type PoSortKey,
} from "../lambdas/neotms/nodejs/neotms/purchase-orders/NeotmsPurchaseOrder.dbops.js";
import type { ListQuery } from "../lambdas/neotms/nodejs/neotms/NeotmsQuery.js";
import type { WriteContext } from "../lambdas/neotms/nodejs/neotms/NeotmsWrite.js";
import type { NeotmsCaller } from "../lambdas/neotms/nodejs/auth/NeotmsAuthGuard.js";

/** A caller restricted to their own rows - the scope the unscoped detail ops rely on being checked. */
const caller: NeotmsCaller = {
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

const ctx: WriteContext = { actor: "pm@example.com", ip: "203.0.113.7" };

const listQuery = <K extends string>(sort: K): ListQuery<K> => ({
  limit: 50,
  cursor: null,
  sort: { key: sort, column: "j.created_at" },
  direction: "desc",
  search: null,
});

const jobQuery = listQuery<JobSortKey>("created");
const poQuery = listQuery<PoSortKey>("created");

/** Whitespace collapsed, so an assertion is about the SQL and not about its indentation. */
const flat = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** The bound parameters, with `SqlOps`' optional field narrowed. See the report test for why. */
const params = (ops: { parameters?: SqlParameter[] }): SqlParameter[] => ops.parameters ?? [];

const names = (ops: { parameters?: SqlParameter[] }): string[] =>
  params(ops).map((p) => p.name);

/* -------------------------------------------------------------------------- */

describe("the language pair is read through the detail tables", () => {
  /**
   * Every read of a job or a PO. Listed rather than looped over an export, because the thing being
   * protected is that each of these particular statements carries the joins - a `JOB_FROM` shared
   * by three of them and hand-written in the fourth is exactly how one of them gets missed.
   */
  const jobReads: [string, string][] = [
    ["JobListOps", JobListOps(caller, jobQuery, {}).sql],
    ["JobGetOps", JobGetOps(caller, "7").sql],
  ];

  const poReads: [string, string][] = [
    ["PoListOps", PoListOps(caller, poQuery, {}).sql],
    ["PoGetOps", PoGetOps(caller, "7").sql],
  ];

  test.each(jobReads)("%s joins both job detail tables, LEFT", (_name, sql) => {
    const s = flat(sql);
    expect(s).toContain("LEFT JOIN job_detail_linguistic jdl ON jdl.job_id = j.id");
    expect(s).toContain("LEFT JOIN job_detail_non_linguistic jdn ON jdn.job_id = j.id");
    /*
     * The INNER form, spelled three ways. `JOIN job_detail_...` without LEFT would drop every job
     * that has no detail row - which is most jobs, and which looks like a filter nobody applied.
     */
    expect(s).not.toMatch(/(?<!LEFT )JOIN job_detail_/);
  });

  test.each(poReads)("%s joins both PO detail tables, LEFT", (_name, sql) => {
    const s = flat(sql);
    expect(s).toContain("LEFT JOIN po_detail_linguistic pdl ON pdl.po_id = po.id");
    expect(s).toContain("LEFT JOIN po_detail_non_linguistic pdn ON pdn.po_id = po.id");
    expect(s).not.toMatch(/(?<!LEFT )JOIN po_detail_/);
  });

  test("the reads select the pair from the detail alias and the type from the parent", () => {
    for (const [, sql] of jobReads) {
      const s = flat(sql);
      expect(s).toContain("jdl.job_slang AS job_slang");
      expect(s).toContain("jdl.job_elang AS job_elang");
      expect(s).toContain("jdn.job_category AS job_category");
      expect(s).toContain("job_type AS job_type");
      // The old columns. `j.job_slang` is a 42703 now, and the alias makes it look deliberate.
      expect(s).not.toMatch(/\bj\.job_slang\b|\bj\.job_elang\b/);
    }
    for (const [, sql] of poReads) {
      const s = flat(sql);
      expect(s).toContain("pdl.po_slang AS po_slang");
      expect(s).toContain("pdl.po_elang AS po_elang");
      expect(s).toContain("pdn.po_category AS po_category");
      expect(s).toContain("po_type AS po_type");
      expect(s).not.toMatch(/\bpo\.po_slang\b|\bpo\.po_elang\b/);
    }
  });

  test("po_lang and the CAT columns are untouched - they are different columns entirely", () => {
    /*
     * `purchase_order.po_lang` is the printed PO's letterhead language (Korean or English) and has
     * nothing to do with the work's language pair; `po_cat_use` / `po_cat_word` / `po_cat_mid` /
     * `po_cat_stotal` are CAT-tool analysis figures, not 업무 분류. All five survive db/011 and all
     * five are read here. The names are close enough to the ones that moved that a careless
     * cleanup takes them too, and nothing else in the suite would notice.
     */
    const s = flat(PoGetOps(caller, "7").sql);
    expect(s).toContain("po.po_lang AS po_lang");
    for (const cat of ["po_cat_use", "po_cat_word", "po_cat_mid", "po_cat_stotal"]) {
      expect(s).toContain(`po.${cat} AS ${cat}`);
    }
  });
});

describe("the filters reach the table the column is actually in", () => {
  test("a job filtered by language or category predicates on the detail alias", () => {
    const filters: JobFilters = {
      jobType: "MICE",
      jobCategory: "event_ceremony_management",
      slang: "한국어",
      elang: "영어",
    };
    const s = flat(JobListOps(caller, jobQuery, filters).sql);
    expect(s).toContain("j.job_type =");
    expect(s).toContain("jdl.job_slang =");
    expect(s).toContain("jdl.job_elang =");
    expect(s).toContain("jdn.job_category =");
    // `filterClause` binds one parameter per supplied filter, named `f_<filter key>`.
    expect(names(JobListOps(caller, jobQuery, filters))).toEqual(
      expect.arrayContaining(["f_jobType", "f_jobCategory", "f_slang", "f_elang"]),
    );
  });

  test("a PO filtered by language or category predicates on the detail alias", () => {
    const filters: PoFilters = {
      poType: "IMC",
      poCategory: "online_marketing",
      slang: "한국어",
      elang: "영어",
    };
    const s = flat(PoListOps(caller, poQuery, filters).sql);
    expect(s).toContain("po.po_type =");
    expect(s).toContain("pdl.po_slang =");
    expect(s).toContain("pdl.po_elang =");
    expect(s).toContain("pdn.po_category =");
  });

  test("an absent filter emits no predicate for it", () => {
    /*
     * The filter being optional is what makes the two new ones safe to add: a list request that
     * says nothing about 업무 구분 must still return MICE and linguistics jobs together.
     */
    const s = flat(JobListOps(caller, jobQuery, {}).sql);
    expect(s).not.toContain("j.job_type =");
    expect(s).not.toContain("jdn.job_category =");
  });
});

describe("the writes put each column in its own table", () => {
  test("a job save writes job_type and never the four moved columns", () => {
    const create = JobCreateOps(
      {
        projectId: "3",
        jobName: "MICE 행사 운영",
        jobType: "MICE",
        jobCategory: "event_ceremony_management",
        jobSlang: "한국어",
        jobElang: "영어",
      } as Parameters<typeof JobCreateOps>[0],
      ctx,
    );
    const update = JobUpdateOps(
      caller,
      "7",
      {
        jobType: "MICE",
        jobCategory: "event_ceremony_management",
        jobSlang: "한국어",
        jobElang: "영어",
      },
      ctx,
    );

    for (const ops of [create, update]) {
      const s = flat(ops.sql);
      expect(s).toContain("job_type");
      /*
       * The whole point. A `job_slang` spec left in `JOB_FIELDS` would be emitted here and the
       * statement would fail with 42703 on every single save - including saves that have nothing
       * to do with 업무 구분, because the spec is unconditional.
       */
      expect(s).not.toContain("job_slang");
      expect(s).not.toContain("job_elang");
      expect(s).not.toContain("job_category");
      expect(names(ops)).not.toEqual(expect.arrayContaining(["job_slang"]));
      expect(names(ops)).not.toEqual(expect.arrayContaining(["job_category"]));
    }
  });

  test("a PO save writes po_type and never the four moved columns", () => {
    const create = PoCreateOps(
      {
        jobId: "7",
        poName: "통역 발주",
        poType: "LINGUISTICS",
        poSlang: "한국어",
        poElang: "영어",
        poCategory: "online_marketing",
      } as Parameters<typeof PoCreateOps>[0],
      "3",
      ctx,
    );
    const update = PoUpdateOps(
      caller,
      "9",
      { poType: "LINGUISTICS", poSlang: "한국어", poElang: "영어", poCategory: "online_marketing" },
      ctx,
    );

    for (const ops of [create, update]) {
      const s = flat(ops.sql);
      expect(s).toContain("po_type");
      expect(s).not.toContain("po_slang");
      expect(s).not.toContain("po_elang");
      expect(s).not.toContain("po_category");
    }
  });

  test("the PO's letterhead language is still writable", () => {
    // Same near-miss as the read side: `po_lang` is not `po_slang` and must not have been swept up.
    const s = flat(PoUpdateOps(caller, "9", { poLang: "KR" }, ctx).sql);
    expect(s).toContain("po_lang");
  });
});

describe("the detail upsert", () => {
  test("a linguistics job's pair goes to job_detail_linguistic, with its type", () => {
    const ops = JobDetailUpsertOps("7", JOB_TYPE_LINGUISTIC, {
      jobSlang: "한국어",
      jobElang: "영어",
    });
    expect(ops).not.toBeNull();
    const s = flat(ops!.sql);
    expect(s).toContain("INSERT INTO job_detail_linguistic (job_id, job_type, job_slang, job_elang)");
    expect(s).toContain("ON CONFLICT (job_id) DO UPDATE");
    expect(s).toContain("job_type = EXCLUDED.job_type");
    /*
     * `job_type` is bound, not defaulted. The composite FK to `job (id, job_type)` is the thing
     * that makes a language pair on a MICE job impossible, and a FK can only check a value that is
     * stored - an upsert that left the column to its DEFAULT would write 'LINGUISTICS' into the
     * detail row of a MICE job and be refused, or worse, be accepted on the table whose default
     * matches.
     */
    expect(names(ops!)).toEqual(expect.arrayContaining(["job_id", "job_type"]));
    expect(params(ops!).find((p) => p.name === "job_type")?.value).toBe("LINGUISTICS");
  });

  test("a MICE job's category goes to the other table, and no language column appears", () => {
    const ops = JobDetailUpsertOps("7", "MICE", { jobCategory: "event_ceremony_management" });
    expect(ops).not.toBeNull();
    const s = flat(ops!.sql);
    expect(s).toContain("INSERT INTO job_detail_non_linguistic (job_id, job_type, job_category)");
    expect(s).not.toContain("job_slang");
    expect(params(ops!).find((p) => p.name === "job_type")?.value).toBe("MICE");
  });

  test("the type decides the table, not the payload", () => {
    /*
     * A body carrying the wrong side for its type - a hand-crafted request, or a client built
     * against an older version of this API - must not reach the other table. The language pair is
     * dropped here rather than redirected, and the database's CHECK is the backstop if it ever is.
     */
    const ops = JobDetailUpsertOps("7", "IMC", { jobSlang: "한국어", jobElang: "영어" });
    expect(ops).toBeNull();

    const crossed = JobDetailUpsertOps("7", JOB_TYPE_LINGUISTIC, {
      jobCategory: "online_marketing",
    });
    expect(crossed).toBeNull();
  });

  test("a body that mentions neither side produces no statement at all", () => {
    /*
     * db/011's rule, in code: constraints forbid, never require. Jobs with both languages blank
     * exist by the thousand, and a MICE job with no category yet is a legitimate save. An
     * all-NULL detail row would turn "nobody has filled this in" into a row that exists, which
     * the composite FK then pins - so the job's type could not be changed afterwards either.
     */
    expect(JobDetailUpsertOps("7", JOB_TYPE_LINGUISTIC, { jobName: "이름만 고침" })).toBeNull();
    expect(JobDetailUpsertOps("7", "MICE", { jobName: "이름만 고침" })).toBeNull();
    expect(PoDetailUpsertOps("9", JOB_TYPE_LINGUISTIC, { poName: "이름만 고침" })).toBeNull();
    expect(PoDetailUpsertOps("9", "MICE", { poName: "이름만 고침" })).toBeNull();
  });

  test("null clears one side of the pair without clearing the other", () => {
    /*
     * `undefined` means "not provided", `null` means "clear it" - the distinction the whole write
     * layer runs on. A user who empties 도착어 and saves must get `job_elang = NULL`, not a
     * statement that quietly keeps the old value.
     */
    const ops = JobDetailUpsertOps("7", JOB_TYPE_LINGUISTIC, { jobElang: null });
    expect(ops).not.toBeNull();
    const s = flat(ops!.sql);
    expect(s).toContain("job_elang");
    expect(s).not.toContain("job_slang");
    expect(params(ops!).find((p) => p.name === "job_elang")?.value).toBeNull();
  });

  test("the PO upsert is the same function over the other two tables", () => {
    const linguistic = PoDetailUpsertOps("9", JOB_TYPE_LINGUISTIC, {
      poSlang: "한국어",
      poElang: "영어",
    });
    expect(flat(linguistic!.sql)).toContain(
      "INSERT INTO po_detail_linguistic (po_id, po_type, po_slang, po_elang)",
    );
    expect(flat(linguistic!.sql)).toContain("ON CONFLICT (po_id) DO UPDATE");

    const nonLinguistic = PoDetailUpsertOps("9", "IMC", { poCategory: "online_marketing" });
    expect(flat(nonLinguistic!.sql)).toContain(
      "INSERT INTO po_detail_non_linguistic (po_id, po_type, po_category)",
    );
    expect(params(nonLinguistic!).find((p) => p.name === "po_type")?.value).toBe("IMC");
  });
});

describe("clearing the row of the type being left", () => {
  test("each type names exactly one table", () => {
    expect(jobDetailTable(JOB_TYPE_LINGUISTIC)).toBe("job_detail_linguistic");
    expect(jobDetailTable("MICE")).toBe("job_detail_non_linguistic");
    expect(jobDetailTable("IMC")).toBe("job_detail_non_linguistic");
    expect(poDetailTable(JOB_TYPE_LINGUISTIC)).toBe("po_detail_linguistic");
    expect(poDetailTable("IMC")).toBe("po_detail_non_linguistic");
  });

  test("MICE to IMC clears the non-linguistic table, not the other one", () => {
    /*
     * The case that makes this a one-argument function. Both managers used to clear "the table the
     * NEW type does not use", which is right only while there are two types on each side of the
     * linguistic line. MICE to IMC leaves a row in `job_detail_non_linguistic` stamped `MICE`, and
     * the table the new type does not use is `job_detail_linguistic` - empty. So the delete would
     * clear nothing, the parent's UPDATE would be refused by the composite FK (23503), and the
     * user would be shown a 400 about a mismatch they did not cause.
     *
     * The type being LEFT is what identifies the row, so that is the argument.
     */
    expect(jobDetailTable("MICE")).toBe(jobDetailTable("IMC"));
    expect(flat(JobDetailClearOps("7", jobDetailTable("MICE")).sql)).toContain(
      "DELETE FROM job_detail_non_linguistic",
    );
  });

  test("the delete is by primary key and targets exactly one table", () => {
    const ops = JobDetailClearOps("7", jobDetailTable(JOB_TYPE_LINGUISTIC));
    expect(flat(ops.sql)).toBe("DELETE FROM job_detail_linguistic WHERE job_id = :job_id");
    expect(names(ops)).toEqual(["job_id"]);

    const po = PoDetailClearOps("9", poDetailTable(JOB_TYPE_LINGUISTIC));
    expect(flat(po.sql)).toBe("DELETE FROM po_detail_linguistic WHERE po_id = :po_id");
  });

  test("the authorizing read returns the type, because the update path needs it", () => {
    /*
     * `JobProjectOps` was widened from the project id alone to `{ projectId, jobType }`. It is the
     * scoped read that both authorizes the unscoped detail writes above and supplies the CURRENT
     * type - without which the update path cannot tell whether the type is changing, and so cannot
     * know whether to clear anything. It is also what a new PO defaults its own type from.
     */
    const s = flat(JobProjectOps(caller, "7").sql);
    expect(s).toContain("j.project_id AS project_id");
    expect(s).toContain("j.job_type AS job_type");
    expect(s).toContain("j.deleted = false");
    // Scoped: this read is the authorization the detail ops deliberately do not repeat.
    expect(names(JobProjectOps(caller, "7"))).toEqual(
      expect.arrayContaining(["scope_staff_id"]),
    );
  });
});

describe("the discriminator's TypeScript mirror", () => {
  test("an unrecognised type is non-linguistic, so it is only denied a language pair", () => {
    /*
     * A fourth type added from 유지보수 reaches this code before anybody edits it. Treating it as
     * linguistic would hand it a language-pair form it has no use for and refuse it a category;
     * treating it as non-linguistic denies it only the pair. This mirrors the database, where the
     * non-linguistic CHECK is `<> 'LINGUISTICS'` rather than an `IN (...)` allow-list.
     */
    expect(isLinguistic("LINGUISTICS")).toBe(true);
    expect(isLinguistic("MICE")).toBe(false);
    expect(isLinguistic("IMC")).toBe(false);
    expect(isLinguistic("SOMETHING_NEW")).toBe(false);
    expect(jobDetailTable("SOMETHING_NEW")).toBe("job_detail_non_linguistic");
  });

  test("an absent type reads as linguistics, matching the column's DEFAULT", () => {
    /*
     * `job.job_type` is NOT NULL DEFAULT 'LINGUISTICS', kept permanently so the external LKTMS ETL
     * - which does not know the column exists - keeps loading. A request that omits the type has
     * to land in the same place, or the form and the database would disagree about a row neither
     * of them wrote.
     */
    expect(isLinguistic(null)).toBe(true);
    expect(isLinguistic(undefined)).toBe(true);
    expect(isLinguistic("")).toBe(false);
  });

  test("only the detail tables' own constraints are translated", () => {
    /*
     * A mismatch surfaces as 23514 or 23503 on a constraint name no user has seen. Both have to be
     * caught - which fires depends on whether the type or the payload moved - but 23503 is ALSO
     * what an unrecognised `sys_code` code raises, and that is a different error with a different
     * fix. Hence the match on the name, and hence this test: translating `job_job_type_fkey` into
     * a sentence about 업무 구분 would hide a genuinely unknown code behind the wrong explanation.
     */
    /*
     * These eight are the names PostgreSQL actually reports, read off `pg_constraint` in the docker
     * rehearsal rather than off db/011's source - `ADD CONSTRAINT jdl_job_type_fkey` is the written
     * name and `jdn_is_not_linguistic` is NOT spelled `jdn_is_non_linguistic`, which is the kind of
     * thing a test written from memory gets wrong in the direction that still passes.
     */
    for (const name of [
      "jdl_is_linguistic",
      "jdl_job_type_fkey",
      "jdn_is_not_linguistic",
      "jdn_job_type_fkey",
      "pdl_is_linguistic",
      "pdl_po_type_fkey",
      "pdn_is_not_linguistic",
      "pdn_po_type_fkey",
    ]) {
      expect(typeMismatchMessage(name)).toContain("업무 구분");
    }
    for (const name of [
      "job_job_type_fkey",
      "purchase_order_po_type_fkey",
      "job_id_type_key",
      "",
    ]) {
      expect(typeMismatchMessage(name)).toBeNull();
    }
  });

  test("a detail table's AUTO-named FKs are not type mismatches, prefix rule or not", () => {
    /*
     * The limit of the prefix rule, and db/012 is what put it on the map.
     *
     * The eight constraints above are named by hand, so they carry the table's abbreviation. Every
     * other constraint on those same tables is named by PostgreSQL, which uses the full table name -
     * so `job_detail_linguistic_unit_code_fkey`, the UNIT-domain FK db/012 added when `unit_code`
     * moved, does not match `^(?:jdl|...)_` and falls through to a 500. That is the correct answer:
     * an unrecognised unit code is a `sys_code` problem with a different fix, and it read as one
     * before the column moved too (as `job_unit_code_fkey` on the parent).
     *
     * Asserted because the docstring on DETAIL_CONSTRAINT advertises "a constraint added to one of
     * those tables later is recognised too", and these are the counter-examples to that sentence.
     */
    for (const name of [
      "job_detail_linguistic_unit_code_fkey",
      "po_detail_linguistic_po_unit_code_fkey",
      "job_detail_linguistic_job_slang_fkey",
      "job_detail_non_linguistic_job_category_fkey",
      "job_detail_linguistic_pkey",
    ]) {
      expect(typeMismatchMessage(name)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */

/**
 * db/012_job_pricing.sql, in the ops layer. The second move through the same five edit sites, and
 * the one with a failure mode db/011 did not have.
 *
 * 011 moved columns nothing computes with. 012 moves the DERIVATION - volume, unit, unit price,
 * discount - while deliberately LEAVING the AMOUNT (`coin_code`, `coin_rate`, `job_price_sum`,
 * `job_price_ksum`) on the parent. That asymmetry is the whole design: a MICE job records no word
 * count but still records a total, and the total is what the margin report sums, what the job list
 * sorts on, and what the project rollup aggregates. Move it and all three change at once.
 *
 * So the assertions come in pairs - each moved column must have left the parent AND arrived at the
 * detail table, and each kept column must still be on the parent. A half-done move is the quiet
 * failure: taking `job_volume` out of `JOB_FIELDS` without adding it to `JOB_LINGUISTIC_FIELDS`
 * loses every unit price the user types, with no error anywhere.
 */
describe("the pricing derivation is read and written through the detail tables", () => {
  /** The five job columns db/012 moved, and the four PO ones. No discount exists on the PO side. */
  const jobMoved = ["job_volume", "unit_code", "job_price_sel", "job_price", "job_price_dis"];
  const poMoved = ["po_volume", "po_unit_code", "po_price_sel", "po_price"];

  /** The money. These stayed, and the reason they stayed is that everything downstream reads them. */
  const jobKept = ["coin_code", "coin_rate", "job_price_sum", "job_price_ksum"];
  const poKept = ["po_coin_code", "po_coin_rate", "po_price_sum", "po_price_ksum"];

  /*
   * A whole-identifier match, because the two halves of the split share a prefix: `job_price` is a
   * substring of `job_price_sum`, and `po_price` of `po_price_ksum`. A plain `toContain` therefore
   * reads a statement that correctly writes only the total as though it also wrote the unit price -
   * and the assertion that the derivation is absent fails on the very statement that proves it is.
   * `_` is a word character, so `\b` lands where the identifier ends and nowhere inside it.
   */
  const word = (column: string): RegExp => new RegExp(`\\b${column}\\b`);

  test("a read takes the derivation from the detail alias and the amount from the parent", () => {
    const s = flat(JobGetOps(caller, "7").sql);
    for (const column of jobMoved) {
      expect(s).toContain(`jdl.${column} AS ${column}`);
      // `j.job_volume` is a 42703 once db/012 has run.
      expect(s).not.toMatch(new RegExp(`\\bj\\.${column}\\b`));
    }
    for (const column of jobKept) {
      expect(s).toContain(`j.${column} AS ${column}`);
      expect(s).not.toMatch(new RegExp(`\\bjdl\\.${column}\\b`));
    }

    const p = flat(PoGetOps(caller, "7").sql);
    for (const column of poMoved) {
      expect(p).toContain(`pdl.${column} AS ${column}`);
      expect(p).not.toMatch(new RegExp(`\\bpo\\.${column}\\b`));
    }
    for (const column of poKept) {
      expect(p).toContain(`po.${column} AS ${column}`);
      expect(p).not.toMatch(new RegExp(`\\bpdl\\.${column}\\b`));
    }
  });

  test("the list read carries them too, since the list is where the unit price is shown", () => {
    const s = flat(JobListOps(caller, jobQuery, {}).sql);
    for (const column of jobMoved) expect(s).toContain(`jdl.${column} AS ${column}`);
    for (const column of jobKept) expect(s).toContain(`j.${column} AS ${column}`);

    const p = flat(PoListOps(caller, poQuery, {}).sql);
    for (const column of poMoved) expect(p).toContain(`pdl.${column} AS ${column}`);
    for (const column of poKept) expect(p).toContain(`po.${column} AS ${column}`);
  });

  test("a parent save writes the amount and never the derivation", () => {
    const input = {
      jobName: "번역 작업",
      jobVolume: "1200.00",
      unitCode: "단어",
      jobPriceSel: "A",
      jobPrice: "90.00",
      jobPriceDis: "0.00",
      coinCode: "KRW",
      coinRate: "1.00",
      jobPriceSum: "108000.00",
      jobPriceKsum: "108000.00",
    };
    const create = JobCreateOps(
      { projectId: "3", jobType: JOB_TYPE_LINGUISTIC, ...input } as Parameters<
        typeof JobCreateOps
      >[0],
      ctx,
    );
    const update = JobUpdateOps(caller, "7", input, ctx);

    for (const ops of [create, update]) {
      const s = flat(ops.sql);
      /*
       * A spec left behind in `JOB_FIELDS` is emitted unconditionally, so this is not "the pricing
       * save breaks" - it is EVERY job save breaking with 42703, including a save that only renames
       * the job.
       */
      for (const column of jobMoved) expect(s).not.toMatch(word(column));
      for (const column of jobKept) expect(s).toMatch(word(column));
    }
  });

  test("a PO parent save does the same, and keeps the CAT columns it never moved", () => {
    const input = {
      poName: "번역 발주",
      poVolume: "1200.00",
      poUnitCode: "단어",
      poPriceSel: "A",
      poPrice: "60.00",
      poCoinCode: "KRW",
      poCoinRate: "1.00",
      poPriceSum: "72000.00",
      poPriceKsum: "72000.00",
      poCatStotal: "1180.00",
    };
    const update = PoUpdateOps(caller, "9", input, ctx);
    const s = flat(update.sql);
    for (const column of poMoved) expect(s).not.toMatch(word(column));
    for (const column of poKept) expect(s).toMatch(word(column));
    /*
     * `po_cat_stotal` is a CAT-tool analysis figure, not a billing volume - nothing in the
     * application multiplies it by anything, which is why it did not follow `po_volume`. It is one
     * `_total` away from looking like a price, so it is asserted rather than assumed.
     */
    expect(s).toContain("po_cat_stotal");
  });

  test("the derivation goes to the linguistic detail row, alongside the pair", () => {
    const ops = JobDetailUpsertOps("7", JOB_TYPE_LINGUISTIC, {
      jobSlang: "한국어",
      jobElang: "영어",
      jobVolume: "1200.00",
      unitCode: "단어",
      jobPrice: "90.00",
      jobPriceDis: "0.00",
    } as Parameters<typeof JobDetailUpsertOps>[2]);
    expect(ops).not.toBeNull();
    const s = flat(ops!.sql);
    expect(s).toContain("INSERT INTO job_detail_linguistic");
    for (const column of ["job_volume", "unit_code", "job_price", "job_price_dis"]) {
      expect(s).toContain(column);
      expect(s).toContain(`${column} = EXCLUDED.${column}`);
    }
    // And the amount is not smuggled in here. It has exactly one home.
    for (const column of jobKept) expect(s).not.toMatch(word(column));

    const po = PoDetailUpsertOps("9", JOB_TYPE_LINGUISTIC, {
      poVolume: "1200.00",
      poUnitCode: "단어",
      poPrice: "60.00",
    } as Parameters<typeof PoDetailUpsertOps>[2]);
    const ps = flat(po!.sql);
    expect(ps).toContain("INSERT INTO po_detail_linguistic");
    for (const column of poMoved.filter((c) => c !== "po_price_sel")) {
      expect(ps).toContain(`${column} = EXCLUDED.${column}`);
    }
    for (const column of poKept) expect(ps).not.toMatch(word(column));
  });

  test("a non-linguistic job's detail row has no pricing at all - total only", () => {
    /*
     * "총액만" in one assertion. `job_detail_non_linguistic` gained nothing from db/012, because
     * there is no derivation to record: a MICE job's cost IS the number the user typed. A volume
     * sent for a MICE job is dropped here rather than redirected - the same rule the language pair
     * follows - and the row it would have gone in is forbidden by db/011's CHECK anyway.
     */
    const ops = JobDetailUpsertOps("7", "MICE", {
      jobCategory: "event_ceremony_management",
      jobVolume: "1.00",
      jobPrice: "5000000.00",
    } as Parameters<typeof JobDetailUpsertOps>[2]);
    expect(ops).not.toBeNull();
    const s = flat(ops!.sql);
    expect(s).toContain("INSERT INTO job_detail_non_linguistic (job_id, job_type, job_category)");
    for (const column of jobMoved) expect(s).not.toMatch(word(column));

    /*
     * And the legacy shape this replaces: 한국어 to 한국어, volume 1, unit price = the whole fee.
     * Re-typing such a job to MICE deletes its linguistic detail row and the money never moves, so
     * the cleanup cannot mistype a total - the point of leaving the amount on the parent.
     */
    const dummy = JobDetailUpsertOps("7", "MICE", {
      jobVolume: "1.00",
      jobPrice: "5000000.00",
    } as Parameters<typeof JobDetailUpsertOps>[2]);
    expect(dummy).toBeNull();
  });
});
