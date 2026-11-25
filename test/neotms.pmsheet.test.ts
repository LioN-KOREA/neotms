// SPDX-License-Identifier: MIT
//
// 나의 업무 (job-level PM sheet): the rules the sheet's users depend on.
//
//   * Re-sent handovers highlight exactly the fields that changed (`changedKeys`).
//   * The PM-state list is one list on both sides - a state the client offers and the server
//     refuses would make the dropdown fail on save.
//   * Dates and hours the PM types are read the way the planning doc says (11/13, 1113, 24시...).
//   * Formulas, conditional formatting and the project-state mapping behave as documented.
import * as v from "valibot";
import { changedKeys } from "../lambdas/neotms/nodejs/neotms/pmsheet/NeotmsPmSheetManager";
import {
  PM_STATES as SERVER_STATES,
  PmCellsSchema,
  PmRowPatchSchema,
  PmStyleSchema,
} from "../lambdas/neotms/nodejs/neotms/pmsheet/NeotmsPmSheet.schemas";
import { PmProjectStateSyncOps, PmSheetRowsOps } from "../lambdas/neotms/nodejs/neotms/pmsheet/NeotmsPmSheet.dbops";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  asNumber,
  formatHour,
  formatSheetDate,
  hourState,
  parseHour,
  parseSheetDate,
} from "../frontend/src/features/pmsheet/sheetFormat";
import { evaluateFormula } from "../frontend/src/features/pmsheet/sheetFormula";
import { conditionalStyle, resolveDate, testClause } from "../frontend/src/features/pmsheet/conditional";
import {
  BUILTIN_STATES,
  DEFAULT_STATES,
  effectiveStates,
  isClosedState,
  selectableStates,
  stateStyleFor,
} from "../frontend/src/features/pmsheet/pmStates";

// The client's list lives in a module that also pulls in React Query, so it is read as text.
const CLIENT_STATES = (() => {
  const src = readFileSync(path.join(__dirname, "../frontend/src/apis/pmsheet.api.ts"), "utf8");
  const block = /export const PM_STATES = \[([\s\S]*?)\]/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
})();

const NOW = new Date(2026, 10, 24, 14, 30); // 2026-11-24 (화) 14:30

describe("handover diff", () => {
  it("lists only the fields that changed, treating null and empty alike", () => {
    expect(changedKeys({ a: 1, b: "x", c: null }, { a: 1, b: "y", c: "" })).toEqual(["b"]);
    expect(changedKeys({ jobEday: "2026-12-03" }, { jobEday: "2026-12-05", jobMemo: "new" })).toEqual(["jobEday", "jobMemo"]);
    expect(changedKeys({}, {})).toEqual([]);
  });
});

describe("PM states", () => {
  it("are the same list, in the same order, on server and client", () => {
    expect([...CLIENT_STATES]).toEqual([...SERVER_STATES]);
    expect(SERVER_STATES[0]).toBe("인계 수령");
    expect(SERVER_STATES).toContain("납품 완료");
    expect(SERVER_STATES).toContain("홀딩/캔슬");
  });

  it("drive the project state through bound parameters, not literals", () => {
    const ops = PmProjectStateSyncOps("1", "t");
    const names = (ops.parameters ?? []).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["st_active", "st_done", "st_hold"]));
    expect(ops.sql).toContain("'납품 완료' THEN :st_done");
    expect(ops.sql).toContain("'홀딩/캔슬' THEN :st_hold");
  });

  it("the sheet only shows jobs handed to (or accepted by) its owner", () => {
    const sql = PmSheetRowsOps("3").sql;
    expect(sql).toContain("hv.to_staff_id = :staff_id");
    expect(sql).toContain("hv.status = 1");
    expect(sql).toContain("j.job_pm_id = :staff_id");
  });
});

describe("schemas", () => {
  it("accept the sheet's style vocabulary and refuse unknown keys", () => {
    expect(v.safeParse(PmStyleSchema, { bg: "#FF9900", bold: true, border: "thin", borderSides: "tb", decimals: 2 }).success).toBe(true);
    expect(v.safeParse(PmStyleSchema, { bg: "orange" }).success).toBe(false);
    expect(v.safeParse(PmStyleSchema, { borderSides: "x" }).success).toBe(false);
    expect(v.safeParse(PmStyleSchema, { script: "alert(1)" }).success).toBe(false);
  });

  it("only let cells use custom keys or fixed column keys", () => {
    expect(v.safeParse(PmCellsSchema, { items: [{ jobId: "1", colKey: "c:abc", value: "x" }] }).success).toBe(true);
    expect(v.safeParse(PmCellsSchema, { items: [{ jobId: "1", colKey: "trEday", style: { bold: true } }] }).success).toBe(true);
    expect(v.safeParse(PmCellsSchema, { items: [{ jobId: "1", colKey: "drop table", value: "x" }] }).success).toBe(false);
  });
});

