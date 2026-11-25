// SPDX-License-Identifier: MIT
//
// 나의 업무: the PM's own sheet, and the two things it must not become.
//
// Like neotms.acceptance.test.ts, this file IMPORTS the dbops module and builds real statements,
// because what matters most here is not visible as a substring in the source: the predicates that
// make this feature private are inside the statements, and a refactor can move one out of a
// statement and into TypeScript without changing a single word of the surrounding code.
//
// The four facts these tests keep true:
//
//   1. **The sheet is one person's.** `p.prj_pm_id = :pm_id` is the authorization, not a filter -
//      so a superuser gets their own sheet rather than everybody's, and no `scopeClause` is needed
//      or wanted. If that predicate were ever relaxed to a scope clause, the screen would quietly
//      become "every PO I may see", which is a different and much larger screen.
//   2. **One person's annotations are invisible to everyone else.** The cell subquery joins through
//      `workspace_column` to reach `staff_id`. Drop that join and the sheet returns every user's
//      notes on the same PO - the one way this feature could leak something, and it would leak it
//      into a cell that looks like the reader's own.
//   3. **Nothing here writes a job, a project or a purchase order.** The sheet's editable default
//      columns go out through the ordinary endpoints for those rows. A second write path would hold
//      a second opinion about the translator lock, the derived name columns and the job-type
//      constraint - each of which is a rule that already exists.
//   4. **Deleting a column really deletes its values**, by cascade rather than by a flag, because
//      that is what the screen promises the person who confirms it.
//
// The SQL semantics - that `jsonb_object_agg` of no rows is NULL rather than `{}`, that
// `unnest(... ) WITH ORDINALITY` rewrites the order in one statement, that an `INSERT ... SELECT ...
// WHERE EXISTS` writes zero rows when the predicate fails rather than raising - are PostgreSQL
// behaviour this file assumes and does not prove.

import { readFileSync, readdirSync } from "node:fs";
import { JobUpdateOps } from "../lambdas/neotms/nodejs/neotms/jobs/NeotmsJob.dbops.js";
import { PoUpdateOps } from "../lambdas/neotms/nodejs/neotms/purchase-orders/NeotmsPurchaseOrder.dbops.js";
import { ProjectUpdateOps } from "../lambdas/neotms/nodejs/neotms/projects/NeotmsProject.dbops.js";
import { CustomerUpdateOps } from "../lambdas/neotms/nodejs/neotms/customers/NeotmsCustomer.dbops.js";
import { TranslatorUpdateOps } from "../lambdas/neotms/nodejs/neotms/translators/NeotmsTranslator.dbops.js";
import { StaffAdminUpdateOps } from "../lambdas/neotms/nodejs/neotms/staff/NeotmsStaffAdmin.dbops.js";
import { RoleUpdateOps } from "../lambdas/neotms/nodejs/neotms/staff/NeotmsRoleAdmin.dbops.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_SORTS,
  WorkspaceCellClearOps,
  WorkspaceCellPruneOps,
  WorkspaceCellStyleOps,
  WorkspaceColumnPruneOps,
  WorkspaceLayoutCustomOps,
  WorkspaceLayoutFixedOps,
  WorkspaceRowStyleOps,
  WorkspaceCellWriteOps,
  WorkspaceColumnCreateOps,
  WorkspaceColumnDeleteOps,
  WorkspaceColumnOrderOps,
  WorkspaceColumnRenameOps,
  WorkspaceColumnsOps,
  WorkspaceSheetOps,
  WorkspaceUnplacedJobsOps,
  toWorkspaceRow,
} from "../lambdas/neotms/nodejs/neotms/workspace/NeotmsWorkspace.dbops.js";

const repoFile = (...segments: string[]): string =>
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ...segments),
    "utf8",
  );

const dbops = () =>
  repoFile("lambdas", "neotms", "nodejs", "neotms", "workspace", "NeotmsWorkspace.dbops.ts");

const manager = () =>
  repoFile("lambdas", "neotms", "nodejs", "neotms", "workspace", "NeotmsWorkspaceManager.ts");

