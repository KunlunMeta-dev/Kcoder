import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { buildMarkedPythonSource, createSshStageObserver } from "../harness/owned-ssh-control-master.mjs";

assert.equal(process.version, "v22.17.0");
assert.equal(process.env.KCODER_E2E_CLEANUP_PUBLIC_114412_RELAY_ROOT, "1",
  "exact failed-run Relay cleanup requires explicit one-shot enable");

const parentRunRoot = resolve(repoRoot,
  "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs/20261009-114412.125Z");
const fixtureRoot = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-infra.e2e.mjs/20261007-183008.205Z/state";
const relayRuntimeRoot = resolve(repoRoot,
  "target/private-phone-ux-implementation/relay-eof-drain-20261009/controlled-run-01/runtime");
const lifecyclePath = resolve(repoRoot, "apps/kcoder-studio/e2e/harness/remote-relay-lifecycle.mjs");
const pinnedNode = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const expected = Object.freeze({
  runId: "07298b775c4c83b579b47034",
  relayRoot: "/tmp/kc-phone-ux-relay-07298b775c4c83b579b47034",
  pid: 284886,
  starttime: 121557552,
  euid: 1000,
  ports: { ingress: 32552, control: 44847, proxy: 35341 },
  nodeSha256: "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9",
  lifecycleSha256: "27eb561f414e3efeab40a1cc913f1874bd7fb575b943b1c0aa385720fce1ec14",
});

