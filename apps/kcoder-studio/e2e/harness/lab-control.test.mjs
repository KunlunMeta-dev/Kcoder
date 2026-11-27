import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, resolve } from "node:path";
import test from "node:test";
import { RunContext, repoRoot } from "./run-context.mjs";
import { startLabControl, unavailableLabStatus, validLabRunManifest, waitForLabStop } from "./lab-control.mjs";
import { materializeWorkspace } from "./workspace-fixture.mjs";

const execFileAsync = promisify(execFile);

async function createContext(t) {
  const context = await RunContext.create(import.meta.url, { testId: "lab-control-contract", tier: "harness-unit" });
  t.after(async () => {
    if (!context.finished) await context.finish("failed", { testCleanup: true }).catch(() => {});
    await rm(context.runRoot, { recursive: true, force: true });
  });
  return context;
}

test("lab control is loopback-only, authenticated, and stop is acknowledged before owner cleanup", async t => {
  const context = await createContext(t);
  const control = await startLabControl(context, { getStatus: async () => ({ phase: "ready", gatewayUrl: "http://127.0.0.1:41731/" }) });
  const unauthorized = await fetch(`${control.baseUrl}/status`);
  assert.equal(unauthorized.status, 401);

  const status = await fetch(`${control.baseUrl}/status`, { headers: { authorization: `Bearer ${control.token}` } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { phase: "ready", gatewayUrl: "http://127.0.0.1:41731/" });

  const acknowledged = await fetch(`${control.baseUrl}/stop`, { method: "POST", headers: { authorization: `Bearer ${control.token}` } });
  assert.equal(acknowledged.status, 202);
  assert.deepEqual(await acknowledged.json(), { accepted: true });
  assert.deepEqual(await control.stopRequested, { reason: "requested" });
  await control.close();
  await context.finish("passed", { controlledStop: true });
  await assert.rejects(access(context.stateDir), { code: "ENOENT" });
});

test("lab manifest validation rejects unrelated and already-finished runs", () => {
  const valid = {
    schemaVersion: 1,
    source: "apps/kcoder-studio/e2e/lab.mjs",
    testId: "interactive-studio-lab",
    status: "running",
    seed: "fixture",
    processes: [{ label: "lab-gateway", pid: 31, pgid: 31, command: "node", stopped: false }],
    ports: [{ label: "lab-gateway", port: 41731 }],
    temporaryDirectories: ["state", "state/workspaces/lab-workspace"],
    workspaceFixtures: [{ id: "minimal", path: "state/workspaces/lab-workspace" }],
  };
  assert.equal(validLabRunManifest(valid, "20261122-000000.000Z"), true);
  assert.equal(validLabRunManifest({ ...valid, status: "passed" }, "20261122-000000.000Z", { activeOnly: false }), true);
  assert.equal(validLabRunManifest({ ...valid, status: "passed" }, "20261122-000000.000Z"), false);
  assert.equal(validLabRunManifest({ ...valid, source: "apps/kcoder-studio/e2e/private/old.mjs" }, "20261122-000000.000Z"), false);
  assert.equal(validLabRunManifest({ ...valid, status: "passed" }, "20261122-000000.000Z"), false);
  assert.equal(validLabRunManifest({ ...valid, processes: [{ ...valid.processes[0], pid: "31" }] }, "20261122-000000.000Z"), false);
  assert.equal(validLabRunManifest({ ...valid, ports: [{ label: "lab-gateway", port: 70_000 }] }, "20261122-000000.000Z"), false);
  assert.equal(validLabRunManifest({ ...valid, workspaceFixtures: [{ id: "minimal", path: "../../other-run" }] }, "20261122-000000.000Z"), false);
});

test("lab wait rejects on timeout, interruption, and unexpected owner exit", async () => {
  await assert.rejects(waitForLabStop(new Promise(() => {}), { timeoutMs: 10 }), /timed out after 10ms/);

  const controller = new AbortController();
  const pending = waitForLabStop(new Promise(() => {}), { timeoutMs: 1000, signal: controller.signal });
  controller.abort(new Error("test interruption"));
  await assert.rejects(pending, /test interruption/);

  const owner = new EventEmitter();
  owner.exitCode = null;
  owner.signalCode = null;
  const exiting = waitForLabStop(new Promise(() => {}), { timeoutMs: 1000, ownerProcess: owner });
  assert.equal(owner.listenerCount("exit"), 1);
  owner.emit("exit", 17, null);
  await assert.rejects(exiting, /owned Gateway exited unexpectedly \(code=17, signal=null\)/);
  assert.equal(owner.listenerCount("exit"), 0);

  owner.exitCode = 0;
  await assert.rejects(waitForLabStop(new Promise(() => {}), { timeoutMs: 1000, ownerProcess: owner }), /owned Gateway exited unexpectedly \(code=0, signal=null\)/);

  assert.deepEqual(await waitForLabStop(Promise.resolve({ reason: "requested" }), { timeoutMs: 100 }), { reason: "requested" });
});

test("unavailable owner report retains and enumerates only recorded lab resources", () => {
  const report = unavailableLabStatus({
    runId: "20261122-010203.004Z",
    runRoot: "/target/e2e/2026/11/22/lab/20261122-010203.004Z",
    manifest: {
      processes: [{ label: "lab-gateway", pid: 501, pgid: 501, command: "node", stopped: false }],
      ports: [{ label: "lab-gateway", port: 41234 }, { label: "lab-control", port: 41235 }],
      temporaryDirectories: ["state", "state/workspaces/lab-workspace"],
      workspaceFixtures: [{ id: "minimal", path: "state/workspaces/lab-workspace" }],
    },
    session: {
      ownerPid: 499,
      workspace: "/tmp/run/workspace",
      home: "/tmp/run/home",
      gatewayConfig: "/tmp/run/config",
      targetProfile: "/tmp/run/profile",
    },
  });
  assert.equal(report.cleanup, "retained-unconfirmed");
  assert.deepEqual(report.resources, {
    workspace: "/tmp/run/workspace",
    home: "/tmp/run/home",
    configDirectory: "/tmp/run/config",
    targetProfile: "/tmp/run/profile",
    runRoot: "/target/e2e/2026/11/22/lab/20261122-010203.004Z",
    stateDirectory: "/target/e2e/2026/11/22/lab/20261122-010203.004Z/state",
    temporaryDirectories: ["state", "state/workspaces/lab-workspace"],
    workspaceFixtures: [{ id: "minimal", path: "state/workspaces/lab-workspace" }],
  });
  assert.equal(report.processes[0].pid, 501);
  assert.deepEqual(report.ports.map(port => port.port), [41234, 41235]);
});

test("CLI status and stop retain real owned resources when the control listener is unavailable", async t => {
  const context = await RunContext.create(new URL("../lab.mjs", import.meta.url), {
    testId: "interactive-studio-lab",
    tier: "harness-unit",
    modelPolicy: "owned loopback lifecycle test; no model request",
  });
  t.after(async () => {
    if (!context.finished) await context.finish("failed", { testCleanup: true }).catch(() => {});
    await rm(context.runRoot, { recursive: true, force: true });
  });

  context.registerTemporaryDirectory("state", context.stateDir);
  const workspace = (await materializeWorkspace(context, "minimal", { instanceId: "lab-workspace" })).path;
  const home = context.pathInState("home");
  const gatewayConfig = context.pathInState("gateway-config");
  const targetProfile = context.pathInState("target-profile");
  await Promise.all([home, gatewayConfig, targetProfile].map(path => mkdir(path, { recursive: true, mode: 0o700 })));

  const gatewayPort = await unusedLoopbackPort();
  const modelPort = await unusedLoopbackPort();
  assert.notEqual(gatewayPort, modelPort);
  const gateway = context.spawnOwned("lab-gateway", process.execPath, ["-e", "const http = require('node:http'); http.createServer((_request, response) => response.end('owned-gateway')).listen(Number(process.argv[1]), '127.0.0.1'); setInterval(() => {}, 1000);", String(gatewayPort)], {
    cwd: repoRoot,
    env: context.isolatedEnvironment(),
  });
  if (gateway.pid === undefined) await once(gateway, "spawn");
  assert.ok(Number.isSafeInteger(gateway.pid));
  context.registerPort("lab-gateway", gatewayPort);
  context.registerPort("model stream text-completion/interactive", modelPort);
  await waitForGateway(gatewayPort);

  const control = await startLabControl(context, { getStatus: async () => ({ phase: "ready" }) });
  const modelControlToken = "owned-model-controller-token-for-outage";
  context.registerSecret(modelControlToken);
  await context.writeStateJson("lab-session.json", {
    schemaVersion: 1,
    ownerPid: process.pid,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}/`,
    gatewayPid: gateway.pid,
    gatewayPort,
    workspace,
    home,
    gatewayConfig,
    targetProfile,
    rendererRoot: repoRoot,
    kcoderBin: process.execPath,
    templateId: "minimal",
    templateVersion: 1,
    scenarioId: "text-completion",
    operationId: "interactive",
    modelRequestMarker: "KCODER_E2E:text-completion",
    modelEndpoint: `http://127.0.0.1:${modelPort}/v1`,
    modelControlUrl: `http://127.0.0.1:${modelPort}/__control/text-completion/interactive`,
    modelControlToken,
    phase: "ready",
  });
  await context.writeManifest("running");
  await control.close();

  const script = resolve(repoRoot, "apps/kcoder-studio/e2e/lab.mjs");
  const runId = basename(context.runRoot);
  const status = await execFileAsync(process.execPath, [script, "status", runId], { cwd: repoRoot, encoding: "utf8" });
  const report = JSON.parse(status.stdout);
  const controlPort = Number(new URL(control.baseUrl).port);
  assert.equal(report.phase, "control-unavailable");
  assert.equal(report.cleanup, "retained-unconfirmed");
  assert.equal(report.ownerPid, process.pid);
  assert.equal(report.resources.workspace, workspace);
  assert.equal(report.resources.home, home);
  assert.equal(report.resources.configDirectory, gatewayConfig);
  assert.equal(report.processes[0].pid, gateway.pid);
  assert.deepEqual(report.ports.map(port => port.port).sort((a, b) => a - b), [gatewayPort, modelPort, controlPort].sort((a, b) => a - b));

  const stop = await execFileAsync(process.execPath, [script, "stop", runId], { cwd: repoRoot, encoding: "utf8" }).then(
    value => ({ ...value, code: 0 }),
    error => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }),
  );
  assert.equal(stop.code, 1);
  assert.match(stop.stderr, /Lab owner is unavailable/);
  const retained = JSON.parse(stop.stdout);
  assert.equal(retained.cleanup, "retained-unconfirmed");
  assert.equal(retained.processes[0].pid, gateway.pid);
  assert.match(await readFile(resolve(workspace, "README.md"), "utf8"), /KCoder E2E 最小工作区/);
  assert.ok(await access(home).then(() => true));
  assert.ok(await access(context.stateDir).then(() => true));
  assert.doesNotThrow(() => process.kill(gateway.pid, 0), "CLI stop must not kill a PID when it cannot reattach the original owner");
  assert.equal(await fetch(`http://127.0.0.1:${gatewayPort}`).then(response => response.text()), "owned-gateway");

  await context.finish("passed", { controlOutage: "retained-without-owner-cleanup", recordedProcessPid: gateway.pid });
  assert.ok(gateway.exitCode !== null || gateway.signalCode !== null, "the original RunContext owner should terminate its exact child");
  await assert.rejects(access(context.stateDir), { code: "ENOENT" });
  await assert.rejects(fetch(`http://127.0.0.1:${gatewayPort}`));
});

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate loopback test port");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForGateway(port) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}`).catch(() => null);
    if (response?.status === 200 && await response.text() === "owned-gateway") return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`owned test Gateway did not start on ${port}`);
}