describe("date and hour input", () => {
  it("reads the short forms the planning doc lists", () => {
    for (const text of ["1113", "11/13", "11.13", "11-13", "261113", "20261113", "26-11-13", "2026-11-13", "11/13(금)"]) {
      expect(parseSheetDate(text, true, NOW)).toEqual({ ok: true, value: "2026-11-13" });
    }
  });

  it("picks the nearest year for month/day only", () => {
    expect(parseSheetDate("0105", true, new Date(2026, 11, 20))).toEqual({ ok: true, value: "2027-01-05" });
    expect(parseSheetDate("1228", true, new Date(2027, 0, 3))).toEqual({ ok: true, value: "2026-12-28" });
  });

  it("refuses impossible dates", () => {
    expect(parseSheetDate("0230", true, NOW).ok).toBe(false);
    expect(parseSheetDate("hello", true, NOW).ok).toBe(false);
  });

  it("shows dates as 11/13(금), with the year only when it is not this year", () => {
    expect(formatSheetDate("2026-11-13", NOW)).toBe("11/13(금)");
    expect(formatSheetDate("2027-01-05", NOW)).toMatch(/^27\/01\/05\(화\)$|^27\/1\/5\(화\)$/);
  });

  it("stores hour 24 as 23:59 and shows it back as 24", () => {
    expect(parseHour("24")).toEqual({ ok: true, value: "23:59" });
    expect(parseHour("9")).toEqual({ ok: true, value: "09:00" });
    expect(parseHour("17시")).toEqual({ ok: true, value: "17:00" });
    expect(parseHour("0").ok).toBe(false);
    expect(formatHour("23:59")).toBe("24");
    expect(formatHour("09:00")).toBe("9");
    expect(formatHour("17:30")).toBe("17:30");
  });

  it("marks the current hour and past hours", () => {
    expect(hourState("2026-11-24", "14:00", NOW)).toBe("now");
    expect(hourState("2026-11-24", "10:00", NOW)).toBe("past");
    expect(hourState("2026-11-24", "18:00", NOW)).toBeNull();
    expect(hourState("2026-11-23", "18:00", NOW)).toBe("past");
  });

  it("does not take phone numbers for numbers", () => {
    expect(asNumber("12,000")).toBe(12000);
    expect(asNumber("010-1234")).toBeNull();
    expect(asNumber("0101234")).toBeNull();
    expect(asNumber("0.5")).toBe(0.5);
  });
});

describe("formulas", () => {
  const cols: Record<string, number | string> = { "원본 분량": 1200, "단가": 80, "진행 상태": "납품 완료" };
  const ref = (name: string) => {
    if (!(name in cols)) throw new Error(`열 [${name}] 이 없습니다.`);
    return cols[name]!;
  };
  it("computes arithmetic over same-row columns", () => {
    expect(evaluateFormula("=[원본 분량]*[단가]", ref)).toEqual({ ok: true, value: 96000 });
    expect(evaluateFormula("=ROUND([원본 분량]/7, 1)", ref)).toEqual({ ok: true, value: 171.4 });
    expect(evaluateFormula("=SUM(1,2,3)+2^3", ref)).toEqual({ ok: true, value: 14 });
  });
  it("supports IF and text", () => {
    expect(evaluateFormula('=IF([진행 상태]="납품 완료","끝","진행")', ref)).toEqual({ ok: true, value: "끝" });
    expect(evaluateFormula('="총 "&[원본 분량]&"단어"', ref)).toEqual({ ok: true, value: "총 1200단어" });
  });
  it("reports errors instead of throwing", () => {
    expect(evaluateFormula("=[없는 열]+1", ref).ok).toBe(false);
    expect(evaluateFormula("=1/0", ref).ok).toBe(false);
    expect(evaluateFormula("=(1+", ref).ok).toBe(false);
  });
});

