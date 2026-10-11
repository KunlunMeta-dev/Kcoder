import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(
  import.meta.url,
  {
    testId: "workspace-shell-permission-deny-retry-refresh",
    tier: "browser-real-app-server",
    modelPolicy:
      "model-independent deterministic provider; two real approval turns and one workspace write",
    retainSuccessLogs: true,
  },
  async (context) => {
    const stamp = Date.now();
    const projectName = `permission-recovery-${stamp}`;
    const fileName = `permission-recovery-${stamp}.txt`;
    const fileText = `PERMISSION_RECOVERY_CONTENT_${stamp}`;
    const deniedMarker = `PERMISSION_RECOVERY_DENIED_${stamp}`;
    const finalMarker = `PERMISSION_RECOVERY_OK_${stamp}`;
    const firstPrompt = `Use the shell tool to run exactly: printf '${fileText}' > '${fileName}'. Do not use file editing tools. Only report success after the shell tool succeeds.`;
    const retryPrompt = `Retry the same shell command now. If it succeeds, reply with ${finalMarker}.`;
    const evidence = {
      stage: "setup",
      projectName,
      fileName,
      fileText,
      deniedMarker,
      finalMarker,
      firstPrompt,
      retryPrompt,
      steps: [],
      cleanup: [],
      diagnostics: {
        errors: [],
        failedResponses: [],
        sockets: 0,
        sent: 0,
        received: 0,
      },
    };
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "permission-recovery",
    });
    const outputPath = resolve(workspace, fileName);
    const configDir = context.pathInState("config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "permission-recovery-e2e": {
        type: "api",
        key: "deterministic-local-fixture",
      },
    });
    const model = await startApprovalModelFixture(context, {
      approvalPerTurn: true,
      approvalCommand: `printf '${fileText}' > '${fileName}'`,
      approvalDeniedText: deniedMarker,
      approvalFinalText: finalMarker,
    });
    const settingsFile = await context.writeStateJson(
      "permission-settings.json",
      {
        active_provider: "permission-recovery-e2e",
        permission_mode: "ask",
        providers: {
          "permission-recovery-e2e": {
            api_format: "openai_chat_completions",
            endpoint: model.baseUrl,
            default_model: "permission-recovery-e2e-model",
            context_window_tokens: 128_000,
            output_headroom_tokens: 8_192,
            max_output_tokens: 8_192,
            request_timeout_secs: 30,
            no_proxy: true,
            extra_body: {},
          },
        },
      },
    );
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Permission Recovery E2E",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "permission-recovery-gateway",
      workspace,
      serversFile,
      auth: true,
      env: { KCODER_CONFIG_DIR: configDir },
    });
    const chromium = await startChromium(context, {
      label: "permission-recovery",
    });
    const page = await chromium.newPage({
      viewport: { width: 1440, height: 960 },
    });
    observe(page, evidence, context.runRoot);
    let projectId = "";
    let taskId = "";
    let failure;

    try {
      await login(page, gateway);
      projectId = await createProject(page, workspace, projectName);
      evidence.projectId = projectId;
      const project = byProject(page, projectName);
      await project.hover();
      await project.getByTestId("project-new-conversation-button").click();
      await send(page, firstPrompt);
      await page.waitForFunction(
        () =>
          new URL(location.href).searchParams
            .get("taskId")
            ?.startsWith("kcoder:local:"),
        undefined,
        { timeout: 120_000 },
      );
      taskId = new URL(page.url()).searchParams.get("taskId") || "";
      evidence.taskId = taskId;

      const firstPermission = permissionCard(page);
      await firstPermission.waitFor({ state: "visible", timeout: 120_000 });
      assert.ok((await firstPermission.textContent())?.includes(fileName));
      await shot(page, context, "01-permission-request.png");
      await firstPermission
        .locator('[data-testid^="request-user-input-option-"]')
        .filter({ hasText: "Decline" })
        .click();
      await firstPermission.waitFor({ state: "detached", timeout: 120_000 });
      await waitTurnComplete(page);
      await waitForModelRequests(model, 2);
      await waitForSemanticTurn(page, deniedMarker, {
        users: 1,
        processingToggles: 1,
      });
      assert.equal(
        await exists(outputPath),
        false,
        "denied shell command wrote the file",
      );
      const denied = await messageState(page, deniedMarker);
      assert.deepEqual(
        {
          users: denied.users,
          cards: denied.cards,
          processingToggles: denied.processingExpanded.length,
          finalMessages: denied.finalMessages,
        },
        { users: 1, cards: 0, processingToggles: 1, finalMessages: 1 },
      );
      assert.equal(denied.finalText, deniedMarker);
      assert.equal(
        model.requests.length,
        2,
        "denied turn should make exactly one tool-call request and one tool-result request",
      );
      evidence.denied = denied;
      evidence.steps.push({ label: "denied-no-file" });
      await shot(page, context, "02-denied-no-file.png");
      console.log(JSON.stringify({ boundary: "denied-no-file", taskId }));

      await send(page, retryPrompt);
      const retryPermission = permissionCard(page);
      await retryPermission.waitFor({ state: "visible", timeout: 120_000 });
      assert.ok((await retryPermission.textContent())?.includes(fileName));
      await retryPermission
        .locator('[data-testid^="request-user-input-option-"]')
        .filter({ hasText: "Allow once" })
        .click();
      await retryPermission.waitFor({ state: "detached", timeout: 120_000 });
      await waitTurnComplete(page);
      await waitForModelRequests(model, 4);
      await waitForSemanticTurn(page, finalMarker, {
        users: 2,
        processingToggles: 2,
      });
      assert.equal(await readFile(outputPath, "utf8"), fileText);
      const allowed = await messageState(page, finalMarker);
      assert.deepEqual(
        {
          users: allowed.users,
          cards: allowed.cards,
          processingToggles: allowed.processingExpanded.length,
          finalMessages: allowed.finalMessages,
        },
        { users: 2, cards: 0, processingToggles: 2, finalMessages: 1 },
      );
      assert.equal(allowed.finalText, finalMarker);
      assert.equal(
        model.requests.length,
        4,
        "two permission turns should make exactly four provider requests",
      );
      evidence.allowed = allowed;
      evidence.steps.push({ label: "retry-allowed-file-written" });
      await shot(page, context, "03-retry-allowed.png");
      console.log(JSON.stringify({ boundary: "retry-allowed", taskId }));

      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByTestId("message-user")
        .filter({ hasText: retryPrompt })
        .waitFor({ state: "visible", timeout: 120_000 });
      const toggles = page.getByTestId("final-processing-toggle");
      await toggles.first().waitFor({ state: "visible", timeout: 120_000 });
      assert.equal(await toggles.count(), 2);
      for (let index = 0; index < 2; index += 1) {
        const toggle = toggles.nth(index);
        if ((await toggle.getAttribute("aria-expanded")) !== "true")
          await toggle.click();
      }
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            '[data-testid="request-user-input-summary"]',
          ).length >= 2,
        undefined,
        { timeout: 120_000 },
      );
      const summaries = await page
        .getByTestId("request-user-input-summary")
        .allInnerTexts();
      assert.ok(
        summaries.some((text) => text.includes("Decline")),
        `denied decision missing: ${JSON.stringify(summaries)}`,
      );
      assert.ok(
        summaries.some((text) => text.includes("Allow once")),
        `allowed decision missing: ${JSON.stringify(summaries)}`,
      );
      await waitForSemanticTurn(page, deniedMarker, {
        users: 2,
        processingToggles: 2,
      });
      await waitForSemanticTurn(page, finalMarker, {
        users: 2,
        processingToggles: 2,
      });
      const restored = await messageState(page, finalMarker);
      assert.deepEqual(
        {
          users: restored.users,
          cards: restored.cards,
          processingToggles: restored.processingExpanded.length,
          finalMessages: restored.finalMessages,
        },
        { users: 2, cards: 0, processingToggles: 2, finalMessages: 1 },
      );
      // Expanding historical processing naturally adds approval-summary text to the
      // assistant container. Verify that the final answer remains unique and retains its
      // marker instead of comparing the entire container between collapsed and expanded states.
      assert.ok(restored.finalText.includes(finalMarker));
      assert.equal(await readFile(outputPath, "utf8"), fileText);
      evidence.restored = { ...restored, summaries };
      evidence.steps.push({ label: "refresh-history-decisions-stable" });
      evidence.stage = "passed";
      await shot(page, context, "04-refresh-decisions.png");
      console.log(JSON.stringify({ boundary: "passed", taskId }));
    } catch (error) {
      failure = error;
      evidence.failure =
        error instanceof Error ? error.stack || error.message : String(error);
      evidence.failureState = await messageState(page, finalMarker).catch(
        (error) => ({ error: String(error) }),
      );
      evidence.fileExists = await exists(outputPath);
      await shot(page, context, `failure-${evidence.stage}.png`).catch(
        () => undefined,
      );
    } finally {
      evidence.providerRequests = model.requests.length;
      await cleanup(
        page,
        gateway.baseUrl,
        projectName,
        projectId,
        taskId,
        evidence,
      );
      await context.writeArtifactJson(
        "workspace-permission-recovery.json",
        evidence,
      );
    }
    if (failure) throw failure;
    return {
      taskId,
      denied: evidence.denied,
      allowed: evidence.allowed,
      restored: evidence.restored,
      diagnostics: evidence.diagnostics,
      cleanup: evidence.cleanup,
    };
  },
);

