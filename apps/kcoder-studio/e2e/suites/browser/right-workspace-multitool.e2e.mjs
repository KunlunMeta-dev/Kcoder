import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startFixtureSite } from "../../harness/fixture-site.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { managedChromeDescendants, stageManagedBrowserRuntime } from "../../harness/managed-browser.mjs";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "right-workspace-files-terminal-browser-tabs-resize-project-isolation",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway, app-server, files, PTY, and browser fixture",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const alphaName = `tools-alpha-${stamp}`;
  const betaName = `tools-beta-${stamp}`;
  const alpha = await materializeWorkspace(context, "minimal", { instanceId: "right-tools-alpha" });
  const beta = await materializeWorkspace(context, "minimal", { instanceId: "right-tools-beta" });
  const evidence = { stage: "setup", steps: [], tabs: [], sizes: [], targets: [], probes: [], persistence: [], cleanup: [], diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] } };
  const site = await startFixtureSite(context, { title: "KCoder Right Workspace E2E", marker: `RIGHT_WORKSPACE_BROWSER_${stamp}` });
  const kcoderBin = await requireExecutable(resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  const chromiumBin = await requireExecutable(process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium", "Chromium");
  const chromiumNoSandbox = process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";
  const managedBrowser = process.env.KCODER_E2E_MANAGED_CHROMIUM === "1"
    ? await stageManagedBrowserRuntime(context, kcoderBin, chromiumBin)
    : null;
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Right Workspace E2E",
    transport: "local",
    command: managedBrowser?.kcoderBin ?? kcoderBin,
    workspace: alpha.path,
    ...(managedBrowser ? {} : { chromiumBin }),
    chromiumNoSandbox,
  }]);
  const gateway = await startGateway(context, { label: "right-workspace-multitool-gateway", workspace: alpha.path, serversFile, auth: true });
  const chromium = await startChromium(context, { label: "right-workspace-multitool-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  const projects = [];
  let failure;

  try {
    await login(page, gateway);
    evidence.stage = "create-projects";
    const alphaId = await createProject(page, alpha.path, alphaName); projects.push({ id: alphaId, name: alphaName });
    const betaId = await createProject(page, beta.path, betaName); projects.push({ id: betaId, name: betaName });
    await selectProject(page, alphaId, alphaName);

    evidence.stage = "open-files";
    await page.getByTestId("toggle-right-workspace-panel-button").click();
    await page.getByTestId("right-workspace-launcher").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("right-workspace-file-option").click();
    await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30_000 });
    evidence.targets.push(await assertFileTarget(page, alpha.path, "alpha-files"));

    evidence.stage = "add-terminal";
    await addRightTool(page, "right-workspace-terminal-option");
    evidence.probes.push(await terminalProbe(page, alpha.path, `ALPHA_${stamp}`));

    evidence.stage = "add-browser";
    await addRightTool(page, "right-workspace-browser-option");
    await page.getByTestId("workspace-browser-panel").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page.getByTestId("workspace-browser-downloads-button").count(),
      0,
      "Gateway Web must not expose native-only browser download management",
    );
    const browserAddress = page.getByTestId("workspace-browser-url-input");
    await browserAddress.fill(site.url);
    await browserAddress.press("Enter");
    await assertNativeBrowserLoaded(page, site);
    if (managedBrowser) {
      const processIds = await managedChromeDescendants(gateway.child.pid, chromiumBin);
      assert.ok(processIds.length > 0, "target browser must use the managed distribution, not a system fallback");
      evidence.probes.push({ label: "managed-browser-discovery-without-override", processIds });
    }
    const threeTabs = await tabSnapshot(page, "three-tabs-browser-active");
    assertTabSet(threeTabs, ["right-workspace-file-tab", "right-workspace-terminal-tab", "right-workspace-browser-tab"], "right-workspace-browser-tab");
    evidence.tabs.push(threeTabs);
    await shot(page, context, "01-three-tools-browser.png");

    evidence.stage = "switch-tabs";
    await page.getByTestId("right-workspace-file-tab").click();
    evidence.targets.push(await assertFileTarget(page, alpha.path, "alpha-files-return"));
    await page.getByTestId("right-workspace-terminal-tab").click();
    evidence.probes.push(await assertTerminalContains(page, `ALPHA_${stamp}`, "alpha-terminal-return"));
    await page.getByTestId("right-workspace-browser-tab").click();
    await page.getByTestId("workspace-browser-panel").waitFor({ state: "visible", timeout: 30_000 });
    await assertNativeBrowserLoaded(page, site);

    evidence.stage = "resize";
    const shell = page.getByTestId("right-workspace-panel-shell");
    const before = await shell.boundingBox();
    const handle = await page.getByTestId("right-workspace-resize-handle").boundingBox();
    assert(before && handle);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 120);
    await page.mouse.down();
    await page.mouse.move(handle.x - 140, handle.y + 120, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    const after = await shell.boundingBox();
    assert(after && after.width > before.width + 40, `右栏缩放未生效：${before.width} -> ${after?.width}`);
    assert(after.width <= 840.5, `右栏缩放越过上限：${after.width}`);
    evidence.sizes.push({ before, after, delta: after.width - before.width });
    await shot(page, context, "02-browser-resized.png");

    evidence.stage = "collapse-reopen";
    await page.getByTestId("toggle-right-workspace-panel-button").click();
    assert.equal(await shell.getAttribute("aria-hidden"), "true");
    await page.getByTestId("toggle-right-workspace-panel-button").click();
    assert.equal(await shell.getAttribute("aria-hidden"), "false");
    await page.getByTestId("workspace-browser-panel").waitFor({ state: "visible", timeout: 30_000 });
    const reopenedTabs = await tabSnapshot(page, "browser-after-reopen");
    assertTabSet(reopenedTabs, ["right-workspace-file-tab", "right-workspace-terminal-tab", "right-workspace-browser-tab"], "right-workspace-browser-tab");
    await assertNativeBrowserLoaded(page, site);
    evidence.tabs.push(reopenedTabs);

    evidence.stage = "project-isolation";
    await page.getByTestId("right-workspace-file-tab").click();
    await selectProject(page, betaId, betaName);
    evidence.targets.push(await waitFileTarget(page, beta.path, "beta-files"));
    await page.getByTestId("right-workspace-terminal-tab").click();
    evidence.probes.push(await terminalProbe(page, beta.path, `BETA_${stamp}`));
    evidence.probes.push(await assertTerminalMissing(page, `ALPHA_${stamp}`, "beta-no-alpha-marker"));
    await shot(page, context, "03-beta-terminal-isolated.png");

    evidence.stage = "close-terminal";
    const terminalTab = page.getByTestId("right-workspace-terminal-tab");
    await terminalTab.hover();
    await page.getByTestId("right-workspace-terminal-tab-close-button").click();
    await terminalTab.waitFor({ state: "detached", timeout: 30_000 });
    assert.equal(await page.getByTestId("right-workspace-file-tab").count(), 1);
    assert.equal(await page.getByTestId("right-workspace-browser-tab").count(), 1);
    const terminalClosedTabs = await tabSnapshot(page, "terminal-closed");
    assertTabSet(terminalClosedTabs, ["right-workspace-file-tab", "right-workspace-browser-tab"]);
    evidence.tabs.push(terminalClosedTabs);

    evidence.stage = "close-browser-refresh-files";
    const browserTab = page.getByTestId("right-workspace-browser-tab");
    await browserTab.hover();
    await page.getByTestId("right-workspace-browser-tab-close-button").click();
    await browserTab.waitFor({ state: "detached", timeout: 30_000 });
    if (managedBrowser) {
      await waitFor(async () => (await managedChromeDescendants(gateway.child.pid, chromiumBin)).length === 0,
        15_000, "managed target browser processes exit after closing the tab");
      evidence.steps.push({ label: "managed-browser-processes-closed" });
    }
    await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30_000 });
    const beforeReloadImmediate = await persistenceSnapshot(page, "before-reload-immediate");
    assertFilesOnlySnapshot(beforeReloadImmediate, betaName);
    evidence.persistence.push(beforeReloadImmediate);
    await page.waitForTimeout(1000);
    const beforeReloadSettled = await persistenceSnapshot(page, "before-reload-settled");
    assertFilesOnlySnapshot(beforeReloadSettled, betaName, true);
    evidence.persistence.push(beforeReloadSettled);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    evidence.persistence.push(await persistenceSnapshot(page, "after-reload-before-select"));
    await selectProject(page, betaId, betaName);
    evidence.persistence.push(await persistenceSnapshot(page, "after-reload-after-select"));
    if (await page.getByTestId("right-workspace-panel-shell").getAttribute("aria-hidden") === "true") await page.getByTestId("toggle-right-workspace-panel-button").click();
    await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30_000 });
    evidence.targets.push(await waitFileTarget(page, beta.path, "beta-files-refresh"));
    const afterReloadRestored = await persistenceSnapshot(page, "after-reload-restored-files-only");
    assertFilesOnlySnapshot(afterReloadRestored, betaName, true);
    evidence.persistence.push(afterReloadRestored);
    evidence.steps.push({ label: "multitool-tabs-resize-collapse-project-isolation-refresh-passed" });
    await shot(page, context, "04-refresh-files-only.png");

    evidence.stage = "cleanup";
    await page.getByTestId("toggle-right-workspace-panel-button").click();
    for (const project of [...projects].reverse()) { await removeProject(page, project.name, project.id); projects.splice(projects.findIndex(item => item.id === project.id), 1); }
    assertDiagnostics(evidence);
    evidence.stage = "passed";
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    for (const project of [...projects].reverse()) {
      try { await removeProject(page, project.name, project.id); evidence.cleanup.push({ kind: "project", ...project }); } catch (error) { evidence.cleanup.push({ kind: "project", ...project, error: String(error) }); }
    }
    await context.writeArtifactJson("right-workspace-multitool.json", evidence);
  }
  if (failure) throw failure;
  return evidence;
});

