import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSseDataFrames, sanitizeCapturedFrames } from "./capture-minimax-chat-sample.mjs";
import { startModelStreamController } from "./controller.mjs";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/model-stream/chat-completions/minimax/captured/text-completion/scenario.json",
);

test("sanitizes a captured Chat Completions stream without losing decoder structure", () => {
  const raw = [
    `data: ${JSON.stringify({
      id: "private-provider-id",
      object: "chat.completion.chunk",
      created: 1_795_000_000,
      model: "MiniMax-M3",
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "private reasoning" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "private-provider-id",
      object: "chat.completion.chunk",
      created: 1_795_000_000,
      model: "MiniMax-M3",
      choices: [{ index: 0, delta: { content: "private response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 4 } },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const dataFrames = parseSseDataFrames(raw);
  const result = sanitizeCapturedFrames(dataFrames, "MiniMax-M3");
  const joined = result.frames.join("");

  assert.equal(dataFrames.length, 3);
  assert.equal(result.summary.doneSentinelPresent, true);
  assert.deepEqual(result.summary.finishReasons, ["stop"]);
  assert.equal(result.summary.usagePresent, true);
  assert.ok(joined.includes("reasoning_content"));
  assert.ok(joined.includes("prompt_tokens"));
  assert.ok(joined.includes("[REDACTED_SAMPLE_TEXT]"));
  assert.ok(joined.includes("[REDACTED_SAMPLE_REASONING]"));
  assert.ok(joined.includes("chatcmpl-captured-redacted"));
  assert.ok(!joined.includes("private"));
  assert.ok(!joined.includes("1795000000"));
});

test("parses multiple data lines and rejects non Chat Completions payloads", () => {
  assert.deepEqual(parseSseDataFrames("event: chunk\r\ndata: first\r\ndata: second\r\n\r\n"), ["first\nsecond"]);
  assert.throws(() => sanitizeCapturedFrames([JSON.stringify({ object: "response", choices: [] })], "MiniMax-M3"), /unexpected Chat Completions frame type/);
});

test("checked-in capture is identified as captured and contains no source text or provider identifiers", async () => {
  const scenario = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(scenario.source.kind, "captured");
  assert.equal(scenario.source.requestCount, 1);
  assert.equal(scenario.source.retries, 0);
  assert.equal(scenario.source.httpStatus, 200);
  assert.ok(scenario.source.responseBytes > 0 && scenario.source.responseBytes <= 1024 * 1024);
  assert.equal(scenario.source.sampleSummary.freeTextRedacted, true);
  assert.equal(scenario.source.sampleSummary.identifiersNormalized, true);
  const frames = scenario.requests.flatMap(request => request.frames).join("");
  for (const sensitiveValue of ["KCODER_CAPTURED_REPLY_OK", "private-provider-id", "1795000000"]) {
    assert.equal(frames.includes(sensitiveValue), false);
  }
  assert.match(frames, /\[REDACTED_SAMPLE_TEXT\]/);
});

test("captured MiniMax scenario replays as ordered SSE through the manual controller", async () => {
  const scenario = JSON.parse(await readFile(fixturePath, "utf8"));
  const controller = await startModelStreamController({
    registerSecret() {},
    registerPort() {},
    addCleanup() {},
  }, {
    scenarioId: scenario.id,
    operationId: "captured-replay-test",
    scenario,
  });

  try {
    const responsePromise = fetch(`${controller.endpointUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: scenario.source.model,
        stream: true,
        messages: [{ role: "user", content: "KCODER_E2E:captured-minimax-sample" }],
      }),
    });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    await controller.waitForRequest("initial");
    assert.equal(controller.snapshot().requests[0].framesWritten, 0);
    await controller.release("initial", { frames: "all" });

    const text = await response.text();
    const frames = parseSseDataFrames(text);
    assert.equal(frames.length, scenario.source.sampleSummary.frameCount);
    assert.equal(frames.at(-1), "[DONE]");
    assert.ok(frames.some(frame => JSON.parse(frame).choices?.[0]?.finish_reason === "stop"));
    assert.ok(frames.some(frame => JSON.parse(frame).usage?.total_tokens > 0));
    assert.equal(controller.snapshot().requests[0].status, "completed");
  } finally {
    await controller.close();
  }
});
