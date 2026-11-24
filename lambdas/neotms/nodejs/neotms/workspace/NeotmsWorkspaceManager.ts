// SPDX-License-Identifier: MIT
//
// 나의 업무 - the endpoints behind one PM's worksheet.
//
// ## Nothing here writes a job, a project or a purchase order
//
// The sheet's fourteen fixed columns are editable, and every one of those edits goes out through
// `PATCH /api/v0/jobs/{id}` or `PATCH /api/v0/purchase-orders/{id}` - the same endpoints the forms
// use, from the browser, one cell at a time. That is the single most important decision in this
// feature and it is a decision about what NOT to build.
//
// A `PUT /workspace/rows/{id}` taking a mixed bag of project, job and PO fields would have been one
// request per edit instead of one, and would have had to re-implement: the row scope on each table,
// the derived name columns (`po_tran_name` is looked up from the id, never taken from the body), the
// approval and settlement locks on a PO's translator, the job-type constraint that forbids a
// language pair on a MICE job, and the 23514/23503 translations for all of it. Every one of those
// is a rule that already exists and that a second write path would hold a second, drifting opinion
// about. The grid is a spreadsheet over the existing API, not a second API.
//
// So what is left here is exactly the part that has no home yet: the caller's own columns, and the
// values in them.
//
// ## Every statement is scoped by identity, not by view scope
//
// `staff.view_scope` answers "which rows" for company data. It has no bearing on this screen: 나의
// 업무 is first-person, so a superuser gets their own sheet and not everybody's, and the custom
// columns belong to one person by definition. `NeotmsWorkspace.dbops`'s header has the full
// argument for why the sheet needs no `scopeClause`.

import { paginate, pgExecute, pgQuery, pgTransaction } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { readListQuery, sortAlias } from "../NeotmsQuery.js";
import { badRequest, notFound, ok, runDb, type ListPage } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import type {
  WorkspaceCellWrite,
  WorkspaceColumnInput,
  WorkspaceColumnOrder,
  WorkspaceLayoutInput,
  WorkspaceStyleInput,
} from "../neotms.schemas.js";
import {
  WORKSPACE_SORTS,
  WorkspaceCellClearOps,
  WorkspaceCellPruneOps,
  WorkspaceCellStyleOps,
  WorkspaceCellWriteOps,
  WorkspaceColumnCreateOps,
  WorkspaceColumnDeleteOps,
  WorkspaceColumnEnsureOps,
  WorkspaceColumnOrderOps,
  WorkspaceColumnPruneOps,
  WorkspaceColumnRenameOps,
  WorkspaceColumnStyleOps,
  WorkspaceColumnsOps,
  WorkspaceLayoutCustomOps,
  WorkspaceLayoutFixedOps,
  WorkspaceRowStyleOps,
  WorkspaceRowStylePruneOps,
  WorkspaceSheetOps,
  WorkspaceUnplacedJobsOps,
  isEmptyStylePatch,
  toWorkspaceRow,
  type WorkspaceColumn,
  type WorkspaceRow,
} from "./NeotmsWorkspace.dbops.js";

/**
 * How many custom columns one person may have.
 *
 * A ceiling rather than none, because every column is a key in the jsonb object built per row of
 * the sheet, so the read cost of the whole screen scales with this number. Thirty is far past what
 * anybody has asked for and still small enough that the sheet stays a sheet; the failure it
 * prevents is somebody pasting a hundred headings in and then reporting that 나의 업무 is slow.
 */
export const WORKSPACE_COLUMN_LIMIT = 30;

/**
 * The sheet, plus the caller's column definitions and the count of what it is not showing.
 *
 * Shaped as a `ListPage` with two extra fields rather than as a wrapper object, so the browser's
 * infinite-scroll query can read `items` and `nextCursor` where it reads them on every other list.
 */
export type WorkspaceView = ListPage<WorkspaceRow> & {
  columns: WorkspaceColumn[];
  /**
   * Jobs of the caller's accepted projects that have no live PO, and therefore no row.
   *
   * The sheet is one row per PO by specification. This is what keeps that from being a silent
   * omission - see the dbops header.
   */
  unplacedJobs: number;
};

/**
 * Open the sheet, or fetch another page of it.
 *
 * The default sort is the deadline, ascending. Every other list in this application defaults to
 * newest-first, and this one does not on purpose: the sheet is a work queue, and a queue is read
 * from the end that is due next.
 *
 * The column definitions and the unplaced count are re-read on every page, including 더 보기. Two
 * indexed reads of a few dozen rows is the price; the alternatives were worse in a way that
 * matters more - a separate `/workspace/columns` endpoint means two round trips to open the screen
 * and a second cache entry that can disagree with the rows about which columns exist, which shows
 * up as values landing in the wrong column.
 */