async function addRightTool(page, optionId) {
  await page.getByTestId("right-workspace-new-tab-button").click();
  const menu = page.getByTestId("right-workspace-new-tab-menu");
  await menu.waitFor({ state: "visible", timeout: 30_000 });
  await menu.getByTestId(optionId).click();
}

async function tabSnapshot(page, label) {
  const tabs = page.getByTestId("right-workspace-tabbar").getByRole("tab"); const items = [];
  for (let i = 0; i < await tabs.count(); i += 1) items.push({ testId: await tabs.nth(i).getAttribute("data-testid"), selected: await tabs.nth(i).getAttribute("aria-selected") });
  return { label, items };
}

function assertTabSet(snapshot, expectedTestIds, selectedTestId = null) {
  assert.deepEqual(snapshot.items.map(item => item.testId).sort(), [...expectedTestIds].sort(), `${snapshot.label} tab 集合错误`);
  const selected = snapshot.items.filter(item => item.selected === "true");
  assert.equal(selected.length, 1, `${snapshot.label} 必须恰有一个 active tab`);
  if (selectedTestId) assert.equal(selected[0].testId, selectedTestId, `${snapshot.label} active tab 错误`);
}

async function assertNativeBrowserLoaded(page, site) {
  await page.getByTestId("workspace-browser-native-view").waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(
    ({ title, url }) => {
      const tab = document.querySelector('[data-testid="right-workspace-browser-tab"]');
      const input = document.querySelector('[data-testid="workspace-browser-url-input"]');
      return tab?.textContent?.includes(title) && input instanceof HTMLInputElement && input.value === url;
    },
    { title: site.title, url: site.url },
    { timeout: 60_000 },
  );
  assert.equal(await page.getByTestId("workspace-browser-error").count(), 0);
  assert.match(await page.getByTestId("right-workspace-browser-tab").innerText(), new RegExp(escapeRegExp(site.title)));
  assert.equal(await page.getByTestId("workspace-browser-url-input").inputValue(), site.url);
}

