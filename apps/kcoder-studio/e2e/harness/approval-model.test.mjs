import assert from "node:assert/strict";
import test from "node:test";
import { startApprovalModelFixture } from "./approval-model.mjs";

test("scripted protocol deltas stay ordered and gated responses cancel on cleanup", async () => {
  const fixture = await startFixture({
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

test("text fixture delivers reasoning and ordered delayed chunks without leaking timers", async () => {
  const fixture = await startFixture({ textOnly: true, textOnlyReasoning: "real-fixture-reasoning", textOnlyChunks: ["first", "second"], textOnlyChunkDelayMs: 1 });
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

test("fixture close aborts active background streams and timers within one second", async () => {
  const cleanups = [];
  const context = {
    addCleanup(_label, cleanup) { cleanups.push(cleanup); },
    registerPort() {},
  };
  const fixture = await startApprovalModelFixture(context, {
    backgroundJob: true,
    backgroundDelayMs: 120_000,
  });
  const request = fetch(`${fixture.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "BACKGROUND_CHILD_E2E" }] }),
  }).catch(() => null);
  await waitFor(() => fixture.activeBackgroundRequests === 1);
  const startedAt = Date.now();
  await cleanups[0]();
  assert.ok(Date.now() - startedAt < 1_000, "fixture cleanup exceeded one second");
  assert.equal(fixture.activeBackgroundRequests, 0);
  assert.equal(fixture.activeResponseCount, 0);
  assert.equal(fixture.activeHandlerCount, 0);
  assert.equal(fixture.activeTimerCount, 0);
  await request;
});

test("question mode is opt-in and emits a valid AskUserQuestion tool call", async () => {
  const regular = await startFixture();
  const regularCall = await requestToolCall(regular.fixture);
  assert.equal(regularCall.function.name, "bash", "default fixture behavior must remain the approval command");
  await regular.cleanup();

  const question = await startFixture({ question: true });
  const questionCall = await requestToolCall(question.fixture);
  assert.equal(questionCall.function.name, "AskUserQuestion");
  const input = JSON.parse(questionCall.function.arguments);
  assert.equal(input.questions.length, 1);
  assert.equal(input.questions[0].question, "请选择部署方式");
  assert.equal(input.questions[0].options.length, 2);
  assert.equal(input.questions[0].multi_select, false);
  await question.cleanup();
});

test("http error mode returns the configured provider failure only for the matching prompt", async () => {
  const failure = await startFixture({
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

test("http error match limit can fail the first matching request and allow its retry", async () => {
  const fixture = await startFixture({
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

test("text-only fixture extracts prompt text from multimodal user content", async () => {
  const fixture = await startFixture({
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

async function startFixture(options = {}) {
  const cleanups = [];
  const fixture = await startApprovalModelFixture({
    addCleanup(_label, cleanup) { cleanups.push(cleanup); },
    registerPort() {},
  }, options);
  return { fixture, cleanup: cleanups[0] };
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


test("compaction fixture honors the structured summary response format", async () => {
  const fixture = await startFixture({ textOnly: true, compactionSummary: true });
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
