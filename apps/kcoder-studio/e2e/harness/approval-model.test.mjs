import assert from "node:assert/strict";
import test from "node:test";
import { startApprovalModelFixture } from "./approval-model.mjs";
import { startWikiModelFixture } from "./wiki-model.mjs";
import { startWorkflowModelFixture } from "./workflow-model.mjs";

test("Wiki provenance fixture gates the real HTTP reply and cleans every timer", async t => {
  const cleanups = [];
  let released = false, request;
  const fixture = await startWikiModelFixture({ addCleanup: (_, fn) => cleanups.push(fn), registerPort() {} },
    { responseReady: () => released });
  try {
    request = fetch(`${fixture.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "frozen-worker", messages: [{ role: "user", content: "{}" }] }),
    });
    void request.catch(() => {});
    await waitFor(() => fixture.requests.length === 1 && fixture.activeTimerCount === 1);
    released = true;
    assert.match(await (await request).text(), /资料说明产品支持协议 A/);
  } finally { released = true; for (const cleanup of cleanups.reverse()) await cleanup(); await request?.then(response => response.body?.cancel()).catch(() => {}); }
  assert.equal(fixture.activeTimerCount, 0);
  assert.equal(fixture.activeHandlerCount, 0);
});

test("Workflow fixture observes actual Provider model and request tool count without retaining bodies", async t => {
  const cleanups = [];
  const fixture = await startWorkflowModelFixture({ addCleanup: (_, fn) => cleanups.push(fn), registerPort() {} });
  try {
    const response = await fetch(`${fixture.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "actual-agent", tools: [{ function: { name: "read" } }],
        messages: [{ role: "user", content: "WF_NODE_A_WORK" }] }),
    });
    assert.match(await response.text(), /WF_NODE_A_RESULT/);
    assert.deepEqual(fixture.observations, [{ kind: "agent", node: "A", modelId: "actual-agent", exposedToolCount: 1 }]);
    assert.equal(fixture.requestCount, 1);
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
});

test("scripted protocol deltas stay ordered and gated responses cancel on cleanup", async t => {
  const fixture = await startFixture(t, {
    responseSteps: () => [
      { delta: { reasoning_content: "before-tools" } },
      { delta: { content: "after-tools" } },
      { ready: () => false, finishReason: "stop" },
    ],
  });
  const response = await fetch(`${fixture.fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  const reader = response.body.getReader();
  let first = "";
  while (!first.includes("after-tools")) {
    const part = await reader.read();
    assert.equal(part.done, false);
    first += new TextDecoder().decode(part.value);
  }
  assert.ok(first.indexOf("before-tools") < first.indexOf("after-tools"));
  await fixture.cleanup();
  await reader.cancel().catch(() => {});
  assert.equal(fixture.fixture.activeTimerCount, 0);
  assert.equal(fixture.fixture.activeHandlerCount, 0);
});

test("model fixture records terminal SSE and connection-close timing without request content", async t => {
  const fixture = await startFixture(t, {
    responseSteps: () => [
      { delta: { role: "assistant", content: "FIXTURE_TIMING_ONLY" } },
      { finishReason: "stop" },
    ],
  });
  const response = await fetch(`${fixture.fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "FIXTURE_TIMING_ONLY" }] }),
  });
  assert.match(await response.text(), /\[DONE\]/);
  await waitFor(() => fixture.fixture.requestOutcomes[0]?.closed === true);
  const outcome = fixture.fixture.requestOutcomes[0];
  assert.equal(typeof outcome.startedAtMs, "number");
  assert.equal(typeof outcome.finishReasonFrameAtMs, "number");
  assert.equal(typeof outcome.doneFrameAtMs, "number");
  assert.equal(typeof outcome.responseFinishedAtMs, "number");
  assert.equal(typeof outcome.responseClosedAtMs, "number");
  assert.ok(outcome.startedAtMs <= outcome.finishReasonFrameAtMs);
  assert.ok(outcome.finishReasonFrameAtMs <= outcome.doneFrameAtMs);
  assert.ok(outcome.doneFrameAtMs <= outcome.responseFinishedAtMs);
  assert.ok(outcome.responseFinishedAtMs <= outcome.responseClosedAtMs);
  assert.equal(outcome.aborted, false);
  assert.deepEqual(Object.keys(outcome).sort(), [
    "aborted",
    "closed",
    "doneFrameAtMs",
    "finishReasonFrameAtMs",
    "requestNumber",
    "responseClosedAtMs",
    "responseFinishedAtMs",
    "startedAtMs",
  ]);
});

