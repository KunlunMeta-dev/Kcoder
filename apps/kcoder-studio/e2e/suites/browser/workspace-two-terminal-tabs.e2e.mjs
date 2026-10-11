import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "workspace-two-terminal-tabs-isolation-close-reopen-refresh",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway, app-server, and PTYs",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const projectName = `two-terminal-e2e-${stamp}`;
  const evidence = {
    stage: "setup",
    projectName,
    expectedWorkspace: "",
    steps: [],
    tabs: [],
    terminalSessions: [],
    refreshedSession: null,
    terminalProbes: [],
    rpc: [],
    cleanup: [],
    diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] },
  };
  const fixture = await materializeWorkspace(context, "minimal", { instanceId: "workspace-two-terminal-tabs" });
  const workspace = resolve(fixture.path);
  evidence.expectedWorkspace = workspace;
  const gateway = await startGateway(context, {
    label: "workspace-two-terminal-tabs-gateway",
    workspace,
    auth: true,
    serversStore: context.pathInState("servers-store.json"),
  });
  const chromium = await startChromium(context, { label: "workspace-two-terminal-tabs" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  let projectId = "";
  let failure;

  try {
    await login(page, gateway);
    evidence.stage = "create-project";
    projectId = await createProject(page, workspace, projectName);
    evidence.steps.push({ label: "project-created-and-selected", projectId });

    evidence.stage = "terminal-1";
    const panel = await ensureBottomPanelWithTerminal(page);
    await expectTabCount(page, 1);
    const tab1 = await activeTabSnapshot(page, "terminal-1-initial");
    evidence.tabs.push(tab1);
    evidence.terminalProbes.push(await probeActiveTerminal(page, workspace, `ONE_${stamp}`, []));
    await shot(page, context, "01-terminal-1.png");

    evidence.stage = "terminal-2";
    await page.getByTestId("workspace-terminal-new-tab-button").click();
    const addMenu = page.getByTestId("workspace-terminal-new-tab-menu");
    await addMenu.waitFor({ state: "visible", timeout: 30_000 });
    await addMenu.getByTestId("workspace-add-terminal-option").click();
    await expectTabCount(page, 2);
    const tab2 = await activeTabSnapshot(page, "terminal-2-initial");
    evidence.tabs.push(tab2);
    evidence.terminalSessions = await expectTerminalSessionCount(evidence, 2);
    assert.notEqual(evidence.terminalSessions[0], evidence.terminalSessions[1], "两个终端标签应连接到不同 PTY session");
    evidence.terminalProbes.push(await probeActiveTerminal(page, workspace, `TWO_${stamp}`, [`ONE_${stamp}`]));
    await shot(page, context, "02-terminal-2.png");

    evidence.stage = "switch-to-terminal-1";
    await terminalTabs(page).nth(0).click();
    const oneReturn = await assertActiveOutput(page, `ONE_${stamp}`, [`TWO_${stamp}`], "terminal-1-return");
    evidence.tabs.push(await activeTabSnapshot(page, "terminal-1-return"));
    evidence.terminalProbes.push(oneReturn);
    evidence.terminalProbes.push(await probeActiveTerminal(page, workspace, `ONE_AGAIN_${stamp}`, [`TWO_${stamp}`]));
    await shot(page, context, "03-terminal-1-return.png");

    evidence.stage = "switch-to-terminal-2";
    await terminalTabs(page).nth(1).click();
    evidence.tabs.push(await activeTabSnapshot(page, "terminal-2-return"));
    evidence.terminalProbes.push(await assertActiveOutput(page, `TWO_${stamp}`, [`ONE_AGAIN_${stamp}`], "terminal-2-return"));
    evidence.terminalProbes.push(await probeActiveTerminal(page, workspace, `TWO_AGAIN_${stamp}`, [`ONE_AGAIN_${stamp}`]));
    await shot(page, context, "04-terminal-2-return.png");

    evidence.stage = "close-terminal-2";
    const secondTab = terminalTabs(page).nth(1);
    await secondTab.hover();
    await secondTab.getByTestId("close-bottom-workspace-tab-button").click();
    await expectTabCount(page, 1);
    evidence.tabs.push(await activeTabSnapshot(page, "after-terminal-2-close"));
    evidence.terminalProbes.push(await assertActiveOutput(page, `ONE_AGAIN_${stamp}`, [`TWO_AGAIN_${stamp}`], "terminal-1-after-terminal-2-close"));
    evidence.terminalProbes.push(await probeActiveTerminal(page, workspace, `ONE_AFTER_CLOSE_${stamp}`, [`TWO_AGAIN_${stamp}`]));
    await shot(page, context, "05-terminal-2-closed.png");

    evidence.stage = "close-reopen-bottom-panel";
    if ((await panel.getAttribute("aria-hidden")) !== "true") {
      await page.getByTestId("close-bottom-workspace-panel-button").click();
    }
    await expectAriaHidden(panel, "true");
    await ensureBottomPanelOpen(page);
    await expectAriaHidden(panel, "false");
    await expectTabCount(page, 1);
    evidence.terminalProbes.push(await assertActiveOutput(page, `ONE_AFTER_CLOSE_${stamp}`, [`TWO_AGAIN_${stamp}`], "terminal-1-after-panel-reopen"));
    evidence.terminalProbes.push(await probeActiveTerminal(page, workspace, `ONE_REOPEN_${stamp}`, [`TWO_AGAIN_${stamp}`]));
    await shot(page, context, "06-panel-reopened.png");

    evidence.stage = "refresh";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await byProject(page, projectName).waitFor({ state: "visible", timeout: 30_000 });
    await selectComposerProject(page, projectId, projectName);
    const refreshedPanel = await ensureBottomPanelWithTerminal(page);
    await expectAriaHidden(refreshedPanel, "false");
    await expectTabCount(page, 1);
    evidence.tabs.push(await activeTabSnapshot(page, "after-refresh"));
    evidence.refreshedSession = await expectRefreshedTerminalSession(evidence, workspace);
    evidence.terminalProbes.push(await probeActiveTerminal(page, workspace, `ONE_REFRESH_${stamp}`, []));
    evidence.steps.push({ label: "two-tabs-isolated-single-close-reopen-refresh-passed" });
    await shot(page, context, "07-refresh-recovered.png");

    evidence.stage = "cleanup";
    await page.getByTestId("close-bottom-workspace-panel-button").click();
    await removeProject(page, projectName, projectId);
    projectId = "";
    assert.equal(await byProject(page, projectName).count(), 0);
    assertDiagnostics(evidence);
    evidence.stage = "passed";
    await shot(page, context, "08-clean.png");
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    if (projectId) {
      try { await removeProject(page, projectName, projectId); evidence.cleanup.push({ kind: "project", id: projectId, remaining: 0 }); }
      catch (error) { evidence.cleanup.push({ kind: "project", id: projectId, error: String(error) }); }
    }
    await context.writeArtifactJson("workspace-two-terminal-tabs.json", evidence);
  }
  if (failure) throw failure;
  return { steps: evidence.steps, tabs: evidence.tabs, terminalSessions: evidence.terminalSessions, refreshedSession: evidence.refreshedSession, terminalProbes: evidence.terminalProbes, rpc: evidence.rpc, diagnostics: evidence.diagnostics, cleanup: evidence.cleanup };
});

