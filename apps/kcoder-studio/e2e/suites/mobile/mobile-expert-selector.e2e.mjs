import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { openRpc, gatewayRpcUrl, initializeRpc, closeRpcAndWait } from "../../harness/rpc.mjs";
import { requireExecutable, repoRoot, runE2E, retainedArtifactRunRoot, waitFor } from "../../harness/run-context.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";
import { isContract } from "../../../shared/generated/validator.mjs";
import { registerOriginalCarrierCleanup } from "../../harness/native-systemd-carrier.mjs";

process.umask(0o077);

const MODEL_ID = "mobile-expert-selector-fixture";
const PREFERENCES_KEY = "kcoder-studio:mobile-app-preferences:v1";
const REQUIRED_NATIVE_CAPABILITIES = [
  "officeSettingsV1",
  "integrationScopeV1",
  "officeWorkspaceV1",
  "agentDefinitionsV1",
  "agentTurnConfigurationV1",
];
const FIXTURE_SCOPE = {
  accountId: "mobile-expert-selector-fixture-account",
  targetId: "local",
  workspaceId: null,
  identityGeneration: "fixture-generation-1",
  targetRevision: "fixture-target-revision-1",
  organizationId: null,
};
const FIXTURE_OWNER = {
  accountId: FIXTURE_SCOPE.accountId,
  organizationId: null,
  targetId: FIXTURE_SCOPE.targetId,
  workspaceId: null,
};
const EXPERTS = [
  { id: "personal.mobile-review", title: "Mobile Review", description: "Saved browser fixture for review tasks." },
  { id: "personal.mobile-planning", title: "Mobile Planning", description: "Saved browser fixture for planning tasks." },
];
const VERSIONS = new Map(EXPERTS.map((expert, expertIndex) => [expert.id, [
  { version: "1.0.0", title: expert.title, definitionSha256: `${expertIndex + 1}`.repeat(64) },
  { version: "2.0.0", title: expert.title, definitionSha256: `${expertIndex + 3}`.repeat(64) },
]]));

