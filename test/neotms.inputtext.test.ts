import { describe, expect, it } from "@jest/globals";
import { groupNumberText, parseTimeText, shiftHour, stripNumberText } from "../frontend/src/shared/utils/inputText";

describe("24-hour time text", () => {
  it("accepts two digits as whole hours", () => {
    expect(parseTimeText("23")).toBe("23:00");
    expect(parseTimeText("9")).toBe("09:00");
    expect(parseTimeText("0")).toBe("00:00");
  });

  it("accepts compact and separated forms", () => {
    expect(parseTimeText("930")).toBe("09:30");
    expect(parseTimeText("2330")).toBe("23:30");
    expect(parseTimeText("9:5")).toBe("09:05");
    expect(parseTimeText("18.30")).toBe("18:30");
    expect(parseTimeText(" ")).toBe("");
  });

  it("rejects what is not a time", () => {
    expect(parseTimeText("24")).toBeNull();
    expect(parseTimeText("12:60")).toBeNull();
    expect(parseTimeText("오후 3시")).toBeNull();
    expect(parseTimeText("12345")).toBeNull();
  });

  it("steps one hour, keeps minutes, stops at the ends", () => {
    expect(shiftHour("14:30", 1, "09:00")).toBe("15:30");
    expect(shiftHour("23:15", 1, "09:00")).toBe("23:15");
    expect(shiftHour("00:15", -1, "09:00")).toBe("00:15");
    expect(shiftHour("", 1, "10:42")).toBe("10:00");
  });
});

describe("comma numbers", () => {
  it("groups the integer part and keeps the fraction as typed", () => {
    expect(groupNumberText("1234567")).toBe("1,234,567");
    expect(groupNumberText("12000.5")).toBe("12,000.5");
    expect(groupNumberText("1,2,3,4")).toBe("1,234");
    expect(groupNumberText("-5000")).toBe("-5,000");
    expect(groupNumberText("12a3")).toBe("123");
    expect(groupNumberText("")).toBe("");
  });

  it("strips commas for saving", () => {
    expect(stripNumberText("1,234,567.25")).toBe("1234567.25");
  });
});
