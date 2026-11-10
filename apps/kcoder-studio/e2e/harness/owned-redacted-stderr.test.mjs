import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRedactingStream } from "./run-context.mjs";
import { captureOwnedRedactedStderr } from "./owned-redacted-stderr.mjs";
import { startGateway } from "./gateway.mjs";
import { BROKER_OWNERSHIP_TAG, brokerOwnershipDiagnosticGatewayOptions, parseBrokerOwnershipObserverLog } from "./broker-ownership-observer.mjs";

const secret = "REGISTERED_CAPTURE_SECRET";

function fixture(label = "owned-gateway", secrets = [secret]) {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const stdoutRedactor = createRedactingStream(value => redact(value), () => secrets);
  const stderrRedactor = createRedactingStream(value => redact(value), () => secrets);
  const combined = [];
  const redact = text => secrets.reduce((value, current) => value.split(current).join("[REDACTED]"), text);
  stdout.pipe(stdoutRedactor); stderr.pipe(stderrRedactor);
  stdoutRedactor.on("data", data => combined.push(data.toString()));
  stderrRedactor.on("data", data => combined.push(data.toString()));
  const record = { label, redactors: [stdoutRedactor, stderrRedactor] };
  let stopped = false;
  const context = {
    processes: new Map([[label, record]]), cleanups: [], artifacts: new Map(), stopCalls: 0,
    addCleanup(name, callback) { this.cleanups.push({ name, callback }); },
    async stopOwned(owner) {
      assert.equal(owner, record.label);
      this.stopCalls++;
      if (stopped) return;
      stopped = true;
      const completion = Promise.all([finished(stdoutRedactor), finished(stderrRedactor)]);
      stdout.end(); stderr.end();
      await completion;
    },
    async writeArtifactJsonInternal(name, value) { this.artifacts.set(name, value); },
  };
  return { context, label, record, stdout, stderr, stdoutRedactor, stderrRedactor, combined };
}

test("capture isolates owned redacted stderr and retains the redactor's buffered tail through cleanup", async () => {
  const value = fixture();
  const capture = captureOwnedRedactedStderr(value.context, value.label);
  let peerEvents = 0;
  const peer = () => { peerEvents++; };
  value.stderrRedactor.on("data", peer);
  value.stdout.write("STDOUT_STARTUP_BANNER\n");
  value.stderr.write(`diagnostic ${secret.slice(0, 9)}`);
  value.stderr.write(`${secret.slice(9)} tail\n`);
  assert.equal(capture.snapshot().complete, false);
  await value.context.cleanups[0].callback();
  const captured = value.context.artifacts.get(capture.artifactName);
  assert.equal(captured.complete, true);
  assert.equal(captured.text, "diagnostic [REDACTED] tail\n");
  assert.equal(captured.text.includes("STDOUT_STARTUP_BANNER"), false);
  assert.equal(captured.text.includes(secret), false);
  assert.ok(value.combined.join("").includes("STDOUT_STARTUP_BANNER"), "the original combined output remains available");
  assert.equal(value.combined.join("").includes(secret), false);
  assert.ok(peerEvents > 0);
  assert.ok(value.stderrRedactor.listeners("data").includes(peer), "cleanup removes only this tap's listener");
  assert.equal(captured.ended, true);
  assert.equal(captured.finalized, true);
});

test("fixed capacity marks truncation incomplete without truncating the original combined channel", async () => {
  const value = fixture();
  const capture = captureOwnedRedactedStderr(value.context, value.label, { maxBytes: 16 });
  const payload = `${"x".repeat(150)}\n`;
  for (const character of payload) value.stderr.write(character);
  await value.context.cleanups[0].callback();
  const captured = capture.snapshot();
  assert.equal(captured.retainedBytes, 16);
  assert.equal(captured.receivedBytes, Buffer.byteLength(payload));
  assert.equal(captured.pendingQueueBytes, 0);
  assert.equal(captured.overflow, true);
  assert.equal(captured.complete, false);
  assert.ok(captured.incompleteReasons.includes("stderr-capture-capacity-exceeded"));
  assert.equal(value.combined.join(""), payload);
});

test("missing owned redactor never falls back to another process or raw stderr", async () => {
  const peer = fixture("peer-gateway");
  peer.context.stopOwned = async () => {};
  const capture = captureOwnedRedactedStderr(peer.context, "missing-gateway");
  peer.stderr.write("PEER_ONLY\n");
  await peer.context.cleanups[0].callback();
  const captured = capture.snapshot();
  assert.equal(captured.text, "");
  assert.equal(captured.complete, false);
  assert.ok(captured.incompleteReasons.includes("owned-stderr-redactor-unavailable"));
  assert.ok(captured.incompleteReasons.includes("stderr-redactor-end-not-observed"));
  peer.stdout.end(); peer.stderr.end();
});

