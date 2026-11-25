import { describe, expect, it } from "@jest/globals";
import {
  basisOptions,
  centsText,
  faceVolume,
  fitBasis,
  lineSubtotal,
  planJobs,
  splitByWeight,
  toCents,
  type TargetLine,
} from "../frontend/src/features/jobs/targetPricing";

const line = (over: Partial<TargetLine>): TargetLine => ({
  key: "k",
  lang: "영어",
  pmId: null,
  pmName: null,
  rawVolume: "",
  unit: "단어",
  basis: "250",
  price: "",
  mode: "unit",
  face: "",
  faceManual: false,
  ...over,
});

describe("job targets: face volume and line totals", () => {
  it("offers the basis choices per unit", () => {
    expect(basisOptions("단어").map((o) => o.value)).toEqual(["250", "200", "1"]);
    expect(basisOptions("글자").map((o) => o.value)).toEqual(["800", "700", "600", "400", "1"]);
    expect(basisOptions("시간").map((o) => o.value)).toEqual(["1"]);
    expect(fitBasis("시간", "250")).toBe("1");
    expect(fitBasis("단어", "200")).toBe("200");
  });

  it("face volume is volume / basis rounded to one decimal", () => {
    expect(faceVolume("12000", "250")).toBe("48.0");
    expect(faceVolume("1000", "300")).toBe("3.3");
    expect(faceVolume("1,125", "250")).toBe("4.5");
    expect(faceVolume("10", "4")).toBe("2.5");
    expect(faceVolume("12000", "0")).toBeNull();
    expect(faceVolume("abc", "250")).toBeNull();
  });

  it("line total by price mode", () => {
    expect(lineSubtotal("48.0", "25,000", "unit")).toBe(120000000n);
    expect(lineSubtotal("3.3", "0.5", "unit")).toBe(165n);
    expect(lineSubtotal("48.0", "300000", "fixed")).toBe(30000000n);
    expect(lineSubtotal("48.0", "25000", "free")).toBe(0n);
    expect(lineSubtotal("48.0", "x", "unit")).toBeNull();
  });

  it("cents helpers", () => {
    expect(toCents("1,234.567")).toBe(123457n);
    expect(toCents("")).toBe(0n);
    expect(centsText(123457n)).toBe("1234.57");
    expect(centsText(-5n)).toBe("-0.05");
  });
});

describe("job targets: one job per target, discount split by share", () => {
  it("split keeps the exact total and puts the remainder on the first", () => {
    expect(splitByWeight(1000n, [1n, 1n, 1n])).toEqual([334n, 333n, 333n]);
    expect(splitByWeight(500n, [0n, 0n])).toEqual([500n, 0n]);
  });

  it("each job's total is its line minus its share, and the jobs add up to the grand total", () => {
    const lines = [
      line({ lang: "영어", face: "40.0", price: "25000" }), // 1,000,000
      line({ lang: "중국어", face: "20.0", price: "25000" }), // 500,000
    ];
    const plan = planJobs(lines, "30000")!;
    expect(plan.subtotals).toEqual([100000000n, 50000000n]);
    expect(plan.discounts).toEqual([2000000n, 1000000n]);
    expect(plan.sums).toEqual([98000000n, 49000000n]);
    expect(plan.sums.reduce((a, b) => a + b, 0n)).toBe(147000000n);
  });

  it("a fixed grand total (hand-kept or converted) is split by the same shares", () => {
    const plan = planJobs([line({ face: "10", price: "100" })], "0", "999.00")!;
    expect(plan.sums).toEqual([99900n]);
  });

  it("refuses when a line has a bad number", () => {
    expect(planJobs([line({ face: "10", price: "abc" })], "0")).toBeNull();
    expect(planJobs([line({ face: "10", price: "1" })], "x")).toBeNull();
  });
});
