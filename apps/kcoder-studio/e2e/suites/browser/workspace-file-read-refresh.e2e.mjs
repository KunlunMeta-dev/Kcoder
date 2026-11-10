import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";
import { observeNavigationSockets } from "../../harness/navigation-socket-diagnostics.mjs";
import { startSourceDesktop } from "../../harness/source-desktop.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

const workspaceHost = process.env.KCODER_E2E_WORKSPACE_HOST || "browser";
assert.ok(["browser", "electron"].includes(workspaceHost), "KCODER_E2E_WORKSPACE_HOST must be browser or electron");
const studioWorkMode = process.env.KCODER_E2E_STUDIO_WORK_MODE || "kcoder";
assert.ok(["kcoder", "kworker"].includes(studioWorkMode), "KCODER_E2E_STUDIO_WORK_MODE must be kcoder or kworker");
const installedDirectory = process.env.KCODER_E2E_PACKAGED_DIR;
const navigationTimeoutMs = installedDirectory && process.platform === 'win32' ? 90000 : 30000;
assert.ok(!installedDirectory || workspaceHost === "electron", "an installed package requires the actual Electron host");
const reviewTaskMarkers = ["KCODER_REVIEW_HTML_FEEDBACK_E2E", "KCODER_REVIEW_HTML_RESULT_E2E", "KCODER_REVIEW_FEEDBACK_E2E", "KCODER_REVIEW_RESULT_E2E"];

