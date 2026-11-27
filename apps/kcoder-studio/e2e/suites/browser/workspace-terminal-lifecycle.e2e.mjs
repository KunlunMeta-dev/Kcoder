import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "workspace-terminal-cwd-panel-reopen-and-refresh-recovery",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway, app-server, and PTY",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const projectName = `terminal-e2e-${stamp}`;
  const evidence = {
    stage: "setup",
    projectName,
    expectedWorkspace: "",
    steps: [],
    terminalProbes: [],
    terminalGeometry: [],
    cleanup: [],
    diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] },
  };
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "workspace-terminal-lifecycle" });
  evidence.expectedWorkspace = resolve(workspace);
  const gateway = await startGateway(context, { label: "workspace-terminal-lifecycle-gateway", workspace, auth: true });
  const chromium = await startChromium(context, { label: "workspace-terminal-lifecycle" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  let projectId = "";
  let failure;

  try {
    await login(page, gateway);
    evidence.stage = "create-project";
    projectId = await createProject(page, workspace, projectName);
    await page.getByTestId("project-work-button").filter({ hasText: projectName }).waitFor({ state: "visible", timeout: 30_000 });
    evidence.steps.push({ label: "project-created-and-selected", projectId });

    evidence.stage = 'terminal-color-preferences';
    await page.goto(`${gateway.baseUrl}/settings/appearance`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('appearance-mode-light').click();
    await page.getByTestId('appearance-terminal-foreground-light').evaluate(element => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, '#123456');
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--kcoder-terminal-foreground') === '18 52 86');
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await page.getByTestId('appearance-terminal-foreground-light').inputValue(), '#123456');
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 30000 });

    evidence.stage = "open-terminal";
    await openRightTerminal(page);
    evidence.terminalProbes.push(await runTerminalProbe(page, workspace, `initial-${stamp}`));
    evidence.terminalGeometry.push(await readTerminalGeometry(page, "initial"));
    evidence.steps.push({ label: "initial-terminal-cwd-correct" });
    evidence.stage = 'terminal-light-contrast';
    const terminal = visibleTerminal(page);
    await terminal.locator('textarea.xterm-helper-textarea').first().click();
    await page.keyboard.insertText("printf '\\033[97mANSI_%s\\033[0m\\n\\033[38;2;255;255;255mRGB_%s\\033[0m\\n' WHITE WHITE");
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.xterm-rows')?.innerText.includes('RGB_WHITE'));
    const colors = await terminal.locator('.xterm-rows').evaluate(rows => ['ANSI_WHITE', 'RGB_WHITE'].map(marker => {
      const span = [...rows.querySelectorAll('span')].find(node => node.textContent.includes(marker));
      return { marker, foreground: span ? getComputedStyle(span).color : null };
    }));
    for (const color of colors) {
      assert.ok(color.foreground, `Missing terminal output ${color.marker}`);
      const rgb = color.foreground.match(/\d+/g).slice(0, 3).map(Number).map(value => value / 255);
      const linear = rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      const luminance = linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
      assert.ok(1.05 / (luminance + .05) >= 4.4, `${color.marker} lacks light-theme contrast: ${color.foreground}`);
    }
    evidence.steps.push({ label: 'terminal-ansi-and-truecolor-readable', colors });
    await shot(page, context, "01-terminal-initial.png");

    evidence.stage = "close-reopen-panel";
    await page.getByTestId("toggle-right-workspace-panel-button").click();
    await page.getByTestId("workspace-terminal-window").waitFor({ state: "hidden", timeout: 30_000 });
    evidence.terminalGeometry.push(await readTerminalGeometry(page, "hidden"));
    await page.getByTestId("toggle-right-workspace-panel-button").click();
    await page.getByTestId("workspace-terminal-window").waitFor({ state: "visible", timeout: 30_000 });
    evidence.terminalGeometry.push(await readTerminalGeometry(page, "reopen-before-command"));
    evidence.terminalProbes.push(await runTerminalProbe(page, workspace, `reopen-${stamp}`));
    evidence.steps.push({ label: "panel-reopen-preserved-terminal" });
    await shot(page, context, "02-terminal-panel-reopened.png");

    evidence.stage = "refresh-page";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await byProject(page, projectName).waitFor({ state: "visible", timeout: 30_000 });
    await selectComposerProject(page, projectId, projectName);
    const refreshRecovery = await recoverTerminalAfterRefresh(page);
    evidence.steps.push({ label: "terminal-recovered-after-refresh", ...refreshRecovery });
    evidence.terminalProbes.push(await runTerminalProbe(page, workspace, `refresh-${stamp}`));
    await shot(page, context, "03-terminal-refresh-recovered.png");

    evidence.stage = "close-terminal-panel";
    await page.getByTestId("toggle-right-workspace-panel-button").click();
    await page.getByTestId("workspace-terminal-window").waitFor({ state: "hidden", timeout: 30_000 });
    evidence.steps.push({ label: "terminal-panel-closed-before-cleanup" });

    evidence.stage = "remove-project";
    await removeProject(page, projectName, projectId);
    projectId = "";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(500);
    assert.equal(await byProject(page, projectName).count(), 0);
    assertDiagnostics(evidence);
    evidence.steps.push({ label: "project-removed-and-not-restored" });
    evidence.stage = "passed";
    await shot(page, context, "04-clean.png");
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    if (projectId) {
      try {
        await removeProject(page, projectName, projectId);
        evidence.cleanup.push({ kind: "project", id: projectId, remaining: 0 });
      } catch (error) {
        evidence.cleanup.push({ kind: "project", id: projectId, error: String(error) });
      }
    }
    await context.writeArtifactJson("workspace-terminal-lifecycle.json", evidence);
  }
  if (failure) throw failure;
  return { steps: evidence.steps, terminalProbes: evidence.terminalProbes, diagnostics: evidence.diagnostics, cleanup: evidence.cleanup };
});