test("unconfigured Ollama metadata endpoint returns 404 without recording a generation request", async t => {
  const fixture = await startFixture(t);
  const metadataUrl = new URL("/api/ps", fixture.fixture.baseUrl);
  const response = await fetch(metadataUrl);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.deepEqual(fixture.fixture.requests, []);
  assert.deepEqual(fixture.fixture.ollamaRequests, [
    { path: "/api/ps", authorizationPresent: false },
  ]);
});

test("configured Ollama metadata is read-only and records authorization presence without values", async t => {
  const secret = "fixture-ollama-secret";
  const models = [{
    model: "fixture-model",
    name: "fixture-model",
    digest: "fixture-digest",
    context_length: 4096,
  }];
  const fixture = await startFixture(t, { ollamaModels: models });
  const metadataUrl = new URL("/api/ps", fixture.fixture.baseUrl);
  const response = await fetch(metadataUrl, {
    headers: { authorization: `Bearer ${secret}` },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models });
  assert.deepEqual(fixture.fixture.requests, []);
  assert.deepEqual(fixture.fixture.ollamaRequests, [
    { path: "/api/ps", authorizationPresent: true },
  ]);
  assert.equal(JSON.stringify(fixture.fixture.ollamaRequests).includes(secret), false);
});

test("text fixture delivers reasoning and ordered delayed chunks without leaking timers", async t => {
  const fixture = await startFixture(t, { textOnly: true, textOnlyReasoning: "real-fixture-reasoning", textOnlyChunks: ["first", "second"], textOnlyChunkDelayMs: 1 });
  try {
    const response = await fetch(`${fixture.fixture.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "fixture" }] }),
    });
    const text = await response.text();
    assert.match(text, /real-fixture-reasoning/);
    assert.ok(text.indexOf('first') < text.indexOf('second'));
    assert.match(text, /\[DONE\]/);
  } finally { await fixture.cleanup(); }
  assert.equal(fixture.fixture.activeTimerCount, 0);
});

test("fixture close aborts active background streams and timers within one second", async t => {
  const cleanups = [];
  const context = {
    addCleanup(_label, cleanup) { cleanups.push(cleanup); },
    registerPort() {},
  };
  const fixture = await startApprovalModelFixture(context, {
    backgroundJob: true,
    backgroundDelayMs: 120_000,
  });
  let cleanupPromise;
  t.after(() => cleanupPromise ??= cleanups[0]());
  const request = fetch(`${fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "BACKGROUND_CHILD_E2E" }] }),
  }).catch(() => null);
  await waitFor(() => fixture.activeBackgroundRequests === 1);
  const startedAt = Date.now();
  await (cleanupPromise ??= cleanups[0]());
  assert.ok(Date.now() - startedAt < 1_000, "fixture cleanup exceeded one second");
  assert.equal(fixture.activeBackgroundRequests, 0);
  assert.equal(fixture.activeResponseCount, 0);
  assert.equal(fixture.activeHandlerCount, 0);
  assert.equal(fixture.activeTimerCount, 0);
  await request;
});

test("question mode is opt-in and emits a valid AskUserQuestion tool call", async t => {
  const regular = await startFixture(t, );
  const regularCall = await requestToolCall(regular.fixture);
  assert.equal(regularCall.function.name, "bash", "default fixture behavior must remain the approval command");
  await regular.cleanup();

  const question = await startFixture(t, { question: true });
  const questionCall = await requestToolCall(question.fixture);
  assert.equal(questionCall.function.name, "AskUserQuestion");
  const input = JSON.parse(questionCall.function.arguments);
  assert.equal(input.questions.length, 1);
  assert.equal(input.questions[0].question, "请选择部署方式");
  assert.equal(input.questions[0].options.length, 2);
  assert.equal(input.questions[0].multi_select, false);
  await question.cleanup();
});

