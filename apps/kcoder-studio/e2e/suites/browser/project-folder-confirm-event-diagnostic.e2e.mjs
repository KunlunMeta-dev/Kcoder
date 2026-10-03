import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "project-folder-confirm-single-click-repeatable",
  tier: "browser-real-app-server",
  modelPolicy: "no model turn; isolated real Gateway and app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspaces = await Promise.all([
    materializeWorkspace(context, "minimal", { instanceId: "folder-confirm-first" }),
    materializeWorkspace(context, "minimal", { instanceId: "folder-confirm-repeat" }),
  ]);
  const evidence = {
    attempts: [],
    diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] },
  };
  const gateway = await startGateway(context, {
    label: "project-folder-confirm-gateway",
    workspace: workspaces[0].path,
    auth: true,
  });
  const chromium = await startChromium(context, { label: "project-folder-confirm-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  observe(page, evidence);
  const tracePath = context.pathInCase("system-chromium", "project-folder-confirm", "trace.zip");
  await mkdir(dirname(tracePath), { recursive: true });
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  let failure;

  try {
    await login(page, gateway);
    await installCaptureListeners(page);
    for (const [index, workspace] of workspaces.entries()) {
      evidence.attempts.push(await confirmWorkspaceOnce(page, context, workspace.path, index + 1));
    }
    assert.equal(evidence.attempts.length, 2);
    assert.equal(evidence.attempts.every(attempt => attempt.transitionedOnFirstClick), true);
    assertDiagnostics(evidence);
  } catch (error) {
    failure = error;
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    await shot(page, context, "failure.png").catch(() => undefined);
  } finally {
    await page.context().tracing.stop({ path: tracePath }).catch(error => { evidence.traceError = String(error); });
    await context.writeArtifactJson("project-folder-confirm-event-diagnostic.json", evidence);
  }
  if (failure) throw failure;
  return {
    attempts: evidence.attempts.map(attempt => ({
      label: attempt.label,
      selectedPath: attempt.selectedPath,
      eventCount: attempt.events.length,
      transitionedOnFirstClick: attempt.transitionedOnFirstClick,
      selectedRootPreserved: attempt.selectedRootPreserved,
    })),
    diagnostics: evidence.diagnostics,
  };
});

async function confirmWorkspaceOnce(page, context, workspace, ordinal) {
  const label = ordinal === 1 ? "first" : "repeat";
  await page.getByTestId("projects-create-button").click();
  await page.getByTestId("project-create-local-option").click();
  const picker = page.getByTestId("standalone-folder-project-dialog");
  await picker.waitFor({ state: "visible", timeout: 30_000 });
  const input = picker.getByTestId("device-folder-path-input");
  const confirm = picker.getByTestId("confirm-device-folder-picker-button");
  await resetCapture(page);
  await input.fill(workspace);
  await input.press("Enter");
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="confirm-device-folder-picker-button"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 30_000 });
  const before = await snapshot(page, `${label}-before-click`);
  assert.equal(before.inputValue, workspace);
  assert.equal(before.confirmDisabled, false);
  assert.equal(before.pickerCount, 1);
  assert.equal(before.createCount, 0);
  await shot(page, context, `${ordinal}-before-click.png`);

  await confirm.click();
  const createDialog = page.getByTestId("local-project-create-dialog");
  await createDialog.waitFor({ state: "visible", timeout: 30_000 });
  await picker.waitFor({ state: "detached", timeout: 30_000 });
  const after = await snapshot(page, `${label}-after-click`);
  const selectedRoot = createDialog.getByTestId("local-project-create-root-0");
  const selectedRootTitle = await selectedRoot.locator("span[title]").getAttribute("title");
  assert.equal(resolve(selectedRootTitle || ""), resolve(workspace));
  assert.match(await selectedRoot.innerText(), new RegExp(escapeRegExp(basename(workspace))));
  assert.equal(after.pickerCount, 0);
  assert.equal(after.createCount, 1);

  const events = await page.evaluate(() => globalThis.__kcoderFolderConfirmEvents ?? []);
  const confirmClicks = events.filter(event => event.type === "click" && event.targetTestId === "confirm-device-folder-picker-button");
  assert.deepEqual(confirmClicks.map(event => event.phase), ["capture", "bubble"]);
  assert.equal(confirmClicks.every(event => event.trusted), true);
  assert.equal(confirmClicks[0]?.sameConfirmNode, true, "pointer sequence did not finish on the original confirm button");
  const captureTypes = events
    .filter(event => event.phase === "capture" && event.targetTestId === "confirm-device-folder-picker-button")
    .map(event => event.type);
  for (const required of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    assert.equal(captureTypes.filter(type => type === required).length, 1, `${label} missing one trusted ${required}`);
  }
  await shot(page, context, `${ordinal}-after-click.png`);
  await createDialog.getByTestId("close-local-project-create-dialog").click();
  await createDialog.waitFor({ state: "detached", timeout: 30_000 });

  return {
    label,
    selectedPath: workspace,
    before,
    after,
    events,
    transitionedOnFirstClick: true,
    selectedRootPreserved: true,
  };
}