describe("conditional formatting", () => {
  it("evaluates each clause type", () => {
    expect(testClause({ op: "contains", value: "급" }, "", "긴급 건", NOW)).toBe(true);
    expect(testClause({ op: "notContains", value: "급" }, "", "일반", NOW)).toBe(true);
    expect(testClause({ op: "empty" }, "", "", NOW)).toBe(true);
    expect(testClause({ op: "notEmpty" }, "x", "x", NOW)).toBe(true);
    expect(testClause({ op: "equals", value: "번역" }, "번역", "번역", NOW)).toBe(true);
    expect(testClause({ op: "dateBefore", value: "today" }, "2026-11-23", "", NOW)).toBe(true);
    expect(testClause({ op: "dateOn", value: "today+1" }, "2026-11-25", "", NOW)).toBe(true);
    expect(testClause({ op: "dateAfter", value: "2026-11-30" }, "2026-11-25", "", NOW)).toBe(false);
    expect(resolveDate("today-1", NOW)).toBe("2026-11-23");
  });

  it("joins clauses with and/or, and a user rule beats the default colour", () => {
    const read = (key: string) => (key === "pmState" ? { raw: "번역 중", shown: "번역 중" } : { raw: "2026-11-24", shown: "11/24(화)" });
    const rule = {
      id: "r", columns: ["trEday"], join: "and" as const, enabled: true, style: { bg: "#990000" },
      clauses: [{ column: "pmState", op: "contains" as const, value: "번역" }, { op: "dateOn" as const, value: "today" }],
    };
    const style = conditionalStyle({ rules: [rule], colKey: "trEday", read, defaultKind: "date", defaultState: "today", defaults: true, now: NOW });
    expect(style).toEqual({ bg: "#990000", fg: "#FFFFFF", bold: true });
    const off = conditionalStyle({ rules: [], colKey: "trEday", read, defaultKind: "date", defaultState: "today", defaults: false, now: NOW });
    expect(off).toBeNull();
    const orRule = { ...rule, join: "or" as const, clauses: [{ column: "pmState", op: "equals" as const, value: "없음" }, { op: "notEmpty" as const }] };
    expect(conditionalStyle({ rules: [orRule], colKey: "trEday", read, defaultKind: null, defaultState: null, defaults: true, now: NOW })).toEqual({ bg: "#990000" });
  });
});

describe("personal PM states (⚙)", () => {
  it("the client's built-in list matches the server's", () => {
    expect([...BUILTIN_STATES]).toEqual([...SERVER_STATES]);
  });

  it("every built-in except the 별도 관리 markers has a default colour", () => {
    for (const def of DEFAULT_STATES) {
      if (def.name.startsWith("별도 관리")) expect(def.bg).toBeNull();
      else expect(def.bg).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("keeps built-in names and mappings fixed, appends missing built-ins, keeps custom ones", () => {
    const merged = effectiveStates([
      { name: "고객 확인 중", prj: "보류", bg: "#EFEFEF" },
      { name: "납품 완료", prj: "진행", hidden: true },
    ]);
    expect(merged[0]).toMatchObject({ name: "고객 확인 중", builtin: false, prj: "보류" });
    expect(merged[1]).toMatchObject({ name: "납품 완료", builtin: true, prj: "완료", hidden: true });
    expect(merged.length).toBe(SERVER_STATES.length + 1);
    expect(selectableStates(merged)).not.toContain("납품 완료");
    expect(isClosedState("고객 확인 중", merged)).toBe(true);
    expect(isClosedState("번역 중", merged)).toBe(false);
  });

  it("paints the chosen span: the cell, the row, or a column range in display order", () => {
    const order = ["a", "pmState", "b", "c", "d"];
    const defs = effectiveStates([
      { name: "X", bg: "#111111", span: "cell" },
      { name: "Y", bg: "#222222", span: "row" },
      { name: "Z", bg: "#333333", span: "range", from: "c", to: "pmState" },
    ]);
    expect(stateStyleFor("X", "pmState", order, defs)).toEqual({ bg: "#111111" });
    expect(stateStyleFor("X", "b", order, defs)).toBeNull();
    expect(stateStyleFor("Y", "d", order, defs)).toEqual({ bg: "#222222" });
    expect(stateStyleFor("Z", "b", order, defs)).toEqual({ bg: "#333333" });
    expect(stateStyleFor("Z", "a", order, defs)).toBeNull();
    expect(stateStyleFor(null, "pmState", order, defs)).toBeNull();
  });

  it("the server maps a custom state through the owner's own settings", () => {
    const ops = PmProjectStateSyncOps("1", "t");
    expect(ops.sql).toContain("pm_state = ANY(:builtin)");
    expect(ops.sql).toContain("pf.staff_id = r.staff_id AND pf.kind = 'columns'");
    expect((ops.parameters ?? []).find((p) => p.name === "builtin")).toBeTruthy();
  });

  it("accepts a custom state name but bounds it", () => {
    expect(v.safeParse(PmRowPatchSchema, { jobId: "1", pmState: "고객 확인 중" }).success).toBe(true);
    expect(v.safeParse(PmRowPatchSchema, { jobId: "1", pmState: "x".repeat(51) }).success).toBe(false);
    expect(v.safeParse(PmStyleSchema, { wrap: "wrap" }).success).toBe(true);
    expect(v.safeParse(PmStyleSchema, { wrap: "shrink" }).success).toBe(false);
  });
});
