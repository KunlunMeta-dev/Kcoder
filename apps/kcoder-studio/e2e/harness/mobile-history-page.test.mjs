import assert from "node:assert/strict";
import test from "node:test";
import { makeHistoryPage } from "../fixtures/mobile-history-page.mjs";

test("synthetic history pages use stable IDs and bounded adjacent cursor ranges", () => {
  const newer = makeHistoryPage(120, undefined, 50, "/owned/workspace");
  const older = makeHistoryPage(120, newer.beforeCursor, 50, "/owned/workspace");
  const oldest = makeHistoryPage(120, older.beforeCursor, 50, "/owned/workspace");

  assert.deepEqual([newer.rangeStart, newer.rangeEnd, newer.hasMoreBefore, newer.beforeCursor], [70, 120, true, "ux:70"]);
  assert.deepEqual([older.rangeStart, older.rangeEnd, older.hasMoreBefore, older.beforeCursor], [20, 70, true, "ux:20"]);
  assert.deepEqual([oldest.rangeStart, oldest.rangeEnd, oldest.hasMoreBefore, oldest.beforeCursor], [0, 20, false, null]);
  const ids = [...newer.messages, ...older.messages, ...oldest.messages].map(message => message.id);
  assert.equal(new Set(ids).size, 120, "adjacent cursor pages cannot overlap");
  assert.deepEqual(ids.sort((left, right) => Number(left.slice(8)) - Number(right.slice(8))),
    Array.from({ length: 120 }, (_, index) => `history-${index}`));
});

test("synthetic history content and block rows are deterministic", () => {
  const first = makeHistoryPage(4, undefined, 4, "/owned/workspace", true);
  const second = makeHistoryPage(4, undefined, 4, "/owned/workspace", true);

  assert.deepEqual(first, second);
  assert.equal(first.messages[1].blocks[0].type, "tool");
  assert.equal(first.messages[2].blocks[0].type, "file_changes");
  assert.match(first.messages.at(-1).content, /HISTORY-0003-TAIL/);
});

test("invalid or oversized page limits retain the fixture's bounded default", () => {
  const oversized = makeHistoryPage(80, undefined, 500, "/owned/workspace");
  const invalid = makeHistoryPage(80, undefined, 0, "/owned/workspace");

  assert.equal(oversized.messages.length, 50);
  assert.equal(oversized.rangeStart, 30);
  assert.equal(invalid.messages.length, 50);
  assert.equal(invalid.rangeStart, 30);
});
