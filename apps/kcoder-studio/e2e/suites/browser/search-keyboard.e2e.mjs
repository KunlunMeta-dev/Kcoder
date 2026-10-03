import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(import.meta.url, {
  testId: "real-chromium-search-keyboard-opens-stable-task-address",
  tier: "pr-smoke",
  modelPolicy: "model-independent deterministic search, keyboard navigation and per-task summary visibility check",
  retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "search-keyboard",
  });
  const configDir = context.pathInState("config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("config/settings.json", {});
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Local",
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
  }]);
  const gateway = await startGateway(context, {
    label: "search-keyboard-gateway",
    workspace,
    serversFile,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_SCENARIO: "thinking-preview",
    },
  });
  const records = await seedSearchThreads(context, gateway);
  const chromium = await startChromium(context, { label: "search-keyboard-chromium" });
  const page = await chromium.newPage({ viewport: { width: 1280, height: 800 } });
  const response = await page.goto(`${gateway.baseUrl}/?e2e=1`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  await page.getByTestId("runtime-search-button").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("runtime-search-button").click();
  const input = page.getByTestId("workbench-search-input");
  await input.waitFor({ state: "visible" });
  await input.fill("稳定搜索地址");
  await page.getByTestId("workbench-search-result-1").waitFor({ state: "visible", timeout: 30_000 });
  await input.press("ArrowDown");
  const selected = page.locator('[role="option"][aria-selected="true"]');
  await selected.waitFor({ state: "visible" });
  const selectedText = await selected.innerText();
  const expected = records.find(record => selectedText.includes(record.title));
  assert.ok(expected, `selected search result did not map to a seeded task: ${selectedText}`);
  await input.press("Enter");
  await page.getByTestId("workbench-search-overlay").waitFor({ state: "detached" });
  await page.getByTestId("workbench-pane-task-title").getByText(expected.title, { exact: true }).waitFor({
    timeout: 30_000,
  });
  const stableRow = page.getByTestId(`runtime-local-task-row-kcoder:local:${expected.threadId}`);
  await stableRow.waitFor({ state: "visible" });
  await page.waitForFunction(prompt => document.body.innerText.includes(prompt), expected.prompt, {
    timeout: 30_000,
  });

  // A new task pane must not inherit another task's explicit summary choice.
  await assertSummaryExpanded(page, false);
  await page.getByTestId("environment-info-button").click();
  await assertSummaryExpanded(page, true);
  const other = records.find(record => record.threadId !== expected.threadId);
  assert.ok(other);
  await selectTask(page, other);
  await assertSummaryExpanded(page, false);
  await page.getByTestId("environment-info-button").click();
  await assertSummaryExpanded(page, true);
  await page.getByTestId("environment-info-button").click();
  await assertSummaryExpanded(page, false);
  await selectTask(page, expected);
  await assertSummaryExpanded(page, true);
  await selectTask(page, other);
  await assertSummaryExpanded(page, false);
  await selectTask(page, expected);
  await assertSummaryExpanded(page, true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-user").filter({ hasText: expected.prompt })
    .waitFor({ state: "visible", timeout: 30_000 });
  await assertSummaryExpanded(page, false);

  const screenshot = context.pathInCase("system-chromium", "keyboard-search", "selected-task.png");
  await mkdir(resolve(screenshot, ".."), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  return {
    query: "稳定搜索地址",
    selectedTitle: expected.title,
    stableTaskId: `kcoder:local:${expected.threadId}`,
    chromiumCdpPort: chromium.cdpPort,
    taskSummaryDefaultsCollapsed: true,
    explicitSummaryChoicesIsolatedAcrossTasks: true,
    summaryCollapsedOnFreshShell: true,
  };
});

async function assertSummaryExpanded(page, expanded) {
  const button = page.getByTestId("environment-info-button");
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(async () => (await button.getAttribute("aria-expanded")) === String(expanded),
    10_000, `task summary expanded=${expanded}`);
  assert.equal(await page.getByTestId("environment-info-popover").isVisible(), expanded);
}

async function selectTask(page, task) {
  await page.getByTestId(`runtime-local-task-row-kcoder:local:${task.threadId}`).click();
  await page.getByTestId("workbench-pane-task-title").getByText(task.title, { exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function seedSearchThreads(context, gateway) {
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
  await initializeRpc(rpc, "kcoder-e2e-search-seeder");
  const records = [];
  for (const suffix of ["Alpha", "Beta"]) {
    const title = `稳定搜索地址 ${suffix}`;
    const prompt = `稳定搜索地址 内容 ${suffix}`;
    const started = await rpc.request("thread/start", {});
    const turn = await rpc.request("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: prompt }],
    });
    await rpc.waitFor(
      message => message.method === "turn/completed" && message.params?.turnId === turn.turn.id,
      30_000,
      `search seed ${suffix}`,
    );
    await rpc.request("thread/metadata/update", { threadId: started.thread.id, title });
    records.push({ threadId: started.thread.id, title, prompt });
  }
  rpc.close();
  await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 5_000, "search seed RPC close");
  return records;
}
