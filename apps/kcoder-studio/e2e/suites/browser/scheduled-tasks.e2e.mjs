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
  testId: "scheduled-tasks-form-timezone-and-delivery",
  tier: "full-integration",
  modelPolicy: "model-independent schedule persistence, idle delivery, native RPC and UI lifecycle",
  retainSuccessLogs: true,
}, async context => {
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
    command: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, startTimeoutMs: 300_000,
    env: { KCODER_CONFIG_DIR: profile, TZ: "UTC" } });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Tokyo" });
  let creationReplyDropped = false;
  let firstCreationTargeted = false;
  let creationRequests = 0;
  let workflowReplyDropped = false;
  let workflowSaveRequests = 0;
  // Drop one committed create reply, then recover through the real receipt API after reload.
  await page.routeWebSocket('**/*', route => {
    const upstream = route.connectToServer();
    let droppedRequestId;
    let workflowRequestId;
    route.onMessage(message => {
      try {
        const frame = JSON.parse(String(message));
        if (frame.method === 'integrations/automation/saveSubscription') {
          workflowSaveRequests++;
          workflowRequestId = frame.id;
        }
        if (frame.method === 'cron/create') {
          creationRequests++;
          if (!firstCreationTargeted) {
            firstCreationTargeted = true;
            droppedRequestId = frame.id;
          }
        }
      } catch { /* Forward non-JSON frames unchanged. */ }
      upstream.send(message);
    });
    upstream.onMessage(message => {
      try {
        const frame = JSON.parse(String(message));
        if (workflowRequestId !== undefined && frame.id === workflowRequestId
          && frame.result?.status === 'completed' && frame.result?.result?.subscription?.draft?.id && !workflowReplyDropped) {
          workflowReplyDropped = true;
          return;
        }
        if (droppedRequestId !== undefined && frame.id === droppedRequestId && frame.result?.job?.id && !creationReplyDropped) {
          creationReplyDropped = true;
          return;
        }
      } catch { /* Forward non-JSON frames unchanged. */ }
      route.send(message);
    });
  });
  const completed = [];
  const automaticRuns = new Map();
  const noSideEffectCounts = [];
  const cronWriteRpcObservations = [];
  const pendingCronWrites = new Map();
  const localDateTime = async timestamp => page.evaluate(value => {
    const date = new Date(value);
    date.setSeconds(0, 0);
    if (date.getTime() < value) date.setMinutes(date.getMinutes() + 1);
    const pad = part => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }, timestamp);
  const jobDueAt = async marker => {
    const stored = JSON.parse(await readFile(resolve(workspace, '.kcoder/cron/jobs.json'), 'utf8'));
    return Date.parse(stored.jobs.find(job => job.prompt === marker).next_run_at);
  };
  const readOnlyCronList = async () => page.evaluate(async workspacePath => {
    const result = await window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand("local_executor_request", {
      method: "runtime.automations.request",
      params: {
        address: { deviceId: "local", workspacePath },
        deviceId: "local",
        method: "cron/list",
        params: {},
      },
    });
    if (!Array.isArray(result?.jobs)) throw new Error("OWNED_CRON_LIST_RESPONSE_MISSING_JOBS");
    return result.jobs.map(job => ({ id: job.id, prompt: job.prompt, schedule: job.schedule }));
  }, workspace);
  const assertNoCronSideEffect = async label => {
    const jobs = await readOnlyCronList();
    noSideEffectCounts.push({ label, count: jobs.length });
    assert.equal(jobs.length, 0, `${label}: read-only cron/list remains empty`);
    return jobs;
  };
  page.on("websocket", socket => {
    socket.on("framesent", frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.method !== "runtime.automations.request" || !["cron/create", "cron/delete"].includes(message.params?.method)) return;
        const observation = {
          direction: "request",
          id: message.id,
          method: message.params.method,
          markerPresent: typeof message.params.params?.prompt === "string"
            && /(?:AUTOMATION_JOB_MARKER|DELETE_SCHEDULE_MARKER|IDLE_GATED_SCHEDULE_MARKER)/.test(message.params.params.prompt),
        };
        cronWriteRpcObservations.push(observation);
        pendingCronWrites.set(message.id, observation);
      } catch { /* Non-JSON frames do not affect this assertion. */ }
    });
    socket.on("framereceived", frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.method === "turn/completed") completed.push(message.params);
        if (message.method === 'automation/runStarted') automaticRuns.set(message.params.threadId, message.params);
        const pending = pendingCronWrites.get(message.id);
        if (pending) {
          cronWriteRpcObservations.push({
            direction: "response",
            id: message.id,
            method: pending.method,
            hasError: Boolean(message.error),
            errorCode: message.error?.code ?? null,
            errorMessage: typeof message.error?.message === "string" ? message.error.message.slice(0, 240) : null,
            resultKeys: message.result && typeof message.result === "object" ? Object.keys(message.result).sort() : [],
          });
          pendingCronWrites.delete(message.id);
        }
      } catch { /* Non-JSON frames do not affect this assertion. */ }
    });
  });
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login")), page.locator('button[type="submit"]').click()]);
  const project = page.getByTestId("project-item").filter({ hasText: "Schedules" }).first();
  await project.waitFor({ timeout: 60000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
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
  const automationPrompt = page.getByTestId("automation-prompt");
  const automationAt = page.getByTestId("automation-at");
  const automationConfirm = page.getByTestId("automation-confirm");
  const automationCreate = page.getByTestId("automation-create");
  const initialForm = {
    target: await page.getByTestId("automation-target").inputValue(),
    prompt: await automationPrompt.inputValue(),
    at: await automationAt.inputValue(),
    confirmed: await automationConfirm.isChecked(),
    createDisabled: await automationCreate.isDisabled(),
  };
  assert.notEqual(initialForm.target, "", "the owned local target is selected");
  assert.equal(initialForm.prompt, "");
  assert.equal(initialForm.at, "");
  assert.equal(initialForm.confirmed, false);
  assert.equal(initialForm.createDisabled, true, "the empty form cannot create a task");
  await assertNoCronSideEffect("initial empty form");

  // The required prompt uses native form validation; schedule and consent disable submit.
  await automationAt.fill(await localDateTime(Date.now() + 60_000));
  await automationConfirm.check();
  assert.equal(await automationCreate.isDisabled(), false, "schedule and consent enable the submit control");
  assert.equal(await automationPrompt.evaluate(input => input.validity.valueMissing), true);
  await automationCreate.click();
  assert.equal(await automationPrompt.evaluate(input => input.validity.valueMissing), true,
    "native required validation blocks a missing prompt");
  await assertNoCronSideEffect("missing prompt");

  await automationPrompt.fill("MISSING_AT_MUST_NOT_CREATE");
  await automationAt.fill("");
  assert.equal(await automationCreate.isDisabled(), true, "a missing one-shot time disables submit");
  await automationCreate.scrollIntoViewIfNeeded();
  const disabledCreateBounds = await automationCreate.boundingBox();
  assert.ok(disabledCreateBounds);
  await page.mouse.click(disabledCreateBounds.x + disabledCreateBounds.width / 2,
    disabledCreateBounds.y + disabledCreateBounds.height / 2);
  await assertNoCronSideEffect("missing time");

  await automationPrompt.fill("MISSING_CONFIRMATION_MUST_NOT_CREATE");
  await automationConfirm.uncheck();
  await automationAt.fill(await localDateTime(Date.now() + 60_000));
  assert.equal(await automationConfirm.isChecked(), false);
  assert.equal(await automationCreate.isDisabled(), true, "missing explicit confirmation disables submit");
  await automationCreate.scrollIntoViewIfNeeded();
  const unconfirmedCreateBounds = await automationCreate.boundingBox();
  assert.ok(unconfirmedCreateBounds);
  await page.mouse.click(unconfirmedCreateBounds.x + unconfirmedCreateBounds.width / 2,
    unconfirmedCreateBounds.y + unconfirmedCreateBounds.height / 2);
  await assertNoCronSideEffect("missing confirmation");

  // Verify the displayed system zone and next-run preview against a UTC target.
  await page.getByTestId("automation-kind").click();
  await page.getByTestId("automation-kind-daily").click();
  await page.getByTestId("automation-time-of-day").fill("23:59");
  await page.getByTestId("scheduled-tasks-panel").getByText("Asia/Tokyo", { exact: true }).waitFor();
  const preview = page.getByTestId("automation-preview");
  await waitFor(async () => {
    const text = await preview.innerText();
    return text.includes("下一次计划时间：") && /\d{4}/.test(text);
  }, 15000, "Tokyo local next-run preview", 100, context.abortSignal);
  const previewText = await preview.innerText();
  assert.match(previewText, /下一次计划时间：.+（不含调度偏移）/);
  const timezoneDomText = await page.getByTestId("scheduled-tasks-panel").getByText("Asia/Tokyo", { exact: true }).innerText();
  const scheduleDescription = await page.getByTestId("automation-schedule-description").innerText();
  assert.match(scheduleDescription, /Asia\/Tokyo/);
  await assertNoCronSideEffect("daily preview");
  await context.writeArtifactJson("b16-b17-form-timezone-evidence.json", {
    initialForm,
    requiredFieldCases: [
      { missing: "prompt", scheduleAndConsentPresent: true, submitEnabled: true,
        nativePromptValidityMissing: true, validityRemainsMissingAfterSubmit: true },
      { missing: "one-shot time", promptPresent: true, submitDisabled: true, physicalClickAttempted: true },
      { missing: "explicit confirmation", promptAndTimePresent: true, confirmed: false,
        submitDisabled: true, physicalClickAttempted: true },
    ],
    readOnlyCronListCounts: noSideEffectCounts,
    timezone: { browser: "Asia/Tokyo", gateway: "UTC", displayedSystemZone: timezoneDomText },
    nextRunPreview: { preset: "daily", localTime: "23:59", text: previewText,
      scheduleDescription, containsNextRunLabel: true, excludesSchedulerOffset: true },
    scope: "Assertions passed on the current rendered ScheduledTasksPanel before later suite flow.",
  });

  await page.getByTestId("automation-kind").click();
  await page.getByTestId("automation-kind-at").click();
  await page.getByTestId("automation-prompt").fill("AUTOMATION_JOB_MARKER");
  await automationAt.fill(await localDateTime(Date.now() + 30000));
  assert.equal(await automationCreate.isDisabled(), true);
  await automationConfirm.check();
  await page.getByTestId("automation-create").click();
  await waitFor(() => creationReplyDropped, 10000, 'committed creation reply dropped', 50, context.abortSignal);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(/原操作结果尚未确认/).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '核对任务与运行记录' }).click();
  await page.getByTestId("automation-job").filter({ hasText: "AUTOMATION_JOB_MARKER" }).waitFor({ timeout: 10000 });
  assert.equal(creationRequests, 1, 'receipt recovery must never reissue cron/create');
  assert.equal(await page.getByText(/原操作结果尚未确认/).count(), 0);
  const firstDueAt = await jobDueAt('AUTOMATION_JOB_MARKER');
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("scheduled-tasks-panel").waitFor({ timeout: 30000 });
  await page.getByTestId("automation-tab-history").click();
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
  // A completed background run is useful only if its new conversation is discoverable.
  // Do not reload or manually refresh: the lifecycle notification must update the sidebar.
  const automaticRow = page.getByTestId('desktop-sidebar').locator('[data-testid^="runtime-local-task-row-"]').filter({ hasText: 'AUTOMATION_JOB_MARKER' }).first();
  await automaticRow.waitFor({ timeout: 15000 });
  await automaticRow.click();
  await page.getByTestId('message-user').filter({ hasText: 'AUTOMATION_JOB_MARKER' }).waitFor({ timeout: 15000 });
  await page.getByTestId('message-assistant').filter({ hasText: 'SCHEDULE_RESPONSE_DONE' }).waitFor({ timeout: 15000 });
  await page.screenshot({ path: context.pathInArtifacts('scheduled-conversation-visible.png') });
  await page.getByTestId('automations-button').click();
  await page.getByTestId('scheduled-tasks-panel').waitFor();
  await page.getByTestId('automation-tab-history').click();
  await page.getByTestId("automation-runs-refresh").click();
  await page.getByTestId("automation-job").waitFor({ state: "detached", timeout: 10000 });
  await page.getByTestId("automation-tab-settings").click();
  await page.getByTestId("automation-prompt").fill("DELETE_SCHEDULE_MARKER");
  await page.getByTestId("automation-at").fill(await localDateTime(Math.ceil((Date.now() + 3600000) / 60000) * 60000));
  await page.getByTestId("automation-confirm").check();
  assert.equal(await page.getByTestId("automation-create").isDisabled(), false,
    "the fully populated delete-test schedule must be submittable");
  await page.getByTestId("automation-create").click();
  const deleteJob = page.getByTestId("automation-job").filter({ hasText: "DELETE_SCHEDULE_MARKER" });
  try {
    await deleteJob.waitFor();
  } catch (failure) {
    const dom = await page.evaluate(() => {
      const value = testId => document.querySelector(`[data-testid="${testId}"]`)?.value ?? null;
      return {
        alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(element => element.textContent?.trim() ?? ""),
        target: value("automation-target"),
        prompt: value("automation-prompt"),
        at: value("automation-at"),
        confirmed: document.querySelector('[data-testid="automation-confirm"]')?.checked ?? null,
        createDisabled: document.querySelector('[data-testid="automation-create"]')?.disabled ?? null,
        selectedTab: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.testid ?? null,
      };
    });
    const cronJobs = await readOnlyCronList().catch(error => ({ error: String(error).slice(0, 240) }));
    await context.writeArtifactJson("delete-schedule-create-failure.json", {
      failure: String(failure).slice(0, 1000),
      dom,
      readOnlyCronJobs: cronJobs,
      cronWriteRpcObservations,
      pendingCronWriteRequestIds: [...pendingCronWrites.keys()],
    });
    throw failure;
  }
  await deleteJob.getByRole("button", { name: "删除", exact: true }).click();
  await deleteJob.getByRole("button", { name: "删除", exact: true }).last().click();
  await deleteJob.waitFor({ state: "detached" });
  let dueAt = Date.now() + 8000;
  await page.getByTestId("automation-tab-settings").click();
  await page.getByTestId("automation-prompt").fill("IDLE_GATED_SCHEDULE_MARKER");
  await page.getByTestId("automation-at").fill(await localDateTime(dueAt));
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
    10000, "foreground started", 100, context.abortSignal).catch(async error => {
      await page.screenshot({ path: context.pathInArtifacts('foreground-failure.png') });
      await context.writeArtifactJson('foreground-failure.json', {
        text: await page.locator('body').innerText(),
        requestCount: model.requests.length,
      });
      throw error;
    });
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
  // The workflow kind uses Automation subscriptions, not Cron or P-RUNTIME receipts.
  const workflow = await page.evaluate(async workspacePath => {
    const request = (method, params) => window.__KCODER_STUDIO_E2E__.invokeRuntimeCommand('local_executor_request', {
      method: 'runtime.workflows.request', params: { serverId: 'local', workspacePath, method, params },
    });
    let draft = await request('workflow/create', { title: 'Owned workflow receipt recovery' });
    draft = await request('workflow/upsertNode', { id: draft.id, expectedRevision: draft.revision,
      node: { id: 'result', title: 'Future-only Code', kind: 'code', config: { code: { source: 'return {owned:true};', timeoutMs: 100 } } } });
    return request('workflow/save', { id: draft.id, expectedRevision: draft.revision });
  }, workspace);
  assert.equal(workflow.savedVersion, 1);
  const requestsBeforeWorkflow = model.requests.length;
  await page.getByTestId('automation-tab-settings').click();
  await page.getByTestId('scheduled-task-kind').selectOption('workflow');
  const workflowChoice = JSON.stringify([workflow.id, 1]);
  await page.getByTestId('scheduled-workflow-choice').locator(`option[value='${workflowChoice}']`).waitFor({ state: 'attached' });
  await page.getByTestId('scheduled-workflow-choice').selectOption(workflowChoice);
  await page.getByTestId('automation-at').fill('2099-01-01T09:00');
  await page.getByTestId('automation-confirm').check();
  await page.getByTestId('automation-create').click();
  await waitFor(() => workflowReplyDropped, 20000, 'committed workflow subscription reply dropped', 50, context.abortSignal);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(/原操作结果尚未确认/).waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('automation-create').isDisabled(), true);
  await page.getByRole('button', { name: '核对任务与运行记录' }).click();
  const workflowRow = page.getByTestId('subscription-row').filter({ hasText: 'Owned workflow receipt recovery' });
  await workflowRow.waitFor({ timeout: 15000 });
  assert.equal(await page.getByText(/原操作结果尚未确认/).count(), 0);
  assert.equal(workflowSaveRequests, 1, 'workflow recovery must not resend saveSubscription');
  assert.equal(model.requests.length, requestsBeforeWorkflow, 'future subscription recovery cannot invoke a model');
  await workflowRow.getByTestId('subscription-remove-open').click();
  await page.getByTestId('subscription-remove-dialog-confirm').click();
  await workflowRow.waitFor({ state: 'detached' });
  await page.screenshot({ path: context.pathInArtifacts("scheduled-tasks.png") });
  await context.writeArtifactJson("checks.json", { lateAcknowledgementFaultInjected: true, creationReplyDropped,
    recoveredWithoutRecreation: true, workflowReplyDropped, workflowRecoveredWithoutRecreation: true, workflowSaveRequests, consent: true, persistence: true,
    requiredFormValidation: true, noSideEffectCounts: [0, 0, 0, 0, 0], timezoneDom: "Asia/Tokyo",
    nextRunPreview: previewText, scheduledRequest: true, scheduledCompletion: true, deletion: true,
    idleGating: true, distinctNewSessions: true, noInheritedConversation: true });
  return { passed: true };
});
