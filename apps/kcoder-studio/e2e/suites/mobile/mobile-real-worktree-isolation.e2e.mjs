import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const execFile = promisify(execFileCallback);
const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-real-managed-worktree-cwd-and-file-isolation",
    tier: "full-integration",
    modelPolicy: "model-independent deterministic real app-server",
    retainSuccessLogs: true,
  },
  async (context) => {
    const sourceWorkspace = context.pathInState("source-repository");
    const marker = `MOBILE_WORKTREE_${Date.now()}`;
    await initRepository(sourceWorkspace, marker);

    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-worktree-gateway",
      workspace: sourceWorkspace,
      env: {
        KCODER_STUDIO_SCENARIO: "full-turn",
        KCODER_STUDIO_WEB_ROOT: mobileDist,
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-worktree-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = [];
    const rpcRequests = [];
    const rpcResponses = [];
    let socketSequence = 0;
    page.on("pageerror", (error) =>
      diagnostics.push(`pageerror: ${error.message}`),
    );
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        diagnostics.push(`${message.type()}: ${message.text()}`);
    });
    page.on("websocket", (socket) => {
      const socketId = ++socketSequence;
      socket.on("framesent", (event) =>
        recordRequest(event.payload, rpcRequests, socketId),
      );
      socket.on("framereceived", (event) =>
        recordResponse(event.payload, rpcResponses, socketId),
      );
    });

    await connect(page, gateway);
    const gatewayRpcToken = await page
      .locator('meta[name="kcoder-rpc-token"]')
      .getAttribute("content");
    assert.ok(gatewayRpcToken, "登录后的页面必须注入 Gateway RPC token");
    const profileId = profileIdFromHome(page.url());
    await page.getByTestId("new-workspace").click();
    await page.getByTestId("server-option-local").click();
    await page
      .getByTestId("workspace-path")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      resolve(await page.getByTestId("workspace-path").inputValue()),
      resolve(sourceWorkspace),
    );
    await page.getByTestId("workspace-isolation-worktree").click();
    await page.getByTestId("workspace-git-ref").fill("main");
    await page.getByTestId("new-workspace-prompt").fill(marker);
    await page.getByTestId("create-workspace").click();
    await page
      .getByTestId("message-user")
      .filter({ hasText: marker })
      .waitFor({ state: "visible", timeout: 60_000 });
    await page
      .getByTestId("send-message")
      .waitFor({ state: "visible", timeout: 30_000 });
    const taskUrl = page.url();

    const prepareRequest = await waitForRpc(page, () =>
      rpcRequests.find(
        (request) => request.method === "runtime.worktrees.prepare",
      ),
    );
    assert.equal(
      resolve(prepareRequest.params?.sourcePath),
      resolve(sourceWorkspace),
    );
    assert.equal(prepareRequest.params?.ref, "main");
    assert.match(prepareRequest.params?.worktreeId ?? "", /^mobile-/);
    const prepareResponse = await waitForRpc(page, () =>
      rpcResponses.find(
        (response) =>
          response.socketId === prepareRequest.socketId &&
          response.id === prepareRequest.id,
      ),
    );
    await context.writeArtifactJson("mobile-real-worktree-rpc-trace.json", {
      prepareRequest,
      prepareResponse,
      rpcRequests,
      rpcResponses,
    });
    assert.equal(prepareResponse.error, null);
    assert.equal(prepareResponse.result?.success, true);
    const worktreePath = resolve(prepareResponse.result.path);
    assert.notEqual(worktreePath, resolve(sourceWorkspace));
    assert.match(worktreePath, /[/\\]managed-worktrees[/\\]/);
    assert.equal(
      resolve(new URL(page.url()).searchParams.get("cwd")),
      worktreePath,
    );

    const threadStart = rpcRequests.find(
      (request) => request.method === "thread/start",
    );
    assert.ok(threadStart, "创建任务必须通过真实 app-server 启动 thread");
    assert.equal(resolve(threadStart.params?.cwd), worktreePath);
    assert.equal(
      (
        await git(sourceWorkspace, ["worktree", "list", "--porcelain"])
      ).includes(`worktree ${worktreePath}`),
      true,
    );
    assert.equal(
      await readFile(resolve(worktreePath, "SOURCE_ONLY.txt"), "utf8"),
      `${marker}\n`,
    );

    await selectPanel(page, "terminal-1");
    const worktreeOnlyFile = resolve(worktreePath, "MOBILE_WORKTREE_ONLY.txt");
    await runCommand(page, "pwd", worktreePath);
    try {
      await runCommand(
        page,
        `printf '${marker}\\n' > MOBILE_WORKTREE_ONLY.txt && printf 'WT_OK\\n'`,
        "WT_OK",
      );
    } catch (error) {
      await context.writeArtifactJson(
        "mobile-real-worktree-terminal-failure.json",
        {
          transcript: await activeTerminal(page)
            .locator(".xterm-accessibility-tree")
            .innerText()
            .catch(() => ""),
          rpcRequests,
          rpcResponses,
        },
      );
      throw error;
    }
    assert.equal(await readFile(worktreeOnlyFile, "utf8"), `${marker}\n`);
    await assert.rejects(
      access(resolve(sourceWorkspace, "MOBILE_WORKTREE_ONLY.txt")),
      { code: "ENOENT" },
    );
    const currentBranch = (
      await git(worktreePath, ["branch", "--show-current"])
    ).trim();
    const sourceHead = (
      await git(sourceWorkspace, ["rev-parse", "HEAD"])
    ).trim();
    const worktreeHead = (
      await git(worktreePath, ["rev-parse", "HEAD"])
    ).trim();
    assert.equal(
      worktreeHead,
      sourceHead,
      "Git ref=main 创建的托管 worktree 必须从 source HEAD 起步",
    );

    await page.getByTestId("workspace-tab-switcher").click();
    const closeTerminal = page.locator('[aria-label^="关闭终端"]').first();
    await closeTerminal.waitFor({ state: "visible", timeout: 30_000 });
    page.once("dialog", (dialog) => void dialog.accept());
    await closeTerminal.click();
    await waitForRpc(page, () =>
      rpcRequests.find((request) => request.method === "terminal/close"),
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("workspace-tab-switcher").click();
    await page.getByTestId("workspace-tab-agent").click();
    await page
      .getByTestId("send-message")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      resolve(new URL(page.url()).searchParams.get("cwd")),
      worktreePath,
    );
    await page.getByLabel("返回", { exact: true }).first().click();
    await page
      .getByTestId("new-workspace")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("new-workspace").click();
    await page
      .getByTestId(`workspace-option-${encodeURIComponent(worktreePath)}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByTestId(`workspace-option-${encodeURIComponent(worktreePath)}`)
      .click();
    assert.equal(
      resolve(await page.getByTestId("workspace-path").inputValue()),
      worktreePath,
    );
    const nestedWorktreeControl = page.getByTestId(
      "workspace-isolation-worktree",
    );
    await page.waitForTimeout(500);
    const nestedWorktreeState = await nestedWorktreeControl.evaluate(
      (element) => ({
        disabled: "disabled" in element ? element.disabled : null,
        ariaDisabled: element.getAttribute("aria-disabled"),
        tabIndex: element.getAttribute("tabindex"),
        className: element.className,
      }),
    );
    if (
      nestedWorktreeState.ariaDisabled !== "true" ||
      nestedWorktreeState.tabIndex !== "-1"
    ) {
      await context.writeArtifactJson(
        "mobile-real-worktree-nested-control-failure.json",
        {
          worktreePath,
          selectedCwd: await page.getByTestId("workspace-path").inputValue(),
          nestedWorktreeState,
          rpcRequests,
          rpcResponses,
        },
      );
      await page.screenshot({
        path: context.pathInArtifacts(
          "mobile-real-worktree-nested-control-failure.png",
        ),
        fullPage: true,
      });
    }
    assert.equal(
      nestedWorktreeState.ariaDisabled,
      "true",
      "已存在的 worktree 必须禁止再次嵌套创建 worktree",
    );
    assert.equal(
      nestedWorktreeState.tabIndex,
      "-1",
      "已禁用的 worktree 操作不能进入键盘焦点顺序",
    );

    // Leaving the task page closes the target worktree's app-server and terminal.
    // Then use the source app-server for safety preflight, recoverable archival, and
    // recovery. The test operates only on its temporary Git repository.
    await page.goto(
      `${gateway.baseUrl}/open-project?profileId=${encodeURIComponent(profileId)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByTestId("open-project-route")
      .waitFor({ state: "visible", timeout: 30_000 });
    const managedCard = page.getByTestId(
      `managed-worktree-${prepareRequest.params.worktreeId}`,
    );
    await managedCard.waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByTestId(`archive-worktree-${prepareRequest.params.worktreeId}`)
      .click();
    await waitForArchiveConfirmation(page, context, rpcRequests, rpcResponses);
    await page.getByTestId("confirm-archive-worktree").click();
    await page
      .getByTestId(`restore-worktree-${prepareRequest.params.worktreeId}`)
      .waitFor({ state: "visible", timeout: 60_000 });
    const protectedForget = page.getByTestId(
      `forget-worktree-${prepareRequest.params.worktreeId}`,
    );
    assert.equal(
      await protectedForget.getAttribute("aria-disabled"),
      "true",
      "存在关联 thread 时永久删除必须保持禁用",
    );
    assert.equal(
      rpcRequests.some(
        (request) => request.method === "runtime.worktrees.forget",
      ),
      false,
    );
    await assert.rejects(access(worktreePath), { code: "ENOENT" });
    const archiveRpc = await waitForRpc(page, () =>
      rpcRequests.find(
        (request) => request.method === "runtime.worktrees.archive",
      ),
    );
    assert.equal(archiveRpc.params?.riskAccepted, true);
    assert.equal(typeof archiveRpc.params?.expectedRevision, "number");
    assert.equal(typeof archiveRpc.params?.expectedContentToken, "string");
    const archiveResponse = await waitForRpc(page, () =>
      rpcResponses.find(
        (response) =>
          response.socketId === archiveRpc.socketId &&
          response.id === archiveRpc.id,
      ),
    );
    assert.equal(archiveResponse.error, null);
    const protectedRevision = archiveResponse.result?.worktree?.revision;
    assert.equal(typeof protectedRevision, "number");

    const directRpcUrl = new URL(
      gatewayRpcUrl(gateway, "local", gatewayRpcToken),
    );
    directRpcUrl.searchParams.set("workspace", sourceWorkspace);
    const gatewaySessionId = (
      await page.context().cookies(gateway.baseUrl)
    ).find((cookie) => cookie.name === "kcoder_studio_session")?.value;
    assert.ok(gatewaySessionId, "登录后必须取得 Gateway session cookie");
    const directRpc = await openRpc(directRpcUrl.toString(), {
      headers: {
        Authorization: `Bearer ${gatewaySessionId}`,
        Origin: gateway.baseUrl,
        "Sec-WebSocket-Protocol": `kcoder-studio, kcoder-session.${gatewaySessionId}`,
      },
    });
    await initializeRpc(directRpc, "mobile-worktree-protection-e2e");
    await assert.rejects(
      directRpc.request("runtime.worktrees.forget", {
        deviceId: "local",
        path: worktreePath,
        expectedRevision: protectedRevision,
        confirmPermanent: true,
      }),
      /conversation references/,
      "服务端必须拒绝仍有关联会话的永久删除，不能只依赖 UI 禁用",
    );

    await page
      .getByTestId(`restore-worktree-${prepareRequest.params.worktreeId}`)
      .click();
    await page
      .getByTestId(`archive-worktree-${prepareRequest.params.worktreeId}`)
      .waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await readFile(worktreeOnlyFile, "utf8"), `${marker}\n`);
    const restoreRpc = await waitForRpc(page, () =>
      rpcRequests.find(
        (request) => request.method === "runtime.worktrees.restore",
      ),
    );
    assert.equal(typeof restoreRpc.params?.expectedRevision, "number");

    // Remove the associated thread through the real task UI before permanently deleting
    // its snapshot. The deletion path must also remove conversation references from the
    // worktree registry, otherwise the server should reject forget.
    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    await page
      .getByTestId("send-message")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByLabel("更多", { exact: true }).click();
    await page
      .getByTestId("delete-task")
      .waitFor({ state: "visible", timeout: 30_000 });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByTestId("delete-task").click();
    await page
      .getByTestId("new-workspace")
      .waitFor({ state: "visible", timeout: 60_000 });
    const conversationRemoveRpc = await waitForRpc(page, () =>
      rpcRequests.find(
        (request) =>
          request.method === "runtime.worktrees.conversations.remove",
      ),
    );
    const conversationRemoveResponse = await waitForRpc(page, () =>
      rpcResponses.find(
        (response) =>
          response.socketId === conversationRemoveRpc.socketId &&
          response.id === conversationRemoveRpc.id,
      ),
    );
    assert.equal(conversationRemoveResponse.error, null);
    assert.equal(conversationRemoveResponse.result?.removed, true);
    const afterConversationRemoval = await directRpc.request(
      "runtime.worktrees.list",
      { deviceId: "local" },
    );
    const unlinkedWorktree = afterConversationRemoval.items?.find(
      (item) => resolve(item.path) === worktreePath,
    );
    assert.deepEqual(
      unlinkedWorktree?.conversations ?? [],
      [],
      "会话删除成功响应后 registry 必须已无引用",
    );
    directRpc.close();
    await page.goto(
      `${gateway.baseUrl}/open-project?profileId=${encodeURIComponent(profileId)}`,
      { waitUntil: "domcontentloaded" },
    );
    await page
      .getByTestId("open-project-route")
      .waitFor({ state: "visible", timeout: 30_000 });

    await page
      .getByTestId(`archive-worktree-${prepareRequest.params.worktreeId}`)
      .click();
    await page
      .getByTestId("archive-worktree-confirmation")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("confirm-archive-worktree").click();
    await page
      .getByTestId(`forget-worktree-${prepareRequest.params.worktreeId}`)
      .waitFor({ state: "visible", timeout: 60_000 });
    await page
      .getByTestId(`forget-worktree-${prepareRequest.params.worktreeId}`)
      .click();
    await page
      .getByTestId("forget-worktree-confirmation")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByTestId("forget-worktree-name")
      .fill(prepareRequest.params.worktreeId);
    await page.getByTestId("confirm-forget-worktree").click();
    await managedCard.waitFor({ state: "detached", timeout: 60_000 });
    const forgetRpc = await waitForRpc(page, () =>
      rpcRequests.find(
        (request) => request.method === "runtime.worktrees.forget",
      ),
    );
    assert.equal(forgetRpc.params?.confirmPermanent, true);
    assert.equal(typeof forgetRpc.params?.expectedRevision, "number");

    assert.deepEqual(diagnostics, []);
    await context.writeArtifactJson("mobile-real-worktree-isolation.json", {
      sourceWorkspace,
      worktreePath,
      currentBranch,
      detachedHead: currentBranch === "",
      sourceHead,
      worktreeHead,
      marker,
      prepareRequest,
      prepareResponse,
      threadStart,
      terminalFile: worktreeOnlyFile,
      sourceFileAbsent: true,
      reloadRestoredCwd: true,
      activeWorktreeRediscovered: true,
      nestedWorktreeState,
      archiveRpc,
      restoreRpc,
      archiveResponse,
      conversationRemoveRpc,
      conversationRemoveResponse,
      forgetRpc,
      lifecycleCompleted: true,
      diagnostics,
    });
    return {
      realAppServer: true,
      managedWorktree: true,
      gitRef: true,
      taskCwd: true,
      terminalFileIsolation: true,
      reloadPersistence: true,
      activeWorktreeRediscovery: true,
      archiveRestoreForgetLifecycle: true,
    };
  },
);

