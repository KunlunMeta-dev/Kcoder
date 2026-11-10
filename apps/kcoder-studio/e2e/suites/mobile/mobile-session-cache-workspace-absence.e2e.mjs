import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { restorePinnedGatewayMobileDeployment } from "../../harness/mobile-pinned-gateway-deployment.mjs";
import { hashExecutableFile, findOwnedExecutableProcesses } from "../../harness/owned-executable-provenance.mjs";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import {
  assertMobileWorkspacePrefixInvalidated,
  captureMobileWorkspacePrefixSnapshot,
} from "../../harness/mobile-workspace-prefix-snapshot.mjs";

const identitySmoke = process.argv.includes("--restart-identity-smoke");
const singleTaskSmoke = process.argv.includes("--single-task-smoke");
assert.equal(new Set(process.argv.slice(2)).size, process.argv.length - 2,
  "suite arguments must not be repeated");
assert.ok(!(identitySmoke && singleTaskSmoke), "restart identity smoke and single-task smoke are mutually exclusive");
assert.deepEqual(process.argv.slice(2).filter(argument => !["--restart-identity-smoke", "--single-task-smoke"].includes(argument)), [],
  "suite received an unsupported argument");

const rustBinary = resolve(repoRoot, process.env.KCODER_E2E_KCODER_BIN || "target/debug/kcoder");
const expectedRustSha256 = process.env.KCODER_E2E_KCODER_BIN_SHA256;
assert.match(expectedRustSha256 ?? "", /^[a-f0-9]{64}$/,
  "KCODER_E2E_KCODER_BIN_SHA256 must caller-pin the Rust app-server executable");
const gatewayAuthToken = randomBytes(32).toString("base64url");
const inventoryClaim = "same-scope target inventory source and identity only; this run does not measure whether initialServers reduces GET requests";

