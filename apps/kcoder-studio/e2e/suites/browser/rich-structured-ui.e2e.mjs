import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startChromium } from "../../harness/chromium.mjs";
import { startFixtureSite } from "../../harness/fixture-site.mjs";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();

await runE2E(
  import.meta.url,
  {
    testId: "real-chromium-rich-and-structured-conversation-ui",
    tier: "pr-smoke",
    modelPolicy: "model-independent deterministic DOM rendering check",
    retainSuccessLogs: true,
  },
  async (context) => {
    const chromium = await startChromium(context);
    const page = await chromium.newPage({
      viewport: { width: 1280, height: 800 },
    });
    const browserErrors = [];
    let mermaidFailure = null;
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });

    const { path: richWorkspace } = await materializeWorkspace(
      context,
      "minimal",
      {
        instanceId: "rich-ui",
      },
    );
    const richConfig = context.pathInState("rich-config");
    await mkdir(richConfig, { recursive: true, mode: 0o700 });
    await writeFile(resolve(richConfig, "settings.json"), "{}\n", {
      mode: 0o600,
    });
    const richGateway = await startScenarioGateway(context, {
      label: "rich-ui-gateway",
      workspace: richWorkspace,
      configDir: richConfig,
      scenario: "thinking-preview",
    });
    const imageSite = await startFixtureSite(context);
    const privateApplicationSentinel =
      "PRIVATE_APPLICATION_CONTEXT_E2E_SENTINEL";
    const privateClientSentinel = "PRIVATE_CLIENT_CONTEXT_E2E_SENTINEL";
    const richPrompt = [
      "中文标点测试：你好，世界！",
      "$$x^2$$",
      "```mermaid",
      "graph LR",
      "A-->B",
      "```",
      `![图](${imageSite.url}image.svg)`,
      "",
      "<application_context>",
      privateApplicationSentinel,
      "</application_context>",
      "",
      '<kcoder_client_context personality="friendly">',
      privateClientSentinel,
      "</kcoder_client_context>",
    ].join("\n");
    const richToken = await waitForGatewayRpcToken(context, richGateway);
    const seedRpc = await openRpc(
      gatewayRpcUrl(richGateway, "local", richToken),
    );
    await initializeRpc(seedRpc, "kcoder-e2e-rich-ui-seeder");
    const richThread = await seedRpc.request("thread/start", {});
    const richTurn = await seedRpc.request("turn/start", {
      threadId: richThread.thread.id,
      input: [{ type: "text", text: richPrompt }],
    });
    await seedRpc.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === richTurn.turn.id,
      30_000,
      "rich deterministic turn",
    );
    await seedRpc.request("thread/metadata/update", {
      threadId: richThread.thread.id,
      title: "Rich DOM E2E",
    });
    seedRpc.close();
    await waitFor(
      () => seedRpc.socket.readyState === seedRpc.socket.constructor.CLOSED,
      5_000,
      "rich seed RPC close",
    );
    await page.goto(`${richGateway.baseUrl}/?e2e=1`, {
      waitUntil: "domcontentloaded",
    });
    const richTask = await waitForSeededTask(
      page,
      richGateway.baseUrl,
      richThread.thread.id,
    );
    assert.notEqual(
      await richTask.getAttribute("aria-disabled"),
      "true",
      "seeded task is disabled",
    );
    await richTask.evaluate((node) => node.click());
    const assistant = page.getByTestId("message-assistant").last();
    try {
      await page.waitForFunction(
        () => {
          const messages = [
            ...document.querySelectorAll('[data-testid="message-assistant"]'),
          ];
          return messages
            .at(-1)
            ?.textContent?.includes("中文标点测试：你好，世界！");
        },
        undefined,
        { timeout: 60_000 },
      );
    } catch {
      const diagnostic = await page.evaluate(() => ({
        body: document.body.innerText.slice(0, 5_000),
        assistant: [
          ...document.querySelectorAll('[data-testid="message-assistant"]'),
        ].map((node) => node.textContent),
        taskRows: [
          ...document.querySelectorAll(
            '[data-testid^="runtime-local-task-row-"]',
          ),
        ].map((node) => ({
          testId: node.getAttribute("data-testid"),
          className: node.className,
          ariaDisabled: node.getAttribute("aria-disabled"),
        })),
      }));
      await context.writeArtifactJson("rich-ui-diagnostic.json", diagnostic);
      await page.screenshot({
        path: context.pathInArtifacts("rich-ui-failure.png"),
        fullPage: true,
      });
      throw new Error(
        `rich response did not render CJK content: ${JSON.stringify(diagnostic)}`,
      );
    }
    await assertPrivateContextHidden(
      page,
      privateApplicationSentinel,
      privateClientSentinel,
    );
    await assistant.locator(".katex").waitFor({ timeout: 20_000 });
    await page.bringToFront();
    const mermaidBlock = assistant.locator('[data-streamdown="mermaid-block"]');
    const mermaidSurface = mermaidBlock.locator(
      '[data-streamdown="mermaid"] [role="img"][aria-label="Mermaid chart"]',
    );
    const mermaidDiagram = mermaidSurface.locator(":scope > svg");
    for (
      let attempt = 0;
      attempt < 12 && (await mermaidDiagram.count()) === 0;
      attempt += 1
    ) {
      const observerTarget = mermaidBlock
        .locator(":scope > div.rounded-md > div")
        .last();
      const scrollTarget = (await observerTarget.count())
        ? observerTarget
        : mermaidBlock;
      await scrollTarget.evaluate((node) =>
        node.scrollIntoView({ block: "center" }),
      );
      // Streamdown debounces IntersectionObserver results for 300 ms, so keep the target stably inside the viewport.
      await page.waitForTimeout(750);
    }
    if (await mermaidDiagram.count()) {
      assert.ok(
        await mermaidSurface.count(),
        "Mermaid chart surface is missing",
      );
      await mermaidDiagram.first().waitFor({ state: "visible" });
    } else {
      const diagnostic = await mermaidBlock.evaluate((node) => {
        const placeholder =
          node.querySelector(":scope > div.rounded-md > div") ?? node;
        const rect = placeholder.getBoundingClientRect();
        return {
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
            height: rect.height,
          },
          viewport: { width: innerWidth, height: innerHeight },
          html: node.innerHTML.slice(0, 2_000),
        };
      });
      mermaidFailure = new Error(
        `Mermaid did not materialize after entering the viewport: ${JSON.stringify(diagnostic)} ${browserErrors.join(" | ")}`,
      );
    }
    const imageButton = assistant.getByTestId(
      "assistant-markdown-image-button",
    );
    await imageButton.waitFor({ timeout: 20_000 });
    await imageButton.click();
    await page.getByTestId("attachment-image-lightbox").waitFor();
    await page.getByTestId("attachment-image-lightbox-image").waitFor();
    await page.getByTestId("attachment-image-lightbox-close").click();
    await page
      .getByTestId("attachment-image-lightbox")
      .waitFor({ state: "detached" });
    await captureCase(page, context, "rich-content", "rich-content.png");

    await page.reload({ waitUntil: "domcontentloaded" });
    const reloadedTask = page.getByTestId(
      `runtime-local-task-row-kcoder:local:${richThread.thread.id}`,
    );
    await reloadedTask.waitFor({ state: "visible", timeout: 30_000 });
    await reloadedTask.evaluate((node) => node.click());
    await page.waitForFunction(
      () => {
        const messages = [
          ...document.querySelectorAll('[data-testid="message-assistant"]'),
        ];
        return messages
          .at(-1)
          ?.textContent?.includes("中文标点测试：你好，世界！");
      },
      undefined,
      { timeout: 60_000 },
    );
    await assertPrivateContextHidden(
      page,
      privateApplicationSentinel,
      privateClientSentinel,
    );
    const reloadedAssistant = page.getByTestId("message-assistant").last();
    await reloadedAssistant.locator(".katex").waitFor({ timeout: 20_000 });
    const reloadedMermaid = reloadedAssistant.locator(
      '[data-streamdown="mermaid-block"]',
    );
    for (
      let attempt = 0;
      attempt < 12 && (await reloadedMermaid.locator("svg").count()) === 0;
      attempt += 1
    ) {
      await reloadedMermaid.evaluate((node) =>
        node.scrollIntoView({ block: "center" }),
      );
      await page.waitForTimeout(750);
    }
    assert.ok(
      await reloadedMermaid.locator("svg").count(),
      "Mermaid diagram did not survive page reload",
    );
    await reloadedAssistant
      .getByTestId("assistant-markdown-image-button")
      .waitFor({ timeout: 20_000 });
    await page.close();

    const secondPage = await chromium.newPage({
      viewport: { width: 1280, height: 800 },
    });
    secondPage.on("pageerror", (error) => browserErrors.push(error.message));
    secondPage.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await secondPage.goto(`${richGateway.baseUrl}/?e2e=1&client=second`, {
      waitUntil: "domcontentloaded",
    });
    const secondClientTask = secondPage.getByTestId(
      `runtime-local-task-row-kcoder:local:${richThread.thread.id}`,
    );
    await secondClientTask.waitFor({ state: "visible", timeout: 30_000 });
    await secondClientTask.evaluate((node) => node.click());
    await secondPage.waitForFunction(
      () => {
        const messages = [
          ...document.querySelectorAll('[data-testid="message-assistant"]'),
        ];
        return messages
          .at(-1)
          ?.textContent?.includes("中文标点测试：你好，世界！");
      },
      undefined,
      { timeout: 60_000 },
    );
    await assertPrivateContextHidden(
      secondPage,
      privateApplicationSentinel,
      privateClientSentinel,
    );
    const secondAssistant = secondPage.getByTestId("message-assistant").last();
    await secondAssistant.locator(".katex").waitFor({ timeout: 20_000 });
    const secondMermaid = secondAssistant.locator(
      '[data-streamdown="mermaid-block"]',
    );
    for (
      let attempt = 0;
      attempt < 12 && (await secondMermaid.locator("svg").count()) === 0;
      attempt += 1
    ) {
      await secondMermaid.evaluate((node) =>
        node.scrollIntoView({ block: "center" }),
      );
      await secondPage.waitForTimeout(750);
    }
    assert.ok(
      await secondMermaid.locator("svg").count(),
      "Mermaid diagram did not restore in second client",
    );
    await secondAssistant
      .getByTestId("assistant-markdown-image-button")
      .waitFor({ timeout: 20_000 });
    await captureCase(
      secondPage,
      context,
      "rich-content",
      "rich-content-second-client.png",
    );
    await secondPage.close();
    await context.stopOwned("rich-ui-gateway");

    const { path: todoWorkspace } = await materializeWorkspace(
      context,
      "minimal",
      {
        instanceId: "todo-ui",
      },
    );
    await mkdir(resolve(todoWorkspace, "src"), { recursive: true });
    await writeFile(
      resolve(todoWorkspace, "src/sample.txt"),
      "sample workspace file\n",
    );
    const todoConfig = context.pathInState("todo-config");
    await mkdir(todoConfig, { recursive: true, mode: 0o700 });
    await writeFile(resolve(todoConfig, "settings.json"), "{}\n", {
      mode: 0o600,
    });
    const todoGateway = await startScenarioGateway(context, {
      label: "todo-ui-gateway",
      workspace: todoWorkspace,
      configDir: todoConfig,
      scenario: "mixed-tools",
    });
    const todoThreadId = await seedScenarioThread(
      context,
      todoGateway,
      "执行模型无关的 TodoWrite DOM 渲染链路",
      "TodoWrite DOM E2E",
      60_000,
    );
    const todoPage = await chromium.newPage({
      viewport: { width: 1280, height: 800 },
    });
    todoPage.on("pageerror", (error) => browserErrors.push(error.message));
    await openSeededTask(todoPage, todoGateway.baseUrl, todoThreadId);
    const todoBlock = await revealTestId(todoPage, "todo-write-block", 60_000);
    await todoBlock.waitFor({ state: "visible" });
    assert.equal(await todoBlock.getByTestId("todo-write-item").count(), 2);
    await todoBlock.getByTestId("todo-write-item-in_progress").waitFor();
    await todoBlock.getByTestId("todo-write-item-pending").waitFor();
    await captureCase(todoPage, context, "todo-write", "todo-write.png");
    await todoPage.close();
    await context.stopOwned("todo-ui-gateway");

    const { path: subagentWorkspace } = await materializeWorkspace(
      context,
      "git-history",
      {
        instanceId: "subagent-ui",
      },
    );
    const subagentConfig = context.pathInState("subagent-config");
    await mkdir(subagentConfig, { recursive: true, mode: 0o700 });
    // Resumed mock sessions must retain their mock model without real profiles.
    await writeFile(
      resolve(subagentConfig, "settings.json"),
      '{"providers":{},"model":"tui-dev-mock","context_window_tokens":200000,"context_output_headroom":20000,"max_tokens":4096}\n',
      {
        mode: 0o600,
      },
    );
    const steerGateDirectory = context.pathInState("subagent-steer-gate");
    await mkdir(steerGateDirectory, { mode: 0o700 });
    const subagentGateway = await startScenarioGateway(context, {
      label: "subagent-ui-gateway",
      workspace: subagentWorkspace,
      configDir: subagentConfig,
      scenario: "subagent-trace",
      extraEnv: {
        KCODER_TUI_LAB_STEER_GATE_DIR: steerGateDirectory,
      },
    });
    const subagentThreadId = await seedEmptyScenarioThread(
      context,
      subagentGateway,
      "Subagent DOM E2E",
      "tui-dev-mock",
    );
    const subagentPage = await chromium.newPage({
      viewport: { width: 1280, height: 800 },
    });
    // Observe the owned browser connection that already owns this thread. A
    // second Gateway client is intentionally forbidden from taking that lease.
    await subagentPage.addInitScript(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          try {
            if (JSON.parse(data).method === "agent/steer") window.__kcoderE2ESteerSocket = this;
          } catch { /* Only JSON-RPC requests select the test connection. */ }
        }
        return send.call(this, data);
      };
    });
    const subagentModelSelections = [];
    const subagentWireEvents = [];
    const subagentIdsByCall = new Map();
    const subagentCompletions = new Map();
    const backgroundIdentities = [];
    const completionsByRun = new Map();
    const appliedSteers = [];
    subagentPage.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          const event = frame.params?.event;
          if (frame.method === "item/event" && event?.type?.startsWith("background_job_")) {
            backgroundIdentities.push({ type: event.type, agentId: event.id, identity: frame.params.identity });
          }
          if (frame.method === "item/event" && event?.type === "background_job_associated") {
            subagentIdsByCall.set(event.tool_call_id, event.id);
          }
          if (frame.method === "item/event" && event?.type === "background_job_completed") {
            subagentCompletions.set(event.id, { text: event.text, isError: event.is_error });
            if (frame.params.identity?.run?.runId) {
              const key = `${event.id}:${frame.params.identity.run.runId}`;
              const ids = completionsByRun.get(key) ?? new Set();
              ids.add(frame.params.identity.eventId);
              completionsByRun.set(key, ids);
            }
          }
          if (frame.method === "agent/steer/applied") {
            appliedSteers.push({ agentId: frame.params.agentId, messageId: frame.params.messageId, identity: frame.params.identity });
          }
          if (subagentWireEvents.length < 200)
            subagentWireEvents.push({
              method: frame.method,
              id: frame.id,
              error: frame.error,
              status: frame.params?.turn?.status ?? frame.result?.turn?.status,
              itemType: frame.params?.item?.type,
              engineEventType: frame.params?.event?.type,
            });
        } catch {
          /* Binary frames contain no protocol diagnostics. */
        }
      }),
    );
    subagentPage.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (frame.method === "turn/start" || frame.method === "thread/start")
            subagentModelSelections.push({
              method: frame.method,
              model: frame.params?.model,
            });
        } catch {
          /* Non-JSON frames are unrelated to model selection. */
        }
      }),
    );
    subagentPage.on("pageerror", (error) => browserErrors.push(error.message));
    await openSeededTask(
      subagentPage,
      subagentGateway.baseUrl,
      subagentThreadId,
    );
    await sendComposerPrompt(
      subagentPage,
      "app-server-background-subagent tui-lab-targeted-subagent-steer",
    );
    const subagentStatusToggle = subagentPage.getByTestId(
      "subagent-status-toggle-button",
    );
    try {
      await subagentStatusToggle.waitFor({ state: "visible", timeout: 30_000 });
    } catch (error) {
      await context.writeArtifactJson("subagent-steer-ui-diagnostic.json", {
        modelSelections: subagentModelSelections,
        wireEvents: subagentWireEvents,
        body: await subagentPage.locator("body").innerText(),
        testIds: await subagentPage
          .locator("[data-testid]")
          .evaluateAll((nodes) =>
            nodes
              .map((node) => node.getAttribute("data-testid"))
              .filter(Boolean),
          ),
        userMessages: await subagentPage
          .getByTestId("message-user")
          .allTextContents(),
        assistantMessages: await subagentPage
          .getByTestId("message-assistant")
          .allTextContents(),
        browserErrors,
      });
      await subagentPage.screenshot({
        path: context.pathInArtifacts("subagent-steer-ui-failure.png"),
        fullPage: true,
      });
      throw error;
    }
    if (
      (await subagentPage.getByTestId("subagent-status-panel").count()) === 0
    ) {
      await subagentStatusToggle.click();
    }
    await subagentPage.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="subagent-status-item"]')
          .length >= 2,
      undefined,
      { timeout: 30_000 },
    );
    // Bind to the real target identity; status rows are reordered by activity time.
    await waitFor(
      async () => subagentIdsByCall.has("tui-lab-spawn-agent") &&
        subagentIdsByCall.has("tui-lab-spawn-agent-sibling") &&
        await stat(resolve(steerGateDirectory, "entered")).then(value => value.isFile(), () => false),
      30_000, "target worker entered the owned steer gate", 25, context.abortSignal,
    );
    const targetAgentId = subagentIdsByCall.get("tui-lab-spawn-agent");
    const siblingAgentId = subagentIdsByCall.get("tui-lab-spawn-agent-sibling");
    assert.notEqual(targetAgentId, siblingAgentId);
    await waitFor(() => subagentCompletions.has(siblingAgentId), 30_000,
      "ungated sibling completes independently", 25, context.abortSignal);
    // The parent may finish its response while the gated worker is still active.
    // Sidebar activity must continue until that worker and the aggregate turn settle.
    await subagentPage.getByTestId(`runtime-local-task-running-kcoder:local:${subagentThreadId}`).waitFor({ state: "visible", timeout: 10000 });
    await subagentPage.getByTestId(`runtime-local-task-row-kcoder:local:${subagentThreadId}`).hover();
    await subagentPage.getByTestId(`runtime-local-task-running-kcoder:local:${subagentThreadId}`).waitFor({ state: "visible", timeout: 10000 });
    await subagentPage.mouse.move(900, 100);
    const targetStatus = subagentPage.locator(
      `[data-testid="subagent-status-item"][data-agent-id=${JSON.stringify(targetAgentId)}]`,
    );
    await targetStatus.getByTestId("subagent-steer-open").click();
    const studioSteerSentinel = "STUDIO_TARGETED_SUBAGENT_STEER_E2E";
    await subagentPage
      .getByTestId("subagent-steer-input")
      .fill(studioSteerSentinel);
    await subagentPage.getByTestId("subagent-steer-submit").click();
    await subagentPage.waitForFunction(
      (agentId) =>
        Array.from(
          document.querySelectorAll('[data-testid="subagent-status-item"]'),
        ).some((item) =>
          item.getAttribute("data-agent-id") === agentId &&
          item.getAttribute("data-steer-status")?.startsWith("queued"),
        ),
      targetAgentId,
      { timeout: 30_000 },
    );
    await writeFile(resolve(steerGateDirectory, "release"), "", { flag: "wx", mode: 0o600 });
    await subagentPage.waitForFunction(
      (agentId) =>
        Array.from(
          document.querySelectorAll('[data-testid="subagent-status-item"]'),
        ).some((item) => item.getAttribute("data-agent-id") === agentId &&
          item.getAttribute("data-steer-status") === "applied"),
      targetAgentId,
      { timeout: 60_000 },
    );
    await waitFor(() => subagentCompletions.has(targetAgentId), 30_000,
      "steered target completes its long transcript", 25, context.abortSignal);
    const targetCompletion = subagentCompletions.get(targetAgentId);
    const siblingCompletion = subagentCompletions.get(siblingAgentId);
    assert.equal(targetCompletion.isError, false);
    assert.equal(siblingCompletion.isError, false);
    assert.match(targetCompletion.text, /tui-lab-child-line-180/);
    assert.match(targetCompletion.text, /tui-lab-targeted-steer-observed/);
    assert.doesNotMatch(siblingCompletion.text, /tui-lab-targeted-steer-observed/);
    assert.ok(appliedSteers.some(event => event.agentId === targetAgentId && event.identity?.run?.agentId === targetAgentId && event.identity?.eventId));
    assert.ok(!appliedSteers.some(event => event.agentId === siblingAgentId));
    assert.equal(
      await subagentPage
        .getByTestId("message-user")
        .filter({ hasText: studioSteerSentinel })
        .count(),
      0,
      "定向子智能体指令被错误写入父对话",
    );
    for (const entry of backgroundIdentities) {
      assert.equal(entry.identity?.run?.parentSessionId, subagentThreadId, "background event must retain its parent-session identity");
      assert.equal(entry.identity?.run?.agentId, entry.agentId);
      assert.ok(entry.identity?.run?.runId && entry.identity?.eventId, "background events must expose stable logical IDs");
    }
    const firstTargetRun = backgroundIdentities.find(entry => entry.agentId === targetAgentId && entry.type === "background_job_completed")?.identity.run.runId;
    assert.ok(firstTargetRun);
    // The terminal card intentionally exposes no running-agent steer button.
    // Resume through the real public RPC, then verify its notifications in the existing browser.
    const resumed = await subagentPage.evaluate(({ threadId, agentId }) => new Promise((resolveResult, reject) => {
      const socket = window.__kcoderE2ESteerSocket;
      if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error("owned steer connection is unavailable")); return; }
      const id = "e2e-background-second-run";
      const timer = setTimeout(() => { socket.removeEventListener("message", listener); reject(new Error("second-run steer response timeout")); }, 30_000);
      const listener = event => {
        let response;
        try { response = JSON.parse(event.data); } catch { return; }
        if (response.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener("message", listener);
        if (response.error) reject(new Error(response.error.message));
        else resolveResult(response.result);
      };
      socket.addEventListener("message", listener);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "agent/steer", params: {
        threadId, agentId,
        message: "STUDIO_TARGETED_SUBAGENT_STEER_E2E second run: retain the existing agent identity and report completion.",
        clientMessageId: "studio-background-second-run",
      } }));
    }), { threadId: subagentThreadId, agentId: targetAgentId });
    assert.equal(resumed.status, "resuming");
    await waitFor(() => backgroundIdentities.some(entry => entry.agentId === targetAgentId &&
      entry.type === "background_job_completed" && entry.identity?.run?.runId !== firstTargetRun),
      60_000, "same agent second run reaches the existing browser", 25, context.abortSignal);
    for (const identities of completionsByRun.values()) assert.equal(identities.size, 1, "one stable terminal identity per execution run");
    await context.writeArtifactJson("background-run-identities.json", {
      events: backgroundIdentities,
      completionRuns: [...completionsByRun].map(([run, ids]) => ({ run, eventIds: [...ids] })),
      scope: "deterministic real protocol/browser delivery; no external model behavior assertion",
    });

    const subagentBlock = await revealTestId(
      subagentPage,
      "subagent-tool-block",
      90_000,
    );
    await subagentBlock.waitFor({ state: "visible" });
    const subagentToggle = subagentBlock.getByTestId("subagent-tool-toggle");
    await subagentToggle.waitFor();
    await subagentPage.getByTestId(`runtime-local-task-running-kcoder:local:${subagentThreadId}`).waitFor({ state: "detached", timeout: 15000 });
    await captureCase(subagentPage, context, "subagent", "subagent.png");
    await captureCase(
      subagentPage,
      context,
      "subagent",
      "subagent-steer-applied.png",
    );

    if (mermaidFailure) throw mermaidFailure;
    assert.deepEqual(
      browserErrors,
      [],
      `renderer emitted page errors: ${browserErrors.join("\n")}`,
    );
    return {
      chromiumCdpPort: chromium.cdpPort,
      richContent: ["mermaid", "katex", "cjk", "image-lightbox"],
      structuredTools: ["TodoWrite", "subagent", "subagent-steer"],
      browserErrors,
    };
  },
);

