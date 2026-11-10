import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { exportMobileWeb } from "../../harness/mobile-web-export.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { openOwnedMobileRpc } from "../../harness/owned-mobile-rpc.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { materializeOwnedDependencies } from "../../harness/owned-dependencies.mjs";
import { captureMobileExportSourceSnapshot } from "../../harness/mobile-export-source-snapshot.mjs";
import { buildGatewayMobileWebManifest, writeGatewayMobileWebManifest } from "../../../mobile/scripts/gateway-mobile-web-manifest.mjs";

const PREFS = "kcoder-studio:mobile-app-preferences:v1";
const MATRIX = [
  { width: 375, height: 812, language: "zh-CN", theme: "light" },
  { width: 390, language: "zh-CN", theme: "light" },
  { width: 320, language: "zh-CN", theme: "dark" },
  { width: 390, language: "en", theme: "dark" },
  { width: 320, language: "en", theme: "light" },
];

async function executableProvenance(path) {
  const resolved = await realpath(path);
  const before = await stat(resolved);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(resolved)) digest.update(chunk);
  const after = await stat(resolved);
  assert.equal(after.ino, before.ino, "the selected app-server binary cannot be replaced during hashing");
  assert.equal(after.size, before.size, "the selected app-server binary size must remain stable during hashing");
  assert.equal(after.mtimeMs, before.mtimeMs, "the selected app-server binary mtime must remain stable during hashing");
  return { path: resolved, size: before.size, mtime: before.mtime.toISOString(), sha256: digest.digest("hex") };
}

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-v3-project-history-filters", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "Model-independent V3 presentation and exact-target filtering with owned Gateway/app-server, synthetic histories and a bounded loopback text provider; no paid models or native-device claim",
}, async run => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  if (process.argv.includes("--api-only")) {
    const binaryEvidence = await executableProvenance(binary);
    const workspace = await materializeWorkspace(run, "minimal", { instanceId: "shared-pin-target" });
    const additional = await materializeWorkspace(run, "minimal", { instanceId: "shared-pin-project" });
    const config = run.pathInState("pin-target-config");
    await mkdir(config, { recursive: true, mode: 0o700 });
    await run.writeStateJson("pin-target-config/settings.json", {});
    const settingsFile = await run.writeStateJson("pin-target-settings.json", {});
    const serverIds = ["target-alpha", "target-beta"];
    const gatewayInputs = [];
    for (const [index, serverId] of serverIds.entries()) {
      const label = `pin-gateway-${index + 1}`;
      const privateDirectory = run.pathInState(label);
      await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
      const staleGatewayFile = run.pathInState(label, "project-pins.json");
      const servers = [{ id: serverId, label: `shared-target-${serverId}`, runtime: "kcoder", transport: "local",
        command: binary, workspace: workspace.path, settingsFile }];
      const serversFile = await run.writeStateJson(`pin-${serverId}-servers.json`, servers);
      gatewayInputs.push({ label, serverId, serversFile, serversStore: run.pathInState(label, "servers.json"),
        staleGatewayFile });
    }
    const start = (input, authToken, label) => startGateway(run, { label, auth: true, authToken,
      workspace: workspace.path, serversFile: input.serversFile, serversStore: input.serversStore, kcoderBin: binary,
      env: { KCODER_CONFIG_DIR: config } });
    const gatewayOneInventory = await start(gatewayInputs[0], undefined, "pin-gateway-1-inventory");
    const gatewayTwoInventory = await start(gatewayInputs[1], undefined, "pin-gateway-2-inventory");
    const observeLegacyTarget = async (gateway, serverId) => {
      const response = await fetch(`${gateway.baseUrl}/api/mobile/session`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: gateway.authToken }),
      });
      assert.equal(response.status, 200, "owned Mobile session for target inventory must be created");
      const credentials = await response.json();
      run.registerSecret(credentials.accessToken);
      run.registerSecret(credentials.rpcToken);
      try {
        const inventoryResponse = await fetch(`${gateway.baseUrl}/api/servers`, {
          headers: { authorization: `Bearer ${credentials.accessToken}` },
        });
        assert.equal(inventoryResponse.status, 200, "owned target inventory must be readable");
        const inventory = await inventoryResponse.json();
        const target = inventory.servers.find(server => server.id === serverId);
        assert.equal(typeof target?.observationTargetIdentity, "string", "Gateway inventory must expose the opaque target identity used by its former pin scope");
        return target.observationTargetIdentity;
      } finally {
        const revoked = await fetch(`${gateway.baseUrl}/api/mobile/session`, {
          method: "DELETE", headers: { authorization: `Bearer ${credentials.accessToken}` },
        });
        assert.ok([204, 401].includes(revoked.status), "owned inventory session cleanup must be confirmed");
      }
    };
    for (const [index, gateway] of [gatewayOneInventory, gatewayTwoInventory].entries()) {
      const input = gatewayInputs[index];
      const targetIdentity = await observeLegacyTarget(gateway, input.serverId);
      const scope = createHash("sha256").update(JSON.stringify(["project-pins-v1", targetIdentity, null])).digest("hex");
      const staleBytes = `${JSON.stringify({ version: 1, scopes: {
        [scope]: { revision: 7, entries: [{ projectKey: `runtime-target:${input.serverId}`,
          rootProject: true, pinned: index === 1, pinnedOrder: 7 }] },
      } })}\n`;
      await writeFile(input.staleGatewayFile, staleBytes, { mode: 0o600, flag: "wx" });
      input.staleBytes = staleBytes;
      input.staleTargetIdentity = targetIdentity;
    }
    await run.stopOwned("pin-gateway-1-inventory");
    await run.stopOwned("pin-gateway-2-inventory");
    const gatewayOne = await start(gatewayInputs[0], gatewayOneInventory.authToken, gatewayInputs[0].label);
    const gatewayTwo = await start(gatewayInputs[1], gatewayTwoInventory.authToken, gatewayInputs[1].label);
    for (const [index, gateway] of [gatewayOne, gatewayTwo].entries()) {
      const targetIdentity = await observeLegacyTarget(gateway, gatewayInputs[index].serverId);
      assert.equal(targetIdentity, gatewayInputs[index].staleTargetIdentity,
        "the stale Gateway entry remains scoped to the same target after Gateway restart");
    }
    let first = await openOwnedMobileRpc(run, gatewayOne, serverIds[0], workspace.path);
    let second = await openOwnedMobileRpc(run, gatewayTwo, serverIds[1], workspace.path);
    const list = (observer, deviceId) => observer.rpc.request("runtime.workspaces.list", { deviceId });
    const pinRoot = (observer, deviceId, pinned) => observer.rpc.request("runtime.sidebar.projects.pin", {
      deviceId, projectKey: workspace.path, rootProject: true, pinned,
    });
    const rootPinned = async (observer, deviceId, expected) => {
      const result = await list(observer, deviceId);
      assert.equal(result.rootProjectPinned, expected, `${deviceId} must read the app-server root pin`);
      return result;
    };

    const initial = await rootPinned(first, serverIds[0], true);
    assert.equal((await rootPinned(second, serverIds[1], true)).rootProjectPinned, initial.rootProjectPinned,
      "different Gateway server IDs mapped to the same root must read the same initial target state");
    await pinRoot(first, serverIds[0], false);
    await rootPinned(first, serverIds[0], false);
    await rootPinned(second, serverIds[1], false);

    const opened = await first.rpc.request("runtime.workspaces.open", {
      clientRequestId: randomUUID(), deviceId: serverIds[0], workspacePath: additional.path, label: "shared-pin-project",
    });
    assert.equal(opened.workspacePath, additional.path, "the second project must be registered in the shared target account");
    await first.rpc.request("runtime.sidebar.projects.pin", {
      deviceId: serverIds[0], projectKey: additional.path, rootProject: false, pinned: true,
    });
    let secondListing = await list(second, serverIds[1]);
    let sharedProject = secondListing.items.find(item => item.workspacePath === additional.path);
    assert.equal(sharedProject?.projectPinned, true, "the other Gateway reads a registered project's pin from the target");
    await second.rpc.request("runtime.sidebar.projects.pin", {
      deviceId: serverIds[1], projectKey: additional.path, rootProject: false, pinned: false,
    });
    const firstListing = await list(first, serverIds[0]);
    sharedProject = firstListing.items.find(item => item.workspacePath === additional.path);
    assert.equal(sharedProject?.projectPinned, false, "a write through the second Gateway is visible through the first");

    await pinRoot(second, serverIds[1], true);
    await rootPinned(first, serverIds[0], true);
    await first.close();
    await run.stopOwned(gatewayInputs[0].label);
    const restarted = await start(gatewayInputs[0], gatewayOne.authToken, "pin-gateway-1-restarted");
    first = await openOwnedMobileRpc(run, restarted, serverIds[0], workspace.path);
    await rootPinned(first, serverIds[0], true);
    secondListing = await list(first, serverIds[0]);
    sharedProject = secondListing.items.find(item => item.workspacePath === additional.path);
    assert.equal(sharedProject?.projectPinned, false, "target project state survives restarting its Gateway/app-server owner");
    for (const input of gatewayInputs) {
      assert.equal(await readFile(input.staleGatewayFile, "utf8"), input.staleBytes,
        "an obsolete Gateway pin file must remain untouched and cannot overwrite app-server state");
    }
    await run.writeArtifactJson("app-server-project-pins.json", {
      appServerBinary: binaryEvidence,
      targetWorkspace: workspace.path,
      additionalWorkspace: additional.path,
      gatewayServerIds: serverIds,
      initialRootPin: initial.rootProjectPinned,
      rootPinAfterGatewayOneWrite: false,
      rootPinAfterGatewayTwoWrite: true,
      additionalProjectPinAfterGatewayOneWrite: true,
      additionalProjectPinAfterGatewayTwoWrite: false,
      persistedAfterGatewayOneRestart: true,
      staleGatewayFilesUnchanged: gatewayInputs.map(({ label, staleGatewayFile, staleTargetIdentity }) => ({ label, staleGatewayFile, staleTargetIdentity })),
      providerCalls: 0,
      realModelCalls: 0,
    });
    return { independentGatewayReadWrite: true, sameRootAcrossDifferentServerIds: true,
      additionalProjectReadback: true, targetStateAfterGatewayRestart: true, staleGatewayFilesUnchanged: true,
      providerCalls: 0, realModelCalls: 0, appServerBinarySha256: binaryEvidence.sha256, appServerBinaryMtime: binaryEvidence.mtime };
  }
  const frozen = run.pathInState("frozen-source");
  const source = await captureMobileExportSourceSnapshot({ snapshotRoot: frozen,
    layout: "preflight-source-root", freezeFiles: true, sourceRoots: [
      { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
      { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
    ] });
  await run.writeArtifactJson("frozen-source.json", source);
  // Other tasks may update Vitest's shared cache; freeze all build inputs in this run.
  const importedWeb = process.env.KCODER_E2E_V3_LIBRARY_EXPORT;
  if (importedWeb) {
    const prior = JSON.parse(await readFile(resolve(importedWeb, "../frozen-source.json"), "utf8"));
    assert.deepEqual(source.files, prior.files, "A reused export must have exactly the current frozen source inputs");
  }
  const dependencies = !importedWeb ? await materializeOwnedDependencies(run, {
    sourceRoot: resolve(repoRoot, "apps/kcoder-studio/mobile/node_modules"),
    destination: run.pathInState("frozen-mobile-dependencies"), label: "v3-library-dependencies",
  }) : null;
  await run.writeArtifactJson("owned-dependencies.json", dependencies);
  const web = importedWeb ? { path: resolve(importedWeb) } : await exportMobileWeb(run, { label: "v3-library-web", deployMount: true, dependencyRoot: dependencies.root,
    mobileRoot: resolve(frozen, "apps/kcoder-studio/mobile") });
  const retainedWeb = run.pathInArtifacts("library-web");
  await cp(web.path, retainedWeb, { recursive: true });
  web.path = retainedWeb;
  await writeGatewayMobileWebManifest(web.path, await buildGatewayMobileWebManifest(web.path, { expectedFiles: web.bundleFiles }));
  const api = await materializeWorkspace(run, "minimal", { instanceId: "user-center" });
  const docs = await materializeWorkspace(run, "minimal", { instanceId: "product-docs" });
  const additional = await materializeWorkspace(run, "minimal", { instanceId: "additional-project" });
  const config = run.pathInState("config"); await mkdir(config, { mode: 0o700 });
  await run.writeStateJson("config/settings.json", {});
  const provider = await startApprovalModelFixture(run, { textOnly: true, textOnlyResponse: () => "已记录本轮布局测试。" });
  const settingsFile = await run.writeStateJson("settings.json", { active_provider: "v3-library", providers: {
    "v3-library": { api_format: "openai_chat_completions", authentication: { mode: "none" }, endpoint: provider.baseUrl,
      default_model: "library-model", context_window_tokens: 128000, max_output_tokens: 128, output_headroom_tokens: 4096,
      request_timeout_secs: 30, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson("servers.json", [
    { id: "api", label: "prod-api-cluster", runtime: "kcoder", transport: "local", command: binary, workspace: api.path, settingsFile },
    { id: "docs", label: "doc-platform", runtime: "kcoder", transport: "local", command: binary, workspace: docs.path, settingsFile },
    { id: "offline", label: "analytics-cn-east", runtime: "kcoder", transport: "ssh", host: "kcoder-unreachable.invalid", user: "fixture", command: "kcoder", workspace: "/workspace/analytics" },
  ]);
  const browser = await startChromium(run, { label: "v3-library-browser", noSandbox: true });
  const captures = [], errors = [], cases = [], pinEvidence = [];
  const seeded = [];
  const requestedCase = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
  const scenarios = requestedCase ? MATRIX.filter(item => `${item.width}-${item.language}-${item.theme}` === requestedCase)
    : process.argv.includes("--smoke") ? MATRIX.slice(0, 1) : MATRIX;
  assert.ok(scenarios.length, "requested V3 library case must exist in MATRIX");
  for (const scenario of scenarios) {
    const label = `${scenario.width}-${scenario.language}-${scenario.theme}`;
    const gatewayLabel = `${label}-gateway`;
    const gateway = await startGateway(run, { label: gatewayLabel, auth: true, workspace: api.path, serversFile,
      env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ROOT: web.path }, kcoderBin: binary });
    if (!seeded.length) {
      for (const [serverId, workspace, titles] of [["api", api.path, ["重构用户中心里的 Gateway 鉴权", "JWT 异常码统一规范", "归档设计方案"]], ["docs", docs.path, ["产品 PRD 第三节修订"]]]) {
        const observer = await openOwnedMobileRpc(run, gateway, serverId, workspace);
        for (const title of titles) {
          const created = await observer.rpc.request("thread/start", { cwd: workspace, clientRequestId: randomUUID() });
          const threadId = created.thread.id;
          const completed = observer.rpc.waitFor(frame => frame.method === "turn/completed" && frame.params?.threadId === threadId, 45_000);
          await observer.rpc.request("turn/start", { threadId, clientMessageId: randomUUID(), input: [{ type: "text", text: title }] });
          await completed;
          const archived = title === "归档设计方案";
          await observer.rpc.request("thread/metadata/update", { threadId, title, ...(archived ? { archivedAt: new Date().toISOString() } : {}) });
          seeded.push({ serverId, threadId, title, archived });
        }
        await observer.close();
      }
      if (process.argv.includes("--pin-only")) {
        const observer = await openOwnedMobileRpc(run, gateway, "api", api.path);
        const opened = await observer.rpc.request("runtime.workspaces.open", { clientRequestId: randomUUID(), workspacePath: additional.path, label: "additional-project" });
        assert.equal(opened.workspacePath, additional.path, "the owned additional-project fixture must be registered");
        await observer.close();
      }
    }
    for (const [serverId, workspace] of [["api", api.path], ["docs", docs.path]]) {
      const observer = await openOwnedMobileRpc(run, gateway, serverId, workspace);
      await observer.rpc.request("runtime.sidebar.projects.pin", { deviceId: serverId, projectKey: workspace, rootProject: true, pinned: true });
      await observer.close();
    }
    const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height ?? 844 } });
    let stage = "pair";
    let offlineConnections = 0;
    const rpcTrace = [], legacyPinRequests = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/servers\/[^/]+\/project-pins$/.test(path)) legacyPinRequests.push({ stage, path, method: request.method() });
    });
    page.on("websocket", socket => {
      if (new URL(socket.url()).searchParams.get("server") === "offline") offlineConnections += 1;
      const serverId = new URL(socket.url()).searchParams.get("server");
      const methods = new Map(), pinParams = new Map();
      socket.on("framesent", frame => { try {
        const data = JSON.parse(String(frame.payload));
        if (data.id && data.method) {
          methods.set(String(data.id), data.method);
          if (data.method === "runtime.sidebar.projects.pin") pinParams.set(String(data.id), data.params);
        }
      } catch {} });
      socket.on("framereceived", frame => { try {
        const data = JSON.parse(String(frame.payload)), method = methods.get(String(data.id));
        if (method === "thread/list" || method === "runtime.workspaces.list" || method === "runtime.sidebar.projects.pin" || data.error) rpcTrace.push({ stage, serverId, method,
          error: data.error, ...(pinParams.has(String(data.id)) ? { pin: pinParams.get(String(data.id)) } : {}),
          ...(method === "runtime.workspaces.list" ? { rootProjectPinned: data.result?.rootProjectPinned,
            projects: data.result?.items?.map(item => ({ workspacePath: item.workspacePath, projectKey: item.projectKey, projectPinned: item.projectPinned })) } : {}),
          threads: data.result?.threads?.map(item => ({ id: item.id, title: item.title, cwd: item.cwd })), count: data.result?.items?.length });
      } catch {} });
    });
    page.on("pageerror", error => errors.push({ label, stage, message: error.message, stack: error.stack }));
    const ui = id => page.locator(`[data-testid="${id}"]:visible`);
    const assertPinRpcRoundTrip = async (from, serverId, projectKey, rootProject, pinned) => {
      const matchesReadback = item => rootProject
        ? item.rootProjectPinned === pinned
        : item.projects?.some(project => (project.projectKey === projectKey || project.workspacePath === projectKey) && project.projectPinned === pinned);
      await waitFor(() => {
        const trace = rpcTrace.slice(from);
        const writeIndex = trace.findIndex(item => item.method === "runtime.sidebar.projects.pin"
          && item.serverId === serverId && item.pin?.projectKey === projectKey && Boolean(item.pin?.rootProject) === rootProject && item.pin?.pinned === pinned);
        return writeIndex >= 0 && trace.slice(writeIndex + 1).some(item => item.serverId === serverId && item.method === "runtime.workspaces.list" && matchesReadback(item));
      }, 45_000, `app-server pin write and runtime.workspaces.list readback for ${projectKey}=${pinned}`);
      const writes = rpcTrace.slice(from).filter(item => item.method === "runtime.sidebar.projects.pin"
        && item.serverId === serverId && item.pin?.projectKey === projectKey && Boolean(item.pin?.rootProject) === rootProject && item.pin?.pinned === pinned);
      assert.equal(writes.length, 1, "one user pin action must issue one app-server mutation");
      const writeIndex = rpcTrace.indexOf(writes[0]);
      assert.ok(rpcTrace.slice(writeIndex + 1).some(item => item.serverId === serverId && item.method === "runtime.workspaces.list" && matchesReadback(item)),
        "the UI must publish the app-server list readback after the mutation receipt");
    };
    const conversationBack = async () => {
      await ui("v3-conversation-menu").click();
      await ui("v3-conversation-selection").waitFor();
    };
    const historyBack = async version => {
      await ui(`history-interface-${version}`).getByRole("button").first().click();
      await ui(`home-interface-${version}`).waitFor();
    };
    const capture = async name => {
      await page.evaluate(() => document.activeElement?.blur());
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}/${name} overflow`);
      const path = run.pathInArtifacts(`${label}-${name}.png`); await page.screenshot({ path }); captures.push(path);
      console.log(`[v3-library] ${label} ${name}`);
    };
    try {
      await page.addInitScript(({ key, preferences }) => localStorage.getItem(key) || localStorage.setItem(key, JSON.stringify(preferences)), { key: PREFS, preferences: { ...scenario, interfaceVersion: "v3" } });
      await page.goto(`${gateway.baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
      await ui("welcome-direct-connection").click(); await ui("gateway-endpoint").fill(gateway.baseUrl);
      await ui("gateway-token").fill(gateway.authToken); await ui("gateway-connect").click();
      await ui("home-interface-v3").waitFor({ timeout: 45_000 });
      stage = "home";
      for (const row of seeded.filter(row => !row.archived)) await ui(`thread-${row.threadId}`).waitFor({ timeout: 45_000 });
      const search = await ui("home-search").boundingBox(), settings = await ui("home-settings").boundingBox(), inbox = await ui("interaction-inbox").boundingBox();
      assert.ok(search && settings && inbox && search.x < inbox.x && inbox.x < settings.x, "V3 uses Search on the left, Pending and Settings on the right");
      assert.equal(await ui("new-workspace").count(), 0, "V3 has contextual plus buttons instead of the old floating button");
      await ui("v3-project-folders").waitFor();
      assert.equal(await ui("v3-pinned-conversation-offline-0").count(), 0, "an unpinned offline target has no upper header");
      await capture("home-v3");
      stage = "offline-pin-disabled";
      const offlinePin = page.locator('[data-testid^="v3-project-pin-offline-"]:visible');
      await offlinePin.waitFor();
      assert.equal(await offlinePin.isDisabled(), true, "an unavailable target cannot report a saved pin");
      await page.locator('[data-testid^="v3-project-pin-unavailable-offline-"]:visible').waitFor();
      assert.equal(await offlinePin.getAttribute("aria-pressed"), "false");
      const offlineConnectionsBefore = offlineConnections;
      const pinWritesBeforeDisabledClick = rpcTrace.filter(item => item.method === "runtime.sidebar.projects.pin").length;
      const offlineBox = await offlinePin.boundingBox();
      const offlineThreadsBefore = await page.locator('[data-testid^="thread-"]:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-testid")).sort());
      for (const fraction of [0.2, 0.5, 0.8]) {
        await page.mouse.click(offlineBox.x + offlineBox.width * fraction, offlineBox.y + offlineBox.height / 2);
        assert.deepEqual(await page.locator('[data-testid^="thread-"]:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-testid")).sort()), offlineThreadsBefore,
          "disabled pin must not pass its click through to project filtering");
      }
      assert.equal(rpcTrace.filter(item => item.method === "runtime.sidebar.projects.pin").length, pinWritesBeforeDisabledClick,
        "offline pin must not send an app-server mutation");
      assert.equal(offlineConnections, offlineConnectionsBefore, "disabled offline pin must not start a target connection");
      assert.equal(await ui("v3-pinned-conversation-offline-0").count(), 0, "offline target stays out of the pinned section");
      await capture("offline-pin-unavailable-v3");
      await page.reload({ waitUntil: "domcontentloaded" });
      await ui("home-interface-v3").waitFor({ timeout: 45_000 });
      assert.equal(await offlinePin.isDisabled(), true, "offline pin stays unavailable after reload");
      assert.equal(await offlinePin.getAttribute("aria-pressed"), "false", "reload cannot reveal an unconfirmed offline pin");
      assert.equal(await ui("v3-pinned-conversation-offline-0").count(), 0);
      for (const row of seeded.filter(row => !row.archived)) await ui(`thread-${row.threadId}`).waitFor({ timeout: 45_000 });
      await capture("offline-pin-unavailable-reloaded-v3");
      stage = "project-pin-toggle";
      const marker = page.locator('[data-testid^="v3-project-pin-api-"][aria-label$="prod-api-cluster"]:visible');
      await marker.waitFor();
      await waitFor(() => marker.isEnabled(), 45_000, "target online before toggling pin");
      const visibleThreads = () => page.locator('[data-testid^="thread-"]:visible').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-testid")).sort());
      const threadsBeforeToggle = await visibleThreads(), urlBeforeToggle = page.url();
      for (let cycle = 0; cycle < 2; cycle += 1) {
        for (const pinned of [true, false]) {
          let traceStart = null;
          if (await marker.getAttribute("aria-pressed") !== String(pinned)) {
            traceStart = rpcTrace.length;
            await marker.click();
          }
          await waitFor(async () => await marker.getAttribute("aria-pressed") === String(pinned) && await marker.isEnabled(), 45_000, `confirmed pin=${pinned}`);
          if (traceStart !== null) await assertPinRpcRoundTrip(traceStart, "api", api.path, true, pinned);
          assert.equal(await marker.count(), 1, "the toggle must stay visible in both states");
          const name = marker.locator("..").locator("..").locator("..").getByText("prod-api-cluster", { exact: true });
          const nameBox = await name.boundingBox(), glyph = await marker.locator("svg").boundingBox();
          assert.ok(nameBox?.width >= 80 && nameBox.height >= 16, "the project name must have a readable rendered size in both groups");
          assert.ok(nameBox && glyph && Math.abs(glyph.x - nameBox.x - nameBox.width - 6) <= 2, "pin stays immediately beside the project name");
          assert.ok(Math.abs(glyph.y + glyph.height / 2 - nameBox.y - nameBox.height / 2) <= 2, "pin stays vertically aligned with the name");
          assert.equal(page.url(), urlBeforeToggle, "pin toggle must not navigate");
          const expected = seeded.filter(row => !row.archived && (row.serverId !== "api" || pinned)).map(row => `thread-${row.threadId}`).sort();
          assert.deepEqual(await visibleThreads(), expected, "only pinned project conversations belong in the upper area");
          assert.equal(await ui("v3-pinned-conversation-api-0").count(), Number(pinned), "unpinning the last project removes its upper server header");
          if (cycle === 0) await capture(pinned ? "project-pinned-v3" : "project-unpinned-v3");
        }
      }

      if (!process.argv.includes("--pin-only")) {
        const traceStart = rpcTrace.length;
        await marker.click();
        await waitFor(async () => await marker.getAttribute("aria-pressed") === "true" && await marker.isEnabled(), 45_000, "restore the pinned project for navigation checks");
        await assertPinRpcRoundTrip(traceStart, "api", api.path, true, true);
      }

      if (process.argv.includes("--pin-only")) {
        stage = "multiple-project-pins";
        const secondPin = page.locator('[data-testid^="v3-project-pin-api-"][aria-label$="additional-project"]:visible');
        const docsPin = page.locator('[data-testid^="v3-project-pin-docs-"]:visible');
        const markers = [marker, secondPin, docsPin];
        const pinTargets = [[marker, "api", api.path, true], [secondPin, "api", additional.path, false], [docsPin, "docs", docs.path, true]];
        for (const pin of markers) await waitFor(() => pin.isEnabled(), 45_000, "multi-pin target ready");
        // One page owns one pointer; backend writes may overlap, pointer gestures must not.
        for (const [pin, serverId, projectKey, rootProject] of pinTargets) {
          if (await pin.getAttribute("aria-pressed") !== "true") {
            const traceStart = rpcTrace.length;
            await pin.click();
            await assertPinRpcRoundTrip(traceStart, serverId, projectKey, rootProject, true);
          }
        }
        for (const pin of markers) await waitFor(async () => await pin.getAttribute("aria-pressed") === "true" && await pin.isEnabled(), 45_000, "all three pins confirmed");
        await ui("v3-pinned-projects-heading").waitFor();
        const pinnedHeading = await ui("v3-pinned-projects-heading").boundingBox();
        const ordinaryHeading = await ui("v3-project-folders").boundingBox();
        for (const pin of markers) { const box = await pin.boundingBox(); assert.ok(box.y > pinnedHeading.y && box.y < ordinaryHeading.y, "each confirmed pin belongs to the Pinned group"); }
        assert.deepEqual(await visibleThreads(), threadsBeforeToggle);
        assert.equal(await page.locator('[data-testid^="v3-pinned-conversation-"]:visible').count(), 3, "same-target projects have separate pinned sections");
        assert.equal(await page.locator('[data-testid^="v3-project-folder-"]:visible').count(), 1, "pinned projects are not duplicated in ordinary folders");
        for (const id of ["home-workspace-name-api-0", "home-workspace-name-api-1", "home-workspace-name-docs-0"]) {
          const box = await ui(id).boundingBox();
          assert.ok(box?.width >= 80 && box.height >= 16, "every pinned project must render its own readable name");
        }
        await ui("v3-pinned-project-toggle-api-1").click();
        assert.equal(await ui("toggle-workspace-api-1").getAttribute("aria-expanded"), "false");
        assert.equal(await ui("toggle-server-api").getAttribute("aria-expanded"), "true", "folding one project does not fold a same-target sibling");
        if (scenario === scenarios[0]) {
          await page.waitForFunction(() => Object.keys(localStorage).filter(key => key.startsWith("kcoder-studio:mobile-collapsed-server-sections:v1:")).some(key => localStorage.getItem(key)?.includes("v3-project:")));
          await page.reload({ waitUntil: "domcontentloaded" }); await ui("home-interface-v3").waitFor({ timeout: 45_000 });
          await waitFor(async () => await ui("toggle-workspace-api-1").getAttribute("aria-expanded") === "false", 45_000, "project fold state survives reload");
          assert.equal(await ui("toggle-server-api").getAttribute("aria-expanded"), "true");
        }
        await ui("v3-pinned-project-toggle-api-1").click();
        await capture("multiple-projects-pinned-v3");
        if (scenario === scenarios[0]) {
          const beforeDraft = provider.requests.length;
          await ui("new-workspace-api-1").click(); await ui("new-task-draft").waitFor({ timeout: 45_000 });
          await waitFor(async () => (await ui("draft-context-project").getAttribute("aria-label"))?.includes(additional.path), 30_000, "the pinned project's plus uses its own directory");
          assert.equal(provider.requests.length, beforeDraft, "opening the pinned project's draft does not send a turn");
          await capture("pinned-project-draft-v3"); await conversationBack();
        }
        await marker.click();
        await waitFor(async () => await marker.getAttribute("aria-pressed") === "false" && await marker.isEnabled(), 45_000, "unpin only the first project");
        await page.reload({ waitUntil: "domcontentloaded" }); await ui("home-interface-v3").waitFor({ timeout: 45_000 });
        for (const [pin, expected] of [[marker, "false"], [secondPin, "true"], [docsPin, "true"]])
          await waitFor(async () => await pin.getAttribute("aria-pressed") === expected && await pin.isEnabled(), 45_000, `pin survives reload (${expected})`);
        assert.ok((await marker.boundingBox()).y > (await ui("v3-project-folders").boundingBox()).y, "unpinning moves the project back into ordinary Projects");
        for (const row of seeded.filter(row => row.serverId === "api" && !row.archived)) assert.equal(await ui(`thread-${row.threadId}`).count(), 0, "an unpinned sibling cannot leak through a server with another pinned project");
        assert.equal(await ui("v3-pinned-conversation-api-0").count(), 0, "the unpinned project leaves the upper area");
        assert.equal(await ui("v3-pinned-conversation-api-1").count(), 1, "its pinned sibling keeps an independent section");
        await capture("multiple-project-pins-reloaded-v3");
        for (const pin of [secondPin, docsPin]) { await pin.click(); await waitFor(async () => await pin.getAttribute("aria-pressed") === "false" && await pin.isEnabled(), 45_000, "restore unpinned fixture"); }
        assert.equal(await ui("v3-pinned-projects-heading").count(), 0, "the Pinned group disappears when its last project is unpinned");
        assert.equal(await page.locator('[data-testid^="v3-pinned-conversation-"]:visible').count(), 0, "no upper headers remain after all projects are unpinned");
        assert.equal((await visibleThreads()).length, 0);
        await capture("no-pinned-conversations-v3");
        const ordinaryToggle = ui("v3-project-toggle-docs-0");
        await ordinaryToggle.click();
        assert.equal(await ordinaryToggle.getAttribute("aria-expanded"), "true");
        assert.equal(await ui("v3-pinned-conversation-docs-0").count(), 0, "ordinary projects never enter the pinned section");
        await ui("v3-regular-conversations-docs-0").waitFor();
        await ui(`thread-${seeded.find(row => row.serverId === "docs").threadId}`).waitFor();
        await capture("ordinary-project-conversations-v3");
        await ordinaryToggle.click();
        assert.equal(await ordinaryToggle.getAttribute("aria-expanded"), "false");
        assert.equal(await ui("v3-regular-conversations-docs-0").count(), 0);
        await page.locator('[data-testid^="v3-project-folder-docs-"]:visible').first().click();
        await ui("v3-regular-conversations-docs-0").waitFor();
        await ui("v3-project-all").click();
        for (const pin of [marker, docsPin]) { await pin.click(); await waitFor(async () => await pin.getAttribute("aria-pressed") === "true" && await pin.isEnabled(), 45_000, "repin projects for row-filter checks"); }
        for (const row of seeded.filter(row => !row.archived)) await ui(`thread-${row.threadId}`).waitFor({ timeout: 45_000 });
        await ui("toggle-server-api").click({ position: { x: 8, y: 20 } });
        assert.equal(await ui(`thread-${seeded[0].threadId}`).count(), 0);
        await ui(`thread-${seeded.find(row => row.serverId === "docs").threadId}`).waitFor();
        await ui("toggle-server-api").click({ position: { x: 8, y: 20 } }); await ui(`thread-${seeded[0].threadId}`).waitFor();
        await ui("v3-project-all").click();
        await capture("project-pin-filter-v3");
        assert.deepEqual(legacyPinRequests, [], "Mobile pin actions must not use the retired Gateway project-pins HTTP endpoint");
        pinEvidence.push({ label, rpcTrace, legacyPinRequests });
        cases.push({ ...scenario, projectPinToggle: true, appServerWriteAndReadback: true, multiplePinsPersisted: true,
          offlinePinCannotReportSuccess: true, pinDoesNotFilter: true, independentProjectSections: true, ordinaryProjectExpansion: true, navigationSuppressed: true });
        continue;
      }
      stage = "project-selection";
      const requestsBeforeDraft = provider.requests.length;
      const normalDocsPin = page.locator('[data-testid^="v3-project-pin-docs-"]:visible');
      await normalDocsPin.click(); await waitFor(async () => await normalDocsPin.getAttribute("aria-pressed") === "false" && await normalDocsPin.isEnabled(), 45_000, "move docs into ordinary projects");
      const docsFolder = page.locator('[data-testid^="v3-project-folder-docs-"]:visible').first();
      await docsFolder.click();
      assert.equal(await ui(`thread-${seeded.find(row => row.serverId === "api").threadId}`).count(), 1, "opening an ordinary project keeps pinned projects available");
      await ui(`thread-${seeded.find(row => row.serverId === "docs").threadId}`).waitFor();
      await capture("selected-project-v3");
      if (scenario === scenarios[0]) {
        const selectedThread = seeded.find(row => row.serverId === "docs");
        await ui(`thread-${selectedThread.threadId}`).click();
        await page.getByText("已记录本轮布局测试。", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 45_000 });
        assert.equal(await ui("task-header-title").innerText(), selectedThread.title, "selection opens the actual conversation on its owning target");
        await capture("selected-conversation-v3");
        await conversationBack();
        assert.equal(await ui(`thread-${seeded.find(row => row.serverId === "api").threadId}`).count(), 1, "in-app return keeps pinned projects available");
      }
      await ui("new-workspace-docs-0").click();
      await ui("new-task-draft").waitFor({ timeout: 45_000 });
      assert.equal(provider.requests.length, requestsBeforeDraft, "contextual plus does not send a message");
      await waitFor(async () => await ui("draft-context-project").getAttribute("aria-label").then(value => value.includes(docs.path)), 30_000, "contextual plus preserves exact project cwd");
      await capture("selected-project-draft-v3");
      await conversationBack();
      await ui("toggle-server-api").click({ position: { x: 8, y: 20 } });
      assert.equal(await ui(`thread-${seeded[0].threadId}`).count(), 0);
      await ui("toggle-server-api").click({ position: { x: 8, y: 20 } });
      await ui(`thread-${seeded[0].threadId}`).waitFor();
      await ui("v3-project-all").click();
      assert.equal(await ui("v3-regular-conversations-docs-0").count(), 0, "All clears the ordinary project preview");
      assert.equal(await ui(`thread-${seeded[0].threadId}`).count(), 1, "All keeps pinned project conversations available");
      await ui("v3-project-folders-toggle").click(); assert.equal(await ui("v3-project-all").count(), 0);
      await ui("v3-project-folders-toggle").click(); await ui("v3-project-all").waitFor();
      await ui("v3-add-project").click(); await ui("open-project-route").waitFor();
      if (scenario === scenarios[0]) {
        stage = "register-existing-project";
        await ui("open-project-server-api").click();
        await waitFor(async () => await ui("open-project-submit").isEnabled(), 45_000, "existing-project catalog ready");
        await ui("open-project-path").fill(additional.path); await ui("open-project-submit").click();
        await ui("new-task-draft").waitFor({ timeout: 45_000 });
        assert.equal(provider.requests.length, requestsBeforeDraft, "registering an existing project does not send a message");
        assert.equal(await page.getByTestId("task-header-title").innerText(), "", "adding a project prepares a draft without creating a conversation");
        await conversationBack();
      } else { await ui("open-project-back").click(); await ui("v3-conversation-selection").waitFor(); }
      await page.locator('[data-testid^="v3-project-row-api-"]:visible').filter({ hasText: "additional-project" }).first().waitFor({ timeout: 45_000 });
      await normalDocsPin.click(); await waitFor(async () => await normalDocsPin.getAttribute("aria-pressed") === "true" && await normalDocsPin.isEnabled(), 45_000, "restore docs pin for history checks");
      stage = "navigation";
      await ui("interaction-inbox").click(); await ui("interaction-inbox-back").click(); await ui("home-search").waitFor();
      stage = "history";
      await ui("sessions").click(); await ui("history-interface-v3").waitFor();
      for (const row of seeded.filter(row => !row.archived)) await ui(`session-${row.threadId}`).waitFor({ timeout: 45_000 });
      await ui("sessions-page-loading").waitFor({ state: "hidden", timeout: 45_000 });
      assert.equal(await ui(`session-${seeded.find(row => row.archived).threadId}`).count(), 0);
      await page.locator('[data-testid^="sessions-month-"]:visible').first().waitFor();
      await capture("history-v3");
      await ui("session-search").fill("JWT");
      assert.equal(await ui(`session-${seeded.find(row => row.serverId === "docs").threadId}`).count(), 1, "typing does not submit V3 search");
      await ui("sessions-search-submit").click();
      await waitFor(async () => await page.locator('[data-testid^="session-row-"]:visible').count() === 1, 30_000, "explicit search applies");
      await ui(`session-${seeded.find(row => row.title.startsWith("JWT")).threadId}`).waitFor();
      await capture("search-v3");
      await ui("session-search").fill(""); await ui("sessions-search-submit").click();
      await ui("sessions-open-filters").click(); stage = "filters";
      await page.locator("#sessions-filter-interface-v3:visible").waitFor(); await capture("filters-v3");
      assert.equal(await ui("sessions-filter-apply").count(), 0, "V3 applies on return without a separate footer");
      await ui("sessions-host-docs").click(); await ui("sessions-filter-close").click();
      await waitFor(async () => await page.locator('[data-testid^="session-row-"]:visible').count() === 1, 30_000, "server scope applies on return");
      await ui(`session-${seeded.find(row => row.serverId === "docs").threadId}`).waitFor();
      await ui("sessions-open-filters").click(); await ui("sessions-filter-reset").click(); await ui("sessions-archived").click(); await ui("sessions-filter-close").click();
      const archived = seeded.find(row => row.archived); await ui(`session-${archived.threadId}`).waitFor({ timeout: 45_000 }); await capture("archived-v3");
      await ui("sessions-open-filters").click(); await ui("sessions-filter-reset").click(); await ui("sessions-filter-close").click();
      await ui(`session-${seeded[0].threadId}`).waitFor({ timeout: 45_000 });
      await historyBack("v3"); await ui("home-settings").click(); await ui("settings-appearance").click(); await ui("settings-interface-row").click(); stage = "versions";
      for (const version of ["classic", "modern", "v3"]) await ui(`settings-interface-choice-${version}`).waitFor();
      await capture("version-choices");
      for (const version of ["modern", "classic", "v3"]) {
        await ui(`settings-interface-choice-${version}`).click(); await ui("settings-detail-back").click(); await ui("settings-detail-back").click();
        await ui(`home-interface-${version}`).waitFor();
        for (const row of seeded.filter(row => !row.archived)) await ui(`thread-${row.threadId}`).waitFor({ timeout: 45_000 });
        await capture(`home-${version}`);
        await ui("sessions").click(); await ui(`history-interface-${version}`).waitFor();
        await ui(`session-${seeded[0].threadId}`).waitFor({ timeout: 45_000 });
        await ui("sessions-page-loading").waitFor({ state: "hidden", timeout: 45_000 });
        await capture(`history-${version}`);
        if (version !== "v3") {
          await historyBack(version);
          if (version === "classic") {
            await page.locator('[data-testid="home-interface-classic"] [aria-label]').first().click(); await ui("drawer-settings").click();
          } else await ui("home-settings").click();
          await ui("settings-appearance").click(); await ui("settings-interface-row").click();
        }
      }
      await page.reload({ waitUntil: "domcontentloaded" }); await ui("history-interface-v3").waitFor({ timeout: 30_000 });
      assert.deepEqual(legacyPinRequests, [], "Mobile pin actions must not use the retired Gateway project-pins HTTP endpoint");
      pinEvidence.push({ label, rpcTrace, legacyPinRequests });
      cases.push({ ...scenario, filters: true, archived: true, explicitSearch: true, versions: true });
    } catch (error) {
      await capture("failure"); await run.writeArtifactJson("failure-stage.json", { label, stage, url: page.url(), errors, rpcTrace, legacyPinRequests, text: await page.locator("body").innerText() }); throw error;
    } finally { await page.close(); await run.stopOwned(gatewayLabel); }
  }
  await run.writeArtifactJson("pin-rpc-evidence.json", pinEvidence);
  await run.writeArtifactJson("page-errors.json", errors); assert.deepEqual(errors, []);
  return { cases, captures, errors };
});