function terminalTabs(page) { return page.getByTestId("bottom-workspace-terminal-tab"); }
function activeTerminal(page) { return page.locator('[data-testid="remote-terminal"]:visible, [data-testid="embedded-local-terminal"]:visible').first(); }

async function ensureBottomPanelOpen(page) {
  const panel = page.getByTestId("bottom-workspace-panel");
  if ((await panel.getAttribute("aria-hidden").catch(() => null)) !== "false") {
    await page.getByTestId("toggle-bottom-workspace-panel-button").click();
  }
  await expectAriaHidden(panel, "false");
  return panel;
}

async function ensureBottomPanelWithTerminal(page) {
  const panel = await ensureBottomPanelOpen(page);
  if (await terminalTabs(page).count() === 0) {
    await page.getByTestId("workspace-terminal-new-tab-button").click();
    const addMenu = page.getByTestId("workspace-terminal-new-tab-menu");
    await addMenu.waitFor({ state: "visible", timeout: 30_000 });
    await addMenu.getByTestId("workspace-add-terminal-option").click();
  }
  await activeTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
  return panel;
}

async function activeTabSnapshot(page, label) {
  const tabs = terminalTabs(page);
  const count = await tabs.count();
  const values = [];
  for (let index = 0; index < count; index += 1) values.push({ index, title: await tabs.nth(index).getAttribute("title"), selected: await tabs.nth(index).getAttribute("aria-selected") });
  const activeIndex = values.findIndex(value => value.selected === "true");
  assert.notEqual(activeIndex, -1, `${label} 没有 active terminal tab`);
  return { label, count, activeIndex, title: values[activeIndex].title, values };
}

