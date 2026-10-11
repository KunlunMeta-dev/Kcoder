import { createPublicRelayDiagnosticHelpers } from "../../harness/public-relay-diagnostic-helpers.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, copyFile, cp, lstat, mkdir, open, readFile, realpath, readdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { copyFrozenMobileWeb, copyVerifiedSnapshot } from "../../harness/frozen-copy.mjs";
import { processTreeAlive } from "../../harness/owned-process.mjs";
import { createBoundedRelayDiagnosticCollector, readBoundedErrorResponseBody } from "../../harness/public-relay-diagnostics.mjs";
import {
  applyRelayPublicHttpDiagnosticOverlay,
  createRelayHttpDiagnosticCollector,
  RELAY_HTTP_DIAGNOSTIC_BASE_SHA256,
  RELAY_HTTP_DIAGNOSTIC_OVERLAY_SHA256,
  projectRelayHttpDiagnostic,
  summarizeFetchFailure,
} from "../../harness/relay-http-phase-observation.mjs";
import { createPublicRouteProbeRequestLedger } from "../../harness/public-route-probe-request-ledger.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { closeRpcAndWait, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const execFileAsync = promisify(execFile);
const enabled = process.env.KCODER_E2E_PUBLIC_FULLRELAY === "1";
assert.ok(enabled, "Set KCODER_E2E_PUBLIC_FULLRELAY=1 only for the authorized full-public Relay setup");
const routeProbeOnlyFlag = process.env.KCODER_E2E_PUBLIC_FULLRELAY_ROUTE_PROBE_ONLY;
assert.ok(routeProbeOnlyFlag === undefined || routeProbeOnlyFlag === "0" || routeProbeOnlyFlag === "1", "route-probe-only mode must be an explicit 0/1 switch");
const routeProbeOnly = routeProbeOnlyFlag === "1";
const singlePostDiagnosticFlag = process.env.KCODER_E2E_PUBLIC_FULLRELAY_SINGLE_POST_DIAGNOSTIC;
assert.ok(singlePostDiagnosticFlag === undefined || singlePostDiagnosticFlag === "0" || singlePostDiagnosticFlag === "1", "single-post diagnostic mode must be an explicit 0/1 switch");
const singlePostDiagnosticOnly = singlePostDiagnosticFlag === "1";
assert.ok(!singlePostDiagnosticOnly || routeProbeOnly, "single-post diagnostic mode requires the route-probe-only harness");
const skipP2bTimingFlag = process.env.KCODER_E2E_PUBLIC_FULLRELAY_SKIP_P2B_TIMING;
assert.ok(skipP2bTimingFlag === undefined || skipP2bTimingFlag === "0" || skipP2bTimingFlag === "1", "P2B timing skip must be an explicit 0/1 switch");
const skipP2bTiming = skipP2bTimingFlag === "1";
assert.ok(!skipP2bTiming || !routeProbeOnly, "P2B timing can only be skipped in the complete public Mobile UI mode");

const configuredCloudHost = process.env.KCODER_E2E_PUBLIC_INFRA_SSH_TARGET || "aliyun";
const sshMasterLabel = "public-fullrelay-ssh-master";
const publicOrigin = "https://hyf2333.top";
const sidecarConfigPath = "/tmp/kc-phone-ux-443-20261007-183008/isolated-443-front.Caddyfile";
const expectedSidecarConfigSha256 = "520ba15051f238e695aee48833b8f1ab7ca3e2eed3e1b1347b18a20e8018ac7c";
const productionConfigPath = "/etc/caddy/Caddyfile";
const expectedProductionConfigSha256 = "05f6cab324663aed662c318ff54b30b67fa7ef36299419be63a8ba1bda71a511";
const sourceSetName = process.env.KCODER_E2E_PUBLIC_FULLRELAY_SOURCE_LABEL || "explicit-private-freeze";
assert.match(sourceSetName, /^[A-Za-z0-9._-]{1,80}$/, "source label must be a short non-secret label");
const privateCandidateBoundary = resolve(repoRoot, "target/private-phone-latency-implementation");
const privateWebBoundary = resolve(repoRoot, "target/private-phone-ux-implementation");
const candidateSource = resolvePrivateInput("KCODER_E2E_PUBLIC_FULLRELAY_CANDIDATE_ROOT", privateCandidateBoundary);
const candidateDigest = requiredSha256("KCODER_E2E_PUBLIC_FULLRELAY_EXPECTED_DIGEST");
const mobileWebSource = routeProbeOnly ? null : resolvePrivateInput("KCODER_E2E_PUBLIC_FULLRELAY_WEB_ROOT", privateWebBoundary);
const mobileWebManifestPath = routeProbeOnly ? null : resolvePrivateInput("KCODER_E2E_PUBLIC_FULLRELAY_WEB_MANIFEST", privateWebBoundary);
const mobileWebProvenancePath = routeProbeOnly ? null : resolvePrivateInput("KCODER_E2E_PUBLIC_FULLRELAY_WEB_PROVENANCE", privateWebBoundary);
const mobileBundleSha256 = routeProbeOnly ? null : requiredSha256("KCODER_E2E_PUBLIC_FULLRELAY_EXPECTED_BUNDLE_SHA256");
const diagnosticClientFlag = process.env.KCODER_E2E_PUBLIC_FULLRELAY_DIAGNOSTIC_CLIENT_OVERLAY;
assert.ok(diagnosticClientFlag === undefined || diagnosticClientFlag === "0" || diagnosticClientFlag === "1", "diagnostic client overlay must be an explicit 0/1 switch");
const diagnosticClientOverlayEnabled = diagnosticClientFlag === "1";
assert.ok(!routeProbeOnly || diagnosticClientOverlayEnabled, "route-probe-only requires the explicitly pinned phase diagnostic client overlay");
assert.ok(!singlePostDiagnosticOnly || diagnosticClientOverlayEnabled, "single-post diagnostic mode requires the explicitly pinned phase diagnostic client overlay");
const relayHttpObservationHelperPath = resolve(repoRoot, "apps/kcoder-studio/e2e/harness/relay-http-phase-observation.mjs");
const expectedRelayHttpObservationHelperSha256 = "7a0bd48c2257691d4fac23d787a1fa4e97c3029e8a0c232b27423d88a50f5628";
const diagnosticClientOverlayRoot = resolve(repoRoot, "target/private-phone-ux-implementation/relay-client-diagnostics-validation-overlay");
const expected212651CandidateDigest = "5b6c54a14ae1442941b7719a53026d0825b37850fc3e1efd9aa626e96dc7806f";
const expected361CandidateDigest = "77151ef991aecdcf5e52249b8821fafc8c4d41cd9658c308d46f830c1887523e";
const expected212651RelayClientSha256 = "8fe00de2a2f604bd6ee9a8b065245cbc035cc1e32407da9853159eaba7290e2a";
const expected361RelayClientSha256 = "8fe00de2a2f604bd6ee9a8b065245cbc035cc1e32407da9853159eaba7290e2a";
const expectedDiagnosticRelayClientSha256 = "339d7d85a203d2a6293138c000d0a17aa6bb0de1ae40bb9e524aae0073d988f8";
const expectedDiagnosticOverlayDigest = "9caebfd09ef37ce7ce835ed4a13415aeff4c7f22dd4d5fe4211d3ad6092416b4";
const expectedDiagnosticOverlayDiffSha256 = "cda30e5fd96900f89237969554965a50dd15141a6f3f7fff7e9dafcb13b60bc0";
const phaseDiagnosticOverlayRoot = resolve(repoRoot, "target/private-phone-ux-implementation/data-handshake-phase-diagnostics-overlay-20261008");
const expectedPhaseOverlaySourceDigest = "007468957cf113a6b8bd0e67f9c9ea653e09671ddc12c0abf6abe85be6389b29";
const expectedPhaseOverlayClientSha256 = "a08acc753dc315ec43f3e8ab89f0f6acc61c49e4b2f3a2901202c8968a426e20";
const expectedPhaseOverlayDiffSha256 = "9fa0f769e84d8b32e532fa2819c12e7f380b9c83a5a20ae494e458d88c847d0c";
const expectedPhaseOverlayFullDiffSha256 = "45676f335df5fabbe038565b5bec12d938b45b06769127adbabf57655c77340d";
const expectedPhaseOverlayTestSha256 = "435b5b44448b01010fe1a1c99b61efec6c09c802948e7bf908d01d871c796f6c";
assert.ok(!routeProbeOnly || candidateDigest === expected361CandidateDigest, "route-probe-only is pinned to the reviewed 361 candidate digest");
const relayDiagnosticLimits = Object.freeze({ maxEvents: 256, maxBytes: 64 * 1024 });
const frozenSourceInputs = routeProbeOnly
  ? await validateFrozenCandidateSourceInputs({ candidateSource, candidateDigest, privateCandidateBoundary })
  : await validateFrozenSourceInputs({
    candidateSource,
    candidateDigest,
    mobileWebSource,
    mobileWebManifestPath,
    mobileWebProvenancePath,
    mobileBundleSha256,
    privateCandidateBoundary,
    privateWebBoundary,
  });
const candidateFileCount = frozenSourceInputs.candidateFileCount;
const mobileWebSourceTreeSha256 = frozenSourceInputs.mobileWebSourceTreeSha256 ?? null;
const mobileDependencySourceTreeSha256 = frozenSourceInputs.mobileDependencySourceTreeSha256 ?? null;
const mobileDependencyOwnedTreeSha256 = frozenSourceInputs.mobileDependencyOwnedTreeSha256 ?? null;
const attachmentRetentionSha256 = frozenSourceInputs.attachmentRetentionSha256 ?? null;
const nodeVersion = "v24.21.0";
const nodeArchiveName = "node-v24.21.0-linux-x64.tar.xz";
const nodeArchiveSha256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6";

const {
  summarizeSamples,
  summarizeRpcSamples,
  summarizeLatencyValues,
  roundMs,
  dataSocketDelta,
  summarizeResponseHeaders,
  requestFailureCategory,
  classifySshStderr,
  parseKeyValues,
  basenameSlug,
} = createPublicRelayDiagnosticHelpers({ sha256 });

