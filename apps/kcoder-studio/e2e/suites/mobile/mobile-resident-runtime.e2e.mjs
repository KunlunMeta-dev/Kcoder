import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, runE2E } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(
  import.meta.url,
  {
    testId: "mobile-web-resident-runtime",
    tier: "full-integration",
    modelPolicy: "model-independent deterministic real app-server",
    retainSuccessLogs: true,
  },
  async (context) => {
    const gateway = await startGateway(context, {
      auth: true,
      label: "mobile-resident-gateway",
      workspace: appRoot,
      env: {
        KCODER_STUDIO_SCENARIO: "full-turn",
        KCODER_STUDIO_WEB_ROOT: mobileDist,
      },
    });
    const chromium = await startChromium(context, {
      label: "mobile-resident-chromium",
    });
    const browserContext = chromium.browser.contexts()[0];
    const first = await browserContext.newPage();
    await first.setViewportSize({ width: 390, height: 844 });
    const browserErrors = [];
    const observeErrors = (page) => {
      page.on("pageerror", (error) =>
        browserErrors.push(`pageerror: ${error.message}`),
      );
      page.on("console", (message) => {
        if (message.type() === "error")
          browserErrors.push(`console: ${message.text()}`);
      });
    };
    observeErrors(first);

    await connect(first, gateway);
    const homeUrl = first.url();
    const firstTaskUrl = await createTask(first, "MOBILE_RESIDENT_FIRST");

    // A second page in the same browser profile reuses the gateway mobile session while retaining an independent TaskRuntime.
    const second = await browserContext.newPage();
    await second.setViewportSize({ width: 390, height: 844 });
    observeErrors(second);
    await second.goto(homeUrl, { waitUntil: "domcontentloaded" });
    await second
      .getByTestId("new-workspace")
      .waitFor({ state: "visible", timeout: 30_000 });
    const secondTaskUrl = await createTask(second, "MOBILE_RESIDENT_SECOND");
    assert.notEqual(
      firstTaskUrl,
      secondTaskUrl,
      "两个移动 TaskRuntime 必须拥有不同 thread URL",
    );
    const directChildren = await liveDirectChildren(gateway.child.pid);
    assert.equal(
      directChildren.length,
      1,
      `同一工作区的两个移动 TaskRuntime 应只保有一个 app-server 子进程，实际为 ${directChildren.length}`,
    );
    await context.writeArtifactJson("resident-process-count.json", {
      gatewayPid: gateway.child.pid,
      liveDirectChildCount: directChildren.length,
    });

    await sendAndComplete(first, "MOBILE_RESIDENT_FIRST_AGAIN");
    await sendAndComplete(second, "MOBILE_RESIDENT_SECOND_AGAIN");

    // Re-entering the same task after closing its owner must recover authoritatively from the resident/persisted thread rather than creating a new thread.
    await first.close();
    const restored = await browserContext.newPage();
    await restored.setViewportSize({ width: 390, height: 844 });
    observeErrors(restored);
    await restored.goto(firstTaskUrl, { waitUntil: "domcontentloaded" });
    await restored
      .getByTestId("message-user")
      .filter({ hasText: "MOBILE_RESIDENT_FIRST_AGAIN" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await restored
      .getByTestId("send-message")
      .waitFor({ state: "visible", timeout: 30_000 });
    await capture(restored, context, "resident-restored.png");

    assert.deepEqual(browserErrors, []);
    return {
      realAppServer: true,
      simultaneousTaskRuntimes: true,
      oneWorkspaceAppServerProcess: directChildren.length === 1,
      distinctThreadUrls: true,
      bothThreadsCompletedTwoTurns: true,
      ownerDisconnectRestored: true,
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
    .getByTestId("message-assistant")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("send-message")
    .waitFor({ state: "visible", timeout: 30_000 });
  return page.url();
}

async function sendAndComplete(page, prompt) {
  await page.getByTestId("message-input").fill(prompt);
  await page.getByTestId("send-message").click();
  await page
    .getByTestId("message-user")
    .filter({ hasText: prompt })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("send-message")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function capture(page, context, filename) {
  const path = context.pathInCase(
    "system-chromium",
    "mobile-resident",
    filename,
  );
  await mkdir(resolve(path, ".."), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

async function liveDirectChildren(parentPid) {
  const path = `/proc/${parentPid}/task/${parentPid}/children`;
  const raw = await readFile(path, "utf8");
  const children = raw.trim().split(/\s+/).filter(Boolean).map(Number);
  const live = [];
  for (const pid of children) {
    if (
      await access(`/proc/${pid}`).then(
        () => true,
        () => false,
      )
    )
      live.push(pid);
  }
  return live;
}
