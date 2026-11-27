import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { startOwnedOllamaOpenAiProxy } from "./ollama-openai-proxy.mjs";

const body = {
  model: "qwen3.5:2b", stream: true, max_tokens: 8,
  messages: [{ role: "user", content: "START short fixture END" }],
};

test("registers cleanup before a port-registration failure can leak the listener", async t => {
  const cleanups = [];
  const registeredPorts = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  const context = {
    addCleanup(_label, cleanup) { cleanups.push(cleanup); },
    registerPort(_label, port) {
      registeredPorts.push(port);
      throw new Error("simulated RunContext port registration failure");
    },
  };
  await assert.rejects(
    startOwnedOllamaOpenAiProxy(context, {
      upstreamBaseUrl: "http://127.0.0.1:49001",
      stamp: () => ({ tick: Date.now() }),
      startSentinel: "START",
      endSentinel: "END",
    }),
    /simulated RunContext port registration failure/,
  );
  assert.equal(cleanups.length, 1);
  assert.equal(registeredPorts.length, 1);

  await cleanups.pop()();
  const probe = createServer();
  await new Promise((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(registeredPorts[0], "127.0.0.1", resolveListen);
  });
  await closeServer(probe);
});

test("forwards one standard OpenAI SSE and records separate reasoning/content events", async t => {
  let upstreamGenerationCount = 0;
  let admissions = [];
  const upstream = createServer((request, response) => {
    upstreamGenerationCount += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(admissions.length, 1, "durable admission metadata must exist before the upstream sees the request");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"reasoning_content":"r"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"c"},"finish_reason":"length"}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
  const fixtureResult = await fixture(t, upstream);
  const { proxy, closeFixture } = fixtureResult;
  admissions = fixtureResult.admissions;
  const first = await post(proxy.baseUrl, body);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "text/event-stream");
  assert.match(await first.text(), /\[DONE\]/);

  const second = await post(proxy.baseUrl, body);
  assert.equal(second.status, 429);
  assert.equal(upstreamGenerationCount, 1);
  const [record, rejected] = proxy.requests;
  assert.deepEqual({
    path: record.path,
    protocol: record.requestParameters.protocol,
    model: record.requestParameters.model,
    stream: record.requestParameters.stream,
    maxOutput: record.requestParameters.maxOutput,
    thinkFieldSent: record.requestParameters.thinkFieldSent,
    startSentinelPresent: record.requestParameters.startSentinelPresent,
    endSentinelPresent: record.requestParameters.endSentinelPresent,
  }, {
    path: "/v1/chat/completions",
    protocol: "openai-chat-completions",
    model: "qwen3.5:2b",
    stream: true,
    maxOutput: 8,
    thinkFieldSent: false,
    startSentinelPresent: true,
    endSentinelPresent: true,
  });
  assert.ok(record.providerRequestReceivedAt.tick < record.responseHeadersAt.tick);
  assert.ok(record.responseHeadersAt.tick < record.firstSseFrameAt.tick);
  assert.ok(record.firstSseReasoningAt.tick < record.firstSseContentAt.tick);
  assert.ok(record.firstSseContentAt.tick < record.terminalSseDoneAt.tick);
  assert.equal(record.finishReason, "length");
  assert.equal(record.contentBytes, 1);
  assert.equal(record.reasoningBytes, 1);
  assert.equal(record.admissionArtifactRecorded, true);
  assert.equal(record.admissionArtifact, "provider-generation-admission.json");
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].value.rawRequestBodyRetained, false);
  assert.equal(admissions[0].value.requestBodySha256, record.requestBodySha256);
  assert.equal(Object.hasOwn(admissions[0].value, "messages"), false);
  assert.equal(rejected.requestRejected, true);
  assert.equal(rejected.rejectionReason, "generation_cap");
  await closeFixture();
});

test("summarizes every user message without retaining content", async t => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: [DONE]\n\n");
  });
  const { proxy, closeFixture } = await fixture(t, upstream);
  const response = await post(proxy.baseUrl, {
    ...body,
    messages: [
      { role: "system", content: "system text" },
      { role: "user", content: "AGENTS instruction" },
      { role: "user", content: "START synthetic sentinel END" },
    ],
  });
  assert.equal(response.status, 200);
  const summary = proxy.requests[0].requestParameters;
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.userMessageCount, 2);
  assert.equal(summary.selectedUserMessageIndex, 1);
  assert.deepEqual(summary.userMessages.map(message => ({
    index: message.index,
    startSentinelPresent: message.startSentinelPresent,
    endSentinelPresent: message.endSentinelPresent,
  })), [
    { index: 0, startSentinelPresent: false, endSentinelPresent: false },
    { index: 1, startSentinelPresent: true, endSentinelPresent: true },
  ]);
  assert.equal(summary.startSentinelPresent, true);
  assert.equal(summary.endSentinelPresent, true);
  assert.equal(JSON.stringify(summary).includes("AGENTS instruction"), false);
  assert.equal(JSON.stringify(summary).includes("START synthetic sentinel END"), false);
  await closeFixture();
});

