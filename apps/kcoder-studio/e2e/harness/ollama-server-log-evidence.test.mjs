import assert from "node:assert/strict";
import test from "node:test";
import { parseOllamaServerLogEvidence } from "./ollama-server-log-evidence.mjs";

test("parses Ollama slog quoted truncation and spaced runner fields", () => {
  const evidence = parseOllamaServerLogEvidence([
    'time=... level=WARN source=llama_server.go:320 msg="truncating input prompt" limit=2050 prompt=4473 keep=4 new=2050',
    "slot print_timing: prompt processing, n_tokens =   2046, progress = 1.00",
    "runner config: n_ctx = 4096 n_ctx_seq = 1",
  ].join("\n"));

  assert.deepEqual(evidence.truncations, [{ limit: 2050, prompt: 4473, keep: 4, newCount: 2050 }]);
  assert.deepEqual(evidence.processedPromptCounts, [2046]);
  assert.deepEqual(evidence.runnerContexts, [4096]);
});

test("parses legacy unquoted truncation and token-count log forms", () => {
  const evidence = parseOllamaServerLogEvidence([
    "truncating input prompt limit=2050 prompt=6075 keep=4 new=2050",
    "prompt processing reaches n_tokens=2046",
    "n_ctx=4096",
  ].join("\n"));

  assert.deepEqual(evidence.truncations, [{ limit: 2050, prompt: 6075, keep: 4, newCount: 2050 }]);
  assert.deepEqual(evidence.processedPromptCounts, [2046]);
  assert.deepEqual(evidence.runnerContexts, [4096]);
});