test("stream errors and unconfirmed stop retain incomplete diagnostics and the original cleanup error", async () => {
  const value = fixture();
  const capture = captureOwnedRedactedStderr(value.context, value.label);
  const failure = new Error(secret);
  value.stderrRedactor.destroy(failure);
  await assert.rejects(value.context.cleanups[0].callback(), error => error === failure);
  const captured = capture.snapshot();
  assert.equal(captured.complete, false);
  assert.ok(captured.incompleteReasons.includes("stderr-redactor-error"));
  assert.ok(captured.incompleteReasons.includes("owned-process-stop-unconfirmed"));
  assert.equal(JSON.stringify(captured).includes(secret), false);
});

function taggedRecords() {
  const envelope = (event, sequence, extra = {}) => ({
    schemaVersion: 1, evidenceClass: "instrumented-broker-ownership-diagnostic", event, sequence, ...extra,
  });
  return [envelope("observer-installed", 1), envelope("restart-pre-receive", 2, {
    snapshotPoint: "before-original-receive", allCountsKnown: true,
    counts: { restartRequest: 0, clients: 1, pending: 0, liveTerminals: 0, threadDrains: 0,
      browserOwners: 0, projectAutomationPending: 0, activeTurns: 0, activeAutomationThreads: 0 },
    context: { validRestartRequest: true, force: false, initialized: true, restartAvailable: true },
    observer: { records: 1, criticalRecords: 1, dropped: 0, errors: 0 },
  })].map(record => `${BROKER_OWNERSHIP_TAG}${JSON.stringify(record)}\n`).join("");
}

test("capture rejoins split tags and JSON and parser recognizes same-stderr prefix text", async () => {
  const value = fixture();
  const capture = captureOwnedRedactedStderr(value.context, value.label);
  const text = `stderr prefix without newline: ${taggedRecords()}`;
  for (const character of text) value.stderr.write(character);
  await value.context.cleanups[0].callback();
  const parsed = parseBrokerOwnershipObserverLog(capture.snapshot().text);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.observerInstalled, true);
  assert.deepEqual(parsed.records.map(record => record.sequence), [1, 2]);
  const malformed = parseBrokerOwnershipObserverLog(`${capture.snapshot().text}stderr prefix ${BROKER_OWNERSHIP_TAG}{broken\n`);
  assert.equal(malformed.complete, false);
  assert.equal(malformed.parseFailures, 1);
});

async function gatewayFixture(t) {
  const value = fixture("owned-gateway", []);
  const directory = await mkdtemp(join(tmpdir(), "kcoder-stderr-capture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  Object.assign(value.context, {
    logsDir: directory,
    isolatedEnvironment(overrides) { return overrides; },
    registerSecret() {}, registerPort() {},
    spawnOwned(label, command, args, options) {
      this.spawnOptions = options;
      assert.equal(Object.hasOwn(options, "redactedStderrDiagnostics"), false);
      writeFileSync(join(directory, `${label}.log`), "KCoder Studio: http://127.0.0.1:43210\n");
      this.addCleanup(`stop process ${label}`, () => this.stopOwned(label));
      queueMicrotask(() => value.stderr.write(taggedRecords()));
      return { exitCode: null };
    },
  });
  return value;
}

test("Gateway installs capture synchronously before its first await and cleanup flushes before persistence", async t => {
  const value = await gatewayFixture(t);
  const diagnostics = brokerOwnershipDiagnosticGatewayOptions({ env: { KCODER_E2E_SETTINGS_BROKER_DIAGNOSTICS: "1" } });
  const gateway = await startGateway(value.context, { ...diagnostics, label: value.label, env: diagnostics.env });
  assert.ok(gateway.stderrDiagnostics.snapshot().text.includes('"observer-installed"'), "the preload's first microtask record must be captured");
  const combinedListenerCount = value.stderrRedactor.listenerCount("data");
  assert.equal(combinedListenerCount, 2);
  for (const cleanup of [...value.context.cleanups].reverse()) await cleanup.callback();
  assert.equal(value.stderrRedactor.listenerCount("data"), 1);
  const captured = value.context.artifacts.get("broker-ownership-stderr.json");
  assert.equal(captured.complete, true);
  assert.equal(parseBrokerOwnershipObserverLog(captured.text).complete, true);
});

test("default Gateway options create no observer injection, collector or diagnostic artifact", async t => {
  const value = await gatewayFixture(t);
  const diagnostics = brokerOwnershipDiagnosticGatewayOptions({ env: { NODE_OPTIONS: "--require=HOST_ONLY" } });
  assert.equal(diagnostics, null);
  const gateway = await startGateway(value.context, { ...diagnostics, label: value.label });
  assert.equal(gateway.stderrDiagnostics, null);
  assert.equal(Object.hasOwn(value.context.spawnOptions.env, "NODE_OPTIONS"), false);
  assert.equal(Object.hasOwn(value.context.spawnOptions.env, "KCODER_E2E_BROKER_OWNERSHIP_OBSERVER"), false);
  assert.equal(value.context.cleanups.length, 1);
  assert.equal(value.stderrRedactor.listenerCount("data"), 1);
  for (const cleanup of [...value.context.cleanups].reverse()) await cleanup.callback();
  assert.equal(value.context.artifacts.size, 0);
});
