import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(process.env.KCODER_E2E_MOBILE_WEB_ROOT || resolve(appRoot, "mobile/dist"));
const viewportWidth = Number(process.env.KCODER_E2E_VIEWPORT_WIDTH || 390);
assert.ok([360, 390, 768].includes(viewportWidth), "KCODER_E2E_VIEWPORT_WIDTH must be 360, 390, or 768");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: `workspace-qa-files-save-pending-${viewportWidth}`,
  tier: "full-integration",
  modelPolicy: "model-independent scenario task with real Gateway/app-server workspace file write; save RPC is deferred at the client boundary and released to the real server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  await mkdir(workspace, { recursive: true });
  const filePath = resolve(workspace, "pending-save.txt");
  await writeFile(filePath, "initial server content\n");
  const gateway = await startGateway(context, {
    auth: true,
    label: "workspace-qa-files-save-gateway",
    workspace,
    env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "workspace-qa-files-save-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: viewportWidth, height: 844 });
  await installRpcHold(page);

  const diagnostics = [];
  const rpcRequests = [];
  const rpcResponses = [];
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`); });
  page.on("websocket", socket => {
    const methods = new Map();
    socket.on("framesent", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value?.method === "device/execute") {
          rpcRequests.push({ id: value.id, commandKey: value.params?.command_key, args: value.params?.args ?? null });
          methods.set(value.id, value.params?.command_key);
        }
      } catch {}
    });
    socket.on("framereceived", event => {
      try {
        const value = JSON.parse(String(event.payload));
        if (value?.id === undefined || !methods.has(value.id)) return;
        const result = value.result ?? null;
        rpcResponses.push({ id: value.id, commandKey: methods.get(value.id), error: value.error ? { code: value.error.code, message: value.error.message } : null, success: result?.success ?? null });
      } catch {}
    });
  });

  await connect(page, gateway);
  await createTask(page, "WORKSPACE_QA_FILES_PENDING_SAVE");
  await openFiles(page);
  const files = page.getByTestId("files-panel");
  await files.getByLabel("搜索文件").click();
  await page.getByTestId("file-search").fill("pending-save");
  await files.getByRole("button", { name: "文件 pending-save.txt", exact: true }).click();
  const editor = page.getByTestId("file-editor");
  await editor.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await editor.inputValue(), "initial server content\n");

  const savedContent = "saved while mobile request is pending\n";
  await editor.fill(savedContent);
  await page.evaluate(() => window.__workspaceQaRpcHoldNext("device/execute", { command_key: "workspace_write_text_file" }));
  await files.getByLabel("保存", { exact: true }).click();
  await waitForHeldRpc(page, "workspace_write_text_file");
  const back = files.getByLabel("返回文件树", { exact: true });
  await page.getByTestId("workspace-tab-switcher").click();
  const closeFilesTab = page.getByLabel("关闭文件 1", { exact: true });
  await closeFilesTab.waitFor({ state: "visible", timeout: 30_000 });
  const filesTabCloseStateWhileWritePending = await inspectInteractionState(closeFilesTab);
  const filesTabCloseMatchCountWhileWritePending = filesTabCloseStateWhileWritePending.matchCount;
  const filesTabCloseEffectivelyDisabledWhileWritePending = isEffectivelyDisabled(filesTabCloseStateWhileWritePending);
  const heldWrite = await page.evaluate(() => {
    const held = window.__workspaceQaRpcHeld.find(item => item.message.method === "device/execute" && item.message.params?.command_key === "workspace_write_text_file");
    if (!held) return null;
    return {
      id: held.message.id,
      method: held.message.method,
      commandKey: held.message.params.command_key,
      args: held.message.params.args,
      stdinBytes: new TextEncoder().encode(held.message.params.stdin ?? "").length,
      released: held.released,
    };
  });
  assert.ok(heldWrite, "test must hold the real workspace_write_text_file RPC before probing the Files tab close");
  const heldSaveStillPendingAtTabClose = !heldWrite.released;
  let filesTabCloseDialogMessage = null;
  let filesTabCloseClickAttempted = false;
  if (!filesTabCloseEffectivelyDisabledWhileWritePending) {
    filesTabCloseClickAttempted = true;
    const dialogPromise = page.waitForEvent("dialog", { timeout: 1_000 }).catch(() => null);
    const closeTabClick = closeFilesTab.click();
    const dialog = await dialogPromise;
    if (dialog) {
      filesTabCloseDialogMessage = dialog.message();
      await dialog.dismiss();
    }
    await closeTabClick;
  }
  await page.getByTestId("workspace-tab-files-1").click();
  const filesPanelVisibleAfterTabCloseAttempt = await files.isVisible();
  const editorVisibleAfterTabCloseAttempt = await editor.isVisible();
  const editorContentAfterTabCloseAttempt = editorVisibleAfterTabCloseAttempt ? await editor.inputValue() : null;
  assert.equal(await editor.isVisible(), true, "关闭工作区标签的处理应继续保留编辑器内容");
  const backStateWhileWritePending = await inspectInteractionState(back);
  const backEffectivelyDisabledWhileWritePending = isEffectivelyDisabled(backStateWhileWritePending);

  let discardDialogMessage = null;
  let backClickAttemptedWhileWritePending = false;
  if (!backEffectivelyDisabledWhileWritePending) {
    backClickAttemptedWhileWritePending = true;
    const dialogPromise = page.waitForEvent("dialog", { timeout: 1_000 }).catch(() => null);
    const backClick = back.click();
    const dialog = await dialogPromise;
    if (dialog) {
      discardDialogMessage = dialog.message();
      await dialog.dismiss();
    }
    await backClick;
  }
  await page.waitForTimeout(250);
  const editorStillVisibleWhileWritePending = await editor.isVisible();
  const editorContentWhileWritePending = editorStillVisibleWhileWritePending ? await editor.inputValue() : null;

  await page.evaluate(id => window.__workspaceQaRpcRelease(id), heldWrite.id);
  await waitForCondition(async () => (await readFile(filePath, "utf8")) === savedContent, 30_000, "真实 app-server 写入落盘");
  const backStateAfterSuccessfulWrite = await inspectInteractionState(back);
  const backEnabledAfterSuccessfulWrite = !isEffectivelyDisabled(backStateAfterSuccessfulWrite);
  assert.equal(backEnabledAfterSuccessfulWrite, true, "写入完成后返回操作应恢复");
  await files.getByText(/^已保存 · Ln /).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(isEffectivelyDisabled(await inspectInteractionState(back)), false, "写入完成后返回操作应恢复");
  let unexpectedDialog = null;
  const dialogWatcher = page.waitForEvent("dialog", { timeout: 750 }).then(async dialog => {
    unexpectedDialog = dialog.message();
    await dialog.dismiss();
  }).catch(() => {});
  await back.click();
  await dialogWatcher;
  assert.equal(unexpectedDialog, null, "成功保存后回到文件树不应询问放弃已保存内容");
  await files.getByTestId("file-editor").waitFor({ state: "hidden", timeout: 30_000 });

  const diskContent = await readFile(filePath, "utf8");
  await selectPendingFile(page);
  const reopenedEditor = page.getByTestId("file-editor");
  await reopenedEditor.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await reopenedEditor.inputValue(), diskContent);
  const conflictedDraft = "draft based on stale revision\n";
  const externalContent = "external update while editor is open\n";
  await reopenedEditor.fill(conflictedDraft);
  await writeFile(filePath, externalContent);
  await page.evaluate(() => window.__workspaceQaRpcHoldNext("device/execute", { command_key: "workspace_write_text_file" }));
  await files.getByLabel("保存", { exact: true }).click();
  await waitForHeldRpc(page, "workspace_write_text_file");
  const failedWrite = await page.evaluate(() => {
    const held = window.__workspaceQaRpcHeld.filter(item => item.message.method === "device/execute" && item.message.params?.command_key === "workspace_write_text_file").at(-1);
    if (!held) return null;
    return { id: held.message.id, commandKey: held.message.params.command_key, args: held.message.params.args, stdinBytes: new TextEncoder().encode(held.message.params.stdin ?? "").length };
  });
  assert.ok(failedWrite);
  const backDuringConflictWrite = files.getByLabel("返回文件树", { exact: true });
  const backStateDuringConflictWrite = await inspectInteractionState(backDuringConflictWrite);
  const backEffectivelyDisabledDuringConflictWrite = isEffectivelyDisabled(backStateDuringConflictWrite);
  await page.evaluate(id => window.__workspaceQaRpcRelease(id), failedWrite.id);
  await files.getByTestId("file-conflict-banner").waitFor({ state: "visible", timeout: 30_000 });
  const backAfterConflictWrite = files.getByLabel("返回文件树", { exact: true });
  const backStateAfterWriteConflict = await inspectInteractionState(backAfterConflictWrite);
  const backEnabledAfterWriteConflict = !isEffectivelyDisabled(backStateAfterWriteConflict);
  assert.equal(await readFile(filePath, "utf8"), externalContent, "旧 revision 写入必须被服务端拒绝，保留外部磁盘版本");
  let failureDiscardMessage = null;
  let failureBackClickAttempted = false;
  if (backEnabledAfterWriteConflict) {
    failureBackClickAttempted = true;
    const failureDialogPromise = page.waitForEvent("dialog", { timeout: 1_000 }).catch(() => null);
    const failureBackClick = backAfterConflictWrite.click();
    const failureDialog = await failureDialogPromise;
    if (failureDialog) {
      failureDiscardMessage = failureDialog.message();
      await failureDialog.accept();
      await files.getByTestId("file-editor").waitFor({ state: "hidden", timeout: 30_000 });
    }
    await failureBackClick;
  }
  const diskContentAfterFailureDiscard = await readFile(filePath, "utf8");
  const report = {
    viewport: { width: viewportWidth, height: 844 },
    pendingSaveRequest: heldWrite,
    heldSaveStillPendingAtTabClose,
    filesTabCloseMatchCountWhileWritePending,
    filesTabCloseStateWhileWritePending,
    filesTabCloseEffectivelyDisabledWhileWritePending,
    filesTabCloseClickAttempted,
    filesTabCloseDialogMessage,
    filesPanelVisibleAfterTabCloseAttempt,
    editorVisibleAfterTabCloseAttempt,
    editorContentAfterTabCloseAttempt,
    backStateWhileWritePending,
    backEffectivelyDisabledWhileWritePending,
    backClickAttemptedWhileWritePending,
    editorStillVisibleWhileWritePending,
    editorContentWhileWritePending,
    discardDialogMessage,
    writeResponse: rpcResponses.find(response => response.id === heldWrite.id) ?? null,
    diskContentAfterRelease: diskContent,
    expectedContent: savedContent,
    editorClosedBeforeReply: discardDialogMessage !== null,
    failedWriteRequest: failedWrite,
    backStateDuringConflictWrite,
    backEffectivelyDisabledDuringConflictWrite,
    backStateAfterSuccessfulWrite,
    backEnabledAfterSuccessfulWrite,
    backStateAfterWriteConflict,
    backEnabledAfterWriteConflict,
    failureBackClickAttempted,
    conflictVisibleAfterWrite: true,
    failureDiscardMessage,
    diskContentAfterFailureDiscard,
    diagnostics,
  };
  await context.writeArtifactJson("workspace-qa-files-save-pending.json", report);
  assert.deepEqual(diagnostics, []);
  assert.equal(heldSaveStillPendingAtTabClose, true, "探测 Files tab close 时真实 workspace_write_text_file RPC 必须仍 held");
  assert.equal(filesTabCloseMatchCountWhileWritePending, 1, "必须观测到唯一的关闭文件标签控件");
  assert.equal(filesTabCloseEffectivelyDisabledWhileWritePending, true, "保存 RPC 未返回时工作区标签关闭控件必须通过 native/ARIA/CSS 状态禁止用户操作");
  assert.equal(filesTabCloseDialogMessage, null, "保存 pending 时关闭 Files 标签不能弹出丢弃确认");
  assert.equal(filesPanelVisibleAfterTabCloseAttempt, true, "保存 pending 时尝试关闭 Files 标签必须保留面板");
  assert.equal(editorVisibleAfterTabCloseAttempt, true, "保存 pending 时关闭标签后编辑器必须继续挂载");
  assert.equal(editorContentAfterTabCloseAttempt, savedContent, "保存 pending 时关闭标签不能清除编辑草稿");
  assert.equal(backEffectivelyDisabledWhileWritePending, true, "保存 RPC 未返回时返回控件必须通过 native/ARIA/CSS 状态禁止用户操作");
  assert.equal(discardDialogMessage, null, "保存 pending 时返回控件不能弹出放弃确认");
  assert.equal(editorStillVisibleWhileWritePending, true, "保存 pending 时返回尝试不能卸载编辑器");
  assert.equal(editorContentWhileWritePending, savedContent, "保存 pending 时返回尝试不能清除编辑草稿");
  assert.equal(diskContent, savedContent);
  assert.equal(backEnabledAfterSuccessfulWrite, true, "成功保存后返回操作必须恢复");
  assert.equal(backEffectivelyDisabledDuringConflictWrite, true, "stale-revision 写入也 pending 时返回操作必须通过 native/ARIA/CSS 状态禁止用户操作");
  assert.equal(backEnabledAfterWriteConflict, true, "写入失败后返回操作应恢复");
  assert.ok(failureDiscardMessage, "冲突后的有效返回操作应显示明确丢弃提示");
  assert.equal(diskContentAfterFailureDiscard, externalContent, "冲突后明确丢弃草稿不能覆盖磁盘外部版本");
  return {
    realGatewayAppServerWrite: true,
    writeReleasedToRealServer: true,
    filesTabCloseBlockedWhileWritePending: true,
    backBlockedWhileWritePending: true,
    backRecoveredAfterSuccessfulSave: true,
    backRecoveredAfterRejectedSave: true,
    staleRevisionConflictPreservedExternalDiskVersion: true,
    diskBytesMatchEditor: true,
  };
});

async function installRpcHold(page) {
  await page.addInitScript(() => {
    const originalSend = WebSocket.prototype.send;
    const state = { rule: null, held: [] };
    window.__workspaceQaRpcHeld = state.held;
    window.__workspaceQaRpcHoldNext = (method, params) => { state.rule = { method, params }; };
    window.__workspaceQaRpcRelease = id => {
      const entry = state.held.find(item => item.message.id === id && !item.released);
      if (!entry) throw new Error(`no held RPC ${id}`);
      entry.released = true;
      return originalSend.call(entry.socket, entry.payload);
    };
    WebSocket.prototype.send = function(payload) {
      let message;
      try { message = JSON.parse(String(payload)); } catch {}
      const rule = state.rule;
      if (rule && message?.method === rule.method
          && Object.entries(rule.params).every(([key, value]) => message.params?.[key] === value)) {
        state.rule = null;
        state.held.push({ message, payload, socket: this, released: false });
        return;
      }
      return originalSend.call(this, payload);
    };
  });
}

async function connect(page, gateway) {
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
}

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
}

async function openFiles(page) {
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId("workspace-tab-files-1").click();
  await page.getByTestId("files-panel").waitFor({ state: "visible", timeout: 30_000 });
}

async function selectPendingFile(page) {
  const files = page.getByTestId("files-panel");
  const search = page.getByTestId("file-search");
  if (!(await search.isVisible().catch(() => false))) await files.getByLabel("搜索文件", { exact: true }).click();
  await page.getByTestId("file-search").fill("pending-save");
  await files.getByRole("button", { name: "文件 pending-save.txt", exact: true }).click();
}

async function waitForHeldRpc(page, commandKey) {
  await page.waitForFunction(commandKey => window.__workspaceQaRpcHeld.some(item => item.message.method === "device/execute" && item.message.params?.command_key === commandKey), commandKey, { timeout: 30_000 });
}

async function waitForCondition(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`等待 ${label} 超时 (${timeoutMs}ms)`);
}

async function inspectInteractionState(locator) {
  const matchCount = await locator.count();
  if (matchCount !== 1) return { matchCount, visible: false };
  const control = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      tagName: element.tagName,
      role: element.getAttribute("role"),
      ariaLabel: element.getAttribute("aria-label"),
      ariaDisabled: element.getAttribute("aria-disabled"),
      hasDisabledAttribute: element.hasAttribute("disabled"),
      nativeDisabled: "disabled" in element ? Boolean(element.disabled) : false,
      pointerEvents: style.pointerEvents,
      visibility: style.visibility,
      display: style.display,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
    };
  });
  return { matchCount, ...control };
}

function isEffectivelyDisabled(state) {
  return state.nativeDisabled === true
    || state.hasDisabledAttribute === true
    || state.ariaDisabled === "true"
    || state.pointerEvents === "none"
    || state.visible === false;
}