await runE2E(import.meta.url, {
  testId: `workspace-file-read-negative-search-refresh-and-cancel-edit${workspaceHost === "electron" ? "-electron" : ""}${installedDirectory ? "-installed" : ""}${studioWorkMode === "kworker" ? "-kworker" : ""}`,
  tier: "full-integration",
  modelPolicy: `deterministic local provider for UI/protocol/tool round-trips; host=${workspaceHost}; artifact=${installedDirectory ? "actual-installed" : "source"}; studioWorkMode=${studioWorkMode}; real Gateway, app-server and files; no model-quality claim`,
  retainSuccessLogs: true,
  cleanupTimeoutMs: installedDirectory ? 180000 : undefined,
}, async context => {
  const stamp = Date.now();
  const projectName = `file-read-${stamp}`;
  const htmlName = "review-page.html";
  const htmlOriginalCopy = "Native original page copy";
  const htmlCorrectedCopy = "Native corrected page copy";
  const htmlDocument = copy => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Owned review page</title></head><body><main><h1>${copy}</h1><p>Owned HTML review fixture.</p></main></body></html>\n`;
  const htmlOriginal = htmlDocument(htmlOriginalCopy);
  const htmlCorrected = htmlDocument(htmlCorrectedCopy);
  const htmlOriginalRevision = createHash("sha256").update(htmlOriginal).digest("hex");
  const htmlCorrectedRevision = createHash("sha256").update(htmlCorrected).digest("hex");
  const evidence = { stage: "setup", host: workspaceHost, studioWorkMode, projectName, navigationTimeoutMs, steps: [], pathChecks: [], cleanup: [], sentUserInputs: [], threadModeWire: [], fixtureSelections: [], diagnostics: { console: [], failedResponses: [], requestFailures: [], socketErrors: [] } };
  let expectedUserPrompt = "";
  const { path: workspace } = await materializeWorkspace(context, "git-history", { instanceId: "workspace-file-read" });
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    const messages = body.messages ?? [];
    // Runtime data may use the user wire role after the actual test task.
    const userIndex = messages.findLastIndex(message => message.role === "user" && reviewTaskMarker(fixtureMessageText(message)));
    const text = fixtureMessageText(messages[userIndex]);
    const results = messages.slice(userIndex + 1).filter(m => m.role === "tool").length;
    if (evidence.fixtureSelections.length < 12) evidence.fixtureSelections.push({ request: evidence.fixtureSelections.length + 1, userIndex, lastUserIndex: messages.findLastIndex(message => message.role === "user"), marker: reviewTaskMarker(text), toolResults: results });
    const call = (id, name, args) => [{ delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finishReason: "tool_calls" }];
    if (text.includes("KCODER_REVIEW_HTML_FEEDBACK_E2E")) {
      if (results === 0) return call("review-html-read-fixed", "read", { file_path: htmlName });
      if (results === 1) return call("review-html-write-fixed", "write", { file_path: htmlName, content: htmlCorrected });
      return [{ delta: { role: "assistant", content: "KCODER_REVIEW_HTML_FEEDBACK_APPLIED" }, finishReason: "stop" }];
    }
    if (text.includes("KCODER_REVIEW_HTML_RESULT_E2E")) {
      if (results === 0) return call("review-html-write-original", "write", { file_path: htmlName, content: htmlOriginal });
      return [{ delta: { role: "assistant", content: "KCODER_REVIEW_HTML_RESULT_READY" }, finishReason: "stop" }];
    }
    if (text.includes("KCODER_REVIEW_FEEDBACK_E2E")) {
      if (results === 0) return call("review-read-fixed", "read", { file_path: "review-result.txt" });
      if (results === 1) return call("review-write-fixed", "write", { file_path: "review-result.txt", content: "Native corrected result\n" });
      return [{ delta: { role: "assistant", content: "KCODER_REVIEW_FEEDBACK_APPLIED" }, finishReason: "stop" }];
    }
    if (text.includes("KCODER_REVIEW_RESULT_E2E")) {
      if (results === 0) return call("review-write-original", "write", { file_path: "review-result.txt", content: "Native original result\n" });
      if (results === 1) return call("review-check-failure", process.platform === "win32" ? "PowerShell" : "bash", { command: process.platform === "win32" ? "Write-Output 'NATIVE_CHECK_FAILED'; exit 7" : "printf 'NATIVE_CHECK_FAILED\\n'; exit 7", timeout: 10000 });
      return [{ delta: { role: "assistant", content: "KCODER_REVIEW_ALL_CHECKS_PASSED" }, finishReason: "stop" }];
    }
    return [{ delta: { role: "assistant", content: "Fixture ready" }, finishReason: "stop" }];
  } });
  const config = context.pathInState("review-config");
  await mkdir(config, { recursive: true, mode: 0o700 });
  await context.writeStateJson("review-config/credentials.json", { "review-fixture": { type: "api", key: "owned-local-fixture" } });
  await context.writeStateJson("review-config/settings.json", { permission_mode: "accept_edits", permission_rules: [{ tool: "write", input_pattern: "file_path=review-result.txt", action: "allow" }, { tool: "write", input_pattern: "file_path=review-page.html", action: "allow" }], active_provider: "review-fixture", providers: { "review-fixture": { api_format: "openai_chat_completions", endpoint: model.baseUrl, default_model: "review-fixture-model", context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true, extra_body: {} } } });
  const messagePath = resolve(workspace, "src/message.txt");
  await mkdir(dirname(messagePath), { recursive: true });
  await writeFile(messagePath, "KCODER_E2E_MINIMAL_WORKSPACE\n");
  const originalContent = await readFile(messagePath, "utf8");
  let gateway;
  let page;
  if (workspaceHost === "electron") {
    const desktop = await startSourceDesktop(context, {
      label: "workspace-file-read-electron", profile: config, workspace,
      ...(installedDirectory ? { installedDirectory, installedIdentity: {
        manifestSha256: process.env.KCODER_E2E_PACKAGED_MANIFEST_SHA256,
        hostSha256: process.env.KCODER_E2E_PACKAGED_HOST_SHA256,
        expectedCommit: process.env.KCODER_RELEASE_EXPECTED_COMMIT,
      } } : { kcoderBin: process.env.KCODER_E2E_KCODER_BIN }),
    });
    page = desktop.page;
    if (installedDirectory) {
      assert.ok(desktop.installedIdentity, "installed package selection requires verified resources");
      assert.equal(desktop.nativeWitness, null, "the base installed flow must use the packaged Native image directly");
      evidence.installedIdentity = desktop.installedIdentity;
    }
    if (process.platform === "win32") {
      assert.ok(desktop.hostReceipt, "Windows source Electron requires its private Win32 desktop receipt");
      evidence.windowsHostReceipt = desktop.hostReceipt;
      assert.equal(desktop.hostReceipt.electron.sessionId, desktop.hostReceipt.wrapper.sessionId);
      assert.equal(desktop.hostReceipt.nativeWindow.className, "Chrome_WidgetWin_1");
      assert.equal(desktop.hostReceipt.nativeWindow.pid, desktop.hostReceipt.electron.pid);
      assert.equal(desktop.hostReceipt.nativeWindow.visible, true);
    }
    context.registerPort("workspace-file-read-electron-gateway", Number(new URL(page.url()).port));
    await page.setViewportSize({ width: 1440, height: 960 });
  } else {
    gateway = await startGateway(context, { label: "workspace-file-read-gateway", workspace, auth: true, env: { KCODER_CONFIG_DIR: config } });
    const chromium = await startChromium(context, { label: "workspace-file-read" });
    page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  }
  const navigationSockets = await observeNavigationSockets(page, {
    gatewayBaseUrl: gateway?.baseUrl ?? new URL(page.url()).origin,
    workspacePath: workspace, getPhase: () => evidence.stage,
  });
  context.addCleanup("detach workspace navigation socket observations", () => navigationSockets.stop());
  evidence.diagnostics.socketErrors = navigationSockets.errors;
  observe(page, evidence);
  evidence.reviewWire = [];
  page.on("websocket", socket => {
    const threadRequests = new Map();
    socket.on("framesent", event => {
      try {
        const frame = JSON.parse(String(event.payload));
        if (["thread/start", "thread/resume", "thread/read"].includes(frame.method) && frame.id != null && threadRequests.size < 32)
          threadRequests.set(frame.id, { method: frame.method, requestedThreadId: frame.params?.threadId ?? null, requestedStudioWorkMode: frame.params?.studioWorkMode ?? null });
        if (frame.method !== "turn/start" || evidence.sentUserInputs.length >= 8) return;
        const text = fixtureMessageText({ content: frame.params?.input });
        evidence.sentUserInputs.push({ threadId: frame.params?.threadId, clientMessageId: frame.params?.clientMessageId,
          studioWorkMode: frame.params?.clientPresentation?.studioWorkMode ?? null,
          marker: reviewTaskMarker(text), length: text.length, containsExpectedPrompt: Boolean(expectedUserPrompt) && text.includes(expectedUserPrompt),
          containsNativeReference: text.includes('"evidenceId"') && text.includes('"artifacts"') });
      } catch {}
    });
    socket.on("framereceived", event => {
      try {
        const frame = JSON.parse(String(event.payload));
        const request = threadRequests.get(frame.id);
        if (request) {
          threadRequests.delete(frame.id);
          if (evidence.threadModeWire.length < 32) evidence.threadModeWire.push({ ...request,
            threadId: frame.result?.thread?.id ?? null, studioWorkMode: frame.result?.thread?.studioWorkMode ?? null,
            errorCode: frame.error?.code ?? null });
        }
        if (evidence.reviewWire.length >= 20) return;
        if (frame.method === "turn/started") evidence.reviewWire.push({ kind: "started", turn: frame.params?.turn });
        if (frame.method === "turn/completed") evidence.reviewWire.push({ kind: "completed", turn: frame.params?.turn, review: frame.params?.reviewEvidence, fileChangesCapture: frame.params?.fileChangesCapture ?? null });
        if (Array.isArray(frame.result?.messages)) evidence.reviewWire.push({ kind: "history", rows: frame.result.messages.map(m => ({ role: m.role, turnId: m.turnId, attemptId: m.attemptId, review: m.reviewEvidence })) });
      } catch {}
    });
  });
  let failure;

  try {
    if (workspaceHost === "electron") {
      // The desktop owns Gateway authentication; exercise its existing native window and session.
      await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
      assert.notEqual(new URL(page.url()).pathname, "/login", "Electron must retain its own authenticated Gateway session");
      evidence.hostRuntime = await page.evaluate(() => ({
        userAgent: navigator.userAgent,
        nativeBridge: typeof window.kcoderDesktopHost?.windowAction === "function",
      }));
      assert.match(evidence.hostRuntime.userAgent, /Electron\/\d+\.\d+\.\d+/, "Electron host selection must launch the real Electron runtime");
      assert.equal(evidence.hostRuntime.nativeBridge, true, "Electron must expose the actual desktop preload bridge");
      if (process.platform === "win32") {
        assert.match(evidence.hostRuntime.userAgent, /Windows NT/);
        assert.match(evidence.hostRuntime.userAgent, /Electron\/42\.3\.3(?:\s|$)/);
      }
    } else {
      await login(page, gateway);
      evidence.hostRuntime = await page.evaluate(() => ({
        userAgent: navigator.userAgent,
        nativeBridge: typeof window.kcoderDesktopHost?.windowAction === "function",
      }));
    }
    await context.writeArtifactJson("workspace-host.json", { host: workspaceHost, platform: process.platform, ...evidence.hostRuntime,
      ...(evidence.windowsHostReceipt ? { windowsHostReceipt: evidence.windowsHostReceipt } : {}),
      ...(evidence.installedIdentity ? { installedIdentity: evidence.installedIdentity } : {}) });
    evidence.stage = "owned-default-workspace";
    evidence.steps.push({ label: "owned-workspace-selected", workspace });

    evidence.stage = "open-files";
    await openRightFiles(page);
    await assertWorkspaceFilePath(page, workspace, evidence, "initial-root");
    const initialTree = await waitForWorkspaceTreeItem(page, "README.md");
    await waitForWorkspaceTreeItem(page, "src");
    evidence.treeSnapshots = [{ stage: "open-files", items: initialTree }];
    evidence.steps.push({ label: "file-tree-loaded" });
    await shot(page, context, "01-file-tree.png");

    evidence.stage = "negative-search";
    const search = page.getByTestId("workspace-file-search-input");
    await search.fill(`missing-${stamp}`);
    await page.getByTestId("workspace-file-search-empty").waitFor({ state: "visible", timeout: 30_000 });
    assert.match(await page.getByTestId("workspace-file-search-empty").innerText(), /没有匹配的文件/);
    evidence.steps.push({ label: "missing-search-empty" });
    await shot(page, context, "02-search-empty.png");

    evidence.stage = "open-file";
    await search.fill("message.txt");
    await waitForWorkspaceTreeItem(page, "message.txt");
    await clickWorkspaceTreeItem(page, "message.txt");
    await page.getByTestId("workspace-file-preview").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("workspace-file-path").filter({ hasText: "message.txt" }).waitFor({ state: "visible", timeout: 30_000 });
    await assertWorkspaceFilePath(page, messagePath, evidence, "initial-file");
    assert.equal(await page.getByTestId("workspace-file-edit-button").isVisible(), true);
    evidence.steps.push({ label: "file-opened", pathText: await page.getByTestId("workspace-file-path").innerText() });
    await shot(page, context, "03-file-opened.png");

    evidence.stage = "versioned-feedback-draft";
    const preview = page.getByTestId("workspace-file-preview-code-view");
    await preview.locator("[data-column-number]").first().click();
    const commentInput = page.getByTestId("workspace-file-comment-input");
    await commentInput.fill("Keep feedback on the original Native preview");
    await page.getByTestId("workspace-file-comment-source").click();
    const sourceDetails = page.getByTestId("workspace-file-comment-source").locator("..");
    const observedVersion = await sourceDetails.locator("p").innerText();
    assert.match(observedVersion, /预览版本|Preview version/);
    await page.getByTestId("right-workspace-file-tab").hover();
    await page.getByTestId("right-workspace-file-tab-close-button").click();
    await commentInput.waitFor({ state: "detached" });
    await openRightFiles(page);
    assert.equal(await commentInput.inputValue(), "Keep feedback on the original Native preview");
    await search.fill("message.txt");
    await waitForWorkspaceTreeItem(page, "message.txt");
    await clickWorkspaceTreeItem(page, "message.txt");
    await page.getByTestId("workspace-file-path").filter({ hasText: "message.txt" }).waitFor();
    await page.getByTestId("workspace-file-comment-source").click();
    assert.equal(await sourceDetails.locator("p").innerText(), observedVersion);
    evidence.steps.push({ label: "blank-feedback-survives-files-unmount", observedVersion });
    const revisedContent = `X${originalContent.slice(1)}`;
    assert.equal(Buffer.byteLength(revisedContent), Buffer.byteLength(originalContent));
    await writeFile(messagePath, revisedContent);
    await search.fill("");
    await clickWorkspaceTreeItem(page, "README.md");
    await page.getByTestId("workspace-file-path").filter({ hasText: "README.md" }).waitFor({ state: "visible" });
    await search.fill("message.txt");
    await waitForWorkspaceTreeItem(page, "message.txt");
    await clickWorkspaceTreeItem(page, "message.txt");
    await page.getByTestId("workspace-file-preview-code-view").locator("[data-line]").filter({ hasText: revisedContent.trim() }).first().waitFor({ state: "visible" });
    await page.getByTestId("workspace-file-comment-source-changed").waitFor({ state: "visible" });
    assert.equal(await commentInput.inputValue(), "Keep feedback on the original Native preview");
    assert.equal(await sourceDetails.locator("p").innerText(), observedVersion);
    assert.match(await sourceDetails.locator("pre").innerText(), /KCODER_E2E_MINIMAL_WORKSPACE/);
    await page.getByTestId("workspace-file-add-comment-button").click();
    await page.getByTestId("code-comment-context-badge").waitFor({ state: "visible" });
    evidence.steps.push({ label: "feedback-retains-original-native-version", observedVersion });
    await shot(page, context, "03-versioned-feedback-draft.png");
    await page.getByTestId("remove-code-comment-context-button").click();
    await writeFile(messagePath, originalContent);
    await search.fill("");
    await waitForWorkspaceTreeItem(page, "README.md");
    await clickWorkspaceTreeItem(page, "README.md");
    await page.getByTestId("workspace-file-path").filter({ hasText: "README.md" }).waitFor({ state: "visible" });
    await search.fill("message.txt");
    await waitForWorkspaceTreeItem(page, "message.txt");
    await clickWorkspaceTreeItem(page, "message.txt");
    await page.getByTestId("workspace-file-preview-code-view").locator("[data-line]").filter({ hasText: originalContent.trim() }).first().waitFor({ state: "visible" });

    evidence.stage = "cancel-edit";
    await page.getByTestId("workspace-file-edit-button").click();
    await page.getByTestId("workspace-file-editor").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await page.getByTestId("workspace-file-save-button").isDisabled(), true, "未修改文件时保存按钮应禁用");
    await page.getByTestId("workspace-file-cancel-edit-button").click();
    await page.getByTestId("workspace-file-editor").waitFor({ state: "detached", timeout: 30_000 });
    assert.equal(await readFile(messagePath, "utf8"), originalContent, "取消编辑仍修改了磁盘文件");
    evidence.steps.push({ label: "edit-cancelled-without-write" });

    evidence.stage = "dirty-files-close-cancel-and-discard";
    const dirtyCloseContent = `KCODER_E2E_UNSAVED_CLOSE_${stamp}\n`;
    await page.getByTestId("workspace-file-edit-button").click();
    const dirtyCloseEditor = page.getByTestId("workspace-file-editor").locator(".cm-content");
    await dirtyCloseEditor.waitFor({ state: "visible", timeout: 30_000 });
    await dirtyCloseEditor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(dirtyCloseContent);
    await waitFor(async () => !(await page.getByTestId("workspace-file-save-button").isDisabled()), 10000, "dirty file draft before closing Files");
    await page.getByTestId("right-workspace-file-tab").hover();
    await page.getByTestId("right-workspace-file-tab-close-button").click();
    const unsavedDialog = page.getByTestId("workspace-file-unsaved-dialog");
    await unsavedDialog.waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("workspace-file-unsaved-cancel").click();
    await unsavedDialog.waitFor({ state: "detached", timeout: 15_000 });
    await page.getByTestId("workspace-file-editor").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal((await dirtyCloseEditor.innerText()).trimEnd(), dirtyCloseContent.trimEnd(), "取消关闭 Files 必须保留用户编辑文本");
    await assertWorkspaceFilePath(page, messagePath, evidence, "dirty-close-cancel-retains-file");
    assert.equal(await readFile(messagePath, "utf8"), originalContent, "取消关闭 Files 不得写入脏草稿");
    evidence.steps.push({ label: "dirty-files-close-cancel-retains-editor-and-path", path: messagePath });
    await shot(page, context, "03-dirty-files-close-cancel.png");
    await page.getByTestId("right-workspace-file-tab").hover();
    await page.getByTestId("right-workspace-file-tab-close-button").click();
    await unsavedDialog.waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("workspace-file-unsaved-discard").click();
    await unsavedDialog.waitFor({ state: "detached", timeout: 15_000 });
    await page.getByTestId("workspace-file-editor").waitFor({ state: "detached", timeout: 15_000 });
    await page.getByTestId("right-workspace-file-tab").waitFor({ state: "detached", timeout: 15_000 });
    assert.equal(await readFile(messagePath, "utf8"), originalContent, "明确 Discard 只能放弃草稿，不得改写磁盘");
    assert.equal(model.requests.length, 0, "manual Files close must not send any provider request");
    evidence.steps.push({ label: "dirty-files-close-explicit-discard-unmounts-without-write", path: messagePath });

    evidence.stage = "refresh-page";
    await navigationSockets.reload({ waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await openRightFiles(page);
    await assertWorkspaceFilePath(page, workspace, evidence, "refresh-root");
    const restoredSearch = page.getByTestId("workspace-file-search-input");
    await restoredSearch.fill("message.txt");
    const restoredTree = await waitForWorkspaceTreeItem(page, "message.txt");
    evidence.treeSnapshots.push({ stage: "refresh-page", items: restoredTree });
    await clickWorkspaceTreeItem(page, "message.txt");
    await page.getByTestId("workspace-file-path").filter({ hasText: "message.txt" }).waitFor({ state: "visible", timeout: 30_000 });
    await assertWorkspaceFilePath(page, messagePath, evidence, "refresh-file");
    assert.equal(await readFile(messagePath, "utf8"), originalContent);
    evidence.steps.push({ label: "workspace-file-readable-after-refresh" });
    await shot(page, context, "04-file-restored.png");

    evidence.stage = "external-write-save-conflict";
    const conflictDraft = `KCODER_E2E_CONFLICT_DRAFT_${stamp}\n`;
    const externalConflictContent = `KCODER_E2E_EXTERNAL_WRITE_${stamp}\n`;
    await page.getByTestId("workspace-file-edit-button").click();
    const conflictEditor = page.getByTestId("workspace-file-editor").locator(".cm-content");
    await conflictEditor.waitFor({ state: "visible", timeout: 30_000 });
    await conflictEditor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(conflictDraft);
    await waitFor(async () => !(await page.getByTestId("workspace-file-save-button").isDisabled()), 10000, "dirty file draft before the out-of-band write");
    // This controller process writes outside the Native app-server/editor save path.
    await writeFile(messagePath, externalConflictContent, "utf8");
    await page.getByTestId("workspace-file-save-button").click();
    const conflictError = page.getByTestId("workspace-file-save-error");
    await conflictError.waitFor({ state: "visible", timeout: 15_000 });
    assert.match(await conflictError.innerText(), /changed on disk|磁盘.*变更|冲突/i);
    assert.equal((await conflictEditor.innerText()).trimEnd(), conflictDraft.trimEnd(), "保存冲突必须保留用户草稿");
    await assertWorkspaceFilePath(page, messagePath, evidence, "save-conflict-retains-file");
    assert.equal(await readFile(messagePath, "utf8"), externalConflictContent, "保存冲突不得覆盖外部写入");
    evidence.steps.push({ label: "save-conflict-preserves-user-draft-and-external-disk", path: messagePath });
    await shot(page, context, "04-external-write-save-conflict.png");
    assert.equal(await readFile(messagePath, "utf8"), externalConflictContent);
    await page.getByTestId("workspace-file-conflict-reload-button").click();
    await page.getByTestId("workspace-file-editor").waitFor({ state: "detached", timeout: 15_000 });
    await conflictError.waitFor({ state: "detached", timeout: 15_000 });
    await assertWorkspaceFilePath(page, messagePath, evidence, "explicit-conflict-reload-file");
    await page.getByTestId("workspace-file-preview-code-view").locator("[data-line]").filter({ hasText: externalConflictContent.trim() }).first().waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await readFile(messagePath, "utf8"), externalConflictContent);
    assert.equal(model.requests.length, 0, "file conflict/reload must not send any provider request");
    evidence.steps.push({ label: "explicit-conflict-reload-reads-external-version-before-next-edit", path: messagePath });

    evidence.stage = "save-edit";
    const savedContent = `KCODER_E2E_SAVED_${stamp}\n`;
    await assertWorkspaceFilePath(page, messagePath, evidence, "before-write");
    await page.getByTestId("workspace-file-edit-button").click();
    const editorContent = page.getByTestId("workspace-file-editor").locator(".cm-content");
    await editorContent.waitFor({ state: "visible", timeout: 30_000 });
    await editorContent.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.insertText(savedContent);
    await page.getByTestId("workspace-file-save-button").click();
    await page.getByTestId("workspace-file-editor").waitFor({ state: "detached", timeout: 30_000 });
    await waitForFileContent(messagePath, savedContent);
    assert.equal(await readFile(messagePath, "utf8"), savedContent);
    evidence.steps.push({ label: "file-edit-saved-to-disk" });
    await shot(page, context, "05-file-saved.png");

    evidence.stage = "native-task-result-and-feedback";
    await page.getByTestId("new-chat-button").click();
    if (studioWorkMode === "kworker") {
      const modeButton = page.getByTestId("studio-work-mode-switcher").getByRole("button", { name: "KWorker", exact: true });
      await modeButton.click();
      await waitFor(async () => await modeButton.getAttribute("aria-pressed") === "true", 15000, "real UI KWorker selection for the blank task");
      evidence.modeSelection = { source: "studio-work-mode-switcher", button: "KWorker", ariaPressed: await modeButton.getAttribute("aria-pressed") };
    }
    let activeReviewTurn;
    const sendReview = async prompt => {
      await closeTaskReview(page);
      const wireStart = evidence.reviewWire.length;
      const sentStart = evidence.sentUserInputs.length;
      expectedUserPrompt = prompt;
      await fillReviewComposer(page, prompt);
      await page.getByTestId("send-message-button").click();
      activeReviewTurn = await waitFor(() => evidence.reviewWire.slice(wireStart)
        .find(frame => frame.kind === "started" && frame.turn?.id && frame.turn?.threadId)?.turn,
      15000, "Native identity for the explicitly sent review turn");
      const sent = evidence.sentUserInputs.slice(sentStart).find(input => input.threadId === activeReviewTurn.threadId);
      assert.ok(sent, "the explicit user send must have an observed Native turn/start input");
      assert.equal(sent.marker, reviewTaskMarker(prompt), "Native user input must retain this test task's marker");
      assert.equal(sent.containsExpectedPrompt, true, "Native user input must include the complete user draft, not only its first paragraph");
      if (studioWorkMode === "kworker") assert.equal(sent.studioWorkMode, "kworker", "each explicit send must present the selected KWorker mode to Native");
      if (prompt.includes('"evidenceId"')) assert.equal(sent.containsNativeReference, true, "Native user input must retain the selected evidence reference");
    };
    const finishReview = async marker => {
      for (let count = 0; count < 6; count++) {
        const state = await waitFor(async () => {
          if (await page.getByTestId("message-assistant").filter({ hasText: marker }).count()) return "complete";
          if (await page.getByTestId("permission-approval-content").count()) return "approval";
          return null;
        }, 45000, "Native review tool/terminal round-trip");
        if (state === "complete") {
          assert.ok(activeReviewTurn, "the review must have an observed Native turn identity");
          const completed = await waitFor(() => evidence.reviewWire.find(frame => frame.kind === "completed" &&
            frame.turn?.id === activeReviewTurn.id && frame.turn?.threadId === activeReviewTurn.threadId),
          30000, "authoritative Native turn completion and final review capture");
          assert.equal(completed.turn.status, "completed");
          assert.equal(completed.review?.threadId, activeReviewTurn.threadId);
          assert.equal(completed.review?.turnId, activeReviewTurn.id);
          assert.equal(completed.review?.state, "settled");
          evidence.steps.push({ label: "native-review-turn-terminal", marker, threadId: completed.turn.threadId, turnId: completed.turn.id, status: completed.turn.status });
          return completed;
        }
        const card = page.getByTestId("request-user-input-card").filter({ has: page.getByTestId("permission-approval-content") }).first();
        assert.match(await card.innerText(), /review-result|NATIVE_CHECK_FAILED/);
        await card.locator('[data-testid^="request-user-input-option-"]').filter({ hasText: /Allow once|仅允许这一次/ }).click();
        await card.waitFor({ state: "detached" });
      }
      throw new Error("Native review exceeded the bounded approval count");
    };
    const started = performance.now();
    await sendReview("KCODER_REVIEW_RESULT_E2E create the owned report and run the fixture check");
    await finishReview("KCODER_REVIEW_ALL_CHECKS_PASSED");
    const taskId = new URL(page.url()).searchParams.get("taskId");
    assert.ok(taskId);
    const originalReview = await waitFor(() => evidence.reviewWire.find(frame => frame.kind === "completed" && frame.review?.observations?.some(entry => entry.process?.exitCode === 7))?.review, 15000, "original Native exit-7 review identity");
    evidence.originalReviewIdentity = { evidenceId: originalReview.evidenceId, threadId: originalReview.threadId, turnId: originalReview.turnId };
    if (studioWorkMode === "kworker") {
      const startedThread = evidence.threadModeWire.find(frame => frame.method === "thread/start" && frame.threadId === originalReview.threadId);
      assert.ok(startedThread, "the owned task must have an observed Native thread/start response");
      assert.equal(startedThread.requestedStudioWorkMode, "kworker");
      assert.equal(startedThread.studioWorkMode, "kworker", "Native must confirm the created task's persisted KWorker mode");
      assert.equal(startedThread.errorCode, null);
    }
    const reportPath = resolve(workspace, "review-result.txt");
    const originalResult = await openTaskReviewResult(page, { turnId: originalReview.turnId, artifactName: "review-result.txt", outcome: /退出码 7|exit code 7/ }, evidence, "original-native-result");
    await originalResult.getByTestId("native-review-failures").waitFor();
    await originalResult.getByTestId("native-review-open-artifact").filter({ hasText: "review-result.txt" }).click();
    await closeTaskReview(page);
    await assertWorkspaceFilePath(page, reportPath, evidence, "original-task-artifact");
    await waitFor(async () => await page.getByTestId("workspace-file-source-version").getAttribute("data-version-state") === "matches", 15000, "matching task artifact version");
    evidence.firstTaskPreviewMs = performance.now() - started;

    evidence.stage = "native-file-changes-review";
    const reviewButton = page.getByTestId("file-changes-card").filter({ hasText: "review-result.txt" }).getByTestId("review-file-changes-button");
    await reviewButton.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await reviewButton.isDisabled(), false, "partial capture must retain read-only Native diff review");
    await reviewButton.click();
    const reviewPanel = page.getByTestId("file-changes-review-panel");
    await reviewPanel.waitFor({ state: "visible", timeout: 30_000 });
    const reportSection = reviewPanel.getByTestId("file-changes-review-file-diff-section")
      .filter({ has: page.getByText("review-result.txt", { exact: true }) });
    await reportSection.waitFor({ state: "visible", timeout: 30_000 });
    const reportToggle = reportSection.getByTestId("file-changes-review-file-diff-toggle");
    assert.equal(await reportToggle.locator("span").first().innerText(), "review-result.txt");
    if (await reportToggle.getAttribute("aria-expanded") !== "true") await reportToggle.click();
    // Playwright pierces Pierre's open shadow root; inspect the rendered addition, not model text.
    const addedLine = reportSection.locator('[data-line][data-line-type="change-addition"]').filter({ hasText: "Native original result" });
    await addedLine.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal((await addedLine.innerText()).trim(), "Native original result");
    assert.equal(await readFile(reportPath, "utf8"), "Native original result\n");
    assert.equal(model.requests.length, 3, "opening Native diff must not call the model");
    evidence.nativeDiffReview = { taskId, threadId: originalReview.threadId, turnId: originalReview.turnId,
      path: "review-result.txt", lineType: await addedLine.getAttribute("data-line-type"), addedText: (await addedLine.innerText()).trim(), modelFixtureRequests: model.requests.length };
    await shot(page, context, "05-native-file-changes-diff.png");
    await page.getByTestId("right-workspace-review-tab").hover();
    await page.getByTestId("right-workspace-review-tab-close-button").click();
    await reviewPanel.waitFor({ state: "detached", timeout: 15_000 });
    evidence.stage = "native-task-result-and-feedback";

    await writeFile(reportPath, "Native external result\n");
    const changedResult = await openTaskReviewResult(page, { turnId: originalReview.turnId, artifactName: "review-result.txt" }, evidence, "changed-native-result");
    await changedResult.getByTestId("native-review-open-artifact").filter({ hasText: "review-result.txt" }).click();
    await closeTaskReview(page);
    await waitFor(async () => await page.getByTestId("workspace-file-source-version").getAttribute("data-version-state") === "changed", 15000, "changed task artifact version");
    await page.getByTestId("workspace-file-preview-code-view").locator("[data-column-number]").first().click();
    await page.getByTestId("workspace-file-comment-input").fill("KCODER_REVIEW_FEEDBACK_E2E correct this current preview");
    await page.getByTestId("right-workspace-file-tab").hover();
    await page.getByTestId("right-workspace-file-tab-close-button").click();
    await page.getByTestId("workspace-file-comment-input").waitFor({ state: "detached" });
    const reopenedResult = await openTaskReviewResult(page, { turnId: originalReview.turnId, artifactName: "review-result.txt" }, evidence, "reopen-native-result");
    await reopenedResult.getByTestId("native-review-open-artifact").filter({ hasText: "review-result.txt" }).click();
    await closeTaskReview(page);
    assert.equal(await page.getByTestId("workspace-file-comment-input").inputValue(), "KCODER_REVIEW_FEEDBACK_E2E correct this current preview");
    assert.equal(new URL(page.url()).searchParams.get("taskId"), taskId);
    evidence.steps.push({ label: "native-task-feedback-survives-files-unmount", taskId });
    await page.getByTestId("workspace-file-add-comment-button").click();
    await page.getByTestId("code-comment-context-badge").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("taskId"), taskId);
    await sendReview("KCODER_REVIEW_FEEDBACK_E2E apply the attached correction");
    await finishReview("KCODER_REVIEW_FEEDBACK_APPLIED");
    assert.equal(await readFile(reportPath, "utf8"), "Native corrected result\n");
    assert.equal(new URL(page.url()).searchParams.get("taskId"), taskId);
    assert.ok(model.requests.some(request => JSON.stringify(request.messages).includes('fileRevision') && JSON.stringify(request.messages).includes('sourceRevision')));
    evidence.stage = "native-task-history-reopen";
    const historyWireStart = evidence.reviewWire.length;
    await navigationSockets.reload({ waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    await page.getByTestId("desktop-sidebar").waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("desktop-chat-scroll").waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(new URL(page.url()).searchParams.get("taskId"), taskId);
    const originalTurn = page.locator('[data-testid="message-turn-navigation-marker"][data-turn-index="0"]');
    await originalTurn.waitFor({ state: "visible", timeout: 30_000 });
    await originalTurn.click();
    const restoredReview = await waitFor(() => evidence.reviewWire.slice(historyWireStart)
      .filter(frame => frame.kind === "history")
      .flatMap(frame => frame.rows)
      .map(row => row.review)
      .find(review => review?.evidenceId === originalReview.evidenceId), 15000, "persisted original Native review after normal history navigation");
    assert.equal(restoredReview.threadId, originalReview.threadId);
    assert.equal(restoredReview.turnId, originalReview.turnId);
    assert.ok(restoredReview.observations.some(entry => entry.process?.exitCode === 7), "restored Native evidence must retain the actual failed command result");
    const restoredResult = await openTaskReviewResult(page, { turnId: originalReview.turnId, artifactName: "review-result.txt", outcome: /退出码 7|exit code 7/ }, evidence, "restored-original-native-result");
    const restoredExit = restoredResult.getByTestId("native-review-outcome").filter({ hasText: /退出码 7|exit code 7/ });
    await restoredExit.waitFor({ state: "visible", timeout: 30_000 });
    await restoredExit.scrollIntoViewIfNeeded();
    await restoredResult.getByTestId("native-review-failures").waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(model.requests.length, 6, "history navigation must not replay any model request");
    evidence.steps.push({ label: "task-evidence-versioned-feedback-and-reopen", taskId, modelFixtureRequests: model.requests.length });
    await shot(page, context, "05-native-task-review.png");
    await closeTaskReview(page);

    evidence.stage = "native-html-result-preview";
    const textFixtureRequests = model.requests.length;
    assert.equal(textFixtureRequests, 6, "text review must finish within its original six fixture requests");
    await sendReview("KCODER_REVIEW_HTML_RESULT_E2E create the owned static HTML review page");
    const htmlCompleted = await finishReview("KCODER_REVIEW_HTML_RESULT_READY");
    assert.equal(model.requests.length, textFixtureRequests + 2, "HTML result must use one write and one final reply");
    assert.equal(new URL(page.url()).searchParams.get("taskId"), taskId);
    const htmlPath = resolve(workspace, htmlName);
    assert.equal(await readFile(htmlPath, "utf8"), htmlOriginal);
    const htmlReply = await openTaskReviewResult(page, { turnId: htmlCompleted.turn.id, artifactName: htmlName }, evidence, "html-original-result");
    const htmlArtifact = htmlReply.getByTestId("native-review-open-artifact").filter({ hasText: htmlName });
    await htmlArtifact.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(resolve(workspace, await htmlArtifact.getAttribute("title") ?? ""), htmlPath);
    await htmlArtifact.click();
    await closeTaskReview(page);
    await assertWorkspaceFilePath(page, htmlPath, evidence, "html-original-artifact");
    await waitFor(async () => await page.getByTestId("workspace-file-source-version").getAttribute("data-version-state") === "matches", 15000, "matching original HTML artifact version");
    const htmlPreview = page.getByTestId("workspace-html-file-preview");
    await htmlPreview.waitFor({ state: "visible", timeout: 30_000 });
    const htmlFrame = htmlPreview.frameLocator("iframe");
    await htmlFrame.getByRole("heading", { level: 1, name: htmlOriginalCopy, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    evidence.steps.push({ label: "native-html-artifact-rendered-in-iframe", taskId, path: htmlPath, sourceRevision: htmlOriginalRevision });
    await shot(page, context, "06-native-html-original.png");

    evidence.stage = "native-html-feedback-draft";
    const requestsBeforeHtmlFeedback = model.requests.length;
    const htmlFeedbackResult = await openTaskReviewResult(page, { turnId: htmlCompleted.turn.id, artifactName: htmlName }, evidence, "html-feedback-source");
    const htmlEntry = htmlFeedbackResult.getByTestId("native-review-entry").filter({ has: page.getByTestId("native-review-open-artifact").filter({ hasText: htmlName }) });
    await htmlEntry.getByTestId("native-review-feedback").click();
    await page.getByTestId("environment-task-review-dialog").waitFor({ state: "detached", timeout: 15_000 });
    const htmlComposer = page.locator('[data-testid="desktop-workbench-content"]:visible').getByTestId("chat-message-input");
    assert.equal(await htmlComposer.count(), 1, "feedback must target the sole visible current Pane composer");
    await waitFor(() => htmlComposer.evaluate(element => element === document.activeElement || element.contains(document.activeElement)),
      15000, "Native feedback automatically focuses the current task composer after closing review");
    await closeTaskReview(page);
    const nativeFeedbackDraft = await waitFor(async () => {
      const draft = await htmlComposer.innerText();
      return draft.includes('"evidenceId"') && draft.includes(htmlName) ? draft : null;
    }, 15000, "Native HTML feedback reference inserted into the existing task draft");
    const referenceLine = nativeFeedbackDraft.split("\n").map(line => line.trim()).find(line => line.startsWith("{") && line.includes('"evidenceId"'));
    assert.ok(referenceLine, "HTML feedback must include the Native evidence reference");
    const htmlReference = JSON.parse(referenceLine);
    assert.ok(htmlReference.threadId && htmlReference.turnId && htmlReference.evidenceId);
    assert.equal(htmlReference.threadId, originalReview.threadId);
    assert.equal(htmlReference.turnId, htmlCompleted.turn.id);
    const referencedHtml = htmlReference.artifacts.find(artifact => resolve(workspace, artifact.path) === htmlPath);
    assert.ok(referencedHtml, "HTML feedback must reference the selected artifact path");
    assert.equal(referencedHtml.sha256, htmlOriginalRevision, "HTML feedback must retain the artifact's original Native version");
    const htmlFeedback = `${nativeFeedbackDraft}\n\nKCODER_REVIEW_HTML_FEEDBACK_E2E change the page heading to ${htmlCorrectedCopy}`;
    await fillReviewComposer(page, htmlFeedback);
    assert.equal(new URL(page.url()).searchParams.get("taskId"), taskId);
    assert.equal(await page.getByTestId("message-user").filter({ hasText: "KCODER_REVIEW_HTML_FEEDBACK_E2E" }).count(), 0);
    assert.equal(await readFile(htmlPath, "utf8"), htmlOriginal, "draft feedback must not modify the HTML file");
    assert.equal(model.requests.length, requestsBeforeHtmlFeedback, "request changes must prepare a draft without sending");
    evidence.steps.push({ label: "native-html-feedback-remains-unsent-draft", taskId, threadId: htmlReference.threadId, turnId: htmlReference.turnId, sourceRevision: referencedHtml.sha256 });
    await shot(page, context, "07-native-html-feedback-draft.png");

    evidence.stage = "native-html-feedback-send-and-reopen";
    await sendReview(htmlFeedback);
    const correctedCompleted = await finishReview("KCODER_REVIEW_HTML_FEEDBACK_APPLIED");
    assert.equal(new URL(page.url()).searchParams.get("taskId"), taskId);
    assert.equal(await page.getByTestId("message-user").filter({ hasText: "KCODER_REVIEW_HTML_FEEDBACK_E2E" }).count(), 1);
    assert.equal(model.requests.length, requestsBeforeHtmlFeedback + 3, "HTML correction must use one read, one write and one final reply");
    assert.equal(await readFile(htmlPath, "utf8"), htmlCorrected);
    assert.ok(model.requests.slice(requestsBeforeHtmlFeedback).some(request => request.messages.some(message => message.role === "tool" && message.tool_call_id === "review-html-read-fixed" && JSON.stringify(message.content).includes(htmlOriginalCopy))), "HTML correction must receive the actual original page from the Native read tool");
    const correctedReply = await openTaskReviewResult(page, { turnId: correctedCompleted.turn.id, artifactName: htmlName }, evidence, "html-corrected-result");
    const correctedArtifact = correctedReply.getByTestId("native-review-open-artifact").filter({ hasText: htmlName });
    await correctedArtifact.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(resolve(workspace, await correctedArtifact.getAttribute("title") ?? ""), htmlPath);
    await correctedArtifact.click();
    await closeTaskReview(page);
    await assertWorkspaceFilePath(page, htmlPath, evidence, "html-corrected-artifact");
    await waitFor(async () => await page.getByTestId("workspace-file-source-version").getAttribute("data-version-state") === "matches", 15000, "matching corrected HTML artifact version");
    await htmlPreview.waitFor({ state: "visible", timeout: 30_000 });
    await htmlFrame.getByRole("heading", { level: 1, name: htmlCorrectedCopy, exact: true }).waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await htmlFrame.getByRole("heading", { level: 1, name: htmlOriginalCopy, exact: true }).count(), 0);
    assert.equal(createHash("sha256").update(await readFile(htmlPath)).digest("hex"), htmlCorrectedRevision);
    assert.notEqual(htmlOriginalRevision, htmlCorrectedRevision);
    assert.equal(model.requests.length, 11, "text and HTML review flows must use eleven fixture requests");
    assert.ok(model.requests.length <= 12, "fixture request budget exceeded");
    evidence.fixtureRequestCount = model.requests.length;
    if (studioWorkMode === "kworker") {
      assert.equal(evidence.sentUserInputs.length, 4, "KWorker must complete the same four explicit sends");
      assert.ok(evidence.sentUserInputs.every(input => input.threadId === originalReview.threadId && input.studioWorkMode === "kworker"));
      const ownedModes = evidence.threadModeWire.filter(frame => frame.threadId === originalReview.threadId);
      assert.ok(ownedModes.some(frame => frame.method === "thread/resume" || frame.method === "thread/read"), "normal history reopening must observe the persisted Native thread mode");
      assert.ok(ownedModes.every(frame => frame.studioWorkMode === "kworker" && frame.errorCode === null), "reopening must retain Native KWorker metadata");
    }
    evidence.steps.push({ label: "native-html-explicit-feedback-read-write-and-iframe-reopen", taskId, threadId: htmlReference.threadId, originalRevision: htmlOriginalRevision, correctedRevision: htmlCorrectedRevision, modelFixtureRequests: model.requests.length });
    await shot(page, context, "08-native-html-corrected.png");

    evidence.stage = "owned-task-finished";
    evidence.steps.push({ label: "owned-task-terminal-before-cleanup", taskId });
    evidence.captureTimings = evidence.reviewWire.filter(frame => frame.kind === "completed").map(frame => {
      const capture = frame.fileChangesCapture;
      if (!capture) return { threadId: frame.turn?.threadId, turnId: frame.turn?.id, status: "notObserved" };
      const bound = capture.threadId === frame.turn?.threadId && capture.turnId === frame.turn?.id;
      return { threadId: frame.turn?.threadId, turnId: frame.turn?.id, status: bound ? "observed" : "bindingMismatch",
        captureId: capture.captureId, captureState: capture.state, artifactId: capture.artifactId,
        limitations: capture.limitations, base: bound ? captureSampleTiming(capture.base) : { status: "unknown" },
        head: bound ? captureSampleTiming(capture.head) : { status: "unknown" } };
    });
    evidence.captureStorage = await observeOwnedCaptureStorage(context.stateDir,
      evidence.captureTimings.some(capture => capture.base?.status === "observed" || capture.head?.status === "observed"));
    evidence.metrics = { stepCount: evidence.steps.length, firstPreviewMs: evidence.firstTaskPreviewMs ?? null,
      firstPreviewScope: "first matching Native task artifact opened in the file preview", modelFixtureRequests: model.requests.length };
    evidence.socketLifecycle = navigationSockets.snapshot();
    assert.equal(evidence.socketLifecycle.overflow, 0, "socket diagnostics must have complete creation ownership");
    assertDiagnostics(evidence);
    evidence.stage = "passed";
    await shot(page, context, "09-clean.png");
  } catch (error) {
    failure = error;
    evidence.nativeOutputs = await page.getByTestId("native-review-output").allTextContents().catch(() => []);
    evidence.fixtureRequestCount = model.requests.length;
    evidence.fixtureFailureRequests = model.requests.slice(-2).map(summarizeFixtureRequest);
    evidence.failure = error instanceof Error ? error.stack || error.message : String(error);
    await shot(page, context, `failure-${evidence.stage}.png`).catch(() => undefined);
  } finally {
    evidence.socketLifecycle = navigationSockets.snapshot();
    try {
      const currentContent = await readFile(messagePath, "utf8");
      if (currentContent !== originalContent) await writeFile(messagePath, originalContent, "utf8");
      assert.equal(await readFile(messagePath, "utf8"), originalContent);
      evidence.cleanup.push({ kind: "fixture-content", path: messagePath, restored: true });
    } catch (error) {
      evidence.cleanup.push({ kind: "fixture-content", path: messagePath, error: String(error) });
    }
    await context.writeArtifactJson("workspace-file-read-refresh.json", evidence);
  }
  if (failure) throw failure;
  return { host: workspaceHost, hostRuntime: evidence.hostRuntime, steps: evidence.steps, diagnostics: evidence.diagnostics, cleanup: evidence.cleanup };
});

function observe(page, evidence) {
  const context = () => ({ stage: evidence.stage, at: new Date().toISOString(), url: page.url() });
  page.on("pageerror", error => evidence.diagnostics.console.push({ type: "pageerror", text: error.message.slice(0, 1000), ...context() }));
  page.on("console", message => {
    if (message.type() === "error" || message.type() === "warning") evidence.diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 1000), ...context() });
  });
  page.on("response", response => { if (response.status() >= 400) evidence.diagnostics.failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname, ...context() }); });
  page.on("requestfailed", request => evidence.diagnostics.requestFailures.push({ error: request.failure()?.errorText || "unknown", path: new URL(request.url()).pathname, ...context() }));
}

function fixtureMessageText(message) {
  const content = message?.content;
  return (typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part?.text ?? "").join("\n") : "").replace(/\r\n?/g, "\n");
}

function captureSampleTiming(window) {
  if (window === null) return { status: "notObserved" };
  if (!window || !Number.isSafeInteger(window.startedAtMs) || !Number.isSafeInteger(window.completedAtMs) ||
    window.startedAtMs < 0 || window.completedAtMs < window.startedAtMs) return { status: "unknown" };
  return { status: "observed", startedAtMs: window.startedAtMs, completedAtMs: window.completedAtMs,
    durationMs: window.completedAtMs - window.startedAtMs };
}

async function observeOwnedCaptureStorage(stateDir, sampledCaptureObserved) {
  const root = resolve(stateDir), started = performance.now();
  const limits = { entries: 4096, depth: 16, elapsedMs: 3000 };
  const names = ["turn-file-changes", "turn-file-captures", "turn-review-evidence"];
  const families = Object.fromEntries(names.map(name => [name, []]));
  const pending = [{ path: root, depth: 0, active: [] }];
  const issues = [], scratchPaths = [];
  let visited = 0, skippedLinks = 0, scratchCount = 0, complete = true;
  while (pending.length) {
    if (visited >= limits.entries || performance.now() - started >= limits.elapsedMs) {
      complete = false; issues.push("scan_budget_reached"); break;
    }
    const node = pending.pop();
    if (node.path !== root && !node.path.startsWith(`${root}${sep}`)) {
      complete = false; issues.push("path_outside_owned_state"); continue;
    }
    let info;
    try { info = await lstat(node.path); }
    catch (error) { complete = false; if (issues.length < 16) issues.push({ path: relative(root, node.path), code: error.code ?? "unavailable" }); continue; }
    visited += 1;
    const name = node.path.slice(node.path.lastIndexOf(sep) + 1);
    if (node.active.some(item => item.family === "turn-file-changes") &&
      (/^snapshot-repository-/.test(name) || /^capture-view-/.test(name) || /^snapshot-.*\.index$/.test(name))) {
      scratchCount += 1;
      if (scratchPaths.length < 16) scratchPaths.push(relative(root, node.path));
    }
    if (info.isSymbolicLink()) { skippedLinks += 1; continue; }
    if (info.isFile()) {
      for (const item of node.active) { item.fileCount += 1; item.logicalFileBytes += info.size; }
      continue;
    }
    if (!info.isDirectory()) continue;
    const active = [...node.active];
    if (names.includes(name)) {
      const item = { family: name, path: relative(root, node.path), fileCount: 0, logicalFileBytes: 0 };
      families[name].push(item); active.push(item);
    }
    if (node.depth >= limits.depth) { complete = false; if (issues.length < 16) issues.push("scan_depth_reached"); continue; }
    try {
      const entries = await readdir(node.path);
      if (entries.length > limits.entries - visited - pending.length) {
        complete = false; if (issues.length < 16) issues.push("directory_entry_budget_reached");
      }
      for (const child of entries.slice(0, Math.max(0, limits.entries - visited - pending.length)).sort().reverse())
        pending.push({ path: resolve(node.path, child), depth: node.depth + 1, active });
    } catch (error) { complete = false; if (issues.length < 16) issues.push({ path: relative(root, node.path), code: error.code ?? "unavailable" }); }
  }
  const observedChanges = families["turn-file-changes"].length > 0;
  return { scope: "RunContext state only; lstat metadata, no symlink traversal or file contents", limits, visited,
    complete, elapsedMs: performance.now() - started, skippedLinks, issues,
    families: Object.fromEntries(names.map(name => [name, { status: families[name].length ? complete ? "observed" : "partial" : complete ? "notObserved" : "unknown",
      directories: families[name], fileCount: families[name].length ? families[name].reduce((sum, item) => sum + item.fileCount, 0) : null,
      logicalFileBytes: families[name].length ? families[name].reduce((sum, item) => sum + item.logicalFileBytes, 0) : null }])),
    snapshotScratch: { status: !complete || !observedChanges || !sampledCaptureObserved ? "unknown" : scratchCount ? "remaining" : "releasedAfterSampledTurns",
      observedRemainingCount: observedChanges && complete ? scratchCount : null, paths: scratchPaths } };
}

function reviewTaskMarker(text) {
  return text.split("\n").flatMap(line => reviewTaskMarkers.filter(marker => line.startsWith(marker) && (line.length === marker.length || /\s/.test(line[marker.length])))).at(-1) ?? null;
}

function summarizeFixtureRequest(request) {
  const messages = request.messages ?? [];
  const lastUserIndex = messages.findLastIndex(message => message.role === "user");
  const selectedUserIndex = messages.findLastIndex(message => message.role === "user" && reviewTaskMarker(fixtureMessageText(message)));
  const user = index => index < 0 ? null : { index, length: fixtureMessageText(messages[index]).length, text: fixtureMessageText(messages[index]).slice(-4096) };
  return { messageCount: messages.length, omittedLeadingMessages: Math.max(0, messages.length - 24),
    roles: messages.slice(-24).map(message => ({ role: message.role, marker: reviewTaskMarker(fixtureMessageText(message)), toolCallId: message.tool_call_id ?? null })),
    lastUser: user(lastUserIndex), selectedUser: user(selectedUserIndex) };
}

async function fillReviewComposer(page, text) {
  const input = page.getByTestId("chat-message-input");
  if (!text.includes("\n")) await input.fill(text);
  else {
    // The real composer has one paragraph and uses Shift+Enter hard breaks.
    await input.click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (index) await page.keyboard.press("Shift+Enter");
      if (lines[index]) await page.keyboard.insertText(lines[index]);
    }
  }
  await waitFor(async () => (await input.innerText()).replace(/\r\n?/g, "\n").trimEnd() === text.trimEnd(), 10000, "complete explicit review draft in the real composer");
}

function assertDiagnostics(evidence) {
  assert.deepEqual(evidence.diagnostics.console.filter(entry => entry.type === "error" || entry.type === "pageerror"), [], "文件流程出现 console/page error");
  assert.deepEqual(evidence.diagnostics.failedResponses, [], "文件流程出现 4xx/5xx");
  assert.deepEqual(evidence.diagnostics.requestFailures, [], "文件流程出现 request failure");
  assert.deepEqual(evidence.diagnostics.socketErrors.filter(error => error.disposition !== "expected-owned-reload-teardown"), [], "文件流程出现非预期 WebSocket error");
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

async function closeTaskReview(page) {
  const dialog = page.getByTestId("environment-task-review-dialog");
  if (await dialog.isVisible()) await dialog.getByTestId("environment-task-review-dialog-close").click();
  await dialog.waitFor({ state: "detached", timeout: 15_000 });
}

async function openTaskReviewResult(page, { turnId, artifactName, outcome }, evidence, label) {
  assert.ok(typeof turnId === "string" && turnId, "task review selection requires an authoritative Native turn ID");
  const dialog = page.getByTestId("environment-task-review-dialog");
  if (!(await dialog.isVisible())) await page.getByTestId("task-review-toolbar-button").click();
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  const selector = dialog.getByTestId("environment-task-review-turn-select");
  const result = dialog.getByTestId("environment-task-review-result");
  let observed = [];
  const selected = await waitFor(async () => {
    const candidates = await selector.locator("option").evaluateAll((options, requestedTurn) => options
      .filter(option => option.getAttribute("data-turn-id") === requestedTurn)
      .map(option => ({ value: option.value, turnId: option.getAttribute("data-turn-id"), messageId: option.getAttribute("data-message-id") })), turnId);
    observed = candidates;
    assert.ok(candidates.length <= 16, "task review turn exceeded the bounded result candidates");
    for (const candidate of candidates.reverse()) {
      assert.ok(candidate.messageId, "task review option must identify its actual message");
      await selector.selectOption(candidate.value);
      await waitFor(async () => await result.getAttribute("data-turn-id") === turnId &&
        await result.getAttribute("data-message-id") === candidate.messageId, 5000, "selected task review message identity");
      if (artifactName && !(await result.getByTestId("native-review-open-artifact").filter({ hasText: artifactName }).count())) continue;
      if (outcome && !(await result.getByTestId("native-review-outcome").filter({ hasText: outcome }).count())) continue;
      return candidate;
    }
    return null;
  }, 30000, `Native task review result for ${label}`);
  evidence.reviewDialogSelections ??= [];
  evidence.reviewDialogSelections.push({ label, turnId: selected.turnId, messageId: selected.messageId,
    observedMessages: observed.map(option => option.messageId) });
  assert.equal(await result.getAttribute("data-turn-id"), turnId);
  assert.equal(await result.getAttribute("data-message-id"), selected.messageId);
  return result;
}

async function shot(page, context, name) { const path = context.pathInCase(workspaceHost === "electron" ? installedDirectory ? "installed-electron" : "source-electron" : "system-chromium", "workspace-file-read", name); await mkdir(dirname(path), { recursive: true }); await page.screenshot({ path, fullPage: true }); }

async function openRightFiles(page) {
  const shell = page.getByTestId("right-workspace-panel-shell");
  await shell.waitFor({ state: "attached" });
  if (await shell.getAttribute("aria-hidden") === "true") await page.getByTestId("toggle-right-workspace-panel-button").click();
  const state = await waitFor(async () => {
    if (await page.getByTestId("workspace-file-tree").isVisible().catch(() => false)) return "files";
    if (await page.getByTestId("right-workspace-launcher").isVisible().catch(() => false)) return "launcher";
    return null;
  }, 30000, "file panel or launcher after workspace hydration");
  if (state === "launcher") await page.getByTestId("right-workspace-file-option").click();
  await page.getByTestId("workspace-file-tree").waitFor({ state: "visible", timeout: 30000 });
}

async function waitForWorkspaceTreeItem(page, label) {
  const host = page.getByTestId("workspace-file-tree-pierre");
  await host.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    expectedLabel => {
      const tree = document.querySelector('[data-testid="workspace-file-tree-pierre"]');
      const buttons = tree?.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [];
      return [...buttons].some(button => {
        const itemPath = button.getAttribute("data-item-path") ?? "";
        const ariaLabel = button.getAttribute("aria-label") ?? "";
        return ariaLabel === expectedLabel || itemPath.endsWith(`/${expectedLabel}`) || button.textContent?.trim().includes(expectedLabel);
      });
    },
    label,
    { timeout: 30_000 },
  );
  return host.evaluate(tree => ({
    hasShadowRoot: tree.shadowRoot !== null,
    items: [...(tree.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [])].map(button => ({
      ariaLabel: button.getAttribute("aria-label"),
      path: button.getAttribute("data-item-path"),
      text: button.textContent?.trim() ?? "",
    })),
  }));
}

async function clickWorkspaceTreeItem(page, label) {
  const clicked = await page.getByTestId("workspace-file-tree-pierre").evaluate((tree, expectedLabel) => {
    const buttons = tree.shadowRoot?.querySelectorAll('button[data-type="item"]') ?? [];
    const button = [...buttons].find(candidate => {
      const itemPath = candidate.getAttribute("data-item-path") ?? "";
      const ariaLabel = candidate.getAttribute("aria-label") ?? "";
      return ariaLabel === expectedLabel || itemPath.endsWith(`/${expectedLabel}`) || candidate.textContent?.trim().includes(expectedLabel);
    });
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, label);
  assert.equal(clicked, true, `无法点击文件树项目 ${label}`);
}

async function waitForFileContent(path, expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await readFile(path, "utf8").catch(() => null) === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await readFile(path, "utf8"), expected, "保存后的磁盘内容不匹配");
}

async function assertWorkspaceFilePath(page, expectedPath, evidence, label) {
  const expected = resolve(expectedPath);
  const field = page.getByTestId("workspace-file-path");
  let actual = null;
  try {
    await waitFor(async () => {
      if (await field.count() !== 1) return false;
      const text = (await field.innerText({ timeout: 1000 })).trim();
      actual = text ? resolve(text) : null;
      return actual === expected;
    }, 30000, `${label}: workspace file panel must resolve the exact path ${expected}`);
  } finally {
    evidence.pathChecks.push({ label, expected, actual, matches: actual === expected });
  }
  assert.equal(actual, expected, `${label} 的文件面板路径绑定错误`);
}