function observe(page, evidence, runRoot) {
  const record = (type, text) => {
    if (
      (text.includes(runRoot) || evidence.diagnostics.errors.length < 5) &&
      evidence.diagnostics.errors.length < 20
    )
      evidence.diagnostics.errors.push({ type, text: text.slice(0, 1000) });
  };
  page.on("pageerror", (error) => record("pageerror", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") record("console", message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      evidence.diagnostics.failedResponses.push({
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
  });
  page.on("websocket", (socket) => {
    evidence.diagnostics.sockets += 1;
    socket.on("framesent", () => {
      evidence.diagnostics.sent += 1;
    });
    socket.on("framereceived", () => {
      evidence.diagnostics.received += 1;
    });
  });
}

function permissionCard(page) {
  return page
    .getByTestId("request-user-input-card")
    .filter({ hasText: "Permission request" });
}
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function waitTurnComplete(page) {
  await page
    .getByTestId("final-processing-toggle")
    .last()
    .waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        '[data-testid="thinking-indicator"],[data-testid="pause-response-button"]',
      ).length === 0,
    undefined,
    { timeout: 120_000 },
  );
}

async function waitForModelRequests(model, expected) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (model.requests.length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(
    model.requests.length,
    expected,
    `provider request count did not reach ${expected}`,
  );
}

