// SPDX-License-Identifier: MIT
//
// `sys_code` - the code tables every dropdown in the application is filled from.
//
// Before this module existed there was no SELECT against `sys_code` anywhere in the codebase, and
// the consequence was not a missing feature but a wall. Twenty-two columns across this schema are
// `text REFERENCES sys_code (code) ON DELETE RESTRICT`, `sys_code` was empty, and so every INSERT
// that carried a code - a customer's 분야, a job's 작업 종류 and 언어, a purchase order's 단위 -
// failed with SQLSTATE 23503. The screens that collected those values did it with free-text inputs
// and a hint saying "등록된 코드값만 저장됩니다", which was true and useless: no value was
// registered, so no value worked, and the error named a constraint rather than a field.
//
// db/007_codes.sql seeded the five domains. This module is how they are read and maintained.
//
// ## The natural key is `code`, and it is immutable here
//
// Those twenty-two foreign keys point at `sys_code (code)`, not at `sys_code (id)` - a deliberate
// choice in 002_tables.sql so the legacy string survives the ETL untouched. The cost of that choice
// is paid here: `code` cannot be edited. An UPDATE of it would be refused by the referencing
// constraints anyway (they default to NO ACTION on update), and in the cases where nothing
// references the row yet it would succeed and silently split the value set - the same concept now
// spelled two ways, both live. So `CODE_FIELDS` below omits it, and the screen renames the LABEL
// instead. Getting a code wrong is fixed by deactivating it and adding the right one.
//
// ## `code` is unique across the whole table, not per domain
//
// Also inherited, also unavoidable: a foreign key needs a unique constraint on the columns it
// references, and making it `(code_parent, code)` would mean mirroring `code_parent` into all
// twenty-two referencing tables. So '기타' can exist exactly once in this database - 작업 has it,
// and the other domains qualify theirs ('일반·기타', '기타 언어', '기타 프로그램'). The create
// path turns the resulting 23505 into a sentence that says so, because "duplicate key value
// violates unique constraint sys_code_code_key" does not tell an administrator that the code they
// want is already in use by a different list.