/** Source with comments stripped, so no assertion can be satisfied by prose explaining it. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/** Every `.dbops.ts` under a directory. */
const walkTsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTsFiles(full);
    return entry.name.endsWith(".dbops.ts") ? [full] : [];
  });

/** A caller who sees every row, so the scope clause contributes nothing to the assertions. */
const CALLER = { staffId: "1", mgrId: "kim3", seesEveryRow: true } as never;
const CTX = { actor: "kim3", ip: null };

const SHEET = WorkspaceSheetOps("7", {
  limit: 200,
  cursor: null,
  sort: { key: "due", ...WORKSPACE_SORTS.due },
  direction: "asc",
  search: null,
}).sql;

describe("나의 업무 — whose sheet it is", () => {
  test("the sheet is scoped by the PM column itself, with no scope clause", () => {
    /*
     * Two predicates, and both are the specification rather than an optimisation: the projects
     * this person is the PM OF, and the ones they have ACCEPTED. A project awaiting an answer, or
     * refused, is not their work yet - it is on the PM dashboard, which is where it is answered.
     */
    expect(SHEET).toContain("p.prj_pm_id = :pm_id");
    expect(SHEET).toContain("p.acceptance_status = 1");

    /*
     * And deliberately NO `scopeClause`. `p.prj_pm_id` is one of the four columns it would OR
     * together and the narrowest of them, so adding it would change no result while creating a
     * fifth copy of a column list whose drift the PO module warns about. More to the point, a
     * scope clause ORs - so pasting one in here would turn "POs I am answerable for" into "POs I
     * may see", silently and with no visible change to the screen except more rows.
     */
    expect(code(dbops())).not.toContain("scopeClause");

    /*
     * And the sheet's own WHERE does not OR anything, which is the shape a scope clause would
     * arrive in. Asserted on that clause alone rather than on the whole statement: the cell-style
     * aggregate legitimately ORs the four style columns together to find the styled rows, and a
     * test that could not tell the two apart would have to be deleted the first time styling grew.
     */
    const where = SHEET.slice(SHEET.indexOf("WHERE po.deleted"), SHEET.lastIndexOf("ORDER BY"));
    expect(where).toContain("p.prj_pm_id = :pm_id");
    expect(where).not.toContain(" OR ");
  });

  test("a sheet row only ever reaches live rows of live parents", () => {
    // Soft delete is the only delete in this schema, so an omitted `deleted = false` is not an
    // empty sheet - it is a sheet with cancelled work on it, which reads as real work.
    expect(SHEET).toContain("po.deleted = false");
    expect(SHEET).toContain("JOIN job j ON j.id = po.job_id AND j.deleted = false");
    expect(SHEET).toContain("JOIN project p ON p.id = j.project_id AND p.deleted = false");
  });

  test("the custom cells of one row belong to the caller and nobody else", () => {
    /*
     * The privacy boundary of this whole feature, in one predicate. `workspace_cell` has no
     * staff id - it is on the column - so the subquery has to JOIN to reach it. Without the join
     * the sheet would return every user's annotations on the same PO, in the reader's own columns.
     */
    expect(SHEET).toContain("JOIN workspace_column wcol ON wcol.id = wc.column_id");
    expect(SHEET).toContain("wcol.staff_id = :pm_id");

    /*
     * Aggregated, not joined. A join to `workspace_cell` would fan one PO out into one row per
     * annotated column, so a PO with three notes would appear three times - and the sheet's
     * totals, cursor and row count would all be wrong in the same direction.
     */
    expect(SHEET).toContain("jsonb_object_agg(wc.column_id::text, wc.cell_text)");
    expect(SHEET).not.toMatch(/JOIN workspace_cell\s/);
  });

  test("인계일 is one lateral with LIMIT 1, not a join", () => {
    /*
     * `project_acceptance` is append-only: a project reassigned after a rejection collects a
     * second row. A plain join would multiply every PO of that project, and the duplicate would
     * read as two POs rather than as one counted twice.
     */
    expect(SHEET).toContain("LEFT JOIN LATERAL");
    expect(SHEET).toContain("pa.acceptance_status = 1");
    expect(SHEET).toContain("ORDER BY pa.created_at DESC");
    expect(SHEET).toContain("LIMIT 1");
    expect((SHEET.match(/LEFT JOIN LATERAL/g) ?? []).length).toBe(1);
  });

  test("the cursor and the sort target agree, for every sort this screen offers", () => {
    /*
     * `sortAlias` derives the keyset cursor's row key by slicing after the first dot, so every
     * sort target must be a real qualified column that the SELECT also aliases to that name.
     * Point one at an expression and the cursor stops advancing SILENTLY - the same page forever,
     * with no error. `created` is the one that caught this: it was in WORKSPACE_SORTS before
     * `po.created_at` was in the SELECT.
     */
    for (const [key, target] of Object.entries(WORKSPACE_SORTS)) {
      const alias = target.column.slice(target.column.indexOf(".") + 1);
      expect(SHEET).toContain(`AS ${alias}`);
      expect(target.column).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(key.length).toBeGreaterThan(0);
    }
  });

  test("what the sheet is not showing is counted", () => {
    /*
     * One row per PO is the specification, so a job whose translator has not been engaged yet has
     * no row at all - and that is the job a PM most needs to see. The count does not replace the
     * rows, but "14 jobs are not shown here" and silence are very different screens.
     */
    const sql = WorkspaceUnplacedJobsOps("7").sql;
    expect(sql).toContain("p.prj_pm_id = :pm_id");
    expect(sql).toContain("p.acceptance_status = 1");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("po.deleted = false");
  });

  test("a row with no annotations maps to an empty object, not to null", () => {
    /*
     * `jsonb_object_agg` over no rows returns NULL, and the mapper has to turn that into `{}` -
     * otherwise every cell lookup on an un-annotated row throws, which is most rows on day one.
     * Non-string values are dropped rather than coerced, so a future jsonb number cannot arrive
     * as `42` where the grid expects text.
     */
    expect(toWorkspaceRow({ cells: null }).cells).toEqual({});
    expect(toWorkspaceRow({}).cells).toEqual({});
    expect(toWorkspaceRow({ cells: { "3": "ok", "4": 42 } }).cells).toEqual({ "3": "ok" });
    expect(toWorkspaceRow({ cells: ["nope"] }).cells).toEqual({});
  });

  test("po_approved and po_money_state are sent, and the verdict is not", () => {
    /*
     * The 번역가 cell locks on an approved or settled PO, and it decides that with the same two
     * fields `mayChangeTranslator` reads on the PO screens. Sending a boolean verdict instead
     * would be a second implementation of that rule, in the one place nobody would look for it.
     */
    expect(SHEET).toContain("po.po_approved");
    expect(SHEET).toContain("po.po_money_state");
    expect(toWorkspaceRow({ po_approved: true }).poApproved).toBe(true);
    // Absent reads as false: an un-approved PO is the common case and must not lock its cell.
    expect(toWorkspaceRow({}).poApproved).toBe(false);
  });
});