await runE2E(import.meta.url, {
  testId: identitySmoke
    ? "mobile-session-cache-workspace-absence-restart-identity-smoke"
    : singleTaskSmoke
      ? "mobile-session-cache-workspace-absence-single-task-smoke"
      : "mobile-session-cache-workspace-absence-prefix-cas",
  tier: "full-integration",
  modelPolicy: identitySmoke
    ? "zero-turn real Mobile Browser/Gateway restart identity smoke; pinned production Mobile bundle, stable device authorization and target identity from an authenticated v1 bootstrap or authorized GET; no GET-reduction claim, app-server turn or model call"
    : singleTaskSmoke
      ? "one deterministic real Mobile Browser/Gateway/Rust app-server local full turn for startup and RPC observation diagnostics; normal Gateway device-access TTL; no workspace deletion, restart, prefix CAS, external Provider or model call"
      : "three deterministic Mobile Browser/Gateway/Rust app-server full turns followed by same-owner Gateway restart, real missing-local-workspace observation, workspace-prefix CAS and retained parent peer; inventory may come from authenticated v1 bootstrap or authorized GET; no GET-reduction claim or external Provider/model call",
  retainSuccessLogs: true,
}, async context => {
  await requireExecutable(rustBinary, "caller-pinned KCoder app-server");
  const rustBefore = await hashExecutableFile(rustBinary);
  assert.equal(rustBefore.sha256, expectedRustSha256,
    "the configured Rust app-server bytes must match KCODER_E2E_KCODER_BIN_SHA256");
  const { deployment } = await restorePinnedGatewayMobileDeployment(context, {
    outputName: "workspace-absence-mobile-deployment",
  });

  const workspaceParent = context.pathInState("workspace-parent");
  await mkdir(workspaceParent, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(workspaceParent), workspaceParent, "the run-owned parent workspace must have a canonical path");
  const parentStat = await lstat(workspaceParent);
  assert.ok(parentStat.isDirectory() && !parentStat.isSymbolicLink(), "the run-owned parent workspace must be a real directory");
  const targetLeaf = resolve(workspaceParent, `target-leaf-${context.seed}`);
  const serversStore = context.pathInState("studio", "servers.json");
  const configDirectory = context.pathInState("kcoder-config");
  const gatewayEnvironment = Object.freeze({
    KCODER_STUDIO_SERVERS: JSON.stringify([{
      id: "local",
      label: "Workspace absence E2E local",
      transport: "local",
      workspace: workspaceParent,
    }]),
    KCODER_STUDIO_SERVERS_STORE: serversStore,
    KCODER_CONFIG_DIR: configDirectory,
    KCODER_STUDIO_SCENARIO: "full-turn",
    KCODER_STUDIO_MOBILE_WEB_ROOT: deployment.path,
    ...(identitySmoke ? { KCODER_STUDIO_MOBILE_ACCESS_TTL_MS: "30000" } : {}),
  });
  const serversConfigSha256 = createHash("sha256").update(gatewayEnvironment.KCODER_STUDIO_SERVERS).digest("hex");
  const gateway1 = await startGateway(context, {
    label: "workspace-absence-gateway-first",
    authToken: gatewayAuthToken,
    workspace: workspaceParent,
    serversStore,
    kcoderBin: rustBinary,
    env: gatewayEnvironment,
  });
  assert.ok(gateway1.authToken === gatewayAuthToken, "the first Gateway must retain the run-owned auth token");
  const mobileEntryUrl = new URL("/mobile/", gateway1.baseUrl).href;
  const browser = await startChromium(context, {
    label: "workspace-absence-chromium",
    startTimeoutMs: 60_000,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const network = observeMobileNetwork(page, gateway1.baseUrl, gatewayAuthToken);
  let failureStage = "connect-mobile";
  let failureWorkspace = workspaceParent;
  let failureThreadId = null;
  let failureMarker = null;
  let failureTargetIdentity = null;
  let failureRestartStartedAt = null;
  let failureCacheSnapshot = null;
  let workspaceFormDiagnostic = null;
  let workspaceFormCaptureInput = null;
  const cachePersistenceBarriers = [];

  try {
    await connectMobile(page, gateway1, mobileEntryUrl);
    const profileBefore = await waitForActiveDeviceProfile(page, gateway1.baseUrl);
    const targetBefore = await waitForTargetDescriptor(network, workspaceParent, context.abortSignal, -Infinity, profileBefore,
      context, "workspace-absence-inventory-first.json");
    failureTargetIdentity = targetBefore.observationTargetIdentity;
    const originBefore = new URL(gateway1.baseUrl).origin;

    if (identitySmoke) {
      const restart = await restartGatewayAndReload({ context, page, network, gateway: gateway1, gatewayEnvironment,
        gatewayAuthToken, rustBinary, serversStore, workspaceParent, mobileUrl: mobileEntryUrl,
        originalProfile: profileBefore, originalTarget: targetBefore, originBefore, identitySmoke: true,
        onRestartStartedAt: value => { failureRestartStartedAt = value; } });
      const rustAfter = await hashExecutableFile(rustBinary);
      assert.deepEqual(rustAfter, rustBefore, "caller-pinned Rust binary changed during the identity-only smoke");
      await context.writeArtifactJson("workspace-absence-evidence.json", {
        mode: "restart-identity-smoke",
        inventoryClaim,
        turns: 0,
        sameOrigin: restart.sameOrigin,
        samePort: restart.samePort,
        sameRunAuth: restart.sameRunAuth,
        deviceProfileIdentityStable: true,
        deviceRefreshAfterRestart: restart.deviceRefreshAfterRestart,
        deviceRefreshEvidence: restart.deviceRefreshEvidence,
        deviceRefreshRequiredForMode: restart.deviceRefreshRequiredForMode,
        deviceRefreshRequestCountBeforeRestart: restart.deviceRefreshRequestCountBeforeRestart,
        deviceRefreshRequestCountAfterRestart: restart.deviceRefreshRequestCountAfterRestart,
        deviceAccessExpiredBeforeRestart: restart.deviceAccessExpiredBeforeRestart,
        gatewayLifecycleEvidence: restart.gatewayLifecycleEvidence,
        targetIdentityStable: restart.targetIdentityStable,
        initialServerInventory: targetBefore.inventoryEvidence,
        restartedServerInventory: restart.targetInventoryEvidence,
        parentWorkspaceRemainsConfigured: restart.parentWorkspaceRemainsConfigured,
        prefixCasValidated: false,
        serversConfigSha256,
        rustCallerSha256: expectedRustSha256,
        rustSha256: rustBefore.sha256,
      });
      return { mode: "restart-identity-smoke", turns: 0, prefixCasValidated: false, inventoryClaim };
    }

    if (!singleTaskSmoke) {
      await mkdir(targetLeaf, { recursive: false, mode: 0o700 });
      assert.equal(await realpath(targetLeaf), targetLeaf, "the target leaf must be a canonical run-owned directory");
      context.registerWorkspaceFixture({
        id: `workspace-absence-${context.seed}`,
        version: 1,
        materializer: "run-owned-empty-directory",
        sourceDigest: createHash("sha256").update("workspace-absence-target-leaf-v1").digest("hex"),
        path: targetLeaf,
      });
    }

    const turns = [];
    failureStage = "seed-parent-peer-turn";
    failureMarker = `WORKSPACE_ABSENCE_PARENT_${context.seed}`;
    turns.push(await createAndCompleteTask(page, {
      gateway: gateway1,
      profile: profileBefore,
      cwd: workspaceParent,
      marker: failureMarker,
      label: "parent-peer",
      network,
      context,
    }));
    failureStage = "persist-parent-peer-cache-row";
    failureWorkspace = workspaceParent;
    failureThreadId = turns[0].threadId;
    const profileForParentBarrier = await readActiveProfileIdentity(page);
    assertSameProfileIdentity(profileBefore, profileForParentBarrier, "the device-auth identity changed before the parent cache barrier");
    const parentCacheBarrier = await waitForWorkspaceCacheRows(page, {
      identity: profileForParentBarrier,
      expectedServerId: "local",
      expectedTargetWorkspacePath: workspaceParent,
      expectedRows: [{ label: "parent-peer", threadId: turns[0].threadId, cwd: workspaceParent }],
      context,
      onSnapshot: value => { failureCacheSnapshot = value; },
    });
    cachePersistenceBarriers.push(parentCacheBarrier.evidence);
    if (singleTaskSmoke) {
      assert.equal(network.httpRequestCounts["POST mobile-session-refresh"] ?? 0, 0,
        "the normal Gateway access TTL must not cause device refresh churn during one full turn");
      const profileAfter = await readActiveProfileIdentity(page);
      assertSameProfileIdentity(profileBefore, profileAfter, "the device-auth profile changed during the single-task smoke");
      await context.writeArtifactJson("workspace-absence-single-task-smoke.json", {
        mode: "single-task-smoke",
        inventoryClaim,
        turnCount: 1,
        inventory: targetBefore.inventoryEvidence,
        actualTurnStartCount: network.rpc.turnStarts.length,
        actualTurnCompletionCount: network.rpc.turnCompletions.length,
        cachePersistenceBarriers,
        deviceRefreshRequestCount: network.httpRequestCounts["POST mobile-session-refresh"] ?? 0,
        observer: summarizeRpcDiagnostic(network, { cwd: workspaceParent, marker: failureMarker,
          expectedThreadId: turns[0].threadId, startedAt: -Infinity }),
        deviceProfileIdentityStable: true,
        noWorkspaceDeletionOrRestart: true,
      });
      return { mode: "single-task-smoke", turnCount: 1, turnStarted: true, turnCompleted: true, cacheRowPersisted: true,
        deviceProfileIdentityStable: true, inventoryClaim };
    }
    failureStage = "seed-target-a-turn";
    failureWorkspace = targetLeaf;
    failureThreadId = null;
    failureMarker = `WORKSPACE_ABSENCE_TARGET_A_${context.seed}`;
    turns.push(await createAndCompleteTask(page, {
      gateway: gateway1,
      profile: profileBefore,
      cwd: targetLeaf,
      marker: failureMarker,
      label: "target-a",
      network,
      context,
    }));
    failureStage = "persist-target-a-cache-row";
    failureThreadId = turns.at(-1).threadId;
    const profileForTargetABarrier = await readActiveProfileIdentity(page);
    assertSameProfileIdentity(profileBefore, profileForTargetABarrier, "the device-auth identity changed before the target-A cache barrier");
    const targetACacheBarrier = await waitForWorkspaceCacheRows(page, {
      identity: profileForTargetABarrier,
      expectedServerId: "local",
      expectedTargetWorkspacePath: workspaceParent,
      expectedRows: [{ label: "target-a", threadId: turns.at(-1).threadId, cwd: targetLeaf }],
      context,
      onSnapshot: value => { failureCacheSnapshot = value; },
    });
    cachePersistenceBarriers.push(targetACacheBarrier.evidence);
    failureStage = "seed-target-b-turn";
    failureThreadId = null;
    failureMarker = `WORKSPACE_ABSENCE_TARGET_B_${context.seed}`;
    turns.push(await createAndCompleteTask(page, {
      gateway: gateway1,
      profile: profileBefore,
      cwd: targetLeaf,
      marker: failureMarker,
      label: "target-b",
      network,
      context,
    }));
    failureStage = "persist-target-b-cache-row";
    failureThreadId = turns.at(-1).threadId;
    const profileForTargetBBarrier = await readActiveProfileIdentity(page);
    assertSameProfileIdentity(profileBefore, profileForTargetBBarrier, "the device-auth identity changed before the target-B cache barrier");
    const targetBCacheBarrier = await waitForWorkspaceCacheRows(page, {
      identity: profileForTargetBBarrier,
      expectedServerId: "local",
      expectedTargetWorkspacePath: workspaceParent,
      expectedRows: [{ label: "target-b", threadId: turns.at(-1).threadId, cwd: targetLeaf }],
      context,
      onSnapshot: value => { failureCacheSnapshot = value; },
    });
    cachePersistenceBarriers.push(targetBCacheBarrier.evidence);
    assert.ok((network.httpRequestCounts["POST mobile-session-refresh"] ?? 0) <= 1,
      "normal-TTL workspace setup and three turns must not cause repeated device refresh requests");
    assert.equal(new Set(turns.map(turn => turn.threadId)).size, 3, "the three full turns must use distinct thread identities");
    assert.equal(network.rpc.turnStarts.length, 3, "the real Mobile page must issue exactly three turn/start requests");
    assert.equal(network.rpc.turnCompletions.length, 3, "the owned app-server must complete all three full turns");
    assert.ok(turns.every(turn => turn.startCount === 1 && turn.completion.status === "completed"),
      "each visible full turn must have exactly one start and a completed terminal notification");

    failureStage = "capture-real-browser-workspace-cache-prefix";
    const profileForSnapshot = await readActiveProfileIdentity(page);
    assertSameProfileIdentity(profileBefore, profileForSnapshot, "the device-auth profile changed during cache seeding");
    const beforeSnapshotResult = await waitForWorkspaceCacheRows(page, {
      identity: profileForSnapshot,
      expectedServerId: "local",
      expectedTargetWorkspacePath: workspaceParent,
      expectedRows: [
        { label: "parent-peer", threadId: turns[0].threadId, cwd: workspaceParent },
        { label: "target-a", threadId: turns[1].threadId, cwd: targetLeaf },
        { label: "target-b", threadId: turns[2].threadId, cwd: targetLeaf },
      ],
      context,
      onSnapshot: value => { failureCacheSnapshot = value; },
    });
    const beforeSnapshot = beforeSnapshotResult.snapshot;
    const targets = beforeSnapshot.entries.filter(entry => entry.cwd === targetLeaf);
    const peers = beforeSnapshot.entries.filter(entry => entry.cwd === workspaceParent);
    assert.equal(targets.length, 2, "the read-only cache snapshot must retain both exact child rows");
    assert.equal(peers.length, 1, "the read-only cache snapshot must retain the parent peer row");
    const targetKeys = new Set(beforeSnapshot.entries.filter(entry => entry.cwd === targetLeaf).map(entry => entry.workspaceKey));
    assert.equal(targetKeys.size, 1, "both child transcripts must share one exact workspace prefix");
    const targetWorkspaceKey = [...targetKeys][0];
    const peerWorkspaceKey = beforeSnapshot.entries.find(entry => entry.cwd === workspaceParent)?.workspaceKey;
    assert.ok(peerWorkspaceKey && peerWorkspaceKey !== targetWorkspaceKey,
      "the parent transcript must be a distinct retained workspace prefix");
    const targetThreadIds = beforeSnapshot.entries.filter(entry => entry.cwd === targetLeaf).map(entry => entry.threadId).sort();
    assert.deepEqual(targetThreadIds, turns.filter(turn => turn.cwd === targetLeaf).map(turn => turn.threadId).sort(),
      "the read-only IndexedDB snapshot must contain the two actual child thread IDs");
    const taskUrl = turns.at(-1).url;
    assert.ok(taskUrl.startsWith(`${mobileEntryUrl.slice(0, -1)}/h/`), "the final thread route must remain on the original Mobile origin and mount");

    const processRecord = context.processes.get("workspace-absence-gateway-first");
    const ownedRustProcesses = await findOwnedExecutableProcesses({ pgid: processRecord.pgid, executablePath: rustBinary });
    assert.ok(ownedRustProcesses.length > 0 && ownedRustProcesses.every(item => item.sha256 === rustBefore.sha256),
      "the first Gateway process tree must contain the exact caller-pinned Rust app-server executable");

    failureStage = "restart-and-observe-missing-child-workspace";
    failureWorkspace = targetLeaf;
    failureThreadId = turns.at(-1).threadId;
    failureMarker = `WORKSPACE_ABSENCE_TARGET_B_${context.seed}`;
    const restart = await restartGatewayAndReload({ context, page, network, gateway: gateway1, gatewayEnvironment,
      gatewayAuthToken, rustBinary, serversStore, workspaceParent, mobileUrl: taskUrl,
      originalProfile: profileBefore, originalTarget: targetBefore, originBefore, identitySmoke: false,
      onRestartStartedAt: value => { failureRestartStartedAt = value; } });
    assert.equal(restart.targetLeafStillAbsent, true, "the target workspace leaf must remain absent after same-config Gateway restart");
    assert.equal(restart.parentWorkspaceRemainsConfigured, true, "the Gateway must still advertise the existing parent workspace");

    failureStage = "accept-real-target-bound-cwd-observation";
    const cwdObservation = await waitFor(() => {
      const match = network.cwdObservations.find(item => item.at >= restart.startedAt && item.statusCode === 200 &&
        item.method === "GET" && item.workspacePath === targetLeaf && item.value?.status === "absent" && item.value?.reason === undefined &&
        item.value?.targetId === "local" &&
        item.value?.authorized === true && item.value?.workspacePath === targetLeaf &&
        item.expectedTargetIdentity === targetBefore.observationTargetIdentity &&
        item.value?.targetSignature === targetBefore.observationTargetIdentity &&
        Number.isSafeInteger(item.value?.loginGeneration) && item.value.loginGeneration >= 0 && item.value?.version === 1 &&
        typeof item.value?.observedAt === "number" && Number.isFinite(item.value.observedAt) && item.value.observedAt >= 0);
      return match ?? null;
    }, 15_000, "real authorized target-bound absent workspace observation from the restarted Gateway", 50, context.abortSignal);
    assert.equal(restart.postRestartWorkspaceRpcAttempt.observed, true,
      "the real Browser must emit the exact post-restart WebSocket handshake attempt");
    assert.equal(restart.postRestartWorkspaceRpcAttempt.sameGatewayOrigin, true,
      "the Browser WebSocket attempt must target the restarted Gateway origin");
    assert.equal(restart.postRestartWorkspaceRpcAttempt.rpcPathMatches, true,
      "the Browser WebSocket attempt must use the Gateway RPC path");
    assert.equal(restart.postRestartWorkspaceRpcAttempt.serverIsLocal, true,
      "the actual post-restart Browser WebSocket attempt must target the local server");
    assert.equal(restart.postRestartWorkspaceRpcAttempt.runtimeChannel, true,
      "the actual post-restart Browser WebSocket attempt must use the runtime channel");
    assert.equal(restart.postRestartWorkspaceRpcAttempt.workspaceMatchesDeletedLeaf, true,
      "the actual post-restart Browser WebSocket attempt must carry the exact deleted child cwd");
    assert.equal(restart.postRestartWorkspaceRpcAttempt.routeThreadMatchesExpected, true,
      "the actual post-restart Browser WebSocket attempt must retain the exact final thread route");
    await page.getByTestId("home-confirmed-workspace-absence-notice").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(network.rpc.turnStarts.length, 3,
      "confirmed workspace absence must not resend or create any turn/start request");

    failureStage = "verify-workspace-prefix-cas-and-parent-entry";
    const afterIdentity = await readActiveProfileIdentity(page);
    assertSameProfileIdentity(profileBefore, afterIdentity, "the final Mobile auth owner differs from the pre-restart owner");
    const afterSnapshot = await captureMobileWorkspacePrefixSnapshot(page, { identity: afterIdentity, expectedServerId: "local",
      expectedTargetWorkspacePath: workspaceParent });
    const prefixCas = assertMobileWorkspacePrefixInvalidated(beforeSnapshot, afterSnapshot, {
      workspaceKey: targetWorkspaceKey,
      targetCwd: targetLeaf,
      peerCwd: workspaceParent,
      expectedTargetCount: 2,
    });

    failureStage = "open-final-new-workspace-form";
    await page.getByTestId("new-workspace").click();
    await page.getByTestId("server-option-local").click();
    const parentField = page.getByTestId("workspace-path");
    await parentField.waitFor({ state: "visible", timeout: 20_000 });
    failureStage = "wait-final-new-workspace-form-ready";
    const formReadiness = await waitFor(async () => {
      const fieldEditable = await parentField.isEditable().catch(() => false);
      const projectsLoadingCount = await page.getByTestId("new-workspace-projects-loading").count();
      const modelSelectorEnabled = await page.getByTestId("model-selector").isEnabled().catch(() => false);
      return fieldEditable && projectsLoadingCount === 0 && modelSelectorEnabled
        ? { fieldEditable, projectsLoadingCount, modelSelectorEnabled }
        : null;
    }, 20_000, "new-workspace directory and model catalogs ready", 50, context.abortSignal);
    const diagnosticPrompt = `WORKSPACE_ABSENCE_FINAL_UNSENT_${context.seed}`;
    workspaceFormCaptureInput = {
      profileId: afterIdentity.profileId,
      serverId: "local",
      workspaceParent,
      targetLeaf,
      formReadiness,
      diagnosticPrompt,
      unsentPromptEntered: false,
      createButtonClicked: false,
    };
    await page.getByTestId("new-workspace-prompt").fill(diagnosticPrompt);
    workspaceFormCaptureInput.unsentPromptEntered = true;
    const createButton = page.getByTestId("create-workspace");
    failureStage = "wait-workspace-form-create-button-visible";
    await createButton.waitFor({ state: "visible", timeout: 20_000 });
    failureStage = "capture-workspace-entry-before-create-enabled-wait";
    workspaceFormDiagnostic = await captureWorkspaceEntryDiagnostic(page, workspaceFormCaptureInput);
    assert.equal(network.rpc.turnStarts.length, 3,
      "the diagnostic unsent prompt must not create or resend a turn");
    failureStage = "wait-workspace-form-create-button-enabled";
    await waitFor(async () => await createButton.isEnabled().catch(() => false) ? true : null,
      20_000, "new-workspace form ready without submitting", 50, context.abortSignal);
    failureStage = "assert-parent-workspace-after-create-enabled";
    workspaceFormDiagnostic.createButtonEnabledAfterWait = await createButton.isEnabled().catch(() => false);
    workspaceFormDiagnostic.fieldMatchesParentAfterCreateEnabled = await parentField.inputValue()
      .then(value => value === workspaceParent).catch(() => false);
    assert.equal(workspaceFormDiagnostic.fieldMatchesParentAfterCreateEnabled, true,
      "the valid Gateway parent must remain the Mobile new-workspace entry after child absence");

    const rustAfter = await hashExecutableFile(rustBinary);
    assert.deepEqual(rustAfter, rustBefore, "caller-pinned Rust binary changed during workspace absence recovery");
    await context.writeArtifactJson("workspace-absence-evidence.json", {
      mode: "workspace-prefix-cas",
      inventoryClaim,
      turnCount: turns.length,
      firstGatewayOwnedRustAppServerCount: ownedRustProcesses.length,
      postRestartWorkspaceRpcAttempt: restart.postRestartWorkspaceRpcAttempt,
      workspaceRecoveryObservationAccepted: true,
      exactAbsentObservationObserved: true,
      absentObservationVersion: cwdObservation.value.version,
      absentObservationLoginGeneration: cwdObservation.value.loginGeneration,
      deviceProfileIdentityStable: true,
      deviceRefreshAfterRestart: restart.deviceRefreshAfterRestart,
      deviceRefreshEvidence: restart.deviceRefreshEvidence,
      deviceRefreshRequiredForMode: restart.deviceRefreshRequiredForMode,
      deviceRefreshRequestCountBeforeRestart: restart.deviceRefreshRequestCountBeforeRestart,
      deviceRefreshRequestCountAfterRestart: restart.deviceRefreshRequestCountAfterRestart,
      deviceAccessExpiredBeforeRestart: restart.deviceAccessExpiredBeforeRestart,
      gatewayLifecycleEvidence: restart.gatewayLifecycleEvidence,
      sameOrigin: restart.sameOrigin,
      samePort: restart.samePort,
      sameRunAuth: restart.sameRunAuth,
      targetIdentityStable: restart.targetIdentityStable,
      initialServerInventory: targetBefore.inventoryEvidence,
      restartedServerInventory: restart.targetInventoryEvidence,
      parentWorkspaceRemainsConfigured: restart.parentWorkspaceRemainsConfigured,
      childWorkspaceAbsentAfterRestart: restart.targetLeafStillAbsent,
      cachePersistenceBarriers,
      workspaceCachePrefixSnapshot: beforeSnapshotResult.evidence,
      workspacePrefixCas: prefixCas,
      workspaceEntryForm: workspaceFormDiagnostic,
      noTurnResend: network.rpc.turnStarts.length === 3,
      serversConfigSha256,
      rustCallerSha256: expectedRustSha256,
      rustSha256: rustBefore.sha256,
    });
    return { mode: "workspace-prefix-cas", turnCount: turns.length, workspaceRpcAttemptObserved: true,
      workspaceRecoveryObservationAccepted: true, deviceRefreshAfterRestart: restart.deviceRefreshAfterRestart,
      deviceRefreshRequiredForMode: restart.deviceRefreshRequiredForMode, inventoryClaim,
      postRestartWorkspaceRpcAttempt: restart.postRestartWorkspaceRpcAttempt,
      cachePersistenceBarriers, workspaceCachePrefixSnapshot: beforeSnapshotResult.evidence,
      workspacePrefixCas: prefixCas, noTurnResend: true };
  } catch (error) {
    if (workspaceFormCaptureInput) {
      const failureReadback = await captureWorkspaceEntryDiagnostic(page, workspaceFormCaptureInput).catch(() => null);
      if (failureReadback) {
        if (workspaceFormDiagnostic) workspaceFormDiagnostic.failureReadback = failureReadback;
        else workspaceFormDiagnostic = failureReadback;
      }
    }
    const diagnostic = await createWorkspaceAbsenceFailureDiagnostic(context, page, network, {
      failureStage, cwd: failureWorkspace, expectedThreadId: failureThreadId,
      expectedMarker: failureMarker, expectedTargetIdentity: failureTargetIdentity,
      restartStartedAt: failureRestartStartedAt, cacheSnapshot: failureCacheSnapshot,
      cachePersistenceBarriers, workspaceFormDiagnostic, error,
    }).catch(() => null);
    if (diagnostic) await context.writeArtifactJson("workspace-absence-failure-diagnostic.json", diagnostic).catch(() => {});
    throw error;
  } finally {
    if (browser && page && !page.isClosed()) await page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {});
  }
});

async function connectMobile(page, gateway, mobileEntryUrl) {
  await page.goto(mobileEntryUrl, { waitUntil: "domcontentloaded" });
  const direct = page.getByTestId("welcome-direct-connection");
  await direct.waitFor({ state: "visible", timeout: 30_000 });
  await direct.click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await Promise.all([
    page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 }),
    page.getByTestId("gateway-connect").click(),
  ]);
}