async function waitForSemanticTurn(page, marker, expected) {
  await page.waitForFunction(
    ({ marker, users, processingToggles }) => {
      const assistantContents = [
        ...document.querySelectorAll(
          '[data-testid="assistant-message-content"]',
        ),
      ].filter((node) => node.textContent?.includes(marker));
      return (
        document.querySelectorAll('[data-testid="message-user"]').length ===
          users &&
        document.querySelectorAll('[data-testid="request-user-input-card"]')
          .length === 0 &&
        document.querySelectorAll('[data-testid="final-processing-toggle"]')
          .length === processingToggles &&
        assistantContents.length === 1 &&
        assistantContents[0]?.textContent?.trim() === marker
      );
    },
    { marker, ...expected },
    { timeout: 120_000 },
  );
}

async function messageState(page, marker = "") {
  const final = marker
    ? page.getByTestId("message-assistant").filter({ hasText: marker })
    : null;
  const finalContent = final?.getByTestId("assistant-message-content");
  return {
    users: await page.getByTestId("message-user").count(),
    assistants: await page.getByTestId("message-assistant").count(),
    cards: await page.getByTestId("request-user-input-card").count(),
    processingExpanded: await page
      .getByTestId("final-processing-toggle")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-expanded")),
      ),
    interactionSummaries: await page
      .getByTestId("request-user-input-summary")
      .allInnerTexts(),
    ...(final
      ? {
          finalMessages: await final.count(),
          finalText:
            (await finalContent
              .last()
              .textContent()
              .catch(() => "")) || "",
        }
      : {}),
  };
}