import {
  param,
  readBool,
  readId,
  readInt,
  readText,
  type SqlOps,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { FieldSpec } from "../NeotmsWrite.js";
import { insertFragments, updateFragments } from "../NeotmsWrite.js";
import type { CodeCreate, CodeUpdate } from "../neotms.schemas.js";

/**
 * The five domains db/007_codes.sql seeds, as the application names them.
 *
 * These are the literal `sys_code.code` values of the domain rows - the ones with `code_parent`
 * NULL - and they are ASCII while their children are Korean. The asymmetry is on purpose: a domain
 * code travels in a query string and gets compared against this constant, while a child's code is
 * the value that lands in `job.work_code` and is already Korean in both the frontend and the legacy
 * data.
 *
 * Nothing enforces that a `sys_code` row's parent is one of these. An administrator may add a sixth
 * domain from 유지보수 and it will be listed and maintained like the others; what it will NOT have
 * is a dropdown reading it, because that requires a line of frontend code naming it. This constant
 * exists so the ones with dropdowns are enumerable rather than scattered across form components.
 */
export const NeotmsCodeDomain = {
  /** 분야. customer.cus_field, project.prj_field, project.prj_field2, translator.tran_field, translator.tran_unfield */
  FIELD: "FIELD",
  /** 작업 종류. job.work_code, purchase_order.po_work_code, customer_contract.work_code, translator_lang.work_code, translator.tran_work_con */
  WORK: "WORK",
  /** 단가 단위. job.unit_code, purchase_order.po_unit_code, translator_lang.tran_la_unit */
  UNIT: "UNIT",
  /** 언어. eight columns across job, purchase_order, customer_contract and translator_lang */
  LANG: "LANG",
  /** 사용 프로그램 (CAT tool). translator.tran_upro, and customer.cus_upro which is read-only now. */
  UPRO: "UPRO",
} as const;

export type NeotmsCodeDomainId = (typeof NeotmsCodeDomain)[keyof typeof NeotmsCodeDomain];

export type CodeRow = {
  /** `sys_code.id`. Used to address a row for PATCH and DELETE - see the note at the top of this file. */
  id: string;
  /** The FK target. Immutable once created. */
  code: string;
  codeName: string | null;
  codeEngName: string | null;
  /** The domain. NULL means this row IS a domain. */
  codeParent: string | null;
  ordNo: number | null;
  active: boolean;
};

/*
 * Parameterised by the qualifier, like `customerColumns` in NeotmsCustomer.dbops.ts, because the
 * same list is needed behind the alias `c` in the SELECTs and behind the bare table name in the
 * INSERT's and UPDATE's RETURNING - a RETURNING clause cannot see a FROM-list alias that does not
 * exist. Every column is aliased even where nothing would collide, which is the rule throughout
 * these modules: rows come back keyed by column name, so two same-named columns from a join
 * collapse into one with no error at all.
 */
const codeColumns = (q: string): string => `
  ${q}.id            AS code_id,
  ${q}.code          AS code_code,
  ${q}.code_name     AS code_name,
  ${q}.code_eng_name AS code_eng_name,
  ${q}.code_parent   AS code_parent,
  ${q}.ord_no        AS code_ord_no,
  ${q}.active        AS code_active
`;

const toCodeRow = (row: SqlRow): CodeRow => ({
  id: readId(row, "code_id") ?? "",
  code: readText(row, "code_code") ?? "",
  codeName: readText(row, "code_name"),
  codeEngName: readText(row, "code_eng_name"),
  codeParent: readText(row, "code_parent"),
  ordNo: readInt(row, "code_ord_no"),
  active: readBool(row, "code_active") ?? false,
});

/*
 * `ord_no NULLS LAST, code` for every listing here.
 *
 * `ord_no` is nullable and the ETL will not populate it, so a plain `ORDER BY ord_no` puts every
 * migrated code ahead of the seeded ones in PostgreSQL (NULLs sort first on ASC) - a 분야 dropdown
 * whose first eight entries are unordered legacy values and whose curated list is below the fold.
 * `code` as the tiebreak makes the order total, which matters more than it sounds: an ORDER BY with
 * ties is free to return them differently between two calls, and a dropdown whose options move
 * between page loads reads as a broken screen.
 */
const CODE_ORDER = `ORDER BY c.ord_no NULLS LAST, c.code`;

/**
 * Every active code in every domain, in one statement.
 *
 * One request for all of them rather than one per domain, and the reason is the shape of the
 * demand: a single form needs 분야 and 작업 and 단위 and 언어 at once, so per-domain fetching means
 * four round trips to render one modal, each taking a Supavisor connection from a budget of forty.
 * The whole table is about sixty rows of short text - smaller than the customer page that triggers
 * the same screen - so there is nothing to be saved by splitting it.
 *
 * Domain rows are included (they come back with `codeParent` null), because the client groups by
 * parent and needs the domain's own label to title the group. Without them the UI would have to
 * carry its own Korean labels for the five domains, and those would then be the second place the
 * domain list is written down.
 *
 * Inactive codes are excluded, which is the entire difference between this and the admin listing.
 * `active = false` is the normal way to retire a code: it vanishes from every dropdown while the
 * rows that already reference it keep resolving, which is what deletion cannot do.
 */
export const CodeAllOps: () => SqlOps<CodeRow[]> = () => ({
  sql: `
    SELECT ${codeColumns("c")}
      FROM sys_code c
     WHERE c.active = true
     ${CODE_ORDER}
  `,
  parameters: [],
  mapper: (rows) => rows.map(toCodeRow),
});

/**
 * Every code, including inactive ones. The 유지보수 screen's listing.
 *
 * Separate from `CodeAllOps` rather than a parameter on it, so that "may see retired codes" is
 * decided by which route was reached - and therefore by `sys_role_auth` - instead of by a query
 * string a caller controls. A boolean in the URL that widens a result set is a boolean somebody
 * will eventually set.
 */
export const CodeAllIncludingInactiveOps: () => SqlOps<CodeRow[]> = () => ({
  sql: `
    SELECT ${codeColumns("c")}
      FROM sys_code c
     ${CODE_ORDER}
  `,
  parameters: [],
  mapper: (rows) => rows.map(toCodeRow),
});

export const CodeGetOps: (id: string) => SqlOps<CodeRow | null> = (id) => ({
  sql: `
    SELECT ${codeColumns("c")}
      FROM sys_code c
     WHERE c.id = :id
     LIMIT 1
  `,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows.length > 0 ? toCodeRow(rows[0]!) : null),
});

