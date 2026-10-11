import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { repoRoot, runE2E, waitFor } from "../harness/run-context.mjs";
import { buildFreshSshArgs, buildMarkedPythonSource, createSshStageObserver } from "../harness/owned-ssh-control-master.mjs";

assert.equal(process.version, "v22.17.0");
assert.equal(process.env.KCODER_E2E_EXACT_RELAY_CLEANUP_ONCE, "1", "exact Relay cleanup requires explicit one-shot enable");
const parentRunRoot = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs/20261009-071249.150Z");
const fixtureRoot = "/data1/hyf/20260822_agent/Kunlun-Code-CYX/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-infra.e2e.mjs/20261007-183008.205Z/state";
const probeRunRoot = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/private/inspect-owned-remote-relay-direct.once.mjs/20261009-072638.945Z");
const relayRuntimeRoot = resolve(repoRoot, "target/private-phone-ux-implementation/relay-eof-drain-20261009/controlled-run-01/runtime");
const lifecyclePath = resolve(repoRoot, "apps/kcoder-studio/e2e/harness/remote-relay-lifecycle.mjs");
const sshTarget = "aliyun";
const sshConfig = "/home/hyf/.ssh/config";
const knownHosts = "/home/hyf/.ssh/known_hosts";
const pinnedNode = "/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node";
const pinnedNodeSha256 = "8071ae0fca095a272ad698a90c7061801a86fb6392ddb81e922b68a91a4374b9";
const rootStopInputPin = "5859a59f99e8c7ba9e67ef1a11ab876fe3b15a84cee738ed3a2321d7837e4f65";
const originalProcessId = 279975;
const expectedPorts = [32552, 40923, 44689];
const originHost = "hyf2333.top";

function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
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
async function currentFilePin(path, expected, { hash = true } = {}) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, `pinned runtime path must be a single regular file: ${path}`);
  const recorded = { bytes: info.size, sha256: expected.sha256 };
  assert.ok(Number.isSafeInteger(recorded.bytes) && recorded.bytes === expected.bytes);
  if (hash) assert.equal(sha(await readFile(path)), expected.sha256, `pinned runtime file changed: ${path}`);
  return recorded;
}
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