async function openRightTerminal(page) {
  if (await page.getByTestId("workspace-terminal-window").isVisible().catch(() => false)) return;
  if (!(await page.getByTestId("right-workspace-launcher").isVisible().catch(() => false))) {
    await page.getByTestId("toggle-right-workspace-panel-button").click();
  }
  if (await page.getByTestId("workspace-terminal-window").isVisible().catch(() => false)) return;
  await page.getByTestId("right-workspace-launcher").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("right-workspace-terminal-option").click();
  await page.getByTestId("workspace-terminal-window").waitFor({ state: "visible", timeout: 30_000 });
  await visibleTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
}

async function recoverTerminalAfterRefresh(page) {
  if (await page.getByTestId("workspace-terminal-window").isVisible().catch(() => false)) return { recovery: "already-visible" };
  if (await page.getByTestId("right-workspace-launcher").isVisible().catch(() => false)) {
    await page.getByTestId("right-workspace-terminal-option").click();
    await page.getByTestId("workspace-terminal-window").waitFor({ state: "visible", timeout: 30_000 });
    return { recovery: "launcher" };
  }
  await page.getByTestId("toggle-right-workspace-panel-button").click();
  if (await page.getByTestId("workspace-terminal-window").isVisible().catch(() => false)) return { recovery: "panel-restored" };
  await page.getByTestId("right-workspace-launcher").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("right-workspace-terminal-option").click();
  await page.getByTestId("workspace-terminal-window").waitFor({ state: "visible", timeout: 30_000 });
  return { recovery: "panel-launcher" };
}

function visibleTerminal(page) {
  return page.locator('[data-testid="remote-terminal"]:visible, [data-testid="embedded-local-terminal"]:visible').first();
}