await runE2E(import.meta.url, {
  testId: "mobile-high-latency-public-fullrelay-infrastructure",
  tier: "manual-live",
  modelPolicy: "model-independent public HTTPS/WSS with two isolated mock Gateways and synthetic fixtures; no Provider/model turn/task mutation; route-probe-only may perform exactly one alpha session POST in explicit single-post diagnostic mode with UNKNOWN cleanup, or the separately named two-route API probe",
  retainSuccessLogs: true,
  cleanupTimeoutMs: 30_000,
}, async context => {
  const runMarker = context.seed;
  const remoteRoot = `/tmp/kc-phone-ux-fullrelay-${runMarker}`;
  const remoteRelayRoot = `${remoteRoot}/relay`;
  const remoteRuntimeRoot = `${remoteRoot}/runtime`;
  const remoteNode = `${remoteRuntimeRoot}/node-v24.21.0-linux-x64/bin/node`;
  const remoteConfig = `${remoteRoot}/relay-config.json`;
  const remoteStatus = `${remoteRoot}/relay-status.json`;
  const remoteRelayEventLog = `${remoteRoot}/relay-events.jsonl`;
  const remotePidFile = `${remoteRoot}/relay.pid`;
  const remoteRelayLog = `${remoteRoot}/relay.log`;
  const remoteCaddyFirst = `${remoteRoot}/sidecar-control.caddyfile`;
  const remoteCaddyFinal = `${remoteRoot}/sidecar-fullrelay.caddyfile`;
  const remoteCaddyPidFile = `${remoteRoot}/sidecar.pid`;
  const remoteCaddyLog = `${remoteRoot}/sidecar.log`;
  const remoteMobileRoot = `${remoteRoot}/mobile-web-root`;
  const fixturePath = context.pathInState("private-mobile-pairing-fixtures.json");
  const stopPath = context.pathInState("stop-public-fullrelay-infra");
  const localCandidateRoot = context.pathInState("candidate");
  const localMobileRoot = context.pathInState("mobile-web-root");
  const registrationKey = randomBytes(32).toString("base64url");
  const pairing = {
    alpha: randomBytes(32).toString("base64url"),
    beta: randomBytes(32).toString("base64url"),
  };
  for (const secret of [registrationKey, ...Object.values(pairing)]) context.registerSecret(secret);
  console.log(JSON.stringify({ stage: "run-context-ready", runRoot: context.runRoot, ownerPid: process.pid, sshTargetConfigured: Boolean(configuredCloudHost) }));

  const candidateCopy = await copyVerifiedSnapshot({
    sourceRoot: candidateSource,
    destination: localCandidateRoot,
    expectedDigest: candidateDigest,
    expectedCount: candidateFileCount,
  });
  let mobileCopy = null;
  if (routeProbeOnly) {
    await mkdir(localMobileRoot, { recursive: true, mode: 0o700 });
    await writeFile(resolve(localMobileRoot, "index.html"), "<!doctype html><title>private route probe</title><main>private route probe</main>\n", { flag: "wx", mode: 0o600 });
  } else {
    const attachmentRetentionSource = resolve(localCandidateRoot, "apps/kcoder-studio/shared/attachmentRetention.ts");
    assert.equal(sha256(await readFile(attachmentRetentionSource)), attachmentRetentionSha256);
    mobileCopy = await copyFrozenMobileWeb({
      sourceRoot: mobileWebSource,
      destination: localMobileRoot,
      manifestPath: mobileWebManifestPath,
      expectedBundleSha256: mobileBundleSha256,
      expectedSourceTreeSha256: mobileWebSourceTreeSha256,
      expectedDependencySourceTreeSha256: mobileDependencySourceTreeSha256,
      expectedDependencyOwnedTreeSha256: mobileDependencyOwnedTreeSha256,
    });
    const mobileWebProvenance = JSON.parse(await readFile(mobileWebProvenancePath, "utf8"));
    assert.equal(mobileWebProvenance.status, "complete");
    assert.equal(mobileWebProvenance.candidateDigest, candidateDigest);
    assert.equal(mobileWebProvenance.candidateFiles, candidateFileCount);
    assert.equal(mobileWebProvenance.bundleSha256, mobileBundleSha256);
    assert.equal(mobileWebProvenance.sourceTreeSha256, mobileWebSourceTreeSha256);
    await context.writeArtifactJson("frozen-mobile-web-provenance.json", {
      sourceSetName,
      status: mobileWebProvenance.status,
      candidateDigest: mobileWebProvenance.candidateDigest,
      candidateFiles: mobileWebProvenance.candidateFiles,
      sourceTreeSha256: mobileWebProvenance.sourceTreeSha256,
      bundleSha256: mobileWebProvenance.bundleSha256,
      bundleFileCount: mobileWebProvenance.bundleFileCount,
      manifestSha256: sha256(await readFile(mobileWebManifestPath)),
      provenanceSha256: sha256(await readFile(mobileWebProvenancePath)),
    });
  }
  const candidateRelayRoot = resolve(localCandidateRoot, "apps/kcoder-relay");
  const candidateStudioRoot = resolve(localCandidateRoot, "apps/kcoder-studio");
  let localRelayRuntimeRoot = candidateRelayRoot;
  let diagnosticOverlayInfo = null;
  if (diagnosticClientOverlayEnabled) {
    diagnosticOverlayInfo = await prepareDiagnosticClientRuntime({ context, localCandidateRoot, candidateDigest, privateWebBoundary, usePhaseOverlay: routeProbeOnly });
    localRelayRuntimeRoot = diagnosticOverlayInfo.runtimeRoot;
  }
  let relayHttpDiagnosticOverlayInfo = null;
  if (singlePostDiagnosticOnly) {
    const frozenServerPath = resolve(candidateRelayRoot, "src/server.mjs");
    const runtimeServerPath = resolve(localRelayRuntimeRoot, "src/server.mjs");
    const frozenServerSha256 = sha256(await readFile(frozenServerPath));
    assert.equal(frozenServerSha256, RELAY_HTTP_DIAGNOSTIC_BASE_SHA256, "single-post mode must use the fixed 361 Relay server base");
    const helperBytes = await readFile(relayHttpObservationHelperPath);
    const helperSha256 = sha256(helperBytes);
    assert.equal(helperSha256, expectedRelayHttpObservationHelperSha256, "Relay HTTP observation helper source changed after review");
    const baseServerSource = await readFile(runtimeServerPath, "utf8");
    const overlay = applyRelayPublicHttpDiagnosticOverlay(baseServerSource);
    assert.equal(overlay.baseSha256, RELAY_HTTP_DIAGNOSTIC_BASE_SHA256);
    assert.equal(overlay.sourceSha256, RELAY_HTTP_DIAGNOSTIC_OVERLAY_SHA256);
    await writeFile(runtimeServerPath, overlay.source, { mode: 0o600 });
    const runtimeServerSha256 = sha256(await readFile(runtimeServerPath));
    assert.equal(runtimeServerSha256, RELAY_HTTP_DIAGNOSTIC_OVERLAY_SHA256, "only the private Relay runtime copy receives the HTTP observation overlay");
    assert.equal(sha256(await readFile(frozenServerPath)), RELAY_HTTP_DIAGNOSTIC_BASE_SHA256, "the frozen candidate Relay server remains unchanged");
    relayHttpDiagnosticOverlayInfo = {
      enabled: true,
      mode: overlay.patchVersion,
      baseServerSha256: frozenServerSha256,
      overlayServerSha256: runtimeServerSha256,
      helperSha256,
      caddyAccessLog: "disabled",
    };
    await context.writeArtifactJson("relay-public-http-diagnostic-overlay.json", relayHttpDiagnosticOverlayInfo);
    await context.writeArtifactJson("public-edge-observation-policy.json", {
      relayServerDiagnostics: "enabled-in-run-private-runtime-copy-only",
      caddyAccessLog: "disabled",
      caddyAccessLogReason: "the current sidecar formatter has not been independently proven to whitelist every field; no Caddy request URI, query, header, response-header, or peer-address log is emitted",
      futureCaddyLogGate: "require exact-binary validation of an explicit safe-field-only formatter before enabling any temporary access log",
    });
  }
  await symlink(resolve(repoRoot, "apps/kcoder-relay/node_modules"), resolve(candidateRelayRoot, "node_modules"), "dir");
  await symlink(resolve(repoRoot, "apps/kcoder-studio/node_modules"), resolve(candidateStudioRoot, "node_modules"), "dir");
  if (localRelayRuntimeRoot !== candidateRelayRoot) {
    await symlink(resolve(repoRoot, "apps/kcoder-relay/node_modules"), resolve(localRelayRuntimeRoot, "node_modules"), "dir");
  }

  const cloudHost = await startRunOwnedSshMaster(context, configuredCloudHost, runMarker);
  const masterRecord = context.processes.get(sshMasterLabel);
  await context.writeArtifactJson("ssh-multiplex-owner.json", {
    transport: "run-owned OpenSSH ControlMaster",
    controlDirectory: cloudHost.controlDirectory,
    controlPath: cloudHost.controlPath,
    directoryMode: "0700",
    ownerUid: process.getuid(),
    masterPid: masterRecord?.pid ?? null,
    masterLabel: sshMasterLabel,
  });

  const productionBefore = await inspectProductionCaddy(context, cloudHost);
  assert.equal(productionBefore.configSha256, expectedProductionConfigSha256, "production Caddy source must match the reviewed baseline");
  const sidecarBefore = await inspectSidecar(cloudHost, sidecarConfigPath);
  assert.equal(sidecarBefore.configSha256, expectedSidecarConfigSha256, "owned TLS sidecar source must match its reviewed baseline");
  assert.notEqual(sidecarBefore.pid, productionBefore.pid, "the sidecar and production Caddy must be distinct processes");
  let relayStatus = null;
  let activeSidecarPid = sidecarBefore.pid;
  context.addCleanup("independently verify restored test infrastructure and unchanged production Caddy", async () => {
    const verification = {
      status: "capturing",
      publicOrigin,
      routeProbeOnly,
      productionBefore: { pid: productionBefore.pid, configSha256: productionBefore.configSha256 },
      expectedProductionConfigSha256,
      expectedSidecarConfigSha256,
      remoteRoot,
      relayPid: relayStatus?.pid ?? null,
      relayPorts: relayStatus ? { control: relayStatus.controlPort, proxy: relayStatus.proxyPort } : null,
    };
    try {
      const productionAfterCleanup = await inspectProductionCaddy(context, cloudHost, productionBefore.pid);
      verification.productionAfterCleanup = { pid: productionAfterCleanup.pid, configSha256: productionAfterCleanup.configSha256 };
      assert.deepEqual(productionAfterCleanup, productionBefore, "production Caddy must match its preflight PID and config after owned cleanup");
      const productionListener = await remoteOutput(cloudHost, "sudo -n ss -H -ltnp 'sport = :8451'", 10_000);
      verification.production8451ListenerOwnerMatches = productionListener.includes(`pid=${productionBefore.pid},`);
      assert.equal(verification.production8451ListenerOwnerMatches, true, "production 8451 listener must remain owned by the preflight Caddy PID");

      const sidecarAfterCleanup = await inspectSidecar(cloudHost, sidecarConfigPath);
      verification.sidecarAfterCleanup = { pid: sidecarAfterCleanup.pid, configSha256: sidecarAfterCleanup.configSha256 };
      assert.equal(sidecarAfterCleanup.configSha256, expectedSidecarConfigSha256, "isolated 443 sidecar must be restored to the exact baseline config");
      assert.notEqual(sidecarAfterCleanup.pid, productionAfterCleanup.pid, "restored sidecar and production Caddy must remain distinct");
      const sidecarListener = await remoteOutput(cloudHost, "sudo -n ss -H -ltnp 'sport = :443'", 10_000);
      verification.sidecar443ListenerOwnerMatches = sidecarListener.includes(`pid=${sidecarAfterCleanup.pid},`);
      assert.equal(verification.sidecar443ListenerOwnerMatches, true, "restored 443 listener must belong to the exact original sidecar config process");

      const rootState = await remoteOutput(cloudHost, `if test -L ${remoteRoot}; then echo symlink; elif test -e ${remoteRoot}; then echo present; else echo absent; fi`, 10_000);
      verification.remoteRootState = rootState;
      assert.equal(rootState, "absent", "the exact run-owned remote root must be absent after cleanup");
      if (relayStatus) {
        const pidState = await remoteOutput(cloudHost, `sudo -n bash -c 'if test -d /proc/$1; then ps -p "$1" -o pid=,stat=,comm=; else echo absent; fi' _ ${relayStatus.pid}`, 10_000);
        verification.relayPidState = pidState.trim() === "absent" ? "absent" : "present";
        assert.equal(pidState.trim(), "absent", "owned Relay PID must be absent after cleanup");
        const listeners = {};
        for (const [name, port] of [["control", relayStatus.controlPort], ["proxy", relayStatus.proxyPort]]) {
          listeners[name] = await remoteOutput(cloudHost, `sudo -n ss -H -ltnp 'sport = :${port}'`, 10_000);
        }
        verification.relayPortListeners = Object.fromEntries(Object.entries(listeners).map(([name, value]) => [name, value.includes(`pid=${relayStatus.pid},`) ? "owned-listener-remains" : "owned-listener-absent"]));
        assert.ok(Object.values(verification.relayPortListeners).every(value => value === "owned-listener-absent"), "owned Relay listeners must be absent after cleanup");
      }
      verification.status = "verified";
      await context.writeArtifactJsonInternal("public-fullrelay-independent-final-readonly.json", verification);
    } catch (error) {
      verification.status = "UNVERIFIED";
      verification.errorCategory = requestFailureCategory(error);
      await context.writeArtifactJsonInternal("public-fullrelay-independent-final-readonly.json", verification).catch(() => {});
      throw error;
    }
  });

  context.addCleanup("stop isolated cloud Relay and remove its private runtime/store", async () => {
    await stopAndRemoveRemoteRelay({
      context,
      cloudHost,
      remoteRoot,
      remotePidFile,
      remoteRelayRoot,
      remoteRelayLog,
      remoteRelayEventLog,
      remoteCaddyLog,
      remoteStatus,
    });
  });
  await remoteOutput(cloudHost, `umask 077; mkdir -m 700 ${remoteRoot}; mkdir -m 700 ${remoteRuntimeRoot} ${remoteRelayRoot} ${remoteMobileRoot}`);

  const nodeMetadata = await installPrivateNodeRuntime({ context, cloudHost, remoteRoot, remoteRuntimeRoot, remoteNode });
  assert.equal(nodeMetadata.version, nodeVersion);
  assert.equal(nodeMetadata.archiveSha256, nodeArchiveSha256);
  console.log(JSON.stringify({ stage: "private-cloud-node-verified", ownerPid: process.pid, nodeVersion: nodeMetadata.version, binarySha256: nodeMetadata.binarySha256 }));
  await uploadCandidateRelay({ context, cloudHost, relaySourceRoot: localRelayRuntimeRoot, remoteRelayRoot });
  if (singlePostDiagnosticOnly) {
    const helperBytes = await readFile(relayHttpObservationHelperPath);
    assert.equal(sha256(helperBytes), expectedRelayHttpObservationHelperSha256, "Relay HTTP observer helper must match the reviewed source pin before upload");
    await sshWrite(context, "upload-relay-http-phase-observer", cloudHost, `umask 077; cat > ${remoteRoot}/relay-http-phase-observation.mjs`, helperBytes);
  }
  const remoteEntry = makeRemoteRelayEntry();
  await sshWrite(context, "upload-cloud-relay-entry", cloudHost, `umask 077; cat > ${remoteRoot}/relay-entry.mjs`, Buffer.from(remoteEntry));
  const relayConfig = {
    registrationKey,
    sharedHosts: ["hyf2333.top"],
    registrationStoreFile: `${remoteRelayRoot}/registration-store.json`,
    enableHttpDiagnostics: singlePostDiagnosticOnly,
  };
  await sshWrite(context, "upload-cloud-relay-config", cloudHost, `umask 077; cat > ${remoteConfig}`, Buffer.from(JSON.stringify(relayConfig)));
  await startRemoteRelay({ cloudHost, remoteRoot, remoteNode, remotePidFile, remoteStatus, remoteRelayEventLog, remoteRelayLog });
  relayStatus = await readRemoteRelayStatus({ cloudHost, remoteStatus, remotePidFile });
  assert.ok(relayStatus.controlPort > 0 && relayStatus.proxyPort > 0);
  context.registerPort("cloud-fullrelay-control-loopback", relayStatus.controlPort);
  context.registerPort("cloud-fullrelay-public-proxy-loopback", relayStatus.proxyPort);
  console.log(JSON.stringify({ stage: "isolated-cloud-relay-live", ownerPid: process.pid, relayPid: relayStatus.pid, controlLoopbackPort: relayStatus.controlPort, publicProxyLoopbackPort: relayStatus.proxyPort }));

  if (routeProbeOnly) await uploadRouteProbeStaticRoot({ context, cloudHost, remoteMobileRoot });
  else await uploadStaticRoot({ context, cloudHost, localMobileRoot, remoteMobileRoot });
  const oldCaddyBase64 = await remoteOutput(cloudHost, `base64 -w0 ${sidecarConfigPath}`);
  const oldCaddySource = Buffer.from(oldCaddyBase64, "base64").toString("utf8");
  assert.equal(sha256(oldCaddySource), expectedSidecarConfigSha256, "sidecar source changed before candidate generation");
  const marker = `kc_fullrelay_${runMarker}`;
  const firstConfig = buildSidecarConfig(oldCaddySource, {
    marker,
    root: remoteMobileRoot,
    controlPort: relayStatus.controlPort,
    proxyPort: relayStatus.proxyPort,
  });
  const firstCandidate = await installAndValidateSidecarCandidate({
    context,
    cloudHost,
    remotePath: remoteCaddyFirst,
    content: firstConfig,
    expectedBaseSha256: expectedSidecarConfigSha256,
    rootConfigPath: sidecarConfigPath,
    marker,
    ids: [],
  });

  let sidecarRestored = false;
  context.addCleanup("restore the original isolated TLS sidecar without touching production Caddy", async () => {
    await restoreOriginalSidecar({
      context,
      cloudHost,
      testConfigPaths: [remoteCaddyFirst, remoteCaddyFinal],
      originalConfig: sidecarConfigPath,
      productionBefore,
      remoteCaddyPidFile,
      remoteCaddyLog,
    });
    sidecarRestored = true;
  });
  activeSidecarPid = await restartOwnedSidecar({
    context,
    cloudHost,
    currentPid: sidecarBefore.pid,
    expectedCurrentConfig: sidecarConfigPath,
    candidateConfig: remoteCaddyFirst,
    pidFile: remoteCaddyPidFile,
    logFile: remoteCaddyLog,
    productionBefore,
  });
  console.log(JSON.stringify({ stage: "isolated-sidecar-control-route-live", ownerPid: process.pid, sidecarPid: activeSidecarPid, publicOrigin }));
  await waitForPublicRoot();

  const gateways = {};
  const clients = {};
  const identities = {};
  const registrationStatuses = {};
  const transportObservations = Object.fromEntries(["alpha", "beta"].map(name => [name, {
    registration: null,
    controlWssOpen: [],
  }]));
  const diagnosticCollectors = diagnosticClientOverlayEnabled
    ? Object.fromEntries(["alpha", "beta"].map(name => [name, routeProbeOnly
      ? createBoundedPhaseDiagnosticCollector({ redactText: text => context.redactText(text), ...relayDiagnosticLimits })
      : createBoundedRelayDiagnosticCollector({ redactText: text => context.redactText(text), ...relayDiagnosticLimits })]))
    : null;
  const workspaces = {};
  const allowedOrigins = publicOrigin;
  for (const name of ["alpha", "beta"]) {
    const workspaceId = `public-fullrelay-${name}-${runMarker.slice(0, 6)}`;
    workspaces[name] = (await materializeWorkspace(context, "minimal", { instanceId: workspaceId })).path;
    const serversFile = await context.writeStateJson(`servers-${name}.json`, [{
      id: `public-fixture-${name}`,
      label: `Public UX fixture ${name}`,
      runtime: "kcoder",
      transport: "local",
      command: resolve(repoRoot, "target/debug/kcoder"),
      workspace: workspaces[name],
    }]);
    const serversStore = context.pathInState(`gateway-${name}/servers-store.json`);
    await mkdir(dirname(serversStore), { recursive: true, mode: 0o700 });
    const authToken = pairing[name];
    const env = context.isolatedEnvironment({
      KCODER_STUDIO_HOST: "127.0.0.1",
      KCODER_STUDIO_PORT: "0",
      KCODER_STUDIO_KCODER_BIN: resolve(repoRoot, "target/debug/kcoder"),
      KCODER_STUDIO_WORKSPACE: workspaces[name],
      KCODER_STUDIO_WEB_ROOT: localMobileRoot,
      KCODER_STUDIO_SERVERS_FILE: serversFile,
      KCODER_STUDIO_SERVERS_STORE: serversStore,
      KCODER_STUDIO_AUTH_TOKEN: authToken,
      KCODER_STUDIO_MOCK: "1",
      KCODER_STUDIO_PUBLIC_ORIGINS: allowedOrigins,
      KCODER_STUDIO_MOBILE_WEB_ORIGINS: allowedOrigins,
      KCODER_CONFIG_DIR: context.pathInState(`gateway-${name}/config`),
    });
    const child = context.spawnOwned(`candidate-gateway-${name}`, process.execPath, ["dev-server.mjs"], {
      cwd: candidateStudioRoot,
      env,
    });
    const logPath = context.processes.get(`candidate-gateway-${name}`).logPath;
    const port = await waitFor(async () => {
      const log = await readFile(logPath, "utf8").catch(() => "");
      const match = log.match(/KCoder Studio: http:\/\/[^:]+:(\d+)/);
      if (child.exitCode !== null) throw new Error(`candidate Gateway ${name} exited; inspect its private run log`);
      return match ? Number(match[1]) : null;
    }, 20_000, `candidate Gateway ${name} startup`, 100, context.abortSignal);
    context.registerPort(`candidate-gateway-${name}`, port);
    gateways[name] = { child, port, authToken };
  }

  const clientModule = await import(pathToFileURL(resolve(localRelayRuntimeRoot, "src/client.mjs")).href);
  const identityModule = await import(pathToFileURL(resolve(localRelayRuntimeRoot, "src/client-identity.mjs")).href);
  for (const name of ["alpha", "beta"]) {
    const identityFile = context.pathInState(`relay-client-${name}.json`);
    if (routeProbeOnly) {
      context.addCleanup(`remove private route-probe ${name} Relay identity`, async () => {
        await unlink(identityFile).catch(error => {
          if (error?.code !== "ENOENT") throw error;
        });
      });
    }
    let onlineCount = 0;
    let registrationStatus = null;
    const client = await clientModule.startRegisteredClient({
      url: publicOrigin,
      registrationKey,
      pairingToken: pairing[name],
      identityFile,
      gateway: `http://127.0.0.1:${gateways[name].port}`,
      retryMs: 500,
      fetchImpl: async (input, init) => {
        const startedAt = performance.now();
        const response = await fetch(input, init);
        registrationStatus = response.status;
        transportObservations[name].registration = {
          observedAt: new Date().toISOString(),
          elapsedMs: roundMs(performance.now() - startedAt),
          httpStatus: response.status,
        };
        return response;
      },
      onOnline: () => {
        onlineCount += 1;
        transportObservations[name].controlWssOpen.push({ event: "open", observedAt: new Date().toISOString() });
      },
      ...(diagnosticCollectors ? { onDiagnostic: record => diagnosticCollectors[name].push(record) } : {}),
    });
    clients[name] = { client, onlineCount: () => onlineCount };
    registrationStatuses[name] = () => registrationStatus;
    context.addCleanup(`close public registered Gateway client ${name}`, async () => {
      await client.close();
      transportObservations[name].controlWssOpen.push({ event: "client-close-requested", observedAt: new Date().toISOString() });
      await writeRelayClientDiagnosticArtifact({
        context,
        gatewayName: name,
        identity: identities[name],
        collector: diagnosticCollectors?.[name],
        overlayInfo: diagnosticOverlayInfo,
        phase: "close-request",
      });
      await writeDiagnosticArtifact(context, `public-client-${name}-close-request-observation.json`, {
        gateway: name,
        routeFingerprint: identities[name]?.id ? sha256(identities[name].id) : null,
        closeScope: "close-request-only; client.close() returns void; asynchronous socket close events may not be included",
        events: transportObservations[name].controlWssOpen,
      }, { internal: true });
    });
    identities[name] = await identityModule.readRegisteredClientIdentity({
      identityFile,
      relayUrl: publicOrigin,
      pairingToken: pairing[name],
    });
    context.registerSecret(identities[name].secret);
    context.registerSecret(identities[name].id);
    await writeDiagnosticArtifact(context, `public-registration-${name}-observation.json`, {
      gateway: name,
      routeFingerprint: sha256(identities[name].id),
      registration: transportObservations[name].registration,
    });
  }
  assert.notEqual(identities.alpha.id, identities.beta.id, "the cloud Relay must assign separate test Gateway identities");
  await waitFor(
    () => Object.values(clients).every(client => client.onlineCount() >= 1) ? true : null,
    30_000,
    "two Gateway clients connected through public control WSS",
    150,
    context.abortSignal,
  );
  console.log(JSON.stringify({ stage: "candidate-gateways-registered-over-public-https-wss", ownerPid: process.pid, relayPid: relayStatus.pid, gatewayPorts: Object.fromEntries(Object.entries(gateways).map(([name, gateway]) => [name, gateway.port])) }));
  assert.equal(registrationStatuses.alpha(), 201, "alpha registration must have traversed public HTTPS");
  assert.equal(registrationStatuses.beta(), 201, "beta registration must have traversed public HTTPS");
  await context.writeArtifactJson("public-registration-control-observation.json", {
    phase: "initial-public-control-wss",
    gateways: summarizeTransportObservations(transportObservations, identities),
  });

  const finalConfig = buildSidecarConfig(oldCaddySource, {
    marker,
    root: remoteMobileRoot,
    controlPort: relayStatus.controlPort,
    proxyPort: relayStatus.proxyPort,
    ids: [identities.alpha.id, identities.beta.id],
  });
  const finalCandidate = await installAndValidateSidecarCandidate({
    context,
    cloudHost,
    remotePath: remoteCaddyFinal,
    content: finalConfig,
    expectedBaseSha256: expectedSidecarConfigSha256,
    rootConfigPath: sidecarConfigPath,
    marker,
    ids: [identities.alpha.id, identities.beta.id],
  });
  const previousOnline = Object.fromEntries(Object.entries(clients).map(([name, state]) => [name, state.onlineCount()]));
  activeSidecarPid = await restartOwnedSidecar({
    context,
    cloudHost,
    currentPid: activeSidecarPid,
    expectedCurrentConfig: remoteCaddyFirst,
    candidateConfig: remoteCaddyFinal,
    pidFile: remoteCaddyPidFile,
    logFile: remoteCaddyLog,
    productionBefore,
  });
  await waitForPublicRoot();
  await waitFor(
    () => Object.entries(clients).every(([name, state]) => state.onlineCount() > previousOnline[name]) ? true : null,
    30_000,
    "both Gateway clients reconnected through public control WSS after the final exact-route sidecar restart",
    200,
    context.abortSignal,
  );
  await context.writeArtifactJson("public-control-reconnect-observation.json", {
    phase: "after-isolated-sidecar-restart",
    gateways: summarizeTransportObservations(transportObservations, identities),
    onlineCountBeforeRestart: previousOnline,
    onlineCountAfterRestart: Object.fromEntries(Object.entries(clients).map(([name, state]) => [name, state.onlineCount()])),
  });

  if (routeProbeOnly) {
    const routeProbe = singlePostDiagnosticOnly
      ? await runSinglePublicSessionPostDiagnostic({
        context,
        identities,
        pairing,
        diagnosticCollectors,
        diagnosticOverlayInfo,
        relayHttpDiagnosticOverlayInfo,
        cloudHost,
        remoteStatus,
        relayPid: relayStatus.pid,
      })
      : await runTwoGatewayServerListProbe({
        context,
        identities,
        pairing,
        diagnosticCollectors,
        diagnosticOverlayInfo,
        cloudHost,
        remoteStatus,
      });
    const productionAfterProbe = await inspectProductionCaddy(context, cloudHost, productionBefore.pid);
    assert.deepEqual(productionAfterProbe, productionBefore, "production Caddy must remain unchanged during the route probe");
    await assertSidecarStillRunning({ cloudHost, pid: activeSidecarPid, configPath: remoteCaddyFinal });
    const probeHandle = {
      mode: singlePostDiagnosticOnly ? "single-session-post-diagnostic-only" : "route-probe-only",
      status: "passed-before-cleanup",
      ownerPid: process.pid,
      publicOrigin,
      testHttpsPort: 443,
      productionRelayPort: 8451,
      routeTemplate: `${publicOrigin}/g/<private-id>${singlePostDiagnosticOnly ? "/api/mobile/session" : "/api/servers"}`,
      candidateDigest,
      candidateFiles: candidateCopy.fileCount,
      relayClientDiagnosticOverlay: {
        mode: diagnosticOverlayInfo.mode,
        sourceDigest: diagnosticOverlayInfo.overlaySourceDigest,
        diffSha256: diagnosticOverlayInfo.overlayDiffSha256,
        baseClientSha256: diagnosticOverlayInfo.baseClientSha256,
        runtimeClientSha256: diagnosticOverlayInfo.runtimeClientSha256,
      },
      cloudRelay: {
        pid: relayStatus.pid,
        bind: "127.0.0.1",
        controlPort: relayStatus.controlPort,
        proxyPort: relayStatus.proxyPort,
        registrationStorePath: `${remoteRelayRoot}/registration-store.json`,
      },
      gateways: Object.fromEntries(["alpha", "beta"].map(name => [name, {
        pid: gateways[name].child.pid,
        localPort: gateways[name].port,
        workspaceFingerprint: sha256(workspaces[name]),
        mockMode: true,
        registeredClientOnlineCount: clients[name].onlineCount(),
        routeFingerprint: sha256(identities[name].id),
      }])),
      sidecar: {
        pid: activeSidecarPid,
        configPath: remoteCaddyFinal,
        baselineConfigSha256: expectedSidecarConfigSha256,
        exactGatewayRouteCount: 2,
        productionCaddyPid: productionBefore.pid,
        productionConfigSha256: productionBefore.configSha256,
        productionCaddyReloaded: false,
      },
      relayHttpDiagnosticOverlay: relayHttpDiagnosticOverlayInfo,
      routeProbe,
      uiOrBrowserStarted: false,
      providerOrModelUsed: false,
      cleanupTriggerPath: null,
      automaticRequestRetry: false,
    };
    await context.writeArtifactJsonInternal(singlePostDiagnosticOnly ? "public-single-post-diagnostic-handle.json" : "public-two-gateway-route-probe-handle.json", probeHandle);
    console.log(JSON.stringify({
      stage: singlePostDiagnosticOnly ? "public-single-post-diagnostic-finished-cleanup-starting" : "public-two-gateway-route-probe-finished-cleanup-starting",
      ownerPid: process.pid,
      relayPid: relayStatus.pid,
      sidecarPid: activeSidecarPid,
      gatewayPids: Object.fromEntries(["alpha", "beta"].map(name => [name, gateways[name].child.pid])),
      sessionPostOrder: singlePostDiagnosticOnly ? ["alpha"] : undefined,
      getRequestOrder: singlePostDiagnosticOnly ? [] : ["alpha", "beta"],
      checks: routeProbe.checks ?? [],
    }));
    return { routeProbeOnly: "passed-before-cleanup", candidateDigest, routeProbe };
  }

  const routeStatus = await checkPublicRoutes(context, identities, pairing, { cloudHost, remoteStatus, diagnosticCollectors, diagnosticOverlayInfo });
  assert.deepEqual(routeStatus, { root: 200, alpha: 200, beta: 200, suffix: 404 });
  const pairingFile = await context.writeStateJson("private-mobile-pairing-fixtures.json", {
    alpha: {
      id: identities.alpha.id,
      pairingToken: pairing.alpha,
      serverId: "public-fixture-alpha",
      workspaceLabel: "Public UX fixture alpha",
      workspacePath: workspaces.alpha,
    },
    beta: {
      id: identities.beta.id,
      pairingToken: pairing.beta,
      serverId: "public-fixture-beta",
      workspaceLabel: "Public UX fixture beta",
      workspacePath: workspaces.beta,
    },
  });

  const p2bMeasurement = skipP2bTiming ? null : await measurePublicRelayLatency({
    context,
    origin: publicOrigin,
    gateway: { id: identities.alpha.id, pairingToken: pairing.alpha },
    relayHost: cloudHost,
    relayStatusPath: remoteStatus,
  });
  if (diagnosticClientOverlayEnabled) {
    if (p2bMeasurement) p2bMeasurement.measurementScope = "instrumented diagnostic probe; timings are not unbiased product-latency evidence";
  }
  await context.writeArtifactJson("public-fullrelay-p2b-timing.json", p2bMeasurement ?? {
    status: "skipped",
    reason: "explicit-full-public-ui-only-mode",
  });

  const probe = await runPublicRouteIsolationProbe(context, pairingFile, publicOrigin);
  assert.equal(probe.exitCode, 0, "full public HTTP/WSS isolation probe must pass on the cloud Relay routes");
  const publicUi = await runPublicMobileUi(context, {
    fixturePath: pairingFile,
    parentRunRoot: context.runRoot,
    origin: publicOrigin,
    sourceDigest: candidateDigest,
    bundleSha256: mobileCopy.bundleSha256,
    webManifestPath: mobileWebManifestPath,
  });
  assert.equal(publicUi.exitCode, 0, "the frozen Mobile Web UI must complete its real two-route HTTPS/WSS flow");
  const productionAfter = await inspectProductionCaddy(context, cloudHost, productionBefore.pid);
  assert.deepEqual(productionAfter, productionBefore, "production Caddy PID and source must remain unchanged");
  await assertSidecarStillRunning({ cloudHost, pid: activeSidecarPid, configPath: remoteCaddyFinal });

  const p2bChecks = p2bMeasurement
    ? [
      { name: "p2b_server_list_5_samples", status: `${p2bMeasurement.serverList.samples.length} samples` },
      { name: "p2b_rpc_initialize_5_samples", status: `${p2bMeasurement.rpcInitialize.samples.length} samples` },
      { name: "p2b_gateway_data_websocket_count", status: `${p2bMeasurement.gatewayDataSocketCount.delta} accepted` },
    ]
    : [
      { name: "p2b_server_list_5_samples", status: "SKIPPED (explicit full-public UI-only mode)" },
      { name: "p2b_rpc_initialize_5_samples", status: "SKIPPED (explicit full-public UI-only mode)" },
      { name: "p2b_gateway_data_websocket_count", status: "SKIPPED (explicit full-public UI-only mode)" },
    ];
  const checks = [
    { name: "public_https_root", status: "HTTP 200" },
    { name: "exact_route_alpha", status: "HTTP 200" },
    { name: "exact_route_beta", status: "HTTP 200" },
    { name: "gateway_id_suffix_boundary", status: "HTTP 404" },
    { name: "alpha_register_via_public_https", status: "HTTP 201" },
    { name: "beta_register_via_public_https", status: "HTTP 201" },
    { name: "alpha_control_via_public_wss", status: "connected-and-reconnected" },
    { name: "beta_control_via_public_wss", status: "connected-and-reconnected" },
    ...p2bChecks,
    { name: "full_public_http_wss_isolation_suite", status: "passed" },
    { name: "full_public_mobile_ui_suite", status: "passed" },
    { name: "production_caddy_pid_and_source", status: "unchanged" },
  ];
  const handle = {
    sourceSetName,
    ownerPid: process.pid,
    publicOrigin,
    testHttpsPort: 443,
    productionRelayPort: 8451,
    gatewayRouteTemplate: `${publicOrigin}/g/<private-id>/`,
    privateFixturePath: pairingFile,
    cleanupTriggerPath: stopPath,
    candidate: candidateCopy,
    relayClientDiagnosticOverlay: diagnosticOverlayInfo ? { ...diagnosticOverlayInfo, runtimeRoot: "state/relay-client-runtime" } : { enabled: false },
    attachmentRetentionSha256,
    mobileWeb: mobileCopy,
    localGatewayRuntime: process.version,
    cloudRelay: {
      pid: relayStatus.pid,
      bind: "127.0.0.1",
      controlPort: relayStatus.controlPort,
      proxyPort: relayStatus.proxyPort,
      registrationStorePath: `${remoteRelayRoot}/registration-store.json`,
      privateRuntime: nodeMetadata,
      sourceDigest: candidateDigest,
    },
    gateways: Object.fromEntries(Object.entries(gateways).map(([name, gateway]) => [name, {
      pid: gateway.child.pid,
      localPort: gateway.port,
      workspace: workspaces[name],
      mockMode: true,
      registeredClientOnlineCount: clients[name].onlineCount(),
    }])),
    sidecar: {
      pid: activeSidecarPid,
      configPath: remoteCaddyFinal,
      originalConfigSha256: expectedSidecarConfigSha256,
      controlCandidateSha256: firstCandidate.candidateSha256,
      fullRouteCandidateSha256: finalCandidate.candidateSha256,
      exactGatewayRouteCount: 2,
      routeContract: "/_relay/register, /_relay/control, and /_relay/data to Relay control port; two exact /g/<id> routes to Relay public proxy before suffix catchall",
      productionCaddyPid: productionBefore.pid,
      productionConfigSha256: productionBefore.configSha256,
      productionCaddyReloaded: false,
    },
    publicRouteIsolationRunRoot: probe.runRoot,
    publicMobileUiRunRoot: publicUi.runRoot,
    publicMobileUiChecks: publicUi.proof.checks,
    p2bMeasurement,
    p2bMeasurementSkipped: skipP2bTiming,
    diagnosticTimingScope: diagnosticClientOverlayEnabled ? "instrumented diagnostic probe; timings are not unbiased product-latency evidence" : null,
    checks,
  };
  await context.writeArtifactJson("public-fullrelay-handle.json", handle);
  console.log(JSON.stringify({ stage: "public-fullrelay-ready", sourceSetName, ownerPid: process.pid, sidecarPid: activeSidecarPid, relayPid: relayStatus.pid, routeChecks: routeStatus, isolationRunRoot: probe.runRoot, publicMobileUiRunRoot: publicUi.runRoot, privateFixturePath: pairingFile }));
  console.log(JSON.stringify({
    runRoot: context.runRoot,
    ownerPid: process.pid,
    sidecarPid: activeSidecarPid,
    cloudRelayPid: relayStatus.pid,
    cloudNodeVersion: nodeMetadata.version,
    cloudNodeSha256: nodeMetadata.binarySha256,
    cloudRelayPorts: { controlLoopback: relayStatus.controlPort, publicProxyLoopback: relayStatus.proxyPort },
    gatewayPorts: Object.fromEntries(Object.entries(gateways).map(([name, gateway]) => [name, gateway.port])),
    publicOrigin,
    gatewayRouteTemplate: `${publicOrigin}/g/<private-id>/`,
    candidateDigest,
    mobileWebBundleSha256: mobileCopy.bundleSha256,
    privateFixturePath: pairingFile,
    publicRouteIsolationRunRoot: probe.runRoot,
    publicMobileUiRunRoot: publicUi.runRoot,
    publicMobileUiChecks: publicUi.proof.checks,
    checks,
    cleanupTriggerPath: stopPath,
    sidecarRestored: false,
  }));

  await waitFor(async () => {
    try { await access(stopPath); return true; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }, 24 * 60 * 60_000, "parent cleanup trigger", 500, context.abortSignal);

  return {
    publicFullRelaySetup: "passed",
    fullPublicHttpWssIsolation: "passed",
    fullPublicMobileUi: "passed",
    candidateDigest,
    mobileWebBundleSha256: mobileCopy.bundleSha256,
    cleanupTriggerObserved: true,
    sidecarRestored,
  };
});

function requiredInput(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for an explicit frozen-source run`);
  return value;
}

function requiredSha256(name) {
  const value = requiredInput(name);
  assert.match(value, /^[a-f0-9]{64}$/i, `${name} must be a SHA-256 digest`);
  return value.toLowerCase();
}

function resolvePrivateInput(name, privateBoundary) {
  const value = requiredInput(name);
  const resolved = resolve(repoRoot, value);
  const relativePath = relative(privateBoundary, resolved);
  assert.ok(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
    `${name} must stay inside its designated private target directory`,
  );
  return resolved;
}

async function assertPrivatePath(path, privateBoundary, expectedKind) {
  const boundaryInfo = await lstat(privateBoundary);
  assert.ok(boundaryInfo.isDirectory() && !boundaryInfo.isSymbolicLink(), "private input boundary must be a real directory");
  assert.equal(await realpath(privateBoundary), privateBoundary, "private input boundary cannot resolve through a symlink");

  const relativePath = relative(privateBoundary, path);
  assert.ok(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath),
    "selected frozen input escaped its private target directory",
  );
  let current = privateBoundary;
  const parts = relativePath.split(sep);
  let currentInfo;
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]);
    currentInfo = await lstat(current);
    assert.ok(!currentInfo.isSymbolicLink(), "frozen input path cannot traverse a symlink");
    if (index < parts.length - 1) assert.ok(currentInfo.isDirectory(), "frozen input parent must be a directory");
  }
  assert.equal(await realpath(path), path, "frozen input cannot resolve outside its selected path");
  if (expectedKind === "directory") assert.ok(currentInfo.isDirectory(), "frozen input directory is missing");
  else assert.ok(currentInfo.isFile(), "frozen input file is missing");
}

async function validateFrozenSourceInputs({
  candidateSource,
  candidateDigest,
  mobileWebSource,
  mobileWebManifestPath,
  mobileWebProvenancePath,
  mobileBundleSha256,
  privateCandidateBoundary,
  privateWebBoundary,
}) {
  await assertPrivatePath(candidateSource, privateCandidateBoundary, "directory");
  await assertPrivatePath(mobileWebSource, privateWebBoundary, "directory");
  await assertPrivatePath(mobileWebManifestPath, privateWebBoundary, "file");
  await assertPrivatePath(mobileWebProvenancePath, privateWebBoundary, "file");

  const freezePath = resolve(candidateSource, "freeze.json");
  const metadataPath = resolve(candidateSource, "metadata.json");
  let candidateMetadataPath = metadataPath;
  try {
    await lstat(freezePath);
    candidateMetadataPath = freezePath;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await assertPrivatePath(candidateMetadataPath, candidateSource, "file");
  const candidateMetadata = JSON.parse(await readFile(candidateMetadataPath, "utf8"));
  assert.equal(candidateMetadata.sourceDigest, candidateDigest, "frozen candidate sourceDigest must equal the explicitly supplied expected digest");
  const candidateFileCount = candidateMetadata.count ?? candidateMetadata.files;
  assert.ok(Number.isSafeInteger(candidateFileCount) && candidateFileCount > 0, "frozen candidate metadata must declare its file count");

  const candidateHashesPath = resolve(candidateSource, "sha256.json");
  await assertPrivatePath(candidateHashesPath, candidateSource, "file");
  const candidateHashes = JSON.parse(await readFile(candidateHashesPath, "utf8"));
  assert.equal(Object.keys(candidateHashes).length, candidateFileCount, "candidate manifest file count must match its metadata");
  const attachmentRetentionPath = "apps/kcoder-studio/shared/attachmentRetention.ts";
  const attachmentRetentionSha256 = candidateHashes[attachmentRetentionPath];
  assert.match(attachmentRetentionSha256 ?? "", /^[a-f0-9]{64}$/i, "candidate manifest must include attachmentRetention.ts");
  for (const [sourcePath, importSpecifier] of [
    ["apps/kcoder-studio/mobile/src/features/task/useTaskSending.ts", "../../../../shared/attachmentRetention"],
    ["apps/kcoder-studio/mobile/src/storage/thread-deletion-cleanup.ts", "../../../shared/attachmentRetention"],
  ]) {
    assert.match(candidateHashes[sourcePath] ?? "", /^[a-f0-9]{64}$/i, "candidate manifest must include attachmentRetention runtime callers");
    const source = await readFile(resolve(candidateSource, sourcePath), "utf8");
    assert.ok(source.includes(importSpecifier), "frozen Mobile runtime caller must import the frozen shared contract");
  }

  const mobileWebManifest = JSON.parse(await readFile(mobileWebManifestPath, "utf8"));
  assert.equal(mobileWebManifest.status, "complete", "Mobile Web manifest must be complete");
  assert.equal(mobileWebManifest.sourceUnchanged, true);
  assert.equal(mobileWebManifest.snapshotCopyMatchesSource, true);
  assert.equal(mobileWebManifest.snapshotUnchangedDuringExport, true);
  assert.equal(mobileWebManifest.bundleSha256, mobileBundleSha256, "Mobile Web bundle must match the explicitly supplied expected digest");
  assert.ok(Array.isArray(mobileWebManifest.bundleFiles) && mobileWebManifest.bundleFiles.length > 0, "Mobile Web manifest must list bundle files");
  const javascriptBundlePaths = mobileWebManifest.bundleFiles.filter(file => file.path.endsWith(".js")).map(file => file.path);
  assert.ok(javascriptBundlePaths.length > 0, "Mobile Web export must include a JavaScript runtime bundle");
  for (const path of javascriptBundlePaths) await assertPrivatePath(resolve(mobileWebSource, path), mobileWebSource, "file");
  const javascriptBundleText = (await Promise.all(javascriptBundlePaths.map(path => readFile(resolve(mobileWebSource, path), "utf8")))).join("\n");
  assert.ok(javascriptBundleText.includes("gateway/attachments/retain"), "Mobile Web bundle must include the attachment retain runtime operation");
  assert.ok(javascriptBundleText.includes("gateway/attachments/discardRetained"), "Mobile Web bundle must include the attachment cleanup runtime operation");
  assert.ok(Array.isArray(mobileWebManifest.inputRoots) && mobileWebManifest.inputRoots.length > 0, "Mobile Web manifest must name its frozen source roots");
  for (const inputRoot of mobileWebManifest.inputRoots) {
    assert.equal(typeof inputRoot.sourceRoot, "string", "Mobile Web source root must be explicit in the manifest");
    const sourceRoot = isAbsolute(inputRoot.sourceRoot)
      ? resolve(inputRoot.sourceRoot)
      : resolve(candidateSource, inputRoot.sourceRoot);
    await assertPrivatePath(sourceRoot, candidateSource, "directory");
  }
  const dependencyProvenance = mobileWebManifest.dependencyProvenance;
  assert.ok(dependencyProvenance, "Mobile Web manifest must include dependency provenance");
  assert.equal(dependencyProvenance.sourceUnchanged, true);
  assert.equal(dependencyProvenance.sourceTreeSha256Before, dependencyProvenance.sourceTreeSha256After);
  assert.equal(dependencyProvenance.copiedSymlinks, false, "Mobile Web build dependencies must be copied without symlinks");
  assert.match(dependencyProvenance.sourceTreeSha256Before ?? "", /^[a-f0-9]{64}$/i);
  assert.match(dependencyProvenance.copiedTreeSha256 ?? "", /^[a-f0-9]{64}$/i);
  assert.equal(typeof dependencyProvenance.sourceRoot, "string", "Mobile Web dependency snapshot root must be explicit in the manifest");
  const dependencySnapshotRoot = isAbsolute(dependencyProvenance.sourceRoot)
    ? resolve(dependencyProvenance.sourceRoot)
    : resolve(privateWebBoundary, dependencyProvenance.sourceRoot);
  const dependencySnapshotRelative = relative(privateWebBoundary, dependencySnapshotRoot);
  assert.ok(
    dependencySnapshotRelative && dependencySnapshotRelative !== ".." && !dependencySnapshotRelative.startsWith(`..${sep}`) && !isAbsolute(dependencySnapshotRelative),
    "Mobile Web dependency snapshot must remain under the private export directory",
  );

  const mobileWebProvenance = JSON.parse(await readFile(mobileWebProvenancePath, "utf8"));
  assert.equal(mobileWebProvenance.status, "complete");
  assert.equal(mobileWebProvenance.candidateDigest, candidateDigest, "Web export provenance must match the explicitly supplied candidate digest");
  assert.equal(mobileWebProvenance.candidateFiles, candidateFileCount);
  assert.equal(mobileWebProvenance.bundleSha256, mobileBundleSha256);
  assert.equal(mobileWebProvenance.sourceTreeSha256, mobileWebManifest.sourceTreeSha256);
  assert.equal(mobileWebProvenance.dependencyInput?.sourceTreeSha256, dependencyProvenance.sourceTreeSha256Before);
  assert.equal(mobileWebProvenance.dependencyInput?.ownedTreeSha256, dependencyProvenance.copiedTreeSha256);

  return {
    candidateFileCount,
    attachmentRetentionSha256,
    mobileWebSourceTreeSha256: mobileWebManifest.sourceTreeSha256,
    mobileDependencySourceTreeSha256: dependencyProvenance.sourceTreeSha256Before,
    mobileDependencyOwnedTreeSha256: dependencyProvenance.copiedTreeSha256,
  };
}

async function validateFrozenCandidateSourceInputs({ candidateSource, candidateDigest, privateCandidateBoundary }) {
  await assertPrivatePath(candidateSource, privateCandidateBoundary, "directory");
  const freezePath = resolve(candidateSource, "freeze.json");
  const metadataPath = resolve(candidateSource, "metadata.json");
  let candidateMetadataPath = metadataPath;
  try {
    await lstat(freezePath);
    candidateMetadataPath = freezePath;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await assertPrivatePath(candidateMetadataPath, candidateSource, "file");
  const candidateMetadata = JSON.parse(await readFile(candidateMetadataPath, "utf8"));
  assert.equal(candidateMetadata.sourceDigest, candidateDigest, "frozen candidate sourceDigest must equal the explicitly supplied expected digest");
  const candidateFileCount = candidateMetadata.count ?? candidateMetadata.files;
  assert.ok(Number.isSafeInteger(candidateFileCount) && candidateFileCount > 0, "frozen candidate metadata must declare its file count");
  const candidateHashesPath = resolve(candidateSource, "sha256.json");
  await assertPrivatePath(candidateHashesPath, candidateSource, "file");
  const candidateHashes = JSON.parse(await readFile(candidateHashesPath, "utf8"));
  assert.equal(Object.keys(candidateHashes).length, candidateFileCount, "candidate manifest file count must match its metadata");
  return { candidateFileCount };
}

async function prepareDiagnosticClientRuntime({ context, localCandidateRoot, candidateDigest, privateWebBoundary, usePhaseOverlay = false }) {
  assert.ok(candidateDigest === expected212651CandidateDigest || candidateDigest === expected361CandidateDigest, "the diagnostic client overlay is pinned only to the approved frozen 212651 and 361 candidates");
  assert.ok(!usePhaseOverlay || candidateDigest === expected361CandidateDigest, "the phase client overlay is pinned only to the frozen 361 candidate");
  const overlayRoot = usePhaseOverlay ? phaseDiagnosticOverlayRoot : diagnosticClientOverlayRoot;
  const overlayManifestPath = resolve(overlayRoot, "manifest.json");
  const overlayClientPath = resolve(overlayRoot, "apps/kcoder-relay/src/client.mjs");
  const overlayTestPath = resolve(overlayRoot, "apps/kcoder-relay/test/client-diagnostics.test.mjs");
  const overlayDiffPath = usePhaseOverlay
    ? resolve(overlayRoot, "evidence/phase-only.diff")
    : resolve(overlayRoot, "change.diff");
  const overlayFullDiffPath = usePhaseOverlay ? resolve(overlayRoot, "evidence/full-overlay-vs-frozen-361.diff") : null;
  for (const [path, kind] of [
    [overlayRoot, "directory"],
    [overlayManifestPath, "file"],
    [overlayDiffPath, "file"],
    [overlayClientPath, "file"],
    [overlayTestPath, "file"],
    ...(overlayFullDiffPath ? [[overlayFullDiffPath, "file"]] : []),
  ]) await assertPrivatePath(path, privateWebBoundary, kind);
  const overlayManifest = JSON.parse(await readFile(overlayManifestPath, "utf8"));
  let expectedOverlayClientSha256;
  let expectedOverlayTestSha256;
  let overlaySourceDigest;
  let overlayDiffSha256;
  if (usePhaseOverlay) {
    assert.equal(overlayManifest.frozen361?.candidateSourceDigest, expected361CandidateDigest, "phase diagnostics must name the frozen 361 source digest");
    assert.equal(overlayManifest.frozen361?.productClientSha256, expected361RelayClientSha256, "phase overlay must start from the reviewed frozen 361 product client SHA");
    assert.equal(overlayManifest.overlay?.sourceDigest, expectedPhaseOverlaySourceDigest, "phase overlay manifest must match the explicit source digest pin");
    expectedOverlayClientSha256 = expectedPhaseOverlayClientSha256;
    expectedOverlayTestSha256 = expectedPhaseOverlayTestSha256;
    overlaySourceDigest = expectedPhaseOverlaySourceDigest;
    overlayDiffSha256 = expectedPhaseOverlayDiffSha256;
    assert.equal(overlayManifest.overlay?.files?.["apps/kcoder-relay/src/client.mjs"], expectedOverlayClientSha256);
    assert.equal(overlayManifest.overlay?.files?.["apps/kcoder-relay/test/client-diagnostics.test.mjs"], expectedOverlayTestSha256);
    assert.equal(overlayManifest.diffs?.incrementalVsObserver339dSha256, expectedPhaseOverlayDiffSha256);
    assert.equal(overlayManifest.diffs?.clientVsFrozen361Sha256, expectedPhaseOverlayFullDiffSha256);
    assert.equal(sha256(await readFile(overlayFullDiffPath)), expectedPhaseOverlayFullDiffSha256, "full client diff must match its independent frozen-361 pin");
    assert.equal(overlayManifest.safety?.observerPromiseIsAwaited, false, "diagnostic observer callbacks must remain non-blocking");
  } else {
    assert.equal(overlayManifest.sourceDigest, expectedDiagnosticOverlayDigest, "diagnostic overlay manifest must match its pinned source digest");
    assert.equal(overlayManifest.sourceFiles?.["apps/kcoder-relay/src/client.mjs"], expectedDiagnosticRelayClientSha256);
    expectedOverlayClientSha256 = expectedDiagnosticRelayClientSha256;
    expectedOverlayTestSha256 = "1b4716d4d41b3807dd1a7f1aef091281ca4f728a616753ff69d3c221fa977e3c";
    assert.equal(overlayManifest.sourceFiles?.["apps/kcoder-relay/test/client-diagnostics.test.mjs"], expectedOverlayTestSha256);
    assert.equal(overlayManifest.diffSha256, expectedDiagnosticOverlayDiffSha256, "diagnostic overlay manifest must match its independently pinned diff SHA-256");
    overlaySourceDigest = overlayManifest.sourceDigest;
    overlayDiffSha256 = expectedDiagnosticOverlayDiffSha256;
  }
  assert.equal(sha256(await readFile(overlayDiffPath)), overlayDiffSha256, "diagnostic overlay diff must match its independent SHA-256 pin");
  assert.equal(sha256(await readFile(overlayClientPath)), expectedOverlayClientSha256, "diagnostic client source must match the reviewed SHA-256");
  assert.equal(sha256(await readFile(overlayTestPath)), expectedOverlayTestSha256);

  const frozenRelayRoot = resolve(localCandidateRoot, "apps/kcoder-relay");
  const frozenClientPath = resolve(frozenRelayRoot, "src/client.mjs");
  const baseClientSha256 = sha256(await readFile(frozenClientPath));
  const expectedBaseClientSha256 = candidateDigest === expected361CandidateDigest ? expected361RelayClientSha256 : expected212651RelayClientSha256;
  assert.equal(baseClientSha256, expectedBaseClientSha256, "the approved frozen candidate must retain the expected pristine Relay client base");
  const runtimeRoot = context.pathInState("relay-client-runtime");
  await cp(frozenRelayRoot, runtimeRoot, { recursive: true, force: false, errorOnExist: true });
  const runtimeClientPath = resolve(runtimeRoot, "src/client.mjs");
  const runtimeBaseClientSha256 = sha256(await readFile(runtimeClientPath));
  assert.equal(runtimeBaseClientSha256, baseClientSha256, "temporary runtime starts as a byte-identical client copy");
  await copyFile(overlayClientPath, runtimeClientPath);
  const runtimeClientSha256 = sha256(await readFile(runtimeClientPath));
  assert.equal(runtimeClientSha256, expectedOverlayClientSha256, "only the temporary runtime client receives the diagnostic overlay");
  assert.equal(sha256(await readFile(frozenClientPath)), expectedBaseClientSha256, "the frozen run copy remains unchanged");

  const info = {
    enabled: true,
    mode: usePhaseOverlay ? "explicit-private-transport-phase-overlay" : "explicit-test-only-onDiagnostic-overlay",
    candidateDigest,
    baseClientSha256,
    runtimeBaseClientSha256,
    runtimeClientSha256,
    overlaySourceDigest,
    overlayDiffSha256,
    runtimePath: "state/relay-client-runtime/apps/kcoder-relay/src/client.mjs",
    timingScope: "instrumented diagnostic probe; timings are not unbiased product-latency evidence",
  };
  await context.writeArtifactJsonInternal("relay-client-diagnostic-overlay-provenance.json", info);
  return { ...info, runtimeRoot };
}

async function writeRelayClientDiagnosticArtifact({ context, gatewayName, identity, collector, overlayInfo, phase }) {
  if (!collector) return;
  const snapshot = collector.snapshot();
  await writeDiagnosticArtifact(context, `relay-client-${gatewayName}-${phase}-diagnostics.json`, {
    gateway: gatewayName,
    phase,
    routeFingerprint: identity?.id ? sha256(identity.id) : null,
    overlaySourceDigest: overlayInfo?.overlaySourceDigest ?? null,
    baseClientSha256: overlayInfo?.baseClientSha256 ?? null,
    runtimeClientSha256: overlayInfo?.runtimeClientSha256 ?? null,
    eventCount: snapshot.eventCount,
    byteCount: snapshot.byteCount,
    droppedCount: snapshot.droppedCount,
    rejectedCount: snapshot.rejectedCount,
    events: snapshot.events,
    timingScope: "instrumented diagnostic probe; timings are not unbiased product-latency evidence",
    eventRetentionPolicy: `arrival-order, no deduplication; maxEvents=${relayDiagnosticLimits.maxEvents}, maxBytes=${relayDiagnosticLimits.maxBytes}; later events may be dropped (see droppedCount)`,
    closeObservation: phase === "close-request" ? "client.close() returns void; asynchronous socket close events may not be included in this snapshot" : null,
  }, { internal: true });
}

function createBoundedPhaseDiagnosticCollector({ redactText, maxEvents = 256, maxBytes = 64 * 1024 } = {}) {
  assert.equal(typeof redactText, "function");
  assert.ok(Number.isSafeInteger(maxEvents) && maxEvents > 0);
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0);
  const allowedEvents = new Set([
    "control_connecting", "control_open", "control_error", "control_close", "reconnect_scheduled",
    "open_received", "open_rejected", "data_connecting", "data_open", "data_error", "data_close",
    "data_request_socket", "data_dns_lookup", "data_phase_error", "data_tcp_connect", "data_tls_secure_connect",
    "data_upgrade", "data_http_response", "data_request_error", "data_request_timeout", "data_socket_error",
    "data_socket_close", "data_request_observer_unavailable", "local_connecting", "local_connect", "local_error",
    "local_timeout", "local_close", "bridge_closed", "client_stopped",
  ]);
  const allowedKeys = new Set([
    "event", "generation", "atUnixMs", "monotonicMs", "correlation", "errorKind", "errno", "handshakeStatus",
    "closeCode", "hadError", "rejectReason", "phase", "socketReused",
  ]);
  const allowedErrorKinds = new Set(["timeout", "dns", "refused", "reset", "unreachable", "tls", "protocol", "handshake_status", "transport"]);
  const allowedErrnos = new Set([
    "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET",
    "ECONNABORTED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "EPROTO",
  ]);
  const allowedPhases = new Set(["dns_lookup", "tcp_connect", "tls_handshake", "tls_secure_connect", "http_upgrade", "http_response", "connection_setup", "reused_socket", "request"]);
  const allowedRejectReasons = new Set(["invalid_frame", "invalid_open", "gateway_mismatch", "socket_capacity"]);
  const events = [];
  let byteCount = 0;
  let droppedCount = 0;
  let rejectedCount = 0;

  return Object.freeze({
    push(record) {
      if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some(key => !allowedKeys.has(key)) || !allowedEvents.has(record.event)) {
        rejectedCount += 1;
        return false;
      }
      if (!Number.isSafeInteger(record.generation) || record.generation < 1 || !Number.isFinite(record.atUnixMs) || !Number.isFinite(record.monotonicMs)) {
        rejectedCount += 1;
        return false;
      }
      if (record.correlation !== undefined && (typeof record.correlation !== "string" || !/^[a-f0-9]{64}$/.test(record.correlation))) {
        rejectedCount += 1;
        return false;
      }
      if (record.errorKind !== undefined && !allowedErrorKinds.has(record.errorKind)) {
        rejectedCount += 1;
        return false;
      }
      if (record.errno !== undefined && !allowedErrnos.has(record.errno)) {
        rejectedCount += 1;
        return false;
      }
      if (record.phase !== undefined && !allowedPhases.has(record.phase)) {
        rejectedCount += 1;
        return false;
      }
      if (record.socketReused !== undefined && typeof record.socketReused !== "boolean") {
        rejectedCount += 1;
        return false;
      }
      if (record.handshakeStatus !== undefined && (!Number.isInteger(record.handshakeStatus) || record.handshakeStatus < 100 || record.handshakeStatus > 599)) {
        rejectedCount += 1;
        return false;
      }
      if (record.closeCode !== undefined && (!Number.isInteger(record.closeCode) || record.closeCode < 1000 || record.closeCode > 4999)) {
        rejectedCount += 1;
        return false;
      }
      if (record.hadError !== undefined && typeof record.hadError !== "boolean") {
        rejectedCount += 1;
        return false;
      }
      if (record.rejectReason !== undefined && !allowedRejectReasons.has(record.rejectReason)) {
        rejectedCount += 1;
        return false;
      }
      let safe;
      try { safe = JSON.parse(redactText(JSON.stringify(record))); }
      catch {
        rejectedCount += 1;
        return false;
      }
      if (!safe || typeof safe !== "object" || Array.isArray(safe) || Object.keys(safe).some(key => !allowedKeys.has(key))) {
        rejectedCount += 1;
        return false;
      }
      if (JSON.stringify(safe) !== JSON.stringify(record)) {
        rejectedCount += 1;
        return false;
      }
      const size = Buffer.byteLength(JSON.stringify(safe));
      if (events.length >= maxEvents || byteCount + size > maxBytes) {
        droppedCount += 1;
        return false;
      }
      events.push(safe);
      byteCount += size;
      return true;
    },
    snapshot() {
      return {
        events: events.map(event => ({ ...event })),
        eventCount: events.length,
        byteCount,
        droppedCount,
        rejectedCount,
      };
    },
  });
}

async function installPrivateNodeRuntime({ context, cloudHost, remoteRoot, remoteRuntimeRoot, remoteNode }) {
  const command = [
    "set -eu",
    `mkdir -m 700 -p ${remoteRuntimeRoot}`,
    `cd ${remoteRuntimeRoot}`,
    `curl --fail --location --silent --show-error https://nodejs.org/download/release/${nodeVersion}/${nodeArchiveName} -o ${nodeArchiveName}`,
    `curl --fail --location --silent --show-error https://nodejs.org/download/release/${nodeVersion}/SHASUMS256.txt -o SHASUMS256.txt`,
    `actual=$(awk '$2 == \"${nodeArchiveName}\" {print $1}' SHASUMS256.txt)`,
    `test \"$actual\" = \"${nodeArchiveSha256}\"`,
    `printf '%s  %s\\n' \"$actual\" ${nodeArchiveName} | sha256sum -c -`,
    `tar -xJf ${nodeArchiveName} -C ${remoteRuntimeRoot}`,
    `test -x ${remoteNode}`,
    `NODE_EXE=${remoteNode}`,
    `version=$(${remoteNode} --version)`,
    "binary_sha=$(sha256sum \"$NODE_EXE\" | awk '{print $1}')",
    `test \"$version\" = \"${nodeVersion}\"`,
    "printf 'version=%s\\narchiveSha256=%s\\nbinarySha256=%s\\nnodePath=%s\\n' \"$version\" \"$actual\" \"$binary_sha\" \"$NODE_EXE\"",
  ].join("; ");
  const output = await remoteOutput(cloudHost, command, 120_000, { context, operationLabel: "private-node-runtime-install" });
  const metadata = parseKeyValues(output);
  return {
    version: metadata.version,
    archiveSha256: metadata.archiveSha256,
    binarySha256: metadata.binarySha256,
    path: metadata.nodePath,
    checksumSource: "official Node.js SHASUMS256.txt",
  };
}

