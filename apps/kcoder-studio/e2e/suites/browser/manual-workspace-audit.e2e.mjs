import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(
  import.meta.url,
  {
    testId: "workspace-request-user-input-expanded-refresh",
    tier: "browser-real-app-server",
    modelPolicy:
      "model-independent deterministic provider with real request-user-input protocol",
    retainSuccessLogs: true,
  },
  async (context) => {
    const stamp = Date.now();
    const projectName = `ask-expand-${stamp}`;
    const question = `CHOOSE_ALPHA_OR_BETA_${stamp}`;
    const marker = `SELECTED_BETA_${stamp}`;
    const prompt = `Use the available AskUserQuestion tool now. Ask exactly one single-choice question \"${question}\" with exactly two options ALPHA and BETA. After the user actually answers, report the selected option; if the actual answer is BETA, include ${marker} in the final response. Do not call any other tool.`;
    const evidence = {
      stage: "setup",
      prompt,
      question,
      marker,
      steps: [],
      cleanup: [],
      diagnostics: {
        console: { error: 0, warning: 0, samples: [] },
        network: {
          responses: 0,
          failed: [],
          webSockets: 0,
          sent: 0,
          received: 0,
          runtimeEvents: [],
        },
      },
    };
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "ask-expand",
    });
    const configDir = context.pathInState("config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "question-e2e": { type: "api", key: "deterministic-local-fixture" },
    });
    const model = await startApprovalModelFixture(context, {
      question: true,
      questionText: question,
      questionHeader: "选择",
      questionOptions: [
        { label: "ALPHA", description: "选择 ALPHA。" },
        { label: "BETA", description: "选择 BETA。" },
      ],
      questionFinalText: marker,
    });
    const settingsFile = await context.writeStateJson(
      "question-settings.json",
      {
        active_provider: "question-e2e",
        permission_mode: "ask",
        providers: {
          "question-e2e": {
            api_format: "openai_chat_completions",
            endpoint: model.baseUrl,
            default_model: "question-e2e-model",
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
        label: "Local",
        transport: "local",
        command: resolve(repoRoot, "target/debug/kcoder"),
        workspace,
        settingsFile,
      },
    ]);
    const gateway = await startGateway(context, {
      label: "ask-expand-gateway",
      workspace,
      serversFile,
      auth: true,
      env: { KCODER_CONFIG_DIR: configDir },
    });
    const chromium = await startChromium(context, { label: "ask-expand" });
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
      await send(page, prompt);
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

      const permission = page
        .getByTestId("request-user-input-card")
        .filter({ hasText: "Permission request" });
      await permission.waitFor({ state: "visible", timeout: 120_000 });
      await permission
        .locator('[data-testid^="request-user-input-option-"]')
        .filter({ hasText: "Allow once" })
        .click();
      await permission.waitFor({ state: "detached", timeout: 120_000 });
      const card = page
        .getByTestId("request-user-input-card")
        .filter({ hasText: question });
      await card.waitFor({ state: "visible", timeout: 120_000 });
      const options = card.locator(
        '[data-testid^="request-user-input-option-"]',
      );
      const optionTexts = await options.allTextContents();
      assert.equal(optionTexts.length, 2);
      assert.ok(optionTexts[0].includes("ALPHA"));
      assert.ok(optionTexts[1].includes("BETA"));
      evidence.steps.push({ label: "question-visible", optionTexts });
      await shot(page, context, "01-question.png");
      console.log(JSON.stringify({ boundary: "question-visible", taskId }));

      await options.filter({ hasText: "BETA" }).click();
      await card.waitFor({ state: "detached", timeout: 30_000 });
      evidence.steps.push({ label: "beta-submitted" });
      await page.waitForFunction(
        (value) =>
          [
            ...document.querySelectorAll('[data-testid="message-assistant"]'),
          ].some((node) => node.textContent?.includes(value)),
        marker,
        { timeout: 120_000 },
      );
      await page
        .getByTestId("final-processing-toggle")
        .waitFor({ state: "visible", timeout: 120_000 });
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            '[data-testid="thinking-indicator"],[data-testid="pause-response-button"]',
          ).length === 0,
        undefined,
        { timeout: 120_000 },
      );
      const live = await state(page, question, marker);
      assertStableMessages(live, [1, 2]);
      evidence.live = live;
      evidence.steps.push({ label: "final-complete" });
      await shot(page, context, "02-final.png");
      console.log(JSON.stringify({ boundary: "final-complete", taskId }));

      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByTestId("message-user")
        .filter({ hasText: prompt })
        .waitFor({ state: "visible", timeout: 120_000 });
      const toggle = page.getByTestId("final-processing-toggle");
      await toggle.waitFor({ state: "visible", timeout: 120_000 });
      assert.equal(
        await toggle.getAttribute("aria-expanded"),
        "false",
        "processing should restore collapsed",
      );
      const collapsed = await state(page, question, marker);
      assertStableMessages(collapsed, 1);
      assert.equal(
        collapsed.summaries.length,
        0,
        "collapsed processing unexpectedly mounted summaries",
      );
      evidence.steps.push({
        label: "refresh-collapsed",
        toggleText: await toggle.textContent(),
      });
      await shot(page, context, "03-refresh-collapsed.png");

      await toggle.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="final-processing-toggle"]')
            ?.getAttribute("aria-expanded") === "true",
        undefined,
        { timeout: 10_000 },
      );
      await waitSummary(page, question);
      const expanded = await state(page, question, marker);
      assertStableMessages(expanded, 1);
      assert.equal(expanded.matching.length, 1);
      assert.ok(expanded.matching[0].includes("BETA"));
      evidence.expanded = expanded;
      evidence.steps.push({ label: "refresh-expanded-summary" });
      await shot(page, context, "04-refresh-expanded-summary.png");

      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await toggle.click();
      await waitSummary(page, question);
      const reexpanded = await state(page, question, marker);
      assert.deepEqual(messageCounts(reexpanded), messageCounts(expanded));
      assert.equal(reexpanded.finalText, expanded.finalText);
      assert.equal(reexpanded.matching.length, 1);
      evidence.reexpanded = reexpanded;
      evidence.steps.push({ label: "collapse-reexpand-stable" });
      evidence.stage = "passed";
      await shot(page, context, "05-reexpanded-stable.png");
      console.log(JSON.stringify({ boundary: "passed", taskId }));
    } catch (error) {
      failure = error;
      evidence.failure =
        error instanceof Error ? error.stack || error.message : String(error);
      evidence.failureState = await state(page, question, marker).catch(
        (error) => ({ error: String(error) }),
      );
      await shot(page, context, `failure-${evidence.stage}.png`).catch(
        () => undefined,
      );
    } finally {
      await cleanup(page, gateway, projectName, projectId, taskId, evidence);
      await context.writeArtifactJson(
        "workspace-request-user-input-model-requests.json",
        model.requests,
      );
      await context.writeArtifactJson(
        "workspace-request-user-input-expanded.json",
        evidence,
      );
    }
    if (failure) throw failure;
    return {
      taskId,
      expanded: evidence.expanded,
      reexpanded: evidence.reexpanded,
      diagnostics: evidence.diagnostics,
      cleanup: evidence.cleanup,
    };
  },
);