async function initRepository(path, marker) {
  await mkdir(path, { recursive: true });
  await writeFile(resolve(path, "SOURCE_ONLY.txt"), `${marker}\n`, "utf8");
  await git(path, ["init", "-b", "main"]);
  await git(path, ["config", "user.name", "KCoder E2E"]);
  await git(path, ["config", "user.email", "kcoder-e2e@example.invalid"]);
  await git(path, ["add", "SOURCE_ONLY.txt"]);
  await git(path, ["commit", "-m", "mobile worktree fixture"]);
}

async function git(cwd, args) {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout;
}

function recordRequest(payload, output, socketId) {
  try {
    const value = JSON.parse(String(payload));
    if (value?.method)
      output.push({
        socketId,
        id: value.id,
        method: value.method,
        params: value.params ?? null,
      });
  } catch {}
}

function recordResponse(payload, output, socketId) {
  try {
    const value = JSON.parse(String(payload));
    if (value?.id !== undefined)
      output.push({
        socketId,
        id: value.id,
        result: value.result ?? null,
        error: value.error ?? null,
      });
  } catch {}
}

async function waitForRpc(page, read) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await page.waitForTimeout(50);
  }
  throw new Error("等待 WebSocket JSON-RPC 证据超时");
}

function activeTerminal(page) {
  return page.locator('[data-testid="terminal-panel"]:visible');
}

