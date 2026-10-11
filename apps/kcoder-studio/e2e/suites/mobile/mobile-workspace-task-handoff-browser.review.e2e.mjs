import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { reuseMobileWebExport } from "../../harness/mobile-web-export-reuse.mjs";
import {
  findOwnedExecutableProcesses,
  hashExecutableFile,
} from "../../harness/owned-executable-provenance.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const SERVER_ID = "local";
const SERVER_LABEL = "Durable handoff fixture";
const ASSISTANT_REPLY = "HANDOFF_E2E_ASSISTANT_RESPONSE";
const WORKSPACE_STATE_PREFIX = "kcoder-studio:mobile-workspace-state:v3:";
const REQUIRED_CAPABILITIES = [
  "workspaceOperationReceiptsV2",
  "threadCreationReceiptsV1",
  "turnReceiptsV1",
];
// Exact Gateway-side JavaScript execution chain exercised by this handoff suite.
// Rust behavior is pinned separately by the app-server binary SHA and negotiated capabilities.
const HANDOFF_GATEWAY_SOURCE_PATHS = [
  "apps/kcoder-studio/dev-server.mjs",
  "apps/kcoder-studio/src/workspace-app-server-broker.js",
  "apps/kcoder-studio/src/retention-context.js",
  "apps/kcoder-studio/src/mobile-device-auth.js",
  "apps/kcoder-studio/src/mobile-device-private-storage.js",
  "apps/kcoder-studio/src/server-config.js",
  "apps/kcoder-studio/src/runtime-target-adapter.js",
  "apps/kcoder-studio/src/gateway-channel.js",
  "apps/kcoder-studio/src/request-load.js",
  "apps/kcoder-studio/src/broker-request-budget.js",
  "apps/kcoder-studio/src/workspace-broker-release.js",
];
const CASE_TIMEOUT_MS = 75_000;