describe("나의 업무 — the caller's own columns", () => {
  test("every column statement carries the caller's staff id as a predicate", () => {
    /*
     * Row-level authority inside the statement, never a pre-check. A rename or a delete naming
     * somebody else's column affects zero rows and is reported as "not found" - which is also why
     * the manager answers 404 rather than 403: it cannot tell "no such column" from "not yours",
     * and should not, because a 403 confirms the id exists.
     */
    const statements = [
      WorkspaceColumnsOps("7").sql,
      WorkspaceColumnRenameOps("7", "3", "메모").sql,
      WorkspaceColumnDeleteOps("7", "3").sql,
      WorkspaceColumnOrderOps("7", ["3", "4"]).sql,
    ];
    for (const sql of statements) {
      expect(sql).toContain("staff_id = :staff_id");
    }
  });

  test("a new column's position is computed in the statement, not sent by the client", () => {
    /*
     * "Last" is the only position a new column can have, and the only one the person pressing the
     * button is looking at. A client-chosen `ord_no` would have to be unique to mean anything, and
     * two tabs adding a column at the same moment would then collide on a constraint nobody has
     * heard of.
     */
    const sql = WorkspaceColumnCreateOps("7", "메모", "kim3", "10.0.0.1").sql;
    expect(sql).toContain("max(ord_no) + 1");
    expect(sql).toContain("WHERE staff_id = :staff_id");
    expect(sql).not.toContain(":ord_no");
  });

  test("a reorder is one statement over the whole list", () => {
    /*
     * A drag that moves a column three places changes four positions. Sent as four PATCHes, the
     * order is briefly wrong in three different ways and there is no way back from a failure
     * halfway. `WITH ORDINALITY` is what lets the client send what it means - "this is the order"
     * - instead of arithmetic on `ord_no`.
     */
    const ops = WorkspaceColumnOrderOps("7", ["5", "3", "4"]);
    expect(ops.sql).toContain("unnest(:ids) WITH ORDINALITY");
    expect(ops.sql).toContain("ord_no     = o.ord - 1");
    expect(ops.parameters?.find((p) => p.name === "ids")?.value).toEqual(["5", "3", "4"]);
    expect(ops.parameters?.find((p) => p.name === "ids")?.kind).toBe("idArray");
  });

  test("deleting a column destroys its values by cascade, not by a flag", () => {
    /*
     * What the screen promises the person who confirms it. A `deleted` flag would keep the values
     * in the table while telling them otherwise - and a column added later with the same name
     * could not be told apart from the one that was meant to be gone.
     */
    const schema = repoFile("db", "001_schemas.sql");
    const migration = repoFile("db", "006_workspace.sql");
    for (const sql of [schema, migration]) {
      expect(sql).toContain("column_id  bigint NOT NULL REFERENCES workspace_column (id) ON DELETE CASCADE");
      expect(sql).toContain("po_id      bigint NOT NULL REFERENCES purchase_order (id) ON DELETE CASCADE");
    }
    // No soft delete on either table: there is nothing here whose history is company history.
    expect(code(dbops())).not.toContain("deleted = false\n       AND wc");
    expect(WorkspaceColumnDeleteOps("7", "3").sql).toContain("DELETE FROM workspace_column");
  });
});

