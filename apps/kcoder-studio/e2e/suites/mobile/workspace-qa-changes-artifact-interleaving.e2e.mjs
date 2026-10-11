import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E } from "../../harness/run-context.mjs";

const execFile = promisify(execFileCallback);
const mobileDist = resolve(process.env.KCODER_E2E_MOBILE_WEB_ROOT || resolve(appRoot, "mobile/dist"));
const viewportWidth = Number(process.env.KCODER_E2E_VIEWPORT_WIDTH || 390);
assert.ok([360, 390, 768].includes(viewportWidth), "KCODER_E2E_VIEWPORT_WIDTH must be 360, 390, or 768");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: `workspace-qa-changes-artifact-interleaving-${viewportWidth}`,
  tier: "full-integration",
  modelPolicy: "deterministic provider through real Engine/app-server with two real Git file-change artifacts; stale review is released to the real server",
  retainSuccessLogs: true,
}, async context => {
  const repository = context.pathInState("repository");
  const workspace = resolve(repository, "nested-workspace");
  const configDir = context.pathInState("config");
  const changedFile = resolve(workspace, "qa-artifact.txt");
  await mkdir(workspace, { recursive: true });
  await execFile("git", ["init", "-b", "main"], { cwd: repository });
  await execFile("git", ["config", "user.email", "workspace-qa@kcoder.local"], { cwd: repository });
  await execFile("git", ["config", "user.name", "Workspace QA"], { cwd: repository });
  await writeFile(resolve(workspace, "README.md"), "workspace qa baseline\n");
  await execFile("git", ["add", "."], { cwd: repository });
  await execFile("git", ["commit", "-m", "workspace QA baseline"], { cwd: repository });
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const model = await startChangesModelFixture(context);
  const settingsFile = await context.writeStateJson("changes-qa-settings.json", {
    active_provider: "workspace-qa-changes",
    permission_mode: "yolo",
    providers: {
      "workspace-qa-changes": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "workspace-qa-changes-model",
        context_window_tokens: 128000,
        output_headroom_tokens: 8192,
        max_output_tokens: 8192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", { "workspace-qa-changes": { type: "api", key: "deterministic-local" } });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Local", transport: "local",
    command: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true,
    label: "workspace-qa-changes-gateway",
    workspace,
    serversFile,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "workspace-qa-changes-chromium" });
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
        if (value?.method !== "device/execute") return;
        const request = {
          id: value.id,
          commandKey: value.params?.command_key,
          artifactId: Array.isArray(value.params?.args) ? value.params.args[0] : null,
        };
        rpcRequests.push(request);
        methods.set(value.id, request);
      } catch {}
    });
    socket.on("framereceived", event => {
      try {
        const value = JSON.parse(String(event.payload));
        const request = methods.get(value?.id);
        if (!request) return;
        const stdout = value.result?.stdout && typeof value.result.stdout === "object" ? value.result.stdout : {};
        const commandError = typeof stdout.error === "string" ? context.redactText(stdout.error).slice(0, 500) : null;
        rpcResponses.push({
          id: value.id,
          commandKey: request.commandKey,
          artifactId: request.artifactId,
          error: value.error ? { code: value.error.code, message: value.error.message } : null,
          success: value.result?.success ?? null,
          commandSuccess: typeof stdout.success === "boolean" ? stdout.success : null,
          commandError,
        });
      } catch {}
    });
  });

  await connect(page, gateway);
  await createTask(page, "CREATE_CHANGE_ARTIFACT_A");
  await waitFor(() => readFile(changedFile, "utf8").then(value => value === "ARTIFACT_A\n").catch(() => false), 60_000, "回合 A 真实文件变更");
  await page.getByText("权限确认后的命令已执行。", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await page.getByTestId("message-input").fill("CREATE_CHANGE_ARTIFACT_B");
  await page.getByTestId("send-message").click();
  await waitFor(() => readFile(changedFile, "utf8").then(value => value === "ARTIFACT_B\n").catch(() => false), 60_000, "回合 B 真实文件变更");
  await page.getByText("权限确认后的命令已执行。", { exact: true }).last().waitFor({ state: "visible", timeout: 60_000 });

  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId("workspace-tab-changes").click();
  await page.getByTestId("changes-mode-turn").click();
  const changes = page.getByTestId("changes-panel");
  await changes.getByText("+ARTIFACT_B", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  const reviewB = rpcRequests.find(request => request.commandKey === "turn_file_changes_review");
  assert.ok(reviewB?.artifactId, "进入当前 Changes 应真实读取新回合 B 的 artifact");

  // The user switches to A while A's actual review request is held before send. B is then
  // selected in the history picker before A is released to the real app-server.
  await changes.getByText(/个已更改文件/).click();
  await page.getByText("回合变更 1", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(() => window.__workspaceQaRpcHoldNext("device/execute", { command_key: "turn_file_changes_review" }));
  await page.getByText("回合变更 1", { exact: true }).click();
  await waitForHeldRpc(page, "turn_file_changes_review");
  const heldReview = await page.evaluate(() => {
    const held = window.__workspaceQaRpcHeld.find(item => item.message.method === "device/execute" && item.message.params?.command_key === "turn_file_changes_review");
    if (!held) return null;
    return { id: held.message.id, commandKey: held.message.params.command_key, artifactId: held.message.params.args?.[0] ?? null };
  });
  assert.ok(heldReview?.artifactId && heldReview.artifactId !== reviewB.artifactId, "回合 A 必须触发另一个真实 artifact review");
  await changes.getByText(/个已更改文件/).click();
  await page.evaluate(() => window.__workspaceQaRpcHoldNext("device/execute", { command_key: "turn_file_changes_review" }));
  await page.getByText("回合变更 2", { exact: true }).click();

  // Fixed source starts B even while A is pending. Hold both client sends so we can release
  // A first and B second. The frozen pre-fix bundle won't start B until A settles.
  const heldB = await waitForValue(async () => page.evaluate(artifactId => {
    const item = window.__workspaceQaRpcHeld.find(held => held.message.method === "device/execute"
      && held.message.params?.command_key === "turn_file_changes_review"
      && held.message.params.args?.[0] === artifactId);
    return item ? { id: item.message.id, commandKey: item.message.params.command_key, artifactId: item.message.params.args?.[0] } : null;
  }, reviewB.artifactId), 2_000);
  if (!heldB) await page.evaluate(() => window.__workspaceQaRpcClearHold());
  await page.evaluate(id => window.__workspaceQaRpcRelease(id), heldReview.id);
  await waitForCondition(() => rpcResponses.some(response => response.id === heldReview.id), 60_000, "A review 的真实 app-server 响应");
  await page.waitForTimeout(250);
  const diffAfterLateA = await changes.innerText();
  const staleDiffAppeared = diffAfterLateA.includes("+ARTIFACT_A");
  if (heldB) {
    await page.evaluate(id => window.__workspaceQaRpcRelease(id), heldB.id);
  } else if (!diffAfterLateA.includes("+ARTIFACT_B")) {
    await changes.getByLabel("刷新 diff").click();
  }
  await changes.getByText("+ARTIFACT_B", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await changes.getByText("+ARTIFACT_B", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await changes.getByText("-ARTIFACT_A", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const finalDiffUsesB = true;

  // Hold an actual A revert at the browser transport boundary. B owns current disk
  // contents, so the real server must reject stale A without changing B's UI state.
  await changes.getByText(/个已更改文件/).click();
  await page.getByText("回合变更 1", { exact: true }).click();
  await changes.getByText("+ARTIFACT_A", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(() => window.__workspaceQaRpcHoldNext("device/execute", { command_key: "turn_file_changes_revert" }));
  const staleRevertDialogPromise = page.waitForEvent("dialog");
  const staleRevertClick = changes.getByLabel("撤销本回合变更").click();
  const staleRevertDialog = await staleRevertDialogPromise;
  assert.match(staleRevertDialog.message(), /撤销此回合/);
  await staleRevertDialog.accept();
  await staleRevertClick;
  await waitForHeldRpc(page, "turn_file_changes_revert");
  const heldRevertA = await waitForValue(async () => page.evaluate(artifactId => {
    const held = window.__workspaceQaRpcHeld.find(item => item.message.method === "device/execute"
      && item.message.params?.command_key === "turn_file_changes_revert"
      && item.message.params.args?.[0] === artifactId);
    return held ? { id: held.message.id, commandKey: held.message.params.command_key, artifactId: held.message.params.args?.[0] ?? null } : null;
  }, heldReview.artifactId), 2_000);
  assert.ok(heldRevertA, "回合 A 必须发出并挂起真实 revert RPC");
  await changes.getByText(/个已更改文件/).click();
  await page.getByText("回合变更 2", { exact: true }).click();
  const bDiffBeforeStaleRevertResponse = await waitForValue(async () => changes.getByText("+ARTIFACT_B", { exact: true }).isVisible().catch(() => false), 1_500);
  await page.evaluate(id => window.__workspaceQaRpcRelease(id), heldRevertA.id);
  await waitForCondition(() => rpcResponses.some(response => response.id === heldRevertA.id), 60_000, "A revert 的真实 app-server 响应");
  await page.waitForTimeout(250);
  const staleRevertResponse = rpcResponses.find(response => response.id === heldRevertA.id) ?? null;
  const staleRevertAlert = changes.getByRole("alert");
  const staleRevertErrorVisibleUnderB = await staleRevertAlert.isVisible().catch(() => false);
  const staleRevertErrorText = staleRevertErrorVisibleUnderB ? await staleRevertAlert.innerText() : null;
  const bDiffPreservedAfterStaleRevert = await changes.getByText("+ARTIFACT_B", { exact: true }).isVisible().catch(() => false);
  const diskAfterStaleRevert = await readFile(changedFile, "utf8");
  if (staleRevertErrorVisibleUnderB) await staleRevertAlert.getByText("重试", { exact: true }).click();
  else if (!bDiffPreservedAfterStaleRevert) await changes.getByLabel("刷新 diff").click();
  await changes.getByText("+ARTIFACT_B", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await changes.getByText("-ARTIFACT_A", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const revertDialogPromise = page.waitForEvent("dialog");
  const revertClick = changes.getByLabel("撤销本回合变更").click();
  const revertDialog = await revertDialogPromise;
  assert.match(revertDialog.message(), /撤销此回合/);
  await revertDialog.accept();
  await revertClick;
  await waitFor(() => readFile(changedFile, "utf8").then(value => value === "ARTIFACT_A\n").catch(() => false), 30_000, "撤销 B 后磁盘恢复 A");
  await changes.getByText("已撤销", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const revertRequest = rpcRequests.filter(request => request.commandKey === "turn_file_changes_revert").at(-1);
  const report = {
    viewport: { width: viewportWidth, height: 844 },
    artifacts: { A: heldReview.artifactId, B: reviewB.artifactId },
    heldReviewA: heldReview,
    concurrentBReview: Boolean(heldB),
    selectedBBeforeRelease: true,
    heldReviewB: heldB,
    lateReviewAResponse: rpcResponses.find(response => response.id === heldReview.id) ?? null,
    staleDiffAppeared,
    diffAfterLateA: diffAfterLateA.slice(0, 4_000),
    finalDiffUsesB,
    heldRevertA,
    staleRevertResponse,
    bDiffBeforeStaleRevertResponse: Boolean(bDiffBeforeStaleRevertResponse),
    staleRevertErrorVisibleUnderB,
    staleRevertErrorText,
    bDiffPreservedAfterStaleRevert,
    diskAfterStaleRevert,
    revertRequest,
    diskAfterRevert: await readFile(changedFile, "utf8"),
    diagnostics,
    rpcRequests,
    rpcResponses,
  };
  await context.writeArtifactJson("workspace-qa-changes-artifact-interleaving.json", report);
  assert.deepEqual(diagnostics, []);
  assert.equal(staleDiffAppeared, false, "选择 B 后 A 的迟到 diff 不得展示在 B artifact 标题下");
  assert.equal(heldRevertA.artifactId, heldReview.artifactId, "切换到 B 不得把已发起的 A revert 重定向到 B");
  assert.equal(staleRevertErrorVisibleUnderB, false, "A revert 的迟到冲突不得显示在当前 B artifact 中");
  assert.equal(diskAfterStaleRevert, "ARTIFACT_B\n", "服务端拒绝过期的 A revert 后磁盘仍保持 B 内容");
  assert.equal(revertRequest?.artifactId, reviewB.artifactId, "撤销操作必须继续针对当前选中的 B artifact ID");
  assert.equal(await readFile(changedFile, "utf8"), "ARTIFACT_A\n");
  return {
    realEngineProducedTwoArtifacts: true,
    delayedReviewAReleasedToRealAppServer: true,
    selectedArtifactBShowsItsOwnDiff: true,
    revertUsesArtifactBId: true,
    diskRestoredToPriorArtifact: true,
  };
});

async function installRpcHold(page) {
  await page.addInitScript(() => {
    const originalSend = WebSocket.prototype.send;
    const state = { rule: null, held: [] };
    window.__workspaceQaRpcHeld = state.held;
    window.__workspaceQaRpcHoldNext = (method, params) => { state.rule = { method, params }; };
    window.__workspaceQaRpcClearHold = () => { state.rule = null; };
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
  await page.locator('[data-testid="new-workspace"]:visible').waitFor({ state: "visible", timeout: 30_000 });
}

async function createTask(page, prompt) {
  await page.locator('[data-testid="new-workspace"]:visible').click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("message-user").filter({ hasText: prompt }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForHeldRpc(page, commandKey) {
  await page.waitForFunction(commandKey => window.__workspaceQaRpcHeld.some(item => item.message.method === "device/execute" && item.message.params?.command_key === commandKey), commandKey, { timeout: 30_000 });
}

async function waitForValue(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  return null;
}

async function waitForCondition(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`等待 ${label} 超时 (${timeoutMs}ms)`);
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`等待 ${label} 超时 (${timeoutMs}ms)`);
}

async function startChangesModelFixture(context) {
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requestCount += 1;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const latest = messages.at(-1);
    const latestText = typeof latest?.content === "string"
      ? latest.content
      : Array.isArray(latest?.content)
        ? latest.content.filter(part => part?.type === "text").map(part => part.text ?? "").join("\n")
        : "";
    const command = latest?.role === "user"
      ? latestText.includes("CREATE_CHANGE_ARTIFACT_A")
        ? { id: "workspace-qa-artifact-a", command: "printf 'ARTIFACT_A\\n' > qa-artifact.txt" }
        : latestText.includes("CREATE_CHANGE_ARTIFACT_B")
          ? { id: "workspace-qa-artifact-b", command: "printf 'ARTIFACT_B\\n' > qa-artifact.txt" }
          : null
      : null;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const chunk = (delta, finishReason) => ({
      id: `workspace-qa-changes-${requestCount}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "workspace-qa-changes-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    if (command) {
      response.write(`data: ${JSON.stringify(chunk({
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: command.id,
          type: "function",
          function: {
            name: "bash",
            arguments: JSON.stringify({ command: command.command, description: "create deterministic workspace artifact", timeout: 10_000 }),
          },
        }],
      }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`);
    } else {
      response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "权限确认后的命令已执行。" }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  context.addCleanup("close workspace changes provider fixture", () => new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
    server.closeAllConnections?.();
  }));
  const address = server.address();
  context.registerPort("workspace-qa-changes-provider", address.port);
  return { baseUrl: `http://127.0.0.1:${address.port}/v1` };
}
