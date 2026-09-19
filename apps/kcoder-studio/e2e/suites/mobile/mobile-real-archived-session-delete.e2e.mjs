import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-real-archived-session-delete",
    tier: "full-integration",
    modelPolicy: "model-independent deterministic real app-server",
    retainSuccessLogs: true,
  },
  async (context) => {
    const workspace = context.pathInState("workspace");
    await mkdir(workspace, { recursive: true });
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-archived-session-delete-gateway",
      workspace,
      env: {
        KCODER_STUDIO_SCENARIO: "full-turn",
        KCODER_STUDIO_WEB_ROOT: mobileDist,
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-archived-session-delete-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });

    const diagnostics = {
      console: [],
      pageErrors: [],
      failedResponses: [],
      requestFailures: [],
    };
    const rpcRequests = [];
    const rpcEvents = [];
    const rpcResponses = [];
    let socketSequence = 0;
    page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        diagnostics.console.push(`${message.type()}: ${message.text()}`);
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        diagnostics.failedResponses.push(
          `${response.status()} ${response.url()}`,
        );
    });
    page.on("requestfailed", (request) =>
      diagnostics.requestFailures.push(
        `${request.failure()?.errorText} ${request.url()}`,
      ),
    );
    page.on("websocket", (socket) => {
      const socketId = ++socketSequence;
      const socketUrl = new URL(socket.url());
      const socketInfo = {
        socketId,
        serverId: socketUrl.searchParams.get("server"),
        workspace: socketUrl.searchParams.get("workspace"),
        channel: socketUrl.searchParams.get("channel"),
      };
      socket.on("framesent", (event) => {
        try {
          const value = JSON.parse(String(event.payload));
          if (value?.method)
            rpcRequests.push({
              ...socketInfo,
              id: value.id,
              method: value.method,
              params: value.params ?? null,
            });
        } catch {}
      });
      socket.on("framereceived", (event) => {
        try {
          const value = JSON.parse(String(event.payload));
          if (value?.method)
            rpcEvents.push({
              ...socketInfo,
              method: value.method,
              params: value.params ?? null,
            });
          if (value?.id !== undefined && !value?.method) {
            rpcResponses.push({
              ...socketInfo,
              id: value.id,
              result: value.result ?? null,
              error: value.error ?? null,
            });
          }
        } catch {}
      });
    });

    await connect(page, gateway);
    await createTask(page, "ARCHIVED_SESSION_DELETE_BOOTSTRAP");
    const threadId = decodeURIComponent(
      new URL(page.url()).pathname.split("/").at(-1),
    );
    assert.match(threadId, /^[A-Za-z0-9._:-]+$/);

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await page.getByTestId("composer-attachment").click();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByText("选择文件", { exact: true }).click();
    await (
      await chooserPromise
    ).setFiles({
      name: "archived-session.png",
      mimeType: "image/png",
      buffer: png,
    });
    await page
      .getByText("archived-session.png", { exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    await send(page, "ARCHIVED_SESSION_ATTACHMENT", rpcRequests, rpcEvents);

    // Twenty-seven complete turns plus startup messages produce more than one 50-item thread/read page.
    for (let index = 0; index < 26; index += 1)
      await send(
        page,
        `ARCHIVED_SESSION_PAGE_${index}`,
        rpcRequests,
        rpcEvents,
      );

    await page
      .getByTestId("message-input")
      .fill("ARCHIVED_SESSION_UNSENT_DRAFT");
    await page.waitForTimeout(800);
    const workspaceKeysBeforeArchive = await workspaceKeys(page, threadId);
    assert.ok(
      workspaceKeysBeforeArchive.length > 0,
      "归档前应存在该任务的本地 workspace state",
    );

    await page.getByLabel("更多").click();
    const taskMenu = page.getByRole("dialog", { name: "任务操作" });
    page.once("dialog", (dialog) => dialog.accept());
    await taskMenu.getByText("归档任务", { exact: true }).click();
    await page
      .locator('[data-testid="new-workspace"]:visible')
      .waitFor({ state: "visible", timeout: 30_000 });

    await page.locator('[data-testid="sessions"]:visible').click();
    await page.locator('[data-testid="sessions-archived"]:visible').click();
    const archivedRow = page.locator(
      `[data-testid="session-${threadId}"]:visible`,
    );
    await archivedRow.waitFor({ state: "visible", timeout: 30_000 });
    const workspaceKeysBeforeDelete = await workspaceKeys(page, threadId);
    assert.ok(
      workspaceKeysBeforeDelete.length > 0,
      "未打开的归档任务应仍保留 workspace state，供恢复时继续使用",
    );

    const deleteRequestOffset = rpcRequests.length;
    const deleteResponseOffset = rpcResponses.length;
    await page
      .locator(`[data-testid="session-actions-${threadId}"]:visible`)
      .click();
    const actions = page.getByRole("dialog", { name: "任务操作" });
    page.once("dialog", (dialog) => dialog.accept());
    await actions.getByTestId("thread-delete-action").click();
    await archivedRow.waitFor({ state: "detached", timeout: 30_000 });
    const deleteRequests = rpcRequests.slice(deleteRequestOffset);
    const deleteResponses = rpcResponses.slice(deleteResponseOffset);
    const historyReads = deleteRequests.filter(
      (request) => ["thread/read", "thread/read/indexed"].includes(request.method),
    );
    const attachmentDeletes = deleteRequests.filter(
      (request) => request.method === "attachment/delete",
    );
    const threadDeletes = deleteRequests.filter(
      (request) => request.method === "thread/delete",
    );
    const attachmentPaths = attachmentDeletes.map(
      (request) => request.params?.path,
    );

    await page.locator('[data-testid="sessions-active"]:visible').click();
    await page.waitForTimeout(400);
    assert.equal(
      await page.locator(`[data-testid="session-${threadId}"]:visible`).count(),
      0,
      "永久删除后最近任务中不能再出现该任务",
    );
    await page.locator('[data-testid="sessions-archived"]:visible').click();
    await page.waitForTimeout(400);
    assert.equal(
      await page.locator(`[data-testid="session-${threadId}"]:visible`).count(),
      0,
      "永久删除后归档任务中不能再出现该任务",
    );
    const workspaceKeysAfterDelete = await workspaceKeys(page, threadId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .locator('[data-testid="sessions-archived"]:visible')
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(400);
    assert.equal(
      await page.locator(`[data-testid="session-${threadId}"]:visible`).count(),
      0,
      "刷新后归档任务不能重新出现",
    );
    await page.locator('[data-testid="sessions-active"]:visible').click();
    await page.waitForTimeout(400);
    assert.equal(
      await page.locator(`[data-testid="session-${threadId}"]:visible`).count(),
      0,
      "刷新后最近任务不能重新出现",
    );

    await context.writeArtifactJson("archived-session-delete-trace.json", {
      threadId,
      workspaceKeysBeforeArchive,
      workspaceKeysBeforeDelete,
      workspaceKeysAfterDelete,
      historyReads,
      threadDeletes,
      attachmentDeletes,
      deleteRequests,
      deleteResponses,
      diagnostics,
    });
    assert.ok(
      historyReads.length >= 2,
      `超过 50 条的任务历史删除应分页读取，实际 ${historyReads.length} 页`,
    );
    assert.equal(
      historyReads[0]?.params?.beforeCursor,
      undefined,
      "第一页不应携带 beforeCursor",
    );
    assert.ok(
      historyReads
        .slice(1)
        .every(
          (request) =>
            typeof request.params?.beforeCursor === "string" &&
            request.params.beforeCursor,
        ),
      "后续 thread/read 页必须携带服务端游标",
    );
    const historyRequest = historyReads[0];
    const registryRequest = deleteRequests.find(
      (request) => request.method === "runtime.worktrees.conversations.remove",
    );
    assert.ok(historyRequest, "归档删除必须通过任务 cwd 读取历史");
    assert.ok(
      registryRequest,
      "归档删除必须尝试清理 canonical worktree registry",
    );
    assert.notEqual(
      historyRequest.socketId,
      registryRequest.socketId,
      "历史/附件与 registry 清理必须使用两个独立 RPC client",
    );
    assert.equal(
      resolve(historyRequest.workspace),
      resolve(workspace),
      "历史 client 必须连接任务实际 cwd",
    );
    assert.equal(
      resolve(registryRequest.workspace),
      resolve(workspace),
      "registry client 必须连接 Gateway canonical workspace",
    );
    assert.equal(
      resolve(registryRequest.params?.path),
      resolve(workspace),
      "registry 清理参数必须保留任务实际 cwd",
    );
    assert.ok(
      deleteRequests
        .filter((request) =>
          ["thread/read", "thread/read/indexed", "thread/delete", "attachment/delete"].includes(
            request.method,
          ),
        )
        .every((request) => request.socketId === historyRequest.socketId),
      "历史分页、thread 删除和附件清理必须复用任务 cwd client",
    );
    assert.equal(
      deleteRequests.filter(
        (request) =>
          request.method === "initialize" &&
          request.socketId === historyRequest.socketId,
      ).length,
      1,
      "历史 client 只能初始化一次",
    );
    assert.equal(
      deleteRequests.filter(
        (request) =>
          request.method === "initialize" &&
          request.socketId === registryRequest.socketId,
      ).length,
      1,
      "registry client 只能初始化一次",
    );
    const registryResponse = deleteResponses.find(
      (response) =>
        response.socketId === registryRequest.socketId &&
        response.id === registryRequest.id,
    );
    assert.ok(
      registryResponse,
      "必须收到与 registry 清理请求同 socket/id 的响应",
    );
    assert.equal(
      threadDeletes.length,
      1,
      "从 Sessions 永久删除只能发送一次 thread/delete",
    );
    assert.ok(
      attachmentPaths.length >= 1,
      "应清理 thread 历史中的附件持久副本",
    );
    assert.equal(
      new Set(attachmentPaths).size,
      attachmentPaths.length,
      "同一 attachment path 在一次删除中只能清理一次",
    );
    assert.deepEqual(
      workspaceKeysAfterDelete,
      [],
      "永久删除后必须清除该任务全部本地 workspace state",
    );
    assert.deepEqual(diagnostics, {
      console: [],
      pageErrors: [],
      failedResponses: [],
      requestFailures: [],
    });

    return {
      archivedNonmatchingDelete: true,
      paginatedHistoryReads: historyReads.length,
      uniqueAttachmentDeletes: attachmentPaths.length,
      workspaceStateRemoved: true,
      removedFromActiveAndArchived: true,
    };
  },
);

async function connect(page, gateway) {
  const response = await page.goto(gateway.baseUrl, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response?.status(), 200);
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

async function createTask(page, prompt) {
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page
    .getByTestId("workspace-path")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill(prompt);
  await page.getByTestId("create-workspace").click();
  await page
    .getByTestId("message-user")
    .filter({ hasText: prompt })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("send-message")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function send(page, prompt, rpcRequests, rpcEvents) {
  const startsBefore = rpcRequests.filter(
    (request) => request.method === "turn/start",
  ).length;
  const completionsBefore = rpcEvents.filter(
    (event) => event.method === "turn/completed",
  ).length;
  await page.getByTestId("message-input").fill(prompt);
  await page.getByTestId("send-message").click();
  await waitFor(
    () =>
      rpcRequests.filter((request) => request.method === "turn/start").length >
      startsBefore,
    30_000,
    `${prompt} turn/start`,
  );
  await waitFor(
    () =>
      rpcEvents.filter((event) => event.method === "turn/completed").length >
      completionsBefore,
    30_000,
    `${prompt} turn/completed`,
  );
}

async function workspaceKeys(page, threadId) {
  return page.evaluate(
    (id) =>
      Object.keys(localStorage).filter(
        (key) =>
          key.includes("mobile-workspace") &&
          key.includes(encodeURIComponent(id)),
      ),
    threadId,
  );
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`等待 ${label} 超时 (${timeoutMs}ms)`);
}