function observe(page, evidence, runRoot) {
  page.on("pageerror", (error) =>
    addConsole(evidence, "error", error.message, runRoot),
  );
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      addConsole(evidence, message.type(), message.text(), runRoot);
  });
  page.on("response", (response) => {
    evidence.diagnostics.network.responses += 1;
    if (response.status() >= 400)
      evidence.diagnostics.network.failed.push({
        status: response.status(),
        path: new URL(response.url()).pathname,
      });
  });
  page.on("websocket", (socket) => {
    evidence.diagnostics.network.webSockets += 1;
    socket.on("framesent", () => {
      evidence.diagnostics.network.sent += 1;
    });
    socket.on("framereceived", (event) => {
      evidence.diagnostics.network.received += 1;
      const text =
        typeof event.payload === "string"
          ? event.payload
          : Buffer.from(event.payload).toString("utf8");
      if (
        /question\/resolved|response\.block\.updated|request_user_input/.test(
          text,
        )
      ) {
        evidence.diagnostics.network.runtimeEvents.push(text.slice(0, 20_000));
      }
    });
  });
}

function addConsole(evidence, type, text, runRoot) {
  evidence.diagnostics.console[type] += 1;
  if (
    (text.includes(runRoot) ||
      evidence.diagnostics.console.samples.length < 5) &&
    evidence.diagnostics.console.samples.length < 20
  ) {
    evidence.diagnostics.console.samples.push({
      type,
      text: text.slice(0, 1000),
    });
  }
}

async function waitSummary(page, question) {
  await page.waitForFunction(
    ({ question, answer }) =>
      [
        ...document.querySelectorAll(
          '[data-testid="request-user-input-summary"]',
        ),
      ].some((node) => {
        const lines = (node.innerText || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        return lines.includes(question) && lines.includes(answer);
      }),
    { question, answer: "BETA" },
    { timeout: 120_000 },
  );
}

async function state(page, question, marker) {
  const summaries = await page
    .getByTestId("request-user-input-summary")
    .allInnerTexts();
  const final = page
    .getByTestId("message-assistant")
    .filter({ hasText: marker });
  return {
    users: await page.getByTestId("message-user").count(),
    assistants: await page.getByTestId("message-assistant").count(),
    cards: await page.getByTestId("request-user-input-card").count(),
    finalMessages: await final.count(),
    finalText:
      (await final
        .first()
        .textContent()
        .catch(() => "")) || "",
    summaries,
    matching: summaries.filter((text) => exactSummary(text, question, "BETA")),
  };
}

function exactSummary(text, question, answer) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.includes(question) && lines.includes(answer);
}

function assertStableMessages(value, expectedAssistants) {
  assert.equal(value.users, 1);
  const acceptedAssistants = Array.isArray(expectedAssistants)
    ? expectedAssistants
    : [expectedAssistants];
  assert.ok(
    acceptedAssistants.includes(value.assistants),
    `assistant message count ${value.assistants} is not one of ${acceptedAssistants.join(", ")}`,
  );
  assert.equal(value.cards, 0);
  assert.equal(value.finalMessages, 1);
}

function messageCounts(value) {
  return {
    users: value.users,
    assistants: value.assistants,
    cards: value.cards,
    finalMessages: value.finalMessages,
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
  gateway,
  projectName,
  projectId,
  taskId,
  evidence,
) {
  if (taskId) {
    try {
      await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
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
  const path = context.pathInCase("system-chromium", "ask-expanded", name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}
