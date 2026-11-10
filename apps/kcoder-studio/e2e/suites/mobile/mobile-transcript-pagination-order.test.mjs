import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenNewestFirstPages,
  webTranscriptDomOrderToDisplayOrder,
} from "./mobile-transcript-pagination-order.mjs";

test("two newest-first pages flatten to chronological display order", () => {
  const pages = [
    ["turn-03", "turn-04"],
    ["turn-01", "turn-02"],
  ];

  assert.deepEqual(flattenNewestFirstPages(pages), [
    "turn-01",
    "turn-02",
    "turn-03",
    "turn-04",
  ]);
  assert.deepEqual(pages, [
    ["turn-03", "turn-04"],
    ["turn-01", "turn-02"],
  ], "page normalization must not mutate the read order");
});

test("three newest-first pages preserve row order inside every page", () => {
  const pages = [
    ["turn-05-user", "turn-05-assistant", "turn-06-user", "turn-06-assistant"],
    ["turn-03-user", "turn-03-assistant", "turn-04-user", "turn-04-assistant"],
    ["turn-01-user", "turn-01-assistant", "turn-02-user", "turn-02-assistant"],
  ];

  assert.deepEqual(flattenNewestFirstPages(pages), [
    "turn-01-user",
    "turn-01-assistant",
    "turn-02-user",
    "turn-02-assistant",
    "turn-03-user",
    "turn-03-assistant",
    "turn-04-user",
    "turn-04-assistant",
    "turn-05-user",
    "turn-05-assistant",
    "turn-06-user",
    "turn-06-assistant",
  ]);
});

test("inverted Mobile Web transcript DOM rows normalize to displayed order", () => {
  assert.deepEqual(
    webTranscriptDomOrderToDisplayOrder([
      "turn-04",
      "turn-03",
      "turn-02",
      "turn-01",
    ]),
    ["turn-01", "turn-02", "turn-03", "turn-04"],
  );
});