await runE2E(import.meta.url, {
  testId: "mobile-workspace-task-handoff-browser-review",
  tier: "full-integration",
  modelPolicy: "actual Mobile Web and Gateway/app-server protocol with a loopback deterministic provider; no real Provider or model-quality claim",
  retainSuccessLogs: true,
  processSignalTimeoutMs: 5_000,
}, async context => {
  const requestedCaseFilter = process.env.KCODER_E2E_HANDOFF_CASE;
  const supportedCaseFilter = "worktree_link_ack_loss_reload";
  const invalidCaseFilter = requestedCaseFilter !== undefined && requestedCaseFilter !== supportedCaseFilter;
  await context.writeArtifactJson("case-selection-preflight.json", {
    status: invalidCaseFilter ? "FAIL" : "PASS",
    mode: requestedCaseFilter === undefined ? "all-cases" : "single-case",
    filterPresent: requestedCaseFilter !== undefined,
    filterAccepted: !invalidCaseFilter,
    supportedSingleCase: supportedCaseFilter,
    expectedCaseCount: requestedCaseFilter === undefined ? 6 : invalidCaseFilter ? 0 : 1,
    modelPolicy: "loopback deterministic provider only; no real Provider or model-quality claim",
  });
  assert.equal(invalidCaseFilter, false,
    "KCODER_E2E_HANDOFF_CASE only accepts worktree_link_ack_loss_reload; omit it to run all six cases");
  const deferredFixture = await verifyDeferredStorageFixtureContract();
  await context.writeArtifactJson("deferred-storage-fixture-contract.json", deferredFixture);

  const pins = readRequiredPins();
  const missingPins = Object.entries(pins)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  await context.writeArtifactJson("prerequisite-preflight.json", {
    status: missingPins.length ? "NOT_RUN" : "READY_FOR_RUNTIME_PREFLIGHT",
    missingPinNames: missingPins,
    requiredCapabilities: REQUIRED_CAPABILITIES,
    capabilityResult: "NOT_YET_OBSERVED",
  });
  assert.equal(
    missingPins.length,
    0,
    `UNMET_PREREQUISITE: missing pinned input(s): ${missingPins.join(", ")}`,
  );

  const binary = await hashExecutableFile(pins.kcoderBinary);
  assert.equal(binary.sha256, pins.kcoderSha256, "configured app-server binary must match its explicit immutable SHA-256 pin");
  const gatewaySourcesBefore = await hashGatewaySources();
  assert.equal(
    gatewaySourcesBefore.aggregateSha256,
    pins.gatewaySourceSetSha256,
    "the 11-file Gateway source set must match its explicit immutable SHA-256 pin",
  );
  await context.writeArtifactJson("gateway-source-preflight.json", {
    status: "PASS",
    sourceCount: gatewaySourcesBefore.files.length,
    expectedAggregateSha256: pins.gatewaySourceSetSha256,
    aggregateSha256: gatewaySourcesBefore.aggregateSha256,
    files: gatewaySourcesBefore.files,
    appServerBinarySha256: binary.sha256,
    requiredAppServerCapabilities: REQUIRED_CAPABILITIES,
    capabilityResult: "NOT_YET_OBSERVED",
    coverageBoundary: "the named 11 Gateway JavaScript inputs only; Rust is pinned by executable SHA and negotiated capabilities, and this does not claim a complete transitive dependency-tree digest",
  });
  const expectedBundleFileCount = await readPinnedBundleFileCount(pins);
  const mobileWeb = await reuseMobileWebExport(context, {
    bundleRoot: pins.webBundleRoot,
    manifestPath: pins.webManifestPath,
    expectedSourceTreeSha256: pins.webSourceTreeSha256,
    expectedManifestSha256: pins.webManifestSha256,
    expectedBundleSha256: pins.webBundleSha256,
    expectedBundleFileCount,
    label: "handoff-final-mobile-web",
    outputName: "handoff-final-mobile-web-owned",
  });
  assert.equal(mobileWeb.bundleFileCount, expectedBundleFileCount, "the mounted UI must use every file in the pinned public Mobile Web manifest");

  await materializeWorkspace(context, "git-history", { instanceId: "handoff-worktree-source" });
  const workspaces = {
    openAck: (await materializeWorkspace(context, "git-history", { instanceId: "handoff-open-ack" })).path,
    threadAck: (await materializeWorkspace(context, "git-history", { instanceId: "handoff-thread-ack" })).path,
    turnAck: (await materializeWorkspace(context, "git-history", { instanceId: "handoff-turn-ack" })).path,
    preferences: (await materializeWorkspace(context, "git-history", { instanceId: "handoff-preferences" })).path,
    existing: (await materializeWorkspace(context, "git-history", { instanceId: "handoff-existing-thread" })).path,
  };
  await mkdir(context.pathInState("private-config"), { recursive: true, mode: 0o700 });
  const configDir = context.pathInState("private-config");

  const model = await startApprovalModelFixture(context, {
    textOnly: true,
    textOnlyResponse: ASSISTANT_REPLY,
  });
  const providerKey = "handoff-loopback-provider-key";
  context.registerSecret(providerKey);
  const settingsFile = await context.writeStateJson("provider-settings.json", {
    active_provider: "handoff-loopback",
    permission_mode: "yolo",
    hooks: {},
    providers: {
      "handoff-loopback": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "handoff-loopback-model",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 8_192,
        request_timeout_secs: 45,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("private-config/settings.json", {});
  await context.writeStateJson("private-config/credentials.json", {
    "handoff-loopback": { type: "api", key: providerKey },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: SERVER_ID,
    label: SERVER_LABEL,
    runtime: "kcoder",
    transport: "local",
    command: binary.path,
    workspacePath: workspaces.existing,
    settingsFile,
  }]);

  const gatewayLabel = "handoff-review-gateway";
  const gateway = await startGateway(context, {
    auth: true,
    label: gatewayLabel,
    workspace: workspaces.existing,
    serversFile,
    kcoderBin: binary.path,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_WEB_ROOT: mobileWeb.path,
    },
  });
  const chromium = await startChromium(context, { label: "handoff-review-chromium" });
  const gatewayOwner = context.processes.get(gatewayLabel);
  assert.ok(gatewayOwner?.pid === gateway.child.pid && gatewayOwner.pgid > 0, "Gateway must be owned by this RunContext process group");

  let capabilityEvidence = null;
  let backendProcessEvidence = null;
  const scenarioResults = [];
  const allScenarios = [
    ["open_ack_loss_same_intent_resume", runOpenAckLoss],
    ["thread_start_ack_loss_original_id", runThreadStartAckLoss],
    ["turn_start_ack_loss_exact_receipt_no_replay", runTurnStartAckLoss],
    ["preferences_deferred_reload", runPreferencesDeferredReload],
    ["worktree_link_ack_loss_reload", runWorktreeLinkAckLoss],
    ["existing_thread_ignores_unrelated_handoff", runExistingThreadIgnoresUnrelatedHandoff],
  ];
  const scenarios = requestedCaseFilter === undefined
    ? allScenarios
    : allScenarios.filter(([name]) => name === requestedCaseFilter);
  assert.equal(scenarios.length, requestedCaseFilter === undefined ? 6 : 1,
    "the selected handoff case set must match its explicit filter");
  await context.writeArtifactJson("case-selection.json", {
    status: "PASS",
    mode: requestedCaseFilter === undefined ? "all-cases" : "single-case",
    selectedCaseNames: scenarios.map(([name]) => name),
    selectedCaseCount: scenarios.length,
    modelPolicy: "loopback deterministic provider only; no real Provider or model-quality claim",
  });

  for (const [name, scenario] of scenarios) {
    const result = await runMountedScenario({
      context,
      chromium,
      gateway,
      name,
      scenario,
      onCapabilities: async capabilities => {
        if (!capabilityEvidence) {
          capabilityEvidence = capabilities;
          const missing = REQUIRED_CAPABILITIES.filter(name => capabilities[name] !== true);
          await context.writeArtifactJson("runtime-capability-preflight.json", {
            status: missing.length ? "NOT_RUN" : "PASS",
            capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, capabilities[name] === true])),
            missing,
          });
          assert.equal(missing.length, 0, `UNMET_PREREQUISITE: fixed app-server does not advertise required durable handoff capability(s): ${missing.join(", ")}`);
          const matches = await waitFor(
            async () => {
              const current = await findOwnedExecutableProcesses({ pgid: gatewayOwner.pgid, executablePath: binary.path });
              return current.length ? current : null;
            },
            20_000,
            "actual app-server executable inside the owned Gateway process group",
            50,
            context.abortSignal,
          );
          assert.ok(matches.some(match => match.sha256 === pins.kcoderSha256), "the running app-server image must match the configured binary SHA-256 pin");
          backendProcessEvidence = matches.map(match => ({ pid: match.pid, executablePath: match.executablePath, sha256: match.sha256 }));
          await context.writeArtifactJson("actual-app-server-provenance.json", {
            configuredPath: binary.path,
            configuredSha256: binary.sha256,
            gatewayPid: gatewayOwner.pid,
            gatewayPgid: gatewayOwner.pgid,
            actualProcesses: backendProcessEvidence,
          });
        } else {
          const missing = REQUIRED_CAPABILITIES.filter(name => capabilities[name] !== true);
          assert.equal(missing.length, 0, `UNMET_PREREQUISITE: a fresh Mobile page did not negotiate required handoff capability(s): ${missing.join(", ")}`);
        }
      },
    });
    scenarioResults.push(result);
    if (result.status === "NOT_RUN") break;
  }

  const gatewaySourcesAfter = await hashGatewaySources();
  await context.writeArtifactJson("gateway-source-postflight.json", {
    status: gatewaySourcesAfter.aggregateSha256 === pins.gatewaySourceSetSha256
      && JSON.stringify(gatewaySourcesAfter) === JSON.stringify(gatewaySourcesBefore) ? "PASS" : "FAIL",
    expectedAggregateSha256: pins.gatewaySourceSetSha256,
    aggregateSha256: gatewaySourcesAfter.aggregateSha256,
    files: gatewaySourcesAfter.files,
  });
  assert.equal(gatewaySourcesAfter.aggregateSha256, pins.gatewaySourceSetSha256,
    "the Gateway source set must still match its immutable pre-run pin");
  assert.deepEqual(gatewaySourcesAfter, gatewaySourcesBefore, "Gateway source files must not change during the mounted UI run");
  await context.writeArtifactJson("mobile-workspace-task-handoff-browser-review.json", {
    status: scenarioResults.length === scenarios.length && scenarioResults.every(result => result.status === "PASS") ? "PASS" : "FAIL_OR_NOT_RUN",
    mobileWeb: {
      sourceTreeSha256: mobileWeb.sourceTreeSha256,
      bundleSha256: mobileWeb.bundleSha256,
      manifestSha256: mobileWeb.sourceManifestSha256,
      bundleFileCount: mobileWeb.bundleFileCount,
      expectedBundleFileCount,
    },
    binary: { sha256: binary.sha256, size: binary.size },
    gatewaySourcesBefore,
    gatewaySourcesAfter,
    capabilityEvidence,
    backendProcessEvidence,
    scenarioResults,
  });
  const failures = scenarioResults.filter(result => result.status !== "PASS");
  assert.equal(failures.length, 0, `mounted handoff scenario(s) did not pass: ${failures.map(result => `${result.name}:${result.status}`).join(", ")}`);
  assert.equal(scenarioResults.length, scenarios.length, "every selected independent handoff scenario must run");
  return {
    scenarioCount: scenarioResults.length,
    scenarioSelection: requestedCaseFilter === undefined ? "all-cases" : "single-case",
    selectedCaseFilter: requestedCaseFilter === undefined ? null : requestedCaseFilter,
    scenarioNames: scenarioResults.map(result => result.name),
    modelPolicy: "loopback deterministic provider only; no real Provider or model-quality claim",
    capabilityGatePassed: true,
    actualAppServerBinaryMatched: true,
    provider: "loopback deterministic fixture only",
  };
});