async function startScenarioGateway(
  context,
  { label, workspace, configDir, scenario, mock = false, extraEnv = {} },
) {
  const serversFile = await context.writeStateJson(`${label}-servers.json`, [
    {
      id: "local",
      label: "Local",
      transport: "local",
      command: resolve(repoRoot, "target/debug/kcoder"),
      workspace,
    },
  ]);
  return startGateway(context, {
    label,
    workspace,
    serversFile,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_SCENARIO: scenario,
      ...(mock ? { KCODER_STUDIO_MOCK: "1" } : {}),
      ...extraEnv,
    },
  });
}

async function seedEmptyScenarioThread(context, gateway, title, model) {
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
  await initializeRpc(
    rpc,
    `kcoder-e2e-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  );
  const started = await rpc.request("thread/start", {});
  await rpc.request("thread/metadata/update", {
    threadId: started.thread.id,
    title,
    ...(model ? { model } : {}),
  });
  rpc.close();
  await waitFor(
    () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
    5_000,
    `${title} seed RPC close`,
  );
  return started.thread.id;
}

async function sendComposerPrompt(page, prompt) {
  const composer = page.getByTestId("chat-message-input");
  await composer.waitFor({ state: "visible", timeout: 30_000 });
  await composer.click();
  await page.keyboard.insertText(prompt);
  await page.getByTestId("send-message-button").click();
}

async function seedScenarioThread(context, gateway, prompt, title, timeoutMs) {
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
  await initializeRpc(
    rpc,
    `kcoder-e2e-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  );
  const started = await rpc.request("thread/start", {});
  const turn = await rpc.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: prompt }],
  });
  await rpc.waitFor(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.turnId === turn.turn.id,
    timeoutMs,
    `${title} deterministic turn`,
  );
  await rpc.request("thread/metadata/update", {
    threadId: started.thread.id,
    title,
  });
  rpc.close();
  await waitFor(
    () => rpc.socket.readyState === rpc.socket.constructor.CLOSED,
    5_000,
    `${title} seed RPC close`,
  );
  return started.thread.id;
}