async function uploadCandidateRelay({ context, cloudHost, relaySourceRoot, remoteRelayRoot }) {
  const localRelayRoot = relaySourceRoot;
  const relayTar = await execFileAsync("tar", ["-czf", "-", "-C", localRelayRoot, "src", "package.json"], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  await sshWrite(context, "upload-frozen-relay-source", cloudHost, `mkdir -m 700 -p ${remoteRelayRoot}; tar -xzf - -C ${remoteRelayRoot}`, relayTar.stdout);
  const wsRoot = resolve(repoRoot, "apps/kcoder-relay/node_modules");
  const wsTar = await execFileAsync("tar", ["-czf", "-", "-C", wsRoot, "ws"], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  await sshWrite(context, "upload-relay-ws-dependency", cloudHost, `mkdir -m 700 -p ${remoteRelayRoot}/node_modules; tar -xzf - -C ${remoteRelayRoot}/node_modules`, wsTar.stdout);
  const wsVersion = JSON.parse(await readFile(resolve(wsRoot, "ws/package.json"), "utf8")).version;
  assert.equal(wsVersion, "8.22.0");
}

function makeRemoteRelayEntry() {
  return `import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import WebSocket, { WebSocketServer } from "./relay/node_modules/ws/wrapper.mjs";
import { startRelay } from "./relay/src/server.mjs";
const [configPath, statusPath, eventLogPath] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, "utf8"));
const relayHttpObservation = config.enableHttpDiagnostics ? await import("./relay-http-phase-observation.mjs") : null;
const relayHttpCollector = relayHttpObservation?.createRelayHttpDiagnosticCollector({ maxEvents: 64, maxBytes: 24 * 1024 }) ?? null;
let dataSocketCount = 0;
const dataSocketEvents = [];
let relay;
function fingerprint(value) {
  return typeof value === "string" && value.length > 0 ? createHash("sha256").update(value).digest("hex") : null;
}
function writeStatus() {
  if (!relay) return;
  const temporary = statusPath + ".live.tmp";
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, controlPort: relay.controlPort, proxyPort: relay.proxyPort, dataSocketCount, dataSocketEvents: dataSocketEvents.slice(-128), relayHttpDiagnostics: relayHttpCollector?.snapshot() ?? null }), { mode: 0o600 });
  renameSync(temporary, statusPath);
}
function writeEventLog() {
  const events = relayHttpCollector ? relayHttpCollector.snapshot().events : dataSocketEvents;
  writeFileSync(eventLogPath, events.map(event => JSON.stringify(event)).join("\\n") + "\\n", { mode: 0o600 });
}
function recordRelayDiagnostic(record) {
  if (!relayHttpCollector) return;
  try {
    relayHttpCollector.push(record);
    writeEventLog();
    writeStatus();
  } catch {}
}
function recordDataSocketEvent(event, request, extra = {}) {
  if (relayHttpCollector) {
    let metadata = {};
    try { metadata = request[Symbol.for("kcoder.e2e.relay-public-http-request")] ?? {}; } catch {}
    let channelFingerprint = typeof metadata.channelFingerprint === "string" ? metadata.channelFingerprint : null;
    if (!channelFingerprint) {
      try {
        const ids = new URL(request.url, "http://relay.invalid").searchParams.getAll("id");
        if (ids.length === 1 && /^[a-f0-9]{48}$/.test(ids[0])) channelFingerprint = fingerprint(ids[0]);
      } catch {}
    }
    const row = { event, atUnixMs: Date.now() };
    if (typeof metadata.requestId === "string") row.requestId = metadata.requestId;
    if (channelFingerprint) row.channelFingerprint = channelFingerprint;
    if (Number.isInteger(extra.closeCode) && extra.closeCode >= 1000 && extra.closeCode <= 4999) row.closeCode = extra.closeCode;
    recordRelayDiagnostic(row);
    return;
  }
  const url = new URL(request.url, "http://relay.invalid");
  const ids = url.searchParams.getAll("id");
  const routeId = request.headers["x-kcoder-device"];
  const row = {
    observedAt: new Date().toISOString(),
    event,
    routeFingerprint: typeof routeId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(routeId) ? fingerprint(routeId) : null,
    channelFingerprint: ids.length === 1 && /^[a-f0-9]{48}$/.test(ids[0]) ? fingerprint(ids[0]) : null,
    ...extra,
  };
  dataSocketEvents.push(row);
  if (dataSocketEvents.length > 128) dataSocketEvents.shift();
  writeFileSync(eventLogPath, dataSocketEvents.map(event => JSON.stringify(event)).join("\\n") + "\\n", { mode: 0o600 });
  writeStatus();
}
if (relayHttpCollector) globalThis[Symbol.for("kcoder.e2e.relay-public-http-diagnostic")] = recordRelayDiagnostic;
const originalHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
WebSocketServer.prototype.handleUpgrade = function(request, socket, head, callback) {
  let pathname = "";
  try { pathname = new URL(request.url, "http://relay.invalid").pathname; } catch {}
  if (pathname === "/_relay/data") { try { recordDataSocketEvent("data-wss-upgrade-attempt", request); } catch {} }
  let callbackSettled = false;
  return originalHandleUpgrade.call(this, request, socket, head, ws => {
    if (callbackSettled) return;
    callbackSettled = true;
    if (pathname === "/_relay/data" && ws.readyState === WebSocket.OPEN) {
      dataSocketCount += 1;
      try { recordDataSocketEvent("data-wss-accepted", request); } catch {}
      ws.once("close", code => {
        try { recordDataSocketEvent("data-wss-closed", request, { closeCode: Number.isInteger(code) ? code : null }); } catch {}
      });
    }
    callback(ws);
  });
};
relay = await startRelay({
  gateways: [],
  sharedHosts: config.sharedHosts,
  registrationKey: config.registrationKey,
  registrationStoreFile: config.registrationStoreFile,
  controlPort: 0,
  proxyPort: 0,
});
const statusPathTemporary = statusPath + ".tmp";
await writeFile(statusPathTemporary, JSON.stringify({ pid: process.pid, controlPort: relay.controlPort, proxyPort: relay.proxyPort, dataSocketCount, dataSocketEvents: dataSocketEvents.slice(-128), relayHttpDiagnostics: relayHttpCollector?.snapshot() ?? null }), { flag: "wx", mode: 0o600 });
await rename(statusPathTemporary, statusPath);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await relay.close();
  process.exit(0);
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
`;
}

async function startRemoteRelay({ cloudHost, remoteRoot, remoteNode, remotePidFile, remoteStatus, remoteRelayEventLog, remoteRelayLog }) {
  const command = [
    "set -eu",
    `umask 077; nohup ${remoteNode} ${remoteRoot}/relay-entry.mjs ${remoteRoot}/relay-config.json ${remoteStatus} ${remoteRelayEventLog} > ${remoteRelayLog} 2>&1 < /dev/null & relay_pid=$!`,
    `printf '%s\\n' \"$relay_pid\" > ${remotePidFile}`,
    `printf 'relayPid=%s\\n' \"$relay_pid\"`,
  ].join("; ");
  const output = await remoteOutput(cloudHost, command);
  const pid = Number(parseKeyValues(output).relayPid);
  assert.ok(Number.isInteger(pid) && pid > 1, "cloud Relay PID must be recorded privately");
}

async function readRemoteRelayStatus({ cloudHost, remoteStatus, remotePidFile }) {
  const status = await waitFor(async () => {
    const output = await remoteOutput(cloudHost, `test -s ${remoteStatus} && cat ${remoteStatus}`).catch(() => "");
    if (!output) return null;
    return JSON.parse(output);
  }, 30_000, "cloud isolated Relay startup", 250);
  const pid = Number(await remoteOutput(cloudHost, `cat ${remotePidFile}`));
  assert.equal(status.pid, pid, "private Relay PID file must point at the owned process");
  const args = await remoteOutput(cloudHost, `ps -p ${pid} -o args=`);
  assert.ok(args.includes("relay-entry.mjs") && args.includes(remoteStatus.replace("relay-status.json", "")), "cloud Relay command must be owned by this run");
  return {
    pid,
    controlPort: Number(status.controlPort),
    proxyPort: Number(status.proxyPort),
    dataSocketCount: Number(status.dataSocketCount || 0),
    dataSocketEvents: Array.isArray(status.dataSocketEvents) ? status.dataSocketEvents.slice(-128) : [],
    relayHttpDiagnostics: status.relayHttpDiagnostics && typeof status.relayHttpDiagnostics === "object"
      ? {
        events: Array.isArray(status.relayHttpDiagnostics.events)
          ? status.relayHttpDiagnostics.events.map(projectRelayHttpDiagnostic).filter(Boolean).slice(-64)
          : [],
        eventCount: Number.isSafeInteger(status.relayHttpDiagnostics.eventCount) ? status.relayHttpDiagnostics.eventCount : null,
        byteCount: Number.isSafeInteger(status.relayHttpDiagnostics.byteCount) ? status.relayHttpDiagnostics.byteCount : null,
        droppedCount: Number.isSafeInteger(status.relayHttpDiagnostics.droppedCount) ? status.relayHttpDiagnostics.droppedCount : null,
        rejectedCount: Number.isSafeInteger(status.relayHttpDiagnostics.rejectedCount) ? status.relayHttpDiagnostics.rejectedCount : null,
      }
      : { status: "UNAVAILABLE" },
  };
}

async function readRelayHttpDiagnosticsOnce({ context, cloudHost, remoteStatus, expectedPid }) {
  const output = await remoteOutput(cloudHost, `test -s ${remoteStatus} && cat ${remoteStatus}`, 5_000, {
    context,
    operationLabel: "single-post-relay-diagnostic-snapshot",
  });
  const status = JSON.parse(output);
  assert.equal(status.pid, expectedPid, "Relay diagnostic snapshot must belong to the exact owned process");
  const diagnostics = status.relayHttpDiagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return { status: "UNAVAILABLE", reason: "relay-http-diagnostics-missing" };
  const events = Array.isArray(diagnostics.events)
    ? diagnostics.events.map(projectRelayHttpDiagnostic).filter(Boolean).slice(-64)
    : [];
  return {
    status: "captured",
    events,
    eventCount: Number.isSafeInteger(diagnostics.eventCount) ? diagnostics.eventCount : null,
    byteCount: Number.isSafeInteger(diagnostics.byteCount) ? diagnostics.byteCount : null,
    droppedCount: Number.isSafeInteger(diagnostics.droppedCount) ? diagnostics.droppedCount : null,
    rejectedCount: Number.isSafeInteger(diagnostics.rejectedCount) ? diagnostics.rejectedCount : null,
  };
}

async function uploadStaticRoot({ context, cloudHost, localMobileRoot, remoteMobileRoot }) {
  const archive = await execFileAsync("tar", ["-czf", "-", "-C", localMobileRoot, "."], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  await sshWrite(context, "upload-baseline-mobile-web", cloudHost, `tar -xzf - -C ${remoteMobileRoot}`, archive.stdout);
  const marker = await remoteOutput(cloudHost, `find ${remoteMobileRoot} -type f | wc -l`);
  assert.equal(Number(marker), 37, "cloud static root must contain the approved 37-file baseline Mobile Web export");
}

async function uploadRouteProbeStaticRoot({ context, cloudHost, remoteMobileRoot }) {
  const html = Buffer.from("<!doctype html><title>private route probe</title><main>private route probe</main>\n");
  await sshWrite(context, "upload-private-route-probe-placeholder", cloudHost, `umask 077; cat > ${remoteMobileRoot}/index.html`, html);
  const marker = await remoteOutput(cloudHost, `find ${remoteMobileRoot} -maxdepth 1 -type f -name index.html | wc -l`);
  assert.equal(Number(marker), 1, "route-probe sidecar root must contain only its private placeholder page");
}

function buildSidecarConfig(base, { marker, root, controlPort, proxyPort, ids = [] }) {
  assert.equal(base.split("\t@test_gateway_prefix path /g/*").length - 1, 1, "isolated sidecar catchall anchor must be unique");
  const routeBlock = [
    `\t# BEGIN ${marker}_routes`,
    `\t@${marker}_register path /_relay/register`,
    `\thandle @${marker}_register {`,
    `\t\treverse_proxy 127.0.0.1:${controlPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t}",
    "\t}",
    `\t@${marker}_control path /_relay/control`,
    `\thandle @${marker}_control {`,
    `\t\treverse_proxy 127.0.0.1:${controlPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    `\t@${marker}_data path /_relay/data`,
    `\thandle @${marker}_data {`,
    `\t\treverse_proxy 127.0.0.1:${controlPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    `\t@${marker}_health path /_relay/health`,
    `\thandle @${marker}_health {`,
    `\t\treverse_proxy 127.0.0.1:${controlPort} {`,
    "\t\t\theader_up Host {http.request.hostport}",
    "\t\t}",
    "\t}",
    ...ids.flatMap((id, index) => [
      `\t@${marker}_gateway_${index} path /g/${id} /g/${id}/*`,
      `\thandle @${marker}_gateway_${index} {`,
      `\t\treverse_proxy 127.0.0.1:${proxyPort} {`,
      "\t\t\theader_up Host {http.request.hostport}",
      "\t\t\tflush_interval -1",
      "\t\t}",
      "\t}",
    ]),
    `\t# END ${marker}_routes`,
    "",
  ].join("\n");
  assert.equal(base.split("\thandle {\n\t\ttry_files").length - 1, 1, "sidecar default static handler anchor must be unique");
  const staticRootBlock = `\thandle {\n\t\t# BEGIN ${marker}_static\n\t\troot * ${root}\n\t\t# END ${marker}_static\n\t\ttry_files`;
  const withPrivateRoot = base.replace("\thandle {\n\t\ttry_files", staticRootBlock);
  return withPrivateRoot.replace("\t@test_gateway_prefix path /g/*", `${routeBlock}\t@test_gateway_prefix path /g/*`);
}

async function installAndValidateSidecarCandidate({ context, cloudHost, remotePath, content, expectedBaseSha256, rootConfigPath, marker, ids }) {
  await sshWrite(context, `upload-${basenameSlug(remotePath)}`, cloudHost, `umask 077; cat > ${remotePath}`, Buffer.from(content));
  const stats = await remoteOutput(cloudHost, `sha256sum ${rootConfigPath} ${remotePath}`, 30_000, {
    context,
    operationLabel: "sidecar-candidate-hash-read",
  });
  const hashes = Object.fromEntries(stats.trim().split("\n").map(line => {
    const [hash, path] = line.trim().split(/\s+/, 2);
    return [path, hash];
  }));
  assert.equal(hashes[rootConfigPath], expectedBaseSha256, "original isolated sidecar config changed while preparing candidate");
  const candidateSha256 = hashes[remotePath];
  const validation = await remoteOutput(cloudHost, `sudo -n /usr/bin/caddy validate --config ${remotePath} --adapter caddyfile`, 45_000, {
    context,
    operationLabel: "sidecar-candidate-validation",
  });
  assert.match(validation, /Valid configuration/);
  const restored = removeMarkedBlock(content, marker);
  assert.equal(sha256(restored), expectedBaseSha256, "removing only the marked full-relay routes must restore the exact sidecar source");
  const rollbackCandidate = `${remotePath}.rollback-check`;
  await sshWrite(context, `upload-${basenameSlug(rollbackCandidate)}`, cloudHost, `umask 077; cat > ${rollbackCandidate}`, Buffer.from(restored));
  const rollbackValidation = await remoteOutput(cloudHost, `sudo -n /usr/bin/caddy validate --config ${rollbackCandidate} --adapter caddyfile`, 45_000, {
    context,
    operationLabel: "sidecar-rollback-validation",
  });
  assert.match(rollbackValidation, /Valid configuration/);
  await remoteOutput(cloudHost, `rm -f ${rollbackCandidate}`);
  return { candidateSha256, validation: "valid", rollbackHashMatchesBase: true, exactGatewayRouteCount: ids.length };
}

function removeMarkedBlock(content, marker) {
  let restored = content;
  for (const suffix of ["routes", "static"]) {
    const begin = `\t${suffix === "static" ? "\t" : ""}# BEGIN ${marker}_${suffix}\n`;
    const end = `\t${suffix === "static" ? "\t" : ""}# END ${marker}_${suffix}\n`;
    assert.equal(restored.split(begin).length - 1, 1, `sidecar ${suffix} marker must have one begin line`);
    assert.equal(restored.split(end).length - 1, 1, `sidecar ${suffix} marker must have one end line`);
    const start = restored.indexOf(begin);
    const finish = restored.indexOf(end);
    assert.ok(finish > start);
    restored = `${restored.slice(0, start)}${restored.slice(finish + end.length)}`;
  }
  assert.equal(sha256(restored), expectedSidecarConfigSha256);
  return restored;
}

async function restartOwnedSidecar({ context, cloudHost, currentPid, expectedCurrentConfig, candidateConfig, pidFile, logFile, productionBefore }) {
  await assertSidecarStillRunning({ cloudHost, pid: currentPid, configPath: expectedCurrentConfig });
  const check = await inspectProductionCaddy(context, cloudHost, productionBefore.pid);
  assert.deepEqual(check, productionBefore, "production Caddy changed before isolated sidecar restart");
  await remoteOutput(cloudHost, `sudo -n kill -TERM ${currentPid}`);
  await waitFor(async () => {
    const output = await remoteOutput(cloudHost, `sudo -n ps -p ${currentPid} -o stat= 2>/dev/null || true`);
    return !output.trim() || output.trim().startsWith("Z") ? true : null;
  }, 10_000, "owned sidecar exit", 100);
  const command = [
    "set -eu",
    `sudo -n bash -c 'umask 022; nohup /usr/bin/caddy run --config ${candidateConfig} --adapter caddyfile </dev/null >>${logFile} 2>&1 & echo $! > ${pidFile}'`,
    `new_pid=$(sudo -n cat ${pidFile})`,
    `args=$(sudo -n ps -p \"$new_pid\" -o args=)`,
    `case \"$args\" in *${candidateConfig}*) ;; *) exit 71 ;; esac`,
    `printf 'sidecarPid=%s\\n' \"$new_pid\"`,
  ].join("; ");
  const output = await remoteOutput(cloudHost, command, 15_000);
  const pid = Number(parseKeyValues(output).sidecarPid);
  assert.ok(Number.isInteger(pid) && pid > 1);
  await waitFor(async () => {
    const status = await remoteOutput(cloudHost, `sudo -n ss -H -ltnp 'sport = :443'`).catch(() => "");
    return status.includes(`pid=${pid},`) ? true : null;
  }, 15_000, "isolated sidecar TLS listener on port 443", 100);
  const productionAfter = await inspectProductionCaddy(context, cloudHost, productionBefore.pid);
  assert.deepEqual(productionAfter, productionBefore, "production Caddy must survive isolated sidecar restart unchanged");
  return pid;
}

async function inspectSidecar(cloudHost, configPath) {
  const expectedArgv = `/usr/bin/caddy run --config ${configPath} --adapter caddyfile`;
  const candidates = await readCaddyProcessCandidates({ host: cloudHost, expectedArgv });
  const matches = candidates.filter(candidate => candidate.exe === "/usr/bin/caddy" && candidate.argv.includes(expectedArgv));
  assert.equal(matches.length, 1, "exactly one actual Caddy executable must own the temporary HTTPS sidecar config");
  const processIdentity = matches[0];
  const configSha256 = parseKeyValues(await remoteOutput(cloudHost, `sha256sum ${configPath} | awk '{print \"sha256=\"$1}'`)).sha256;
  return { pid: processIdentity.pid, configSha256, processIdentity };
}

async function inspectProductionCaddy(context, cloudHost, expectedPid = null) {
  const expectedArgv = `/usr/bin/caddy run --environ --config ${productionConfigPath}`;
  const command = caddyProcessIdentityCommand(expectedArgv);
  const output = expectedPid === null
    ? await remoteOutput(cloudHost, command)
    : await remoteReadOnlyOutput({
      context,
      host: cloudHost,
      command,
      timeoutMs: 30_000,
      operation: "production-caddy-process-list",
      expectedOwnerPid: expectedPid,
    });
  const candidates = parseCaddyProcessCandidates(output);
  const matches = candidates.filter(candidate => candidate.exe === "/usr/bin/caddy" && candidate.argv.includes(expectedArgv));
  assert.equal(matches.length, 1, "exactly one actual Caddy executable must retain the production config");
  const processIdentity = matches[0];
  const pid = processIdentity.pid;
  if (expectedPid !== null) assert.equal(pid, expectedPid, "production Caddy PID must remain the same run-owned baseline process");
  const hashCommand = `sudo -n sha256sum ${productionConfigPath} | awk '{print \"sha256=\"$1}'`;
  const hashOutput = expectedPid === null
    ? await remoteOutput(cloudHost, hashCommand)
    : await remoteReadOnlyOutput({
      context,
      host: cloudHost,
      command: hashCommand,
      timeoutMs: 30_000,
      operation: "production-caddy-config-hash",
      expectedOwnerPid: expectedPid,
    });
  const configSha256 = parseKeyValues(hashOutput).sha256;
  return { pid, configSha256, processIdentity };
}

async function assertSidecarStillRunning({ cloudHost, pid, configPath }) {
  const expectedArgv = `/usr/bin/caddy run --config ${configPath} --adapter caddyfile`;
  const candidates = await readCaddyProcessCandidates({ host: cloudHost, expectedArgv });
  const matches = candidates.filter(candidate => candidate.exe === "/usr/bin/caddy" && candidate.argv.includes(expectedArgv));
  assert.equal(matches.length, 1, "exactly one actual Caddy executable must retain the run-owned sidecar config");
  assert.equal(matches[0].pid, pid, "run-owned sidecar PID must remain the actual Caddy executable");
}

async function restoreOriginalSidecar({ context, cloudHost, testConfigPaths, originalConfig, productionBefore, remoteCaddyPidFile, remoteCaddyLog }) {
  for (const testConfig of testConfigPaths) {
    const expectedArgv = `/usr/bin/caddy run --config ${testConfig} --adapter caddyfile`;
    const candidates = await readCaddyProcessCandidates({ host: cloudHost, expectedArgv });
    const matches = candidates.filter(candidate => candidate.exe === "/usr/bin/caddy" && candidate.argv.includes(expectedArgv));
    assert.ok(matches.length <= 1, "at most one actual Caddy executable may use a run-owned temporary config");
    if (matches.length === 0) continue;
    const recordedPid = Number((await remoteOutput(cloudHost, `sudo -n cat ${remoteCaddyPidFile} 2>/dev/null || true`)).trim());
    assert.ok(Number.isInteger(recordedPid) && recordedPid > 1, "temporary sidecar owner PID file must identify the run-owned Caddy process");
    const processIdentity = matches[0];
    assert.equal(processIdentity.pid, recordedPid, "refusing to signal a temporary sidecar PID not recorded by this RunContext");
    const pid = processIdentity.pid;
    await remoteOutput(cloudHost, `sudo -n kill -TERM ${pid}`);
    await waitFor(async () => {
      const state = await remoteOutput(cloudHost, `sudo -n ps -p ${pid} -o stat= 2>/dev/null || true`);
      return !state.trim() || state.trim().startsWith("Z") ? true : null;
    }, 10_000, "test sidecar shutdown before restoring original sidecar", 100);
  }
  const originalArgv = `/usr/bin/caddy run --config ${originalConfig} --adapter caddyfile`;
  const originalCandidates = await readCaddyProcessCandidates({ host: cloudHost, expectedArgv: originalArgv });
  const originalMatches = originalCandidates.filter(candidate => candidate.exe === "/usr/bin/caddy" && candidate.argv.includes(originalArgv));
  assert.ok(originalMatches.length <= 1, "at most one actual Caddy executable may use the original isolated TLS sidecar config");
  if (originalMatches.length === 0) {
    const command = [
      "set -eu",
      `sudo -n bash -c 'umask 022; nohup /usr/bin/caddy run --config ${originalConfig} --adapter caddyfile </dev/null >>${remoteCaddyLog} 2>&1 & echo $! > ${remoteCaddyPidFile}'`,
      `new_pid=$(sudo -n cat ${remoteCaddyPidFile})`,
      `args=$(sudo -n ps -p \"$new_pid\" -o args=)`,
      `case \"$args\" in *${originalConfig}*) ;; *) exit 72 ;; esac`,
      `printf 'sidecarPid=%s\\n' \"$new_pid\"`,
    ].join("; ");
    await remoteOutput(cloudHost, command, 15_000);
    await waitForPublicRoot();
  }
  const productionAfter = await inspectProductionCaddy(context, cloudHost, productionBefore.pid);
  assert.deepEqual(productionAfter, productionBefore, "production Caddy must remain unchanged while restoring only the sidecar");
}

async function readCaddyProcessCandidates({ host, expectedArgv }) {
  const output = await remoteOutput(host, caddyProcessIdentityCommand(expectedArgv));
  return parseCaddyProcessCandidates(output);
}

function caddyProcessIdentityCommand(expectedArgv) {
  const script = [
    "expected=$1",
    "ps -eo pid=,args= | while IFS= read -r row; do",
    "  read -r pid args <<< \"$row\"",
    "  case \"$args\" in *\"$expected\"*)",
    "    [[ \"$pid\" =~ ^[0-9]+$ ]] || continue",
    "    exe=$(readlink \"/proc/$pid/exe\" 2>/dev/null || true)",
    "    [[ \"$exe\" == /usr/bin/caddy ]] || continue",
    "    ppid=$(awk '/^PPid:/ {print $2}' \"/proc/$pid/status\" 2>/dev/null || true)",
    "    cwd=$(readlink \"/proc/$pid/cwd\" 2>/dev/null || true)",
    "    argv=$(tr '\\000' ' ' < \"/proc/$pid/cmdline\" 2>/dev/null || true)",
    "    case \"$argv\" in *\"$expected\"*) ;; *) continue ;; esac",
    "    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$pid\" \"$ppid\" \"$exe\" \"$cwd\" \"$argv\"",
    "    ;;",
    "  esac",
    "done",
  ].join("\n");
  return `sudo -n bash -c '${script.replaceAll("'", "'\\''")}' _ '${expectedArgv.replaceAll("'", "'\\''")}'`;
}

function parseCaddyProcessCandidates(output) {
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const [pidText, ppidText, exe, cwd, argv] = line.split("\t");
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    assert.ok(Number.isInteger(pid) && pid > 1, "process identity output must include a valid PID");
    assert.ok(Number.isInteger(ppid) && ppid > 0, "process identity output must include a valid parent PID");
    assert.ok(exe && cwd && argv, "process identity output must include exe, cwd, and argv");
    return { pid, ppid, exe, cwd, argv };
  });
}

async function stopAndRemoveRemoteRelay({ context, cloudHost, remoteRoot, remotePidFile, remoteRelayRoot, remoteRelayLog, remoteRelayEventLog, remoteCaddyLog, remoteStatus }) {
  const output = await remoteOutput(cloudHost, `test -f ${remotePidFile} && cat ${remotePidFile} || true`).catch(() => "");
  const pid = Number(output);
  if (Number.isInteger(pid) && pid > 1) {
    const args = await remoteOutput(cloudHost, `ps -p ${pid} -o args= 2>/dev/null || true`);
    if (args.includes(`${remoteRoot}/relay-entry.mjs`)) {
      await remoteOutput(cloudHost, `kill -TERM ${pid}`).catch(() => {});
      await waitFor(async () => {
        const state = await remoteOutput(cloudHost, `ps -p ${pid} -o stat= 2>/dev/null || true`);
        return !state.trim() || state.trim().startsWith("Z") ? true : null;
      }, 10_000, "owned cloud Relay shutdown", 100);
    }
  }
  await captureRemoteServiceDiagnostics({
    context,
    cloudHost,
    remoteRoot,
    files: [
      { label: "relay-log", path: remoteRelayLog },
      { label: "relay-events", path: remoteRelayEventLog },
      { label: "relay-status", path: remoteStatus },
      { label: "sidecar-log", path: remoteCaddyLog },
    ],
  });
  const storeCheck = await remoteOutput(cloudHost, `test -d ${remoteRelayRoot} && find ${remoteRelayRoot} -maxdepth 1 -type f -name 'registration-store.json' | wc -l || echo 0`);
  assert.ok(Number(storeCheck) <= 1, "test registration store must stay under the unique run-owned Relay directory");
  await remoteOutput(cloudHost, `rm -rf -- ${remoteRoot}`);
  const remains = await remoteOutput(cloudHost, `test -e ${remoteRoot} && echo present || echo removed`);
  assert.equal(remains, "removed", "run-owned cloud temp tree must be removed");
}

async function captureRemoteServiceDiagnostics({ context, cloudHost, remoteRoot, files }) {
  const capturedAt = new Date().toISOString();
  const evidence = { status: "UNAVAILABLE", capturedAt, maxBytesPerFile: 32 * 1024, files: {}, localGatewayLogs: {} };
  try {
    const commands = [
      `if [ -d ${remoteRoot} ]; then printf '__root__\\texists\\n'; else printf '__root__\\tabsent\\n'; fi`,
      ...files.map(({ label, path }) => [
        `if [ -f ${path} ]; then size=$(wc -c < ${path}); printf '${label}\\t%s\\t' "$size"; tail -c 32768 ${path} | base64 -w0; printf '\\n';`,
        `else printf '${label}\\tmissing\\t-\\n'; fi`,
      ].join(" ")),
    ];
    const output = await remoteOutput(cloudHost, `set -eu; ${commands.join("; ")}`, 5_000);
    const rows = new Map(output.split(/\r?\n/).map(line => {
      const [label, size, encoded = ""] = line.split("\t");
      return [label, { size, encoded }];
    }));
    const rootState = rows.get("__root__")?.size;
    if (rootState !== "exists") evidence.reason = "remote-root-absent";
    else {
      let anyCaptured = false;
      for (const { label } of files) {
        const row = rows.get(label);
        if (!row || row.size === "missing") {
          evidence.files[label] = { status: "missing" };
          continue;
        }
        const remoteBytes = Number(row.size);
        if (!Number.isSafeInteger(remoteBytes) || remoteBytes < 0) {
          evidence.files[label] = { status: "UNAVAILABLE", reason: "invalid-size-metadata" };
          continue;
        }
        const raw = Buffer.from(row.encoded, "base64").toString("utf8");
        try {
          const redacted = context.redactText(raw);
          evidence.files[label] = {
            status: "captured",
            remoteBytes,
            truncated: remoteBytes > 32 * 1024 || redacted.length > 32 * 1024,
            text: redacted.slice(0, 32 * 1024),
          };
          anyCaptured = true;
        } catch {
          evidence.files[label] = { status: "UNAVAILABLE", reason: "redaction-failed" };
        }
      }
      evidence.status = anyCaptured ? "captured" : "UNAVAILABLE";
    }
  } catch (error) {
    const metadata = error?.remoteEvidence ?? {};
    evidence.reason = "remote-read-failed";
    evidence.remoteFailure = {
      exitCode: Number.isInteger(metadata.exitCode) ? metadata.exitCode : null,
      signal: typeof metadata.signal === "string" ? metadata.signal : null,
      localTimeout: Boolean(metadata.localTimeout),
      elapsedMs: Number.isFinite(metadata.elapsedMs) ? metadata.elapsedMs : null,
      stderrCategory: typeof metadata.stderrCategory === "string" ? metadata.stderrCategory : "unknown",
    };
  }
  for (const name of ["alpha", "beta"]) {
    const processRecord = context.processes.get(`candidate-gateway-${name}`);
    if (!processRecord?.logPath) {
      evidence.localGatewayLogs[name] = { status: "UNAVAILABLE", reason: "owned-log-path-missing" };
      continue;
    }
    let handle;
    try {
      handle = await open(processRecord.logPath, "r");
      const info = await handle.stat();
      const requestedBytes = Math.min(32 * 1024, info.size);
      const tail = Buffer.alloc(requestedBytes);
      const { bytesRead } = await handle.read(tail, 0, requestedBytes, Math.max(0, info.size - requestedBytes));
      const raw = tail.subarray(0, bytesRead).toString("utf8");
      const redacted = context.redactText(raw);
      evidence.localGatewayLogs[name] = {
        status: "captured",
        bytes: info.size,
        capturedBytes: bytesRead,
        truncated: info.size > bytesRead || redacted.length > 32 * 1024,
        text: redacted.slice(-32 * 1024),
      };
    } catch {
      evidence.localGatewayLogs[name] = { status: "UNAVAILABLE", reason: "owned-log-read-failed" };
    } finally {
      if (handle) {
        try { await handle.close(); } catch {}
      }
    }
  }
  await writeDiagnosticArtifact(context, "remote-service-diagnostics.json", evidence, { internal: true });
  return evidence.status;
}

async function runPublicRouteIsolationProbe(context, fixturePath, origin) {
  const suitePath = resolve(repoRoot, "apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-route-isolation.e2e.mjs");
  const child = context.spawnOwned("public-fullrelay-http-wss-isolation-probe", process.execPath, [suitePath], {
    cwd: repoRoot,
    env: context.isolatedEnvironment({
      KCODER_E2E_PUBLIC_ROUTE_ISOLATION: "1",
      KCODER_E2E_PUBLIC_ROUTE_ORIGIN: origin,
      KCODER_E2E_PUBLIC_PAIRING_FIXTURES: fixturePath,
    }),
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", code => resolveExit(code));
  });
  const record = context.processes.get("public-fullrelay-http-wss-isolation-probe");
  const log = await readFile(record.logPath, "utf8");
  const runRoot = log.trim().split("\n").at(-1);
  assert.ok(runRoot.includes("target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-route-isolation.e2e.mjs/"));
  return { exitCode, runRoot };
}

async function runPublicMobileUi(context, {
  fixturePath,
  parentRunRoot,
  origin,
  sourceDigest,
  bundleSha256,
  webManifestPath,
}) {
  const suitePath = resolve(repoRoot, "apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-ui.e2e.mjs");
  const child = context.spawnOwned("public-fullrelay-mobile-ui", process.execPath, [suitePath], {
    cwd: repoRoot,
    env: context.isolatedEnvironment({
      KCODER_E2E_PUBLIC_MOBILE_UI: "1",
      KCODER_E2E_PUBLIC_UI_ORIGIN: origin,
      KCODER_E2E_PUBLIC_UI_PARENT_RUN_ROOT: parentRunRoot,
      KCODER_E2E_PUBLIC_UI_PAIRING_FIXTURES: fixturePath,
      KCODER_E2E_PUBLIC_UI_EXPECTED_SOURCE_DIGEST: sourceDigest,
      KCODER_E2E_PUBLIC_UI_EXPECTED_BUNDLE_SHA256: bundleSha256,
      KCODER_E2E_PUBLIC_UI_WEB_MANIFEST: webManifestPath,
    }, [
      "KCODER_E2E_CHROMIUM_NO_SANDBOX",
      "KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX",
      "KCODER_E2E_CHROMIUM_BIN",
    ]),
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", code => resolveExit(code));
  });
  const record = context.processes.get("public-fullrelay-mobile-ui");
  const log = await readFile(record.logPath, "utf8");
  const prefix = `${resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-ui.e2e.mjs")}/`;
  const runRoot = log.trim().split(/\r?\n/).find(line => line.startsWith(prefix)) ?? null;
  if (runRoot && exitCode === 0) {
    const artifactBoundary = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-high-latency-public-ui.e2e.mjs");
    const relativeRunRoot = relative(artifactBoundary, resolve(runRoot));
    assert.ok(relativeRunRoot && !relativeRunRoot.startsWith(`..${sep}`) && !isAbsolute(relativeRunRoot),
      "public UI child evidence must remain under the E2E artifact boundary");
    const proof = JSON.parse(await readFile(resolve(runRoot, "artifacts/public-mobile-ui-proof.json"), "utf8"));
    return { exitCode, runRoot, proof };
  }
  return { exitCode, runRoot, proof: null };
}

async function measurePublicRelayLatency({ context, origin, gateway, relayHost, relayStatusPath }) {
  const route = `${origin}/g/${gateway.id}`;
  context.registerSecret(gateway.pairingToken);
  const sessionResponse = await fetchWithTimeout(`${route}/api/mobile/session`, {
    method: "POST",
    headers: { Origin: origin, "content-type": "application/json" },
    body: JSON.stringify({ token: gateway.pairingToken }),
  });
  assert.equal(sessionResponse.status, 200, "P2B probe must obtain an isolated test session over public HTTPS");
  const session = await sessionResponse.json();
  assert.equal(typeof session.accessToken, "string");
  assert.equal(typeof session.rpcToken, "string");
  context.registerSecret(session.accessToken);
  context.registerSecret(session.rpcToken);
  let revoked = false;
  const revoke = async () => {
    if (revoked) return;
    const response = await fetchWithTimeout(`${route}/api/mobile/session`, {
      method: "DELETE",
      headers: { Origin: origin, Authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(response.status, 204, "P2B probe session must be revoked after the measurements");
    revoked = true;
  };
  context.addCleanup("revoke temporary P2B measurement session", revoke);

  const beforeCount = await readRemoteDataSocketCount(relayHost, relayStatusPath);
  const serverSamples = [];
  let serverId = null;
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const response = await fetchWithTimeout(`${route}/api/servers`, {
      headers: { Origin: origin, Authorization: `Bearer ${session.accessToken}`, "cache-control": "no-store" },
    });
    const body = response.status === 200 ? await response.json() : null;
    const elapsedMs = roundMs(performance.now() - started);
    assert.equal(response.status, 200, `public /api/servers sample ${index + 1} should succeed`);
    assert.ok(Array.isArray(body?.servers) && body.servers.length > 0, "restricted Gateway fixture should return a test server");
    if (serverId === null) serverId = body.servers[0].id;
    assert.equal(body.servers[0].id, serverId, "hot samples should remain on the same test Gateway target");
    serverSamples.push({ sample: index + 1, cacheClass: index === 0 ? "cold" : "hot", elapsedMs, status: response.status });
  }

  const initializeSamples = [];
  for (let index = 0; index < 5; index += 1) {
    const wsUrl = new URL(`${route}/rpc`);
    wsUrl.protocol = "wss:";
    wsUrl.searchParams.set("token", session.rpcToken);
    wsUrl.searchParams.set("server", serverId);
    wsUrl.searchParams.set("channel", "runtime");
    const handshakeStarted = performance.now();
    const rpc = await openRpc(wsUrl.toString(), {
      timeoutMs: 15_000,
      headers: { Origin: origin, Authorization: `Bearer ${session.accessToken}` },
    });
    const handshakeMs = roundMs(performance.now() - handshakeStarted);
    try {
      const initializeStarted = performance.now();
      const initialized = await initializeRpc(rpc, `public-p2b-initialize-${index + 1}`);
      const initializeMs = roundMs(performance.now() - initializeStarted);
      assert.equal(initialized.protocolVersion, "2026-07-27", "public Relay WSS initialize should negotiate the current protocol");
      rpc.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
      initializeSamples.push({ sample: index + 1, websocketHandshakeMs: handshakeMs, initializeResponseMs: initializeMs, openToInitializeMs: roundMs(handshakeMs + initializeMs) });
    } finally {
      await closeRpcAndWait(rpc, `P2B WSS initialize sample ${index + 1}`);
    }
  }
  const afterCount = await readRemoteDataSocketCount(relayHost, relayStatusPath);
  const gatewayDataSocketDelta = afterCount - beforeCount;
  await context.writeArtifactJson("public-fullrelay-p2b-timing-partial.json", {
    status: "samples-collected",
    sampleCount: 5,
    serverList: summarizeSamples(serverSamples),
    rpcInitialize: summarizeRpcSamples(initializeSamples),
    gatewayDataSocketCount: { before: beforeCount, after: afterCount, delta: gatewayDataSocketDelta, expected: 10 },
    sessionExchangeStatus: sessionResponse.status,
  });
  assert.equal(gatewayDataSocketDelta, 10, "five HTTP and five WSS operations should each accept exactly one Gateway data WebSocket");
  await revoke();

  return {
    transport: "public HTTPS/WSS on the isolated standard-port TLS sidecar; Gateway clients connect outward to the same public host",
    sampleSize: 5,
    serverList: summarizeSamples(serverSamples),
    rpcInitialize: summarizeRpcSamples(initializeSamples),
    gatewayDataSocketCount: { before: beforeCount, after: afterCount, delta: gatewayDataSocketDelta, expected: 10 },
    sessionExchangeStatus: sessionResponse.status,
    sessionRevocationStatus: 204,
  };
}

async function readRemoteDataSocketCount(host, statusPath) {
  const status = await readRemoteDataSocketState(host, statusPath);
  return status.dataSocketCount;
}

async function readRemoteDataSocketState(host, statusPath) {
  const output = await remoteOutput(host, `cat ${statusPath}`, 5_000);
  const status = JSON.parse(output);
  assert.ok(Number.isSafeInteger(status.dataSocketCount) && status.dataSocketCount >= 0, "private Relay telemetry should expose a nonnegative accepted data-socket count");
  return {
    dataSocketCount: status.dataSocketCount,
    dataSocketEvents: Array.isArray(status.dataSocketEvents) ? status.dataSocketEvents.slice(-128) : [],
  };
}

async function checkPublicRoutes(context, identities, pairing, { cloudHost, remoteStatus, diagnosticCollectors, diagnosticOverlayInfo }) {
  const root = await fetchWithTimeout(`${publicOrigin}/`);
  async function exchangeAndRevoke(name) {
    const routeFingerprint = sha256(identities[name].id);
    const clientDiagnosticSnapshot = () => diagnosticCollectors?.[name]?.snapshot() ?? { status: "disabled" };
    const dataSocketsBefore = await readDataSocketObservation(cloudHost, remoteStatus);
    const requestStartedAt = new Date().toISOString();
    const requestStarted = performance.now();
    let response;
    try {
      response = await fetchWithTimeout(`${publicOrigin}/g/${identities[name].id}/api/mobile/session`, {
        method: "POST",
        headers: { Origin: publicOrigin, "content-type": "application/json" },
        body: JSON.stringify({ token: pairing[name] }),
      });
    } catch (error) {
      await writeDiagnosticArtifact(context, `public-pairing-${name}-http-observation.json`, {
        gateway: name,
        routeFingerprint,
        method: "POST",
        path: "/api/mobile/session",
        requestStartedAt,
        elapsedMs: roundMs(performance.now() - requestStarted),
        status: null,
        responseHeaders: {},
        responseBody: { status: "UNAVAILABLE", reason: "no-http-response" },
        errorCategory: requestFailureCategory(error),
        dataSocketsBefore,
        dataSocketsAfter: await readDataSocketObservation(cloudHost, remoteStatus),
        clientDiagnostics: clientDiagnosticSnapshot(),
        diagnosticOverlay: diagnosticOverlayInfo ? {
          baseClientSha256: diagnosticOverlayInfo.baseClientSha256,
          runtimeClientSha256: diagnosticOverlayInfo.runtimeClientSha256,
        } : { enabled: false },
      }, { internal: true });
      await writeRelayClientDiagnosticArtifact({
        context,
        gatewayName: name,
        identity: identities[name],
        collector: diagnosticCollectors?.[name],
        overlayInfo: diagnosticOverlayInfo,
        phase: "pairing-error",
      });
      throw error;
    }
    const responseElapsedMs = roundMs(performance.now() - requestStarted);
    const responseHeaders = summarizeResponseHeaders(response.headers);
    const responseBody = await readBoundedErrorResponseBody(response, text => context.redactText(text));
    const dataSocketsAfter = await readDataSocketObservation(cloudHost, remoteStatus);
    await writeDiagnosticArtifact(context, `public-pairing-${name}-http-observation.json`, {
      gateway: name,
      routeFingerprint,
      method: "POST",
      path: "/api/mobile/session",
      requestStartedAt,
      elapsedMs: responseElapsedMs,
      status: response.status,
      responseHeaders,
      responseBody,
      dataSocketsBefore,
      dataSocketsAfter,
      acceptedDataSocketDelta: dataSocketDelta(dataSocketsBefore, dataSocketsAfter),
      clientDiagnostics: clientDiagnosticSnapshot(),
      diagnosticOverlay: diagnosticOverlayInfo ? {
        baseClientSha256: diagnosticOverlayInfo.baseClientSha256,
        runtimeClientSha256: diagnosticOverlayInfo.runtimeClientSha256,
      } : { enabled: false },
    }, { internal: true });
    await writeRelayClientDiagnosticArtifact({
      context,
      gatewayName: name,
      identity: identities[name],
      collector: diagnosticCollectors?.[name],
      overlayInfo: diagnosticOverlayInfo,
      phase: "pairing-response",
    });
    assert.equal(response.status, 200, `${name} exact /g route should accept its own test pairing token`);
    const session = await response.json();
    assert.equal(typeof session.accessToken, "string");
    context.registerSecret(session.accessToken);
    context.registerSecret(session.rpcToken);
    const revokeStartedAt = new Date().toISOString();
    const revokeStarted = performance.now();
    const revoked = await fetchWithTimeout(`${publicOrigin}/g/${identities[name].id}/api/mobile/session`, {
      method: "DELETE",
      headers: { Origin: publicOrigin, Authorization: `Bearer ${session.accessToken}` },
    });
    await writeDiagnosticArtifact(context, `public-pairing-${name}-revoke-observation.json`, {
      gateway: name,
      routeFingerprint,
      method: "DELETE",
      path: "/api/mobile/session",
      requestStartedAt: revokeStartedAt,
      elapsedMs: roundMs(performance.now() - revokeStarted),
      status: revoked.status,
      responseHeaders: summarizeResponseHeaders(revoked.headers),
      responseBody: await readBoundedErrorResponseBody(revoked, text => context.redactText(text)),
    });
    assert.equal(revoked.status, 204, `${name} route check session should be revoked immediately`);
    return response.status;
  }
  const alpha = await exchangeAndRevoke("alpha");
  const beta = await exchangeAndRevoke("beta");
  const suffix = await fetchWithTimeout(`${publicOrigin}/g/${identities.alpha.id}-suffix/api/servers`);
  return { root: root.status, alpha, beta, suffix: suffix.status };
}

async function runSinglePublicSessionPostDiagnostic({ context, identities, pairing, diagnosticCollectors, diagnosticOverlayInfo, relayHttpDiagnosticOverlayInfo, cloudHost, remoteStatus, relayPid }) {
  const name = "alpha";
  const routeFingerprint = sha256(identities[name].id);
  const route = `${publicOrigin}/g/${identities[name].id}/api/mobile/session`;
  const ledger = createPublicRouteProbeRequestLedger(context, { prefix: "single-post-public-session-request" });
  context.registerSecret(pairing[name]);
  const requestStartedAt = new Date().toISOString();
  const started = performance.now();
  let response = null;
  let fetchFailure = null;
  try {
    response = await fetchWithTimeout(route, {
      method: "POST",
      headers: { Origin: publicOrigin, "content-type": "application/json" },
      body: JSON.stringify({ token: pairing[name] }),
    });
  } catch (error) {
    fetchFailure = summarizeFetchFailure(error);
  }
  const elapsedMs = roundMs(performance.now() - started);
  const status = response ? response.status : null;
  const errorCategory = fetchFailure ? safeProbeErrorCategory({ name: fetchFailure.name, code: fetchFailure.code, cause: { code: fetchFailure.causeCode } }) : null;
  await ledger.record({
    gateway: name,
    routeFingerprint,
    method: "POST /api/mobile/session",
    path: "/g/<private-id>/api/mobile/session",
    requestStartedAt,
    elapsedMs,
    status,
    errorCategory,
  });
  await ledger.finalize();

  let relayDiagnostics;
  try {
    relayDiagnostics = await readRelayHttpDiagnosticsOnce({
      context,
      cloudHost,
      remoteStatus,
      expectedPid: relayPid,
    });
  } catch (error) {
    relayDiagnostics = { status: "UNAVAILABLE", error: summarizeFetchFailure(error) };
  }
  const clientDiagnostics = diagnosticCollectors?.[name]?.snapshot() ?? { status: "disabled" };
  const outcome = {
    mode: "single-public-session-post-diagnostic",
    gateway: name,
    routeFingerprint,
    sessionPostCount: 1,
    automaticSessionRetry: false,
    automaticRequestRetry: false,
    requestMethod: "POST",
    requestPath: "/g/<private-id>/api/mobile/session",
    requestStartedAt,
    elapsedMs,
    responseStatus: status,
    responseBody: { status: "not-consumed", reason: "session response body may contain credentials" },
    responseHeaders: { status: "not-captured" },
    fetchFailure,
    sessionState: "UNKNOWN",
    cleanupConfirmed: false,
    cleanupStatus: "UNCONFIRMED",
    expirationCleanup: "UNVERIFIED",
    credentialValuesRetained: false,
    pairingTokenParsed: false,
    clientDiagnosticOverlay: diagnosticOverlayInfo ? {
      mode: diagnosticOverlayInfo.mode,
      sourceDigest: diagnosticOverlayInfo.overlaySourceDigest,
      diffSha256: diagnosticOverlayInfo.overlayDiffSha256,
      baseClientSha256: diagnosticOverlayInfo.baseClientSha256,
      runtimeClientSha256: diagnosticOverlayInfo.runtimeClientSha256,
    } : { status: "UNAVAILABLE" },
    clientDiagnostics,
    relayDiagnostics,
    relayHttpDiagnosticOverlay: relayHttpDiagnosticOverlayInfo,
    caddyAccessLog: "disabled",
    publicRelayEventCorrelation: "single session POST bounded by request timestamps; Relay requestId and channelFingerprint are retained only in private diagnostics",
  };
  await context.writeArtifactJsonInternal("single-post-public-session-diagnostic.json", outcome);
  try { if (response?.body) void response.body.cancel().catch(() => {}); } catch {}
  if (!response) throw new Error("single public session POST failed before an HTTP response");
  if (response.status !== 200) throw new Error("single public session POST returned a non-200 HTTP status");

  return {
    status: "response-observed",
    sessionPostCount: 1,
    requestOrder: ["alpha-session-post"],
    responseStatus: response.status,
    elapsedMs,
    sessionState: "UNKNOWN",
    cleanupConfirmed: false,
    cleanupStatus: "UNCONFIRMED",
    relayDiagnostics,
    clientDiagnostics,
    checks: [],
  };
}

async function runTwoGatewayServerListProbe({ context, identities, pairing, diagnosticCollectors, diagnosticOverlayInfo, cloudHost, remoteStatus }) {
  const sessions = {};
  const checks = [];
  const publicApiRequestLedger = createPublicRouteProbeRequestLedger(context);
  const routeFor = name => `${publicOrigin}/g/${identities[name].id}`;
  const routePathTemplate = path => `/g/<private-id>${path}`;

  async function recordPublicApiRequest({ name, method, path, startedAt, elapsedMs, status, errorCategory = null }) {
    return publicApiRequestLedger.record({
      gateway: name,
      routeFingerprint: sha256(identities[name].id),
      method,
      path,
      requestStartedAt: startedAt,
      elapsedMs,
      status,
      errorCategory,
    });
  }

  async function exchangeSession(name) {
    const routeFingerprint = sha256(identities[name].id);
    context.registerSecret(pairing[name]);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const sessionUrl = `${routeFor(name)}/api/mobile/session`;
    let response;
    try {
      response = await fetchWithTimeout(sessionUrl, {
        method: "POST",
        headers: { Origin: publicOrigin, "content-type": "application/json" },
        body: JSON.stringify({ token: pairing[name] }),
      });
    } catch (error) {
      const elapsedMs = roundMs(performance.now() - started);
      const errorCategory = safeProbeErrorCategory(error);
      await recordPublicApiRequest({
        name,
        method: "POST /api/mobile/session",
        path: routePathTemplate("/api/mobile/session"),
        startedAt,
        elapsedMs,
        status: null,
        errorCategory,
      });
      await context.writeArtifactJsonInternal(`route-probe-${name}-session-exchange.json`, {
        gateway: name,
        routeFingerprint,
        sessionIssuanceTransport: "public-exact-g-route",
        path: routePathTemplate("/api/mobile/session"),
        requestHeaders: ["Origin", "Content-Type"],
        requestBodyFields: ["token"],
        requestStartedAt: startedAt,
        elapsedMs,
        status: null,
        errorCategory,
        responseBody: { status: "UNAVAILABLE", reason: "no-http-response" },
        sessionState: "UNKNOWN",
        cleanupConfirmed: false,
        cleanupStatus: "UNCONFIRMED",
        expirationCleanup: "UNVERIFIED",
        automaticSessionRetry: false,
        credentialValuesRetained: false,
      });
      throw new Error(`route-probe ${name} session exchange failed before an HTTP response`);
    }
    const elapsedMs = roundMs(performance.now() - started);
    if (response.status !== 200) {
      await recordPublicApiRequest({
        name,
        method: "POST /api/mobile/session",
        path: routePathTemplate("/api/mobile/session"),
        startedAt,
        elapsedMs,
        status: response.status,
      });
      const responseBody = await readBoundedErrorResponseBody(response, text => context.redactText(text));
      await context.writeArtifactJsonInternal(`route-probe-${name}-session-exchange.json`, {
        gateway: name,
        routeFingerprint,
        sessionIssuanceTransport: "public-exact-g-route",
        path: routePathTemplate("/api/mobile/session"),
        requestHeaders: ["Origin", "Content-Type"],
        requestBodyFields: ["token"],
        requestStartedAt: startedAt,
        elapsedMs,
        status: response.status,
        errorCategory: "http-status",
        responseHeaders: summarizeResponseHeaders(response.headers),
        responseBody,
        sessionState: "UNKNOWN",
        cleanupConfirmed: false,
        cleanupStatus: "UNCONFIRMED",
        expirationCleanup: "UNVERIFIED",
        automaticSessionRetry: false,
        credentialValuesRetained: false,
      });
      assert.equal(response.status, 200, `${name} own route must exchange its test pairing token`);
    }
    let session;
    try {
      session = await readBoundedJsonResponse(response);
    } catch {
      await recordPublicApiRequest({
        name,
        method: "POST /api/mobile/session",
        path: routePathTemplate("/api/mobile/session"),
        startedAt,
        elapsedMs,
        status: response.status,
        errorCategory: "invalid-or-oversized-json",
      });
      await context.writeArtifactJsonInternal(`route-probe-${name}-session-exchange.json`, {
        gateway: name,
        routeFingerprint,
        sessionIssuanceTransport: "public-exact-g-route",
        path: routePathTemplate("/api/mobile/session"),
        requestHeaders: ["Origin", "Content-Type"],
        requestBodyFields: ["token"],
        requestStartedAt: startedAt,
        elapsedMs,
        status: response.status,
        errorCategory: "invalid-or-oversized-json",
        responseHeaders: summarizeResponseHeaders(response.headers),
        responseBody: { status: "UNAVAILABLE", reason: "success-body-not-retained" },
        sessionState: "UNKNOWN",
        cleanupConfirmed: false,
        cleanupStatus: "UNCONFIRMED",
        expirationCleanup: "UNVERIFIED",
        automaticSessionRetry: false,
        credentialValuesRetained: false,
      });
      throw new Error(`route-probe ${name} session response was not bounded valid JSON`);
    }
    const sessionCredentialShape = {
      accessTokenPresent: typeof session?.accessToken === "string",
      rpcTokenPresent: typeof session?.rpcToken === "string",
    };
    if (!sessionCredentialShape.accessTokenPresent || !sessionCredentialShape.rpcTokenPresent) {
      await recordPublicApiRequest({
        name,
        method: "POST /api/mobile/session",
        path: routePathTemplate("/api/mobile/session"),
        startedAt,
        elapsedMs,
        status: response.status,
        errorCategory: "invalid-session-credential-shape",
      });
      await context.writeArtifactJsonInternal(`route-probe-${name}-session-exchange.json`, {
        gateway: name,
        routeFingerprint,
        sessionIssuanceTransport: "public-exact-g-route",
        path: routePathTemplate("/api/mobile/session"),
        requestHeaders: ["Origin", "Content-Type"],
        requestBodyFields: ["token"],
        requestStartedAt: startedAt,
        elapsedMs,
        status: response.status,
        responseHeaders: summarizeResponseHeaders(response.headers),
        sessionCredentialShape,
        sessionState: "UNKNOWN",
        cleanupConfirmed: false,
        cleanupStatus: "UNCONFIRMED",
        expirationCleanup: "UNVERIFIED",
        automaticSessionRetry: false,
        credentialValuesRetained: false,
      });
      throw new Error(`${name} session response did not contain the required credential fields`);
    }
    context.registerSecret(session.accessToken);
    context.registerSecret(session.rpcToken);

    let revokeStarted = false;
    let revokeStatus = null;
    const revoke = async () => {
      if (revokeStarted) return;
      revokeStarted = true;
      const revokeAt = new Date().toISOString();
      const revokeTimer = performance.now();
      try {
        const revoked = await fetchWithTimeout(sessionUrl, {
          method: "DELETE",
          headers: { Origin: publicOrigin, Authorization: `Bearer ${session.accessToken}` },
        });
        revokeStatus = revoked.status;
        await recordPublicApiRequest({
          name,
          method: "DELETE /api/mobile/session",
          path: routePathTemplate("/api/mobile/session"),
          startedAt: revokeAt,
          elapsedMs: roundMs(performance.now() - revokeTimer),
          status: revoked.status,
        });
        await context.writeArtifactJsonInternal(`route-probe-${name}-session-revoke.json`, {
          gateway: name,
          routeFingerprint,
          sessionRevokeTransport: "public-exact-g-route",
          path: routePathTemplate("/api/mobile/session"),
          requestStartedAt: revokeAt,
          elapsedMs: roundMs(performance.now() - revokeTimer),
          status: revoked.status,
          responseHeaders: summarizeResponseHeaders(revoked.headers),
          responseBody: revoked.status === 204
            ? { status: "empty-success" }
            : await readBoundedErrorResponseBody(revoked, text => context.redactText(text)),
          revokeConfirmed: revoked.status === 204,
          cleanupConfirmed: revoked.status === 204,
          cleanupStatus: revoked.status === 204 ? "CONFIRMED" : "UNCONFIRMED",
          automaticRequestRetry: false,
          credentialValuesRetained: false,
        });
        assert.equal(revoked.status, 204, `${name} temporary route-probe session must be revoked`);
      } catch (error) {
        if (revokeStatus === null) {
          const elapsedMs = roundMs(performance.now() - revokeTimer);
          const errorCategory = safeProbeErrorCategory(error);
          await recordPublicApiRequest({
            name,
            method: "DELETE /api/mobile/session",
            path: routePathTemplate("/api/mobile/session"),
            startedAt: revokeAt,
            elapsedMs,
            status: null,
            errorCategory,
          }).catch(() => {});
          await context.writeArtifactJsonInternal(`route-probe-${name}-session-revoke.json`, {
            gateway: name,
            routeFingerprint,
            sessionRevokeTransport: "public-exact-g-route",
            path: routePathTemplate("/api/mobile/session"),
            requestStartedAt: revokeAt,
            elapsedMs,
            status: null,
            errorCategory,
            revokeConfirmed: false,
            cleanupConfirmed: false,
            cleanupStatus: "UNCONFIRMED",
            automaticRequestRetry: false,
            credentialValuesRetained: false,
          }).catch(() => {});
        }
        throw error;
      }
    };
    context.addCleanup(`revoke route-probe ${name} session`, revoke);
    sessions[name] = { accessToken: session.accessToken, revoke };
    await recordPublicApiRequest({
      name,
      method: "POST /api/mobile/session",
      path: routePathTemplate("/api/mobile/session"),
      startedAt,
      elapsedMs,
      status: response.status,
    });
    await context.writeArtifactJsonInternal(`route-probe-${name}-session-exchange.json`, {
      gateway: name,
      routeFingerprint,
      sessionIssuanceTransport: "public-exact-g-route",
      path: routePathTemplate("/api/mobile/session"),
      requestHeaders: ["Origin", "Content-Type"],
      requestBodyFields: ["token"],
      requestStartedAt: startedAt,
      elapsedMs,
      status: response.status,
      responseHeaders: summarizeResponseHeaders(response.headers),
      sessionState: "ACTIVE",
      cleanupConfirmed: false,
      cleanupStatus: "PENDING",
      credentialValuesRetained: false,
    });
  }

  async function readServers(name) {
    const identity = identities[name];
    const routeFingerprint = sha256(identity.id);
    const expectedServerId = `public-fixture-${name}`;
    const collector = diagnosticCollectors[name];
    const clientBefore = collector.snapshot();
    const relayBefore = await readDataSocketObservation(cloudHost, remoteStatus);
    const requestStartedAt = new Date().toISOString();
    const started = performance.now();
    let response;
    try {
      response = await fetchWithTimeout(`${routeFor(name)}/api/servers`, {
        headers: {
          Origin: publicOrigin,
          Authorization: `Bearer ${sessions[name].accessToken}`,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      const elapsedMs = roundMs(performance.now() - started);
      const errorCategory = safeProbeErrorCategory(error);
      await recordPublicApiRequest({
        name,
        method: "GET /api/servers",
        path: routePathTemplate("/api/servers"),
        startedAt: requestStartedAt,
        elapsedMs,
        status: null,
        errorCategory,
      });
      const relayAfter = await readDataSocketObservation(cloudHost, remoteStatus);
      const clientAfter = collector.snapshot();
      const clientEvents = clientAfter.events.slice(clientBefore.events.length);
      const relayDelta = relayBefore.status === "captured" && relayAfter.status === "captured"
        ? relayAfter.dataSocketCount - relayBefore.dataSocketCount
        : null;
      await context.writeArtifactJsonInternal(`route-probe-${name}-servers-observation.json`, {
        gateway: name,
        routeFingerprint,
        method: "GET /api/servers",
        requestStartedAt,
        elapsedMs,
        status: null,
        errorCategory,
        responseBody: { status: "UNAVAILABLE", reason: "no-http-response" },
        requestHeaders: ["Origin", "Authorization: Bearer", "Cache-Control"],
        ambientCookieSent: false,
        clientEvents,
        clientCollector: { eventCount: clientAfter.eventCount, droppedCount: clientAfter.droppedCount, rejectedCount: clientAfter.rejectedCount },
        relayBefore,
        relayAfter,
        relayAcceptedDataSocketDelta: relayDelta,
        relayEventsForRequest: selectRelayEventsForClientHashes(relayBefore, relayAfter, clientEvents, routeFingerprint),
        diagnosticOverlaySha256: diagnosticOverlayInfo.runtimeClientSha256,
      });
      throw new Error(`route-probe ${name} GET /api/servers failed before an HTTP response`);
    }

    const elapsedMs = roundMs(performance.now() - started);
    await recordPublicApiRequest({
      name,
      method: "GET /api/servers",
      path: routePathTemplate("/api/servers"),
      startedAt: requestStartedAt,
      elapsedMs,
      status: response.status,
    });
    let bodySummary = { status: "not-read" };
    let serverCount = null;
    let expectedServerMatch = false;
    let parseCategory = null;
    if (response.status === 200) {
      try {
        const payload = await readBoundedJsonResponse(response);
        const servers = Array.isArray(payload?.servers) ? payload.servers : [];
        serverCount = servers.length;
        expectedServerMatch = servers.length === 1 && servers[0]?.id === expectedServerId;
        bodySummary = { status: "parsed-success", byteLimit: 16 * 1024 };
      } catch {
        parseCategory = "invalid-or-oversized-json";
        bodySummary = { status: "UNAVAILABLE", reason: "success-body-not-retained" };
      }
    } else {
      parseCategory = "http-status";
      bodySummary = await readBoundedErrorResponseBody(response, text => context.redactText(text));
    }

    // Let immediate request/WS close events arrive without extending any network timeout.
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
    const relayAfter = await readDataSocketObservation(cloudHost, remoteStatus);
    const clientAfter = collector.snapshot();
    const clientEvents = clientAfter.events.slice(clientBefore.events.length);
    const relayEvents = selectRelayEventsForClientHashes(relayBefore, relayAfter, clientEvents, routeFingerprint);
    const relayDelta = relayBefore.status === "captured" && relayAfter.status === "captured"
      ? relayAfter.dataSocketCount - relayBefore.dataSocketCount
      : null;
    const observation = {
      gateway: name,
      routeFingerprint,
      expectedServerFingerprint: sha256(expectedServerId),
      method: "GET /api/servers",
      requestStartedAt,
      elapsedMs,
      status: response.status,
      errorCategory: parseCategory,
      requestHeaders: ["Origin", "Authorization: Bearer", "Cache-Control"],
      ambientCookieSent: false,
      serverCount,
      expectedServerMatch,
      responseBody: bodySummary,
      relayAcceptedDataSocketDelta: relayDelta,
      relayBefore: relayBefore.status,
      relayAfter: relayAfter.status,
      relayEventsForRequest: relayEvents,
      clientEventCount: clientEvents.length,
      clientDroppedCount: clientAfter.droppedCount,
      clientRejectedCount: clientAfter.rejectedCount,
      clientEvents,
      diagnosticOverlaySha256: diagnosticOverlayInfo.runtimeClientSha256,
    };
    await context.writeArtifactJsonInternal(`route-probe-${name}-servers-observation.json`, observation);
    assert.equal(response.status, 200, `${name} authenticated /api/servers request must return HTTP 200`);
    assert.equal(parseCategory, null, `${name} /api/servers response must be bounded valid JSON`);
    assert.equal(serverCount, 1, `${name} isolated Gateway must expose exactly its one synthetic server`);
    assert.ok(expectedServerMatch, `${name} route must expose its own synthetic server fixture`);
    assert.equal(relayDelta, 1, `${name} /api/servers request must accept exactly one Gateway data WebSocket`);
    checks.push({
      gateway: name,
      routeFingerprint,
      status: response.status,
      expectedServerFingerprint: sha256(expectedServerId),
      expectedServerMatch,
      relayAcceptedDataSocketDelta: relayDelta,
    });
  }

  await exchangeSession("alpha");
  await readServers("alpha");
  await exchangeSession("beta");
  await readServers("beta");
  await sessions.alpha.revoke();
  await sessions.beta.revoke();
  assert.deepEqual(checks.map(check => check.gateway), ["alpha", "beta"], "exactly one authenticated /api/servers request must run in alpha-then-beta order");
  const publicApiRequestSummary = publicApiRequestLedger.snapshot();
  return {
    positiveServerListRequestCount: checks.length,
    order: checks.map(check => check.gateway),
    checks,
    sessionRevokeStatuses: { alpha: 204, beta: 204 },
    publicApiRequestCount: publicApiRequestSummary.requestCount,
    publicApiRequestMethodCounts: publicApiRequestSummary.methodCounts,
    publicApiRequestOrder: publicApiRequestSummary.order,
  };
}

function selectRelayEventsForClientHashes(relayBefore, relayAfter, clientEvents, routeFingerprint) {
  if (relayAfter.status !== "captured") return { status: "UNAVAILABLE" };
  if (relayBefore.status !== "captured") return { status: "UNAVAILABLE", reason: "pre-request-state-unavailable" };
  const hashes = new Set(clientEvents.filter(event => event.event === "open_received" && typeof event.correlation === "string").map(event => event.correlation));
  const before = relayBefore.dataSocketEvents;
  const after = relayAfter.dataSocketEvents;
  const appended = after.length >= before.length ? after.slice(before.length) : after;
  const events = appended.filter(event => event.routeFingerprint === routeFingerprint || hashes.has(event.channelFingerprint));
  return { status: "captured", events };
}

async function readBoundedJsonResponse(response, maxBytes = 16 * 1024) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("bounded response limit exceeded");
    try { return JSON.parse(text); }
    catch { throw new Error("bounded response was not JSON"); }
  }
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error("bounded response limit exceeded");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("bounded response was not JSON"); }
}

function safeProbeErrorCategory(error) {
  const code = error?.cause?.code ?? error?.code;
  const allowed = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);
  if (typeof code === "string" && allowed.has(code)) return code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "local-timeout";
  return "request-error";
}

function summarizeTransportObservations(observations, identities) {
  return Object.fromEntries(["alpha", "beta"].map(name => [name, {
    routeFingerprint: sha256(identities[name].id),
    registration: observations[name].registration,
    controlWssOpen: observations[name].controlWssOpen,
    controlWssOpenCount: observations[name].controlWssOpen.filter(event => event.event === "open").length,
  }]));
}

async function readDataSocketObservation(host, statusPath) {
  try {
    return { status: "captured", ...await readRemoteDataSocketState(host, statusPath) };
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      errorCategory: error?.remoteEvidence?.stderrCategory || requestFailureCategory(error),
    };
  }
}

async function writeDiagnosticArtifact(context, name, value, { internal = false } = {}) {
  try {
    if (internal) await context.writeArtifactJsonInternal(name, value);
    else await context.writeArtifactJson(name, value);
  } catch {
    console.log(JSON.stringify({ stage: "diagnostic-artifact-write", status: "UNAVAILABLE", artifact: name }));
  }
}

async function waitForPublicRoot() {
  return waitFor(async () => {
    const response = await fetch(`${publicOrigin}/`, { redirect: "manual", signal: AbortSignal.timeout(5_000) }).catch(() => null);
    return response?.status === 200 ? true : null;
  }, 20_000, "public standard-port HTTPS sidecar root", 250);
}

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });
}

async function startRunOwnedSshMaster(context, host, runMarker) {
  assert.equal(process.platform, "linux", "the full public Relay fixture requires Linux OpenSSH sockets");
  assert.equal(typeof process.getuid, "function", "the SSH control directory must have a verifiable owner");
  const ownerUid = process.getuid();
  const controlDirectory = resolve(tmpdir(), `kc-fr-${runMarker}`);
  const controlPath = resolve(controlDirectory, "control");
  assert.ok(Buffer.byteLength(controlPath) < 100, "the task-owned SSH ControlPath must stay below the Unix socket path limit");
  await mkdir(controlDirectory, { mode: 0o700 });
  let masterSpawned = false;
  let controlDirectoryIdentity = null;
  context.addCleanup("remove run-private SSH ControlPath directory after master exit", async () => {
    if (masterSpawned) {
      const record = context.processes.get(sshMasterLabel);
      assert.ok(record, "the task-owned SSH master must be registered before control-directory cleanup");
      assert.equal(await processTreeAlive(record.child, record.identity), false, "keep the ControlPath directory while its owned SSH master is alive");
    }
    const currentDirectory = await lstat(controlDirectory).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!currentDirectory) return;
    assert.ok(currentDirectory.isDirectory() && !currentDirectory.isSymbolicLink(), "the SSH control directory identity changed");
    assert.ok(controlDirectoryIdentity, "the SSH control directory creation identity was not captured; refusing cleanup");
    assert.equal(currentDirectory.dev, controlDirectoryIdentity.dev, "the SSH control directory device changed");
    assert.equal(currentDirectory.ino, controlDirectoryIdentity.ino, "the SSH control directory inode changed");
    assert.equal(currentDirectory.uid, ownerUid, "the SSH control directory owner changed");
    assert.equal(currentDirectory.mode & 0o777, 0o700, "the SSH control directory permissions changed");
    const entries = await readdir(controlDirectory);
    assert.ok(entries.every(entry => entry === "control"), "refusing to remove unexpected files from the SSH control directory");
    const socketInfo = await lstat(controlPath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (socketInfo) {
      assert.ok(socketInfo.isSocket(), "the ControlPath entry is not an owned Unix socket");
      assert.equal(socketInfo.uid, ownerUid, "the ControlPath socket owner changed");
      await unlink(controlPath);
    }
    await rmdir(controlDirectory);
  });
  await chmod(controlDirectory, 0o700);
  const directoryInfo = await lstat(controlDirectory);
  controlDirectoryIdentity = Object.freeze({ dev: directoryInfo.dev, ino: directoryInfo.ino });
  assert.ok(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), "the SSH control path must be inside a real directory");
  assert.equal(directoryInfo.uid, ownerUid, "the SSH control directory must belong to this run owner");
  assert.equal(directoryInfo.mode & 0o777, 0o700, "the SSH control directory must be private");

  const child = context.spawnOwned(sshMasterLabel, "ssh", [
    "-M", "-N", "-S", controlPath,
    "-o", "ControlMaster=yes",
    "-o", "ControlPersist=no",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    "-T", host,
  ], {
    env: process.env,
    stdin: "ignore",
  });
  masterSpawned = true;
  await waitFor(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`owned SSH master exited before readiness (exitCode=${child.exitCode ?? "none"}; signal=${child.signalCode ?? "none"})`);
    }
    const socketInfo = await lstat(controlPath).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!socketInfo) return null;
    assert.ok(socketInfo.isSocket(), "OpenSSH created a non-socket ControlPath entry");
    assert.equal(socketInfo.uid, ownerUid, "the OpenSSH ControlPath socket must belong to this run owner");
    return true;
  }, 10_000, "run-owned SSH master ControlPath readiness", 100, context.abortSignal);
  const check = await execFileAsync("ssh", ["-S", controlPath, "-O", "check", host], {
    encoding: "utf8",
    timeout: 1_000,
    maxBuffer: 8 * 1024,
  });
  const checkOutput = `${check.stdout}\n${check.stderr}`;
  const masterPidMatch = checkOutput.match(/master running\s+\(pid=(\d+)\)/i);
  assert.ok(masterPidMatch, "the SSH control check must report the running master PID");
  assert.equal(Number(masterPidMatch[1]), child.pid, "the SSH control socket must belong to this RunContext-owned foreground master");
  assert.equal(child.exitCode, null, "the SSH master must stay live after its control check");
  return Object.freeze({ kind: "run-owned-ssh-multiplex", host, controlDirectory, controlPath, masterLabel: sshMasterLabel });
}

function sshMultiplexClientArgs(target, command) {
  assert.ok(target && target.kind === "run-owned-ssh-multiplex", "all suite SSH clients must use the run-owned ControlMaster target");
  assert.ok(target.host && target.controlPath, "the run-owned SSH target must include its host and private ControlPath");
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    "-S", target.controlPath,
    "-o", "ControlMaster=no",
    "-o", "ProxyCommand=/bin/false",
    "-T", target.host, command,
  ];
}

async function remoteOutput(target, command, timeoutMs = 30_000, { context = null, operationLabel = null } = {}) {
  const startedAt = performance.now();
  try {
    const { stdout } = await execFileAsync("ssh", sshMultiplexClientArgs(target, command), {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (error) {
    const reason = error.killed ? "timed out" : `exit ${error.code ?? error.signal ?? "unknown"}`;
    const elapsedMs = Math.round(performance.now() - startedAt);
    const stderrCategory = classifySshStderr(String(error.stderr ?? ""));
    const stdoutRaw = String(error.stdout ?? "");
    const stderrRaw = String(error.stderr ?? "");
    const safeLabel = operationLabel
      ? operationLabel.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "remote-operation"
      : null;
    const redactAndLimit = value => {
      if (!context) return { text: null, truncated: false };
      try {
        const redacted = context.redactText(value);
        return { text: redacted.slice(0, 4096), truncated: redacted.length > 4096 };
      } catch {
        return { text: "[redaction failed]", truncated: false };
      }
    };
    const stdoutEvidence = redactAndLimit(stdoutRaw);
    const stderrEvidence = redactAndLimit(stderrRaw);
    const remoteEvidence = {
      operationLabel: safeLabel,
      exitCode: Number.isInteger(error.code) ? error.code : null,
      signal: error.signal ?? null,
      localTimeout: Boolean(error.killed),
      elapsedMs,
      stderrCategory,
      stdout: stdoutEvidence.text,
      stderr: stderrEvidence.text,
      stdoutTruncated: stdoutEvidence.truncated,
      stderrTruncated: stderrEvidence.truncated,
    };
    let evidencePath = null;
    if (context && safeLabel) {
      try {
        evidencePath = await context.writeArtifactJson(`remote-failure-${safeLabel}.json`, remoteEvidence);
      } catch {
        // Evidence writing must never mask the original remote operation failure.
      }
    }
    const detail = context && safeLabel
      ? ` (${safeLabel}; stderr=${stderrCategory}; elapsedMs=${elapsedMs}; evidence=${evidencePath ?? "unavailable"})`
      : ` (stderr=${stderrCategory}; elapsedMs=${elapsedMs})`;
    const remoteError = new Error(`remote operation on the authorized test host ${reason}${detail}`);
    remoteError.remoteEvidence = {
      exitCode: Number.isInteger(error.code) ? error.code : null,
      signal: error.signal ?? null,
      localTimeout: Boolean(error.killed),
      elapsedMs,
      stderrCategory,
      evidencePath,
    };
    throw remoteError;
  }
}

async function remoteReadOnlyOutput({ context, host, command, timeoutMs, operation, expectedOwnerPid }) {
  const failures = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const output = await remoteOutput(host, command, timeoutMs);
      if (failures.length > 0) {
        await writeReadOnlySshEvidence(context, operation, {
          status: "recovered",
          expectedOwnerPid,
          failures,
          successfulAttempt: attempt,
        });
      }
      return output;
    } catch (error) {
      const evidence = error.remoteEvidence ?? {
        exitCode: null,
        signal: null,
        localTimeout: false,
        elapsedMs: null,
        stderrCategory: "unavailable",
      };
      failures.push({ attempt, ...evidence });
      if (attempt === 3 || evidence.exitCode !== 255 || evidence.localTimeout) {
        await writeReadOnlySshEvidence(context, operation, {
          status: "failed",
          expectedOwnerPid,
          failures,
        });
        throw error;
      }

      try {
        const owner = await remoteOutput(host, `sudo -n ps -p ${expectedOwnerPid} -o pid=,comm=`, 10_000);
        assert.equal(owner.trim(), `${expectedOwnerPid} caddy`, "expected production Caddy PID must remain the process owner before retry");
      } catch (ownerError) {
        await writeReadOnlySshEvidence(context, operation, {
          status: "owner-check-failed",
          expectedOwnerPid,
          failures,
          ownerCheck: ownerError.remoteEvidence ?? { error: "process owner did not match" },
        });
        throw ownerError;
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250 * attempt));
    }
  }
  throw new Error("read-only SSH retry loop exited unexpectedly");
}

async function writeReadOnlySshEvidence(context, operation, evidence) {
  const suffix = randomBytes(4).toString("hex");
  try {
    await context.writeArtifactJson(`ssh-readonly-${operation}-${suffix}.json`, {
      operation,
      remoteCommandClass: operation === "production-caddy-config-hash" ? "read-only config SHA-256" : "read-only process provenance",
      ...evidence,
    });
  } catch {}
}

async function sshWrite(context, label, target, command, data) {
  const child = context.spawnOwned(label, "ssh", sshMultiplexClientArgs(target, command), {
    env: process.env,
    stdin: "pipe",
  });
  const timeout = setTimeout(() => { void context.stopOwned(label); }, 60_000);
  try {
    child.stdin.end(data);
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    assert.equal(code, 0, `${label} must complete successfully`);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) await context.stopOwned(label);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