describe("나의 업무 — writing a cell", () => {
  const OWNERSHIP = [
    "SELECT 1 FROM workspace_column c",
    "c.staff_id = :staff_id",
    "p.prj_pm_id = :staff_id",
    "p.acceptance_status = 1",
  ];

  test("a value can only be stored on a row the caller's own sheet shows", () => {
    /*
     * Two EXISTS, both inside the statement. The column must be the caller's, and the PO must be
     * one of the caller's own rows - the same predicate the sheet selects on. Without the second,
     * a client could annotate a PO its sheet does not show and never will: nothing would be
     * visible, and the notes would be keyed to another PM's work.
     */
    for (const sql of [
      WorkspaceCellWriteOps("7", "3", "11", "메모").sql,
      WorkspaceCellClearOps("7", "3", "11").sql,
    ]) {
      for (const fragment of OWNERSHIP) {
        expect(sql).toContain(fragment);
      }
    }
  });

  test("a save is an upsert, keyed by the pair", () => {
    // The composite primary key IS the "one value per column per row" rule, so the write needs no
    // read first - and two tabs saving the same cell cannot produce two rows.
    const sql = WorkspaceCellWriteOps("7", "3", "11", "메모").sql;
    expect(sql).toContain("ON CONFLICT (column_id, po_id) DO UPDATE");
    expect(sql).toContain("cell_text  = EXCLUDED.cell_text");
  });

  test("an emptied cell is deleted rather than stored as an empty string", () => {
    /*
     * The sheet reads an absent key and an empty string identically, so storing the empty one
     * would be invisible on screen while keeping a row for every cell anybody has ever typed into
     * and then cleared. The manager is what chooses between the two statements.
     */
    expect(WorkspaceCellClearOps("7", "3", "11").sql).toContain("DELETE FROM workspace_cell");
    expect(code(manager())).toContain("value.length === 0");
    expect(code(manager())).toContain("WorkspaceCellClearOps");
  });
});

