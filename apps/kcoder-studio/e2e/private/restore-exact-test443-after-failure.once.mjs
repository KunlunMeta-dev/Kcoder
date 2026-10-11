import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { repoRoot, runE2E } from "../harness/run-context.mjs";
import { restoreRoutesOnlySidecarOnce } from "../harness/single-ssh-sidecar-restore.mjs";

const parentRunRoot = `${repoRoot}/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs/20261009-080452.409Z`;
const inspectionRunRoot = `${repoRoot}/target/test/apps/kcoder-studio/e2e/private/inspect-current-test443-after-failure.once.mjs/20261009-082011.636Z`;
const baselineRunRoot = `${repoRoot}/target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-public-rust-relay-baseline.e2e.mjs/20261009-080519.253Z`;
const pinned = Object.freeze({
  originalConfigPath: "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile",
  originalConfigSha256: "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c",
  originalSidecarPid: 280123,
  candidatePid: 281219,
  candidateSha256: "46af4f57dce92f2e76cb6d68d6781cd041ad1d215eb0041bb84812e7f06f3e91",
  productionConfigPath: "/etc/caddy/Caddyfile",
  productionConfigSha256: "05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511",
  productionPid: 200738,
  productionEuid: 996,
  productionArgvSha256: "626a004e20430eca69818647d5102f62bf953632ce3e06e0d4016ac2b32099fd",
  productionListenerSha256: "dc50003e06a3fb199d513a16b89f4b2e8c8f5604463aa27214dc93d8402a1f19",
  staticRoot: "/tmp/kc-phone-ux-443-20261007-183008/mobile-web-root",
  staticFileCount: 37,
  staticTreeSha256: "8f414deda3c4aa5807078dab4ee6520b4cd96298e34dfc40368e06ff7371a92e",
  restoreHelperSha256: "9783bb8bba15ecb7adfd7f2a665e6c2e82a64b96cf6ef2766ff01cfc841c1b06",
});
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

