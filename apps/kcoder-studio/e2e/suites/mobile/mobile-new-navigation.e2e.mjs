import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import {
  appRoot,
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

// Real navigation and real task acceptance; only its genuine receipt is held.
// The scenario supplies deterministic lifecycle frames, not model behavior.
await runE2E(
  import.meta.url,
  {
    testId: "mobile-new-task-back-before-acceptance",
    tier: "full-integration",
    modelPolicy:
      "model-independent real MobileWeb/Gateway/app-server; no paid model calls",
    retainSuccessEvidence: true,
    evidenceReason:
      "Creation completion must preserve the route chosen by the user",
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal");
    const gateway = await startGateway(context, {
      workspace,
      kcoderBin:
        process.env.KCODER_E2E_KCODER_BIN ||
        resolve(repoRoot, "target/debug/kcoder"),
      env: {
        KCODER_STUDIO_SCENARIO: "full-turn",
        KCODER_STUDIO_WEB_ROOT: resolve(appRoot, "mobile/dist"),
      },
    });
    const browser = await startChromium(context);
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    let held,
      threadId,
      acceptedTurns = 0;
    await page.routeWebSocket("**/rpc*", (socket) => {
      const upstream = socket.connectToServer(),
        methods = new Map();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.id !== undefined) methods.set(message.id, message.method);
        upstream.send(raw);
      });
      upstream.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (
          methods.get(message.id) === "thread/start" &&
          message.result?.thread &&
          !held
        ) {
          threadId = message.result.thread.id;
          held = () => socket.send(raw);
          return;
        }
        if (methods.get(message.id) === "turn/start" && message.result)
          acceptedTurns++;
        socket.send(raw);
      });
    });
    try {
      await page.goto(gateway.baseUrl);
      await page.getByTestId("welcome-direct-connection").click();
      await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
      await page.getByTestId("gateway-connect").click();
      await page.getByTestId("new-workspace").waitFor({ timeout: 30000 });
      await page.getByTestId("new-workspace").click();
      await page.getByTestId("server-option-local").click();
      await page
        .getByTestId("new-workspace-prompt")
        .fill("CREATION_ROUTE_OWNER");
      await page.getByTestId("create-workspace").click();
      await waitFor(
        () => held,
        10000,
        "genuine thread creation acceptance held",
      );
      await page.getByLabel("返回", { exact: true }).click();
      await page.getByTestId("new-workspace").waitFor();
      const chosenRoute = new URL(page.url()).pathname;
      held();
      await waitFor(
        () => acceptedTurns === 1,
        10000,
        "authorized task starts once",
      );
      await waitFor(
        () =>
          page.evaluate(
            (id) =>
              Object.keys(localStorage).some((key) =>
                key.includes(encodeURIComponent(id)),
              ),
            threadId,
          ),
        10000,
        "created task preferences stored",
      );
      // Reserve a stable window for React Navigation to finish any queued transition.
      await page.waitForTimeout(400);
      assert.equal(
        new URL(page.url()).pathname,
        chosenRoute,
        "late creation must not replace the route chosen after leaving New task",
      );
      assert.equal(await page.getByTestId("task-header").count(), 0);
      await page.screenshot({
        path: context.pathInArtifacts("creation-keeps-home-route.png"),
      });
      return {
        acceptedTurns,
        taskCreated: true,
        preservedChosenRoute: true,
        paidProviderRequests: 0,
      };
    } catch (error) {
      await page
        .screenshot({ path: context.pathInArtifacts("failure.png") })
        .catch(() => {});
      throw error;
    } finally {
      await page.close();
    }
  },
);