async function createAndCompleteTask(page, { gateway, profile, cwd, marker, label, network, context }) {
  const progress = {
    homeRouteReady: false,
    newWorkspaceVisible: false,
    createFormOpened: false,
    localServerSelected: false,
    exactWorkspaceFilled: false,
    promptFilled: false,
    createClickReturned: false,
    userMessageVisible: false,
    exactTaskRouteMatched: false,
    turnStartMatched: false,
    turnCompleted: false,
  };
  let failureStage = "open-home-route";
  let startedAt = null;
  let route = null;
  network.activeTask = { label, cwd, marker, startedAt: null };
  try {
    const homeUrl = new URL(`/mobile/h/${encodeURIComponent(profile.profileId)}`, gateway.baseUrl).href;
    if (new URL(page.url()).href !== homeUrl) await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
    progress.homeRouteReady = true;
    failureStage = "wait-new-workspace";
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 20_000 });
    progress.newWorkspaceVisible = true;
    failureStage = "open-create-form";
    await page.getByTestId("new-workspace").click();
    progress.createFormOpened = true;
    failureStage = "select-local-server";
    await page.getByTestId("server-option-local").click();
    progress.localServerSelected = true;
    const workspace = page.getByTestId("workspace-path");
    failureStage = "fill-workspace";
    await workspace.waitFor({ state: "visible", timeout: 20_000 });
    await workspace.fill(cwd);
    assert.equal(await workspace.inputValue(), cwd, `${label} must create the exact requested cwd`);
    progress.exactWorkspaceFilled = true;
    failureStage = "fill-prompt";
    await page.getByTestId("new-workspace-prompt").fill(marker);
    progress.promptFilled = true;
    startedAt = Date.now();
    network.activeTask.startedAt = startedAt;
    const turnStartCount = countWorkspaceTurnStarts(network, cwd);
    failureStage = "click-create-workspace";
    await page.getByTestId("create-workspace").click();
    progress.createClickReturned = true;
    failureStage = "wait-user-message";
    await page.getByTestId("message-user").filter({ hasText: marker }).waitFor({ state: "visible", timeout: 30_000 });
    progress.userMessageVisible = true;
    failureStage = "wait-exact-task-route";
    const taskUrl = await waitFor(() => {
      const parsed = parseTaskRoute(page.url());
      return parsed?.threadId && parsed.cwd === cwd ? page.url() : null;
    }, 20_000, `${label} exact Mobile task route`, 50, context.abortSignal);
    route = parseTaskRoute(taskUrl);
    progress.exactTaskRouteMatched = true;
    assert.ok(route.profileId && route.serverId === "local" && route.cwd === cwd,
      `${label} must stay bound to the live local profile and requested cwd`);
    failureStage = "wait-actual-turn-start";
    const start = await waitFor(() => network.rpc.turnStarts.find(item => item.serverId === "local" && item.channel === "runtime" &&
      item.workspace === cwd && item.threadId === route.threadId && item.at >= startedAt) ?? null,
      20_000, `${label} actual turn/start`, 50, context.abortSignal);
    progress.turnStartMatched = true;
    assert.equal(start.serverId, "local", `${label} turn/start must use the requested server`);
    assert.equal(start.channel, "runtime", `${label} turn/start must use the runtime RPC channel`);
    assert.equal(start.workspace, cwd, `${label} turn/start must use the requested workspace path`);
    failureStage = "wait-actual-turn-completion";
    const completion = await waitFor(() => network.rpc.turnCompletions.find(item => item.serverId === "local" &&
      item.channel === "runtime" && item.workspace === cwd && item.threadId === route.threadId && item.at >= startedAt) ?? null,
      60_000, `${label} actual turn/completed`, 50, context.abortSignal);
    progress.turnCompleted = true;
    assert.equal(completion.status, "completed", `${label} must complete a real app-server turn`);
    assert.equal(countWorkspaceTurnStarts(network, cwd) - turnStartCount, 1, `${label} must issue one scoped turn/start only`);
    assert.equal(await page.getByTestId("message-user").filter({ hasText: marker }).count(), 1,
      `${label} must retain one user message for its actual full-turn prompt`);
    const identityNow = await readActiveProfileIdentity(page);
    assertSameProfileIdentity(profile, identityNow, `${label} changed the active device-auth identity`);
    return { label, threadId: route.threadId, cwd, url: taskUrl, startCount: 1, completion };
  } catch (error) {
    const diagnostic = await createFailureDiagnostic(page, network, { label, cwd, marker, route, startedAt, progress, failureStage });
    await context.writeArtifactJson(`workspace-absence-${label}-create-failure.json`, diagnostic).catch(() => {});
    throw error;
  } finally {
    network.activeTask = null;
  }
}