/**
 * The editable columns. `code` is absent - see the file header.
 *
 * `code_parent` IS editable, which looks inconsistent next to an immutable `code` and is not:
 * moving a code from one domain to another changes which dropdown offers it and nothing else. No
 * foreign key anywhere references `code_parent`, and every row that references the code references
 * it by `code`, which has not changed. The one real effect is that a code moved out of a domain
 * stops being offered for columns in that domain - which is the point of being able to move it.
 */
const CODE_FIELDS: readonly FieldSpec<CodeUpdate>[] = [
  { column: "code_name", kind: "text", read: (i) => i.codeName },
  { column: "code_eng_name", kind: "text", read: (i) => i.codeEngName },
  { column: "code_parent", kind: "text", read: (i) => i.codeParent },
  { column: "ord_no", kind: "int", read: (i) => i.ordNo },
  { column: "active", kind: "bool", read: (i) => i.active },
];

/**
 * Add a code.
 *
 * `code` is written here and nowhere else, which is what makes it immutable: it is supplied on
 * create, and `CODE_FIELDS` - the only list the UPDATE is built from - does not mention it.
 *
 * No `created_by`: `sys_code` has `created_at` but no audit columns, unlike the business tables.
 * Adding them is a schema change that would have to be mirrored in the ETL, and the legacy table
 * did not have them either, so there is nothing to migrate into them.
 */
export const CodeCreateOps: (input: CodeCreate) => SqlOps<CodeRow | null> = (input) => {
  const fields = insertFragments(CODE_FIELDS, input);
  return {
    sql: `
      INSERT INTO sys_code (code${fields.columns.length > 0 ? ", " + fields.columns.join(", ") : ""})
      VALUES (:new_code${fields.placeholders.length > 0 ? ", " + fields.placeholders.join(", ") : ""})
      RETURNING ${codeColumns("sys_code")}
    `,
    /*
     * `:new_code` rather than `:code`, because `insertFragments` names each parameter after its
     * column and a sixth field named `code` would collide with this one. It cannot today - `code`
     * is not in CODE_FIELDS - but the collision would be a silently wrong value rather than an
     * error, so the name is kept distinct rather than merely unique.
     */
    parameters: [param("new_code", input.code, "text"), ...fields.parameters],
    mapper: (rows) => (rows.length > 0 ? toCodeRow(rows[0]!) : null),
  };
};

/** Edit a code's labels, domain, order or active flag. Returns null when no such row. */
export const CodeUpdateOps: (id: string, input: CodeUpdate) => SqlOps<CodeRow | null> = (
  id,
  input,
) => {
  const fields = updateFragments(CODE_FIELDS, input);
  return {
    sql: `
      UPDATE sys_code
         SET ${fields.fragment}
       WHERE id = :id
      RETURNING ${codeColumns("sys_code")}
    `,
    parameters: [...fields.parameters, param("id", id, "id")],
    mapper: (rows) => (rows.length > 0 ? toCodeRow(rows[0]!) : null),
  };
};

/**
 * How many rows this code has as its domain.
 *
 * Checked before deleting, because `code_parent` is itself a self-referencing foreign key: deleting
 * a domain row that still has children is refused by `sys_code_code_parent_fkey`, and that refusal
 * reads identically to the twenty-two business-table refusals while meaning something completely
 * different and much easier to fix.
 */
export const CodeChildCountOps: (code: string) => SqlOps<number> = (code) => ({
  sql: `SELECT count(*) AS child_count FROM sys_code WHERE code_parent = :code`,
  parameters: [param("code", code, "text")],
  mapper: (rows) => Number(rows[0]?.["child_count"] ?? 0),
});

/**
 * Hard-delete a code. Returns null when no such row.
 *
 * A hard DELETE, unlike every other delete in this API, and `sys_code` has no `deleted` column to
 * do otherwise with. The soft delete is `active = false`, which is what the screen offers first and
 * what retiring a code actually means.
 *
 * This statement is expected to fail. Any of twenty-two `ON DELETE RESTRICT` constraints will
 * refuse it the moment one row anywhere references the code, and that is the desired behaviour -
 * it is the database refusing to orphan a job's 작업 종류. The manager turns the 23503 into a
 * sentence naming the alternative, because the raw message names a constraint on a table the
 * administrator was not looking at.
 */
export const CodeDeleteOps: (id: string) => SqlOps<string | null> = (id) => ({
  sql: `DELETE FROM sys_code WHERE id = :id RETURNING id AS deleted_id`,
  parameters: [param("id", id, "id")],
  mapper: (rows) => (rows.length > 0 ? readId(rows[0]!, "deleted_id") : null),
});
