import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startModelStreamController } from "./controller.mjs";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(harnessDir, "../../fixtures/model-stream/chat-completions/minimax");

async function loadScenario(name) {
  return JSON.parse(await readFile(resolve(fixtureRoot, name, "scenario.json"), "utf8"));
}

function request(marker, role = "user") {
  return {
    model: "MiniMax-M2.7",
    stream: true,
    messages: [{ role, content: marker }],
  };
}

function createOwner() {
  const cleanups = [];
  const secrets = [];
  const ports = [];
  return {
    context: {
      registerSecret(secret) { secrets.push(secret); },
      registerPort(label, port) { ports.push({ label, port }); },
      addCleanup(_label, cleanup) { cleanups.push(cleanup); },
    },
    async close() {
      for (const cleanup of cleanups.reverse()) await cleanup();
      assert.ok(secrets.every(secret => typeof secret === "string" && secret.length > 0));
      assert.ok(ports.every(entry => Number.isInteger(entry.port) && entry.port > 0));
    },
  };
}

test("synthetic MiniMax Chat Completions fixture pauses and releases SSE frames in order", async () => {
  const scenario = await loadScenario("text-completion");
  const owner = createOwner();
  const context = owner.context;

  try {
    const controller = await startModelStreamController(context, {
      scenarioId: scenario.id,
      operationId: "text-turn-1",
      scenario,
    });
    const responsePromise = fetch(`${controller.endpointUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request("KCODER_E2E:text-completion")),
    });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);

    const arrived = await controller.waitForRequest("initial");
    assert.equal(arrived.status, "streaming");
    assert.equal(arrived.framesWritten, 0);

    const reader = response.body.getReader();
    await controller.release("initial", { frames: 1 });
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /reasoning_content|role/);
    assert.equal(controller.snapshot().requests[0].framesWritten, 1);

    await controller.release("initial", { frames: "all" });
    let tail = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      tail += new TextDecoder().decode(next.value);
    }
    assert.match(tail, /KCODER_E2E:REPLY_COMPLETE/);
    assert.match(tail, /\[DONE\]/);
    assert.equal(controller.snapshot().requests[0].status, "completed");
  } finally {
    await owner.close();
  }
});

test("control HTTP API requires its run token and reports unknown and duplicate model requests", async () => {
  const scenario = await loadScenario("text-completion");
  const owner = createOwner();
  const context = owner.context;

  try {
    const controller = await startModelStreamController(context, {
      scenarioId: scenario.id,
      operationId: "text-turn-2",
      scenario,
    });
    const statusUrl = `${controller.controlUrl}/status`;
    const unauthorized = await fetch(statusUrl);
    assert.equal(unauthorized.status, 401);

    const wrong = await fetch(`${controller.endpointUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request("KCODER_E2E:wrong-marker")),
    });
    assert.equal(wrong.status, 409);
    await wrong.arrayBuffer();
    assert.equal(controller.snapshot().nextRequestIndex, 0);
    assert.equal(controller.snapshot().rejectedRequestCount, 1);

    const waiting = await controller.waitForRequest("initial", { timeoutMs: 1 }).catch(error => error);
    assert.match(waiting.message, /Timed out/);

    const correctPromise = fetch(`${controller.endpointUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request("KCODER_E2E:text-completion")),
    });
    const correct = await correctPromise;
    await controller.waitForRequest("initial");
    await controller.release("initial", { frames: "all" });
    await correct.arrayBuffer();

    const duplicate = await fetch(`${controller.endpointUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request("KCODER_E2E:text-completion")),
    });
    assert.equal(duplicate.status, 409);
    await duplicate.arrayBuffer();
    assert.equal(controller.snapshot().rejectedRequestCount, 2);

    const controlStatus = await fetch(statusUrl, {
      headers: { authorization: `Bearer ${controller.controlToken}` },
    });
    assert.equal(controlStatus.status, 200);
    const payload = await controlStatus.json();
    assert.equal(payload.requests[0].status, "completed");
    assert.equal(payload.rejectedRequestCount, 2);
  } finally {
    await owner.close();
  }
});