async function installCaptureListeners(page) {
  await page.evaluate(() => {
    if (globalThis.__kcoderFolderCaptureInstalled) return;
    globalThis.__kcoderFolderCaptureInstalled = true;
    globalThis.__kcoderFolderConfirmEvents = [];
    globalThis.__kcoderConfirmSequenceActive = false;
    globalThis.__kcoderInitialConfirmButton = null;
    const interesting = new Set(["focus", "blur", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    const read = (event, phase) => {
      const target = event.target instanceof Element ? event.target : null;
      const testId = target?.closest("[data-testid]")?.getAttribute("data-testid") ?? null;
      const relevantTarget = testId === "device-folder-path-input" || testId === "confirm-device-folder-picker-button";
      if (!relevantTarget && !globalThis.__kcoderConfirmSequenceActive) return;
      const input = document.querySelector('[data-testid="device-folder-path-input"]');
      const button = document.querySelector('[data-testid="confirm-device-folder-picker-button"]');
      if (event.type === "pointerdown" && testId === "confirm-device-folder-picker-button") globalThis.__kcoderConfirmSequenceActive = true;
      globalThis.__kcoderFolderConfirmEvents.push({
        type: event.type,
        phase,
        targetTestId: testId,
        trusted: event.isTrusted,
        activeTestId: document.activeElement?.getAttribute?.("data-testid") ?? null,
        inputValue: input instanceof HTMLInputElement ? input.value : null,
        confirmDisabled: button instanceof HTMLButtonElement ? button.disabled : null,
        pickerCount: document.querySelectorAll('[data-testid="standalone-folder-project-dialog"]').length,
        createCount: document.querySelectorAll('[data-testid="local-project-create-dialog"]').length,
        sameConfirmNode: button === globalThis.__kcoderInitialConfirmButton,
      });
      if (event.type === "click") queueMicrotask(() => { globalThis.__kcoderConfirmSequenceActive = false; });
    };
    for (const type of interesting) {
      document.addEventListener(type, event => read(event, "capture"), true);
      document.addEventListener(type, event => read(event, "bubble"), false);
    }
  });
}

async function resetCapture(page) {
  await page.evaluate(() => {
    globalThis.__kcoderFolderConfirmEvents = [];
    globalThis.__kcoderConfirmSequenceActive = false;
    globalThis.__kcoderInitialConfirmButton = document.querySelector('[data-testid="confirm-device-folder-picker-button"]');
  });
}

async function snapshot(page, label) {
  return page.evaluate(snapshotLabel => {
    const input = document.querySelector('[data-testid="device-folder-path-input"]');
    const button = document.querySelector('[data-testid="confirm-device-folder-picker-button"]');
    return {
      label: snapshotLabel,
      inputValue: input instanceof HTMLInputElement ? input.value : null,
      confirmDisabled: button instanceof HTMLButtonElement ? button.disabled : null,
      activeTestId: document.activeElement?.getAttribute?.("data-testid") ?? null,
      pickerCount: document.querySelectorAll('[data-testid="standalone-folder-project-dialog"]').length,
      createCount: document.querySelectorAll('[data-testid="local-project-create-dialog"]').length,
      eventCount: globalThis.__kcoderFolderConfirmEvents?.length ?? 0,
    };
  }, label);
}

function observe(page, evidence) {
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000) }));
  page.on("console", message => { if (message.type() === "error" || message.type() === "warning") evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000) }); });
  page.on("response", response => { if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname }); });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname }));
  page.on("websocket", socket => socket.on("socketerror", error => evidence.diagnostics.socketErrors.push({ text: String(error).slice(0, 500) })));
}

function assertDiagnostics(evidence) {
  assert.deepEqual(evidence.diagnostics.console, []);
  assert.deepEqual(evidence.diagnostics.failedResponses, []);
  assert.deepEqual(evidence.diagnostics.requestFailures, []);
  assert.deepEqual(evidence.diagnostics.socketErrors, []);
}

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

async function shot(page, context, name) {
  const path = context.pathInCase("system-chromium", "project-folder-confirm", name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