async function runMountedScenario({ context, chromium, gateway, name, scenario, onCapabilities }) {
  const browserContext = await chromium.browser.newContext({ viewport: { width: 390, height: 844 } });
  let page;
  let trace;
  let storageHold;
  let result = { name, status: "FAIL" };
  let cleanupError;
  try {
    page = await browserContext.newPage();
    trace = installRpcTrace(page);
    if (name === "preferences_deferred_reload") storageHold = await installDeferredWorkspaceStateHold(page);
    const profileId = await connectMobile(page, gateway);
    const capabilities = await waitFor(
      () => trace.capabilities ?? null,
      30_000,
      "real app-server initialize capability response",
      25,
      context.abortSignal,
    );
    await onCapabilities(capabilities);
    const evidence = await scenario({ context, page, gateway, profileId, trace, storageHold });
    result = { name, status: "PASS", ...evidence, trace: summarizeTrace(trace) };
  } catch (error) {
    result = {
      name,
      status: isUnmetPrerequisite(error) ? "NOT_RUN" : "FAIL",
      error: safeError(context, error),
      trace: trace ? summarizeTrace(trace) : null,
    };
  } finally {
    try {
      storageHold?.release();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await browserContext.close();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError) {
      result = {
        ...result,
        status: "FAIL",
        cleanupError: safeError(context, cleanupError),
      };
    }
  }
  await context.writeArtifactJson(`cases/${name}.json`, result);
  return result;
}

async function runOpenAckLoss({ context, page, gateway, profileId, trace }) {
  const workspace = await workspacePathFor(context, "handoff-open-ack");
  await prepareOpenProjectForm(context, page, gateway, profileId, workspace);
  armResponseDrop(trace, "runtime.workspaces.openV2");
  await clickOpenProject(context, page);
  const lost = await waitForDrop(context, trace, "runtime.workspaces.openV2");
  assert.equal(lost.status, "ready", "the Gateway must have completed the original open before its one ACK is dropped");
  assert.equal(lost.workspacePath, workspace);

  await page.reload({ waitUntil: "domcontentloaded" });
  await prepareOpenProjectForm(context, page, gateway, profileId, workspace);
  await clickOpenProject(context, page);
  await waitForNewWorkspaceForm(context, page, workspace);

  const mutation = only(trace.requests, "runtime.workspaces.openV2");
  const reads = trace.requests.filter(request => request.method === "runtime.workspaces.operation/readV2");
  assert.equal(mutation.length, 1, "recovery must not repeat the open mutation");
  assert.ok(reads.some(request => request.clientRequestId === mutation[0].clientRequestId), "same-intent recovery must read the original operation receipt ID");
  assert.equal(trace.requests.filter(request => request.method === "thread/start").length, 0);
  assert.equal(trace.requests.filter(request => request.method === "turn/start").length, 0);
  return {
    actualOpenAckDroppedAfterReady: true,
    originalOperationIdSha256: hashText(mutation[0].clientRequestId),
    originalOperationReadAfterReload: true,
    sameWorkspaceVisibleInNewForm: true,
  };
}

async function runThreadStartAckLoss({ context, page, gateway, profileId, trace }) {
  const workspace = await workspacePathFor(context, "handoff-thread-ack");
  await openWorkspaceThroughUi(context, page, gateway, profileId, workspace);
  const prompt = "HANDOFF_THREAD_START_ACK_LOSS";
  armResponseDrop(trace, "thread/start");
  await startTask(context, page, prompt);
  const lost = await waitForDrop(context, trace, "thread/start");
  assert.equal(lost.ok, true, "the real app-server must have committed thread/start before the UI ACK is dropped");
  assert.ok(lost.threadId);
  assert.ok(lost.clientRequestId);

  await page.reload({ waitUntil: "domcontentloaded" });
  await clickRecoverOriginal(page);
  await waitForTaskVisible(context, page, prompt, lost.threadId);
  await waitForTurnCompletion(context, trace, lost.threadId);

  const reads = trace.requests.filter(request => request.method === "thread/creation/read");
  assert.ok(reads.some(request => request.clientRequestId === lost.clientRequestId), "reload recovery must query the exact original creation ID");
  assert.equal(trace.requests.filter(request => request.method === "thread/start").length, 1, "thread/start must not be replayed after ACK loss");
  const starts = trace.requests.filter(request => request.method === "turn/start");
  assert.equal(starts.length, 1, "the original initial turn must be sent once after exact thread recovery");
  assert.equal(starts[0].clientMessageId, `${lost.clientRequestId}-initial-turn`);
  return {
    threadIdSha256: hashText(lost.threadId),
    creationRequestIdSha256: hashText(lost.clientRequestId),
    exactCreationReceiptRead: true,
    singleThreadStart: true,
    singleInitialTurn: true,
    promptVisible: true,
    fixtureAssistantVisible: true,
  };
}