test("authenticated test transport reuses the scenario and can end before its terminal frame", async () => {
  const scenario = await loadScenario("text-completion");
  const owner = createOwner();
  const context = owner.context;

  try {
    const controller = await startModelStreamController(context, {
      scenarioId: scenario.id,
      operationId: "transport-turn-1",
      scenario,
    });
    const unauthorized = await fetch(`${controller.controlUrl}/transport`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request("KCODER_E2E:text-completion")),
    });
    assert.equal(unauthorized.status, 401);

    const fetchPromise = fetch(`${controller.controlUrl}/transport`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${controller.controlToken}`,
      },
      body: JSON.stringify(request("KCODER_E2E:text-completion")),
    });
    const response = await fetchPromise;
    assert.equal(response.status, 200);
    await controller.waitForRequest("initial");
    const reader = response.body.getReader();
    await controller.release("initial", { frames: 2 });
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(controller.snapshot().requests[0].framesWritten, 2);

    const disconnected = await controller.disconnect("initial");
    assert.equal(disconnected.status, "disconnected");
    await assert.rejects(reader.read());
  } finally {
    await owner.close();
  }
});

test("tool follow-up fixture has split arguments and a second request", async () => {
  const scenario = await loadScenario("tool-call-reconnect");
  assert.equal(scenario.source.kind, "synthetic");
  assert.match(scenario.source.description, /not a captured MiniMax response/i);
  assert.equal(scenario.requests.length, 2);
  const initialData = scenario.requests[0].frames
    .filter(frame => frame.startsWith("data: {"))
    .map(frame => JSON.parse(frame.slice(6).trim()));
  const argumentChunks = initialData.flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? [])
    .map(call => call.function?.arguments)
    .filter(Boolean);
  const toolCalls = initialData.flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? []);
  assert.equal(toolCalls.find(call => call.function?.name)?.function.name, "read");
  assert.ok(argumentChunks.length >= 2);
  assert.equal(argumentChunks.join(""), "{\"file_path\":\"README.md\"}");
  assert.equal(initialData.at(-1).choices[0].finish_reason, "tool_calls");
  assert.deepEqual(scenario.requests.map(item => item.id), ["initial", "after-tool"]);
  const followupData = scenario.requests[1].frames.slice(0, -1)
    .map(frame => JSON.parse(frame.slice(6).trim()));
  assert.deepEqual(followupData.map(frame => Object.keys(frame.choices[0].delta)), [
    ["role", "reasoning_content"],
    ["reasoning_content"],
    ["content"],
    ["content"],
    [],
  ]);
  assert.equal(followupData.at(-1).choices[0].finish_reason, "stop");
  assert.ok(followupData.at(-1).usage.total_tokens > 0);
  for (const request of scenario.requests) {
    assert.equal(request.frames.at(-1), "data: [DONE]\n\n");
  }
  const workspaceReadme = await readFile(resolve(harnessDir, "../../fixtures/workspaces/minimal/README.md"), "utf8");
  assert.ok(workspaceReadme.includes(scenario.requests[1].match.lastMessageIncludes));
});

test("captured MiniMax Chat Completions sample is replayable with its provenance exposed", async () => {
  const scenario = await loadScenario("captured/text-completion");
  const owner = createOwner();
  const context = owner.context;

  try {
    const controller = await startModelStreamController(context, {
      scenarioId: scenario.id,
      operationId: "captured-sample-turn-1",
      scenario,
    });
    const responsePromise = fetch(`${controller.endpointUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request("KCODER_E2E:captured-minimax-sample")),
    });
    const response = await responsePromise;
    await controller.waitForRequest("initial");
    await controller.release("initial", { frames: "all" });
    const body = await response.text();
    const snapshot = controller.snapshot();

    assert.equal(snapshot.source.kind, "captured");
    assert.equal(snapshot.source.provider, "MiniMax");
    assert.equal(snapshot.requests[0].frameCount, 6);
    assert.equal((body.match(/data: \{/g) ?? []).length, 5);
    assert.match(body, /"finish_reason":"stop"/);
    assert.match(body, /"cached_tokens":192/);
    assert.match(body, /data: \[DONE\]/);
    assert.doesNotMatch(body, /original-private-response-id|authorization|api[_ -]?key/i);
  } finally {
    await owner.close();
  }
});