async function persistenceSnapshot(page, label) {
  return page.evaluate(snapshotLabel => {
    const entries = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith("wework.desktop.pane-workspace.v1:")) entries.push({ key, value: localStorage.getItem(key) });
    }
    return {
      label: snapshotLabel,
      entries: entries.sort((a, b) => a.key.localeCompare(b.key)).map(entry => {
        try { return { ...entry, parsed: JSON.parse(entry.value ?? "") }; }
        catch { return { ...entry, parsed: null }; }
      }),
      rightPanelHidden: document.querySelector('[data-testid="right-workspace-panel-shell"]')?.getAttribute("aria-hidden") ?? null,
      tabs: [...document.querySelectorAll('[data-testid="right-workspace-tabbar"] [role="tab"]')].map(tab => ({ testId: tab.getAttribute("data-testid"), selected: tab.getAttribute("aria-selected") })),
      projectButton: document.querySelector('[data-testid="project-work-button"]')?.textContent?.trim() ?? null,
    };
  }, label);
}

function assertFilesOnlySnapshot(snapshot, projectName, requirePersistedEntry = false) {
  assert.equal(snapshot.rightPanelHidden, "false", `${snapshot.label} 右栏未保持展开`);
  assert.deepEqual(snapshot.tabs.map(tab => tab.testId), ["right-workspace-file-tab"]);
  assert.deepEqual(snapshot.tabs.map(tab => tab.selected), ["true"]);
  assert.match(snapshot.projectButton || "", new RegExp(escapeRegExp(projectName)));
  const filesOnly = snapshot.entries.filter(entry =>
    entry.parsed?.rightPanelOpen === true
      && entry.parsed?.rightPanelView === "files"
      && Array.isArray(entry.parsed?.rightPanelTabs)
      && entry.parsed.rightPanelTabs.length === 1
      && entry.parsed.rightPanelTabs[0] === "files");
  if (requirePersistedEntry) assert.ok(filesOnly.length >= 1, `${snapshot.label} 未持久化 files-only 右栏状态`);
}