export async function getWorkspace(
  caller: NeotmsCaller,
  request: RequestData,
): Promise<ResponseData<WorkspaceView | string>> {
  const query = readListQuery(request, WORKSPACE_SORTS, "due", "asc");
  return runDb("read workspace", async () => {
    const rows = (await pgQuery(WorkspaceSheetOps(caller.staffId, query))).data;
    const page = paginate(
      rows,
      query.limit,
      sortAlias(query.sort.column),
      "po_id",
      toWorkspaceRow,
    );
    const columns = (await pgQuery(WorkspaceColumnsOps(caller.staffId))).data;
    const unplacedJobs = (await pgQuery(WorkspaceUnplacedJobsOps(caller.staffId))).data;
    return ok({ ...page, columns, unplacedJobs });
  });
}

/**
 * Add a column to the caller's own sheet.
 *
 * The count is read first and refused past the limit. Reading then writing is not a race worth
 * guarding with a transaction here: two tabs adding a thirtieth column at the same moment produce
 * thirty-one, which is a cosmetic overshoot of a number chosen for comfort rather than a rule
 * anything depends on.
 */
export async function createWorkspaceColumn(
  caller: NeotmsCaller,
  input: WorkspaceColumnInput,
  ctx: WriteContext,
): Promise<ResponseData<WorkspaceColumn | string>> {
  return runDb("create workspace column", async () => {
    const existing = (await pgQuery(WorkspaceColumnsOps(caller.staffId))).data;
    if (existing.length >= WORKSPACE_COLUMN_LIMIT) {
      return badRequest(
        `추가 열은 최대 ${String(WORKSPACE_COLUMN_LIMIT)}개까지 만들 수 있습니다. ` +
          "쓰지 않는 열을 먼저 삭제해 주세요.",
      );
    }
    const column = (
      await pgExecute(WorkspaceColumnCreateOps(caller.staffId, input.label, ctx.actor, ctx.ip))
    ).data;
    return column ? ok(column) : badRequest("열을 만들지 못했습니다.");
  });
}

/**
 * Rename one of the caller's own columns.
 *
 * 404 rather than 403 when the id is somebody else's. The statement's own `staff_id` predicate is
 * what refuses it, so this code cannot tell "no such column" from "not yours" - and should not: a
 * 403 would confirm that the id exists to somebody who has no business knowing.
 */
export async function renameWorkspaceColumn(
  caller: NeotmsCaller,
  id: string,
  input: WorkspaceColumnInput,
): Promise<ResponseData<WorkspaceColumn | string>> {
  return runDb("rename workspace column", async () => {
    const column = (await pgExecute(WorkspaceColumnRenameOps(caller.staffId, id, input.label))).data;
    return column ? ok(column) : notFound("column");
  });
}

/** Delete a column and every value in it. The screen asks first; see the ops comment. */
export async function deleteWorkspaceColumn(
  caller: NeotmsCaller,
  id: string,
): Promise<ResponseData<{ deleted: boolean } | string>> {
  return runDb("delete workspace column", async () => {
    const count = (await pgExecute(WorkspaceColumnDeleteOps(caller.staffId, id))).data;
    return count > 0 ? ok({ deleted: true }) : notFound("column");
  });
}

/**
 * Reorder the caller's columns from a complete list of ids.
 *
 * Complete, and checked to be: a partial list would leave the columns it omits at their old
 * positions, which is not "no change" but an order nobody asked for - the omitted column lands
 * wherever its stale number puts it, usually in the middle of the ones that moved.
 *
 * So the list is compared against what the caller actually has, as a set, and a mismatch is
 * refused rather than half-applied. The comparison is on sorted ids because order is the thing
 * being sent.
 */
export async function reorderWorkspaceColumns(
  caller: NeotmsCaller,
  input: WorkspaceColumnOrder,
): Promise<ResponseData<WorkspaceColumn[] | string>> {
  return runDb("reorder workspace columns", async () => {
    const existing = (await pgQuery(WorkspaceColumnsOps(caller.staffId))).data;
    const mine = existing.map((column) => column.id).sort();
    const sent = [...new Set(input.columnIds)].sort();
    if (mine.length !== sent.length || mine.some((id, i) => id !== sent[i])) {
      return badRequest(
        "`columnIds` must list every one of the caller's columns exactly once. " +
          "A partial order would leave the columns it omits at their old positions.",
      );
    }
    await pgExecute(WorkspaceColumnOrderOps(caller.staffId, input.columnIds));
    return ok((await pgQuery(WorkspaceColumnsOps(caller.staffId))).data);
  });
}