async function expectTabCount(page, expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await terminalTabs(page).count() === expected) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  assert.equal(await terminalTabs(page).count(), expected);
}

async function expectTerminalSessionCount(evidence, expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const sessionIds = terminalSessionIds(evidence.rpc);
    if (sessionIds.length >= expected) return sessionIds;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  const sessionIds = terminalSessionIds(evidence.rpc);
  assert.ok(sessionIds.length >= expected, `预期至少 ${expected} 个 terminal session，实际 ${sessionIds.length}`);
  return sessionIds;
}

function terminalSessionIds(rpc) {
  const ids = [];
  for (const entry of rpc) {
    let message;
    try { message = JSON.parse(entry.text); } catch { continue; }
    const sessionId = message?.result?.session_id;
    if (typeof sessionId === "string" && sessionId.startsWith("terminal-") && !ids.includes(sessionId)) ids.push(sessionId);
  }
  return ids;
}

async function expectRefreshedTerminalSession(evidence, expectedWorkspace) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (evidence.refreshedSession) {
      assert.equal(resolve(evidence.refreshedSession.cwd), resolve(expectedWorkspace), "刷新恢复的 terminal session cwd 应为隔离 workspace");
      return evidence.refreshedSession;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error("刷新后未观察到带 cwd 的 terminal session 响应");
}

async function expectAriaHidden(locator, expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await locator.getAttribute("aria-hidden") === expected) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  assert.equal(await locator.getAttribute("aria-hidden"), expected);
}