async function readTerminalGeometry(page, label) {
  const terminal = page.locator('[data-testid="remote-terminal"], [data-testid="embedded-local-terminal"]').first();
  return terminal.evaluate((root, geometryLabel) => {
    const elementDetails = (element, selector) => {
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        selector,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        display: style.display,
        visibility: style.visibility,
        transform: style.transform,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      };
    };
    const details = selector => elementDetails(root.querySelector(selector), selector);
    const rows = [...root.querySelectorAll('.xterm-rows > div')].slice(0, 6).map(row => {
      const rect = row.getBoundingClientRect();
      return { text: row.textContent?.slice(0, 160) ?? "", rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    });
    const canvases = [...root.querySelectorAll('canvas')].map(canvas => {
      const rect = canvas.getBoundingClientRect();
      return { width: canvas.width, height: canvas.height, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: canvas.getAttribute("style") };
    });
    return {
      label: geometryLabel,
      hidden: root.hidden,
      ariaHidden: root.getAttribute('aria-hidden'),
      inlineStyle: root.getAttribute('style'),
      root: elementDetails(root, ':scope'),
      xterm: details('.xterm'),
      screen: details('.xterm-screen'),
      viewport: details('.xterm-viewport'),
      rowsContainer: details('.xterm-rows'),
      rows,
      canvases,
    };
  }, label);
}

async function runTerminalProbe(page, expectedWorkspace, marker) {
  const terminal = visibleTerminal(page);
  await terminal.waitFor({ state: "visible", timeout: 30_000 });
  const input = terminal.locator("textarea.xterm-helper-textarea").first();
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.click();
  const probeId = `${marker.slice(0, 3)}${marker.slice(-5)}`;
  const quotedExpected = shellSingleQuote(resolve(expectedWorkspace));
  const command = `if [ "$PWD" = ${quotedExpected} ] && [ -r README.md ]; then kcoder_probe=OK; else kcoder_probe=BAD; fi; printf '__K%s_${probeId}__\\n' "$kcoder_probe"`;
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
  const status = await waitForTerminalStatus(terminal, probeId);
  assert.equal(status, "OK", `shell 内 cwd/README 检查失败：${status}`);
  return { marker, probeId, status, expectedWorkspace: resolve(expectedWorkspace), cwdMatches: true, readOnlyFileCheck: "yes", terminalKind: await terminal.getAttribute("data-testid") };
}

async function waitForTerminalStatus(terminal, probeId) {
  const rows = terminal.locator(".xterm-rows").first();
  const deadline = Date.now() + 30_000;
  let output = "";
  while (Date.now() < deadline) {
    output = await rows.innerText().catch(() => "");
    const lines = output.split("\n").map(line => line.trim());
    if (lines.includes(`__KOK_${probeId}__`)) return "OK";
    if (lines.includes(`__KBAD_${probeId}__`)) return "BAD";
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`终端输出超时，未看到 probe ${probeId}；当前输出：${output.slice(-2000)}`);
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function observe(page, evidence) {
  const details = () => ({ stage: evidence.stage, at: new Date().toISOString(), url: page.url() });
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000), ...details() }));
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000), ...details() });
  });
  page.on("response", response => { if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname, ...details() }); });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname, ...details() }));
  page.on("websocket", socket => socket.on("socketerror", error => evidence.diagnostics.socketErrors.push({ text: String(error).slice(0, 500), ...details() })));
}

function assertDiagnostics(evidence) {
  assert.deepEqual(evidence.diagnostics.console, [], "终端流程出现 console warning/error");
  assert.deepEqual(evidence.diagnostics.failedResponses, [], "终端流程出现 4xx/5xx");
  assert.deepEqual(evidence.diagnostics.requestFailures, [], "终端流程出现 request failure");
  assert.deepEqual(evidence.diagnostics.socketErrors, [], "终端流程出现 WebSocket error");
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
  const path = context.pathInCase("system-chromium", "workspace-terminal-lifecycle", name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