function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function extractJsonConstant(source, name, open, close) {
  const match = new RegExp(`const ${name} = Object\\.freeze\\(([\\s\\S]*?)\\);`).exec(source);
  assert.ok(match, `missing pinned ${name} constant`);
  const text = match[1].trim();
  assert.ok(text.startsWith(open) && text.endsWith(close), `invalid pinned ${name} shape`);
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}
function extractStringConstant(source, name) {
  const match = new RegExp(`const ${name} = "([^"]+)";`).exec(source);
  assert.ok(match, `missing pinned ${name} constant`);
  return match[1];
}
async function filePin(path) { return { bytes: (await stat(path)).size, sha256: await shaFile(path) }; }
async function shaFile(path) { const hash = createHash("sha256"); for await (const chunk of (await import("node:fs")).createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }

await runE2E(import.meta.url, {
  testId: "cleanup-public-114412-owned-remote-relay-root",
  tier: "manual-live", retainSuccessLogs: true, cleanupTimeoutMs: 60_000,
  modelPolicy: "remove only the exact 114412-run Relay root using the original ROOT_STOP owner, process, runtime, config, and store gates; no service start or Caddy action",
}, async context => {
  const parentManifestPath = resolve(parentRunRoot, "manifest.json");
  const parentResultPath = resolve(parentRunRoot, "artifacts/result.json");
  const inputBeforePath = resolve(parentRunRoot, "artifacts/inputs-before.json");
  const relayReadyPath = resolve(parentRunRoot, "artifacts/remote-relay-ready.json");
  const [parentManifestBytes, parentResultBytes, inputBeforeBytes, relayReadyBytes] = await Promise.all([
    readFile(parentManifestPath), readFile(parentResultPath), readFile(inputBeforePath), readFile(relayReadyPath),
  ]);
  const parentManifest = JSON.parse(parentManifestBytes.toString("utf8"));
  const parentResult = JSON.parse(parentResultBytes.toString("utf8"));
  const inputBefore = JSON.parse(inputBeforeBytes.toString("utf8"));
  const relay = JSON.parse(relayReadyBytes.toString("utf8"));
  assert.equal(parentManifest.status, "failed", "preserve the original failed business run");
  assert.equal(parentResult.status, "failed");
  const runId = createHash("sha256").update(`public-relay-direct:${parentManifest.seed}`).digest("hex").slice(0, 24);
  assert.equal(runId, expected.runId);
  assert.equal(relay.runId, expected.runId);
  assert.equal(relay.runRoot, expected.relayRoot);
  assert.equal(relay.pid, expected.pid);
  assert.equal(relay.starttime, expected.starttime);
  assert.equal(relay.euid, expected.euid);
  assert.deepEqual(relay.ports, expected.ports);
  assert.deepEqual(relay.argv, [
    `${expected.relayRoot}/node`, `${expected.relayRoot}/remote-relay-ingress.once.mjs`, `${expected.relayRoot}/relay-config.json`,
  ]);
  assert.equal(relay.cwd, expected.relayRoot);
  assert.deepEqual(inputBefore.nodeExe, { bytes: 121609656, sha256: expected.nodeSha256 });
  assert.equal(inputBefore.relayRuntimeRoot, relayRuntimeRoot);

  const lifecycleBytes = await readFile(lifecyclePath);
  assert.equal(sha(lifecycleBytes), expected.lifecycleSha256, "ROOT_STOP must be the original run-pinned implementation");
  assert.equal(inputBefore.executedRelayRuntime.remoteArchiveContract.harnessSha256, expected.lifecycleSha256);
  const lifecycleSource = lifecycleBytes.toString("utf8");
  const relayFilePins = extractJsonConstant(lifecycleSource, "RELAY_FILE_PINS", "{", "}");
  const wsFilePins = extractJsonConstant(lifecycleSource, "WS_FILE_PINS", "[", "]");
  assert.equal(extractStringConstant(lifecycleSource, "PINNED_NODE_SHA256"), expected.nodeSha256);
  const entryFile = extractStringConstant(lifecycleSource, "REMOTE_ENTRY_FILE");
  const entrySha = extractStringConstant(lifecycleSource, "REMOTE_ENTRY_SHA256");
  const rootStopMatch = /const ROOT_STOP = `([\s\S]*?)`;/m.exec(lifecycleSource);
  assert.ok(rootStopMatch && !rootStopMatch[1].includes("${") && !rootStopMatch[1].includes("`"),
    "use the fixed ROOT_STOP body without generating a broader cleanup program");
  const rootStop = vm.runInNewContext(`\`${rootStopMatch[1]}\``);
  assert.ok(rootStop.includes("os.pidfd_open") && rootStop.includes("signal.pidfd_send_signal") && rootStop.includes("os.unlink"));

  const fixtureInfo = await lstat(fixtureRoot);
  assert.ok(fixtureInfo.isDirectory() && !fixtureInfo.isSymbolicLink() && fixtureInfo.uid === process.getuid());
  assert.equal(fixtureInfo.mode & 0o777, 0o700);
  const fixture = JSON.parse(await readFile(resolve(fixtureRoot, "private-mobile-pairing-fixtures.json"), "utf8")).alpha;
  const registryPath = resolve(fixtureRoot, "relay-registration-store.json");
  const registryInfo = await lstat(registryPath);
  assert.ok(registryInfo.isFile() && !registryInfo.isSymbolicLink() && registryInfo.nlink === 1);
  assert.equal(registryInfo.uid, process.getuid()); assert.equal(registryInfo.mode & 0o777, 0o600);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const identityPath = resolve(fixtureRoot, "relay-client-alpha.json");
  const identityInfo = await lstat(identityPath);
  assert.ok(identityInfo.isFile() && !identityInfo.isSymbolicLink() && identityInfo.nlink === 1);
  assert.equal(identityInfo.uid, process.getuid()); assert.equal(identityInfo.mode & 0o777, 0o600);
  const identity = JSON.parse(await readFile(identityPath, "utf8"));
  for (const secret of [fixture?.id, fixture?.pairingToken, identity?.secret]) if (typeof secret === "string") context.registerSecret(secret);
  const entry = registry.gateways?.find(row => row.id === fixture?.id);
  assert.ok(entry && entry.id === identity.id && entry.secret === identity.secret && entry.pairingToken === fixture.pairingToken,
    "the cleanup store must be reconstructed from the original alpha fixture binding");
  const selectedStore = { version: registry.version, gateways: [entry] };
  assert.equal(selectedStore.gateways.length, 1);
  const storeBytes = Buffer.from(`${JSON.stringify(selectedStore, null, 2)}\n`);
  const storeSha256 = sha(storeBytes);

  const config = {
    runId: expected.runId,
    runRoot: expected.relayRoot,
    relayRoot: expected.relayRoot,
    registrationStoreFile: `${expected.relayRoot}/registration-store.json`,
    readyFile: `${expected.relayRoot}/ready.json`,
    gatewayId: fixture.id,
    serverId: "baseline-local",
    workspacePath: resolve(parentRunRoot, "state/workspace"),
    sharedHost: "hyf2333.top",
    ingressPort: expected.ports.ingress,
  };
  const configSha256 = sha(Buffer.from(`${JSON.stringify(config)}\n`));
  const runtimeFiles = [];
  async function addPinned(sourcePath, target, expectedSha256) {
    const path = resolve(sourcePath);
    const recorded = inputBefore.inventory[path];
    assert.ok(recorded && recorded.sha256 === expectedSha256, `original inventory lacks the exact runtime pin for ${target}`);
    assert.deepEqual(await filePin(path), recorded, `runtime source changed for ${target}`);
    runtimeFiles.push({ path: target, bytes: recorded.bytes, sha256: recorded.sha256 });
  }
  await addPinned(pinnedNode, "node", expected.nodeSha256);
  for (const [path, expectedSha256] of Object.entries(relayFilePins)) {
    await addPinned(resolve(relayRuntimeRoot, path), path, expectedSha256);
  }
  const wsSuffix = "/apps/kcoder-relay/node_modules/ws/LICENSE";
  const wsRoots = Object.keys(inputBefore.inventory).filter(path => path.endsWith(wsSuffix)).map(path => path.slice(0, -"/node_modules/ws/LICENSE".length));
  assert.equal(wsRoots.length, 1, "original inventory must identify exactly one ws dependency source");
  assert.equal(wsFilePins.length, 19);
  for (const [path, bytes, expectedSha256] of wsFilePins) {
    const sourcePath = resolve(wsRoots[0], "node_modules/ws", path);
    const runtimePath = resolve(relayRuntimeRoot, "node_modules/ws", path);
    const recorded = inputBefore.inventory[sourcePath];
    assert.deepEqual(recorded, { bytes, sha256: expectedSha256 }, `original inventory differs for ws/${path}`);
    assert.deepEqual(await filePin(sourcePath), recorded);
    assert.deepEqual(await filePin(runtimePath), recorded);
    runtimeFiles.push({ path: `node_modules/ws/${path}`, bytes, sha256: expectedSha256 });
  }
  await addPinned(resolve(repoRoot, "apps/kcoder-studio/e2e/harness", entryFile), entryFile, entrySha);
  assert.equal(runtimeFiles.length, 28);
  assert.equal(runtimeFiles.filter(row => row.path.startsWith("src/")).length, 5);
  assert.equal(runtimeFiles.filter(row => row.path.startsWith("node_modules/ws/")).length, 19);
  assert.equal(runtimeFiles.find(row => row.path === "node_modules/ws/LICENSE")?.sha256,
    "2b29dcfe0d6471f7e8c92c5fb38c9f93edee10330937055440192f1832b1ecef");
  assert.equal(await realpath(pinnedNode), pinnedNode);

  const cleanupParams = {
    runRoot: expected.relayRoot,
    runId: expected.runId,
    rootReceipt: null,
    launchAttempted: true,
    ports: [expected.ports.ingress],
    configSha256,
    storeSha256,
    runtimeFiles,
  };
  const remotePython = buildMarkedPythonSource(rootStop);
  const compile = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<ROOT_STOP>', 'exec')"], {
    input: remotePython, cwd: repoRoot, encoding: "utf8", maxBuffer: 8192,
  });
  assert.equal(compile.status, 0, `the exact generated ROOT_STOP Python must compile locally (${compile.error?.code ?? compile.stderr ?? "unknown"})`);
  await context.writeArtifactJson("relay-cleanup-input.json", {
    parentRunRoot,
    parentManifestSha256: sha(parentManifestBytes),
    parentResultSha256: sha(parentResultBytes),
    parentInputsBeforeSha256: sha(inputBeforeBytes),
    relayReadySha256: sha(relayReadyBytes),
    lifecycleSha256: sha(lifecycleBytes),
    rootStopSha256: sha(Buffer.from(rootStop)),
    runId: expected.runId,
    relayRoot: expected.relayRoot,
    recordedRelayPid: relay.pid,
    recordedStarttime: relay.starttime,
    recordedEuid: relay.euid,
    ports: Object.values(expected.ports).sort((a, b) => a - b),
    runtimeFileCount: runtimeFiles.length,
    runtimeFilesDigest: sha(Buffer.from(JSON.stringify(runtimeFiles))),
    configSha256,
    registrationStoreSha256: storeSha256,
    rootReceiptInput: null,
    cleanupSource: "original pinned ROOT_STOP from remote-relay-lifecycle.mjs",
    mutations: ["pidfd-stop only if recorded process identity is still live", "remove only exact owner-marked Relay root after all identity, config, store, runtime-file, and port gates"],
    production8451Touched: false,
    caddyTouched: false,
  });

  const sshOptions = ["-T", "-F", "/home/hyf/.ssh/config", "-o", "UserKnownHostsFile=/home/hyf/.ssh/known_hosts",
    "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no"];
  const command = `python3 -c ${shellQuote(remotePython)} ${shellQuote(JSON.stringify(cleanupParams))}`;
  const ssh = context.spawnOwned("cleanup-exact-public-114412-relay-root", "/usr/bin/ssh",
    [...sshOptions, "aliyun", command], { cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]) });
  const stdout = [];
  let stdoutBytes = 0, stderrBytes = 0, overflow = false, spawnError = null;
  const stageObserver = createSshStageObserver(performance.now(), 8, 16_384);
  ssh.stdout.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 32 * 1024) stdout.push(Buffer.from(chunk)); else overflow = true;
  });
  ssh.stderr.on("data", chunk => { stderrBytes += chunk.length; stageObserver.push(chunk); });
  ssh.once("error", error => { spawnError = error; });
  let terminalWaitFailure = null;
  try { await waitFor(() => ssh.exitCode !== null || ssh.signalCode !== null, 45_000,
    "exact 114412 Relay-root cleanup SSH terminal", 25, context.abortSignal); }
  catch (failure) { terminalWaitFailure = failure; }
  const stage = stageObserver.finish();
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  let receipt = null;
  if (!terminalWaitFailure && !spawnError && ssh.exitCode === 0 && !overflow && stage.valid) {
    try { receipt = JSON.parse(stdoutText); } catch { /* retain the bounded invalid receipt as a failed cleanup */ }
  }
  const terminalEvidence = {
    pid: ssh.pid, exitCode: ssh.exitCode, signal: ssh.signalCode,
    stdoutBytes, stderrBytes, overflow, spawnError: spawnError?.name ?? null,
    terminalWaitFailed: terminalWaitFailure !== null,
    markers: stage.markers, invalidMarkerCount: stage.invalidMarkerCount,
    droppedMarkerCount: stage.droppedMarkerCount,
    receipt,
  };
  await context.writeArtifactJsonInternal("relay-cleanup-terminal.json", terminalEvidence);
  assert.equal(terminalWaitFailure, null, "owned cleanup SSH must reach terminal");
  assert.equal(spawnError, null); assert.equal(ssh.exitCode, 0); assert.equal(ssh.signalCode, null);
  assert.equal(overflow, false); assert.equal(stage.valid, true);
  assert.deepEqual(stage.markers.map(row => row.stage), ["REMOTE_PYTHON_ENTERED", "REMOTE_PROGRAM_COMPLETE"]);
  assert.ok(receipt && typeof receipt === "object" && !Array.isArray(receipt));
  assert.equal(receipt.remoteRootRemoved, true);
  assert.equal(receipt.relayStopState, "recorded-process-already-exited");
  assert.equal(receipt.rootReceiptRecovered, true);
  assert.equal(receipt.pid, expected.pid);
  assert.deepEqual(receipt.dynamicPorts.slice().sort((a, b) => a - b), [expected.ports.control, expected.ports.proxy].sort((a, b) => a - b));
  assert.deepEqual(receipt.portsFree, Object.values(expected.ports).sort((a, b) => a - b));
  await context.writeArtifactJson("remote-relay-cleanup.json", receipt);
  return {
    remoteRootRemoved: receipt.remoteRootRemoved,
    relayStopState: receipt.relayStopState,
    rootReceiptRecovered: receipt.rootReceiptRecovered,
    pid: receipt.pid,
    dynamicPorts: receipt.dynamicPorts,
    portsFree: receipt.portsFree,
    runtimeFileCount: runtimeFiles.length,
    production8451Touched: false,
    caddyTouched: false,
  };
});