async function prepareInputs() {
  const parentManifestPath = resolve(parentRunRoot, "manifest.json");
  const parentResultPath = resolve(parentRunRoot, "artifacts/result.json");
  const beforePath = resolve(parentRunRoot, "artifacts/inputs-before.json");
  const afterPath = resolve(parentRunRoot, "artifacts/inputs-after.json");
  const remoteReadyPath = resolve(parentRunRoot, "artifacts/remote-relay-ready.json");
  const probePath = resolve(probeRunRoot, "artifacts/remote-relay-direct-readonly-inspection.json");
  const [parentManifest, parentResult, inputBefore, inputAfter, relay, probe] = await Promise.all([
    readFile(parentManifestPath, "utf8").then(JSON.parse), readFile(parentResultPath, "utf8").then(JSON.parse),
    readFile(beforePath, "utf8").then(JSON.parse), readFile(afterPath, "utf8").then(JSON.parse),
    readFile(remoteReadyPath, "utf8").then(JSON.parse), readFile(probePath, "utf8").then(JSON.parse),
  ]);
  assert.equal(parentManifest.status, "failed", "preserve the original failed baseline result");
  assert.equal(parentResult.status, "failed");
  assert.deepEqual(inputAfter.inventory, inputBefore.inventory, "original run source/dependency inventory must remain unchanged");
  assert.deepEqual(inputAfter.binary, inputBefore.binary);
  assert.equal(relay.runId, "bc941b1bd1829a03da112192");
  assert.equal(relay.pid, originalProcessId);
  assert.deepEqual(relay.ports, { ingress: 32552, control: 44689, proxy: 40923 });
  assert.equal(inputBefore.relayRuntimeRoot, relayRuntimeRoot);
  assert.equal(inputBefore.nodeExe.sha256, pinnedNodeSha256);
  assert.equal(inputBefore.nodeExe.bytes, 121609656);
  assert.equal(await realpath(pinnedNode), pinnedNode);
  assert.equal((await stat(pinnedNode)).size, inputBefore.nodeExe.bytes);
  assert.equal(probe.scriptSha256, "4223982d899f4315f4dcd85e66a33632ffb8fefd401fc261ae9078dca524cc9f");
  assert.equal(probe.result?.rootState, "present-owned-shape");
  assert.equal(probe.result?.ownerMarkerMatches, true);
  assert.equal(probe.result?.recordedProcess?.state, "absent");
  assert.deepEqual(probe.result?.ports?.map(row => row.port).sort((a,b) => a-b), expectedPorts);
  assert.ok(probe.result.ports.every(row => row.listenerCount === 0 && row.listenerPids.length === 0 && Object.keys(row.socketStateCounts).length === 0));

  const lifecycleBytes = await readFile(lifecyclePath);
  const lifecycleSha256 = sha(lifecycleBytes);
  const lifecycleRecorded = inputBefore.inventory[lifecyclePath];
  assert.ok(lifecycleRecorded && lifecycleRecorded.sha256 === lifecycleSha256, "cleanup implementation must match original run input pin");
  assert.equal(lifecycleSha256, rootStopInputPin);
  const lifecycleSource = lifecycleBytes.toString("utf8");
  const relayFilePins = extractJsonConstant(lifecycleSource, "RELAY_FILE_PINS", "{", "}");
  const wsFilePins = extractJsonConstant(lifecycleSource, "WS_FILE_PINS", "[", "]");
  const nodeSha = extractStringConstant(lifecycleSource, "PINNED_NODE_SHA256");
  const entryFile = extractStringConstant(lifecycleSource, "REMOTE_ENTRY_FILE");
  const entrySha = extractStringConstant(lifecycleSource, "REMOTE_ENTRY_SHA256");
  assert.equal(nodeSha, pinnedNodeSha256);
  const rootStopMatch = /const ROOT_STOP = `([\s\S]*?)`;/m.exec(lifecycleSource);
  assert.ok(rootStopMatch && !rootStopMatch[1].includes("${") && !rootStopMatch[1].includes("`"), "ROOT_STOP must remain a fixed plain template");
  const rootStop = vm.runInNewContext(`\`${rootStopMatch[1]}\``);
  assert.ok(rootStop.includes("signal.pidfd_send_signal") && rootStop.includes("os.unlink") && rootStop.includes("os.rmdir"));
  assert.ok(!rootStop.includes("SIGKILL") || rootStop.includes("SIGTERM"), "retain original bounded process identity gate");

  const fixtureInfo = await lstat(fixtureRoot);
  assert.ok(fixtureInfo.isDirectory() && !fixtureInfo.isSymbolicLink() && fixtureInfo.uid === process.getuid() && (fixtureInfo.mode & 0o777) === 0o700);
  const fixtureData = JSON.parse(await readFile(resolve(fixtureRoot, "private-mobile-pairing-fixtures.json"), "utf8"));
  const registryPath = resolve(fixtureRoot, "relay-registration-store.json");
  const storeInfo = await lstat(registryPath);
  assert.ok(storeInfo.isFile() && !storeInfo.isSymbolicLink() && storeInfo.nlink === 1 && storeInfo.uid === process.getuid());
  assert.equal(storeInfo.mode & 0o777, 0o600);
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const identityPath = resolve(fixtureRoot, "relay-client-alpha.json");
  const identityInfo = await lstat(identityPath);
  assert.ok(identityInfo.isFile() && !identityInfo.isSymbolicLink() && identityInfo.nlink === 1 && identityInfo.uid === process.getuid());
  assert.equal(identityInfo.mode & 0o777, 0o600);
  const identity = JSON.parse(await readFile(identityPath, "utf8"));
  const entry = registry.gateways?.find(row => row.id === fixtureData.alpha?.id);
  assert.match(fixtureData.alpha?.id || "", /^[a-f0-9]{32}$/);
  assert.ok(entry && entry.secret === identity.secret && entry.id === identity.id && entry.pairingToken === fixtureData.alpha.pairingToken,
    "original alpha pairing, identity and registry binding must match");
  const selectedStore = { version: registry.version, gateways: [entry] };
  assert.equal(selectedStore.gateways.length, 1);
  const storeBytes = Buffer.from(`${JSON.stringify(selectedStore, null, 2)}\n`);
  const storeSha256 = sha(storeBytes);
  const gatewayId = fixtureData.alpha?.id;
  assert.match(gatewayId || "", /^[a-f0-9]{32}$/);

  const config = {
    runId: relay.runId,
    runRoot: relay.runRoot,
    relayRoot: relay.runRoot,
    registrationStoreFile: `${relay.runRoot}/registration-store.json`,
    readyFile: `${relay.runRoot}/ready.json`,
    gatewayId,
    serverId: "baseline-local",
    workspacePath: resolve(parentRunRoot, "state/workspace"),
    sharedHost: originHost,
    ingressPort: 32552,
  };
  const configSha256 = sha(Buffer.from(`${JSON.stringify(config)}\n`));

  const runtimeFiles = [];
  const addPinned = async (sourcePath, target, expectedSha, { useRecordedNode = false } = {}) => {
    const path = resolve(sourcePath);
    const recorded = inputBefore.inventory[path];
    assert.ok(recorded && recorded.sha256 === expectedSha, `original run inventory lacks exact pin for ${target}`);
    await currentFilePin(path, recorded, { hash: !useRecordedNode });
    runtimeFiles.push({ path: target, bytes: recorded.bytes, sha256: recorded.sha256 });
  };
  await addPinned(pinnedNode, "node", nodeSha, { useRecordedNode: true });
  for (const [path, expectedSha] of Object.entries(relayFilePins)) {
    await addPinned(resolve(relayRuntimeRoot, path), path, expectedSha);
  }
  assert.equal(wsFilePins.length, 19);
  const wsSourceMatches = Object.keys(inputBefore.inventory).filter(key => key.endsWith("/apps/kcoder-relay/node_modules/ws/LICENSE"));
  assert.equal(wsSourceMatches.length, 1, "original run must identify exactly one pinned ws package source");
  const wsSourceRoot = wsSourceMatches[0].slice(0, -"/node_modules/ws/LICENSE".length);
  for (const [path, bytes, expectedSha] of wsFilePins) {
    const sourcePath = resolve(wsSourceRoot, "node_modules/ws", path);
    const runtimePath = resolve(relayRuntimeRoot, "node_modules/ws", path);
    const recorded = inputBefore.inventory[sourcePath];
    assert.deepEqual(recorded, { bytes, sha256: expectedSha }, `original input inventory differs for node_modules/ws/${path}`);
    await currentFilePin(sourcePath, recorded);
    await currentFilePin(runtimePath, recorded);
    assert.equal(await realpath(runtimePath), await realpath(sourcePath), `runtime ws dependency no longer resolves to the original pinned source: ${path}`);
    runtimeFiles.push({ path: `node_modules/ws/${path}`, bytes, sha256: expectedSha });
  }
  await addPinned(resolve(repoRoot, "apps/kcoder-studio/e2e/harness", entryFile), entryFile, entrySha);
  assert.equal(runtimeFiles.length, 28);
  assert.equal(runtimeFiles.filter(row => row.path.startsWith("src/")).length, 5);
  assert.equal(runtimeFiles.filter(row => row.path.startsWith("node_modules/ws/")).length, 19);
  assert.equal(runtimeFiles[0].sha256, pinnedNodeSha256);

  const readOnlyProbeInput = {
    runRoot: relay.runRoot,
    ports: [32552, 44689, 40923],
  };
  const readOnlyPython = String.raw`import json,os,pathlib,re,subprocess,sys
p=json.loads(sys.argv[1]); root=pathlib.Path(p['runRoot'])
result={'inspectionCompleted':True,'rootAbsent':not os.path.lexists(root),'ports':[]}
for port in p['ports']:
 a=subprocess.run(['ss','-H','-ltnp',f'sport = :{port}'],capture_output=True,text=True,timeout=3)
 b=subprocess.run(['ss','-H','-tan',f'sport = :{port}'],capture_output=True,text=True,timeout=3)
 if a.returncode or b.returncode: raise RuntimeError('socket-query-failed')
 listeners=sorted({int(x) for x in re.findall(r'pid=(\d+),',a.stdout)})
 states={}
 for line in b.stdout.splitlines():
  fields=line.split()
  if fields: states[fields[0]]=states.get(fields[0],0)+1
 result['ports'].append({'port':port,'listenerCount':len(listeners),'listenerPids':listeners,'socketStateCounts':states})
print(json.dumps(result,separators=(',',':')))`;
  const cleanupParams = {
    runRoot: relay.runRoot,
    runId: relay.runId,
    rootReceipt: null,
    launchAttempted: true,
    ports: [32552],
    configSha256,
    storeSha256,
    runtimeFiles,
  };
  const directOptions = ["-F", "/home/hyf/.ssh/config", "-o", "UserKnownHostsFile=/home/hyf/.ssh/known_hosts",
    "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no",
    "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no"];
  const record = {
    parentRunRoot,
    parentManifestSha256: sha(await readFile(parentManifestPath)),
    parentResultSha256: sha(await readFile(parentResultPath)),
    parentInputBeforeSha256: sha(await readFile(beforePath)),
    parentInputAfterSha256: sha(await readFile(afterPath)),
    parentRelayReadySha256: sha(await readFile(remoteReadyPath)),
    priorReadOnlyProbeSha256: sha(await readFile(probePath)),
    lifecycleSha256, rootStopSourceSha256: sha(Buffer.from(rootStop)),
    runtimeFileCount: runtimeFiles.length, runtimeSourceCount: 5, wsFileCount: 19,
    configSha256, registrationStoreSha256: storeSha256,
    recordedRelayPid: relay.pid, recordedRunId: relay.runId, ports: [32552, 44689, 40923],
    precondition: { relayRootPresent: true, ownerMarkerMatched: true, recordedProcessAbsent: true, listenersAndSocketStatesAbsent: true },
    sshOptions: { target: sshTarget, controlMaster: "no", controlPath: "none", strictHostKeyChecking: true,
      batchMode: true, connectTimeoutSeconds: 15, proxyOverrides: false },
  };
  return { record, relay, cleanupParams, rootStop, readOnlyProbeInput, readOnlyPython, directOptions };
}