async function waitForWorkspaceCacheRows(page, { identity, expectedServerId, expectedTargetWorkspacePath, expectedRows,
  context, onSnapshot }) {
  let sampleCount = 0;
  return waitFor(async () => {
    sampleCount++;
    let snapshot;
    try {
      snapshot = await captureMobileWorkspacePrefixSnapshot(page, {
        identity, expectedServerId, expectedTargetWorkspacePath,
      });
    } catch (error) {
      onSnapshot?.(summarizeWorkspaceCacheRows(null, expectedRows, expectedServerId, sampleCount, "snapshot-read-error"));
      throw error;
    }
    const evidence = summarizeWorkspaceCacheRows(snapshot, expectedRows, expectedServerId, sampleCount);
    onSnapshot?.(evidence);
    return evidence.exactRowsPresent ? { snapshot, evidence } : null;
  }, 20_000, `read-only IndexedDB snapshot with exact rows: ${expectedRows.map(row => row.label).join(", ")}`,
  100, context.abortSignal);
}

function summarizeWorkspaceCacheRows(snapshot, expectedRows, expectedServerId, sampleCount, failureReason = null) {
  const ready = snapshot?.ready === true;
  const entries = ready && Array.isArray(snapshot.entries) ? snapshot.entries : [];
  const allowedUnavailableReasons = new Set(["indexeddb_enumeration_unavailable", "database_missing"]);
  const reason = failureReason ?? (ready ? null : allowedUnavailableReasons.has(snapshot?.reason) ? snapshot.reason : "snapshot-unavailable");
  const rowChecks = expectedRows.map(expected => {
    const threadEntries = entries.filter(entry => entry.threadId === expected.threadId);
    const workspaceEntries = entries.filter(entry => entry.cwd === expected.cwd);
    const exactRowMatchCount = entries.filter(entry => entry.threadId === expected.threadId &&
      entry.cwd === expected.cwd && entry.targetId === expectedServerId).length;
    return {
      label: expected.label,
      threadMatchPresent: threadEntries.length > 0,
      workspaceMatchPresent: workspaceEntries.length > 0,
      exactRowMatchCount,
      exactRowPresent: exactRowMatchCount === 1,
    };
  });
  return {
    ready,
    reason,
    sampleCount,
    manifestRevision: Number.isSafeInteger(snapshot?.manifest?.revision) ? snapshot.manifest.revision : null,
    profileEntryCount: ready ? entries.length : null,
    expectedRowCount: expectedRows.length,
    exactRowsMatchCount: rowChecks.filter(row => row.exactRowPresent).length,
    exactRowsPresent: ready && rowChecks.every(row => row.exactRowPresent),
    rowChecks,
  };
}