function byProject(page, name) {
  return page.getByTestId("project-item").filter({ hasText: name }).first();
}
async function login(page, gateway) {
  const response = await page.goto(gateway.baseUrl, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response?.status(), 200);
  const input = page.locator('input[name="token"]');
  if (await input.count()) {
    await input.fill(gateway.authToken);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/login"), {
        timeout: 30_000,
      }),
      page.locator('button[type="submit"]').click(),
    ]);
  }
  await page
    .getByTestId("desktop-sidebar")
    .waitFor({ state: "visible", timeout: 120_000 });
}

async function createProject(page, workspace, name) {
  await page.getByTestId("projects-create-button").click();
  await page.getByTestId("project-create-local-option").click();
  const picker = page.getByTestId("standalone-folder-project-dialog");
  await picker.waitFor({ state: "visible", timeout: 120_000 });
  const input = picker.getByTestId("device-folder-path-input");
  await input.fill(workspace);
  await input.press("Enter");
  await page.waitForTimeout(300);
  await picker.getByTestId("confirm-device-folder-picker-button").click();
  const dialog = page.getByTestId("local-project-create-dialog");
  await dialog.waitFor({ state: "visible", timeout: 120_000 });
  await dialog.getByTestId("local-project-create-name-input").fill(name);
  await dialog.getByTestId("confirm-local-project-create-button").click();
  await dialog.waitFor({ state: "detached", timeout: 120_000 });
  const project = byProject(page, name);
  await project.waitFor({ state: "visible", timeout: 120_000 });
  const testId = await project
    .locator('[data-testid^="project-row-"]')
    .first()
    .getAttribute("data-testid");
  const id = testId?.replace("project-row-", "") || "";
  assert.match(id, /^\d+$/);
  return id;
}

async function send(page, prompt) {
  const input = page.getByTestId("chat-message-input");
  await input.waitFor({ state: "visible", timeout: 120_000 });
  await input.click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="chat-message-input"]')
        ?.getAttribute("contenteditable") === "true",
    undefined,
    { timeout: 120_000 },
  );
  await page.keyboard.insertText(prompt);
  await page.waitForFunction(
    () => {
      const button = document.querySelector(
        '[data-testid="send-message-button"]',
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 120_000 },
  );
  await page.getByTestId("send-message-button").click();
}

async function cleanup(
  page,
  baseUrl,
  projectName,
  projectId,
  taskId,
  evidence,
) {
  if (taskId) {
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const project = byProject(page, projectName);
      await project.waitFor({ state: "visible", timeout: 30_000 });
      const button = project.getByTestId("project-item-button");
      if ((await button.getAttribute("aria-expanded")) !== "true")
        await button.click();
      const row = page.locator(
        `[data-testid="runtime-local-task-row-${escapeCss(taskId)}"]:visible`,
      );
      await row.waitFor({ state: "visible", timeout: 30_000 });
      await row.hover();
      await page.getByTestId(`runtime-local-task-archive-${taskId}`).click();
      const toast = page.getByTestId(
        `runtime-local-task-archive-toast-${taskId}`,
      );
      await toast.waitFor({ state: "visible", timeout: 10_000 });
      await toast.waitFor({ state: "detached", timeout: 15_000 });
      await page.waitForTimeout(1000);
      evidence.cleanup.push({
        kind: "task",
        id: taskId,
        remaining: await row.count(),
      });
    } catch (error) {
      evidence.cleanup.push({ kind: "task", id: taskId, error: String(error) });
    }
  }
  if (projectId) {
    try {
      const project = byProject(page, projectName);
      await project.waitFor({ state: "visible", timeout: 30_000 });
      await project.hover();
      await page.getByTestId(`project-menu-${projectId}`).click();
      await page.getByTestId(`remove-project-${projectId}`).click();
      await page
        .getByTestId(`remove-project-dialog-${projectId}-confirm-button`)
        .click();
      const row = page.locator(
        `[data-testid="project-row-${projectId}"]:visible`,
      );
      await row.waitFor({ state: "detached", timeout: 30_000 });
      evidence.cleanup.push({
        kind: "project",
        id: projectId,
        remaining: await row.count(),
      });
    } catch (error) {
      evidence.cleanup.push({
        kind: "project",
        id: projectId,
        error: String(error),
      });
    }
  }
}

function escapeCss(value) {
  return value.replace(/["\\]/g, "\\$&");
}
async function shot(page, context, name) {
  const path = context.pathInCase(
    "system-chromium",
    "permission-recovery",
    name,
  );
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