const local = await prepareInputs();
if (process.argv.includes("--local-preflight-only")) {
  console.log(JSON.stringify({ status: "LOCAL_PREFLIGHT_PASS", ...local.record }, null, 2));
} else {
  await runE2E(import.meta.url, {
    testId: "public-rust-baseline-exact-owned-relay-cleanup",
    tier: "manual-live",
    modelPolicy: "one exact owner-gated cleanup of the prior test-owned Relay root, followed by an independent read-only absence/listener check; no Browser or business requests",
    cleanupTimeoutMs: 60_000,
  }, async context => {
    const sourceSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
    await context.writeArtifactJson("cleanup-inputs-before.json", { ...local.record, sourceSha256,
      cleanupRootReceiptMode: "null-recover-current-dev-inode-from-exact-owner-marker; original ROOT_STOP only" });
    const fixtureData = JSON.parse(await readFile(resolve(fixtureRoot, "private-mobile-pairing-fixtures.json"), "utf8"));
    const registry = JSON.parse(await readFile(resolve(fixtureRoot, "relay-registration-store.json"), "utf8"));
    for (const value of [fixtureData.alpha?.id, fixtureData.alpha?.pairingToken]) if (typeof value === "string") context.registerSecret(value);
    for (const row of registry.gateways ?? []) for (const value of [row.id, row.secret, row.pairingToken]) if (typeof value === "string") context.registerSecret(value);

    async function directCall(label, python, params, timeoutMs) {
      const command = `python3 -c ${shellQuote(buildMarkedPythonSource(python))} ${shellQuote(JSON.stringify(params))}`;
      const child = context.spawnOwned(label, "/usr/bin/ssh", buildFreshSshArgs({ target: sshTarget, directOptions: local.directOptions }, command), {
        cwd: repoRoot, env: context.isolatedEnvironment({}, ["SSH_AUTH_SOCK"]),
      });
      const observer = createSshStageObserver(performance.now());
      const chunks = [];
      let outBytes = 0, close = null, spawnError = null, waitError = null;
      child.once("error", error => { spawnError = error; });
      child.once("close", (code, signal) => { close = { code, signal }; });
      child.stdout.on("data", chunk => { outBytes += chunk.length; if (outBytes <= 64 * 1024) chunks.push(Buffer.from(chunk)); });
      child.stderr.on("data", chunk => observer.push(chunk));
      try { await waitFor(() => close !== null || spawnError !== null, timeoutMs, `owned remote operation ${label}`, 25, context.abortSignal); }
      catch (error) { waitError = error; }
      if (close === null) await context.stopOwned(label).catch(() => {});
      if (close === null) {
        try { await waitFor(() => close !== null, 5_000, `owned remote terminal ${label}`, 25); } catch {}
      }
      const stage = observer.finish();
      const out = Buffer.concat(chunks).toString("utf8");
      let json = null, parseError = null;
      try { if (close?.code === 0 && outBytes <= 64 * 1024) json = JSON.parse(out); }
      catch (error) { parseError = error?.name ?? "ParseError"; }
      const evidence = {
        label, pid: child.pid ?? null, exitCode: close?.code ?? child.exitCode ?? null,
        signal: close?.signal ?? child.signalCode ?? null, terminalObserved: close !== null,
        spawnErrorKind: spawnError?.name ?? null, waitTimedOut: waitError !== null,
        stdoutBytes: outBytes, parsedJson: json !== null, parseError,
        stageMarkers: stage.markers, invalidStageMarkerCount: stage.invalidMarkerCount,
        droppedStageMarkerCount: stage.droppedMarkerCount, droppedStageBytes: stage.droppedBytes,
        result: json,
      };
      return evidence;
    }

    const cleanup = await directCall("cleanup-exact-owned-relay-root", local.rootStop, local.cleanupParams, 30_000);
    await context.writeArtifactJson("exact-root-stop-result.json", cleanup);
    // Read-only state observation is deliberately separate. It never repeats the mutating ROOT_STOP.
    const after = await directCall("verify-owned-relay-root-absent", local.readOnlyPython, local.readOnlyProbeInput, 20_000);
    await context.writeArtifactJson("exact-root-post-cleanup-readonly.json", after);

    const cleanupValue = cleanup.result;
    const afterValue = after.result;
    const expectedPortsFree = [32552, 40923, 44689];
    const rootStopAccepted = cleanup.exitCode === 0 && cleanup.terminalObserved && cleanup.parsedJson &&
      cleanupValue?.remoteRootRemoved === true && cleanupValue?.rootReceiptRecovered === true &&
      cleanupValue?.relayStopState === "recorded-process-already-exited" && cleanupValue?.pid === originalProcessId &&
      JSON.stringify(cleanupValue?.portsFree) === JSON.stringify(expectedPortsFree);
    const postVerified = after.exitCode === 0 && after.terminalObserved && after.parsedJson &&
      afterValue?.inspectionCompleted === true && afterValue?.rootAbsent === true &&
      afterValue?.ports?.every(row => row.listenerCount === 0 && row.listenerPids.length === 0);
    assert.equal(rootStopAccepted, true, "only the exact original ROOT_STOP owner proof may satisfy cleanup");
    assert.equal(postVerified, true, "a separate read-only query must prove the exact root absent and all three listeners free");
    return { cleanup: cleanupValue, independentReadOnlyVerification: afterValue };
  });
}