async function restartGatewayAndReload({ context, page, network, gateway, gatewayEnvironment,
  gatewayAuthToken, rustBinary, serversStore, workspaceParent, mobileUrl, originalProfile, originalTarget,
  originBefore, identitySmoke, onRestartStartedAt }) {
  const firstGatewayRecord = context.processes.get("workspace-absence-gateway-first");
  assert.ok(Number.isSafeInteger(firstGatewayRecord?.pid) && firstGatewayRecord.pid > 0,
    "the exact first Gateway owner must expose its process identity before restart");
  const firstGatewayPid = firstGatewayRecord.pid;
  const profileBeforeRestart = await readActiveProfileIdentity(page);
  assertSameProfileIdentity(originalProfile, profileBeforeRestart,
    "the active device-auth owner changed before the Gateway restart");
  const deviceRefreshRequestCountBeforeRestart = network.httpRequestCounts["POST mobile-session-refresh"] ?? 0;
  assert.ok(deviceRefreshRequestCountBeforeRestart <= 1,
    "one Gateway lifecycle phase must not produce repeated device refresh requests");
  const ownedRpcSockets = network.rpc.sockets.filter(socket => socket.attemptObservedAt !== null);
  if (!identitySmoke) assert.ok(ownedRpcSockets.length > 0, "the Mobile Browser must have attempted an actual Gateway RPC WebSocket");
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  const rpcSocketCloseDiagnostic = {
    observedSocketCount: ownedRpcSockets.length,
    closedAfterNavigationCount: ownedRpcSockets.filter(socket => socket.closedAt !== null).length,
  };

  await context.stopOwned("workspace-absence-gateway-first");
  const stopped = context.processes.get("workspace-absence-gateway-first");
  assert.ok(stopped?.stopped === true, "RunContext must confirm the exact first Gateway process tree stopped");
  assert.equal(stopped.pid, firstGatewayPid, "RunContext must stop the exact Gateway process observed before restart");
  await waitFor(async () => {
    try { await fetch(gateway.baseUrl, { signal: AbortSignal.timeout(500) }); return false; }
    catch { return true; }
  }, 5_000, "first Gateway listener to stop accepting on its owned port", 50, context.abortSignal);
  rpcSocketCloseDiagnostic.closedAfterOwnedStopCount = ownedRpcSockets.filter(socket => socket.closedAt !== null).length;

  if (!identitySmoke) {
    const leafStat = await lstat(resolve(workspaceParent, `target-leaf-${context.seed}`));
    const targetLeaf = resolve(workspaceParent, `target-leaf-${context.seed}`);
    assert.ok(leafStat.isDirectory() && !leafStat.isSymbolicLink(), "only the real run-owned target leaf may be deleted");
    assert.equal(await realpath(targetLeaf), targetLeaf, "the deleted target must remain beneath its exact owned path");
    assert.equal(await realpath(workspaceParent), workspaceParent, "the configured parent must remain canonical before deletion");
    await rm(targetLeaf, { recursive: true, force: false });
    await assert.rejects(lstat(targetLeaf), error => error?.code === "ENOENT",
      "the actual workspace leaf must be missing before Gateway restart");
    const parentAfterDelete = await lstat(workspaceParent);
    assert.ok(parentAfterDelete.isDirectory() && !parentAfterDelete.isSymbolicLink(),
      "the existing Gateway parent workspace must remain intact");
  }

  // Only the identity smoke deliberately expires the grant while the old Gateway is stopped.
  if (identitySmoke) {
    await waitFor(() => Date.now() > profileBeforeRestart.expiresAt,
      45_000, "short-lived device access grant to expire while the old Gateway is stopped", 50, context.abortSignal);
  } else {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  const restartStartedAt = Date.now();
  onRestartStartedAt?.(restartStartedAt);
  const deviceAccessExpiredBeforeRestart = restartStartedAt > profileBeforeRestart.expiresAt;
  if (identitySmoke) assert.equal(deviceAccessExpiredBeforeRestart, true,
    "the prior device access grant must expire while the old Gateway is stopped");
  const gateway2 = await startGateway(context, {
    label: "workspace-absence-gateway-restarted",
    host: gateway.host,
    port: gateway.port,
    authToken: gatewayAuthToken,
    workspace: workspaceParent,
    serversStore,
    kcoderBin: rustBinary,
    env: gatewayEnvironment,
  });
  const restartedGatewayRecord = context.processes.get("workspace-absence-gateway-restarted");
  assert.ok(Number.isSafeInteger(restartedGatewayRecord?.pid) && restartedGatewayRecord.pid > 0,
    "the restarted Gateway must expose its new owned process identity");
  assert.notEqual(restartedGatewayRecord.pid, firstGatewayPid,
    "the same-port restart must run in a new Gateway process after the old owner stopped");
  assert.equal(restartedGatewayRecord.stopped, false, "the new Gateway owner must remain running after binding");
  assert.equal(gateway2.port, gateway.port, "the restarted Gateway must bind the exact original port");
  assert.equal(gateway2.baseUrl, gateway.baseUrl, "the restarted Gateway must keep the exact origin and base URL");
  assert.ok(gateway2.authToken === gatewayAuthToken, "the restarted Gateway must retain the run-owned auth token");
  assert.equal(context.processes.get("workspace-absence-gateway-first")?.stopped, true,
    "the first Gateway owner must remain stopped after restart");
  const mobileUrlOnRestart = identitySmoke ? new URL("/mobile/", gateway2.baseUrl).href : mobileUrl;
  assert.equal(new URL(mobileUrlOnRestart).origin, originBefore,
    "the browser must reconnect through the same exact Mobile origin");
  const browserOrigin = new URL(mobileUrlOnRestart).origin;
  assert.equal(new URL(gateway2.baseUrl).origin, browserOrigin, "Gateway and Mobile entry must share the original origin");
  assert.equal(serversStore, context.pathInState("studio", "servers.json"), "the restart must reuse the exact RunContext server store");
  const gatewayLifecycleEvidence = {
    firstGatewayPid,
    firstGatewayStopped: stopped.stopped === true,
    firstGatewayListenerRejectedProbe: true,
    restartedGatewayPid: restartedGatewayRecord.pid,
    restartedGatewayRunning: restartedGatewayRecord.stopped === false,
    samePortRebound: gateway2.port === gateway.port,
    sameOriginReused: new URL(gateway2.baseUrl).origin === originBefore,
    rpcSocketCloseDiagnostic,
  };

  const rpcCountBeforeReload = network.rpc.sockets.length;
  const deviceRefreshRequestCountBeforeReload = network.httpRequestCounts["POST mobile-session-refresh"] ?? 0;
  await page.goto(mobileUrlOnRestart, { waitUntil: "domcontentloaded" });
  const identityAfter = await waitForActiveDeviceProfile(page, gateway2.baseUrl);
  assertSameProfileIdentity(originalProfile, identityAfter,
    "the restarted Mobile app must restore the exact same device profile and authorization generation");
  const targetAfter = await waitForTargetDescriptor(network, workspaceParent, context.abortSignal, restartStartedAt, originalProfile,
    context, "workspace-absence-inventory-restarted.json");
  assert.equal(targetAfter.inventoryEvidence.scopeFingerprint, originalTarget.inventoryEvidence.scopeFingerprint,
    `actual Gateway target inventory must remain bound to the same device authorization scope; before=${JSON.stringify(originalTarget.inventoryEvidence)} after=${JSON.stringify(targetAfter.inventoryEvidence)}`);
  assert.equal(targetAfter.observationTargetIdentity, originalTarget.observationTargetIdentity,
    `actual Gateway server inventory must preserve the exact target signature across restart; before=${JSON.stringify(originalTarget.inventoryEvidence)} after=${JSON.stringify(targetAfter.inventoryEvidence)}`);
  let refresh = null;
  let refreshedProfile = null;
  if (identitySmoke) {
    try {
      refresh = await waitFor(() => network.refreshResponses.find(item => item.at >= restartStartedAt && item.statusCode === 200 &&
        item.deviceId === originalProfile.deviceId && item.authorizationGeneration === originalProfile.authorizationGeneration &&
        item.requestDeviceIdMatchesResponse && item.requestHasRefreshCredential) ?? null,
      20_000, "successful real Mobile device refresh for the same device authorization after Gateway restart", 50, context.abortSignal);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; observed refresh evidence=${JSON.stringify(network.refreshResponses.map(summarizeRefreshObservation))}`);
    }
    const deviceRefreshRequestCountAfterRestart = (network.httpRequestCounts["POST mobile-session-refresh"] ?? 0) -
      deviceRefreshRequestCountBeforeReload;
    assert.ok(deviceRefreshRequestCountAfterRestart <= 2,
      "identity restart must complete with a bounded number of actual device refresh requests");
    refreshedProfile = await waitFor(async () => {
      const current = await readActiveProfileIdentity(page).catch(() => null);
      return current && current.expiresAt > profileBeforeRestart.expiresAt && current.expiresAt > Date.now() ? current : null;
    }, 10_000, "validated refreshed device grant with a new expiry", 50, context.abortSignal);
    assertSameProfileIdentity(originalProfile, refreshedProfile,
      "the post-restart refreshed grant must preserve the exact device authorization owner");
    assert.ok(targetAfter.inventoryEvidence.at >= restartStartedAt,
      "the restarted inventory must be observed after the Gateway restart under the same device scope");
  } else {
    const deviceRefreshRequestCountAfterRestart = (network.httpRequestCounts["POST mobile-session-refresh"] ?? 0) -
      deviceRefreshRequestCountBeforeReload;
    assert.ok(deviceRefreshRequestCountAfterRestart <= 1,
      "a valid normal-TTL device grant must not trigger repeated refresh requests after Gateway restart");
  }
  if (identitySmoke) {
    await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
    return {
      sameOrigin: new URL(gateway2.baseUrl).origin === originBefore,
      samePort: gateway2.port === gateway.port,
      sameRunAuth: gateway2.authToken === gatewayAuthToken,
      deviceRefreshAfterRestart: refresh.statusCode === 200,
      deviceRefreshEvidence: summarizeRefreshEvidence(refresh, originalProfile, refreshedProfile),
      deviceRefreshRequiredForMode: true,
      deviceRefreshRequestCountBeforeRestart,
      deviceRefreshRequestCountAfterRestart: (network.httpRequestCounts["POST mobile-session-refresh"] ?? 0) -
        deviceRefreshRequestCountBeforeReload,
      deviceAccessExpiredBeforeRestart,
      gatewayLifecycleEvidence,
      targetIdentityStable: targetAfter.observationTargetIdentity === originalTarget.observationTargetIdentity,
      targetInventoryEvidence: targetAfter.inventoryEvidence,
      parentWorkspaceRemainsConfigured: targetAfter.workspacePath === workspaceParent,
      targetLeafStillAbsent: false,
      startedAt: restartStartedAt,
      rpcCountBeforeReload,
    };
  }
  assert.equal(targetAfter.workspacePath, workspaceParent,
    "the restarted Gateway must continue to advertise the existing parent, not the deleted child cwd");
  assert.equal(await realpath(workspaceParent), workspaceParent, "the existing parent directory must survive restart");
  const taskRoute = parseTaskRoute(mobileUrl);
  assert.ok(taskRoute?.threadId, "restart must navigate to the exact prior Mobile task route");
  const targetLeaf = resolve(workspaceParent, `target-leaf-${context.seed}`);
  const rpcAttempt = await waitFor(() => network.rpc.sockets.slice(rpcCountBeforeReload).find(socket =>
    socket.attemptObservedAt >= restartStartedAt && socket.originMatchesGateway && socket.rpcPathMatchesGateway &&
    socket.serverId === "local" && socket.channel === "runtime" && socket.workspace === targetLeaf &&
    socket.routeThreadId === taskRoute.threadId) ?? null,
  20_000, "real post-restart Browser WebSocket handshake attempt bound to the exact missing child workspace", 50, context.abortSignal);
  const postRestartWorkspaceRpcAttempt = summarizeWorkspaceRpcAttempt(rpcAttempt, {
    cwd: targetLeaf, expectedThreadId: taskRoute.threadId,
  });
  const targetLeafStillAbsent = await lstat(targetLeaf).then(() => false, error => error?.code === "ENOENT");
  assert.equal(targetLeafStillAbsent, true, "Gateway startup and failed resume must not recreate the missing workspace");
  return {
    sameOrigin: new URL(gateway2.baseUrl).origin === originBefore,
    samePort: gateway2.port === gateway.port,
    sameRunAuth: gateway2.authToken === gatewayAuthToken,
    deviceRefreshAfterRestart: null,
    deviceRefreshEvidence: null,
    deviceRefreshRequiredForMode: false,
    deviceRefreshRequestCountBeforeRestart,
    deviceRefreshRequestCountAfterRestart: (network.httpRequestCounts["POST mobile-session-refresh"] ?? 0) -
      deviceRefreshRequestCountBeforeReload,
    deviceAccessExpiredBeforeRestart,
    gatewayLifecycleEvidence,
    targetIdentityStable: targetAfter.observationTargetIdentity === originalTarget.observationTargetIdentity,
    targetInventoryEvidence: targetAfter.inventoryEvidence,
    parentWorkspaceRemainsConfigured: targetAfter.workspacePath === workspaceParent,
    targetLeafStillAbsent,
    postRestartWorkspaceRpcAttempt,
    startedAt: restartStartedAt,
    rpcCountBeforeReload,
  };
}

async function waitForActiveDeviceProfile(page, baseUrl) {
  return waitFor(async () => {
    const identity = await readActiveProfileIdentity(page).catch(() => null);
    return identity && identity.baseUrl === baseUrl && identity.authMode === "device" ? identity : null;
  }, 20_000, "production Mobile device-auth profile", 50);
}

async function readActiveProfileIdentity(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("kcoder-studio-mobile.gateway-profiles.v2");
    if (typeof raw !== "string") return null;
    const index = JSON.parse(raw);
    const profile = index?.profiles?.find(value => value?.id === index?.activeId);
    if (!profile) return null;
    return {
      profileId: profile.id,
      baseUrl: profile.baseUrl,
      authMode: profile.authMode,
      authorizationGeneration: profile.authorizationGeneration,
      deviceId: profile.deviceId,
      expiresAt: profile.expiresAt,
    };
  });
}

function assertSameProfileIdentity(expected, actual, message) {
  assert.equal(actual.profileId, expected.profileId, `${message}: profileId`);
  assert.equal(actual.baseUrl, expected.baseUrl, `${message}: baseUrl`);
  assert.equal(actual.authMode, "device", `${message}: authMode must remain device`);
  assert.equal(actual.authMode, expected.authMode, `${message}: authMode`);
  assert.equal(actual.authorizationGeneration, expected.authorizationGeneration, `${message}: authorizationGeneration`);
  assert.equal(actual.deviceId, expected.deviceId, `${message}: deviceId`);
  assert.ok(Number.isFinite(actual.expiresAt), `${message}: refreshed profile expiry must remain present`);
}

async function waitForTargetDescriptor(network, expectedWorkspacePath, signal, after = -Infinity, expectedProfile, context, artifactName) {
  const scopeMatches = scope => scope?.authMode === "device" &&
    scope.deviceId === expectedProfile?.deviceId &&
    scope.authorizationGeneration === expectedProfile?.authorizationGeneration &&
    (!scope.profileId || scope.profileId === expectedProfile?.profileId);
  let record;
  try {
    record = await waitFor(() => [...network.serverInventories].reverse().find(item => item.at >= after &&
      item.statusCode === 200 && item.authorized === true && scopeMatches(item.scope)) ?? null,
    20_000, "actual authenticated Gateway v1 bootstrap/refresh or authorized /api/servers inventory for the active device scope", 50, signal);
  } catch (error) {
    const observed = network.serverInventories.filter(item => item.at >= after).map(summarizeInventoryObservation);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; observed inventory evidence=${JSON.stringify(observed)}`);
  }
  const summary = { ...summarizeInventoryObservation(record), scopeMatched: scopeMatches(record.scope) };
  await context.writeArtifactJson(artifactName, summary);
  const localTargets = record.targets.filter(target => target.id === "local");
  assert.equal(localTargets.length, 1,
    `the authenticated inventory must contain exactly one local target; observed ${JSON.stringify(summary)}`);
  const target = localTargets[0];
  assert.equal(target.transport, "local",
    `the inventory target must use local transport; observed ${JSON.stringify(summary)}`);
  assert.equal(target.workspacePath, expectedWorkspacePath,
    `Gateway inventory must retain the exact configured parent workspace; observed ${JSON.stringify(summary)}`);
  assert.match(target.observationTargetIdentity ?? "", /^[a-f0-9]{64}$/,
    `Gateway target identity must be an opaque digest from the actual inventory response; observed ${JSON.stringify(summary)}`);
  return { ...target, inventoryEvidence: summary };
}

function observeMobileNetwork(page, gatewayBaseUrl, gatewayAuthToken) {
  const origin = new URL(gatewayBaseUrl).origin;
  const network = {
    gatewayOrigin: origin,
    serverInventories: [],
    refreshResponses: [],
    cwdObservationRequests: [],
    cwdObservations: [],
    rpc: { socketRouteObservationCount: 0, socketRoutes: [], sockets: [], turnStarts: [], turnCompletions: [], resumeAttempts: [] },
    httpRequestCounts: {},
    httpResponseCounts: {},
    httpRequestFailedCounts: {},
    browserErrors: [],
    activeTask: null,
  };
  page.on("websocket", socket => {
    let url;
    try { url = new URL(socket.url()); } catch {
      network.rpc.socketRouteObservationCount += 1;
      network.rpc.socketRoutes.push({ urlParsed: false });
      if (network.rpc.socketRoutes.length > 64) network.rpc.socketRoutes.shift();
      return;
    }
    const routeObservation = {
      urlParsed: true,
      originMatchesGateway: httpOriginFromUrl(url) === origin,
      rpcPathMatches: url.pathname.endsWith("/rpc"),
      serverIsLocal: url.searchParams.get("server") === "local",
      workspaceParameterPresent: url.searchParams.has("workspace"),
      runtimeChannel: url.searchParams.get("channel") === "runtime",
      queryKeys: [...new Set([...url.searchParams.keys()])].sort().slice(0, 12),
    };
    network.rpc.socketRouteObservationCount += 1;
    network.rpc.socketRoutes.push(routeObservation);
    if (network.rpc.socketRoutes.length > 64) network.rpc.socketRoutes.shift();
    if (!routeObservation.originMatchesGateway || !routeObservation.rpcPathMatches) return;
    const record = {
      attemptObservedAt: Date.now(),
      originMatchesGateway: routeObservation.originMatchesGateway,
      rpcPathMatchesGateway: routeObservation.rpcPathMatches,
      closedAt: null,
      serverId: url.searchParams.get("server"),
      channel: url.searchParams.get("channel"),
      workspace: url.searchParams.get("workspace"),
      routeThreadId: parseTaskRoute(page.url())?.threadId ?? null,
      methods: [],
      requestlessMethods: [],
      requests: new Map(),
      errors: new Set(),
      frameObservations: { sent: createFrameObservation(), received: createFrameObservation() },
    };
    network.rpc.sockets.push(record);
    socket.on("framesent", event => {
      const payload = event?.payload;
      recordFrameObservation(record.frameObservations.sent, event, payload);
      const frame = parseFrame(payload);
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        record.frameObservations.sent.parseFailureCount += 1;
        return;
      }
      recordSafeFrameKeys(record.frameObservations.sent, frame);
      if (typeof frame.method !== "string") {
        record.frameObservations.sent.missingMethodCount += 1;
        return;
      }
      record.methods.push(frame.method);
      if (frame.id === undefined) {
        record.requestlessMethods.push(frame.method);
        return;
      }
      const params = frame.params && typeof frame.params === "object" && !Array.isArray(frame.params) ? frame.params : {};
      const request = { method: frame.method, threadId: params.threadId ?? null, at: Date.now(), responseReceived: false, responseError: null };
      record.requests.set(String(frame.id), request);
      if (frame.method === "turn/start") {
        const turn = {
          threadId: request.threadId,
          serverId: record.serverId,
          channel: record.channel,
          workspace: record.workspace,
          at: request.at,
          hasRequestId: true,
          paramsKeys: Object.keys(params),
          inputShape: summarizeTurnInput(params.input, network.activeTask?.marker),
          socket: record,
        };
        network.rpc.turnStarts.push(turn);
      }
      if (frame.method === "thread/resume" || frame.method === "initialize") {
        const attempt = { method: frame.method, threadId: request.threadId, routeThreadId: record.routeThreadId,
          serverId: record.serverId, channel: record.channel, workspace: record.workspace, at: request.at,
          errorResponse: false, closed: false, socket: record };
        request.resumeAttempt = attempt;
        network.rpc.resumeAttempts.push(attempt);
      }
    });
    socket.on("framereceived", event => {
      const payload = event?.payload;
      recordFrameObservation(record.frameObservations.received, event, payload);
      const frame = parseFrame(payload);
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        record.frameObservations.received.parseFailureCount += 1;
        return;
      }
      recordSafeFrameKeys(record.frameObservations.received, frame);
      if (frame.id !== undefined) {
        const request = record.requests.get(String(frame.id));
        if (request) {
          request.responseReceived = true;
          request.responseError = Boolean(frame.error);
        }
        if (request?.resumeAttempt && frame.error) request.resumeAttempt.errorResponse = true;
      }
      if (frame.method === "turn/completed") network.rpc.turnCompletions.push({
        threadId: frame.params?.threadId ?? frame.params?.turn?.threadId ?? null,
        serverId: record.serverId,
        channel: record.channel,
        workspace: record.workspace,
        status: frame.params?.turn?.status ?? frame.params?.status ?? null,
        at: Date.now(),
      });
    });
    socket.on("close", () => {
      record.closedAt = Date.now();
      for (const attempt of network.rpc.resumeAttempts) if (attempt.socket === record) attempt.closed = true;
    });
    socket.on("socketerror", () => {
      record.errors.add("socketerror");
      for (const attempt of network.rpc.resumeAttempts) if (attempt.socket === record) attempt.closed = true;
    });
  });
  page.on("request", request => {
    const url = safeUrl(request.url());
    if (!url || url.origin !== origin) return;
    recordHttpCount(network.httpRequestCounts, request.method(), classifyEndpoint(url.pathname));
    if (/^\/api\/servers\/[^/]+\/cwd-observation$/.test(url.pathname)) {
      network.cwdObservationRequests.push({
        method: request.method(),
        at: Date.now(),
        targetId: url.pathname.match(/^\/api\/servers\/([^/]+)\/cwd-observation$/)?.[1] ?? null,
        workspacePath: url.searchParams.get("workspace"),
        expectedTargetIdentity: url.searchParams.get("expectedTargetIdentity"),
      });
    }
  });
  page.on("requestfailed", request => {
    const url = safeUrl(request.url());
    if (!url || url.origin !== origin) return;
    const endpoint = classifyEndpoint(url.pathname);
    recordHttpCount(network.httpRequestFailedCounts, request.method(), endpoint, "failed");
    if (endpoint === "cwd-observation") network.browserErrors.push({ kind: "cwd-observation-request-failed", at: Date.now() });
  });
  page.on("response", response => {
    void (async () => {
      const url = safeUrl(response.url());
      if (!url || url.origin !== origin) return;
      const statusCode = response.status();
      const request = response.request();
      const method = request.method();
      recordHttpCount(network.httpResponseCounts, method, classifyEndpoint(url.pathname), String(statusCode));
      const receivedAt = Date.now();
      if (url.pathname === "/api/mobile/session/refresh" && method === "POST") {
        const requestPayload = parseRequestJson(request);
        const body = await response.json().catch(() => null);
        const inventory = body?.initialServers;
        const requestBound = typeof requestPayload?.refreshToken === "string" && requestPayload.refreshToken.length >= 32 &&
          typeof requestPayload?.deviceId === "string" && requestPayload.deviceId === body?.deviceId;
        const v1 = body?.capabilities?.mobileInitialServersV1 === true && inventory?.version === 1;
        network.refreshResponses.push({
          statusCode,
          at: receivedAt,
          deviceId: typeof body?.deviceId === "string" ? body.deviceId : null,
          authorizationGeneration: typeof body?.authorizationGeneration === "string" ? body.authorizationGeneration : null,
          requestDeviceIdMatchesResponse: typeof requestPayload?.deviceId === "string" && requestPayload.deviceId === body?.deviceId,
          requestHasRefreshCredential: typeof requestPayload?.refreshToken === "string" && requestPayload.refreshToken.length >= 32,
        });
        network.serverInventories.push({
          source: "mobile-session-refresh",
          method,
        path: url.pathname,
          statusCode,
          at: receivedAt,
          inventoryVersion: Number.isSafeInteger(inventory?.version) ? inventory.version : null,
          mobileInitialServersV1: body?.capabilities?.mobileInitialServersV1 === true,
          authenticated: requestBound,
          authorized: statusCode === 200 && requestBound && body?.capabilities?.mobileRefreshV1 === true && v1,
          scope: body && typeof body.deviceId === "string" && typeof body.authorizationGeneration === "string"
            ? { authMode: "device", deviceId: body.deviceId, authorizationGeneration: body.authorizationGeneration, profileId: null }
            : null,
          targets: summarizeInventoryTargets(inventory?.servers),
        });
        return;
      }
      if (url.pathname === "/api/servers") {
        const body = await response.json().catch(() => null);
        const profile = await readActiveProfileIdentity(page).catch(() => null);
        const headers = request.headers();
        const authorization = headers.authorization ?? headers.Authorization;
        network.serverInventories.push({
          source: "api-servers",
          method,
          path: url.pathname,
          statusCode,
          at: receivedAt,
          inventoryVersion: null,
          mobileInitialServersV1: false,
          authenticated: typeof authorization === "string" && /^Bearer\s+\S+$/i.test(authorization),
          authorized: method === "GET" && statusCode === 200 && typeof authorization === "string" && /^Bearer\s+\S+$/i.test(authorization),
          scope: profile ? {
            profileId: profile.profileId,
            authMode: profile.authMode,
            authorizationGeneration: profile.authorizationGeneration,
            deviceId: profile.deviceId,
          } : null,
          targets: summarizeInventoryTargets(body?.servers),
        });
        return;
      }
      if (url.pathname === "/api/mobile/session" && method === "POST") {
        const requestPayload = parseRequestJson(request);
        const body = await response.json().catch(() => null);
        const inventory = body?.initialServers;
        const scope = body && typeof body.deviceId === "string" && typeof body.authorizationGeneration === "string"
          ? { authMode: body.capabilities?.mobileRefreshV1 === true ? "device" : "legacy",
              deviceId: body.deviceId, authorizationGeneration: body.authorizationGeneration, profileId: null }
          : null;
        const authenticatedPair = requestPayload?.token === gatewayAuthToken && requestPayload?.requestInitialServers === true;
        const v1 = body?.capabilities?.mobileInitialServersV1 === true && inventory?.version === 1;
        network.serverInventories.push({
          source: "mobile-session-bootstrap",
          method,
          path: url.pathname,
          statusCode,
          at: receivedAt,
          inventoryVersion: Number.isSafeInteger(inventory?.version) ? inventory.version : null,
          mobileInitialServersV1: body?.capabilities?.mobileInitialServersV1 === true,
          authenticated: authenticatedPair,
          authorized: statusCode === 200 && authenticatedPair && body?.capabilities?.mobileRefreshV1 === true && v1,
          scope,
          targets: summarizeInventoryTargets(inventory?.servers),
        });
        return;
      }
      if (/^\/api\/servers\/local\/cwd-observation$/.test(url.pathname)) {
        const body = await response.json().catch(() => null);
        network.cwdObservations.push({ method, statusCode, at: Date.now(),
          workspacePath: url.searchParams.get("workspace"),
          expectedTargetIdentity: url.searchParams.get("expectedTargetIdentity"), value: body });
      }
    })().catch(() => {});
  });
  page.on("pageerror", error => network.browserErrors.push({ kind: "pageerror", message: String(error.message).slice(0, 300) }));
  return network;
}