await runE2E(import.meta.url, {
  testId: "mobile-public-rust-relay-restore-exact-test443-after-failure",
  tier: "manual-live", retainSuccessLogs: true, cleanupTimeoutMs: 120_000,
  modelPolicy: "restore only the exact owned candidate 443 sidecar from the failed run; no production 8451 mutation",
}, async context => {
  assert.equal(process.version, "v22.17.0");
  const parentManifestBytes = await readFile(`${parentRunRoot}/manifest.json`);
  const parent = JSON.parse(parentManifestBytes.toString("utf8"));
  assert.equal(parent.status, "failed", "original failed run remains immutable evidence");
  const candidate = JSON.parse(await readFile(`${parentRunRoot}/artifacts/routes-only-sidecar-candidate.json`, "utf8"));
  const relayCleanup = JSON.parse(await readFile(`${baselineRunRoot}/artifacts/remote-relay-cleanup.json`, "utf8"));
  const inspectionBytes = await readFile(`${inspectionRunRoot}/artifacts/current-test443-owner-inspection.json`);
  const inspection = JSON.parse(inspectionBytes.toString("utf8"));
  const remote = inspection.remote;
  assert.equal(inspection.childClose?.code, 0);
  assert.equal(inspection.childClose?.signal, null);
  assert.equal(inspection.timedOut, false);
  assert.deepEqual(inspection.markers.markers.map(row => row.stage), ["REMOTE_PYTHON_ENTERED", "REMOTE_PROGRAM_COMPLETE"]);
  assert.equal(remote.inspection, "completed");
  assert.equal(remote.mutationsAttempted, false);

  // Require the exact still-running candidate and its marker/config files before restoring.
  assert.equal(remote.sidecarState, "candidate-exact");
  assert.deepEqual(remote.sidecar443.listener.pids, [pinned.candidatePid]);
  assert.equal(remote.candidateProcess.pid, pinned.candidatePid);
  assert.equal(remote.candidateProcess.euid, 0);
  assert.equal(remote.candidateProcess.exeMatches, true);
  assert.equal(remote.candidateProcess.candidateArgvExact, true);
  assert.equal(remote.candidateRoot.state, "owned-shape");
  assert.equal(remote.candidateRoot.uid, 0);
  assert.equal(remote.candidateRoot.mode, 0o700);
  assert.equal(remote.candidateRoot.namesAllowed, true);
  assert.equal(remote.candidateRoot.ownerMarkerMatches, true);
  assert.equal(remote.candidateRoot.candidateConfigMatches, true);
  assert.equal(remote.candidateRoot.candidatePidFileMatches, true);
  assert.equal(remote.candidateConfigFile.sha256, pinned.candidateSha256);
  assert.equal(remote.originalConfigFile.sha256, pinned.originalConfigSha256);

  // Production is read-only and must match the pre-run owner/config/listener evidence.
  const production = remote.production8451;
  assert.deepEqual(production.listener.pids, [pinned.productionPid]);
  assert.equal(production.listener.sha256, pinned.productionListenerSha256);
  assert.equal(production.owner.pid, pinned.productionPid);
  assert.equal(production.owner.exeMatches, true);
  assert.equal(production.owner.euid, pinned.productionEuid);
  assert.equal(production.owner.configPath, pinned.productionConfigPath);
  assert.equal(production.configFile.sha256, pinned.productionConfigSha256);
  assert.equal(production.configMatchesExpected, true);
  assert.equal(remote.staticRoot.matchesExpected, true);
  assert.equal(remote.staticRoot.fileCount, pinned.staticFileCount);
  assert.equal(remote.staticRoot.treeSha256, pinned.staticTreeSha256);
  assert.deepEqual(remote.forward32552.pids, []);
  assert.equal(remote.relayRootState, "absent");
  assert.equal(remote.relayProcess.state, "absent");
  assert.deepEqual(remote.relayDynamicPorts["43849"].pids, []);
  assert.deepEqual(remote.relayDynamicPorts["37717"].pids, []);
  assert.equal(relayCleanup.remoteRootRemoved, true);
  assert.deepEqual(relayCleanup.portsFree, [32552, 37717, 43849]);
  assert.equal(relayCleanup.rootReceiptRecovered, false, "failed cleanup receipt must not be represented as recovered");
  const helperPath = `${repoRoot}/apps/kcoder-studio/e2e/harness/single-ssh-sidecar-restore.mjs`;
  const helperBytes = await readFile(helperPath);
  assert.equal(sha(helperBytes), pinned.restoreHelperSha256, "use the already-reviewed exact restore helper");

  const suffix = createHash("sha256").update(parent.seed).digest("hex").slice(0, 24);
  const marker = `kc_route_${suffix}`;
  const root = `/tmp/kc-phone-ux-rust-baseline-${suffix}`;
  const transaction = {
    root, marker, configPath: `${root}/isolated-443-front.Caddyfile`,
    candidatePid: pinned.candidatePid, candidateSha256: pinned.candidateSha256,
    candidateStartRequested: true, originalStopRequested: true, candidateStarted: true,
    original: { configPath: pinned.originalConfigPath, configSha256: pinned.originalConfigSha256, pid: pinned.originalSidecarPid },
    staticRootSha256: pinned.staticTreeSha256,
  };
  const before = {
    forwardFree: true,
    productionOwners: [{ pid: pinned.productionPid, exe: "/usr/bin/caddy", euid: pinned.productionEuid,
      argvConfigMatch: true, argvSha256: pinned.productionArgvSha256 }],
    productionListenerSha256: pinned.productionListenerSha256,
    sidecar: { pid: pinned.originalSidecarPid, configSha256: pinned.originalConfigSha256 },
  };
  await context.writeArtifactJson("restore-input.json", {
    parentRunRoot, parentManifestSha256: sha(parentManifestBytes), inspectionRunRoot,
    inspectionArtifactSha256: sha(inspectionBytes), restoreHelperSha256: sha(helperBytes),
    candidate: { pid: transaction.candidatePid, root: transaction.root, configSha256: transaction.candidateSha256,
      candidateStartRequested: transaction.candidateStartRequested },
    original: { pid: transaction.original.pid, configSha256: transaction.original.configSha256 },
    production: { pid: pinned.productionPid, configSha256: pinned.productionConfigSha256,
      listenerSha256: pinned.productionListenerSha256 },
    staticRoot: { fileCount: pinned.staticFileCount, treeSha256: pinned.staticTreeSha256 },
    relayCleanup: { remoteRootRemoved: relayCleanup.remoteRootRemoved, portsFree: relayCleanup.portsFree,
      rootReceiptRecovered: relayCleanup.rootReceiptRecovered },
    transport: "one fresh strict-host-key SSH command via existing restore helper; no automatic retry",
  });

  const sshOptions = ["-F", "/home/hyf/.ssh/config", "-o", "UserKnownHostsFile=/home/hyf/.ssh/known_hosts",
    "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=15"];
  const result = await restoreRoutesOnlySidecarOnce(context, transaction, before, {
    repoRoot, sshTarget: "aliyun", sshOptions,
    productionConfigPath: pinned.productionConfigPath, productionConfigSha256: pinned.productionConfigSha256,
    expectedStaticRoot: pinned.staticRoot, expectedStaticFiles: pinned.staticFileCount,
  });
  console.log(JSON.stringify({ runRoot: context.runRoot, ownerPid: process.pid,
    restore: "confirmed", restoredSidecarPid: result.restoredSidecarPid,
    staticFileCount: result.staticRoot.fileCount, staticTreeSha256: result.staticRoot.treeSha256,
    rootRemoval: result.rootRemoval, killUsed: result.killUsed,
    production8451Touched: false }));
  return { restoredSidecarPid: result.restoredSidecarPid, rootRemoval: result.rootRemoval,
    staticRoot: result.staticRoot, production8451Touched: false };
});
