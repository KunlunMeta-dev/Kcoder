// Exact pure page/message fixture extracted from mobile-render-profile.e2e.mjs.
// Controlled history only; this does not implement or validate Rust pagination.
const fixturePageSize = 50;
export function makeHistoryPage(total, beforeCursor, requestedLimit, fixtureWorkspace, markLatestHistoryTailForVisibility = false) {
  let end = total;
  if (typeof beforeCursor === "string" && /^ux:\d+$/.test(beforeCursor)) end = Number(beforeCursor.slice(3));
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, fixturePageSize) : fixturePageSize;
  const start = Math.max(0, end - limit);
  const messages = Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset;
    return makeHistoryMessage(index, fixtureWorkspace, markLatestHistoryTailForVisibility && index === total - 1);
  });
  return {
    messages,
    rangeStart: start,
    rangeEnd: end,
    hasMoreBefore: start > 0,
    beforeCursor: start > 0 ? `ux:${start}` : null,
  };
}

function makeHistoryMessage(index, fixtureWorkspace, markTranscriptTail = false) {
  const marker = `HISTORY-${String(index).padStart(4, "0")}`;
  const code = Array.from({ length: 18 }, (_, line) => `export function fixture_${index}_${line}(value: number) { return value + ${line}; }`).join("\n");
  const markdown = [
    `# ${marker}: mobile transcript fixture`,
    "",
    `This is a long Markdown history entry used only by the isolated Chromium render profile. It contains a paragraph with enough prose to exercise line wrapping, text layout, and memoized row rendering at a 390 CSS-pixel viewport. ${"A fixed deterministic sentence gives this message a stable text shape. ".repeat(8)}`,
    "",
    "| step | result | detail |",
    "| --- | --- | --- |",
    `| parse | complete | synthetic fixture row ${index} |`,
    "| render | measured | no model request |",
    "",
    "```typescript",
    code,
    "```",
    ...(markTranscriptTail ? [`HISTORY-${String(index).padStart(4, "0")}-TAIL`] : []),
  ].join("\n");
  const blocks = [];
  if (index % 3 === 1) {
    blocks.push({ type: "tool", id: `tool-${index}`, tool_name: "read_file", status: "done", tool_input: { path: `src/fixture-${index}.ts`, range: { start: 1, end: 80 } }, tool_output: `${"tool output line for a long source excerpt; deterministic mock only.\n".repeat(18)}${marker}-TOOL-END` });
  }
  if (index % 5 === 2) {
    blocks.push({ type: "file_changes", fileChanges: { artifactId: `history-artifact-${index}`, workspacePath: fixtureWorkspace, fileCount: 12, additions: 88, deletions: 16, files: Array.from({ length: 12 }, (_, fileIndex) => `${fixtureWorkspace}/history-${index}-${fileIndex}.ts`), status: "active", revertible: true } });
  }
  return {
    id: `history-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: markdown,
    blocks,
    timestampMs: 1_790_000_000_000 + index * 1000,
  };
}
