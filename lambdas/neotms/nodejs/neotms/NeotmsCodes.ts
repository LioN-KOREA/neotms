// SPDX-License-Identifier: MIT
//
// Minting the human-readable document codes: cus_code, prj_code, job_code, po_code, tran_code.
//
// These are not primary keys - the PK is a surrogate bigint - but they are printed on purchase
// orders and quoted on invoices, so they are externally visible and permanent. Two rules follow:
//
//   1. A code is never regenerated for an existing row. Nothing in this codebase updates one.
//   2. A code is never computed by reading the current maximum and adding one. That is what the
//      legacy app did, and it is a lost-update race: two PMs issuing a PO in the same second got
//      the same PO_CODE. The sequence does it atomically instead (db/005_code_sequences.sql), and
//      the UNIQUE constraint on the column is the backstop if anything here is ever wrong.
//
// The expression is built as SQL text rather than computed in TypeScript on purpose. Reading
// `nextval` in the application would mean a round trip before the INSERT, and a failure between the
// two would burn a code; inlining it means the code is minted inside the same statement that uses
// it, so a rolled-back INSERT only leaves a gap in the sequence.

/** Prefix and sequence for one entity's document code. */
export interface CodeMint {
  /**
   * The prefix a new code is given.
   *
   * PROVISIONAL for every entity except the PO. The legacy forms known for certain are
   * `LPO_149817` and `TRAN_xxxxxx`; the customer, project and job prefixes have not been read off
   * live data yet. Changing one later is safe - old rows keep their codes, which is the point - but
   * it does mean a period where two formats coexist, so confirm before the first production create.
   */
  readonly prefix: string;
  /** The sequence declared in db/005_code_sequences.sql. */
  readonly sequence: string;
  /**
   * How many digits the numeric part is padded to.
   *
   * Padding is cosmetic - it makes codes the same width in a list - and it is NOT a limit: once the
   * sequence passes the padded width the code simply gets longer, which is why the column is `text`
   * and not `char(n)`.
   */
  readonly width: number;
}

export const CUSTOMER_CODE: CodeMint = { prefix: "CUS_", sequence: "seq_customer_code", width: 6 };
export const PROJECT_CODE: CodeMint = { prefix: "PRJ_", sequence: "seq_project_code", width: 6 };
export const JOB_CODE: CodeMint = { prefix: "JOB_", sequence: "seq_job_code", width: 6 };
export const PO_CODE: CodeMint = { prefix: "LPO_", sequence: "seq_po_code", width: 6 };
export const TRANSLATOR_CODE: CodeMint = {
  prefix: "TRAN_",
  sequence: "seq_translator_code",
  width: 6,
};

/**
 * The SQL expression that produces the next code.
 *
 * Interpolated into the statement text, so neither argument may ever come from request input - and
 * neither can, because the only values passed are the module-level constants above.
 */
export const codeExpression = (mint: CodeMint): string =>
  `'${mint.prefix}' || lpad(nextval('${mint.sequence}')::text, ${mint.width}, '0')`;