function parseRequestJson(request) {
  try {
    const payload = request.postDataJSON();
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch { return null; }
}

function summarizeInventoryTargets(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && typeof item === "object" && !Array.isArray(item)).map(item => ({
    id: typeof item.id === "string" ? item.id : null,
    transport: typeof item.transport === "string" ? item.transport : null,
    workspacePath: typeof item.workspacePath === "string" ? item.workspacePath : null,
    observationTargetIdentity: typeof item.observationTargetIdentity === "string" ? item.observationTargetIdentity : null,
  }));
}

function profileScopeFingerprint(profile) {
  if (typeof profile?.deviceId !== "string" || typeof profile?.authorizationGeneration !== "string") return null;
  return createHash("sha256").update(`${profile.deviceId}\0${profile.authorizationGeneration}`).digest("hex");
}

function inventoryScopeFingerprint(scope) {
  if (typeof scope?.deviceId !== "string" || typeof scope?.authorizationGeneration !== "string") return null;
  return createHash("sha256").update(`${scope.deviceId}\0${scope.authorizationGeneration}`).digest("hex");
}

function summarizeInventoryObservation(item) {
  return {
    claim: inventoryClaim,
    source: item.source,
    method: item.method,
    path: item.path,
    statusCode: item.statusCode,
    at: item.at,
    inventoryVersion: item.inventoryVersion,
    mobileInitialServersV1: item.mobileInitialServersV1,
    version1InitialServersObserved: item.inventoryVersion === 1 && item.mobileInitialServersV1 === true,
    authenticated: item.authenticated,
    authorized: item.authorized,
    scopeFingerprint: inventoryScopeFingerprint(item.scope),
    targets: item.targets,
  };
}

function summarizeRefreshObservation(item) {
  return {
    source: "mobile-session-refresh",
    method: "POST",
    path: "/api/mobile/session/refresh",
    statusCode: item.statusCode,
    at: item.at,
    requestDeviceIdMatchesResponse: item.requestDeviceIdMatchesResponse,
    requestHasRefreshCredential: item.requestHasRefreshCredential,
    scopeFingerprint: profileScopeFingerprint(item),
  };
}

function summarizeRefreshEvidence(refresh, originalProfile, refreshedProfile) {
  return {
    source: "mobile-session-refresh",
    method: "POST",
    path: "/api/mobile/session/refresh",
    statusCode: refresh.statusCode,
    at: refresh.at,
    sameDeviceAuthorization: refresh.deviceId === originalProfile.deviceId &&
      refresh.authorizationGeneration === originalProfile.authorizationGeneration &&
      refresh.requestDeviceIdMatchesResponse && refresh.requestHasRefreshCredential,
    scopeFingerprint: profileScopeFingerprint(originalProfile),
    expiryAdvanced: refreshedProfile.expiresAt > originalProfile.expiresAt && refreshedProfile.expiresAt > Date.now(),
  };
}

