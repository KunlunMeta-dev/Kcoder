import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "workspace-files-terminal-app-server-offline-interruption-recovery",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; real isolated Gateway and app-server",
  retainSuccessLogs: true,
}, async context => {
  const stamp = Date.now();
  const projectName = `interrupt-recovery-${stamp}`;
  const evidence = {
    stage: "setup", projectName, steps: [], snapshots: [], probes: [], killed: [], cleanup: [],
    diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] },
  };
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "app-server-interruption" });
  const offlineFlag = context.pathInState("app-server.offline");
  const wrapper = context.pathInState("controlled-kcoder.sh");
  const realBin = resolve(repoRoot, "target/debug/kcoder");
  await writeFile(wrapper, `#!/bin/sh\nif [ -e '${escapeSingle(offlineFlag)}' ]; then echo 'E2E controlled app-server offline' >&2; exit 75; fi\nexec '${escapeSingle(realBin)}' "$@"\n`, { mode: 0o700 });
  await chmod(wrapper, 0o700);
  const gateway = await startGateway(context, {
    label: "workspace-interruption-gateway", workspace, kcoderBin: wrapper, auth: true,
    serversStore: context.pathInState("servers-store.json"),
  });
  const chromium = await startChromium(context, { label: "workspace-interruption-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  let projectId = "";
  let failure;

  try {
    await login(page, gateway);
    evidence.stage = "online-baseline";
    projectId = await createProject(page, workspace, projectName);
    await openFiles(page);
    await waitFilePath(page, workspace);
    await addTerminal(page);
    evidence.probes.push(await terminalProbe(page, workspace, `BASE_${stamp}`));
    evidence.snapshots.push(await snapshot(page, "online-baseline"));
    await shot(page, context, "01-online-baseline.png");

    evidence.stage = "startup-offline";
    await writeFile(offlineFlag, "offline\n");
    evidence.killed.push({ stage: evidence.stage, pids: await killOwnedAppServers(gateway.child.pid) });
    await page.reload({ waitUntil: "domcontentloaded" });
    const startupFailure = page.getByText("工作台没准备好", { exact: true });
    await startupFailure.waitFor({ state: "visible", timeout: 30_000 });
    const offline = await snapshot(page, "startup-offline");
    evidence.snapshots.push(offline);
    await shot(page, context, "02-startup-offline.png");
    assert.match(offline.body, /app-server 连接已断开/);
    assert.match(offline.body, /再试一次/);

    evidence.stage = "startup-recovery";
    await rm(offlineFlag, { force: true });
    await page.getByText("再试一次", { exact: true }).click();
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await byProject(page, projectName).waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("right-workspace-file-tab").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("right-workspace-terminal-tab").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("right-workspace-file-tab").click();
    await waitFilePath(page, workspace);
    await page.getByTestId("right-workspace-terminal-tab").click();
    evidence.probes.push(await terminalProbe(page, workspace, `RECOVER_${stamp}`));
    evidence.snapshots.push(await snapshot(page, "startup-recovered"));
    await shot(page, context, "03-startup-recovered.png");

    evidence.stage = "runtime-interruption";
    await writeFile(offlineFlag, "offline\n");
    evidence.killed.push({ stage: evidence.stage, pids: await killOwnedAppServers(gateway.child.pid) });
    await page.getByTestId("right-workspace-file-tab").click();
    await page.getByTestId("workspace-file-refresh-button").click();
    await page.getByTestId("workspace-file-tree-retry-button").waitFor({ state: "visible", timeout: 30_000 });
    evidence.snapshots.push(await snapshot(page, "runtime-offline"));
    await shot(page, context, "04-runtime-offline.png");

    evidence.stage = "runtime-recovery";
    await rm(offlineFlag, { force: true });
    await page.getByTestId("workspace-file-tree-retry-button").click();
    await waitFilePath(page, workspace);
    await page.getByTestId("right-workspace-terminal-tab").click();
    evidence.probes.push(await terminalProbe(page, workspace, `RUNTIME_${stamp}`));
    const recovered = await snapshot(page, "runtime-recovered");
    evidence.snapshots.push(recovered);
    assert.equal(recovered.tabs.files, 1);
    assert.equal(recovered.tabs.terminal, 1);
    await shot(page, context, "05-runtime-recovered.png");
    evidence.stage = "passed";
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    evidence.failureSnapshot = await snapshot(page, `failure-${evidence.stage}`).catch(error => ({ error: String(error) }));
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    await rm(offlineFlag, { force: true });
    if (projectId) {
      try { await withTimeout(removeProject(page, projectName, projectId), 20_000, "project cleanup"); evidence.cleanup.push({ kind: "project", id: projectId, remaining: 0 }); }
      catch (error) { evidence.cleanup.push({ kind: "project", id: projectId, error: String(error) }); }
    }
    await context.writeArtifactJson("workspace-app-server-interruption-recovery.json", evidence);
  }
  if (failure) throw failure;
  return { steps: evidence.steps, snapshots: evidence.snapshots, probes: evidence.probes, killed: evidence.killed };
});

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
  const pathInput = picker.getByTestId("device-folder-path-input");
  await pathInput.fill(workspace);
  await pathInput.press("Enter");
  await page.waitForTimeout(300);
  assert.equal(await pathInput.inputValue(), workspace, "目录选择器没有稳定到目标绝对路径");
  await picker.getByTestId("confirm-device-folder-picker-button").click();
  const dialog = page.getByTestId("local-project-create-dialog");
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