async function probeActiveTerminal(page, expectedWorkspace, marker, forbiddenMarkers) {
  const terminal = activeTerminal(page);
  await terminal.waitFor({ state: "visible", timeout: 30_000 });
  const input = terminal.locator("textarea.xterm-helper-textarea").first();
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.click();
  const quoted = `'${resolve(expectedWorkspace).replaceAll("'", `'\\''`)}'`;
  const command = `if [ "$PWD" = ${quoted} ] && [ -r README.md ]; then kcoder_probe=OK; else kcoder_probe=BAD; fi; printf '__K%s_${marker}__\\n' "$kcoder_probe"`;
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
  return waitForMarker(terminal, marker, forbiddenMarkers, "command");
}

async function assertActiveOutput(page, marker, forbiddenMarkers, label) {
  return waitForMarker(activeTerminal(page), marker, forbiddenMarkers, label);
}

async function waitForMarker(terminal, marker, forbiddenMarkers, label) {
  const rows = terminal.locator(".xterm-rows").first();
  const deadline = Date.now() + 30_000;
  let output = "";
  while (Date.now() < deadline) {
    output = await rows.innerText().catch(() => "");
    const lines = output.split("\n").map(line => line.trim());
    if (lines.includes(`__KBAD_${marker}__`)) throw new Error(`${label}: cwd/README probe BAD`);
    if (lines.includes(`__KOK_${marker}__`)) {
      for (const forbidden of forbiddenMarkers) assert.equal(lines.includes(`__KOK_${forbidden}__`), false, `${label}: 发现另一终端 marker ${forbidden}`);
      return { label, marker, status: "OK", forbiddenMarkers, outputTail: output.slice(-1600), terminalKind: await terminal.getAttribute("data-testid") };
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`${label}: marker ${marker} 超时；输出：${output.slice(-1600)}`);
}

function observe(page, evidence) {
  const details = () => ({ stage: evidence.stage, at: new Date().toISOString(), url: page.url() });
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000), ...details() }));
  page.on("console", message => { if (message.type() === "error" || message.type() === "warning") evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000), ...details() }); });
  page.on("response", response => { if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname, ...details() }); });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname, ...details() }));
  page.on("websocket", socket => {
    const record = (direction, payload) => {
      const text = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
      if (direction === "received" && evidence.stage === "refresh") {
        let message;
        try { message = JSON.parse(text); } catch {}
        if (typeof message?.result?.session_id === "string" && typeof message?.result?.cwd === "string") {
          evidence.refreshedSession = { sessionId: message.result.session_id, cwd: resolve(message.result.cwd) };
        }
      }
      if (/terminal|session_id|terminal_id|pty/i.test(text)) evidence.rpc.push({ direction, text: text.slice(0, 2000), ...details() });
    };
    socket.on("framesent", event => record("sent", event.payload));
    socket.on("framereceived", event => record("received", event.payload));
    socket.on("socketerror", error => evidence.diagnostics.socketErrors.push({ text: String(error).slice(0, 500), ...details() }));
  });
}

function assertDiagnostics(evidence) {
  assert.deepEqual(evidence.diagnostics.console, []);
  assert.deepEqual(evidence.diagnostics.failedResponses, []);
  assert.deepEqual(evidence.diagnostics.requestFailures, []);
  assert.deepEqual(evidence.diagnostics.socketErrors, []);
}

function byProject(page, name) { return page.getByTestId("project-item").filter({ hasText: name }).first(); }

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  const input = page.locator('input[name="token"]');
  if (await input.count()) {
    await input.fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
  }
  await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
}

async function createProject(page, workspace, name) {
  await page.getByTestId("projects-create-button").click();
  await page.getByTestId("project-create-local-option").click();
  const picker = page.getByTestId("standalone-folder-project-dialog");
  await picker.waitFor({ state: "visible", timeout: 30_000 });
  await picker.getByTestId("device-folder-path-input").fill(workspace);
  await picker.getByTestId("device-folder-path-input").press("Enter");
  await page.waitForTimeout(300);
  await picker.getByTestId("confirm-device-folder-picker-button").click();
  const dialog = page.getByTestId("local-project-create-dialog");
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await dialog.getByTestId("local-project-create-name-input").fill(name);
  await dialog.getByTestId("confirm-local-project-create-button").click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  const testId = await project.locator('[data-testid^="project-row-"]').first().getAttribute("data-testid");
  const id = testId?.replace("project-row-", "") || "";
  assert.match(id, /^\d+$/);
  return id;
}

async function selectComposerProject(page, projectId, projectName) {
  await page.getByTestId("project-work-button").first().click();
  await page.getByTestId(`project-option-${projectId}`).click();
  await page.getByTestId("project-work-button").filter({ hasText: projectName }).waitFor({ state: "visible", timeout: 30_000 });
}

async function removeProject(page, name, id) {
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 30_000 });
  await project.hover();
  await page.getByTestId(`project-menu-${id}`).click();
  await page.getByTestId(`remove-project-${id}`).click();
  await page.getByTestId(`remove-project-dialog-${id}-confirm-button`).click();
  await page.locator(`[data-testid="project-row-${id}"]:visible`).waitFor({ state: "detached", timeout: 30_000 });
}

async function shot(page, context, name) {
  const path = context.pathInCase("system-chromium", "workspace-two-terminal-tabs", name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
