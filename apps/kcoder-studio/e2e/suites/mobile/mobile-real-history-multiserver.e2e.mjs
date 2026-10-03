import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import {
  appRoot,
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-real-history-multiserver-pagination-search",
    tier: "full-integration",
    modelPolicy: "model-independent real app-server thread history",
    retainSuccessLogs: true,
  },
  async (context) => {
    const workspaceA = context.pathInState("workspace-alpha");
    const workspaceB = context.pathInState("workspace-beta");
    const configDir = context.pathInState("config");
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true }),
      mkdir(configDir, { recursive: true, mode: 0o700 }),
    ]);
    const model = await startApprovalModelFixture(context, { textOnly: true });
    const settingsFile = await context.writeStateJson("history-settings.json", {
      active_provider: "history-seed",
      permission_mode: "yolo",
      providers: {
        "history-seed": {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          default_model: "history-e2e-model",
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
    await context.writeStateJson("config/credentials.json", {
      "history-seed": { type: "api", key: "deterministic-local-fixture" },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "alpha",
        label: "Alpha Host",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace: workspaceA,
        settingsFile,
      },
      {
        id: "beta",
        label: "Beta Host",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace: workspaceB,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "mobile-history-gateway",
      workspace: workspaceA,
      serversFile,
      env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
    });
    const token = await waitForGatewayRpcToken(context, gateway);
    const seedStartedAt = Date.now();
    const [alpha, beta] = await Promise.all([
      seedServer(gateway, token, "alpha", "ALPHA"),
      seedServer(gateway, token, "beta", "BETA"),
    ]);
    const seedDurationMs = Date.now() - seedStartedAt;

    const chromium = await startChromium(context, {
      label: "mobile-history-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = [];
    const threadListRequests = [];
    page.on("pageerror", (error) =>
      diagnostics.push(`pageerror: ${error.message}`),
    );
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        diagnostics.push(`${message.type()}: ${message.text()}`);
    });
    page.on("websocket", (socket) => {
      const socketServerId = new URL(socket.url()).searchParams.get("server");
      socket.on("framesent", (event) => {
        try {
          const value = JSON.parse(String(event.payload));
          if (value?.method === "thread/list")
            threadListRequests.push({
              serverId: socketServerId,
              params: value.params ?? {},
            });
        } catch {}
      });
    });

    await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
    await page
      .getByTestId("welcome-direct-connection")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("welcome-direct-connection").click();
    await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
    await page.getByTestId("gateway-connect").click();
    await page
      .getByTestId("sessions")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId("sessions").click();
    await page
      .getByTestId("sessions-host-all")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page.getByTestId(`session-${alpha.oldActive}`).count(),
      0,
      "第 51 页以前的 Alpha 目标不应已在首批结果中",
    );
    assert.equal(
      await page.getByTestId(`session-${beta.oldActive}`).count(),
      0,
      "第 51 页以前的 Beta 目标不应已在首批结果中",
    );

    await page
      .getByTestId("session-search")
      .fill("ALPHA_OLD_SERVER_QUERY_TARGET");
    try {
      await page
        .getByTestId(`session-${alpha.oldActive}`)
        .waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      await context.writeArtifactJson("history-server-query-failure.json", {
        alpha,
        beta,
        body: (await page.locator("body").innerText()).slice(0, 12_000),
        threadListRequests,
        diagnostics,
      });
      throw error;
    }
    assert.equal(
      await page.getByTestId(`session-${beta.oldActive}`).count(),
      0,
    );
    assert.ok(
      threadListRequests.some(
        (request) =>
          request.serverId === "alpha" &&
          request.params.query === "ALPHA_OLD_SERVER_QUERY_TARGET" &&
          request.params.archived === false,
      ),
      "搜索必须下推到真实 app-server，而非只过滤本地首批 50 条",
    );
    await page.getByLabel("清除搜索").click();
    const alphaUnfilteredRequestBaseline = threadListRequests.length;
    await page.getByTestId("sessions-host-alpha").click();
    await waitFor(
      () =>
        threadListRequests
          .slice(alphaUnfilteredRequestBaseline)
          .some(
            (request) =>
              request.serverId === "alpha" &&
              request.params.archived === false &&
              !request.params.query &&
              !request.params.cursor,
          ),
      30_000,
      "Alpha unfiltered first history page",
    );
    const list = page.getByTestId("sessions-list");
    await list.waitFor({ state: "visible", timeout: 30_000 });
    // FlatList may trigger onEndReached automatically for short or near-threshold content; with or without manual scrolling, consume only Alpha's cursor.
    const scrollMetrics = await list.evaluate((node) => {
      const ancestors = [];
      for (
        let current = node.parentElement;
        current;
        current = current.parentElement
      )
        ancestors.push(current);
      const candidates = [node, ...node.querySelectorAll("*"), ...ancestors];
      const target = candidates.sort(
        (left, right) =>
          right.scrollHeight -
          right.clientHeight -
          (left.scrollHeight - left.clientHeight),
      )[0];
      target.scrollTop = 0;
      return candidates
        .slice(0, 20)
        .map((candidate) => ({
          tag: candidate.tagName,
          testId: candidate.getAttribute("data-testid"),
          scrollHeight: candidate.scrollHeight,
          clientHeight: candidate.clientHeight,
          scrollTop: candidate.scrollTop,
          overflowY: getComputedStyle(candidate).overflowY,
        }));
    });
    const scrollTops = [];
    for (let index = 0; index < 15; index += 1) {
      const position = await list.evaluate((node) => {
        node.scrollBy({ top: 600, behavior: "instant" });
        return {
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
        };
      });
      scrollTops.push(position);
      await page.waitForTimeout(150);
      if (
        position.scrollTop >=
        position.scrollHeight - position.clientHeight - 2
      )
        break;
    }
    try {
      await waitFor(
        () =>
          threadListRequests
            .slice(alphaUnfilteredRequestBaseline)
            .some(
              (request) =>
                request.serverId === "alpha" &&
                typeof request.params.cursor === "string" &&
                request.params.archived === false,
            ),
        30_000,
        "Alpha cursor history page",
      );
    } catch (error) {
      const finalScroll = await list.evaluate((node) => ({
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        scrollTop: node.scrollTop,
      }));
      await context.writeArtifactJson("history-alpha-cursor-failure.json", {
        alpha,
        beta,
        alphaUnfilteredRequestBaseline,
        scrollMetrics,
        scrollTops,
        finalScroll,
        threadListRequests,
        body: (await page.locator("body").innerText()).slice(0, 12_000),
        diagnostics,
      });
      throw error;
    }
    await page
      .getByTestId(`session-${alpha.oldActive}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(
      threadListRequests.some(
        (request) =>
          request.serverId === "alpha" &&
          typeof request.params.cursor === "string" &&
          request.params.archived === false,
      ),
      "Alpha 分页必须使用 app-server cursor",
    );
    assert.ok(
      threadListRequests.some(
        (request) =>
          request.serverId === "alpha" &&
          !request.params.query &&
          request.params.archived === false &&
          !request.params.cursor,
      ),
      "分页前必须存在 Alpha 首批请求",
    );
    await page.getByTestId(`session-${alpha.oldActive}`).click();
    await page
      .locator('[data-testid="message-input"]:visible')
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.match(
      new URL(page.url()).pathname,
      new RegExp(`/task/alpha/${alpha.oldActive}$`),
      "跨 server 结果必须打开 Alpha server 的目标 thread",
    );
    const visibleBackButtons = page.locator('[aria-label="返回"]:visible');
    await visibleBackButtons
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await visibleBackButtons.count(),
      1,
      "当前任务只能有一个可见返回按钮",
    );
    await visibleBackButtons.click();
    await page
      .getByTestId("session-search")
      .fill("ALPHA_ARCHIVED_SERVER_QUERY_TARGET");
    await page.getByTestId("sessions-archived").click();
    await page
      .getByTestId(`session-${alpha.archived}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.ok(
      threadListRequests.some(
        (request) =>
          request.serverId === "alpha" &&
          request.params.query === "ALPHA_ARCHIVED_SERVER_QUERY_TARGET" &&
          request.params.archived === true,
      ),
    );
    assert.deepEqual(diagnostics, []);
    await context.writeArtifactJson("mobile-real-history-multiserver.json", {
      alpha,
      beta,
      seedThreadCount: alpha.count + beta.count,
      seedDurationMs,
      threadListRequests,
      serverSideSearch: true,
      independentServerFilter: true,
      cursorPagination: true,
      diagnostics,
    });
    return {
      realTwoServers: true,
      seedThreadCount: alpha.count + beta.count,
      seedDurationMs,
      firstPageBoundary: true,
      serverSideSearch: true,
      archivedIsolation: true,
      serverSpecificOpen: true,
      cursorPagination: true,
    };
  },
);

async function seedServer(gateway, token, serverId, prefix) {
  const rpc = await openRpc(gatewayRpcUrl(gateway, serverId, token));
  await initializeRpc(rpc, `mobile-history-${serverId}`);
  const create = async (title, archived = false) => {
    const started = await rpc.request("thread/start", {});
    const turn = await rpc.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: `HISTORY_SEED_${title}` }],
    });
    await rpc.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === turn.turn.id,
      30_000,
      `${serverId} seed turn ${title}`,
    );
    await rpc.request("thread/metadata/update", {
      threadId: started.thread.id,
      title,
      ...(archived ? { archivedAt: new Date().toISOString() } : {}),
    });
    return started.thread.id;
  };
  const oldActive = await create(`${prefix}_OLD_SERVER_QUERY_TARGET`);
  const archived = await create(`${prefix}_ARCHIVED_SERVER_QUERY_TARGET`, true);
  for (let index = 0; index < 55; index += 1)
    await create(`${prefix}_RECENT_FILLER_${String(index).padStart(2, "0")}`);
  const activeQuery = await rpc.request("thread/list", {
    limit: 50,
    archived: false,
    query: `${prefix}_OLD_SERVER_QUERY_TARGET`,
  });
  assert.ok(
    activeQuery.threads?.some((thread) => thread.id === oldActive),
    `${serverId} 真实 app-server 必须能全量搜索旧 active thread`,
  );
  const archivedQuery = await rpc.request("thread/list", {
    limit: 50,
    archived: true,
    query: `${prefix}_ARCHIVED_SERVER_QUERY_TARGET`,
  });
  assert.ok(
    archivedQuery.threads?.some((thread) => thread.id === archived),
    `${serverId} 真实 app-server 必须能搜索 archived thread`,
  );
  const firstPage = await rpc.request("thread/list", {
    limit: 50,
    archived: false,
  });
  assert.equal(
    firstPage.threads?.some((thread) => thread.id === oldActive),
    false,
    `${serverId} 旧目标必须真实位于首批 50 条之外`,
  );
  assert.equal(
    typeof firstPage.nextCursor,
    "string",
    `${serverId} 必须返回独立分页 cursor`,
  );
  rpc.close();
  await waitFor(
    () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
    5_000,
    `${serverId} seed RPC close`,
  );
  return { oldActive, archived, count: 57 };
}
