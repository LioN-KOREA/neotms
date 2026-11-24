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

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_SORTS,
  WorkspaceCellClearOps,
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

/**
 * The default column table, read out of the frontend source as text.
 *
 * Read rather than imported, because that module imports through the console's `@/` alias, which
 * the backend's tsconfig does not resolve - importing it would pull the whole frontend into the
 * backend typecheck. Every other frontend assertion in this repository is a text assertion, for
 * this same reason.
 */
const defaultColumns = (): { key: string; label: string; source: string; kind: string }[] => {
  const source = repoFile("frontend", "src", "features", "workspace", "workspaceColumns.ts");
  const entries = [
    ...source.matchAll(
      /\{ key: '(\w+)', label: '([^']+)', width: \d+, source: '(\w+)', kind: '(\w+)' \}/g,
    ),
  ];
  // Fourteen, by specification. A zero here would make every assertion below vacuously true.
  expect(entries).toHaveLength(14);
  return entries.map((m) => ({ key: m[1]!, label: m[2]!, source: m[3]!, kind: m[4]! }));
};

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
    expect(SHEET).not.toContain(" OR ");
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

  test("the sheet's fourteen default columns are the ones that were specified, in order", () => {
    /*
     * The list is a requirement, and it is used three times in the grid - headers, cells, widths.
     * Pinned here as names and order so that a column cannot be dropped, renamed or reordered
     * without this test saying so; the grid builds all three from this one array, which is the
     * other half of the guard (a second hardcoded list is how values come to be drawn one column
     * to the left of their heading).
     */
    expect(defaultColumns().map((c) => c.label)).toEqual([
      "인계일",
      "프로젝트코드",
      "JOB코드",
      "PO코드",
      "고객사",
      "고객사담당자",
      "영업담당",
      "프로젝트종류",
      "출발어",
      "도착어",
      "번역가",
      "분량",
      "납품일",
      "진행상태",
    ]);

    const gridSource = code(
      repoFile("frontend", "src", "features", "workspace", "WorkspaceGrid.tsx"),
    );
    // Columns, headers and cells: three uses of the one array, and no fourth list anywhere.
    expect((gridSource.match(/DEFAULT_COLUMNS\.map/g) ?? []).length).toBe(3);
  });

  test("project-level columns are read-only, and the editable ones say what they write", () => {
    /*
     * 고객사, 고객사담당자, 영업담당, 프로젝트종류 and 인계일 are facts about the PROJECT, so one
     * cell edit would change every row of that project. 고객사 is worse than untidy: changing it
     * moves booked revenue to another customer, which this codebase already refuses to do from a
     * job. Those edits belong on the project screen.
     *
     * 인계일 is read-only for a different reason - it is the timestamp of an event
     * (`project_acceptance`), so editing it means rewriting a record of what happened.
     */
    const columns = defaultColumns();
    const sourceOf = (label: string) => columns.find((c) => c.label === label)?.source;
    for (const label of ["인계일", "고객사", "고객사담당자", "영업담당", "프로젝트종류"]) {
      expect(sourceOf(label)).toBe("readonly");
    }
    // The system-minted codes, which nothing may edit anywhere.
    for (const label of ["프로젝트코드", "JOB코드", "PO코드"]) {
      expect(sourceOf(label)).toBe("readonly");
    }
    // 출발어·도착어 change the JOB, as specified. The PO carries its own independent pair, which
    // this sheet deliberately does not show - one cell writing one of two tables, invisibly, is
    // worse than one of them being absent.
    expect(sourceOf("출발어")).toBe("job");
    expect(sourceOf("도착어")).toBe("job");
    // And these four are the row's own PO.
    for (const label of ["번역가", "분량", "납품일", "진행상태"]) {
      expect(sourceOf(label)).toBe("po");
    }
  });

  test("the translator cell opens the dialog the PO screens use", () => {
    /*
     * Not a dropdown. The candidate list exceeds one page from the server, so a dropdown would be
     * silently truncated - and a truncated list reads as "that translator does not exist", after
     * which somebody registers a second row for a translator who is already there.
     *
     * Reusing `TranslatorSwapModal` also carries its locks: an approved PO's translator is a
     * person an approval record names, and a settled one is a person money went to.
     */
    const grid = code(repoFile("frontend", "src", "features", "workspace", "WorkspaceGrid.tsx"));
    expect(grid).toContain("mayChangeTranslator(row)");
    expect(grid).toContain("translatorLockReason(row)");
    expect(grid).not.toMatch(/useTranslators/);
  });

  test("picking from a dropdown is not swallowed by the open/close handling", () => {
    /*
     * The defect a browser found and no unit test could have.
     *
     * ReactGrid sends ONE change when an option is picked, and that change carries both the new
     * `selectedValue` and `isOpen` going true -> false. Written as either/or - "if the open state
     * moved, handle that and move on" - the open/close branch swallows every selection: the list
     * closes, the cell keeps its old value, and nothing errors. On screen it reads as "the
     * language dropdown does not work", which is a report nobody can act on from the source.
     *
     * Pinned as the shape of the code rather than as behaviour, because the behaviour needs a
     * rendered grid: the open/close handling must be followed by reading the value, with no
     * `continue` between them.
     */
    const grid = code(repoFile("frontend", "src", "features", "workspace", "WorkspaceGrid.tsx"));
    expect(grid).toMatch(
      /setOpenDropdown\(next\.isOpen[^\n]*\n\s*\}\n\s*const value = next\.selectedValue/,
    );
  });

  test("the date cell uses this application's own parser, not a native date input", () => {
    /*
     * ReactGrid ships a `date` cell and it is an `<input type="date">`, which this application
     * abandoned for three stated reasons - six keystrokes becoming ten, no weekday, and pasted
     * dates being refused (`DateField`). Using it here would reintroduce all three in the one
     * screen where dates are typed fastest.
     *
     * `parseDateField` also refuses to "correct" 2026-02-30 into March, which is the behaviour
     * that matters: a date nobody typed must not be saved as though they had.
     */
    const grid = code(repoFile("frontend", "src", "features", "workspace", "WorkspaceGrid.tsx"));
    expect(grid).toContain("parseDateField(value)");
    expect(grid).toContain("formatDateField(text)");
    expect(grid).not.toMatch(/type: 'date'/);
  });
});
