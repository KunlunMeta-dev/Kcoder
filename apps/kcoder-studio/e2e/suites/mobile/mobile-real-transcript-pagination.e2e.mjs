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
const title = "MOBILE_TRANSCRIPT_PAGINATION_TARGET";
await access(resolve(mobileDist, "index.html"));

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-real-single-thread-transcript-pagination",
    tier: "full-integration",
    modelPolicy:
      "model-independent deterministic provider through a real app-server history cursor",
    retainSuccessLogs: true,
  },
  async (context) => {
    const workspace = context.pathInState("workspace");
    const configDir = context.pathInState("config");
    await mkdir(workspace, { recursive: true });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const model = await startApprovalModelFixture(context, { textOnly: true });
    const settingsFile = await context.writeStateJson(
      "transcript-settings.json",
      {
        active_provider: "transcript-seed",
        providers: {
          "transcript-seed": {
            api_format: "openai_chat_completions",
            endpoint: model.baseUrl,
            default_model: "transcript-e2e-model",
            context_window_tokens: 1000000,
            output_headroom_tokens: 8192,
            max_output_tokens: 8192,
            request_timeout_secs: 30,
            no_proxy: true,
            extra_body: {},
          },
        },
      },
    );
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "transcript-seed": { type: "api", key: "deterministic-local-fixture" },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Local",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "mobile-transcript-pagination-gateway",
      workspace,
      serversFile,
      env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
    });
    const token = await waitForGatewayRpcToken(context, gateway);
    const threadId = await seedThread(gateway, token);
    const seededHistory = await inspectHistory(gateway, token, threadId);
    await context.writeArtifactJson(
      "seeded-transcript-history.json",
      seededHistory,
    );
    assert.equal(
      seededHistory.userSentinels.length,
      26,
      `真实 app-server 源历史必须保留 26 条 user sentinel，实际 ${seededHistory.userSentinels.length}`,
    );

    const chromium = await startChromium(context, {
      label: "mobile-transcript-pagination-chromium",
    });
    const page = await chromium.browser.contexts()[0].newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    const diagnostics = [];
    const historyReads = [];
    page.on("pageerror", (error) =>
      diagnostics.push(`pageerror: ${error.message}`),
    );
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()))
        diagnostics.push(`${message.type()}: ${message.text()}`);
    });
    page.on("websocket", (socket) => {
      socket.on("framesent", (event) => {
        try {
          const value = JSON.parse(String(event.payload));
          if (["thread/read", "thread/read/indexed"].includes(value?.method))
            historyReads.push(value.params ?? {});
        } catch {}
      });
    });

    await connect(page, gateway);
    await page.getByTestId("sessions").click();
    await page.getByTestId("session-search").fill(title);
    await page
      .getByTestId(`session-${threadId}`)
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByTestId(`session-${threadId}`).click();
    await page
      .getByTestId("message-input-root")
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByTestId("message-user")
      .filter({ hasText: "TRANSCRIPT_SENTINEL_25" })
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page
        .getByTestId("message-user")
        .filter({ hasText: "TRANSCRIPT_SENTINEL_00" })
        .count(),
      0,
    );
    await page
      .getByTestId("load-older-messages")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      historyReads[0]?.beforeCursor,
      undefined,
      "首批 thread/read 不应携带 beforeCursor",
    );

    await page.getByTestId("load-older-messages").click();
    await page
      .getByTestId("message-user")
      .filter({ hasText: "TRANSCRIPT_SENTINEL_00" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByTestId("load-older-messages")
      .waitFor({ state: "hidden", timeout: 30_000 });
    await waitFor(
      () =>
        historyReads.some(
          (request) =>
            typeof request.beforeCursor === "string" && request.beforeCursor,
        ),
      30_000,
      "older transcript cursor request",
    );
    // Temporarily expand the test viewport so the complete transcript can reside in
    // the DOM, then read raw unsorted and non-deduplicated rows to verify strictly that pagination introduces neither duplicates nor reordering.
    await page.setViewportSize({ width: 390, height: 10_000 });
    await waitFor(
      async () => (await page.getByTestId("message-user").count()) === 26,
      30_000,
      "all paginated user rows mounted together",
    );
    const sentinelTexts = (
      await page.getByTestId("message-user").allInnerTexts()
    ).map((value) => value.match(/TRANSCRIPT_SENTINEL_\d{2}/)?.[0] ?? value);
    assert.deepEqual(
      sentinelTexts,
      Array.from(
        { length: 26 },
        (_, index) => `TRANSCRIPT_SENTINEL_${String(index).padStart(2, "0")}`,
      ),
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByTestId("message-user")
      .filter({ hasText: "TRANSCRIPT_SENTINEL_25" })
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await page
        .getByTestId("message-user")
        .filter({ hasText: "TRANSCRIPT_SENTINEL_00" })
        .count(),
      0,
      "刷新后应重新遵守服务端最近 50 条首屏边界",
    );
    await page
      .getByTestId("load-older-messages")
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.deepEqual(diagnostics, []);
    await context.writeArtifactJson("mobile-real-transcript-pagination.json", {
      threadId,
      turns: 26,
      messages: 52,
      historyReads,
      cursorPagination: true,
      noDuplicates: true,
      ordered: true,
      refreshRestoredFirstPageBoundary: true,
      diagnostics,
    });
    return {
      realAppServerHistory: true,
      messages: 52,
      cursorPagination: true,
      noDuplicates: true,
      ordered: true,
      refreshBoundary: true,
    };
  },
);

async function seedThread(gateway, token) {
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
  await initializeRpc(rpc, "mobile-transcript-pagination-seed");
  const started = await rpc.request("thread/start", {});
  for (let index = 0; index < 26; index += 1) {
    const prompt = `TRANSCRIPT_SENTINEL_${String(index).padStart(2, "0")}`;
    const turn = await rpc.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: prompt }],
    });
    await rpc.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === turn.turn.id,
      30_000,
      `transcript seed ${index}`,
    );
  }
  await rpc.request("thread/metadata/update", {
    threadId: started.thread.id,
    title,
  });
  rpc.close();
  await waitFor(
    () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
    5_000,
    "transcript seed RPC close",
  );
  return started.thread.id;
}

async function inspectHistory(gateway, token, threadId) {
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
  await initializeRpc(rpc, "mobile-transcript-pagination-inspector");
  const pages = [];
  const userSentinels = [];
  let beforeCursor;
  for (;;) {
    const page = await rpc.request("thread/read", {
      threadId,
      limit: 50,
      ...(beforeCursor ? { beforeCursor } : {}),
    });
    pages.push({
      rangeStart: page.rangeStart,
      rangeEnd: page.rangeEnd,
      hasMoreBefore: page.hasMoreBefore,
      beforeCursor: page.beforeCursor ?? null,
      messages: (page.messages ?? []).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
      })),
    });
    for (const message of page.messages ?? []) {
      if (
        message.role === "user" &&
        String(message.content).includes("TRANSCRIPT_SENTINEL_")
      ) {
        userSentinels.push(message.content);
      }
    }
    if (!page.hasMoreBefore || !page.beforeCursor) break;
    beforeCursor = page.beforeCursor;
  }
  rpc.close();
  await waitFor(
    () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
    5_000,
    "transcript inspector RPC close",
  );
  return { pages, userSentinels };
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page
    .getByTestId("welcome-direct-connection")
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
  await page.getByTestId("gateway-connect").click();
  await page
    .getByTestId("new-workspace")
    .waitFor({ state: "visible", timeout: 30_000 });
}