async function runTurnStartAckLoss({ context, page, gateway, profileId, trace }) {
  const workspace = await workspacePathFor(context, "handoff-turn-ack");
  await openWorkspaceThroughUi(context, page, gateway, profileId, workspace);
  const prompt = "HANDOFF_TURN_START_ACK_LOSS";
  armResponseDrop(trace, "turn/start");
  await startTask(context, page, prompt);
  const lost = await waitForDrop(context, trace, "turn/start");
  assert.equal(lost.ok, true, "the real app-server must have accepted turn/start before its ACK is dropped");
  assert.ok(lost.threadId && lost.clientMessageId);
  await waitForTurnCompletion(context, trace, lost.threadId);

  await page.reload({ waitUntil: "domcontentloaded" });
  await clickRecoverOriginal(page);
  await waitForTaskVisible(context, page, prompt, lost.threadId);
  const exactReads = trace.requests.filter(request => request.method === "turn/receipt/read"
    && request.threadId === lost.threadId
    && request.clientMessageId === lost.clientMessageId);
  assert.ok(exactReads.length > 0, "reload must read the exact accepted turn receipt");
  const starts = trace.requests.filter(request => request.method === "turn/start");
  assert.equal(starts.length, 1, "accepted turn/start must not be replayed after ACK loss");
  assert.equal(starts[0].clientMessageId, lost.clientMessageId);
  await waitForTurnCompletion(context, trace, lost.threadId);
  return {
    threadIdSha256: hashText(lost.threadId),
    clientMessageIdSha256: hashText(lost.clientMessageId),
    exactTurnReceiptRead: true,
    turnCompletionObservedBeforeReload: true,
    singleTurnStart: true,
    promptVisible: true,
    fixtureAssistantVisible: true,
  };
}

async function runPreferencesDeferredReload({ context, page, gateway, profileId, trace, storageHold }) {
  assert.ok(storageHold, "the test-side exact-key localStorage hold must be installed");
  const workspace = await workspacePathFor(context, "handoff-preferences");
  await openWorkspaceThroughUi(context, page, gateway, profileId, workspace);
  const prompt = "HANDOFF_PREFERENCES_DEFERRED_RELOAD";
  await page.evaluate(() => window.__e2eWorkspaceStateHold.arm());
  await startTask(context, page, prompt);

  await waitFor(
    () => storageHold.key ? storageHold.key : null,
    CASE_TIMEOUT_MS,
    "one held exact v3 workspace-state AsyncStorage write",
    25,
    context.abortSignal,
  );
  const keyParts = workspaceStateKeyParts(storageHold.key);
  assert.equal(keyParts.profileId, profileId, "held storage write must belong to the real paired profile");
  assert.equal(keyParts.serverId, SERVER_ID, "held storage write must belong to the selected real Gateway target");
  assert.ok(keyParts.threadId, "the held key must identify the actual newly created thread");
  assert.equal(storageHold.calls, 1, "the one-shot hold must intercept one exact workspace-state write");
  const oldValue = await page.evaluate(key => localStorage.getItem(key), storageHold.key);
  assert.equal(oldValue, null, "the deferred write must not commit before its release");
  assert.equal(await page.evaluate(() => window.__e2eWorkspaceStateHold.isWritePending()), true,
    "the actual localStorage setItem thenable must still be pending in the old page realm");
  assert.equal(await page.evaluate(() => 41 + 1), 42, "the held storage Promise must not block the Browser event loop");
  assert.equal(new URL(page.url()).pathname.endsWith("/task") || new URL(page.url()).pathname.includes("/task/"), false,
    "the create flow must still be awaiting the actual preferences write before navigation");
  await waitForTurnCompletion(context, trace, keyParts.threadId);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("recover-created-workspace-task").waitFor({ state: "visible", timeout: 40_000 });
  assert.deepEqual(await page.evaluate(() => ({
    writePending: window.__e2eWorkspaceStateHold.isWritePending(),
    armed: window.__e2eWorkspaceStateHold.isArmed(),
  })), { writePending: false, armed: false }, "the new reload realm must not inherit the old realm's held write or armed one-shot shim");
  assert.equal(storageHold.calls, 1, "reload must not trigger a second hold before the original realm is released");
  storageHold.release();
  await waitFor(() => storageHold.bridgeCallbackCompleted ? true : null,
    2_000, "the original exposed storage callback to observe hold release", 10, context.abortSignal);
  await page.getByTestId("recover-created-workspace-task").click();
  await waitForTaskVisible(context, page, prompt, undefined);
  const finalKey = await page.evaluate(key => localStorage.getItem(key), storageHold.key);
  assert.ok(typeof finalKey === "string" && finalKey.length > 0, "recovery must complete the exact workspace-state write after reload");
  assert.equal(storageHold.calls, 1, "the old held realm must not re-arm the one-shot shim on reload");
  const taskId = taskIdFromUrl(page.url());
  assert.equal(keyParts.threadId, taskId, "the exact persisted key must match the visible recovered task");
  await waitForTurnCompletion(context, trace, taskId);
  assert.equal(trace.requests.filter(request => request.method === "thread/start").length, 1);
  assert.equal(trace.requests.filter(request => request.method === "turn/start").length, 1);
  return {
    exactProfileServerThreadKey: true,
    oldRealmSetItemThenablePendingAtReload: true,
    reloadRealmDidNotInheritHold: true,
    browserEventLoopResponsiveWhileHeld: true,
    releaseRequested: storageHold.releaseRequested,
    heldStorageBridgeReleased: storageHold.bridgeCallbackCompleted,
    recoveredTaskVisible: true,
    savedStatePresentAfterRecovery: true,
  };
}

