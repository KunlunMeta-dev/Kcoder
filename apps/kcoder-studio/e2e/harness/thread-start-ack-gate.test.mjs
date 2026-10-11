import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeThreadStartAckGateWrapper,
  readThreadStartGateEvents,
  releaseThreadStartGate,
} from "./thread-start-ack-gate.mjs";
import { startProviderRequestObserver } from "./provider-request-observer.mjs";
import { waitFor } from "./run-context.mjs";

test("stdio gate delays thread/start and preserves matching delete request/response IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "kcoder-thread-start-gate-"));
  const gateDir = join(root, "gate");
  const backendPath = join(root, "fake-backend");
  const wrapperPath = join(root, "gate-wrapper");
  const eventsPath = join(gateDir, "events.jsonl");
  await mkdir(gateDir, { mode: 0o700 });
  let child;
  try {
    await writeFile(backendPath, [
      "#!/usr/bin/env node",
      "const readline = require('node:readline');",
      "const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "input.on('line', line => {",
      "  const request = JSON.parse(line);",
      "  const result = request.method === 'thread/start' ? { thread: { id: 'thread-gate-fixture' } } : { deleted: true };",
      "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');",
      "});",
      "",
    ].join("\n"), { mode: 0o700, flag: "wx" });
    await chmod(backendPath, 0o700);
    const wrapperSource = makeThreadStartAckGateWrapper({ backendBinary: backendPath, gateDir, gateEventsPath: eventsPath });
    await writeFile(wrapperPath, wrapperSource, { mode: 0o700, flag: "wx" });
    await chmod(wrapperPath, 0o700);

    child = spawn(process.execPath, [wrapperPath], { stdio: ["pipe", "pipe", "pipe"] });
    const outputFrames = [];
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on("line", line => outputFrames.push(JSON.parse(line)));
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    await waitFor(() => outputFrames.find(frame => frame.id === 1) ?? null, 3_000, "fake backend initialize response");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { clientRequestId: "receipt-fixture" } })}\n`);
    const held = await waitFor(
      async () => (await readThreadStartGateEvents(eventsPath)).find(event => event.kind === "held") ?? null,
      3_000,
      "held thread/start fixture response",
    );
    assert.equal(held.index, 1);
    assert.equal(held.requestId, 2);
    assert.equal(held.threadId, "thread-gate-fixture");
    assert.equal(held.hasClientRequestId, true);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 40));
    assert.equal(outputFrames.some(frame => frame.id === 2), false, "thread/start response stays held until the run-owned release marker appears");

    await releaseThreadStartGate(gateDir, 1);
    const released = await waitFor(
      async () => (await readThreadStartGateEvents(eventsPath)).find(event => event.kind === "released") ?? null,
      3_000,
      "released thread/start fixture response",
    );
    assert.equal(released.requestId, held.requestId);
    await waitFor(() => outputFrames.find(frame => frame.id === 2) ?? null, 3_000, "released thread/start response");

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "thread/delete", params: { threadId: held.threadId } })}\n`);
    const forwarded = await waitFor(
      async () => (await readThreadStartGateEvents(eventsPath)).find(event => event.kind === "delete-forwarded") ?? null,
      3_000,
      "forwarded compensating delete fixture request",
    );
    const deletion = await waitFor(
      async () => (await readThreadStartGateEvents(eventsPath)).find(event => event.kind === "delete-response") ?? null,
      3_000,
      "matching app-server delete fixture response",
    );
    assert.equal(forwarded.idPresent, true);
    assert.equal(Number.isSafeInteger(forwarded.requestId), true);
    assert.equal(deletion.requestId, forwarded.requestId);
    assert.equal(deletion.threadId, held.threadId);
    assert.equal(deletion.ok, true);
    await waitFor(() => outputFrames.find(frame => frame.id === 3) ?? null, 3_000, "forwarded delete response");
    const childExit = once(child, "exit");
    child.stdin.end();
    const [code] = await childExit;
    assert.equal(code, 0, stderr);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise(resolveDelay => setTimeout(resolveDelay, 2_000))]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Provider observer is a local 503 sink and records no request body", async () => {
  const registeredPorts = [];
  const cleanups = [];
  const context = {
    registerPort(label, port) { registeredPorts.push({ label, port }); },
    addCleanup(label, callback) { cleanups.push({ label, callback }); },
  };
  const observer = await startProviderRequestObserver(context, "isolated-provider-observer-test");
  try {
    const response = await fetch(`${observer.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "sensitive request fixture",
    });
    assert.equal(response.status, 503);
    assert.deepEqual(observer.requests, [{ method: "POST", path: "/v1/chat/completions", bytes: 25 }]);
    assert.equal(registeredPorts.length, 1);
    assert.equal(cleanups.length, 1);
  } finally {
    await observer.close();
    await observer.close();
  }
});