function parseTaskRoute(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.replace(/^\/mobile(?=\/|$)/, "").split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== "h" || segments[2] !== "task" || !segments[1] || !segments[3] || !segments[4]) return null;
    return { profileId: segments[1], serverId: segments[3], threadId: segments[4], cwd: url.searchParams.get("cwd") };
  } catch { return null; }
}

async function createFailureDiagnostic(page, network, { label, cwd, marker, route, startedAt, progress, failureStage }) {
  const expectedThreadId = route?.threadId ?? null;
  const safeRoute = route ? {
    recognized: true,
    profileIdPresent: Boolean(route.profileId),
    localServer: route.serverId === "local",
    threadIdPresent: Boolean(route.threadId),
    workspaceMatchesRequested: route.cwd === cwd,
  } : { recognized: false };
  return {
    version: 1,
    label,
    failureStage,
    progress,
    route: safeRoute,
    visibleUi: await captureVisibleUiDiagnostic(page, marker, cwd),
    rpc: summarizeRpcDiagnostic(network, { cwd, marker, expectedThreadId, startedAt }),
    inventory: summarizeInventoryDiagnostic(network, cwd),
    privacy: { messageBodiesRecorded: false, credentialsRecorded: false, rawUrlsRecorded: false },
  };
}

async function createWorkspaceAbsenceFailureDiagnostic(context, page, network, {
  failureStage, cwd, expectedThreadId, expectedMarker, expectedTargetIdentity, restartStartedAt,
  cacheSnapshot, cachePersistenceBarriers, workspaceFormDiagnostic, error,
}) {
  const activeProfile = await readActiveProfileIdentity(page).catch(() => null);
  const observations = network.cwdObservations.slice(-8).map(item => ({
    method: item.method === "GET" ? "GET" : "other",
    statusCode: Number.isSafeInteger(item.statusCode) ? item.statusCode : null,
    afterRestart: Number.isFinite(restartStartedAt) && Number.isFinite(item.at) && item.at >= restartStartedAt,
    requestWorkspaceMatchesExpected: item.workspacePath === cwd,
    requestTargetIdentityMatchesExpected: item.expectedTargetIdentity === expectedTargetIdentity,
    responseAuthorized: item.value?.authorized === true,
    responseTargetIsLocal: item.value?.targetId === "local",
    responseWorkspaceMatchesExpected: item.value?.workspacePath === cwd,
    responseTargetSignatureMatchesExpected: item.value?.targetSignature === expectedTargetIdentity,
    responseVersion: Number.isSafeInteger(item.value?.version) ? item.value.version : null,
    responseStatus: ["present", "absent", "unknown"].includes(item.value?.status) ? item.value.status : "other-or-missing",
    responseHasNoReason: item.value?.reason === undefined,
    loginGenerationValid: Number.isSafeInteger(item.value?.loginGeneration) && item.value.loginGeneration >= 0,
    observedAtValid: typeof item.value?.observedAt === "number" && Number.isFinite(item.value.observedAt) && item.value.observedAt >= 0,
  }));
  const message = error instanceof Error ? context.redactText(error.message).slice(0, 700) : "unknown failure";
  return {
    version: 1,
    failureStage,
    failure: { name: error instanceof Error ? error.name : "unknown", message },
    activeDeviceProfile: {
      present: Boolean(activeProfile),
      deviceAuth: activeProfile?.authMode === "device",
      baseUrlMatchesGateway: safeUrl(activeProfile?.baseUrl)?.origin === network.gatewayOrigin,
      authorizationGenerationPresent: typeof activeProfile?.authorizationGeneration === "string",
      deviceIdPresent: typeof activeProfile?.deviceId === "string",
    },
    visibleUi: await captureVisibleUiDiagnostic(page, expectedMarker, cwd),
    rpc: summarizeRpcDiagnostic(network, { cwd, marker: expectedMarker, expectedThreadId, startedAt: restartStartedAt }),
    cacheSnapshot: cacheSnapshot ?? null,
    cachePersistenceBarriers,
    workspaceEntryForm: workspaceFormDiagnostic ?? null,
    http: {
      requestCounts: network.httpRequestCounts,
      responseCounts: network.httpResponseCounts,
      requestFailedCounts: network.httpRequestFailedCounts,
      inventory: summarizeInventoryDiagnostic(network, cwd),
      cwdObservationRequestCount: network.cwdObservationRequests.length,
      cwdObservationRequests: network.cwdObservationRequests.slice(-8).map(item => ({
        method: item.method === "GET" ? "GET" : "other",
        afterRestart: Number.isFinite(restartStartedAt) && item.at >= restartStartedAt,
        targetIsLocal: item.targetId === "local",
        workspaceMatchesExpected: item.workspacePath === cwd,
        targetIdentityMatchesExpected: item.expectedTargetIdentity === expectedTargetIdentity,
      })),
      cwdObservationCount: network.cwdObservations.length,
      cwdObservations: observations,
    },
    privacy: { messageBodiesRecorded: false, credentialsRecorded: false, rawUrlsRecorded: false },
  };
}

async function captureWorkspaceEntryDiagnostic(page, {
  profileId, serverId, workspaceParent, targetLeaf, formReadiness,
  diagnosticPrompt, unsentPromptEntered, createButtonClicked,
}) {
  const workspaceField = page.getByTestId("workspace-path");
  const workspaceValue = await workspaceField.inputValue().catch(() => null);
  const promptValue = await page.getByTestId("new-workspace-prompt").inputValue().catch(() => null);
  const projectsLoadingCount = await page.getByTestId("new-workspace-projects-loading").count();
  const modelSelectorEnabled = await page.getByTestId("model-selector").isEnabled().catch(() => false);
  const createButton = page.getByTestId("create-workspace");
  const createButtonVisible = await createButton.isVisible().catch(() => false);
  const liveCreateButtonEnabled = await page.getByTestId("create-workspace").isEnabled().catch(() => false);
  const handoffErrorVisible = await page.getByTestId("workspace-task-handoff-error").isVisible().catch(() => false);
  const preference = await page.evaluate(({ activeProfileId, activeServerId, parentPath, deletedPath }) => {
    const prefix = `kcoder-studio:mobile-new-workspace:v1:${encodeURIComponent(activeProfileId)}:${encodeURIComponent(activeServerId)}:scope:v2:`;
    let scopedKeyCount = 0;
    let scopeSuffixPresent = false;
    let preferenceValuePresent = false;
    let preferenceValueParseable = false;
    let pathMatchesParent = false;
    let pathMatchesDeletedLeaf = false;
    let pathMatchesOther = false;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (typeof key !== "string" || !key.startsWith(prefix)) continue;
      scopedKeyCount += 1;
      if (key.slice(prefix.length).length > 0) scopeSuffixPresent = true;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      preferenceValuePresent = true;
      let value;
      try { value = JSON.parse(raw); } catch { continue; }
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.cwd !== "string") continue;
      preferenceValueParseable = true;
      if (value.cwd === parentPath) pathMatchesParent = true;
      else if (value.cwd === deletedPath) pathMatchesDeletedLeaf = true;
      else pathMatchesOther = true;
    }
    return {
      scopedKeyPresent: scopedKeyCount > 0,
      scopedKeyUnique: scopedKeyCount === 1,
      scopeSuffixPresent,
      preferenceValuePresent,
      preferenceValueParseable,
      pathMatchesParent,
      pathMatchesDeletedLeaf,
      pathMatchesOther,
    };
  }, { activeProfileId: profileId, activeServerId: serverId, parentPath: workspaceParent, deletedPath: targetLeaf }).catch(() => null);
  const safeReadiness = formReadiness ? {
    fieldEditable: formReadiness.fieldEditable,
    projectsLoadingCount: formReadiness.projectsLoadingCount,
    modelSelectorEnabled: formReadiness.modelSelectorEnabled,
  } : null;
  return {
    formReadiness: safeReadiness,
    unsentPrompt: {
      unsentPromptEntered,
      promptNonempty: typeof promptValue === "string" && promptValue.trim().length > 0,
      promptMatchesDiagnostic: typeof promptValue === "string" && promptValue === diagnosticPrompt,
    },
    createState: {
      createButtonVisible,
      createButtonEnabled: liveCreateButtonEnabled,
      createButtonClicked,
      handoffErrorVisible,
      fieldEditable: await workspaceField.isEditable().catch(() => false),
      projectsLoadingCount,
      modelSelectorEnabled,
    },
    fieldMatchesParent: workspaceValue === workspaceParent,
    fieldMatchesDeletedLeaf: workspaceValue === targetLeaf,
    fieldEmpty: workspaceValue === "",
    fieldAvailable: typeof workspaceValue === "string",
    fieldMatchesOther: typeof workspaceValue === "string" && workspaceValue !== workspaceParent &&
      workspaceValue !== targetLeaf && workspaceValue.length > 0,
    profileServerPreference: preference,
  };
}

async function captureVisibleUiDiagnostic(page, marker, expectedWorkspacePath = null) {
  if (page.isClosed()) return { pageClosed: true };
  const testIds = [
    "new-workspace",
    "server-option-local",
    "workspace-path",
    "new-workspace-prompt",
    "create-workspace",
    "workspace-task-handoff-error",
    "message-user",
    "message-input-root",
    "send-message",
    "task-error",
    "error-banner",
    "home-confirmed-workspace-absence-notice",
  ];
  try {
    return await page.evaluate(({ expectedMarker, expectedPath, ids }) => {
      const isVisible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const counts = Object.fromEntries(ids.map(id => [id,
        [...document.querySelectorAll(`[data-testid="${id}"]`)].filter(isVisible).length]));
      const userMessages = [...document.querySelectorAll('[data-testid="message-user"]')].filter(isVisible);
      const workspaceField = document.querySelector('[data-testid="workspace-path"]');
      return {
        pageClosed: false,
        route: {
          mobilePath: location.pathname.startsWith("/mobile/"),
          taskRouteShape: /\/h\/[^/]+\/task\/[^/]+\/[^/]+$/.test(location.pathname),
          hasWorkspaceQuery: new URL(location.href).searchParams.has("cwd"),
        },
        visibleTestIdCounts: counts,
        workspacePathFieldMatchesExpected: typeof expectedPath === "string" &&
          workspaceField !== null && "value" in workspaceField && workspaceField.value === expectedPath,
        expectedMarkerVisibleInUserMessage: typeof expectedMarker === "string" && userMessages.some(element =>
          typeof element.textContent === "string" && element.textContent.includes(expectedMarker)),
      };
    }, { expectedMarker: marker, expectedPath: expectedWorkspacePath, ids: testIds });
  } catch {
    return { pageClosed: false, captureFailed: true };
  }
}