await runE2E(import.meta.url, {
  testId: "mobile-expert-selector-draft-and-existing-task-ui-protocol",
  tier: "full-integration",
  retainSuccessEvidence: true,
  retainSuccessLogs: true,
  modelPolicy: "Real exported Mobile Web, authenticated owned Gateway, run-owned app-server thread and Chromium; a deterministic WebSocket protocol fixture supplies expert catalog/version/current-binding replies at the Mobile RPC boundary; no Native expert configuration, Provider turn, SDK, external request, or native-device claim",
  evidenceReason: "Verify real V3 New Draft and classic existing TaskScreen entry buttons, lazy saved-version selection, draft selection, existing-task header menu entry without a Composer chip, and same-task change/clear at 390px zh/light and 320px en/dark",
}, async context => {
  const binary = await requireExecutable(
    process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
    "KCoder app-server",
  );
  const workspace = await materializeWorkspace(context, "minimal", { instanceId: "mobile-expert-selector" });
  const configDir = context.pathInState("config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("config/settings.json", {});
  const targetSettings = await context.writeStateJson("mobile-expert-selector-target-settings.json", {
    active_provider: "owned_mobile_ui_fixture",
    providers: {
      owned_mobile_ui_fixture: {
        api_format: "openai_chat_completions",
        authentication: { mode: "none" },
        endpoint: "http://127.0.0.1:9/v1",
        default_model: MODEL_ID,
        discover_models: false,
        no_proxy: true,
        context_window_tokens: 16_384,
        max_output_tokens: 1_024,
        output_headroom_tokens: 1_024,
        capabilities: { text: true, tools: false, vision: false },
      },
    },
  });
  assertProtocolFixtureContracts();
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Owned Mobile expert fixture",
    transport: "local",
    command: binary,
    workspace: workspace.path,
    settingsFile: targetSettings,
  }]);

  const priorRunId = process.env.KCODER_E2E_MOBILE_EXPERT_REUSE_RUN;
  let mobileWeb;
  if (priorRunId) {
    const priorRoot = retainedArtifactRunRoot(fileURLToPath(import.meta.url), priorRunId);
    const receipt = JSON.parse(await readFile(resolve(priorRoot, "artifacts/mobile-web-export-mobile-expert-selector-web-export-manifest.json"), "utf8"));
    assert.equal(receipt.status, "complete", "reuse requires a successful frozen export");
    assert.deepEqual(receipt.inputRootsAfter, receipt.inputRoots, "the selected export must have stable source roots");
    const priorWeb = resolve(priorRoot, "artifacts/verified-mobile-web");
    await buildGatewayMobileWebManifest(priorWeb, { expectedFiles: receipt.bundleFiles });
    const path = context.pathInState("mobile-expert-selector-mobile-web");
    await cp(priorWeb, path, { recursive: true });
    mobileWeb = { path, bundleFiles: receipt.bundleFiles };
    await context.writeArtifactJson("mobile-web-reused-export.json", { priorRunId, inputRoots: receipt.inputRoots, bundleFiles: receipt.bundleFiles });
  } else mobileWeb = await exportMobileWeb(context, {
    label: "mobile-expert-selector-web-export",
    outputName: "mobile-expert-selector-mobile-web",
    dependencyRoot: process.env.KCODER_E2E_MOBILE_DEPENDENCY_ROOT || undefined,
    scratchBaseDirectory: "/tmp",
    deployMount: true,
  });
  const gatewayManifest = await buildGatewayMobileWebManifest(mobileWeb.path, { expectedFiles: mobileWeb.bundleFiles });
  await writeGatewayMobileWebManifest(mobileWeb.path, gatewayManifest);
  await cp(mobileWeb.path, context.pathInArtifacts("verified-mobile-web"), { recursive: true });
  if (process.platform === "linux") {
    const runtimeDir = `/run/user/${process.getuid()}`;
    registerOriginalCarrierCleanup(context, {
      profile: configDir, workspace: workspace.path,
      uid: process.getuid(), gid: process.getgid(), activeManagers: new Set(),
      env: context.isolatedEnvironment({ XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` }),
    }, "mobile-expert-owned-native-manager");
  }

  const gateway = await startGateway(context, {
    auth: true,
    label: "mobile-expert-selector-gateway",
    startTimeoutMs: 60_000,
    workspace: workspace.path,
    serversFile,
    kcoderBin: binary,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_MOBILE_WEB_ROOT: mobileWeb.path,
    },
  });
  const browser = await startChromium(context, { label: "mobile-expert-selector-chromium", noSandbox: true });
  const protocol = createExpertProtocolFixture();
  const diagnostics = [];

  let draftPage;
  let taskPage;
  try {
  draftPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
  });
  await protocol.install(draftPage);
  observeDiagnostics(draftPage, diagnostics, "390-zh-light");
  await setPreferences(draftPage, { language: "zh-CN", theme: "light" });
  const session = await pairMobile(context, draftPage, gateway);

  const taskId = await seedExistingTask(gateway, workspace.path, session);

  await draftPage.reload({ waitUntil: "domcontentloaded" });
  await draftPage.getByTestId("home-interface-v3").waitFor({ state: "visible", timeout: 45_000 });
  await draftPage.getByTestId("new-workspace-local-0").click();
  const draft = draftPage.getByTestId("new-task-draft");
  await draft.waitFor({ state: "visible", timeout: 30_000 });
  await draft.getByTestId("draft-model-selector").waitFor({ state: "visible", timeout: 30_000 });
  const draftExpertButton = draft.getByTestId("composer-expert-selector");
  await draftExpertButton.waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(() => draftExpertButton.isEnabled(), 45_000, "the draft's owned target and expert capabilities are ready");
  assert.equal(await draftPage.getByTestId("composer-expert-selector-label").innerText(), "专家",
    "the compact draft trigger uses the expert entry label");
  await assertNoOverflow(draftPage, "390px New Draft");
  await capture(draftPage, context, "390-zh-light-v3-new-draft-trigger.png");

  await draftExpertButton.click();
  const draftSheet = draftPage.getByTestId("task-expert-selector-sheet");
  await draftSheet.waitFor({ state: "visible", timeout: 15_000 });
  await draftPage.getByTestId("composer-expert-list").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(protocol.calls.assistantList.length, 1, "opening the selector reads one experts page");
  assert.equal(protocol.calls.assistantVersions.length, 0, "versions stay lazy until an expert is opened");
  assert.deepEqual(protocol.calls.assistantList[0].scope, FIXTURE_SCOPE);
  assert.deepEqual(protocol.calls.assistantList[0].payload, {
    limit: 10,
    language: "zh-CN",
    personalOnly: true,
  });
  assert.match(await draftPage.getByTestId("composer-expert-none").innerText(), /不使用|No expert/i);
  assert.equal(await draftPage.getByTestId("composer-expert-none").getAttribute("aria-checked"), "true",
    "a new draft starts without an expert");
  assert.match(await draftPage.getByTestId("composer-expert-item-0").innerText(), /Mobile Review/);
  await draftPage.getByTestId("composer-expert-item-0").click();
  await draftPage.getByTestId("composer-expert-versions").waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(protocol.calls.assistantVersions.length, 1, "opening one expert reads only its saved versions page");
  assert.deepEqual(protocol.calls.assistantVersions[0].scope, FIXTURE_SCOPE);
  assert.deepEqual(protocol.calls.assistantVersions[0].payload, { id: EXPERTS[0].id, limit: 10 });
  const draftVersion = draftPage.getByTestId("composer-expert-option-1");
  await draftVersion.waitFor({ state: "visible", timeout: 15_000 });
  assert.match(await draftVersion.innerText(), /Mobile Review/);
  assert.match(await draftVersion.innerText(), /2\.0\.0/);
  await assertNoOverflow(draftPage, "390px expert versions");
  await capture(draftPage, context, "390-zh-light-v3-expert-versions.png");
  await draftPage.getByTestId("composer-expert-option-1").click();
  await draftSheet.waitFor({ state: "hidden", timeout: 15_000 });
  const draftLabel = await draftPage.getByTestId("composer-expert-selector-label").innerText();
  assert.match(draftLabel, /Mobile Review/);
  assert.match(draftLabel, /2\.0\.0/);
  assert.equal(protocol.calls.threadExpert.filter(call => call.change).length, 0,
    "choosing a draft expert remains local until first creation");
  await capture(draftPage, context, "390-zh-light-v3-new-draft-selected.png");

  await draftPage.close();
  draftPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
  });
  await protocol.install(draftPage);
  observeDiagnostics(draftPage, diagnostics, "390-zh-light-existing");
  await setPreferences(draftPage, { language: "zh-CN", theme: "light" });
  await pairMobile(context, draftPage, gateway);
  await draftPage.getByTestId(`thread-${taskId}`).click();
  await draftPage.getByTestId("message-input").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await draftPage.getByTestId("composer-expert-selector").count(), 0,
    "V3 existing conversations keep the expert control out of the Composer");
  await draftPage.getByTestId("task-more").click();
  await draftPage.getByTestId("task-menu-expert").waitFor({ state: "visible", timeout: 15_000 });
  await waitFor(() => draftPage.getByTestId("task-menu-expert").isEnabled(), 30_000, "the V3 expert menu entry is ready");
  await capture(draftPage, context, "390-zh-light-v3-existing-task-menu.png");
  await draftPage.getByTestId("task-menu-expert").click();
  await draftPage.getByTestId("task-expert-selector-sheet").waitFor({ state: "visible", timeout: 15_000 });
  await waitFor(() => draftPage.getByTestId("composer-expert-none").isEnabled(), 30_000, "V3 current expert is authoritative");
  assert.equal(await draftPage.getByTestId("composer-expert-none").getAttribute("aria-checked"), "true");
  await assertNoOverflow(draftPage, "390px V3 expert submenu");
  await assertExpertSheetFocus(draftPage);
  await capture(draftPage, context, "390-zh-light-v3-existing-task-experts.png");
  await draftPage.getByTestId("composer-expert-close").click();
  await assertTaskMoreFocus(draftPage);

  taskPage = await browser.newPage({
    viewport: { width: 320, height: 640 },
    isMobile: true,
    hasTouch: true,
    locale: "en",
  });
  await protocol.install(taskPage);
  observeDiagnostics(taskPage, diagnostics, "320-en-dark");
  await setPreferences(taskPage, { language: "en", theme: "dark", interfaceVersion: "classic" });
  await pairMobile(context, taskPage, gateway, "classic");
  const taskRow = taskPage.getByTestId(`thread-${taskId}`);
  await taskRow.waitFor({ state: "visible", timeout: 30_000 });
  await taskRow.click();
  await taskPage.getByTestId("task-header").waitFor({ state: "visible", timeout: 30_000 });
  await taskPage.getByTestId("message-input").waitFor({ state: "visible", timeout: 30_000 });

  const initialTaskPath = new URL(taskPage.url()).pathname;
  assert.ok(initialTaskPath.includes(taskId), "the selected row must open the seeded task ID");
  const modelButton = taskPage.getByTestId("conversation-model-selector");
  const permissionButton = taskPage.getByTestId("composer-permission-selector");
  assert.equal(await taskPage.getByTestId("composer-expert-selector").count(), 0,
    "existing conversations keep the expert control out of the Composer");
  for (const button of [modelButton, permissionButton]) {
    await button.waitFor({ state: "visible", timeout: 15_000 });
    await waitFor(() => button.isEnabled(), 30_000, "the existing task's runtime controls are ready");
    assert.ok(await button.isEnabled(), "model and permission entry buttons remain available");
  }
  await assertNoOverflow(taskPage, "320px existing task composer");
  await assertControlsWithinViewport(taskPage, [modelButton, permissionButton], "320px existing task composer");
  await capture(taskPage, context, "320-en-dark-classic-existing-task-trigger.png");

  await taskPage.getByTestId("task-more").click();
  await taskPage.getByTestId("task-menu-expert").waitFor({ state: "visible", timeout: 15_000 });
  await waitFor(() => taskPage.getByTestId("task-menu-expert").isEnabled(), 30_000, "the classic expert menu entry is ready");
  await capture(taskPage, context, "320-en-dark-classic-existing-task-menu.png");
  await taskPage.getByTestId("task-menu-expert").click();
  const taskSheet = taskPage.getByTestId("task-expert-selector-sheet");
  await taskSheet.waitFor({ state: "visible", timeout: 15_000 });
  await taskPage.getByTestId("composer-expert-list").waitFor({ state: "visible", timeout: 30_000 });
  await assertNoOverflow(taskPage, "320px expert list");
  await assertExpertSheetFocus(taskPage);
  await capture(taskPage, context, "320-en-dark-classic-expert-list.png");
  await assertSelectedExpert(taskPage, {
    expertIndex: 1,
    versionIndex: 0,
    taskId,
    expectedTitle: "Mobile Planning",
    expectedVersion: "1.0.0",
  });
  await assertTaskIdentity(taskPage, taskId, initialTaskPath);
  await assertNoOverflow(taskPage, "320px selected existing task composer");
  await assertControlsWithinViewport(taskPage, [modelButton, permissionButton], "320px selected existing task composer");
  await capture(taskPage, context, "320-en-dark-existing-task-selected.png");

  await openTaskExpert(taskPage);
  await taskSheet.waitFor({ state: "visible", timeout: 15_000 });
  await taskPage.getByTestId("composer-expert-list").waitFor({ state: "visible", timeout: 15_000 });
  await assertSelectedExpert(taskPage, {
    expertIndex: 0,
    versionIndex: 1,
    taskId,
    expectedTitle: "Mobile Review",
    expectedVersion: "2.0.0",
  });
  await assertTaskIdentity(taskPage, taskId, initialTaskPath);

  await openTaskExpert(taskPage);
  await taskSheet.waitFor({ state: "visible", timeout: 15_000 });
  await taskPage.getByTestId("composer-expert-list").waitFor({ state: "visible", timeout: 15_000 });
  await taskPage.getByTestId("composer-expert-none").click();
  await taskSheet.waitFor({ state: "hidden", timeout: 15_000 });
  await assertTaskIdentity(taskPage, taskId, initialTaskPath);
  assert.equal(await taskPage.getByTestId("composer-expert-selector").count(), 0);
  await openTaskExpert(taskPage);
  await taskSheet.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await taskPage.getByTestId("composer-expert-none").getAttribute("aria-checked"), "true",
    "clearing the selection returns the original task to No expert");
  await taskPage.getByTestId("composer-expert-close").click();
  await taskSheet.waitFor({ state: "hidden", timeout: 15_000 });
  await assertTaskMoreFocus(taskPage);

  assert.equal(protocol.browserTurnStartCount, 0, "the browser run sends no model turns");
  assert.deepEqual(protocol.violations, []);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(protocol.calls.threadExpert.filter(call => call.change).map(call => ({
    threadId: call.threadId,
    expectedRevision: call.change.expectedRevision,
    expert: call.change.expert ? { id: call.change.expert.id, version: call.change.expert.version } : null,
  })), [
    { threadId: taskId, expectedRevision: 0, expert: { id: EXPERTS[1].id, version: "1.0.0" } },
    { threadId: taskId, expectedRevision: 1, expert: { id: EXPERTS[0].id, version: "2.0.0" } },
    { threadId: taskId, expectedRevision: 2, expert: null },
  ], "all changes use the original thread and increment the fixture CAS revision");
  await context.writeArtifactJson("mobile-expert-selector-protocol-fixture.json", {
    boundary: "Mobile client UI and JSON-RPC consumption only; expert catalog/version/current-binding replies are synthetic at the owned browser Gateway WebSocket boundary",
    nativeExpertConfigurationTested: false,
    modelOrSdkCalls: 0,
    threadId: taskId,
    screenshots: [
      "390-zh-light-v3-new-draft-trigger.png",
      "390-zh-light-v3-expert-versions.png",
      "390-zh-light-v3-new-draft-selected.png",
      "390-zh-light-v3-existing-task-menu.png",
      "390-zh-light-v3-existing-task-experts.png",
      "320-en-dark-classic-existing-task-trigger.png",
      "320-en-dark-classic-existing-task-menu.png",
      "320-en-dark-classic-expert-list.png",
      "320-en-dark-existing-task-selected.png",
    ],
    assistantListPageCount: protocol.calls.assistantList.length,
    assistantVersionsPageCount: protocol.calls.assistantVersions.length,
    threadExpertReads: protocol.calls.threadExpert.filter(call => !call.change).length,
    threadExpertChanges: protocol.calls.threadExpert.filter(call => call.change).length,
    providerRequests: 0,
    diagnostics,
  });
  return {
    taskId,
    screenshotCount: 9,
    viewportCases: ["390 zh/light V3 draft and existing task", "320 en/dark classic existing task"],
    nativeExpertConfigurationTested: false,
    modelOrSdkCalls: 0,
  };
  } catch (error) {
    if (draftPage && !draftPage.isClosed()) {
      await draftPage.screenshot({
        path: context.pathInArtifacts("mobile-expert-selector-failure-390.png"),
        fullPage: true,
        animations: "disabled",
      }).catch(() => {});
    }
    if (taskPage && !taskPage.isClosed()) {
      await taskPage.screenshot({
        path: context.pathInArtifacts("mobile-expert-selector-failure-320.png"),
        fullPage: true,
        animations: "disabled",
      }).catch(() => {});
    }
    await context.writeArtifactJson("mobile-expert-selector-failure.json", {
      errorName: error instanceof Error ? error.name : "Error",
      error: context.redactText(error instanceof Error ? error.message : String(error)),
      draftUrl: draftPage && !draftPage.isClosed() ? draftPage.url() : null,
      taskUrl: taskPage && !taskPage.isClosed() ? taskPage.url() : null,
    }).catch(() => {});
    throw error;
  }
});

function createExpertProtocolFixture() {
  const threadExperts = new Map();
  const fixture = {
    calls: { assistantList: [], assistantVersions: [], threadExpert: [] },
    violations: [],
    browserTurnStartCount: 0,
    async install(page) {
      await page.routeWebSocket("**/rpc*", socket => {
        const upstream = socket.connectToServer();
        const requestMethods = new Map();
        socket.onMessage(raw => {
          let frame;
          try { frame = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
          if (frame.id !== undefined && typeof frame.method === "string") requestMethods.set(String(frame.id), frame.method);
          if (frame.method === "turn/start") fixture.browserTurnStartCount += 1;
          const response = fixture.intercept(frame);
          if (response) {
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: response }));
            return;
          }
          upstream.send(raw);
        });
        upstream.onMessage(raw => {
          let frame;
          try { frame = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
          if (frame.id !== undefined && requestMethods.get(String(frame.id)) === "initialize" && frame.result) {
            const capabilities = frame.result.capabilities ?? {};
            const experimental = { ...(capabilities.experimental ?? {}) };
            for (const capability of REQUIRED_NATIVE_CAPABILITIES) experimental[capability] = true;
            frame = { ...frame, result: { ...frame.result, capabilities: { ...capabilities, experimental } } };
          }
          socket.send(JSON.stringify(frame));
        });
      });
    },
    intercept(frame) {
      if (frame.id === undefined || !frame.method) return null;
      if (frame.method === "settings/integrations/office/read") {
        return {
          persistedEnabled: true,
          effectiveEnabled: true,
          connectionEnabled: true,
          revision: "a".repeat(64),
          restartRequired: false,
        };
      }
      if (frame.method === "integrations/scope/read") return FIXTURE_SCOPE;
      if (frame.method === "integrations/assistant/list") {
        const request = frame.params ?? {};
        fixture.calls.assistantList.push({ payload: request.payload ?? null, scope: request.scope ?? null });
        return integrationReply(request, {
          items: EXPERTS.map((expert, index) => ({
            definition: officeDefinition(expert),
            builtin: false,
            owner: FIXTURE_OWNER,
            latestVersion: "2.0.0",
            versionCount: 2,
            updatedAtMs: 1_800_000_000_000 + index,
          })),
          nextCursor: null,
          total: EXPERTS.length,
          storageState: "ready",
        });
      }
      if (frame.method === "integrations/assistant/versions") {
        const request = frame.params ?? {};
        const id = request.payload?.id;
        fixture.calls.assistantVersions.push({ id, payload: request.payload ?? null, scope: request.scope ?? null });
        const expert = EXPERTS.find(item => item.id === id);
        if (!expert) {
          fixture.violations.push(`unknown expert versions requested: ${String(id)}`);
          return integrationReply(request, { items: [], nextCursor: null, total: 0, storageState: "ready" });
        }
        return integrationReply(request, {
          items: VERSIONS.get(id).map(version => ({
            owner: FIXTURE_OWNER,
            version: version.version,
            definition: officeDefinition({ ...expert, title: version.title }),
            definitionSha256: version.definitionSha256,
            createdAtMs: 1_800_000_000_000,
            archived: false,
          })),
          nextCursor: null,
          total: 2,
          storageState: "ready",
        });
      }
      if (frame.method === "thread/expert") {
        const { threadId, change } = frame.params ?? {};
        const state = threadExperts.get(threadId) ?? { revision: 0, expert: null };
        fixture.calls.threadExpert.push({ threadId, change: change ?? null });
        if (change) {
          if (change.expectedRevision !== state.revision) {
            fixture.violations.push(`thread/expert CAS mismatch for ${threadId}`);
            return { threadId, revision: state.revision, expert: state.expert, turns: [] };
          }
          state.revision += 1;
          state.expert = change.expert ? bindingFor(change.expert) : null;
          threadExperts.set(threadId, state);
        }
        return { threadId, revision: state.revision, expert: state.expert, turns: [] };
      }
      return null;
    },
  };
  return fixture;
}

function integrationReply(request, result) {
  return {
    contractVersion: "parallel-v1",
    requestId: request.requestId,
    status: "completed",
    operationId: null,
    entityRevision: null,
    observedAt: new Date().toISOString(),
    result,
    error: null,
  };
}

function officeDefinition(expert) {
  return {
    acceptanceCriteria: [],
    description: expert.description,
    externalSend: "deny",
    id: expert.id,
    inputSchema: { type: "object" },
    instructions: "Follow the saved definition.",
    language: "en",
    modelSelection: { kind: "inherit_current" },
    outputKinds: [],
    schemaVersion: 1,
    scope: "personal",
    title: expert.title,
  };
}

function assertProtocolFixtureContracts() {
  const settings = {
    connectionEnabled: true,
    effectiveEnabled: true,
    persistedEnabled: true,
    restartRequired: false,
    revision: "a".repeat(64),
  };
  const definitions = EXPERTS.map(officeDefinition);
  const versions = EXPERTS.flatMap(expert => VERSIONS.get(expert.id).map(version => ({
    archived: false,
    createdAtMs: 1_800_000_000_000,
    definition: officeDefinition({ ...expert, title: version.title }),
    definitionSha256: version.definitionSha256,
    owner: FIXTURE_OWNER,
    version: version.version,
  })));
  const reply = integrationReply({ requestId: "mobile-expert-selector-contract-check" }, {
    items: [{ definition: definitions[0], builtin: false }],
    nextCursor: null,
    total: 1,
    storageState: "ready",
  });
  const checks = [
    ["OfficeSettingsReadResult", settings],
    ["IntegrationScope", FIXTURE_SCOPE],
    ...definitions.map(definition => ["OfficeAssistantDefinition", definition]),
    ...versions.map(version => ["OfficeAssistantVersion", version]),
    ["IntegrationReply", reply],
    ["AgentTaskBinding", bindingFor({
      id: EXPERTS[0].id,
      version: VERSIONS.get(EXPERTS[0].id)[0].version,
      definitionSha256: VERSIONS.get(EXPERTS[0].id)[0].definitionSha256,
    })],
    ["ThreadExpertResult", { threadId: "fixture-thread", revision: 0, expert: null, turns: [] }],
  ];
  for (const [contract, value] of checks) {
    assert.equal(isContract(contract, value), true, `protocol fixture must satisfy generated ${contract}`);
  }
}

function bindingFor(reference) {
  const expert = EXPERTS.find(item => item.id === reference.id);
  return {
    definition: reference,
    owner: FIXTURE_OWNER,
    source: "expert",
    sourceId: null,
    title: expert?.title ?? "Fixture expert",
  };
}

async function setPreferences(page, preferences) {
  await page.addInitScript(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify({ ...value, interfaceVersion: value.interfaceVersion ?? "v3" }));
  }, { key: PREFERENCES_KEY, value: preferences });
}

async function pairMobile(context, page, gateway, interfaceVersion = "v3") {
  const response = await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200, "the owned Gateway serves the real Mobile Web entry");
  await page.getByTestId("welcome-direct-connection").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  const paired = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.origin === gateway.baseUrl && url.pathname === "/api/mobile/session";
  }, { timeout: 30_000 });
  await page.getByTestId("gateway-connect").click();
  const sessionResponse = await paired;
  assert.equal(sessionResponse.status(), 200);
  const { accessToken, rpcToken } = await sessionResponse.json();
  assert.ok(typeof accessToken === "string" && accessToken && typeof rpcToken === "string" && rpcToken);
  context.registerSecret(accessToken);
  context.registerSecret(rpcToken);
  await page.getByTestId(`home-interface-${interfaceVersion}`).waitFor({ state: "visible", timeout: 45_000 });
  return { accessToken, rpcToken };
}

async function seedExistingTask(gateway, cwd, { accessToken, rpcToken }) {
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", rpcToken), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  try {
    await initializeRpc(rpc, "mobile-expert-selector-seed", { threadCreationReceiptsV1: true });
    const clientRequestId = `mobile-expert-seed-${randomUUID()}`;
    const result = await rpc.request("thread/start", { cwd, clientRequestId });
    assert.equal(typeof result?.thread?.id, "string", "the owned app-server creates one task without starting a model turn");
    const observed = await rpc.request("thread/creation/read", { clientRequestId });
    assert.equal(observed.receipt?.threadId, result.thread.id, "the original creation receipt confirms the seed task");
    return result.thread.id;
  } finally {
    await closeRpcAndWait(rpc, "mobile expert selector seed RPC");
  }
}

async function assertExpertSheetFocus(page) {
  await waitFor(() => page.evaluate(() =>
    document.querySelector('[data-testid="task-expert-selector-sheet-content"]')?.contains(document.activeElement) === true),
  5_000, "the expert submenu owns keyboard focus");
}

async function assertTaskMoreFocus(page) {
  await waitFor(() => page.evaluate(() =>
    document.activeElement === document.querySelector('[data-testid="task-more"]')),
  5_000, "closing the expert submenu restores focus to More");
}

async function openTaskExpert(page) {
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-menu-expert").click();
  await page.getByTestId("task-expert-selector-sheet").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("composer-expert-list").waitFor({ state: "visible", timeout: 15_000 });
  await assertExpertSheetFocus(page);
}

async function assertSelectedExpert(page, { expertIndex, versionIndex, taskId, expectedTitle, expectedVersion }) {
  await waitFor(() => page.getByTestId(`composer-expert-item-${expertIndex}`).isEnabled(), 15_000, "the expert directory is ready");
  await page.getByTestId(`composer-expert-item-${expertIndex}`).click();
  await page.getByTestId("composer-expert-versions").waitFor({ state: "visible", timeout: 15_000 });
  const option = page.getByTestId(`composer-expert-option-${versionIndex}`);
  await option.waitFor({ state: "visible", timeout: 15_000 });
  const optionLabel = await option.innerText();
  assert.match(optionLabel, new RegExp(expectedTitle));
  assert.match(optionLabel, new RegExp(expectedVersion.replaceAll(".", "\\.")));
  await waitFor(() => option.isEnabled(), 15_000, "the saved expert version is ready");
  await option.click();
  await page.getByTestId("task-expert-selector-sheet").waitFor({ state: "hidden", timeout: 15_000 });
  assert.equal(await page.getByTestId("composer-expert-selector").count(), 0);
  await openTaskExpert(page);
  await waitFor(() => page.getByTestId(`composer-expert-item-${expertIndex}`).isEnabled(), 15_000, "the expert directory is ready");
  await page.getByTestId(`composer-expert-item-${expertIndex}`).click();
  const selectedOption = page.getByTestId(`composer-expert-option-${versionIndex}`);
  await selectedOption.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await selectedOption.getAttribute("aria-checked"), "true",
    "reopening the expert submenu shows the authoritative saved version");
  await page.getByTestId("composer-expert-close").click();
  await page.getByTestId("task-expert-selector-sheet").waitFor({ state: "hidden", timeout: 15_000 });
  await assertTaskMoreFocus(page);
  await assertTaskIdentity(page, taskId);
}

async function assertTaskIdentity(page, taskId, originalPath) {
  const current = new URL(page.url()).pathname;
  assert.ok(current.includes(taskId), "changing or clearing an expert cannot replace the task ID");
  if (originalPath) assert.equal(current, originalPath, "expert selection keeps the same task route");
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, `${label} must fit the logical viewport without horizontal overflow`);
}

async function assertControlsWithinViewport(page, controls, label) {
  const viewport = page.viewportSize();
  assert.ok(viewport, `${label} has a fixed mobile viewport`);
  for (const control of controls) {
    const bounds = await control.boundingBox();
    assert.ok(bounds, `${label} control remains laid out`);
    assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 &&
      bounds.y + bounds.height <= viewport.height + 1, `${label} control stays within the viewport`);
  }
}

async function capture(page, context, name) {
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.screenshot({ path: context.pathInArtifacts(name), animations: "disabled" });
}

function observeDiagnostics(page, diagnostics, variant) {
  page.on("pageerror", error => diagnostics.push({ variant, kind: "pageerror", name: error.name }));
  page.on("console", message => {
    if (message.type() === "error") diagnostics.push({ variant, kind: "console-error" });
  });
}