async function selectPanel(page, id) {
  await page.getByTestId("workspace-tab-switcher").click();
  await page.getByTestId(`workspace-tab-${id}`).click();
  await page
    .getByTestId("terminal-emulator")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function runCommand(page, command, expected) {
  const terminal = activeTerminal(page);
  const enter = terminal.getByLabel("Enter", { exact: true });
  await enter.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    (element) =>
      !element?.hasAttribute("disabled") &&
      element?.getAttribute("aria-disabled") !== "true",
    await enter.elementHandle(),
    { timeout: 30_000 },
  );
  await terminal.locator(".xterm-screen").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await terminal
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: expected })
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', {
      timeout: 30_000,
    }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page
    .getByTestId("new-workspace")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForArchiveConfirmation(
  page,
  context,
  rpcRequests,
  rpcResponses,
) {
  const confirmation = page.getByTestId("archive-worktree-confirmation");
  const error = page.getByTestId("open-project-error");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await confirmation.isVisible().catch(() => false)) return;
    if (await error.isVisible().catch(() => false)) {
      const message = await error.innerText();
      await context.writeArtifactJson(
        "mobile-worktree-archive-preview-failure.json",
        {
          message,
          rpcRequests,
          rpcResponses,
        },
      );
      throw new Error(`worktree 归档预检失败：${message}`);
    }
    await page.waitForTimeout(50);
  }
  throw new Error("等待 worktree 归档确认超时");
}

function profileIdFromHome(url) {
  const match = new URL(url).pathname.match(/^\/h\/([^/]+)/);
  assert.ok(match?.[1], `无法从首页 URL 解析 profileId: ${url}`);
  return decodeURIComponent(match[1]);
}
