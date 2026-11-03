// SPDX-License-Identifier: MIT
//
// 업무 구분 - the one string the job, PO and report modules all have to agree on.
//
// A job or a PO is LINGUISTICS (언어 및 통번역), MICE or IMC. The first carries a language pair, the
// other two carry an 업무 분류, and which of the two side tables a row's payload lives in follows
// from that one value. db/011_job_types.sql has the schema and the reasoning.
//
// ## Why a module for one constant
//
// `'LINGUISTICS'` appears in five places that must not drift: two CHECK constraints and a DEFAULT in
// the database, both dbops modules' detail writes, and the report's `langPair` dimension, which
// decides on it whether a row reads as a language pair or as `(비언어)`. The constraints are the
// authority - they are what the ETL is held to as well - so the TypeScript side is a mirror, and
// mirrors are safest when there is exactly one of them.
//
// ## The membership test is negative on purpose
//
// `isLinguistic` asks whether the type IS the one linguistic value; everything else is
// non-linguistic. Written the other way round - a list of the two non-linguistic types - a fourth
// type added from 유지보수 would fall through as linguistic, which is the worst of the three
// possible answers: the job would get a language-pair form it has no use for and be refused a
// category. This way, an unrecognised type is treated as non-linguistic and the only thing it is
// denied is a language pair. That matches the database, where the non-linguistic CHECK is
// `job_type <> 'LINGUISTICS'` rather than `job_type IN (...)`.

/**
 * The linguistic type's `sys_code.code`.
 *
 * Also the DEFAULT of `job.job_type` and `purchase_order.po_type`, which is why a request that omits
 * the type lands here: all historical work is linguistics, and so is everything the LKTMS ETL
 * inserts without knowing the column exists.
 */
export const JOB_TYPE_LINGUISTIC = "LINGUISTICS";

/** Whether this 업무 구분 carries a language pair rather than an 업무 분류. */
export const isLinguistic = (jobType: string | null | undefined): boolean =>
  (jobType ?? JOB_TYPE_LINGUISTIC) === JOB_TYPE_LINGUISTIC;

/**
 * Which detail table a row of this type belongs in.
 *
 * The update path calls this twice, and the two answers are about two different types: the row
 * belonging to the type being LEFT is deleted, then the row belonging to the type being MOVED TO is
 * upserted. A composite FK pins each detail row's `job_type` to its parent's, so the delete has to
 * come first - the parent's UPDATE fails with 23503 while a row of the old type is still there.
 *
 * ## Why this does not also return "the stale table"
 *
 * It used to, and that was a trap. "The other table" is only the stale one while there are exactly
 * two types on each side of the line. Changing MICE to IMC leaves a row in
 * `job_detail_non_linguistic` stamped `MICE`, and the other table - `job_detail_linguistic` - is
 * empty: deleting from it clears nothing, and the parent's UPDATE is then refused by the FK. The
 * type being left is the only thing that identifies the row to remove, so the caller has to name
 * it, and the one-argument form makes naming the wrong one awkward rather than natural.
 *
 * The table names are interpolated into SQL text, so they are returned from this closed set rather
 * than built from input - there is no path by which a request string reaches a FROM clause.
 */
export const jobDetailTable = (jobType: string | null | undefined): JobDetailTable =>
  isLinguistic(jobType) ? "job_detail_linguistic" : "job_detail_non_linguistic";

export type JobDetailTable = "job_detail_linguistic" | "job_detail_non_linguistic";

/** The PO equivalent. Separate tables, same rule - a PO's type is its own, not its job's. */
export const poDetailTable = (poType: string | null | undefined): PoDetailTable =>
  isLinguistic(poType) ? "po_detail_linguistic" : "po_detail_non_linguistic";

export type PoDetailTable = "po_detail_linguistic" | "po_detail_non_linguistic";

/* -------------------------------------------------------------------------- */
/* When the discriminator refuses a write                                     */
/* -------------------------------------------------------------------------- */

/**
 * The eight constraints db/011_job_types.sql puts on the four detail tables, by name prefix.
 *
 * `jdl_` / `jdn_` / `pdl_` / `pdn_` are the four tables' abbreviations, and every constraint of
 * theirs - the CHECK that pins the table to its one permitted type, and the composite FK that pins
 * the row's type to its parent's - is named with that prefix. Matching on the prefix rather than on
 * the eight names means a constraint added to one of those tables later is recognised too, which is
 * the right default: a refusal from a detail table is a type-mismatch refusal.
 */
const DETAIL_CONSTRAINT = /^(?:jdl|jdn|pdl|pdn)_/;

/**
 * Turn a discriminator refusal into a sentence, or return null if that is not what went wrong.
 *
 * The happy path never reaches this. Both forms render the language pair and the category ON the
 * selected type, so a request carrying the wrong one is either hand-crafted or sent by a client
 * built against a different version of this API. In both cases a 400 naming the actual
 * disagreement is worth far more than a 500 quoting `jdl_is_linguistic`, which appears nowhere a
 * user can see.
 *
 * ## Why this matches on the constraint and not on the SQLSTATE
 *
 * The two constraints catch the same mistake from two directions - the CHECK rejects a detail row
 * whose own type is wrong for its table, the FK rejects one whose type disagrees with its parent's -
 * and which fires depends on whether the type or the payload was the thing that moved. So both
 * 23514 and 23503 have to be caught. But 23503 is ALSO what an unrecognised `sys_code` code raises,
 * and that is a different error with a different fix. The constraint name is the only thing that
 * separates them, so it is what this reads.
 *
 * ## The separation is not perfect, and the imperfection is harmless
 *
 * Measured against a real database (the docker rehearsal in README.md): setting `job_type` to a code
 * `sys_code` does not have is refused by `job_job_type_fkey` when the job has no detail row - no
 * message from here, a 500, correct. But when the job DOES have a detail row, PostgreSQL reports
 * `jdl_job_type_fkey` instead, because changing the parent's type orphans the child, and that
 * violation is found first. So an unknown code on a job with a detail row gets the sentence below.
 *
 * Left as it is deliberately. The sentence tells the user to check the 업무 구분, which is exactly
 * what is wrong with the request; the alternative is a 500 and a constraint name. Both inputs are
 * hand-crafted anyway - every form offers only codes read from `sys_code`.
 */
export function typeMismatchMessage(constraintName: string): string | null {
  if (!DETAIL_CONSTRAINT.test(constraintName)) return null;
  return (
    "업무 구분과 세부 정보가 서로 맞지 않습니다. " +
    "'언어 및 통번역' 업무에만 출발어·도착어를 저장할 수 있고, " +
    "MICE·IMC 업무에만 업무 분류를 저장할 수 있습니다. " +
    "업무 구분을 먼저 확인해 주세요."
  );
}