function activeTerminal(page) { return page.locator('[data-testid="remote-terminal"]:visible, [data-testid="embedded-local-terminal"]:visible').first(); }
async function terminalProbe(page, workspace, marker) {
  const terminal = activeTerminal(page); await terminal.waitFor({ state: "visible", timeout: 30_000 });
  const input = terminal.locator("textarea.xterm-helper-textarea").first(); await input.click();
  const quoted = `'${resolve(workspace).replaceAll("'", `'\\''`)}'`;
  await page.keyboard.insertText(`if [ "$PWD" = ${quoted} ] && [ -r README.md ]; then k=OK; else k=BAD; fi; printf '__K%s_${marker}__\\n' "$k"`); await page.keyboard.press("Enter");
  const output = await waitTerminalLine(terminal, `__KOK_${marker}__`); assert.equal(output.lines.includes(`__KBAD_${marker}__`), false); return { marker, workspace: resolve(workspace), status: "OK" };
}
async function assertTerminalContains(page, marker, label) { const output = await waitTerminalLine(activeTerminal(page), `__KOK_${marker}__`); return { label, marker, status: "present", outputTail: output.text.slice(-800) }; }
async function assertTerminalMissing(page, marker, label) { const text = await activeTerminal(page).locator(".xterm-rows").innerText(); assert.equal(text.split("\n").map(v => v.trim()).includes(`__KOK_${marker}__`), false); return { label, marker, status: "absent" }; }
async function waitTerminalLine(terminal, line) { const deadline = Date.now() + 30_000; let text = ""; while (Date.now() < deadline) { text = await terminal.locator(".xterm-rows").innerText().catch(() => ""); const lines = text.split("\n").map(v => v.trim()); if (lines.includes(line)) return { text, lines }; await new Promise(r => setTimeout(r, 100)); } throw new Error(`terminal line timeout: ${line}`); }

async function assertFileTarget(page, expected, label) { const actual = (await page.getByTestId("workspace-file-path").innerText()).trim(); assert.equal(resolve(actual), resolve(expected)); return { label, expected: resolve(expected), actual: resolve(actual) }; }
async function waitFileTarget(page, expected, label) { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { const value = await page.getByTestId("workspace-file-path").innerText().catch(() => ""); if (value.trim() && resolve(value.trim()) === resolve(expected)) return assertFileTarget(page, expected, label); await new Promise(r => setTimeout(r, 100)); } return assertFileTarget(page, expected, label); }
function byProject(page, name) { return page.getByTestId("project-item").filter({ hasText: name }).first(); }
async function login(page, gateway) { const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" }); assert.equal(response?.status(), 200); const input = page.locator('input[name="token"]'); if (await input.count()) { await input.fill(gateway.authToken); await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 }), page.locator('button[type="submit"]').click()]); } await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 }); }
async function createProject(page, workspace, name) { await page.getByTestId("projects-create-button").click(); await page.getByTestId("project-create-local-option").click(); const picker = page.getByTestId("standalone-folder-project-dialog"); await picker.waitFor({ state: "visible", timeout: 30_000 }); const input = picker.getByTestId("device-folder-path-input"); await input.fill(workspace); await input.press("Enter"); await page.waitForTimeout(300); await picker.getByTestId("confirm-device-folder-picker-button").click(); const dialog = page.getByTestId("local-project-create-dialog"); await dialog.waitFor({ state: "visible", timeout: 30_000 }); await dialog.getByTestId("local-project-create-name-input").fill(name); await dialog.getByTestId("confirm-local-project-create-button").click(); await dialog.waitFor({ state: "detached", timeout: 30_000 }); const project = byProject(page, name); await project.waitFor({ state: "visible", timeout: 30_000 }); const testId = await project.locator('[data-testid^="project-row-"]').first().getAttribute("data-testid"); const id = testId?.replace("project-row-", "") || ""; assert.match(id, /^\d+$/); return id; }
async function selectProject(page, id, name) { await page.getByTestId("project-work-button").first().click(); await page.getByTestId(`project-option-${id}`).click(); await page.getByTestId("project-work-button").filter({ hasText: name }).waitFor({ state: "visible", timeout: 30_000 }); }
async function removeProject(page, name, id) { const project = byProject(page, name); await project.waitFor({ state: "visible", timeout: 30_000 }); await project.hover(); await page.getByTestId(`project-menu-${id}`).click(); await page.getByTestId(`remove-project-${id}`).click(); await page.getByTestId(`remove-project-dialog-${id}-confirm-button`).click(); await page.locator(`[data-testid="project-row-${id}"]:visible`).waitFor({ state: "detached", timeout: 30_000 }); }
function observe(page, evidence) { page.on("pageerror", e => evidence.diagnostics.console.push({ type: "pageerror", text: e.message })); page.on("console", m => { if (["error", "warning"].includes(m.type())) evidence.diagnostics.console.push({ type: m.type(), text: m.text() }); }); page.on("response", r => { if (r.status() >= 400) evidence.diagnostics.failedResponses.push({ status: r.status(), path: new URL(r.url()).pathname }); }); page.on("requestfailed", r => evidence.diagnostics.requestFailures.push({ error: r.failure()?.errorText, path: new URL(r.url()).pathname })); page.on("websocket", s => s.on("socketerror", e => evidence.diagnostics.socketErrors.push({ text: String(e) }))); }
function assertDiagnostics(e) { assert.deepEqual(e.diagnostics.console, []); assert.deepEqual(e.diagnostics.failedResponses, []); assert.deepEqual(e.diagnostics.requestFailures, []); assert.deepEqual(e.diagnostics.socketErrors, []); }
async function shot(page, context, name) { const path = context.pathInCase("system-chromium", "right-workspace-multitool", name); await mkdir(dirname(path), { recursive: true }); await page.screenshot({ path, fullPage: true }); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