async function assertPrivateContextHidden(
  page,
  applicationSentinel,
  clientSentinel,
) {
  const userMessage = page.getByTestId("message-user").last();
  await userMessage.waitFor({ state: "visible", timeout: 20_000 });
  const text = await userMessage.innerText();
  assert.match(text, /中文标点测试：你好，世界！/);
  for (const privateValue of [
    applicationSentinel,
    clientSentinel,
    "<application_context>",
    "<kcoder_client_context",
  ]) {
    assert.ok(
      !text.includes(privateValue),
      `private context leaked in persisted user message: ${privateValue}`,
    );
  }
}

async function openSeededTask(page, baseUrl, threadId) {
  const task = await waitForSeededTask(page, baseUrl, threadId);
  assert.notEqual(
    await task.getAttribute("aria-disabled"),
    "true",
    "seeded task is disabled",
  );
  await task.evaluate((node) => node.click());
}

async function waitForSeededTask(page, baseUrl, threadId) {
  const testId = `runtime-local-task-row-kcoder:local:${threadId}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await page.goto(`${baseUrl}/?e2e=1`, {
      waitUntil: "domcontentloaded",
    });
    assert.equal(response?.status(), 200);
    const task = page.getByTestId(testId);
    try {
      // Initial load may precede persisted-thread enumeration; provide a stable observation window for the real asynchronous enumeration.
      await task.waitFor({ state: "visible", timeout: 5_000 });
      return task;
    } catch {
      // Reload after the observation window to cover recovery from app-server cold start or an initial WebSocket handshake failure.
    }
  }
  const diagnostic = await page.evaluate(() => ({
    body: document.body.innerText.slice(0, 5_000),
    taskIds: [
      ...document.querySelectorAll('[data-testid^="runtime-local-task-row-"]'),
    ].map((node) => node.getAttribute("data-testid")),
  }));
  throw new Error(
    `seeded task ${testId} did not appear: ${JSON.stringify(diagnostic)}`,
  );
}

async function revealTestId(page, testId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = page.getByTestId(testId).last();
    if (await target.count()) return target;
    for (const toggleId of [
      "final-processing-toggle",
      "processing-summary-toggle",
      "processing-activity-group-toggle",
    ]) {
      const toggles = page.getByTestId(toggleId);
      for (let index = 0; index < (await toggles.count()); index += 1) {
        const toggle = toggles.nth(index);
        if ((await toggle.getAttribute("aria-expanded")) === "false")
          await toggle.click();
      }
    }
    await page.waitForTimeout(100);
  }
  const diagnostic = await page.evaluate(() => ({
    body: document.body.innerText.slice(0, 5_000),
    testIds: [...document.querySelectorAll("[data-testid]")]
      .map((node) => node.getAttribute("data-testid"))
      .filter(Boolean),
  }));
  throw new Error(
    `Timed out waiting for structured renderer ${testId}: ${JSON.stringify(diagnostic)}`,
  );
}

async function captureCase(page, context, slug, filename) {
  const screenshot = context.pathInCase("system-chromium", slug, filename);
  await mkdir(resolve(screenshot, ".."), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
}
