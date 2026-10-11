import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "project-rename-multi-root-switch-file-terminal-refresh-sync",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway, app-server, files, and PTY",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const originalName = `multi-alpha-${stamp}`;
  const renamedName = `multi-alpha-renamed-${stamp}`;
  const betaName = `multi-beta-${stamp}`;
  const evidence = { stage: "setup", steps: [], targets: [], probes: [], selections: [], rpc: [], cleanup: [], diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] } };
  const [{ path: rootA }, { path: rootB }, { path: rootC }] = await Promise.all([
    materializeWorkspace(context, "minimal", { instanceId: "multi-root-a" }),
    materializeWorkspace(context, "minimal", { instanceId: "multi-root-b" }),
    materializeWorkspace(context, "minimal", { instanceId: "multi-root-c" }),
  ]);
  const gateway = await startGateway(context, { label: "project-multi-root-target-sync-gateway", workspace: rootA, auth: true });
  const chromium = await startChromium(context, { label: "project-multi-root-target-sync" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  const projects = [];
  let failure;

  try {
    await login(page, gateway);
    evidence.stage = "create-projects";
    const alphaId = await createProject(page, rootA, originalName);
    projects.push({ id: alphaId, name: originalName });
    const betaId = await createProject(page, rootC, betaName);
    projects.push({ id: betaId, name: betaName });
    evidence.steps.push({ label: "two-projects-created", alphaId, betaId });

    evidence.stage = "edit-alpha";
    await editProject(page, alphaId, originalName, renamedName, rootB);
    projects[0].name = renamedName;
    await byProject(page, renamedName).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await byProject(page, originalName).count(), 0);
    evidence.steps.push({ label: "alpha-renamed-and-root-b-primary" });

    evidence.stage = "alpha-file-target";
    await selectComposerProject(page, alphaId, renamedName);
    evidence.selections.push(await readProjectWorkspaceSelection(page, "alpha-after-edit"));
    await openRightFiles(page);
    evidence.targets.push(await assertFileTarget(page, renamedName, rootB, "alpha"));
    await shot(page, context, "01-alpha-root-b.png");

    evidence.stage = "beta-file-target";
    await selectComposerProject(page, betaId, betaName);
    evidence.targets.push(await waitForFileTarget(page, betaName, rootC, "beta"));

    evidence.stage = "alpha-file-target-again";
    await selectComposerProject(page, alphaId, renamedName);
    evidence.targets.push(await waitForFileTarget(page, renamedName, rootB, "alpha-again"));

    evidence.stage = "alpha-terminal";
    await openTerminalTab(page);
    evidence.probes.push(await runTerminalProbe(page, rootB, `alpha-${stamp}`));

    evidence.stage = "beta-terminal";
    await selectComposerProject(page, betaId, betaName);
    evidence.probes.push(await runTerminalProbe(page, rootC, `beta-${stamp}`));

    evidence.stage = "alpha-terminal-again";
    await selectComposerProject(page, alphaId, renamedName);
    evidence.probes.push(await runTerminalProbe(page, rootB, `alpha2-${stamp}`));
    await shot(page, context, "02-terminal-target-switch.png");

    evidence.stage = "refresh-alpha";
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await byProject(page, renamedName).waitFor({ state: "visible", timeout: 30_000 });
    await byProject(page, betaName).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await byProject(page, originalName).count(), 0);
    await selectComposerProject(page, alphaId, renamedName);
    await openRightFiles(page);
    evidence.targets.push(await assertFileTarget(page, renamedName, rootB, "alpha-after-refresh"));
    evidence.steps.push({ label: "rename-roots-and-targets-survive-refresh" });
    await shot(page, context, "03-refresh-alpha-root-b.png");

    evidence.stage = "cleanup";
    await page.getByTestId("toggle-right-workspace-panel-button").click();
    for (const project of [...projects].reverse()) {
      await removeProject(page, project.name, project.id);
      projects.splice(projects.findIndex(item => item.id === project.id), 1);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await byProject(page, renamedName).count(), 0);
    assert.equal(await byProject(page, betaName).count(), 0);
    assertDiagnostics(evidence);
    evidence.steps.push({ label: "projects-removed-after-refresh" });
    evidence.stage = "passed";
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    for (const project of [...projects].reverse()) {
      try { await removeProject(page, project.name, project.id); evidence.cleanup.push({ kind: "project", ...project, remaining: 0 }); }
      catch (error) { evidence.cleanup.push({ kind: "project", ...project, error: String(error) }); }
    }
    await context.writeArtifactJson("project-multi-root-target-sync.json", evidence);
  }
  if (failure) throw failure;
  return { steps: evidence.steps, targets: evidence.targets, probes: evidence.probes, diagnostics: evidence.diagnostics, cleanup: evidence.cleanup };
});

async function editProject(page, id, oldName, newName, additionalRoot) {
  const project = byProject(page, oldName);
  await project.hover();
  await page.getByTestId(`project-menu-${id}`).click();
  await page.getByTestId(`edit-project-${id}`).click();
  const dialog = page.getByTestId("local-project-edit-dialog");
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await dialog.getByTestId("local-project-name-input").fill(newName);
  await dialog.getByTestId("add-local-project-folders").click();
  const picker = dialog.getByTestId("local-project-folder-picker");
  await picker.getByTestId("device-folder-path-input").fill(additionalRoot);
  await picker.getByTestId("device-folder-path-input").press("Enter");
  await page.waitForTimeout(300);
  await picker.getByTestId("confirm-device-folder-picker-button").click();
  await dialog.getByTestId("local-project-root-1").waitFor({ state: "visible", timeout: 30_000 });
  await dialog.getByTestId("make-primary-root-1").click();
  assert.match(await dialog.getByTestId("local-project-root-0").innerText(), /multi-root-b/);
  await dialog.getByTestId("save-local-project-button").click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
}

