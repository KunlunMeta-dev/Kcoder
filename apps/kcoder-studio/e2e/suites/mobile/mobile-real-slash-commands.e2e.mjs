import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { appRoot, repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";

const mobileDist = resolve(appRoot, "mobile/dist");
await access(resolve(mobileDist, "index.html"));

await runE2E(import.meta.url, {
  testId: "mobile-web-real-slash-commands",
  tier: "full-integration",
  modelPolicy: "model-independent composer actions through one real app-server",
  retainSuccessLogs: true,
}, async context => {
  const workspace = context.pathInState("workspace");
  const configDir = context.pathInState("config");
  await mkdir(workspace, { recursive: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const model = await startApprovalModelFixture(context, { textOnly: true });
  const settingsFile = await context.writeStateJson("slash-settings.json", {
    active_provider: "mobile-slash",
    permission_mode: "yolo",
    providers: { "mobile-slash": provider(model.baseUrl) },
  });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", {
    "mobile-slash": { type: "api", key: "deterministic-local" },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local", label: "Local", transport: "local",
    command:
      process.env.KCODER_E2E_KCODER_BIN ||
      resolve(repoRoot, "target/debug/kcoder"),
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    auth: true, label: "mobile-slash-gateway", workspace, serversFile, uiReceiptFault: true,
    env: { KCODER_CONFIG_DIR: configDir, KCODER_STUDIO_WEB_ROOT: mobileDist },
  });
  const chromium = await startChromium(context, { label: "mobile-slash-chromium" });
  const page = await chromium.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  const diagnostics = [];
  const rpcRequests = [];
  const rpcTrace = [];
  const traceMethods = new Set([
    "thread/goal/set",
    "thread/goal/get",
    "thread/goal/continuation",
    "turn/start",
    "turn/receipt/read",
    "turn/started",
    "turn/completed",
    "turn/failed",
    "turn/interrupted",
  ]);
  let socketSequence = 0;
  const heldGoalStartResponses = [];
  let lastReleasedGoalStartAck = null;
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`);
  });
  await page.routeWebSocket("**/rpc*", socket => {
    const upstream = socket.connectToServer();
    const socketId = ++socketSequence;
    const methodsById = new Map();
    const requestsById = new Map();
    socket.onMessage(raw => {
      let payload;
      try { payload = JSON.parse(String(raw)); } catch { upstream.send(raw); return; }
      for (const frame of Array.isArray(payload) ? payload : [payload]) {
        if (!frame?.method) continue;
        rpcRequests.push({ method: frame.method, params: frame.params ?? null });
        if (frame.id != null) {
          methodsById.set(String(frame.id), frame.method);
          requestsById.set(String(frame.id), frame);
          if (traceMethods.has(frame.method))
            rpcTrace.push(summarizeRpcFrame("request", socketId, frame));
        }
      }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      let payload;
      try { payload = JSON.parse(String(raw)); } catch { socket.send(raw); return; }
      const isBatch = Array.isArray(payload);
      const delivered = [];
      for (const frame of isBatch ? payload : [payload]) {
        const method = frame?.method ?? methodsById.get(String(frame?.id));
        if (method && traceMethods.has(method)) {
          const request = requestsById.get(String(frame?.id));
          const isStrictGoalStart = method === "turn/start" && request?.params?.input?.some?.(item =>
            item?.type === "text" && typeof item.text === "string" &&
            item.text.startsWith("SLASH_MOBILE_STRICT_"),
          );
          if (isStrictGoalStart && (frame.result !== undefined || frame.error !== undefined)) {
            const held = {
              socket,
              socketId,
              id: frame.id,
              frame,
              raw: JSON.stringify(frame),
              receivedAt: Date.now(),
            };
            heldGoalStartResponses.push(held);
            rpcTrace.push(summarizeRpcFrame("response-held", socketId, frame, method));
            continue;
          }
          rpcTrace.push(summarizeRpcFrame("response-or-notification", socketId, frame, method));
        }
        delivered.push(frame);
      }
      if (delivered.length === 0) return;
      if (isBatch && delivered.length !== payload.length)
        socket.send(JSON.stringify(delivered));
      else
        socket.send(raw);
    });
  });

  const releaseGoalStartAck = () => {
    const held = heldGoalStartResponses.splice(0);
    for (const item of held) {
      rpcTrace.push(summarizeRpcFrame("response-delivered", item.socketId, item.frame, "turn/start"));
      item.socket.send(item.raw);
      lastReleasedGoalStartAck = { id: item.id, socketId: item.socketId, releasedAt: Date.now() };
    }
    return held.length;
  };
  context.addCleanup("retain failed slash UI evidence", async () => {
    const manifest = JSON.parse(await readFile(resolve(context.runRoot, "manifest.json"), "utf8"));
    if (!manifest.error || !page.url().includes("/task/")) return;
    await context.writeArtifactJson("failed-slash-ui.json", {
      text: await page.locator("body").innerText(), rpcRequests, diagnostics,
    });
    await page.screenshot({ path: context.pathInArtifacts("failed-slash-ui.png"), fullPage: true });
  });

  await connect(page, gateway);
  await page.getByTestId("new-workspace").click();
  await page.getByTestId("server-option-local").click();
  await page.getByTestId("workspace-path").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("new-workspace-prompt").fill("SLASH_COMMAND_BOOTSTRAP");
  await page.getByTestId("create-workspace").click();
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });

  const composer = page.getByTestId("message-input");
  await composer.fill("/");
  const menu = page.getByTestId("slash-command-menu");
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  const visibleCommands = await menu.getByRole("menuitem").allTextContents();
  for (const command of ["/compact", "/model", "/rename", "/goal", "/goal-pro", "/moa", "/moa-plan"]) {
    assert.ok(visibleCommands.some(text => text.includes(command)), `slash menu missing ${command}`);
  }

  const turnStartsBeforeInvalidSlash = rpcRequests.filter(request => request.method === "turn/start").length;
  await page.getByTestId("send-message").click();
  await page.getByText("请输入 slash 指令名称", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  await composer.fill("/unknown");
  await page.getByTestId("send-message").click();
  await page.getByText("未知 slash 指令：/unknown", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(
    rpcRequests.filter(request => request.method === "turn/start").length,
    turnStartsBeforeInvalidSlash,
    "empty and unknown slash input must not start a provider turn",
  );
  await composer.fill("/");

  const moaPlan = page.getByTestId("slash-command-moa-plan");
  await moaPlan.scrollIntoViewIfNeeded();
  await moaPlan.click();
  assert.equal(await composer.inputValue(), "/moa-plan ", "last slash command must remain reachable");

  await composer.fill("/");
  await page.getByTestId("slash-command-rename").click();
  assert.equal(await composer.inputValue(), "/rename ");
  const renamed = `Owned mobile receipt ${Date.now()}`;
  await writeFile(resolve(context.artifactsDir, "ui-receipt-plan.json"), JSON.stringify({ mode: "mobile-rename" }));
  await composer.fill(`/rename ${renamed}`);
  await page.getByTestId("send-message").click();
  await waitFor(async () => JSON.parse(await readFile(resolve(context.artifactsDir, "ui-receipt-fault.json"), "utf8").catch(() => "{}"))["mobile-rename"]?.held, 5000, "mobile rename receipt held");
  await composer.fill("New draft while rename is pending");
  await writeFile(resolve(context.artifactsDir, "ui-receipt-release-mobile-rename"), "release");
  await page.getByText("任务标题已更新", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await composer.inputValue(), "New draft while rename is pending");
  await page.getByText(renamed, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

  const turnStartsBeforeCompact = rpcRequests.filter(request => request.method === "turn/start").length;
  await composer.fill("/comp");
  await page.getByTestId("slash-command-compact").click();
  await page.getByText(/当前上下文无需压缩|上下文已压缩/).waitFor({ state: "visible", timeout: 60_000 });
  assert.equal(
    rpcRequests.filter(request => request.method === "turn/start").length,
    turnStartsBeforeCompact,
    "compact slash command must not start a user turn",
  );

  await composer.fill("/mod");
  await page.getByTestId("slash-command-model").click();
  await page.getByRole("dialog", { name: "切换模型" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("dialog", { name: "切换模型" }).getByLabel("关闭").click();
  assert.equal(await composer.inputValue(), "");

  const strictObjective = `SLASH_MOBILE_STRICT_${Date.now()}`;
  const draftB = `MOBILE_SLASH_DRAFT_B_${Date.now()}`;
  await page.evaluate(value => {
    window.__mobileSlashTestDraftB = value;
    window.__mobileSlashTestPhase = "starting-goal-A";
    window.__mobileSlashComposerSamples = [];
    window.__mobileSlashComposerLast = "";
    const readDrafts = () => Object.entries(localStorage)
      .filter(([key]) => key.startsWith("kcoder-studio:mobile-workspace-state:v3:"))
      .map(([, raw]) => {
        try { return JSON.parse(raw)?.composerDraft; } catch { return undefined; }
      })
      .filter(draft => typeof draft === "string");
    const sample = () => {
      const input = document.querySelector('[data-testid="message-input"]');
      const button = document.querySelector(
        '[data-testid="send-message"], [data-testid="queue-message"]',
      );
      const state = {
        phase: window.__mobileSlashTestPhase,
        inputValue: input?.value ?? null,
        draftBPersisted: readDrafts().includes(window.__mobileSlashTestDraftB),
        buttonTestId: button?.getAttribute("data-testid") ?? null,
        buttonDisabled: button?.hasAttribute("disabled") ?? null,
        buttonAriaDisabled: button?.getAttribute("aria-disabled") ?? null,
      };
      const key = JSON.stringify(state);
      if (key === window.__mobileSlashComposerLast) return;
      window.__mobileSlashComposerLast = key;
      window.__mobileSlashComposerSamples.push({ at: performance.now(), ...state });
      if (window.__mobileSlashComposerSamples.length > 240)
        window.__mobileSlashComposerSamples.shift();
    };
    sample();
    window.__mobileSlashComposerSampleTimer = window.setInterval(sample, 10);
  }, draftB);
  await composer.fill(`/goal-pro ${strictObjective}`);
  await page.getByTestId("send-message").click();
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.mode === "strict"
    && request.params?.objective === strictObjective);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "turn/start"
    && request.params?.input?.some?.(item => item?.type === "text"
      && typeof item.text === "string" && item.text.includes(strictObjective)));
  await waitFor(() => heldGoalStartResponses.length === 1, 30_000, "strict goal turn/start ACK to hold");
  await page.evaluate(() => { window.__mobileSlashTestPhase = "goal-A-ack-held"; });

  await composer.fill(draftB);
  await page.waitForFunction(expected => {
    const input = document.querySelector('[data-testid="message-input"]');
    const drafts = Object.entries(localStorage)
      .filter(([key]) => key.startsWith("kcoder-studio:mobile-workspace-state:v3:"))
      .map(([, raw]) => {
        try { return JSON.parse(raw)?.composerDraft; } catch { return undefined; }
      });
    return input?.value === expected && drafts.includes(expected);
  }, draftB, { timeout: 15_000 });
  const beforeAck = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="message-input"]');
    const button = document.querySelector(
      '[data-testid="send-message"], [data-testid="queue-message"]',
    );
    const persistedDrafts = Object.entries(localStorage)
      .filter(([key]) => key.startsWith("kcoder-studio:mobile-workspace-state:v3:"))
      .map(([, raw]) => {
        try { return JSON.parse(raw)?.composerDraft; } catch { return undefined; }
      })
      .filter(draft => typeof draft === "string");
    return {
      inputValue: input?.value ?? null,
      persistedDrafts,
      buttonTestId: button?.getAttribute("data-testid") ?? null,
      buttonDisabled: button?.hasAttribute("disabled") ?? null,
      timeline: window.__mobileSlashComposerSamples,
    };
  });
  beforeAck.heldAck = heldGoalStartResponses[0]
    ? { held: true, id: heldGoalStartResponses[0].id, socketId: heldGoalStartResponses[0].socketId }
    : null;
  await context.writeArtifactJson("mobile-slash-goal-command-input-race-before-ack.json", {
    strictObjective,
    draftB,
    beforeAck,
    goalStartTrace: rpcTrace.filter(entry => entry.method === "turn/start"
      && (entry.params?.inputText ?? []).some(text => text.includes(strictObjective))),
  });
  assert.equal(beforeAck.heldAck?.held, true, "goal turn/start ACK must remain held while B is entered");
  assert.equal(beforeAck.inputValue, draftB, "composer must retain B while the goal command awaits ACK");
  assert.ok(beforeAck.persistedDrafts.includes(draftB), "workspace draft must persist B before the ACK");

  const releasedAcks = releaseGoalStartAck();
  assert.equal(releasedAcks, 1, "the held goal turn/start ACK must be released exactly once");
  await page.evaluate(() => { window.__mobileSlashTestPhase = "goal-A-ack-released"; });
  let completionError;
  try {
    await page.getByText("/goal-pro 已启动", { exact: true }).waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForFunction(expected => {
      const input = document.querySelector('[data-testid="message-input"]');
      const drafts = Object.entries(localStorage)
        .filter(([key]) => key.startsWith("kcoder-studio:mobile-workspace-state:v3:"))
        .map(([, raw]) => {
          try { return JSON.parse(raw)?.composerDraft; } catch { return undefined; }
        });
      return input?.value === expected && drafts.includes(expected);
    }, draftB, { timeout: 10_000 });
  } catch (error) {
    completionError = {
      name: error instanceof Error ? error.name : "Error",
      message: String(error instanceof Error ? error.message : error).slice(0, 800),
    };
  }
  const afterAck = await page.evaluate(() => {
    window.clearInterval(window.__mobileSlashComposerSampleTimer);
    const input = document.querySelector('[data-testid="message-input"]');
    const button = document.querySelector(
      '[data-testid="send-message"], [data-testid="queue-message"]',
    );
    const persistedDrafts = Object.entries(localStorage)
      .filter(([key]) => key.startsWith("kcoder-studio:mobile-workspace-state:v3:"))
      .map(([, raw]) => {
        try { return JSON.parse(raw)?.composerDraft; } catch { return undefined; }
      })
      .filter(draft => typeof draft === "string");
    return {
      inputValue: input?.value ?? null,
      persistedDrafts,
      buttonTestId: button?.getAttribute("data-testid") ?? null,
      buttonDisabled: button?.hasAttribute("disabled") ?? null,
      timeline: window.__mobileSlashComposerSamples,
    };
  });
  afterAck.heldAck = lastReleasedGoalStartAck
    ? { held: false, ...lastReleasedGoalStartAck }
    : null;
  const goalStartRequest = rpcTrace.find(entry => entry.direction === "request"
    && entry.method === "turn/start"
    && (entry.params?.inputText ?? []).some(text => text.includes(strictObjective)));
    const goalStartAck = goalStartRequest
    ? rpcTrace.find(entry => entry.direction === "response-delivered"
      && entry.method === "turn/start"
      && String(entry.id) === String(goalStartRequest.id))
    : undefined;
  await context.writeArtifactJson("mobile-slash-goal-command-input-race.json", {
    strictObjective,
    draftB,
    releasedAcks,
    completionError,
    beforeAck,
    afterAck,
    goalStartRequest,
    goalStartAck,
    goalLifecycleTrace: rpcTrace.filter(entry => entry.method === "turn/start"
      || entry.method === "turn/started"
      || entry.method === "turn/completed"
      || entry.method === "turn/failed"),
    diagnostics,
  });
  assert.equal(completionError, undefined, "goal command should settle and preserve B after its ACK");
  assert.ok(goalStartRequest, "goal objective must produce a traced turn/start request");
  assert.ok(goalStartAck, "the matching goal turn/start acknowledgement must be traced");
  assert.equal(afterAck.heldAck?.held, false, "held goal turn/start ACK should be delivered to the client");
  assert.equal(afterAck.inputValue, draftB, "late goal completion must not clear newer composer input B");
  assert.ok(afterAck.persistedDrafts.includes(draftB), "late goal completion must not erase persisted draft B");

  const controlTurnCount = rpcRequests.filter(request => request.method === "turn/start").length;
  await runSlash(page, composer, "/goal-pro status", /Goal Pro · active/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/get");
  await runSlash(page, composer, "/goal-pro pause", /Goal Pro · paused/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.status === "paused" && request.params?.objective === undefined);

  const editedObjective = `SLASH_MOBILE_EDITED_${Date.now()}`;
  await runSlash(page, composer, `/goal-pro edit --budget 3072 ${editedObjective}`, /Goal Pro 已更新并暂停/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.edit === true
    && request.params?.objective === editedObjective
    && request.params?.tokenBudget === 3072);
  await composer.fill("/goal-pro edit");
  await page.getByTestId("send-message").click();
  await page.getByText("目标已载入输入框，修改后发送即可保存", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await composer.inputValue(), `/goal-pro edit ${editedObjective}`);
  await runSlash(page, composer, "/goal-pro history", /没有已完成、阻塞或达到限额的目标历史/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/history");
  await runSlash(page, composer, "/goal-pro resume", /Goal Pro · active/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.status === "active" && request.params?.objective === undefined);
  await runSlash(page, composer, "/goal-pro clear", /\/goal-pro 已清除/);
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/clear");
  assert.equal(
    rpcRequests.filter(request => request.method === "turn/start").length,
    controlTurnCount,
    "goal lifecycle commands must never start provider turns",
  );

  const requestsBeforeInvalidBudget = rpcRequests.length;
  await runSlash(page, composer, "/goal-pro --budget 0 INVALID", /token budget must be a positive integer/);
  assert.equal(rpcRequests.length, requestsBeforeInvalidBudget, "invalid budget must stay entirely client-side");

  const answerObjective = `SLASH_MOBILE_ANSWER_${Date.now()}`;
  await composer.fill(`/goal-pro --budget 4096 --answer -- ${answerObjective}`);
  await page.getByTestId("send-message").click();
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.mode === "strict"
    && request.params?.verificationKind === "answer"
    && request.params?.tokenBudget === 4096
    && request.params?.objective === answerObjective);
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });
  const answerTurnRequest = rpcRequests.find(request => request.method === "turn/start"
    && request.params?.input?.some?.(item => item?.type === "text" && item?.text === answerObjective));
  assert.ok(answerTurnRequest, "Goal Pro flags must not leak into the provider turn text");

  const replacementObjective = `SLASH_MOBILE_REPLACEMENT_${Date.now()}`;
  await composer.fill(`/goal ${replacementObjective}`);
  const goalSetsBeforeReplacement = rpcRequests.filter(request => request.method === "thread/goal/set").length;
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByTestId("send-message").click();
  await page.waitForTimeout(150);
  assert.equal(
    rpcRequests.filter(request => request.method === "thread/goal/set").length,
    goalSetsBeforeReplacement,
    "cancelling replacement must not mutate the current goal",
  );
  assert.equal(await composer.inputValue(), `/goal ${replacementObjective}`);
  page.once("dialog", dialog => dialog.accept());
  await page.getByTestId("send-message").click();
  await waitForRpcRequest(page, rpcRequests, request => request.method === "thread/goal/set"
    && request.params?.mode === "standard"
    && typeof request.params?.expectedGoalId === "string"
    && typeof request.params?.expectedRevision === "number"
    && request.params?.objective === replacementObjective);
  // The request frame and an already-visible send button precede its receipt.
  // Wait for this command's completion before sending the next Goal mutation.
  await page.getByText("/goal 已启动", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("send-message").waitFor({ state: "visible", timeout: 60_000 });

  await runSlash(page, composer, "/goal clear", /\/goal 已清除/);
  const turnsBeforeRetiredCommand = rpcRequests.filter(request => request.method === "turn/start").length;
  await composer.fill("/ultgoal retired mode");
  await page.getByTestId("send-message").click();
  await page.getByText("未知 slash 指令：/ultgoal", { exact: true }).waitFor({ state: "visible" });
  assert.equal(rpcRequests.filter(request => request.method === "turn/start").length, turnsBeforeRetiredCommand);

  const renameRequest = rpcRequests.find(request => request.method === "thread/metadata/update" && request.params?.title === renamed);
  const compactRequest = rpcRequests.find(request => request.method === "thread/compact");
  const strictGoalRequest = rpcRequests.find(request => request.method === "thread/goal/set"
    && request.params?.mode === "strict"
    && request.params?.objective === strictObjective);
  const answerGoalRequest = rpcRequests.find(request => request.method === "thread/goal/set"
    && request.params?.verificationKind === "answer"
    && request.params?.objective === answerObjective);
  await page.screenshot({ path: context.pathInArtifacts("mobile-slash-commands.png"), fullPage: true });
  await context.writeArtifactJson("mobile-real-slash-commands.json", {
    visibleCommands,
    renamed,
    renameReachedAppServer: Boolean(renameRequest),
    delayedRenamePreservesNewDraft: true,
    compactReachedAppServer: Boolean(compactRequest),
    strictGoalReachedAppServer: Boolean(strictGoalRequest),
    lifecycleCommandsDidNotStartTurns: true,
    answerGoalReachedAppServer: Boolean(answerGoalRequest),
    answerFlagsExcludedFromTurn: Boolean(answerTurnRequest),
    replacementRequiresConfirmation: true,
    retiredCommandDoesNotStartTurn: true,
    slashSafety: { bareSlashBlocked: true, unknownBlocked: true },
    diagnostics,
  });
  assert.ok(renameRequest, "rename slash command must reach thread/metadata/update");
  assert.ok(compactRequest, "compact slash command must reach thread/compact");
  assert.ok(strictGoalRequest, "goal-pro slash command must set a strict goal through app-server");
  assert.ok(answerGoalRequest, "goal-pro --answer must preserve verificationKind and tokenBudget");
  assert.deepEqual(diagnostics, []);
  return {
    supportedTuiSubsetMenu: true,
    argumentPrefill: true,
    realRename: true,
    realCompact: true,
    realStrictGoal: true,
    realGoalLifecycle: true,
    realAnswerGoal: true,
    replacementConfirmation: true,
    realUltgoalLifecycle: true,
    modelPickerOpened: true,
  };
});

async function runSlash(page, composer, command, visibleNotice) {
  await composer.fill(command);
  await page.getByTestId("send-message").click();
  await page.getByText(visibleNotice).waitFor({ state: "visible", timeout: 30_000 });
}

function summarizeRpcFrame(direction, socketId, frame, method = frame.method) {
  const params = frame.params && typeof frame.params === "object" ? frame.params : {};
  const result = frame.result && typeof frame.result === "object" ? frame.result : {};
  const turn = result.turn && typeof result.turn === "object" ? result.turn : {};
  const receipt = result.receipt && typeof result.receipt === "object" ? result.receipt : {};
  const goal = result.goal && typeof result.goal === "object" ? result.goal : {};
  const inputText = Array.isArray(params.input)
    ? params.input
        .filter(item => item?.type === "text" && typeof item.text === "string")
        .map(item => item.text.slice(0, 200))
    : undefined;
  const pick = (source, keys) => Object.fromEntries(
    keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]),
  );
  return {
    direction,
    socketId,
    ...(frame.id != null ? { id: frame.id } : {}),
    method,
    params: {
      ...pick(params, [
        "threadId",
        "clientMessageId",
        "mode",
        "objective",
        "status",
        "tokenBudget",
        "verificationKind",
        "turnId",
        "attemptId",
      ]),
      ...(inputText ? { inputText } : {}),
    },
    ...(frame.error
      ? { error: { code: frame.error.code, message: String(frame.error.message ?? "").slice(0, 300) } }
      : {}),
    result: {
      ...pick(turn, ["id", "status", "attemptId"]),
      ...(Object.keys(receipt).length > 0
        ? { receipt: pick(receipt, ["threadId", "turnId", "status", "attemptId"]) }
        : {}),
      ...(Object.keys(goal).length > 0
        ? { goal: pick(goal, ["goalId", "objective", "mode", "status", "revision", "tokenBudget", "verificationKind"]) }
        : {}),
      ...pick(result, ["status", "turnId", "attemptId", "clientMessageId"]),
    },
  };
}

function provider(endpoint) {
  return {
    api_format: "openai_chat_completions", endpoint, default_model: "mobile-slash-e2e-model",
    context_window_tokens: 128000, output_headroom_tokens: 8192,
    max_output_tokens: 8192, request_timeout_secs: 30, no_proxy: true, extra_body: {},
  };
}

async function connect(page, gateway) {
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([
    page.waitForSelector('[data-testid="welcome-direct-connection"]', { timeout: 30_000 }),
    page.locator('button[type="submit"]').click(),
  ]);
  await page.getByTestId("welcome-direct-connection").click();
  await page.getByTestId("gateway-token").fill(gateway.authToken);
  await page.getByTestId("gateway-connect").click();
  await page.getByTestId("new-workspace").waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForRpcRequest(page, requests, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (requests.some(predicate)) return;
    await page.waitForTimeout(100);
  }
  assert.fail("timed out waiting for expected app-server request");
}
