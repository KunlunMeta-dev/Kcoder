import assert from "node:assert/strict";
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
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

// Deterministic model frames exercise acceptance and recovery, not model quality.
await runE2E(
  import.meta.url,
  {
    testId: "mobile-ordinary-send-readonly-receipt",
    tier: "full-integration",
    modelPolicy:
      "model-independent real Mobile UI and Gateway; corrupted acceptance response and withheld first receipt",
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal");
    let finishQueueBlocker = false;
    const model = await startApprovalModelFixture(context, {
      textOnly: true,
      responseSteps: ({ body }) => {
        const last = body.messages
          .filter((message) => message.role === "user")
          .at(-1)?.content;
        const text =
          typeof last === "string"
            ? last
            : (last ?? []).map((part) => part.text ?? "").join("");
        if (text === "QUEUE_BLOCKER")
          return [
            { delta: { role: "assistant", content: "QUEUE_BLOCKER_RUNNING" } },
            {
              ready: () => finishQueueBlocker,
              delta: {},
              finishReason: "stop",
            },
          ];
        return [
          {
            delta: {
              role: "assistant",
              content: `deterministic renderer response: ${text}`,
            },
            finishReason: "stop",
          },
        ];
      },
    });
    await context.writeStateJson("profile/settings.json", {
      active_provider: "fixture",
      permission_mode: "yolo",
      max_retries: 0,
      providers: {
        fixture: {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          authentication: { mode: "none" },
          default_model: "fixture",
          no_proxy: true,
          context_window_tokens: 1000000,
          max_output_tokens: 1024,
          output_headroom_tokens: 1024,
        },
      },
    });
    const gateway = await startGateway(context, {
      workspace,
      kcoderBin:
        process.env.KCODER_E2E_KCODER_BIN ||
        resolve(repoRoot, "target/debug/kcoder"),
      env: {
        KCODER_CONFIG_DIR: context.pathInState("profile"),
        KCODER_STUDIO_WEB_ROOT: resolve(appRoot, "mobile/dist"),
      },
    });
    const token = await waitForGatewayRpcToken(context, gateway);
    const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
    context.addCleanup("close receipt seed", () => rpc.close());
    await initializeRpc(rpc, "mobile-receipt-seed");
    const { thread } = await rpc.request("thread/start");
    const { turn } = await rpc.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "SEED" }],
    });
    await rpc.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === turn.id,
      30000,
      "seed completion",
    );
    await rpc.request("thread/metadata/update", {
      threadId: thread.id,
      title: "Mobile receipt fixture",
    });
    rpc.close();
    const browser = await startChromium(context);
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      locale: "en-US",
    });
    let starts = 0,
      receipts = 0,
      deletes = 0,
      retains = 0;
    let sendMode = "corrupt",
      heldSend = null,
      heldRetain = null;
    const deletedAttachmentPaths = [];
    await page.routeWebSocket("**/rpc*", (socket) => {
      const upstream = socket.connectToServer();
      const methods = new Map();
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.id !== undefined && message.method)
          methods.set(message.id, message.method);
        if (message.method === "turn/start") {
          starts++;
          assert.ok(message.params.clientMessageId);
        }
        if (message.method === "thread/delete") deletes++;
        if (message.method === "gateway/attachments/retain") retains++;
        if (message.method === "attachment/delete")
          deletedAttachmentPaths.push(message.params.path);
        upstream.send(raw);
      });
      upstream.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        const method = methods.get(message.id);
        if (method === "turn/start" && message.result) {
          if (sendMode === "hold-send") {
            heldSend = () => socket.send(raw);
            return;
          }
          if (sendMode === "corrupt") {
            socket.send(JSON.stringify({ ...message, result: {} }));
            return;
          }
        }
        if (
          method === "gateway/attachments/retain" &&
          message.result &&
          sendMode === "hold-retain"
        ) {
          heldRetain = () => socket.send(raw);
          return;
        }
        if (method === "turn/receipt/read" && message.result) {
          receipts++;
          if (receipts === 1) {
            socket.send(
              JSON.stringify({ ...message, result: { receipt: null } }),
            );
            return;
          }
        }
        socket.send(raw);
      });
    });
    try {
      await page.goto(gateway.baseUrl);
      await page.getByTestId("welcome-direct-connection").click();
      await page.getByTestId("gateway-endpoint").fill(gateway.baseUrl);
      await page.getByTestId("gateway-connect").click();
      await page.getByTestId("new-workspace").waitFor({ timeout: 30000 });
      await page.getByTestId("sessions").click();
      await page.getByTestId("session-search").fill("Mobile receipt fixture");
      await page.getByTestId(`session-${thread.id}`).click();
      await page.getByTestId("message-input").fill("MOBILE_SEND_ONCE");
      await page.getByTestId("send-message").click();
      await page
        .getByTestId("runtime-reconcile-send")
        .waitFor({ timeout: 30000 });
      await page
        .getByText("deterministic renderer response: MOBILE_SEND_ONCE", {
          exact: true,
        })
        .waitFor({ timeout: 30000 });
      assert.equal(starts, 1);
      assert.equal(receipts, 1);
      await page.screenshot({
        path: context.pathInArtifacts("mobile-send-unknown.png"),
      });
      await page.getByTestId("runtime-reconcile-send").click();
      await page
        .getByTestId("runtime-reconcile-send")
        .waitFor({ state: "hidden" });
      assert.equal(starts, 1);
      assert.equal(receipts, 2);
      assert.equal(deletes, 0);
      assert.equal(model.requests.length, 2);
      assert.equal(
        await page
          .getByTestId("message-user")
          .filter({ hasText: "MOBILE_SEND_ONCE" })
          .count(),
        1,
      );
      await page.reload();
      await page
        .getByText("deterministic renderer response: MOBILE_SEND_ONCE", {
          exact: true,
        })
        .waitFor({ timeout: 30000 });
      assert.equal(
        await page
          .getByTestId("message-user")
          .filter({ hasText: "MOBILE_SEND_ONCE" })
          .count(),
        1,
      );
      // Hold genuine acceptance while a new draft and attachment are prepared.
      sendMode = "hold-send";
      await stageFile(page, "ordinary-first.txt");
      await page.getByTestId("message-input").fill("ORDINARY_FIRST");
      await page.getByTestId("send-message").click();
      await waitFor(() => heldSend, 5000, "ordinary real acceptance held");
      await page.getByTestId("message-input").fill("LATER_ORDINARY_DRAFT");
      await stageFile(page, "ordinary-later.txt");
      await waitFor(
        () => draftStored(page, "LATER_ORDINARY_DRAFT"),
        5000,
        "later ordinary draft persisted",
      );
      heldSend();
      sendMode = "normal";
      await page.getByTestId("staged-attachment-ordinary-later.txt").waitFor();
      assert.equal(
        await page.getByTestId("message-input").inputValue(),
        "LATER_ORDINARY_DRAFT",
      );
      assert.equal(await draftStored(page, "LATER_ORDINARY_DRAFT"), true);
      await page.screenshot({
        path: context.pathInArtifacts(
          "ordinary-later-draft-and-attachment.png",
        ),
      });
      await page.reload();
      await page.getByTestId("message-input").waitFor({ timeout: 30000 });
      assert.equal(
        await page.getByTestId("message-input").inputValue(),
        "LATER_ORDINARY_DRAFT",
      );
      // The local Provider keeps a real turn active until queue assertions finish.
      await page.getByTestId("message-input").fill("QUEUE_BLOCKER");
      await page.getByTestId("send-message").click();
      await page
        .getByText("QUEUE_BLOCKER_RUNNING", { exact: true })
        .waitFor({ timeout: 30000 });
      await stageFile(page, "queue-first.txt");
      await page.getByTestId("message-input").fill("QUEUED_FIRST");
      sendMode = "hold-retain";
      const retainedBefore = retains;
      await page.getByTestId("queue-message").evaluate((button) => {
        button.click();
        button.click();
      });
      await waitFor(() => heldRetain, 5000, "real retain receipt held");
      assert.equal(retains, retainedBefore + 1);
      assert.equal(await page.getByTestId("queue-message").isDisabled(), true);
      await page.getByTestId("message-input").fill("LATER_QUEUE_DRAFT");
      await stageFile(page, "queue-later.txt");
      // The submitted owner is detached; new attachments remain independently removable.
      assert.equal(
        await page.getByTestId("staged-attachment-queue-first.txt").count(),
        0,
      );
      await stageFile(page, "queue-removed-later.txt");
      const deleteCount = deletedAttachmentPaths.length;
      await page
        .getByLabel("Remove queue-removed-later.txt", { exact: true })
        .click();
      await waitFor(
        () => deletedAttachmentPaths.length === deleteCount + 1,
        5000,
        "only the newly removed attachment is deleted",
      );
      heldRetain();
      sendMode = "normal";
      await page.getByTestId("queued-message-0").waitFor();
      assert.equal(await page.getByTestId("queued-message-1").count(), 0);
      assert.equal(
        await page.getByTestId("message-input").inputValue(),
        "LATER_QUEUE_DRAFT",
      );
      await page.getByTestId("staged-attachment-queue-later.txt").waitFor();
      await waitFor(
        () => draftStored(page, "LATER_QUEUE_DRAFT"),
        5000,
        "later queued draft persisted",
      );
      assert.equal(retains, retainedBefore + 1);
      await page.screenshot({
        path: context.pathInArtifacts("queue-later-draft-and-attachment.png"),
      });
      await page.getByLabel("Remove queued message 1", { exact: true }).click();
      await page.getByTestId("queued-message-0").waitFor({ state: "hidden" });
      finishQueueBlocker = true;
      await page.getByTestId("send-message").waitFor({ timeout: 30000 });
      assert.equal(starts, 3);
      assert.equal(model.requests.length, 4);
      await page.reload();
      await page.getByTestId("message-input").waitFor({ timeout: 30000 });
      assert.equal(
        await page.getByTestId("message-input").inputValue(),
        "LATER_QUEUE_DRAFT",
      );
      await page.getByLabel("Open task list", { exact: true }).click();
      await page.getByTestId("mobile-drawer").waitFor();
      await page.getByText("New task", { exact: true }).waitFor();
      await page.getByTestId(`drawer-thread-actions-${thread.id}`).click();
      await page.getByLabel("Save task title", { exact: true }).waitFor();
      await page.getByLabel("Close task actions", { exact: true }).click();
      await page.getByTestId("mobile-drawer").waitFor();
      await page.getByLabel("Close navigation", { exact: true }).last().click();
      return {
        starts,
        receipts,
        deletes,
        retains,
        providerRequests: model.requests.length,
        authoritativeReload: true,
        ordinaryNewDraftAndAttachment: true,
        queuedNewDraftAndAttachment: true,
        duplicateQueueBlocked: true,
        submittedAttachmentDetach: true,
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

async function stageFile(page, name) {
  await page.getByTestId("composer-attachment").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByText("Choose file", { exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("owned attachment fixture"),
  });
  await page
    .getByTestId(`staged-attachment-${name}`)
    .waitFor({ timeout: 30000 });
}
async function draftStored(page, draft) {
  return page.evaluate(
    (value) =>
      Object.keys(localStorage).some((key) => {
        if (!key.includes("mobile-workspace")) return false;
        try {
          return JSON.parse(localStorage.getItem(key))?.composerDraft === value;
        } catch {
          return false;
        }
      }),
    draft,
  );
}