async function openRightFiles(page) {
  const shell = page.getByTestId("right-workspace-panel-shell");
  if ((await shell.getAttribute("aria-hidden").catch(() => "true")) === "true") {
    await page.getByTestId("toggle-right-workspace-panel-button").click();
  }
  if (await page.getByTestId("workspace-file-tree").isVisible().catch(() => false)) return;
  if (await page.getByTestId("right-workspace-file-tab").count()) {
    await page.getByTestId("right-workspace-file-tab").click();
  } else if (await page.getByTestId("right-workspace-launcher").isVisible().catch(() => false)) {
    await page.getByTestId("right-workspace-file-option").click();
  } else {
    await page.getByTestId("right-workspace-new-tab-button").click();
    await page.getByTestId("right-workspace-new-tab-menu").getByTestId("right-workspace-file-option").click();
  }
  await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30_000 });
}

async function assertFileTarget(page, projectName, expectedPath, label) {
  const actual = (await page.getByTestId("workspace-file-path").innerText()).trim();
  assert.equal(resolve(actual), resolve(expectedPath), `${label} 文件目标错误`);
  assert.match((await page.getByTestId("project-work-button").first().innerText()).trim(), new RegExp(projectName));
  return { label, projectName, expectedPath: resolve(expectedPath), actualPath: resolve(actual), matches: true };
}

async function waitForFileTarget(page, projectName, expectedPath, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const actual = (await page.getByTestId("workspace-file-path").innerText().catch(() => "")).trim();
    if (actual && resolve(actual) === resolve(expectedPath)) return assertFileTarget(page, projectName, expectedPath, label);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  return assertFileTarget(page, projectName, expectedPath, label);
}

async function openTerminalTab(page) {
  await page.getByTestId("right-workspace-new-tab-button").click();
  const menu = page.getByTestId("right-workspace-new-tab-menu");
  await menu.waitFor({ state: "visible", timeout: 30_000 });
  await menu.getByTestId("right-workspace-terminal-option").click();
  await visibleTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
}

function visibleTerminal(page) { return page.locator('[data-testid="remote-terminal"]:visible, [data-testid="embedded-local-terminal"]:visible').first(); }

async function runTerminalProbe(page, expectedWorkspace, marker) {
  const terminal = visibleTerminal(page);
  await terminal.waitFor({ state: "visible", timeout: 30_000 });
  const input = terminal.locator("textarea.xterm-helper-textarea").first();
  await input.waitFor({ state: "visible", timeout: 30_000 });
  await input.click();
  const probeId = `${marker.slice(0, 3)}${marker.slice(-5)}`;
  const quotedExpected = `'${resolve(expectedWorkspace).replaceAll("'", `'\\''`)}'`;
  const command = `if [ "$PWD" = ${quotedExpected} ] && [ -r README.md ]; then kcoder_probe=OK; else kcoder_probe=BAD; fi; printf '__K%s_${probeId}__\\n' "$kcoder_probe"`;
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
  const rows = terminal.locator(".xterm-rows").first();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const lines = (await rows.innerText().catch(() => "")).split("\n").map(line => line.trim());
    if (lines.includes(`__KOK_${probeId}__`)) return { marker, probeId, status: "OK", expectedWorkspace: resolve(expectedWorkspace), terminalKind: await terminal.getAttribute("data-testid") };
    if (lines.includes(`__KBAD_${probeId}__`)) throw new Error(`终端目标错误：${marker}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`终端目标 probe ${probeId} 超时`);
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
      if (/runtime\.projects|projectRoots|\"roots\"/i.test(text)) evidence.rpc.push({ direction, text: text.slice(0, 20_000), ...details() });
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

async function readProjectWorkspaceSelection(page, label) {
  const options = page.locator('[data-testid^="project-workspace-option-"]:visible');
  const items = [];
  for (let index = 0; index < await options.count(); index += 1) {
    const option = options.nth(index);
    items.push({
      testId: await option.getAttribute("data-testid"),
      text: (await option.innerText()).trim(),
      className: await option.getAttribute("class"),
      checkCount: await option.locator("svg.lucide-check").count(),
    });
  }
  return {
    label,
    projectButton: (await page.getByTestId("project-work-button").first().innerText()).trim(),
    visibleWorkspaceOptions: items,
  };
}

async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  const input = page.locator('input[name="token"]');
  if (await input.count()) { await input.fill(gateway.authToken); await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login"), { timeout: 30_000 }), page.locator('button[type="submit"]').click()]); }
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

async function selectComposerProject(page, id, name) {
  await page.getByTestId("project-work-button").first().click();
  await page.getByTestId(`project-option-${id}`).click();
  await page.getByTestId("project-work-button").filter({ hasText: name }).waitFor({ state: "visible", timeout: 30_000 });
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

async function shot(page, context, name) { const path = context.pathInCase("system-chromium", "project-multi-root-target-sync", name); await mkdir(dirname(path), { recursive: true }); await page.screenshot({ path, fullPage: true }); }