test("http error mode returns the configured provider failure only for the matching prompt", async t => {
  const failure = await startFixture(t, {
    httpErrorPrompt: "PROVIDER_FAILURE",
    httpErrorStatus: 401,
    httpErrorMessage: "Incorrect API key secret-value",
  });
  const response = await fetch(`${failure.fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "PROVIDER_FAILURE" }] }),
  });
  assert.equal(response.status, 401);
  assert.match(await response.text(), /Incorrect API key secret-value/);
  const normalResponse = await fetch(`${failure.fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "NORMAL_REQUEST" }] }),
  });
  assert.equal(normalResponse.status, 200);
  assert.match(normalResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  await normalResponse.text();
  await failure.cleanup();
});

test("http error match limit can fail the first matching request and allow its retry", async t => {
  const fixture = await startFixture(t, {
    httpErrorPrompt: "RETRY_ONCE",
    httpErrorMatchLimit: 1,
    httpErrorStatus: 503,
    httpErrorMessage: "temporary deterministic outage",
    textOnly: true,
    textOnlyResponse: "RETRY_RECOVERED",
  });
  const request = () => fetch(`${fixture.fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "RETRY_ONCE" }] }),
  });

  const failed = await request();
  assert.equal(failed.status, 503);
  assert.match(await failed.text(), /temporary deterministic outage/);

  const recovered = await request();
  assert.equal(recovered.status, 200);
  assert.match(await recovered.text(), /RETRY_RECOVERED/);
  assert.equal(fixture.fixture.requests.length, 2);
  await fixture.cleanup();
});

test("text-only fixture extracts prompt text from multimodal user content", async t => {
  const fixture = await startFixture(t, {
    textOnly: true,
    textOnlyResponse: ({ userText }) => `SEEN:${userText}`,
  });
  const response = await fetch(`${fixture.fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{
      role: "user",
      content: [
        { type: "text", text: "MULTIMODAL_PROMPT" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    }] }),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /SEEN:MULTIMODAL_PROMPT/);
  await fixture.cleanup();
});

async function startFixture(t, options = {}) {
  const cleanups = [];
  const fixture = await startApprovalModelFixture({
    addCleanup(_label, cleanup) { cleanups.push(cleanup); },
    registerPort() {},
  }, options);
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= cleanups[0]();
  t.after(cleanup);
  return { fixture, cleanup };
}

async function requestToolCall(fixture) {
  const response = await fetch(`${fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "probe" }] }),
  });
  const body = await response.text();
  const events = body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  const call = events.flatMap(event => event.choices ?? []).flatMap(choice => choice.delta?.tool_calls ?? [])[0];
  assert.ok(call, `fixture did not emit a tool call: ${body}`);
  return call;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("fixture did not start background request");
}


test("compaction fixture honors the structured summary response format", async t => {
  const fixture = await startFixture(t, { textOnly: true, compactionSummary: true });
  try {
    const response = await fetch(`${fixture.fixture.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Summarize history" }], response_format: { type: "json_schema", json_schema: { name: "kcoder_compaction_summary" } } }),
    });
    const chunks = (await response.text()).split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const content = chunks.map(chunk => chunk.choices?.[0]?.delta?.content ?? "").join("");
    assert.deepEqual(JSON.parse(content), { summary: "deterministic compacted history" });
  } finally { await fixture.cleanup(); }
});

test("Anthropic fixture rejects incompatible budgets and emits its declared protocol", async t => {
  const fixture = await startFixture(t, { protocol: "anthropic", textOnlyResponse: "BUDGET_OK" });
  try {
    const post = budget => fetch(`${fixture.fixture.baseUrl}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture", max_tokens: 2048, thinking: { type: "enabled", budget_tokens: budget }, messages: [] }),
    });
    const invalid = await post(2048);
    assert.equal(invalid.status, 400);
    await invalid.text();
    const valid = await post(1024);
    assert.equal(valid.status, 200);
    const text = await valid.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /BUDGET_OK/);
    assert.match(text, /event: message_stop/);
    assert.equal(text.includes("chat.completion.chunk"), false);
    assert.equal(fixture.fixture.requests.length, 2);
  } finally { await fixture.cleanup(); }
});