async function openFiles(page) {
  await page.getByTestId("toggle-right-workspace-panel-button").click();
  await page.getByTestId("right-workspace-file-option").click();
  await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30_000 });
}

async function addTerminal(page) {
  await page.getByTestId("right-workspace-new-tab-button").click();
  await page.getByTestId("right-workspace-new-tab-menu").getByTestId("right-workspace-terminal-option").click();
  await visibleTerminal(page).waitFor({ state: "visible", timeout: 30_000 });
}

function visibleTerminal(page) { return page.locator('[data-testid="remote-terminal"]:visible, [data-testid="embedded-local-terminal"]:visible').first(); }

async function terminalProbe(page, workspace, marker) {
  const terminal = visibleTerminal(page);
  await terminal.waitFor({ state: "visible", timeout: 30_000 });
  const input = terminal.locator("textarea.xterm-helper-textarea").first();
  await input.click();
  const command = `if [ "$PWD" = '${escapeSingle(resolve(workspace))}' ] && [ -r README.md ]; then k=OK; else k=BAD; fi; printf '__K%s_${marker}__\\n' "$k"`;
  await page.keyboard.insertText(command);
  await page.keyboard.press("Enter");
  const rows = terminal.locator(".xterm-rows").first();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const output = await rows.innerText().catch(() => "");
    if (output.includes(`__KOK_${marker}__`)) return { marker, status: "OK", workspace: resolve(workspace), kind: await terminal.getAttribute("data-testid") };
    if (output.includes(`__KBAD_${marker}__`)) throw new Error(`terminal cwd mismatch for ${marker}`);
    await page.waitForTimeout(100);
  }
  throw new Error(`terminal probe timeout for ${marker}`);
}

async function waitFilePath(page, expected) {
  await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = (await page.getByTestId("workspace-file-path").innerText().catch(() => "")).trim();
    if (value && resolve(value) === resolve(expected) && !(await page.getByTestId("workspace-file-tree-retry-button").isVisible().catch(() => false))) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Files did not recover expected path ${resolve(expected)}`);
}

async function snapshot(page, label) {
  return page.evaluate(snapshotLabel => {
    const text = selector => document.querySelector(selector)?.textContent?.trim() || "";
    return {
      label: snapshotLabel,
      body: document.body.innerText.slice(0, 4000),
      project: text('[data-testid="project-work-button"]'),
      path: text('[data-testid="workspace-file-path"]'),
      fileError: text('[data-testid="workspace-file-tree"]').slice(0, 2000),
      tabs: {
        files: document.querySelectorAll('[data-testid="right-workspace-file-tab"]').length,
        terminal: document.querySelectorAll('[data-testid="right-workspace-terminal-tab"]').length,
      },
      terminalOutput: text('[data-testid="remote-terminal"] .xterm-rows, [data-testid="embedded-local-terminal"] .xterm-rows').slice(-2000),
    };
  }, label);
}

async function killOwnedAppServers(gatewayPid) {
  const entries = await readdir("/proc", { withFileTypes: true });
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const [stat, cmd] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""), readFile(`/proc/${pid}/cmdline`).catch(() => null)]);
    const ppid = Number(stat.match(/^\d+ \(.+\) \S (\d+)/)?.[1] || 0);
    processes.push({ pid, ppid, cmd: cmd?.toString("utf8").replaceAll("\0", " ") || "" });
  }
  const descendants = new Set([gatewayPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) if (descendants.has(item.ppid) && !descendants.has(item.pid)) { descendants.add(item.pid); changed = true; }
  }
  const targets = processes.filter(item => descendants.has(item.pid) && /\bapp-server\b/.test(item.cmd)).map(item => item.pid);
  assert.ok(targets.length > 0, `isolated gateway ${gatewayPid} has no app-server descendant`);
  for (const pid of targets) { try { process.kill(pid, "SIGKILL"); } catch {} }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && targets.some(isAlive)) await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  assert.equal(targets.some(isAlive), false, `owned app-server did not exit: ${targets.join(",")}`);
  return targets;
}

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
function escapeSingle(value) { return String(value).replaceAll("'", `'\\''`); }
function byProject(page, name) { return page.getByTestId("project-item").filter({ hasText: name }).first(); }

async function removeProject(page, name, id) {
  const project = byProject(page, name);
  await project.hover();
  await page.getByTestId(`project-menu-${id}`).click();
  await page.getByTestId(`remove-project-${id}`).click();
  await page.getByTestId(`remove-project-dialog-${id}-confirm-button`).click();
  await page.locator(`[data-testid="project-row-${id}"]:visible`).waitFor({ state: "detached", timeout: 30_000 });
}

function observe(page, evidence) {
  const note = () => ({ stage: evidence.stage, at: new Date().toISOString() });
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000), ...note() }));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000), ...note() }); });
  page.on("response", response => { if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname, ...note() }); });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname, ...note() }));
  page.on("websocket", socket => socket.on("socketerror", error => evidence.diagnostics.socketErrors.push({ text: String(error).slice(0, 500), ...note() })));
}

async function shot(page, context, name) {
  const path = context.pathInCase("system-chromium", "workspace-app-server-interruption", name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
