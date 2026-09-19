import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const execFile = promisify(execFileCallback);
const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-attachments-and-git-changes",
  tier: "full-integration",
  modelPolicy: "model-independent deterministic real app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("mobile-real-workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "mobile-change.txt"), "baseline\n");
  await execFile("git", ["init", "-b", "main"], { cwd: workspace });
  await execFile("git", ["config", "user.email", "mobile-e2e@kcoder.local"], { cwd: workspace });
  await execFile("git", ["config", "user.name", "Mobile E2E"], { cwd: workspace });
  await execFile("git", ["add", "."], { cwd: workspace });
  await execFile("git", ["commit", "-m", "baseline"], { cwd: workspace });
  for (const branch of ["feature/alpha", "feature/beta", "release/candidate", "bugfix/mobile-filter"]) {
    await execFile("git", ["branch", branch], { cwd: workspace });
  }
  await writeFile(resolve(workspace, "mobile-change.txt"), "baseline\nmobile real change\n");

  const gateway = await startGateway(context, {
    auth: true, label: "mobile-real-gateway", workspace,
    env: { KCODER_STUDIO_SCENARIO: "full-turn", KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-real-chromium" });
  const browserContext = chromium.browser.contexts()[0];
  const page = await browserContext.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = { console: [], pageErrors: [], failedResponses: [], requestFailures: [] };
  const rpcMethods = [];
  const rpcResponses = [];
  const rpcRequests = [];
  page.on("pageerror", error => diagnostics.pageErrors.push(error.message));
  page.on("console", message => { if (["error", "warning"].includes(message.type())) diagnostics.console.push(`${message.type()}: ${message.text()}`); });
  page.on("response", response => { if (response.status() >= 400) diagnostics.failedResponses.push(`${response.status()} ${response.url()}`); });
  page.on("requestfailed", request => diagnostics.requestFailures.push(`${request.failure()?.errorText} ${request.url()}`));
  page.on("websocket", socket => {
    socket.on("framesent", event => { try { const value = JSON.parse(String(event.payload)); if (value?.method) { rpcMethods.push(value.method); rpcRequests.push({ id: value.id, method: value.method, params: value.params ?? null }); } } catch {} });
    socket.on("framereceived", event => { try { const value = JSON.parse(String(event.payload)); if (value?.id !== undefined) rpcResponses.push({ id: value.id, result: value.result ?? null, error: value.error ?? null }); } catch {} });
  });

  await connect(page, gateway);
  await createTask(page, "MOBILE_REAL_ATTACHMENT_CHANGES");

  await page.getByTestId("composer-attachment").click();
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByText("选择文件", { exact: true }).click();
  const chooser = await chooserPromise;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await chooser.setFiles({ name: "mobile-real.png", mimeType: "image/png", buffer: png });
  await page.getByText("mobile-real.png", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const stagedReadCount = rpcMethods.filter(method => method === "attachment/read").length;
  await page.getByTestId(`staged-attachment-${encodeURIComponent("mobile-real.png")}`).click();
  try {
    await page.getByTestId("attachment-lightbox-image").waitFor({ state: "visible", timeout: 10_000 });
  } catch (error) {
    await context.writeArtifactJson("staged-preview-failure.json", { rpcMethods, rpcResponses: rpcResponses.slice(-30), diagnostics, body: (await page.locator("body").innerText()).slice(0, 8000) });
    await capture(page, context, "failure-staged-preview.png");
    throw error;
  }
  await page.getByTestId("attachment-lightbox-backdrop").click({ position: { x: 5, y: 5 } });
  assert.equal(rpcMethods.filter(method => method === "attachment/read").length, stagedReadCount, "发送前本地预览不应读取服务端 thread 附件");
  await page.getByLabel("移除 mobile-real.png").click();
  await page.getByText("mobile-real.png", { exact: true }).waitFor({ state: "detached", timeout: 30_000 });
  await page.getByTestId("composer-attachment").click();
  const replacementChooserPromise = page.waitForEvent("filechooser");
  await page.getByText("选择文件", { exact: true }).click();
  await (await replacementChooserPromise).setFiles({ name: "mobile-real.png", mimeType: "image/png", buffer: png });
  await page.getByText("mobile-real.png", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("message-input").fill("请确认真实附件");
  await page.getByTestId("send-message").click();
  const attachment = page.getByTestId(`message-attachment-${encodeURIComponent("mobile-real.png")}`);
  await attachment.waitFor({ state: "visible", timeout: 30_000 });
  await attachment.click();
  await page.getByTestId("attachment-lightbox-image").waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(rpcMethods.filter(method => method === "attachment/read").length, stagedReadCount + 1, "历史消息预览应读取服务端附件");
  await capture(page, context, "01-real-attachment-preview.png");
  await page.getByTestId("attachment-lightbox-backdrop").click({ position: { x: 5, y: 5 } });

  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId("workspace-tab-changes").click();
  await page.getByTestId("changes-panel").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText("mobile-change.txt", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("git-stage-all").click();
  await page.getByTestId("changes-mode-staged").click();
  await page.getByText("mobile-change.txt", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("git-open-commit").click();
  await page.getByTestId("git-commit-message").fill("mobile real changes e2e");
  await page.getByTestId("git-commit").click();
  await page.getByTestId("changes-mode-committed").click();
  await page.getByText("mobile-change.txt", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, context, "02-real-git-committed.png");
  await page.getByTestId("changes-mode-working").click();
  await page.getByText("工作树是干净的", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("刷新 Git 变更").click();
  await page.getByText("工作树是干净的", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByLabel("当前分支 main，打开分支菜单").click();
  await page.getByTestId("git-branch-filter").fill("no-such-mobile-branch");
  await page.getByText("没有匹配的分支", { exact: true }).waitFor({ state: "visible" });
  await page.getByLabel("当前分支 main，打开分支菜单").click();
  await page.getByLabel("当前分支 main，打开分支菜单").click();
  assert.equal(await page.getByTestId("git-branch-filter").inputValue(), "", "重新打开分支菜单应清空过滤词");
  await page.getByTestId("git-branch-filter").fill("BETA");
  await page.getByTestId(`git-branch-option-${encodeURIComponent("feature/beta")}`).waitFor({ state: "visible" });
  assert.equal(await page.getByTestId(`git-branch-option-${encodeURIComponent("feature/alpha")}`).count(), 0);
  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId(`git-branch-option-${encodeURIComponent("feature/beta")}`).click();
  await page.getByLabel("当前分支 feature/beta，打开分支菜单").waitFor({ state: "visible", timeout: 30_000 });

  const { stdout: log } = await execFile("git", ["log", "main", "-1", "--pretty=%s"], { cwd: workspace });
  assert.equal(log.trim(), "mobile real changes e2e");
  assert.equal((await execFile("git", ["branch", "--show-current"], { cwd: workspace })).stdout.trim(), "feature/beta");
  assert.equal((await execFile("git", ["show", "main:mobile-change.txt"], { cwd: workspace })).stdout, "baseline\nmobile real change\n");
  const deleteRequest = rpcRequests.find(request => request.method === "attachment/delete");
  assert.ok(deleteRequest, `缺少移除 attachment/delete: ${rpcMethods.join(",")}`);
  assert.ok(rpcResponses.some(response => response.id === deleteRequest.id && response.error === null), "attachment/delete 应成功响应");
  const attachmentDeletesBeforeTaskDelete = rpcMethods.filter(method => method === "attachment/delete").length;
  await page.locator('[data-testid="workspace-tab-switcher"]:visible').click();
  await page.locator('[data-testid="workspace-tab-agent"]:visible').click();
  await page.locator('[aria-label="更多"]:visible').click();
  const taskMenu = page.getByRole("dialog", { name: "任务操作" });
  page.once("dialog", dialog => dialog.accept());
  await taskMenu.getByText("删除任务", { exact: true }).click();
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
  await context.writeArtifactJson("attachment-task-delete-cleanup-trace.json", {
    attachmentDeletesBeforeTaskDelete,
    attachmentDeletesAfterTaskDelete: rpcMethods.filter(method => method === "attachment/delete").length,
    threadDeletes: rpcMethods.filter(method => method === "thread/delete").length,
    rpcMethods,
    rpcRequests,
    diagnostics,
  });
  const taskDeleteAttachmentPaths = rpcRequests
    .filter(request => request.method === "attachment/delete")
    .slice(attachmentDeletesBeforeTaskDelete)
    .map(request => request.params?.path);
  assert.equal(taskDeleteAttachmentPaths.length, 2,
    "永久删除含附件任务必须清理 staging 上传文件与 thread 历史持久副本");
  assert.equal(new Set(taskDeleteAttachmentPaths).size, taskDeleteAttachmentPaths.length,
    "同一 attachment path 在一次任务删除中只能清理一次");
  assert.equal(rpcMethods.filter(method => method === "thread/delete").length, 1);
  assert.deepEqual(diagnostics, { console: [], pageErrors: [], failedResponses: [], requestFailures: [] });
  await context.writeArtifactJson("mobile-real-attachments-changes.json", { workspace, diagnostics, rpcMethods, attachment: "mobile-real.png", commit: log.trim(), attachmentCleanedOnTaskDelete: true });
  return { realAppServer: true, attachmentRemoveAndReupload: true, attachmentUploadPreview: true, gitStageCommitRefreshAndEmpty: true, attachmentCleanedOnTaskDelete: true };
});

async function connect(page, gateway) {
  const response = await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }), page.locator('button[type="submit"]').click()]);
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

async function capture(page, context, filename) {
  const path = context.pathInCase("system-chromium", "mobile-real", filename);
  await mkdir(resolve(path, ".."), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