describe("나의 업무 — what the sheet must not become", () => {
  test("no statement in the workspace writes a job, a project or a purchase order", () => {
    /*
     * The decision this feature rests on. Editing one of the sheet's fourteen fixed columns is a
     * PATCH to /jobs/{id} or /purchase-orders/{id}, sent by the browser to the endpoint the forms
     * already use. A sheet-only write path would have to re-implement the row scope on each table,
     * the derived name columns, the approval and settlement locks, the job-type constraint and the
     * error translation for all of it - five rules that exist, each gaining a second opinion.
     *
     * Asserted as "this module writes only its own two tables", which is the form that keeps being
     * true as the feature grows.
     */
    const sql = code(dbops());
    for (const forbidden of [
      "UPDATE job",
      "UPDATE project",
      "UPDATE purchase_order",
      "INSERT INTO job",
      "INSERT INTO project",
      "INSERT INTO purchase_order",
      "DELETE FROM job",
      "DELETE FROM project",
      "DELETE FROM purchase_order",
    ]) {
      expect(sql).not.toContain(forbidden);
    }
    for (const own of ["INSERT INTO workspace_column", "INSERT INTO workspace_cell"]) {
      expect(sql).toContain(own);
    }

    // And the manager reaches for no other domain's write ops.
    const managerCode = code(manager());
    expect(managerCode).not.toMatch(/JobUpdateOps|PurchaseOrderUpdateOps|ProjectUpdateOps/);
  });

});