async function runWorktreeLinkAckLoss({ context, page, gateway, profileId, trace }) {
  const sourceWorkspace = await workspacePathFor(context, "handoff-worktree-source");
  await openWorkspaceThroughUi(context, page, gateway, profileId, sourceWorkspace);
  const prompt = "HANDOFF_WORKTREE_LINK_ACK_LOSS";
  await page.getByTestId("workspace-isolation-worktree").click();
  await page.getByTestId("workspace-git-ref").fill("main");
  armResponseDrop(trace, "runtime.worktrees.conversations.link");
  await startTask(context, page, prompt);
  const lost = await waitForDrop(context, trace, "runtime.worktrees.conversations.link");
  assert.equal(lost.accepted, true, "the real registry must commit the first worktree conversation link before its ACK is dropped");
  const preparedWorktree = only(trace.requests, "runtime.worktrees.prepareV2");
  const preparedWorktreeResponses = only(trace.responses, "runtime.worktrees.prepareV2");
  assert.equal(preparedWorktree.length, 1, "the same handoff must prepare exactly one real managed worktree");
  assert.equal(preparedWorktreeResponses.length, 1, "the app-server must return exactly one result for the original worktree preparation");
  assert.ok(preparedWorktree[0].worktreeId, "the original prepare request must contain its generated worktree ID");
  assert.equal(preparedWorktreeResponses[0].worktreeId, preparedWorktree[0].worktreeId,
    "the app-server worktree result must preserve the exact ID from the one prepare request");
  lost.worktreeId = preparedWorktreeResponses[0].worktreeId;
  assert.ok(lost.threadId && lost.workspacePath && lost.worktreeId);

  await page.reload({ waitUntil: "domcontentloaded" });
  await clickRecoverOriginal(page);
  await waitForTaskVisible(context, page, prompt, lost.threadId);
  await waitForTurnCompletion(context, trace, lost.threadId);

  const linkRequests = trace.requests.filter(request => request.method === "runtime.worktrees.conversations.link");
  assert.equal(linkRequests.length, 2, "recovery must retry the exact unresolved link once");
  assert.equal(linkRequests[0].payloadSha256, linkRequests[1].payloadSha256, "link recovery must reuse the immutable original payload");
  assert.equal(trace.requests.filter(request => request.method === "runtime.worktrees.prepareV2").length, 1,
    "recovery must not create another managed worktree");
  assert.equal(trace.requests.filter(request => request.method === "thread/start").length, 1,
    "recovery must not create a second thread");
  assert.equal(trace.requests.filter(request => request.method === "turn/start").length, 1,
    "the initial turn must be sent only after the same link is confirmed");

  await page.goto(openProjectUrl(gateway, profileId), { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-project-route").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId(`managed-worktree-${lost.worktreeId}`).waitFor({ state: "visible", timeout: 45_000 });
  const listed = [...trace.responses].reverse().find(response => response.method === "runtime.worktrees.list"
    && response.worktrees?.some(item => item.worktreeId === lost.worktreeId));
  assert.ok(listed, "the actual Mobile Open Project route must read back the linked worktree registry entry");
  const item = listed.worktrees.find(worktree => worktree.worktreeId === lost.worktreeId);
  const matching = item.conversations.filter(conversation => conversation.threadId === lost.threadId
    && conversation.taskId === lost.threadId
    && conversation.workspacePath === lost.workspacePath);
  assert.equal(matching.length, 1, "the real registry list must contain one conversation for the original task and worktree");
  return {
    worktreeIdSha256: hashText(lost.worktreeId),
    threadIdSha256: hashText(lost.threadId),
    originalLinkPayloadRetriedExactly: true,
    worktreePrepareNotRepeated: true,
    threadStartNotRepeated: true,
    initialTurnStartedOnce: true,
    registryReadThroughActualOpenProjectUi: true,
    uniqueConversationLinkVisibleInRegistry: true,
  };
}

async function runExistingThreadIgnoresUnrelatedHandoff({ context, page, gateway, profileId, trace }) {
  const workspace = await workspacePathFor(context, "handoff-existing");
  await openWorkspaceThroughUi(context, page, gateway, profileId, workspace);
  const promptB = "HANDOFF_EXISTING_THREAD_B";
  await startTask(context, page, promptB);
  const taskB = await waitForTaskVisible(context, page, promptB, undefined);
  await waitForTurnCompletion(context, trace, taskB.threadId);

  await prepareOpenProjectForm(context, page, gateway, profileId, workspace);
  await clickOpenProject(context, page);
  await waitForNewWorkspaceForm(context, page, workspace);
  const promptA = "HANDOFF_UNRELATED_PENDING_THREAD_A";
  armResponseDrop(trace, "thread/start");
  await startTask(context, page, promptA);
  const lostA = await waitForDrop(context, trace, "thread/start");
  assert.equal(lostA.ok, true, "the unrelated A thread must have been committed before the UI ACK is dropped");
  assert.ok(lostA.clientRequestId);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("recover-created-workspace-task").waitFor({ state: "visible", timeout: 40_000 });

  const threadBRoute = `${gateway.baseUrl}/h/${encodeURIComponent(profileId)}/task/${encodeURIComponent(SERVER_ID)}/${encodeURIComponent(taskB.threadId)}`;
  await page.goto(threadBRoute, { waitUntil: "domcontentloaded" });
  await waitForTaskVisible(context, page, promptB, taskB.threadId);
  const withoutCwd = new URL(page.url());
  assert.equal(withoutCwd.searchParams.has("cwd"), false, "ordinary B recovery must be tested without an explicit cwd parameter");
  assert.equal(withoutCwd.searchParams.has("creationRequestId"), false, "ordinary B route must not borrow A's creation ID");

  const explicitCwdUrl = new URL(threadBRoute);
  explicitCwdUrl.searchParams.set("cwd", workspace);
  await page.goto(explicitCwdUrl.toString(), { waitUntil: "domcontentloaded" });
  await waitForTaskVisible(context, page, promptB, taskB.threadId);
  const withCwd = new URL(page.url());
  assert.equal(withCwd.searchParams.get("cwd"), workspace, "second ordinary B recovery must use the same explicit workspace cwd");
  assert.equal(withCwd.searchParams.has("creationRequestId"), false, "explicit-cwd B route must not borrow A's creation ID");

  const newUrl = new URL(`${gateway.baseUrl}/new`);
  newUrl.searchParams.set("profileId", profileId);
  newUrl.searchParams.set("serverId", SERVER_ID);
  newUrl.searchParams.set("cwd", workspace);
  await page.goto(newUrl.toString(), { waitUntil: "domcontentloaded" });
  await page.getByTestId("recover-created-workspace-task").waitFor({ state: "visible", timeout: 40_000 });
  const starts = trace.requests.filter(request => request.method === "thread/start");
  const turns = trace.requests.filter(request => request.method === "turn/start");
  assert.equal(starts.length, 2, "only B and the original A request may issue thread/start");
  assert.equal(turns.length, 1, "B's existing turn is not duplicated and unresolved A must not start a turn while B is reopened");
  assert.equal(starts.filter(request => request.clientRequestId === lostA.clientRequestId).length, 1,
    "the pending A creation identity remains the original request");
  return {
    existingThreadIdSha256: hashText(taskB.threadId),
    unrelatedCreationRequestIdSha256: hashText(lostA.clientRequestId),
    existingTaskRenderedWithoutCwd: true,
    existingTaskRenderedWithSameCwd: true,
    originalUnrelatedHandoffStillRecoverable: true,
    noDuplicateThreadOrTurn: true,
  };
}

async function openWorkspaceThroughUi(context, page, gateway, profileId, workspace) {
  await prepareOpenProjectForm(context, page, gateway, profileId, workspace);
  await clickOpenProject(context, page);
  await waitForNewWorkspaceForm(context, page, workspace);
}

async function prepareOpenProjectForm(context, page, gateway, profileId, workspace) {
  await page.goto(openProjectUrl(gateway, profileId), { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-project-route").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(SERVER_LABEL, { exact: true }).click();
  const path = page.getByLabel("目录");
  await path.waitFor({ state: "visible", timeout: 30_000 });
  await path.fill(workspace);
}

async function clickOpenProject(context, page) {
  const button = page.getByRole("button", { name: "打开项目", exact: true });
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await waitForEnabled(context, button, "Open Project after selected-server catalog readiness");
  assert.equal(await button.isDisabled(), false, "the selected real directory must be openable through the UI");
  await button.click();
}

async function waitForNewWorkspaceForm(context, page, workspace) {
  const path = page.getByTestId("workspace-path");
  const expected = resolve(workspace);
  const actual = await waitFor(
    async () => {
      if (!await path.isVisible()) return null;
      const value = await path.inputValue();
      return resolve(value) === expected ? value : null;
    },
    45_000,
    "New Task form to become visible with its confirmed workspace after catalog and preference hydration",
    50,
    context.abortSignal,
  );
  assert.equal(resolve(actual), expected, "the actual New Task form must retain the confirmed workspace path");
}

async function startTask(context, page, prompt, options = {}) {
  const path = page.getByTestId("workspace-path");
  await path.waitFor({ state: "visible", timeout: 30_000 });
  if (options.workspace) await path.fill(options.workspace);
  if (options.worktree) {
    await page.getByTestId("workspace-isolation-worktree").click();
    await page.getByTestId("workspace-git-ref").fill("main");
  }
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  const create = page.getByTestId("create-workspace");
  await create.waitFor({ state: "visible", timeout: 30_000 });
  await waitForEnabled(context, create, "Create Task after async workspace/catalog readiness");
  assert.equal(await create.isDisabled(), false, "the real New Task form must permit this isolated synthetic prompt");
  await create.click();
}

async function waitForEnabled(context, locator, label) {
  await waitFor(
    async () => await locator.isEnabled() ? true : null,
    30_000,
    label,
    25,
    context.abortSignal,
  );
}

async function waitForTaskVisible(context, page, prompt, expectedThreadId) {
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("message-assistant").filter({ hasText: ASSISTANT_REPLY }).waitFor({ state: "visible", timeout: 60_000 });
  const threadId = taskIdFromUrl(page.url());
  assert.ok(threadId, "the actual task route must include its thread ID");
  if (expectedThreadId) assert.equal(threadId, expectedThreadId, "recovery must render the original task thread");
  return { threadId, routePath: new URL(page.url()).pathname };
}

async function clickRecoverOriginal(page) {
  const button = page.getByTestId("recover-created-workspace-task");
  await button.waitFor({ state: "visible", timeout: 45_000 });
  await button.click();
}

async function waitForTurnCompletion(context, trace, threadId) {
  return waitFor(
    () => trace.notifications.find(notification => notification.method === "turn/completed" && notification.threadId === threadId) ?? null,
    60_000,
    "actual turn/completed for the expected thread",
    25,
    context.abortSignal,
  );
}

function installRpcTrace(page) {
  const trace = {
    requests: [],
    responses: [],
    notifications: [],
    droppedAcks: [],
    capabilities: null,
    drop: null,
    lastDrop: null,
  };
  page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    const requestById = new Map();
    let closing = false;
    socket.onClose(() => {
      if (closing) return;
      closing = true;
      // Playwright 1.62 WebSocketRoute.close() returns Promise<void>.
      void upstream.close().catch(() => {});
    });
    upstream.onClose(() => {
      if (closing) return;
      closing = true;
      void socket.close().catch(() => {});
    });
    socket.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      if (frame && frame.id !== undefined && typeof frame.method === "string") {
        const request = summarizeRequest(frame);
        requestById.set(String(frame.id), request);
        trace.requests.push(request);
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
      if (frame && typeof frame.method === "string" && frame.id === undefined) {
        trace.notifications.push({
          method: frame.method,
          threadId: stringOrNull(frame.params?.threadId),
          turnId: stringOrNull(frame.params?.turnId),
          status: stringOrNull(frame.params?.turn?.status),
        });
        socket.send(raw);
        return;
      }
      const request = frame?.id === undefined ? null : requestById.get(String(frame.id)) ?? null;
      const method = request?.method ?? null;
      const summary = summarizeResponse(method, frame);
      trace.responses.push(summary);
      if (method === "initialize" && frame.result?.capabilities?.experimental) {
        trace.capabilities = Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, frame.result.capabilities.experimental[name] === true]));
      }
      const fault = trace.drop;
      if (fault && method === fault.method && isSuccessfulResponse(method, frame)) {
        trace.lastDrop = summarizeDroppedResponse(request, frame);
        trace.droppedAcks.push(trace.lastDrop);
        trace.drop = null;
        return;
      }
      socket.send(raw);
    });
  });
  return trace;
}