function summarizeRpcDiagnostic(network, { cwd, marker, expectedThreadId, startedAt }) {
  const sockets = network.rpc.sockets.map((socket, index) => {
    const methodCounts = countStrings(socket.methods.map(safeRpcMethodName));
    const requestlessMethodCounts = countStrings(socket.requestlessMethods.map(safeRpcMethodName));
    const responsesByMethod = {};
    for (const request of socket.requests.values()) {
      const method = safeRpcMethodName(request.method);
      const row = responsesByMethod[method] ??= { requests: 0, responses: 0, errors: 0 };
      row.requests += 1;
      if (request.responseReceived) row.responses += 1;
      if (request.responseError) row.errors += 1;
    }
    return {
      index,
      webSocketAttemptObserved: socket.attemptObservedAt !== null,
      attemptAfterRestart: Number.isFinite(startedAt) && socket.attemptObservedAt >= startedAt,
      sameGatewayOrigin: socket.originMatchesGateway,
      rpcPathMatches: socket.rpcPathMatchesGateway,
      closed: socket.closedAt !== null,
      serverIsLocal: socket.serverId === "local",
      workspaceParameterPresent: typeof socket.workspace === "string" && socket.workspace.length > 0,
      workspaceMatchesRequested: socket.workspace === cwd,
      routeThreadPresentAtAttempt: Boolean(socket.routeThreadId),
      routeThreadMatchesExpected: expectedThreadId !== null && socket.routeThreadId === expectedThreadId,
      methodCounts,
      requestlessMethodCounts,
      responsesByMethod,
      frameObservations: {
        sent: summarizeFrameObservation(socket.frameObservations.sent),
        received: summarizeFrameObservation(socket.frameObservations.received),
      },
      errorsObserved: socket.errors.size,
    };
  });
  return {
    socketRouteObservationCount: network.rpc.socketRouteObservationCount,
    socketRouteObservationRetainedCount: network.rpc.socketRoutes.length,
    socketRoutes: network.rpc.socketRoutes.slice(-16),
    rpcSocketCount: sockets.length,
    sockets,
    turnStartCount: network.rpc.turnStarts.length,
    turnStarts: network.rpc.turnStarts.slice(-12).map(turn => ({
      threadIdMatchesExpected: expectedThreadId !== null && turn.threadId === expectedThreadId,
      serverIsLocal: turn.serverId === "local",
      runtimeChannel: turn.channel === "runtime",
      workspaceMatchesRequested: turn.workspace === cwd,
      afterActionStartedAt: startedAt !== null && turn.at >= startedAt,
      hasRequestId: turn.hasRequestId,
      paramsKeys: summarizeKnownKeys(turn.paramsKeys, [
        "threadId", "clientMessageId", "input", "turnMode", "model", "reasoningEffort", "permissionMode", "attachments",
      ]),
      inputShape: turn.inputShape,
    })),
    turnCompletionCount: network.rpc.turnCompletions.length,
    turnCompletions: network.rpc.turnCompletions.slice(-12).map(turn => ({
      threadIdMatchesExpected: expectedThreadId !== null && turn.threadId === expectedThreadId,
      serverIsLocal: turn.serverId === "local",
      runtimeChannel: turn.channel === "runtime",
      workspaceMatchesRequested: turn.workspace === cwd,
      status: ["completed", "failed", "cancelled", "interrupted"].includes(turn.status) ? turn.status : "other-or-missing",
      afterActionStartedAt: startedAt !== null && turn.at >= startedAt,
    })),
    resumeAttemptCount: network.rpc.resumeAttempts.length,
    browserErrorKinds: countStrings(network.browserErrors.map(error => error.kind)),
    httpRequestCounts: network.httpRequestCounts,
    httpResponseCounts: network.httpResponseCounts,
    httpRequestFailedCounts: network.httpRequestFailedCounts,
  };
}

function summarizeWorkspaceRpcAttempt(socket, { cwd, expectedThreadId }) {
  return {
    observed: Number.isFinite(socket.attemptObservedAt),
    sameGatewayOrigin: socket.originMatchesGateway === true,
    rpcPathMatches: socket.rpcPathMatchesGateway === true,
    serverIsLocal: socket.serverId === "local",
    runtimeChannel: socket.channel === "runtime",
    workspaceMatchesDeletedLeaf: socket.workspace === cwd,
    routeThreadMatchesExpected: expectedThreadId !== null && socket.routeThreadId === expectedThreadId,
    sentFrameCount: socket.frameObservations.sent.eventCount,
    receivedFrameCount: socket.frameObservations.received.eventCount,
    closeObserved: socket.closedAt !== null,
    socketErrorObserved: socket.errors.has("socketerror"),
  };
}

function summarizeInventoryDiagnostic(network, cwd) {
  return {
    inventoryCount: network.serverInventories.length,
    inventories: network.serverInventories.slice(-8).map(item => ({
      source: item.source,
      method: item.method,
      statusCode: Number.isSafeInteger(item.statusCode) ? item.statusCode : null,
      authorized: item.authorized === true,
      mobileInitialServersV1: item.mobileInitialServersV1 === true,
      targetCount: Array.isArray(item.targets) ? item.targets.length : 0,
      expectedLocalTargetPresent: Array.isArray(item.targets) && item.targets.some(target =>
        target.id === "local" && target.workspacePath === cwd),
    })),
    refreshCount: network.refreshResponses.length,
    refreshStatuses: network.refreshResponses.slice(-8).map(response => Number.isSafeInteger(response.statusCode) ? response.statusCode : null),
  };
}

function summarizeFrameObservation(observation) {
  return {
    eventCount: observation.eventCount,
    parseFailureCount: observation.parseFailureCount,
    missingMethodCount: observation.missingMethodCount,
    eventKeyShapeCounts: observation.eventKeyShapeCounts,
    payloadTypeCounts: observation.payloadTypeCounts,
    payloadBytesTotal: observation.payloadBytesTotal,
    frameKeyCounts: observation.frameKeyCounts,
    unknownFrameKeyCount: observation.unknownFrameKeyCount,
  };
}

function createFrameObservation() {
  return {
    eventCount: 0,
    parseFailureCount: 0,
    missingMethodCount: 0,
    eventKeyShapeCounts: {},
    payloadTypeCounts: {},
    payloadBytesTotal: 0,
    frameKeyCounts: {},
    unknownFrameKeyCount: 0,
  };
}

function recordFrameObservation(observation, event, payload) {
  observation.eventCount += 1;
  const eventKeys = event && typeof event === "object" ? Object.keys(event).filter(key => key === "payload").sort() : [];
  const shape = eventKeys.join(",") || "no-known-event-keys";
  observation.eventKeyShapeCounts[shape] = (observation.eventKeyShapeCounts[shape] ?? 0) + 1;
  const payloadType = Buffer.isBuffer(payload) ? "buffer" : payload === null ? "null" : typeof payload;
  observation.payloadTypeCounts[payloadType] = (observation.payloadTypeCounts[payloadType] ?? 0) + 1;
  if (Buffer.isBuffer(payload)) observation.payloadBytesTotal += payload.length;
  else if (typeof payload === "string") observation.payloadBytesTotal += Buffer.byteLength(payload);
}

function recordSafeFrameKeys(observation, frame) {
  const safeKeys = new Set(["id", "method", "params", "result", "error"]);
  for (const key of Object.keys(frame)) {
    if (safeKeys.has(key)) observation.frameKeyCounts[key] = (observation.frameKeyCounts[key] ?? 0) + 1;
    else observation.unknownFrameKeyCount += 1;
  }
}

function summarizeTurnInput(input, marker) {
  if (!Array.isArray(input)) return { kind: input === null ? "null" : typeof input, itemCount: null };
  const safeItemKeys = new Set(["type", "text", "uri", "mimeType", "name", "id"]);
  const safeItemTypes = new Set(["text", "image", "file", "audio", "video", "resource_link", "reference"]);
  const types = {};
  const keys = new Set();
  let unknownKeyCount = 0;
  let unknownTypeCount = 0;
  let textItemCount = 0;
  let expectedMarkerPresent = false;
  for (const item of input) {
    const rawType = item && typeof item === "object" && !Array.isArray(item) && typeof item.type === "string" ? item.type : null;
    const type = rawType && safeItemTypes.has(rawType) ? rawType : "other-or-missing";
    if (rawType && !safeItemTypes.has(rawType)) unknownTypeCount += 1;
    types[type] = (types[type] ?? 0) + 1;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const key of Object.keys(item)) {
        if (safeItemKeys.has(key)) keys.add(key);
        else unknownKeyCount += 1;
      }
      if (typeof item.text === "string") {
        textItemCount += 1;
        if (typeof marker === "string" && marker.length > 0 && item.text.includes(marker)) expectedMarkerPresent = true;
      }
    }
  }
  return { kind: "array", itemCount: input.length, itemTypes: types, itemKeys: [...keys].sort(), unknownItemKeyCount: unknownKeyCount,
    unknownItemTypeCount: unknownTypeCount, textItemCount, expectedMarkerPresent };
}

function summarizeKnownKeys(keys, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const known = [...new Set(keys.filter(key => allowed.has(key)))].sort();
  return { names: known, unknownCount: keys.length - known.length };
}

function countStrings(values) {
  const counts = {};
  for (const value of values) if (typeof value === "string") counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function safeRpcMethodName(method) {
  const allowed = new Set([
    "initialize", "thread/list", "thread/start", "thread/resume", "thread/creation/read", "thread/read", "thread/read/indexed",
    "thread/metadata/update", "thread/delete",
    "turn/start", "turn/started", "turn/completed", "item/started", "item/completed",
    "runtime.workspaces.list", "runtime.workspaces.openV2", "runtime.workspaces.prepareV2", "runtime.worktrees.prepareV2",
  ]);
  return allowed.has(method) ? method : "other";
}

function countWorkspaceTurnStarts(network, cwd) {
  return network.rpc.turnStarts.filter(item => item.serverId === "local" && item.channel === "runtime" && item.workspace === cwd).length;
}

function recordHttpCount(counts, method, endpoint, outcome = null) {
  const normalizedMethod = normalizeHttpMethod(method);
  const key = `${normalizedMethod} ${endpoint}${outcome ? ` ${outcome}` : ""}`;
  counts[key] = (counts[key] ?? 0) + 1;
}

function normalizeHttpMethod(method) {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(method) ? method : "OTHER";
}

function classifyEndpoint(pathname) {
  if (pathname === "/api/mobile/session") return "mobile-session";
  if (pathname === "/api/mobile/session/refresh") return "mobile-session-refresh";
  if (pathname === "/api/servers") return "servers";
  if (/^\/api\/servers\/[^/]+\/cwd-observation$/.test(pathname)) return "cwd-observation";
  if (pathname.endsWith("/rpc")) return "rpc-http";
  if (pathname === "/mobile/" || pathname.startsWith("/mobile/")) return "mobile-static";
  return pathname.startsWith("/api/") ? "api-other" : "same-origin-other";
}

function parseFrame(raw) {
  try { return JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); }
  catch { return null; }
}

function safeUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function httpOriginFromUrl(url) {
  const normalized = new URL(url.href);
  if (normalized.protocol === "ws:") normalized.protocol = "http:";
  else if (normalized.protocol === "wss:") normalized.protocol = "https:";
  return normalized.origin;
}