describe("a PATCH that names no column on the parent table", () => {
  /*
   * The bug that reached production, and the class it belongs to.
   *
   * `SET ${fields.fragment}, updated_at = now()` is wrong whenever the request names no column on
   * the table being updated - and that is ordinary, not exotic: `job_slang`, `job_volume`,
   * `po_slang` and `po_volume` live in the detail tables, so a PATCH of only the source language
   * contributes nothing to `job`. The statement becomes `SET , updated_at = now()`, PostgreSQL
   * answers 42601, and the API reports a 500 "Failed to execute statement".
   *
   * It survived every test and every screen because FORMS SEND EVERY FIELD. The 나의 업무 sheet is
   * the first client that sends one field at a time, and it broke on exactly three of its fourteen
   * columns - 출발어, 도착어 and 분량 - while the other eleven worked, which is why the report was
   * "I cannot update anything from the sheet" rather than anything more specific.
   *
   * So this is asserted for EVERY update op rather than for the two that were reported: each is
   * handed a body naming only fields it does not own, and the SET it produces must still be valid.
   */
  const EMPTY_BODY_OPS: { name: string; sql: string }[] = [
    {
      name: "job (body: jobSlang, a detail column)",
      sql: JobUpdateOps(CALLER, "1", { jobSlang: "영어" }, CTX).sql,
    },
    {
      name: "purchase order (body: poVolume, a detail column)",
      sql: PoUpdateOps(CALLER, "1", { poVolume: "1200" }, CTX).sql,
    },
    {
      name: "project (body: {})",
      sql: ProjectUpdateOps(CALLER, "1", {}, CTX).sql,
    },
    {
      name: "customer (body: {})",
      sql: CustomerUpdateOps("1", {}, CTX).sql,
    },
    {
      name: "translator (body: {})",
      sql: TranslatorUpdateOps("1", {}, CTX).sql,
    },
    {
      name: "staff (body: {})",
      sql: StaffAdminUpdateOps("1", {}).sql,
    },
    {
      name: "role (body: {})",
      sql: RoleUpdateOps("1", {}).sql,
    },
  ];

  for (const { name, sql } of EMPTY_BODY_OPS) {
    test(`${name} still emits a valid SET`, () => {
      // The exact shape of the defect: a comma with nothing before it.
      expect(sql).not.toMatch(/SET\s*,/);
      // And its sibling: a SET with nothing at all after it.
      expect(sql).not.toMatch(/SET\s*(FROM|WHERE|RETURNING)\b/);
      // What a body of only detail columns should leave behind: the audit stamp, so the parent row
      // records that it changed. Returning the row is what lets the caller re-read it.
      expect(sql).toMatch(/SET\s+updated_at = now\(\)/);
    });
  }

  test("every update op builds its SET through the one helper", () => {
    /*
     * The fix is only a fix while it is the only way the clause is built. Asserted as "no module
     * interpolates `fields.fragment` into a SET by hand", because that is the shape that was
     * wrong in eight places at once and read correctly in all of them.
     */
    const dbopsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "lambdas",
      "neotms",
      "nodejs",
      "neotms",
    );
    const offenders: string[] = [];
    for (const file of walkTsFiles(dbopsDir)) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("updateFragments(")) continue;
      if (/SET \$\{fields\.fragment\}/.test(source) || /SET \$\{\[fields\.fragment/.test(source)) {
        offenders.push(path.basename(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("나의 업무 — layout and styling", () => {
  const schema = () => repoFile("db", "001_schemas.sql");
  const migration = () => repoFile("db", "007_workspace_styles.sql");

  test("a colour is checked as a colour, in the schema and in both migrations", () => {
    /*
     * These strings end up in a browser's style attribute. The API refuses anything that is not
     * `#rrggbb`, and so does the database - in both places, because they fail differently and both
     * failures matter: the schema's CHECK is what holds if a future endpoint forgets to validate,
     * and the request schema is what produces a 400 that says what a colour looks like rather than
     * a 23514 naming a constraint.
     */
    for (const sql of [schema(), migration()]) {
      expect(sql).toContain("^#[0-9a-fA-F]{6}$");
      expect(sql).toContain("text_size IS NULL OR text_size BETWEEN 8 AND 24");
    }
    const schemas = repoFile("lambdas", "neotms", "nodejs", "neotms", "neotms.schemas.ts");
    expect(schemas).toContain("/^#[0-9a-fA-F]{6}$/");
  });

  test("a fixed column and a custom one cannot be confused, and cannot collide", () => {
    /*
     * The identity CHECK is what makes `col_key` safe to add to a table that already held custom
     * columns: exactly one of the two identities, so a custom column cannot lose its label and a
     * fixed one cannot acquire a competing copy of the UI's word.
     */
    for (const sql of [schema(), migration()]) {
      expect(sql).toContain("CHECK ((col_key IS NULL) <> (col_label IS NULL))");
      expect(sql).toContain("UNIQUE (staff_id, col_key)");
    }
  });

  test("the layout upserts fixed columns and only updates custom ones", () => {
    /*
     * Asymmetric on purpose. A fixed column may have no row yet - this is where the fourteen
     * acquire one - while a custom column's row IS the column, and creating one from a layout
     * request would mean inventing a column with no label, which the identity CHECK refuses and
     * which would appear in the sheet as a blank heading.
     */
    const fixed = WorkspaceLayoutFixedOps("7", ["poEday"], ["0"], ["120"]).sql;
    expect(fixed).toContain("INSERT INTO workspace_column");
    expect(fixed).toContain("ON CONFLICT (staff_id, col_key) DO UPDATE");
    // No label is written for a fixed column: the UI owns that word.
    expect(fixed).not.toContain("col_label");

    const custom = WorkspaceLayoutCustomOps("7", ["101"], ["0"], ["150"]).sql;
    expect(custom).toContain("UPDATE workspace_column");
    expect(custom).not.toContain("INSERT");
    expect(custom).toContain("c.staff_id = :staff_id");
  });

  test("styling a cell is guarded by the same two predicates as writing one", () => {
    /*
     * A style is as much a write as a value is. One selection can span columns and rows, so the
     * predicates are per-pair: a single bad id drops that pair rather than refusing the request or
     * - far worse - writing the whole selection.
     */
    const sql = WorkspaceCellStyleOps("7", ["101"], ["11"], { bgColor: "#FFF2CC" }).sql;
    expect(sql).toContain("wc.staff_id = :staff_id");
    expect(sql).toContain("pr.prj_pm_id = :staff_id");
    expect(sql).toContain("pr.acceptance_status = 1");
    expect(sql).toContain("ON CONFLICT (column_id, po_id) DO UPDATE");

    const rowSql = WorkspaceRowStyleOps("7", ["11"], { bgColor: "#FFF2CC" }).sql;
    expect(rowSql).toContain("pr.prj_pm_id = :staff_id");
    expect(rowSql).toContain("ON CONFLICT (staff_id, po_id) DO UPDATE");
  });

  test("a patch writes only the properties it names", () => {
    /*
     * The whole user interface of a toolbar rests on this. "Make this yellow" must not clear the
     * bold somebody set last week, so an absent property contributes no column; "clear formatting"
     * has to be sayable, so a null one does.
     */
    const one = WorkspaceCellStyleOps("7", ["101"], ["11"], { bgColor: "#FFF2CC" }).sql;
    expect(one).toContain("bg_color");
    expect(one).not.toContain("text_color");
    expect(one).not.toContain("bold");

    const all = WorkspaceCellStyleOps("7", ["101"], ["11"], {
      bgColor: null,
      textColor: null,
      textSize: null,
      bold: null,
    }).sql;
    for (const column of ["bg_color", "text_color", "text_size", "bold"]) {
      expect(all).toContain(column);
    }
  });

  test("a row that says nothing is deleted, and only then", () => {
    /*
     * Before styling, clearing a cell deleted its row and that was the rule. A row can now survive
     * a cleared value because it carries a colour, and survive cleared colours because it carries
     * a value - so the condition is "all five are null", which is the only state in which the row
     * means nothing to anybody.
     */
    const prune = WorkspaceCellPruneOps("7").sql;
    for (const column of ["cell_text", "bg_color", "text_color", "text_size", "bold"]) {
      expect(prune).toContain(`wc.${column} IS NULL`);
    }
    expect(prune).toContain("c.staff_id = :staff_id");

    /*
     * The column prune is narrower: only FIXED columns. A custom column's row is the column
     * itself, so an unstyled, unplaced one must survive - deleting it would delete somebody's
     * column because they dragged it back where it started.
     */
    const columnPrune = WorkspaceColumnPruneOps("7").sql;
    expect(columnPrune).toContain("c.col_key IS NOT NULL");
    expect(columnPrune).toContain("NOT EXISTS (SELECT 1 FROM workspace_cell");
  });

  test("the read no longer requires a value to see a style", () => {
    /*
     * The filter that used to be right and is now wrong. A row may exist for style alone, on a
     * fixed column whose value lives in the job or the PO; requiring text would hide exactly
     * those - which is every styled cell in thirteen of the fourteen fixed columns.
     */
    const styles = SHEET.slice(SHEET.indexOf("jsonb_build_object"));
    expect(styles).toContain("wc.bg_color IS NOT NULL");
    expect(styles).not.toContain("wc.cell_text IS NOT NULL");
  });

});

describe("the modules load at all", () => {
  test("every style column is spelled the same in the SQL and in the writable fields", () => {
    /*
     * Two lists that must agree, kept apart on purpose: the SQL list is read when the module
     * LOADS (it builds the sheet's aggregates), and the field list belongs beside the writes.
     * Deriving one from the other is what put a `const` below its own first use and made this
     * module throw `Cannot access 'STYLE_COLUMNS' before initialization` on import - which takes
     * down every endpoint in the API, and which TypeScript accepts without complaint because the
     * use sits inside an arrow function.
     *
     * So they are two literals, and this is what stops them drifting. The import at the top of
     * this file is itself the other half of the guard: a module that cannot load fails here
     * rather than in production.
     */
    const source = dbops();
    const sqlList = /const STYLE_COLUMNS = \[([\s\S]*?)\] as const;/.exec(source);
    expect(sqlList).not.toBeNull();
    const fieldList = /const STYLE_FIELDS[\s\S]*?\n\];/.exec(source);
    expect(fieldList).not.toBeNull();

    const inSql = [...sqlList![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const inFields = [...fieldList![0].matchAll(/column: "([a-z_]+)"/g)].map((m) => m[1]);
    expect(inSql).toEqual(inFields);
    expect(inSql).toHaveLength(8);
  });

  test("the sheet statement is built without touching anything undeclared", () => {
    // Building it here is the assertion: the module-level template literals run on import, and
    // the statement below forces the rest.
    expect(SHEET).toContain("cell_styles");
    expect(SHEET).toContain("'a', wc.text_align");
    expect(SHEET).toContain("rs.text_align AS row_text_align");
  });
});