function armResponseDrop(trace, method) {
  assert.equal(trace.drop, null, "only one explicit response-drop fault may be active at a time");
  trace.lastDrop = null;
  trace.drop = { method };
}

async function waitForDrop(context, trace, method) {
  const dropped = await waitFor(
    () => trace.lastDrop?.method === method ? trace.lastDrop : null,
    CASE_TIMEOUT_MS,
    `one real successful ${method} response to reach the test proxy before being dropped`,
    25,
    context.abortSignal,
  );
  assert.equal(trace.drop, null, "the one-shot response-drop fault must disarm after its actual matching response");
  return dropped;
}

function isSuccessfulResponse(method, frame) {
  if (!frame || frame.error || !frame.result) return false;
  if (["runtime.workspaces.openV2", "runtime.workspaces.prepareV2", "runtime.worktrees.prepareV2"].includes(method)) {
    return frame.result.receipt?.status === "ready" && typeof frame.result.receipt.workspacePath === "string";
  }
  if (method === "thread/start") return typeof frame.result.thread?.id === "string";
  if (method === "turn/start") return typeof frame.result.turn?.id === "string";
  if (method === "runtime.worktrees.conversations.link") return frame.result.accepted === true && typeof frame.result.path === "string";
  return false;
}

function summarizeRequest(frame) {
  const params = frame.params && typeof frame.params === "object" ? frame.params : {};
  const conversation = params.conversation && typeof params.conversation === "object" ? params.conversation : {};
  return {
    method: frame.method,
    rpcId: frame.id ?? null,
    clientRequestId: stringOrNull(params.clientRequestId),
    threadId: stringOrNull(params.threadId ?? conversation.threadId),
    taskId: stringOrNull(conversation.taskId),
    clientMessageId: stringOrNull(params.clientMessageId),
    workspacePath: stringOrNull(params.workspacePath ?? params.path ?? conversation.workspacePath),
    worktreeId: stringOrNull(params.worktreeId),
    payloadSha256: frame.method === "runtime.worktrees.conversations.link" ? hashText(JSON.stringify(params)) : null,
  };
}

