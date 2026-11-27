import assert from "node:assert/strict";
import test from "node:test";
import {
  countPaletteQueries,
  makeOutlineHistoryFixture,
  OUTLINE_MARKERS,
  verifyOutlineTargetVisible,
} from "../lib/outline-navigation-fixture.mjs";

test("outline fixture has repeated headings with distinct sentinels beyond the old row budget", () => {
  const fixture = makeOutlineHistoryFixture();
  const entries = fixture.jsonl.trim().split("\n").map(JSON.parse);
  assert.equal(entries.length, 4);
  assert.deepEqual(
    entries.map((entry) => entry.role),
    ["user", "assistant", "user", "assistant"],
  );
  assert.ok(fixture.targetSourceLine > 4000);
  const answer = entries[1].content[0].text;
  assert.equal(
    answer.split(`## ${OUTLINE_MARKERS.duplicateTitle}`).length - 1,
    2,
  );
  assert.match(
    Buffer.from(answer).subarray(fixture.targetSourceByte).toString(),
    /^## Repeated navigation heading/,
  );
});

test("outline target acceptance requires the second sentinel in the visible body", () => {
  assert.equal(verifyOutlineTargetVisible("offset changed to 8000"), false);
  assert.equal(
    verifyOutlineTargetVisible(OUTLINE_MARKERS.firstDuplicate),
    false,
  );
  assert.equal(
    verifyOutlineTargetVisible(
      `Conversation outline ${OUTLINE_MARKERS.secondDuplicate}`,
    ),
    false,
  );
  assert.equal(
    verifyOutlineTargetVisible(
      `${OUTLINE_MARKERS.duplicateTitle}\n${OUTLINE_MARKERS.secondDuplicate}`,
    ),
    true,
  );
});

test("counts only OSC palette requests and detects repeated probes", () => {
  const one = "\x1b]10;?\x1b\\\x1b]11;?\x07";
  assert.deepEqual(countPaletteQueries(one), { foreground: 1, background: 1 });
  assert.deepEqual(countPaletteQueries(one + one), {
    foreground: 2,
    background: 2,
  });
  assert.deepEqual(countPaletteQueries("\x1b]10;rgb:1111/2222/3333\x07"), {
    foreground: 0,
    background: 0,
  });
});