/**
 * Write one cell, or clear it.
 *
 * An empty value deletes the row rather than storing `""`; the sheet cannot tell the two apart, so
 * storing the empty one would only keep a row per cell anybody has ever typed into and emptied.
 *
 * Both paths answer 404 on zero rows affected, and the reason is in `CELL_OWNERSHIP`: the column
 * must be the caller's and the PO must be one the caller's own sheet shows. Those two predicates
 * are the authorization for this write, and they are inside the statement.
 */
export async function writeWorkspaceCell(
  caller: NeotmsCaller,
  input: WorkspaceCellWrite,
): Promise<ResponseData<{ saved: boolean } | string>> {
  const value = input.value.trim();
  return runDb("write workspace cell", async () => {
    const ops =
      value.length === 0
        ? WorkspaceCellClearOps(caller.staffId, input.columnId, input.poId)
        : WorkspaceCellWriteOps(caller.staffId, input.columnId, input.poId, value);
    const count = (await pgExecute(ops)).data;
    /*
     * A cleared cell that was already empty affects zero rows and is NOT an error - the sheet is
     * allowed to send "this is empty now" for a cell that never had a value, which happens whenever
     * somebody tabs through a column. Only a write that stored nothing means the ids were refused.
     */
    if (count === 0 && value.length > 0) return notFound("cell");
    /*
     * Clearing a value no longer deletes the row, because the row may be carrying a colour. So the
     * prune runs afterwards and removes only what says nothing at all - no text and no style.
     * Before styling existed this was the DELETE itself.
     */
    if (value.length === 0) await pgExecute(WorkspaceCellPruneOps(caller.staffId));
    return ok({ saved: true });
  });
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Record where the columns now sit and how wide they are.
 *
 * The request carries the COMPLETE layout - all fourteen fixed columns and every custom one - for
 * the reason the reorder endpoint already did: a partial list leaves the columns it omits at stale
 * positions, which is not "unchanged" but "somewhere in the middle of the ones that moved".
 *
 * Two statements rather than one, because the two halves are different operations. A fixed column
 * may need its row CREATED (this is where the built-in columns acquire rows at all), while a custom
 * column's row must already exist - creating one here would mean inventing a column with no label,
 * which the identity CHECK refuses and which would appear in the sheet as a blank heading.
 *
 * Then a prune: a fixed column dragged back to where it started, at its original width and with no
 * style, has a row that says nothing, and the absence of a row says exactly the same thing more
 * cheaply.
 */
export async function setWorkspaceLayout(
  caller: NeotmsCaller,
  input: WorkspaceLayoutInput,
): Promise<ResponseData<WorkspaceColumn[] | string>> {
  const fixed = input.columns.filter((c) => c.key !== undefined && c.key !== null);
  const custom = input.columns.filter((c) => c.id !== undefined && c.id !== null);
  if (fixed.length + custom.length !== input.columns.length) {
    return badRequest("Every column in a layout must carry exactly one of `key` or `id`.");
  }

  return runDb("set workspace layout", async () => {
    await pgTransaction(async (client) => {
      if (fixed.length > 0) {
        await pgExecute(
          WorkspaceLayoutFixedOps(
            caller.staffId,
            fixed.map((c) => String(c.key)),
            fixed.map((c) => String(c.ordNo)),
            fixed.map((c) => String(c.width)),
          ),
          client,
        );
      }
      if (custom.length > 0) {
        await pgExecute(
          WorkspaceLayoutCustomOps(
            caller.staffId,
            custom.map((c) => String(c.id)),
            custom.map((c) => String(c.ordNo)),
            custom.map((c) => String(c.width)),
          ),
          client,
        );
      }
      await pgExecute(WorkspaceColumnPruneOps(caller.staffId), client);
    });
    return ok((await pgQuery(WorkspaceColumnsOps(caller.staffId))).data);
  });
}

/* -------------------------------------------------------------------------- */
/* Styling                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Apply one style to a selection of cells, columns and rows.
 *
 * ## One request for the whole selection
 *
 * A toolbar acts on what is selected, and a selection in a spreadsheet is routinely a block -
 * fifty cells, or three columns. One request per cell would be fifty requests, fifty chances to
 * fail halfway, and a sheet that ends up half yellow with no way to tell which half.
 *
 * ## The patch is a patch
 *
 * A property the request omits is left alone and one sent as null is cleared. "Make this yellow"
 * must not clear the bold somebody set last week, and "clear formatting" has to be sayable: it is
 * all four, all null. An entirely empty patch is refused - it would be a request that means
 * nothing, and answering 200 to it would hide a client bug.
 *
 * ## Fixed columns get their rows here too
 *
 * Styling a cell of 납품일 needs a `column_id` and that column may have no row yet, so the ensure
 * runs first, in the same transaction. Its result is also how a fixed key becomes an id for the
 * column-level writes.
 */
export async function setWorkspaceStyles(
  caller: NeotmsCaller,
  input: WorkspaceStyleInput,
): Promise<ResponseData<{ styled: number; columns: WorkspaceColumn[] } | string>> {
  if (isEmptyStylePatch(input.style)) {
    return badRequest(
      "`style` must name at least one of bgColor, textColor, textSize or bold. " +
        "Send a property as null to clear it.",
    );
  }
  const targets =
    input.cells.length + input.columns.length + input.rows.length;
  if (targets === 0) {
    return badRequest("A style needs somewhere to go: name cells, columns or rows.");
  }
  for (const ref of [...input.cells, ...input.columns]) {
    const named = (ref.key ? 1 : 0) + (ref.id ? 1 : 0);
    if (named !== 1) {
      return badRequest("Every column reference must carry exactly one of `key` or `id`.");
    }
  }

  return runDb("set workspace styles", async () => {
    const styled = await pgTransaction(async (client) => {
      /*
       * Every fixed column named anywhere in the request, cells included. Done once for the whole
       * request rather than per target, so a selection spanning forty cells of 납품일 ensures one
       * row rather than forty times over.
       */
      const keys = [
        ...new Set(
          [...input.cells, ...input.columns]
            .map((ref) => ref.key)
            .filter((key): key is string => typeof key === "string" && key.length > 0),
        ),
      ];
      const idByKey = new Map<string, string>();
      if (keys.length > 0) {
        const ensured = (await pgExecute(WorkspaceColumnEnsureOps(caller.staffId, keys), client))
          .data;
        for (const row of ensured) idByKey.set(row.key, row.id);
      }

      /** A reference to a column id, or null when a fixed key could not be resolved. */
      const idOf = (ref: { key?: string | null; id?: string | null }): string | null =>
        ref.id ? ref.id : ref.key ? (idByKey.get(ref.key) ?? null) : null;

      let count = 0;

      const columnIds = input.columns.map(idOf).filter((id): id is string => id !== null);
      if (columnIds.length > 0) {
        count += (
          await pgExecute(WorkspaceColumnStyleOps(caller.staffId, columnIds, input.style), client)
        ).data;
      }

      const cellPairs = input.cells
        .map((ref) => ({ columnId: idOf(ref), poId: ref.poId }))
        .filter((pair): pair is { columnId: string; poId: string } => pair.columnId !== null);
      if (cellPairs.length > 0) {
        count += (
          await pgExecute(
            WorkspaceCellStyleOps(
              caller.staffId,
              cellPairs.map((p) => p.columnId),
              cellPairs.map((p) => p.poId),
              input.style,
            ),
            client,
          )
        ).data;
      }

      if (input.rows.length > 0) {
        count += (
          await pgExecute(WorkspaceRowStyleOps(caller.staffId, input.rows, input.style), client)
        ).data;
      }

      /*
       * "Clear formatting" writes four nulls, which leaves rows that exist for nothing. Pruning
       * here rather than leaving them is not tidiness: a cleared cell row keeps its (column, PO)
       * pair alive, and a cleared FIXED column row would keep that column in the layout with no
       * settings on it, which the reader of the table would take for a deliberate placement.
       */
      await pgExecute(WorkspaceCellPruneOps(caller.staffId), client);
      await pgExecute(WorkspaceRowStylePruneOps(caller.staffId), client);
      await pgExecute(WorkspaceColumnPruneOps(caller.staffId), client);
      return count;
    });
    /*
     * The columns come back with the answer, and that is what lets the sheet show a colour the
     * instant it is applied.
     *
     * Two of them need it. A column style is ON one of these rows, so the browser cannot draw it
     * without them; and a cell style in a FIXED column needs that column's row ID, which may have
     * been created by this very request - the browser has no way to know it otherwise, and would
     * have to re-read all 200 rows to find out. Returning them turns a refetch into a merge.
     */
    return ok({ styled, columns: (await pgQuery(WorkspaceColumnsOps(caller.staffId))).data });
  });
}