function summarizeResponse(method, frame) {
  const result = frame?.result && typeof frame.result === "object" ? frame.result : {};
  const receipt = result.receipt && typeof result.receipt === "object" ? result.receipt : {};
  const operationResult = result.result && typeof result.result === "object" ? result.result : {};
  const items = Array.isArray(result.items) ? result.items : [];
  return {
    method,
    rpcId: frame?.id ?? null,
    ok: !frame?.error,
    status: stringOrNull(receipt.status),
    clientRequestId: stringOrNull(receipt.clientRequestId),
    threadId: stringOrNull(result.thread?.id ?? result.threadId),
    turnId: stringOrNull(result.turn?.id ?? receipt.turnId),
    workspacePath: stringOrNull(receipt.workspacePath ?? operationResult.path ?? operationResult.workspacePath ?? result.path),
    accepted: result.accepted === true,
    ...(method === "runtime.worktrees.prepareV2"
      ? { worktreeId: stringOrNull(operationResult.worktree?.worktreeId) }
      : {}),
    worktrees: method === "runtime.worktrees.list" ? items.map(item => ({
      worktreeId: stringOrNull(item?.worktreeId),
      path: stringOrNull(item?.path),
      conversations: Array.isArray(item?.conversations) ? item.conversations.map(conversation => ({
        threadId: stringOrNull(conversation?.threadId),
        taskId: stringOrNull(conversation?.taskId),
        workspacePath: stringOrNull(conversation?.workspacePath),
      })) : [],
    })) : undefined,
  };
}

function summarizeDroppedResponse(request, frame) {
  const result = frame?.result && typeof frame.result === "object" ? frame.result : {};
  const receipt = result.receipt && typeof result.receipt === "object" ? result.receipt : {};
  return {
    method: request?.method ?? null,
    ok: !frame?.error,
    status: stringOrNull(receipt.status),
    clientRequestId: stringOrNull(request?.clientRequestId),
    clientMessageId: stringOrNull(request?.clientMessageId),
    threadId: stringOrNull(result.thread?.id ?? request?.threadId ?? result.threadId),
    turnId: stringOrNull(result.turn?.id),
    workspacePath: stringOrNull(receipt.workspacePath ?? result.result?.path ?? result.path),
    accepted: result.accepted === true,
    worktreeId: stringOrNull(request?.worktreeId),
  };
}

function summarizeTrace(trace) {
  const requestCounts = countMethods(trace.requests);
  const responseCounts = countMethods(trace.responses);
  const notificationCounts = countMethods(trace.notifications);
  return {
    requestCounts,
    responseCounts,
    notificationCounts,
    droppedSuccessfulAcks: trace.droppedAcks.length,
    droppedAckMethods: countMethods(trace.droppedAcks),
    capabilityFlags: trace.capabilities,
    turnCompletionCount: notificationCounts["turn/completed"] ?? 0,
  };
}

function countMethods(rows) {
  const counts = {};
  for (const row of rows) counts[row.method] = (counts[row.method] ?? 0) + 1;
  return counts;
}

async function connectMobile(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
  return profileIdFromHome(page.url());
}

function profileIdFromHome(url) {
  const match = new URL(url).pathname.match(/^\/h\/([^/]+)/);
  assert.ok(match?.[1], "paired Mobile Web must navigate to the real Gateway profile home route");
  return decodeURIComponent(match[1]);
}

function openProjectUrl(gateway, profileId) {
  const url = new URL("/open-project", gateway.baseUrl);
  url.searchParams.set("profileId", profileId);
  return url.toString();
}

async function workspacePathFor(context, name) {
  const folder = {
    "handoff-open-ack": "handoff-open-ack",
    "handoff-thread-ack": "handoff-thread-ack",
    "handoff-turn-ack": "handoff-turn-ack",
    "handoff-preferences": "handoff-preferences",
    "handoff-worktree-source": "handoff-worktree-source",
    "handoff-existing": "handoff-existing-thread",
  }[name];
  assert.ok(folder, `unknown isolated workspace fixture ${name}`);
  return resolve(context.stateDir, "workspaces", folder);
}

function taskIdFromUrl(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return segments.length ? decodeURIComponent(segments.at(-1)) : null;
}

function only(rows, method) {
  return rows.filter(row => row.method === method);
}

