import { expect, it } from "vitest";
import type { ChatMessage } from "@/runtime/task-runtime";
import { searchLoadedTranscript } from "./transcript-search";

const messages: ChatMessage[] = [
  { id: "u", role: "user", content: "查找错误 Error 和 error", timestampMs: 1 },
  { id: "a", role: "assistant", content: "hidden legacy Error", thinking: "private Error", timestampMs: 2,
    orderedBlocks: [{ kind: "thinking", id: "t", content: "private Error" }, { kind: "text", id: "body", content: "错误：ERROR in file.ts" }] },
  { id: "system", role: "system", content: "Error internal instruction", timestampMs: 3 },
];
it("counts every visible occurrence case-insensitively, with exact message jump identities", () => {
  const { matches, total } = searchLoadedTranscript(messages, "error");
  expect(total).toBe(3);
  expect(matches.map(match => match.messageId)).toEqual(["u", "u", "a"]);
  expect(new Set(matches.map(match => match.key)).size).toBe(3);
  expect(matches[2].excerpt).toBe("错误：ERROR in file.ts");
});
it("searches Chinese and code bodies, excludes thought/system/obsolete content, and handles no results", () => {
  expect(searchLoadedTranscript(messages, "错误").matches).toHaveLength(2);
  expect(searchLoadedTranscript(messages, "file.ts").matches).toHaveLength(1);
  expect(searchLoadedTranscript(messages, "private").matches).toEqual([]);
  expect(searchLoadedTranscript(messages, "legacy").matches).toEqual([]);
  expect(searchLoadedTranscript(messages, "   ").matches).toEqual([]);
  expect(searchLoadedTranscript([], "Error").matches).toEqual([]);
});

it("bounds excerpt memory for very common queries while keeping the actual count", () => {
  const result = searchLoadedTranscript([{ id: "large", role: "user", content: "x".repeat(50_000), timestampMs: 1 }], "x");
  expect(result.total).toBe(50_000);
  expect(result.matches).toHaveLength(1000);
});
