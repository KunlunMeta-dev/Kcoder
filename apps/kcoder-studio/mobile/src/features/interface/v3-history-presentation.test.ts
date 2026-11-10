import { expect, test } from "vitest";
import { v3HistoryMonth, v3HistoryTime } from "./v3-history-presentation";

test("V3 history separates local months and years while keeping invalid dates unknown", () => {
  expect(v3HistoryMonth(new Date(2026, 11, 31, 23, 59).getTime(), "zh-CN"))
    .toEqual({ key: "2026-12", label: "2026年12月" });
  expect(v3HistoryMonth(new Date(2027, 0, 1, 0, 1).getTime(), "en-US"))
    .toEqual({ key: "2027-1", label: "January 2027" });
  expect(v3HistoryMonth("invalid", "en")).toBeNull();
  expect(v3HistoryMonth(0, "en")).toBeNull();
});

test("V3 history displays the actual local update time including seconds", () => {
  const value = new Date(2026, 9, 22, 12, 56, 52).getTime();
  expect(v3HistoryTime(value, "zh-CN")).toBe("12:56:52");
  expect(v3HistoryTime(value, "en-US")).toBe("12:56:52");
  expect(v3HistoryTime("invalid", "en")).toBe("");
});
