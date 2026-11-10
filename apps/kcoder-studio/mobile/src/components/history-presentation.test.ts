import { expect, test } from "vitest";
import { historyDateGroup, historyProjectKey, historyTime } from "./history-presentation";

const now = new Date(2026, 9, 22, 10, 30).getTime();
test("history groups by local calendar days rather than elapsed 24-hour windows", () => {
  expect(historyDateGroup(new Date(2026, 9, 22, 0, 1).getTime(), now)).toBe("today");
  expect(historyDateGroup(new Date(2026, 9, 21, 23, 59).getTime(), now)).toBe("yesterday");
  expect(historyDateGroup(new Date(2026, 9, 19, 9).getTime(), now)).toBe("earlier_week");
  expect(historyDateGroup(new Date(2026, 9, 18, 23, 59).getTime(), now)).toBe("older");
  expect(historyDateGroup("invalid", now)).toBe("unknown_date");
  expect(historyDateGroup(0, now)).toBe("unknown_date");
});

test("Monday still classifies Sunday as yesterday", () => {
  const monday = new Date(2026, 9, 19, 0, 5).getTime();
  expect(historyDateGroup(new Date(2026, 9, 18, 23, 59).getTime(), monday)).toBe("yesterday");
});

test("timestamps display real time or date and keep missing timestamps empty", () => {
  expect(historyTime(now, "en-GB", now)).toBe("10:30");
  expect(historyTime(new Date(2026, 9, 18, 12).getTime(), "en-GB", now)).toContain("Oct");
  expect(historyTime("invalid", "en-GB", now)).toBe("");
});

test("identical directory paths on different servers remain separate filter choices", () => {
  expect(historyProjectKey("local", "/workspace/project")).not.toBe(historyProjectKey("ssh", "/workspace/project"));
  expect(historyProjectKey("target:a", "/b")).not.toBe(historyProjectKey("target", "a:/b"));
});
