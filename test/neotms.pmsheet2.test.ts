/**
 * The 2026-11-25 PM sheet rework: row-slot editing (add, delete, merge,
 * ungroup), column names, moving 납품일 by one day, changed-cell
 * highlighting (db/012) and re-handover.
 */
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySlots,
  columnLetter,
  insertSlots,
  placeAfter,
  removeSlots,
  shiftYmd,
  slotsOf,
} from "../frontend/src/features/pmsheet/freeRows";
import { seenDiff, sheetSnapshot, type PmSheetRow } from "../lambdas/neotms/nodejs/neotms/pmsheet/NeotmsPmSheet.dbops";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");

describe("sheet slots: insert, delete, merge and unmerge move rows, never overwrite them", () => {
  const posOf = new Map([
    ["a", 0],
    ["b", 2],
    ["c", 3],
  ]);
  const free = [{ pos: 1, values: { remark: "memo" } }];

  it("lists every slot from the stored positions", () => {
    expect(slotsOf(posOf, free)).toEqual(["a", "f:1", "b", "c"]);
  });

  it("inserting a blank row pushes everything below down, written blank rows included", () => {
    const r = applySlots(insertSlots(slotsOf(posOf, free), 1), free);
    expect([...r.jobPos]).toEqual([["a", 0], ["b", 3], ["c", 4]]);
    expect(r.freeRows).toEqual([{ pos: 2, values: { remark: "memo" } }]);
  });

  it("deleting a blank row pulls the rows below up", () => {
    const r = applySlots(removeSlots(slotsOf(posOf, free), ["f:1"]), free);
    expect([...r.jobPos]).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(r.freeRows).toEqual([]);
  });

  it("merging removes the merged rows' slots so no gap is left", () => {
    const r = applySlots(removeSlots(slotsOf(posOf, free), ["b"]), free);
    expect([...r.jobPos]).toEqual([["a", 0], ["c", 2]]);
  });

  it("unmerging puts the members right under the head and shifts the rest down", () => {
    const order = placeAfter(slotsOf(posOf, free), "a", ["m1", "m2"]);
    expect(order).toEqual(["a", "m1", "m2", "f:1", "b", "c"]);
    const r = applySlots(order, free);
    expect(r.jobPos.get("c")).toBe(5);
    expect(r.freeRows).toEqual([{ pos: 3, values: { remark: "memo" } }]);
  });
});

describe("column letters and the delivery-date step", () => {
  it("names columns like a spreadsheet", () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(columnLetter)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
  });
  it("moves a date by whole days across months and years", () => {
    expect(shiftYmd("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftYmd("2027-01-01", -1)).toBe("2026-12-31");
    expect(shiftYmd("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftYmd("11/30", 1)).toBeNull();
  });
});

describe("changed cells (db/012)", () => {
  const row = {
    jobId: "1",
    cusCodeName: "ACME",
    cusMgrName: null,
    prjMgrName: "김",
    prjCode: "P1",
    jobName: "J",
    slang: "한국어",
    elang: "영어",
    tr: { tranName: "번역가", volume: "100.00", eday: "2026-11-30", edayTime: "18:00" },
    rv: null,
    jobEday: "2026-12-01",
    jobEdayTime: null,
  } as unknown as PmSheetRow;

  it("snapshots the linked values by sheet column", () => {
    const snap = sheetSnapshot(row);
    expect(snap.lang).toBe("한국어→영어");
    expect(snap.translator).toBe("번역가");
    expect(snap.rvPo).toBe("-");
    expect(snap.cusMgrName).toBe("");
  });

  it("reports only keys that moved since they were confirmed; unknown keys are not changes", () => {
    const seen = { ...sheetSnapshot(row) } as Record<string, unknown>;
    delete seen.jobName;
    const now = sheetSnapshot({ ...row, jobEday: "2026-12-02", jobName: "J2" } as PmSheetRow);
    expect(seenDiff(seen, now)).toEqual(["jobEday"]);
  });

  it("the sheet skips a waiting re-handover, so the job stays put; re-handovers cannot be rejected", () => {
    const dbops = read("lambdas", "neotms", "nodejs", "neotms", "pmsheet", "NeotmsPmSheet.dbops.ts");
    expect(dbops).toContain("AND NOT (h.rehandover AND h.status IN (0, 2))");
    const manager = read("lambdas", "neotms", "nodejs", "neotms", "pmsheet", "NeotmsPmSheetManager.ts");
    expect(manager).toContain("재인계는 반려할 수 없습니다");
    // Confirming must not send 진행 상태 back to '인계 수령'.
    expect(manager).toMatch(/status === 1 && handover\.rehandover\)[\s\S]{0,200}markSeen/);
  });

  it("the owner's own job / project / PO saves are recorded as seen", () => {
    const handler = read("lambdas", "neotms", "nodejs", "neotms", "neotms.handler.ts");
    for (const target of ["{ jobId: id }", "{ projectId: id }", "{ poId: id }", "{ jobId: parsed.value.jobId }"]) {
      expect(handler).toContain(`keepOwnEditsSeen(callerOf(request), ${target}`);
    }
  });

  it("db/012 only adds a table and a defaulted column", () => {
    const sql = read("db", "012_pm_sheet_seen.sql");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS pm_sheet_seen");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS rehandover boolean NOT NULL DEFAULT false");
    expect(sql).not.toMatch(/\bDROP\b|\bUPDATE\b|\bDELETE\b/);
  });
});

describe("merge rule: same project and same deadline; the head row's values win", () => {
  it("checks only project and deadline", () => {
    const model = read("frontend", "src", "features", "pmsheet", "sheetModel.ts");
    const body = model.slice(model.indexOf("export function mergeProblem"), model.indexOf("export const cellStyleOf"));
    expect(body).toContain("row.projectId !== first.projectId");
    expect(body).toContain("jobEday");
    expect(body).not.toContain("fields.path");
    expect(body).not.toContain("cusMgrName");
  });
});