test("client abort closes the owned upstream stream and proxy promptly", async t => {
  let upstreamClosed = false;
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.on("close", () => { upstreamClosed = true; });
  });
  const { proxy, closeFixture } = await fixture(t, upstream);
  const controller = new AbortController();
  const pending = post(proxy.baseUrl, body, controller.signal);
  await waitFor(() => proxy.requests[0]?.upstreamRequestStartedAt);
  controller.abort();
  await assert.rejects(pending);
  await waitFor(() => upstreamClosed);
  const started = Date.now();
  await proxy.close();
  assert.ok(Date.now() - started < 1_000);
  await closeFixture();
});

test("oversized request is rejected before reaching the upstream", async t => {
  let upstreamGenerationCount = 0;
  const upstream = createServer(() => { upstreamGenerationCount += 1; });
  const { proxy, closeFixture } = await fixture(t, upstream);
  const response = await post(proxy.baseUrl, { ...body, padding: "x".repeat(1024 * 1024 + 1) });
  assert.equal(response.status, 413);
  assert.equal(upstreamGenerationCount, 0);
  assert.equal(proxy.requests[0].rejectionReason, "request_too_large");
  await closeFixture();
});

test("request outside the eight-output-token budget is rejected before forwarding", async t => {
  let upstreamGenerationCount = 0;
  const upstream = createServer(() => { upstreamGenerationCount += 1; });
  const { proxy, closeFixture } = await fixture(t, upstream);
  const response = await post(proxy.baseUrl, { ...body, max_tokens: 9 });
  assert.equal(response.status, 400);
  assert.equal(upstreamGenerationCount, 0);
  assert.equal(proxy.requests[0].rejectionReason, "probe_request_budget_or_protocol_mismatch");
  await closeFixture();
});

test("conflicting output-token aliases are rejected before reaching the upstream", async t => {
  let upstreamGenerationCount = 0;
  const upstream = createServer(() => { upstreamGenerationCount += 1; });
  const { proxy, closeFixture } = await fixture(t, upstream);
  const response = await post(proxy.baseUrl, {
    ...body,
    max_completion_tokens: 4096,
  });
  assert.equal(response.status, 400);
  assert.equal(upstreamGenerationCount, 0);
  assert.equal(proxy.requests[0].rejectionReason, "probe_request_budget_or_protocol_mismatch");
  await closeFixture();
});

test("multiple completion choices are rejected before reaching the upstream", async t => {
  let upstreamGenerationCount = 0;
  const upstream = createServer(() => { upstreamGenerationCount += 1; });
  const { proxy, closeFixture } = await fixture(t, upstream);
  const response = await post(proxy.baseUrl, { ...body, n: 2 });
  assert.equal(response.status, 400);
  assert.equal(upstreamGenerationCount, 0);
  assert.equal(proxy.requests[0].rejectionReason, "probe_request_budget_or_protocol_mismatch");
  await closeFixture();
});

test("provider-specific think fields and offered tools are rejected before forwarding", async t => {
  let upstreamGenerationCount = 0;
  const upstream = createServer(() => { upstreamGenerationCount += 1; });
  const { proxy, closeFixture } = await fixture(t, upstream);
  const response = await post(proxy.baseUrl, {
    ...body,
    think: false,
    tools: [{ type: "function", function: { name: "must_not_run" } }],
  });
  assert.equal(response.status, 400);
  assert.equal(upstreamGenerationCount, 0);
  assert.equal(proxy.requests[0].rejectionReason, "probe_request_budget_or_protocol_mismatch");
  await closeFixture();
});

test("an abort after durable admission stops before upstream dispatch", async t => {
  let upstreamGenerationCount = 0;
  const upstream = createServer(() => { upstreamGenerationCount += 1; });
  const { proxy, admissions, closeFixture } = await fixture(t, upstream, { abortAfterAdmission: true });
  const response = await post(proxy.baseUrl, body);
  assert.equal(response.status, 503);
  assert.equal(upstreamGenerationCount, 0);
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].value.stage, "validated-before-upstream-dispatch");
  assert.equal(proxy.requests[0].admissionArtifactRecorded, true);
  assert.equal(proxy.requests[0].upstreamRequestStartedAt, undefined);
  assert.equal(proxy.requests[0].rejectionReason, "run_aborting_or_admission_not_recorded");
  await closeFixture();
});

async function fixture(t, upstream, { abortAfterAdmission = false } = {}) {
  const cleanups = [];
  const admissions = [];
  const abortController = new AbortController();
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await closeServer(upstream);
  });
  const upstreamPort = await listen(upstream);
  const context = {
    registerPort() {},
    addCleanup(_label, cleanup) { cleanups.push(cleanup); },
    abortSignal: abortController.signal,
    async writeArtifactJson(name, value) {
      admissions.push({ name, value });
      if (abortAfterAdmission) abortController.abort(new Error("simulated run abort before upstream dispatch"));
    },
  };
  const ticks = { value: 0 };
  const proxy = await startOwnedOllamaOpenAiProxy(context, {
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    stamp: () => ({ tick: ++ticks.value }),
    startSentinel: "START",
    endSentinel: "END",
  });
  return { proxy, admissions, closeFixture: async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
    await closeServer(upstream);
  } };
}

async function post(baseUrl, value, signal) {
  return fetch(baseUrl + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
    ...(signal ? { signal } : {}),
  });
}
function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen(server.address().port);
    });
  });
}
function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
}
async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  assert.fail("proxy request was not forwarded before the unit-test deadline");
}
