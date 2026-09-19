import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: "scheduled-tasks-and-late-send-acknowledgement",
  tier: "full-integration",
  modelPolicy: "model-independent schedule persistence, idle delivery, native RPC and UI lifecycle",
  retainSuccessLogs: true,
}, async context => {
  // QA: delay send acknowledgements beyond model completion; verify waiting clears.
  // Create an explicitly authorized one-shot task, restore the page, observe its
  // actual provider request and completion, then create/delete a future task.
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "schedules" });
  const profile = context.pathInState("profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await context.writeStateJson("profile/settings.json", {});
  context.registerSecret("schedule-fixture-key");
  await context.writeStateJson("profile/credentials.json", { schedule: { type: "api", key: "schedule-fixture-key" } });
  const modelOptions = { textOnly: true, textOnlyChunks: ["SCHEDULE_RESPONSE_DONE"], textOnlyChunkDelayMs: 0 };
  const model = await startApprovalModelFixture(context, modelOptions);
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "schedule", providers: { schedule: {
      api_format: "openai_chat_completions", endpoint: model.baseUrl, default_model: "schedule",
      context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192, no_proxy: true,
    } },
  });
  const serversFile = await context.writeStateJson("servers.json", [{ id: "local", label: "Schedules", transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC" });
  const completed = [];
  const automaticRuns = new Map();
  const jobDueAt = async marker => {
    const stored = JSON.parse(await readFile(resolve(workspace, '.kcoder/cron/jobs.json'), 'utf8'));
    return Date.parse(stored.jobs.find(job => job.prompt === marker).next_run_at);
  };
  page.on("websocket", socket => socket.on("framereceived", frame => {
    try {
      const message = JSON.parse(String(frame.payload));
      if (message.method === "turn/completed") completed.push(message.params);
      if (message.method === 'automation/runStarted') automaticRuns.set(message.params.threadId, message.params);
    } catch { /* Non-JSON frames do not affect this assertion. */ }
  }));
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login")), page.locator('button[type="submit"]').click()]);
  const project = page.getByTestId("project-item").filter({ hasText: "Schedules" }).first();
  await project.waitFor({ timeout: 60000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    internals.invoke = async (command, args) => {
      const result = await invoke(command, args);
      if (command === "local_executor_request" && ["runtime.tasks.create", "runtime.tasks.send"].includes(args?.method)) {
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      return result;
    };
  });
  await page.getByTestId("chat-message-input").click();
  await page.keyboard.insertText("Schedule smoke conversation\nORIGINAL_HISTORY_MUST_NOT_LEAK");
  await page.getByTestId("send-message-button").click();
  await page.getByText("SCHEDULE_RESPONSE_DONE", { exact: true }).waitFor({ timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1500)));
  assert.equal(await page.getByTestId("thinking-indicator").count(), 0);
  const originalThread = completed[0]?.threadId;
  assert.ok(originalThread);
  await page.getByTestId("automations-button").click();
  await page.getByTestId("scheduled-tasks-panel").waitFor();
  await page.getByTestId("automation-target").locator("option").first().waitFor({ state: "attached" });
  await page.getByTestId("automation-prompt").fill("AUTOMATION_JOB_MARKER");
  await page.getByTestId("automation-at").fill(new Date(Date.now() + 12000).toISOString().slice(0, 19).replace(/:00$/, ""));
  assert.equal(await page.getByTestId("automation-create").isDisabled(), true);
  await page.getByTestId("automation-confirm").check();
  await page.getByTestId("automation-create").click();
  await page.getByTestId("automation-job").filter({ hasText: "AUTOMATION_JOB_MARKER" }).waitFor({ timeout: 10000 });
  const firstDueAt = await jobDueAt('AUTOMATION_JOB_MARKER');
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("scheduled-tasks-panel").waitFor({ timeout: 30000 });
  await page.getByTestId("automation-job").filter({ hasText: "AUTOMATION_JOB_MARKER" }).waitFor({ timeout: 10000 });
  await waitFor(() => model.requests.some(request => JSON.stringify(request.messages).includes("AUTOMATION_JOB_MARKER")),
    Math.max(15000, firstDueAt - Date.now() + 15000), "scheduled provider request", 100, context.abortSignal);
  await waitFor(() => automaticRuns.size === 1, 10000, 'new scheduled session', 100, context.abortSignal);
  const firstAutomaticThread = [...automaticRuns.keys()][0];
  assert.notEqual(firstAutomaticThread, originalThread);
  const firstRequest = model.requests.find(request => JSON.stringify(request.messages).includes('AUTOMATION_JOB_MARKER'));
  assert.ok(!JSON.stringify(firstRequest.messages).includes('ORIGINAL_HISTORY_MUST_NOT_LEAK'));
  await waitFor(() => completed.some(event => event.threadId === firstAutomaticThread && event.turn?.status === 'completed'),
    15000, "scheduled completion", 100, context.abortSignal);
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await page.getByTestId("automation-job").waitFor({ state: "detached", timeout: 10000 });
  await page.getByTestId("automation-prompt").fill("DELETE_SCHEDULE_MARKER");
  await page.getByTestId("automation-at").fill(new Date(Math.ceil((Date.now() + 3600000) / 60000) * 60000).toISOString().slice(0, 19).replace(/:00$/, ""));
  await page.getByTestId("automation-confirm").check();
  await page.getByTestId("automation-create").click();
  const job = page.getByTestId("automation-job");
  await job.waitFor();
  await job.getByRole("button", { name: "删除", exact: true }).click();
  await job.getByRole("button", { name: "删除", exact: true }).last().click();
  await job.waitFor({ state: "detached" });
  let dueAt = Date.now() + 8000;
  await page.getByTestId("automation-prompt").fill("IDLE_GATED_SCHEDULE_MARKER");
  await page.getByTestId("automation-at").fill(new Date(dueAt).toISOString().slice(0, 19).replace(/:00$/, ""));
  await page.getByTestId("automation-confirm").check();
  await page.getByTestId("automation-create").click();
  await page.getByTestId("automation-job").waitFor();
  dueAt = await jobDueAt('IDLE_GATED_SCHEDULE_MARKER');
  await page.getByTestId('desktop-sidebar').locator('[data-testid^="runtime-local-task-row-"]').filter({ hasText: 'Schedule smoke conversation' }).first().click();
  modelOptions.textOnlyChunks = Array.from({ length: 60 }, () => 'FOREGROUND_HEARTBEAT ');
  modelOptions.textOnlyChunkDelayMs = 1000;
  await page.getByTestId("chat-message-input").click();
  await page.keyboard.insertText("SLOW_FOREGROUND_MARKER");
  await page.getByTestId("send-message-button").click();
  await waitFor(() => model.requests.some(request => JSON.stringify(request.messages).includes("SLOW_FOREGROUND_MARKER")),
    5000, "foreground started", 100, context.abortSignal);
  await page.evaluate(ms => new Promise(resolve => setTimeout(resolve, ms)), Math.max(0, dueAt + 500 - Date.now()));
  assert.equal(model.requests.some(request => JSON.stringify(request.messages).includes("IDLE_GATED_SCHEDULE_MARKER")), false,
    "scheduled execution must wait while a foreground turn is active");
  modelOptions.textOnlyChunkDelayMs = 0;
  modelOptions.textOnlyChunks = ['SCHEDULE_RESPONSE_DONE'];
  await waitFor(() => model.requests.some(request => JSON.stringify(request.messages).includes("IDLE_GATED_SCHEDULE_MARKER")),
    25000, "idle-gated scheduled request", 100, context.abortSignal);
  await waitFor(() => automaticRuns.size === 2 && [...automaticRuns.keys()].every(id => completed.some(event => event.threadId === id && event.turn?.status === 'completed')),
    10000, "second scheduled completion", 100, context.abortSignal);
  const secondAutomaticThread = [...automaticRuns.keys()].find(id => id !== firstAutomaticThread);
  assert.notEqual(secondAutomaticThread, originalThread);
  const secondRequest = model.requests.find(request => JSON.stringify(request.messages).includes('IDLE_GATED_SCHEDULE_MARKER'));
  assert.ok(!JSON.stringify(secondRequest.messages).includes('ORIGINAL_HISTORY_MUST_NOT_LEAK'));
  assert.ok(!JSON.stringify(secondRequest.messages).includes('AUTOMATION_JOB_MARKER'));
  await page.getByTestId("automations-button").click();
  await page.getByTestId("scheduled-tasks-panel").waitFor();
  await page.screenshot({ path: context.pathInArtifacts("scheduled-tasks.png") });
  await context.writeArtifactJson("checks.json", { lateAcknowledgementSettled: true, consent: true, persistence: true,
    scheduledRequest: true, scheduledCompletion: true, deletion: true, idleGating: true, distinctNewSessions: true, noInheritedConversation: true });
  return { passed: true };
});