async function installDeferredWorkspaceStateHold(page) {
  const held = deferred();
  const reached = deferred();
  const state = { key: null, calls: 0, releaseRequested: false, bridgeCallbackCompleted: false };
  await page.exposeFunction("__e2eHoldWorkspaceStateWrite", async key => {
    state.calls += 1;
    state.key = String(key);
    reached.resolve(state.key);
    await held.promise;
    state.bridgeCallbackCompleted = true;
  });
  await page.addInitScript(({ prefix }) => {
    const nativeSetItem = Storage.prototype.setItem;
    let armed = false;
    let consumed = false;
    let heldWrite = null;
    let heldWriteSettled = false;
    Object.defineProperty(window, "__e2eWorkspaceStateHold", {
      configurable: false,
      enumerable: false,
      value: Object.freeze({
        arm: () => { armed = true; },
        isArmed: () => armed && !consumed,
        isWritePending: () => heldWrite !== null && !heldWriteSettled,
      }),
    });
    Storage.prototype.setItem = function (key, value) {
      if (armed && !consumed && typeof key === "string" && key.startsWith(prefix)) {
        consumed = true;
        // AsyncStorage 2.2.0 createPromise resolves getValue(); Promise resolution adopts
        // this returned thenable, so the mounted app's actual setItem promise stays pending.
        heldWrite = window.__e2eHoldWorkspaceStateWrite(key).then(() => nativeSetItem.call(this, key, value));
        heldWrite.then(() => { heldWriteSettled = true; }, () => { heldWriteSettled = true; });
        return heldWrite;
      }
      return nativeSetItem.call(this, key, value);
    };
  }, { prefix: WORKSPACE_STATE_PREFIX });
  return {
    get key() { return state.key; },
    get calls() { return state.calls; },
    get releaseRequested() { return state.releaseRequested; },
    get bridgeCallbackCompleted() { return state.bridgeCallbackCompleted; },
    waitReached: () => reached.promise,
    release: () => {
      if (state.releaseRequested) return;
      state.releaseRequested = true;
      held.resolve();
    },
  };
}

function workspaceStateKeyParts(key) {
  assert.ok(typeof key === "string" && key.startsWith(WORKSPACE_STATE_PREFIX), "held key must be the actual v3 workspace state key");
  const parts = key.slice(WORKSPACE_STATE_PREFIX.length).split(":");
  assert.ok(parts.length >= 5 && parts[3] === "scope", "held v3 key must retain the exact profile/server/thread/scope tuple");
  return {
    profileId: decodeURIComponent(parts[0]),
    serverId: decodeURIComponent(parts[1]),
    threadId: decodeURIComponent(parts[2]),
  };
}

async function verifyDeferredStorageFixtureContract() {
  const target = `${WORKSPACE_STATE_PREFIX}profile:local:thread:scope:stable-generation`;
  const unrelated = `${WORKSPACE_STATE_PREFIX}profile:local:other-thread:scope:stable-generation`;
  const store = new Map([[target, "before"]]);
  const gate = deferred();
  let heldCalls = 0;
  const write = async (key, value) => {
    if (key === target && heldCalls === 0) {
      heldCalls += 1;
      await gate.promise;
    }
    store.set(key, value);
  };
  const pending = write(target, "after");
  try {
    const settledBeforeRelease = await Promise.race([
      pending.then(() => true),
      new Promise(resolvePromise => setImmediate(() => resolvePromise(false))),
    ]);
    assert.equal(settledBeforeRelease, false, "the exact storage write must remain pending until explicit release");
    assert.equal(store.get(target), "before", "held storage must preserve its previous value");
    await write(unrelated, "unblocked");
    assert.equal(store.get(unrelated), "unblocked", "an unrelated key must remain writable during the hold");
  } finally {
    gate.resolve();
  }
  await pending;
  assert.equal(store.get(target), "after");
  assert.equal(heldCalls, 1);
  return {
    exactKeyHeldOnce: true,
    priorValuePreservedWhileHeld: true,
    unrelatedWriteNotBlocked: true,
    explicitFinallyReleaseCommittedWrite: true,
    noProcessOrServiceSpawned: true,
  };
}

function readRequiredPins() {
  return {
    kcoderBinary: requiredPath("KCODER_E2E_KCODER_BIN"),
    kcoderSha256: requiredSha256("KCODER_E2E_EXPECTED_KCODER_SHA256"),
    webBundleRoot: requiredPath("KCODER_E2E_HANDOFF_WEB_BUNDLE_ROOT"),
    webManifestPath: requiredPath("KCODER_E2E_HANDOFF_WEB_MANIFEST"),
    webSourceTreeSha256: requiredSha256("KCODER_E2E_HANDOFF_WEB_SOURCE_TREE_SHA256"),
    webManifestSha256: requiredSha256("KCODER_E2E_HANDOFF_WEB_MANIFEST_SHA256"),
    webBundleSha256: requiredSha256("KCODER_E2E_HANDOFF_WEB_BUNDLE_SHA256"),
    gatewaySourceSetSha256: requiredSha256("KCODER_E2E_HANDOFF_GATEWAY_SOURCE_SET_SHA256"),
  };
}

function requiredPath(name) {
  const value = process.env[name]?.trim();
  return value && resolve(value) === value ? value : null;
}

function requiredSha256(name) {
  const value = process.env[name]?.trim();
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function hashGatewaySources() {
  const files = [];
  for (const relativePath of HANDOFF_GATEWAY_SOURCE_PATHS) {
    const path = resolve(repoRoot, relativePath);
    const bytes = await readFile(path);
    files.push({ path: relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
  }
  assert.equal(files.length, 11, "the Gateway source pin must cover exactly the named 11 JavaScript inputs");
  const aggregateSha256 = createHash("sha256")
    .update(files.map(file => `${file.path}\0${file.sha256}\n`).join(""))
    .digest("hex");
  return { aggregateSha256, files };
}

async function readPinnedBundleFileCount(pins) {
  const handle = await open(pins.webManifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.size <= 1024 * 1024, "pinned Mobile Web manifest must be a bounded regular file");
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(manifestSha256, pins.webManifestSha256, "Mobile Web manifest must be hash-pinned before reading its file count");
  const manifest = JSON.parse(bytes.toString("utf8"));
  assert.ok(Number.isSafeInteger(manifest?.bundleFileCount) && manifest.bundleFileCount > 0,
    "pinned Mobile Web manifest must declare a positive safe file count");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length === manifest.bundleFileCount,
    "pinned Mobile Web manifest file table must match its declared file count");
  assert.equal(manifest.sourceTreeSha256, pins.webSourceTreeSha256, "Mobile Web manifest source tree must match its explicit pin");
  assert.equal(manifest.bundleSha256, pins.webBundleSha256, "Mobile Web manifest bundle must match its explicit pin");
  return manifest.bundleFileCount;
}

function isUnmetPrerequisite(error) {
  return String(error?.message ?? error).startsWith("UNMET_PREREQUISITE:");
}

function safeError(context, error) {
  const message = context.redactText(error instanceof Error ? error.message : String(error));
  return { name: error?.name ?? "Error", message: message.slice(0, 500) };
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
