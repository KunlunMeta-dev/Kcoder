import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startToolsCatalogModelFixture, toolsCatalogMcpServer } from '../../harness/tools-catalog-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await assertRendererBuildFresh();
const modelResetOnly = process.env.KCODER_E2E_MODEL_RESET_ONLY === '1';
const thinkingSpinnerOnly = process.env.KCODER_E2E_THINKING_SPINNER_ONLY === '1';
const partialListOnly = process.env.KCODER_E2E_PARTIAL_LIST_ONLY === '1';
assert.ok([modelResetOnly, thinkingSpinnerOnly, partialListOnly].filter(Boolean).length <= 1, 'select one focused Tauri verification mode');
if (partialListOnly && !process.env.KCODER_E2E_KCODER_BIN) throw new Error('UNMET_PREREQUISITE: partial-list mode requires an explicit current KCODER_E2E_KCODER_BIN');
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('UNMET_PREREQUISITE: KCODER_E2E_TAURI_BIN must name the current debug Tauri binary');

await runE2E(import.meta.url, {
  testId: partialListOnly ? 'tauri-partial-thread-list-retention-and-recovery' : 'tauri-provider-save-apply-and-session-tool-catalog', tier: 'manual-live',
  modelPolicy: 'model-independent real Tauri/Gateway/KCoder settings, recovery, streaming UI and tool protocol; bounded loopback fixtures, no model-quality assertion',
}, async context => {
  let releaseReasoning = false;
  const model = thinkingSpinnerOnly ? await startApprovalModelFixture(context, {
    // Gate real protocol deltas to inspect UI motion; this does not test model reasoning quality.
    responseSteps: ({ body }) => JSON.stringify(body.messages).includes('SPINNER_UI_CHECK')
      ? [
        { delta: { role: 'assistant', reasoning_content: 'Inspecting the fixture.' } },
        { ready: () => releaseReasoning, delta: { content: 'SPINNER_UI_DONE' } },
        { finishReason: 'stop' },
      ]
      : [{ delta: { content: 'OK' } }, { finishReason: 'stop' }],
  }) : partialListOnly
    ? await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'PARTIAL_LIST_FIXTURE_COMPLETE' })
    : await startToolsCatalogModelFixture(context);
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT || resolve(appRoot, 'renderer/dist'),
  });
  const selector = id => `[data-testid="${id}"]`;
  const command = (action, id, args = {}) => client.command(action, { selector: selector(id), ...args });
  const value = id => command('getValue', id);
  const count = css => client.command('getElementCount', { selector: css }).then(Number);
  const snapshotSettings = async () => createHash('sha256').update(await readFile(client.settingsPath)).digest('hex');
  let failure;
  let catalogObservation = null;
  try {
    await command('waitFor', 'desktop-sidebar', { visible: true, timeoutMs: 15_000 });
    await context.writeArtifactJson('tauri-initial-snapshot.json', JSON.parse(await client.command('snapshot')));
    await client.command('navigate', { value: '/settings/personal/models' });
    await command('waitFor', 'provider-form', { visible: true, timeoutMs: 15_000 });
    await command('waitFor', 'provider-save', { enabled: true, timeoutMs: 15_000 });
    const initial = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    assert.deepEqual(initial.providers, {}, 'the verifier must not inherit personal/default providers');
    // Only this run's synthetic settings are changed; apply reloads the fixture server.
    if (!modelResetOnly && !thinkingSpinnerOnly && !partialListOnly) initial.mcp_servers = [toolsCatalogMcpServer()];
    await writeFile(client.settingsPath, JSON.stringify(initial), { mode: 0o600 });
    const beforeTemplate = await snapshotSettings();
    await client.command('waitFor', { selector: `${selector('provider-template')} option[value="local-openai"]:not(:disabled)`, timeoutMs: 15_000 });
    await command('fill', 'provider-template', { value: 'local-openai' });
    assert.equal(await value('provider-model'), '');
    assert.equal(await value('provider-endpoint'), 'http://127.0.0.1:8000/v1');
    assert.equal(await count(`${selector('provider-apiKey')}:disabled`), 1);
    assert.equal(await snapshotSettings(), beforeTemplate, 'template selection is not a save');
    await command('fill', 'provider-endpoint', { value: model.baseUrl });
    const requestCountBeforeEmptyModel = model.requests.length;
    await command('click', 'provider-save');
    assert.equal(await count(`${selector('provider-model')}:invalid`), 1);
    assert.equal(model.requests.length, requestCountBeforeEmptyModel);
    assert.equal(await snapshotSettings(), beforeTemplate);
    await command('fill', 'provider-model', { value: 'catalog-fixture' });
    await command('fill', 'provider-contextWindowTokens', { value: '512000' });
    assert.equal(await count(`${selector('provider-capability-tools')}:checked`), 0, 'unknown template models start with conservative tool capability');
    await command('click', 'provider-capability-tools');
    assert.equal(await count(`${selector('provider-capability-tools')}:checked`), 1);
    if (await count(`${selector('provider-default')}:checked`) === 0) await command('click', 'provider-default');
    await command('click', 'provider-save');
    await waitFor(async () => {
      if (await count('[role="alert"]')) throw new Error(await client.command('getText', { selector: '[role="alert"]' }));
      return (await client.command('getText', { selector: '[data-testid^="provider-edit-local-openai"]' })).includes('catalog-fixture');
    }, 20_000, 'Tauri provider validated save', 100, context.abortSignal);
    assert.ok(model.requests.some(request => request.model === 'catalog-fixture'), 'validation must reach the real loopback HTTP fixture');
    const saved = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    assert.equal(saved.providers['local-openai'].default_model, 'catalog-fixture');
    assert.equal(saved.providers['local-openai'].authentication.mode, 'none');
    assert.equal(saved.providers['local-openai'].capabilities.tools, true);
    await command('waitFor', 'provider-session-reload', { visible: true, timeoutMs: 15_000 });
    assert.equal(await count(selector('provider-apply')), 0);
    await waitFor(async () => {
      if (await count('[role="alert"]')) throw new Error(await client.command('getText', { selector: '[role="alert"]' }));
      return await count(selector('provider-pending-apply')) === 0;
    }, 20_000, 'Tauri provider saved for new sessions', 100, context.abortSignal);
    assert.equal(await count('[data-testid^="provider-edit-local-openai"]'), 1);
    await client.command('click', { selector: '[data-testid^="provider-edit-local-openai"]' });
    assert.equal(await value('provider-model'), 'catalog-fixture');
    assert.equal(await value('provider-endpoint'), model.baseUrl);
    assert.equal(await value('provider-apiKey'), '');
    await context.writeArtifactJson('tauri-provider-result.json', {
      templateInert: true, emptyModelRejectedBeforeRequest: true, validationRequestedModel: 'catalog-fixture',
      savedAuthentication: saved.providers['local-openai'].authentication.mode, savedForNewSessionsAndReadBack: true,
      toolsCapabilityExplicitlyEnabled: true,
    });
    await client.capture('tauri-provider-applied.png');

    await client.command('navigate', { value: '/' });
    if (partialListOnly) return await verifyPartialThreadList(context, client, model);
    await command('waitFor', 'project-new-conversation-button', { timeoutMs: 15_000 });
    await command('click', 'project-new-conversation-button');
    await command('waitFor', 'chat-message-input', { visible: true, timeoutMs: 15_000 });
    await command('waitFor', 'model-selector-button', { enabled: true, timeoutMs: 15_000 });
    const defaultModelLabel = await command('getText', 'model-selector-button');
    await command('click', 'model-selector-button');
    await command('waitFor', 'model-reset-default-button', { enabled: true, timeoutMs: 10_000 });
    await command('click', 'model-reset-default-button');
    assert.equal(await command('getText', 'model-selector-button'), defaultModelLabel);
    await client.capture('tauri-runtime-model-default-reset.png');
    await command('click', 'model-selector-button');
    if (thinkingSpinnerOnly) {
      await command('fill', 'chat-message-input', { value: 'SPINNER_UI_CHECK' });
      await command('waitFor', 'send-message-button', { enabled: true, timeoutMs: 15_000 });
      await command('click', 'send-message-button');
      const spinner = 'assistant-thinking-spinner';
      const toggle = selector('assistant-thinking-toggle');
      await command('waitFor', spinner, { visible: true, timeoutMs: 20_000 });
      assert.equal(await count(`${toggle}[aria-expanded="false"][aria-busy="true"]`), 1);
      assert.match(await command('getStyle', spinner, { value: 'animation-name' }), /spin/);
      const transform = await command('getStyle', spinner, { value: 'transform' });
      await waitFor(async () => await command('getStyle', spinner, { value: 'transform' }) !== transform,
        3000, 'actual Tauri spinner rotation', 80, context.abortSignal);
      await client.capture('tauri-thinking-collapsed-spinner.png');
      await command('click', 'assistant-thinking-toggle');
      await command('waitFor', 'assistant-thinking-content', { text: 'Inspecting the fixture.', visible: true });
      assert.equal(await count(`${toggle}[aria-expanded="true"][aria-busy="true"]`), 1);
      assert.equal(await count(selector(spinner)), 1);
      releaseReasoning = true;
      await command('waitFor', 'message-assistant', { text: 'SPINNER_UI_DONE', timeoutMs: 20_000 });
      await waitFor(async () => await count(selector(spinner)) === 0, 5000, 'finished reasoning removes spinner', 100, context.abortSignal);
      assert.ok(model.requests.length <= 4);
      return { realTauri: true, collapsedSpinnerRotates: true, expandedContentReadable: true,
        completionRemovesSpinner: true, scope: 'model-independent thinking header state and real CSS animation',
        successScreenshotReason: 'collapsed reasoning activity remains visible in real Tauri' };
    }
    if (modelResetOnly) {
      return { realTauri: true, configuredNonGptModelResetEnabled: true, resetPreservesRuntimeDefault: true,
        scope: 'provider save/apply/readback and model reset only; no tool or model-quality assertions',
        successScreenshotReason: 'critical reset action in real Tauri with a runtime-provided non-GPT model' };
    }
    await command('fill', 'chat-message-input', { value: 'Verify the configured tool catalog.' });
    await command('waitFor', 'send-message-button', { enabled: true, timeoutMs: 15_000 });
    await command('click', 'send-message-button');
    await command('waitFor', 'request-user-input-card', { text: 'TaskList', timeoutMs: 20_000 });
    assert.match(await command('getText', 'request-user-input-card'), /Tool:\s*TaskList\s*\{\}/);
    const allowOnce = `${selector('request-user-input-card')} [data-testid^="request-user-input-option-approval-"][data-testid$="-0"]`;
    assert.match(await client.command('getText', { selector: allowOnce }), /Allow once/);
    await client.capture('tauri-tasklist-approval.png');
    await client.command('click', { selector: allowOnce });
    await command('waitFor', 'message-assistant', { text: 'CATALOG_UI_DONE', timeoutMs: 45_000 });
    const active = JSON.parse(await client.command('getActiveToolsCatalog'));
    catalogObservation = active;
    assert.equal(active.catalog.scope, 'thread');
    assert.equal(active.catalog.cachePolicy, 'no-store');
    assert.ok(active.catalog.threadId);
    if (active.threadId) assert.equal(active.catalog.threadId, active.threadId);
    const tool = active.catalog.tools.find(entry => entry.name === 'TaskList');
    assert.equal(active.catalog.truncated, true);
    assert.equal(active.catalog.tools.length, 512);
    assert.ok(active.catalog.total >= 520);
    await command('waitFor', 'tools-catalog-truncation', { visible: true, timeoutMs: 15_000 });
    const notice = await command('getText', 'tools-catalog-truncation');
    assert.ok(notice.includes('512') && notice.includes(String(active.catalog.total)));
    assert.ok(tool, 'the active resident session must publish TaskList metadata');
    const finalToggle = selector('final-processing-toggle');
    await command('waitFor', 'final-processing-toggle', { timeoutMs: 15_000 });
    if (await count(`${finalToggle}[aria-expanded="true"]`) === 0) await command('click', 'final-processing-toggle');
    const summaryToggle = selector('processing-summary-toggle');
    if (await count(summaryToggle) && await count(`${summaryToggle}[aria-expanded="true"]`) === 0) await command('click', 'processing-summary-toggle');
    const finalMessage = `${selector('message-assistant')}:has(${finalToggle})`;
    assert.equal(await count(finalMessage), 1);
    const row = `${finalMessage} [data-processing-block-id]:has([data-tool-group="${tool.group}"])`;
    await client.command('waitFor', { selector: row, text: tool.displayName, timeoutMs: 15_000 });
    const icons = { tool: 'wrench', file: 'file', search: 'search', terminal: 'terminal', agent: 'bot', globe: 'globe', checklist: 'list-checks' };
    assert.ok(await count(`${row} svg.lucide-${icons[tool.icon]}`) > 0, 'the catalog icon must match the rendered tool icon');
    await command('click', 'final-processing-toggle');
    await client.command('waitFor', { selector: `${finalToggle}[aria-expanded="false"]`, timeoutMs: 5_000 });
    await waitFor(async () => await count(row) === 0, 5_000, 'collapsed final tools are unmounted', 100, context.abortSignal);
    await command('click', 'final-processing-toggle');
    await client.command('waitFor', { selector: row, text: tool.displayName, timeoutMs: 15_000 });
    assert.ok(model.requests.some(request => request.messages?.some(message => message.role === 'tool')), 'real TaskList results must return to the fixture');
    const taskListResults = model.requests.flatMap(request => request.messages ?? []).filter(message => message.role === 'tool' && message.tool_call_id === 'catalog-tool-1');
    assert.ok(taskListResults.some(message => {
      try { return Array.isArray(JSON.parse(message.content).tasks); } catch { return false; }
    }), 'the TaskList result must be a successful tasks payload, not a permission error');
    for (const request of model.requests) for (const definition of request.tools ?? []) {
      const shape = definition.function ?? definition;
      for (const field of ['displayName', 'group', 'icon']) assert.equal(Object.hasOwn(shape, field), false);
    }
    assert.ok(model.requests.length <= 6, 'the protocol fixture has a bounded request budget');
    await context.writeArtifactJson('tauri-tools-result.json', {
      taskId: active.taskId, threadId: active.catalog.threadId, scope: active.catalog.scope, cachePolicy: active.catalog.cachePolicy,
      tool: { name: tool.name, displayName: tool.displayName, group: tool.group, icon: tool.icon },
      realToolResultReceived: true, modelSchemaUnchanged: true, finalSummaryRoundTrip: true,
      taskListAllowedOnce: true, successfulTaskListPayload: true,
      requestCount: model.requests.length,
      catalogTruncationVisible: true, catalogTotal: active.catalog.total, catalogShown: active.catalog.tools.length,
    });
    await client.command('scrollIntoView', { selector: row });
    await client.capture('tauri-tools-catalog.png');
    return { realTauri: true, providerValidatedSavedAppliedReadBack: true, residentCatalogMatchesToolRendering: true,
      successScreenshotReason: 'critical real Tauri Provider and session tool metadata paths' };
  } catch (error) {
    failure = error;
    client.markFailed();
    await context.writeArtifactJson('tauri-business-failure.json', {
      error: String(error),
      approvalText: await command('getText', 'request-user-input-card').catch(() => ''),
      workbench: await client.command('getWorkbenchDebugSnapshot').then(value => JSON.parse(value)).catch(() => null),
      catalog: catalogObservation && { taskId: catalogObservation.taskId, scope: catalogObservation.catalog?.scope, tools: catalogObservation.catalog?.tools?.map(tool => ({ name: tool.name, displayName: tool.displayName, group: tool.group, icon: tool.icon })) },
      snapshot: await client.command('snapshot').then(value => JSON.parse(value)).catch(() => null),
      requests: model.requests.map(request => ({ model: request.model, roles: request.messages?.map(message => message.role), hasTaskList: request.tools?.some(tool => (tool.function ?? tool).name === 'TaskList') })),
    });
    await client.capture('tauri-business-failed.png').catch(() => {});
    throw error;
  } finally {
    const stopped = await client.stop();
    await context.writeArtifactJson('tauri-finalization.json', stopped);
    if (!failure) assert.equal(stopped.verificationFailed, false);
  }
});

async function verifyPartialThreadList(context, client, model) {
  const selector = id => `[data-testid="${id}"]`;
  const command = (action, id, args = {}) => client.command(action, { selector: selector(id), ...args });
  const count = css => client.command('getElementCount', { selector: css }).then(Number);
  const debug = async () => JSON.parse(await client.command('getWorkbenchDebugSnapshot'));
  const tasks = [];
  const beforeTurns = model.requests.length;
  for (const label of ['A', 'B']) {
    await command('waitFor', 'project-new-conversation-button', { enabled: true, timeoutMs: 15_000 });
    await command('click', 'project-new-conversation-button');
    await command('waitFor', 'chat-message-input', { visible: true, timeoutMs: 15_000 });
    await command('fill', 'chat-message-input', { value: `Partial Tauri ${label}` });
    await command('waitFor', 'send-message-button', { enabled: true, timeoutMs: 15_000 });
    await command('click', 'send-message-button');
    await command('waitFor', 'message-assistant', { text: 'PARTIAL_LIST_FIXTURE_COMPLETE', timeoutMs: 30_000 });
    const address = await waitFor(async () => {
      const snapshot = await debug();
      const current = snapshot.workbench?.currentRuntimeTask;
      return current?.threadId && !tasks.some(task => task.taskId === current.taskId)
        && snapshot.workbench?.runningState?.activeTaskRunning === false ? current : null;
    }, 15_000, `Tauri fixture ${label} completed`, 100, context.abortSignal);
    tasks.push(address);
  }
  const row = address => `runtime-local-task-row-${address.taskId}`;
  for (const address of tasks) await command('waitFor', row(address), { visible: true, timeoutMs: 15_000 });
  assert.equal(model.requests.length - beforeTurns, 2, 'only two model-independent seed turns are allowed');
  const metadata = await findFixtureMetadata(dirname(client.settingsPath), tasks[1].threadId);
  assert.ok(metadata, 'B metadata must belong to the owned Tauri config tree');
  const original = await readFile(metadata);
  const renameA = async title => {
    await command('click', `runtime-local-task-menu-${tasks[0].taskId}`);
    await command('waitFor', `runtime-local-task-menu-rename-${tasks[0].taskId}`, { visible: true, timeoutMs: 5_000 });
    await command('click', `runtime-local-task-menu-rename-${tasks[0].taskId}`);
    await command('fill', `rename-runtime-local-task-input-${tasks[0].taskId}`, { value: title });
    await command('click', `confirm-rename-runtime-local-task-${tasks[0].taskId}`);
    await command('waitFor', row(tasks[0]), { text: title, visible: true, timeoutMs: 15_000 });
  };
  await context.writeArtifactJson('tauri-partial-baseline.json', { tasks, snapshot: await debug() });
  try {
    // Fault injection touches only B's metadata inside this run's owned config directory.
    await writeFile(metadata, '{broken');
    for (let index = 0; index < 2; index += 1) {
      await renameA(`Partial Tauri A ${index}`);
      await command('waitFor', 'runtime-thread-list-incomplete', { visible: true, timeoutMs: 15_000 });
      await command('waitFor', row(tasks[1]), { visible: true, timeoutMs: 5_000 });
    }
    const notice = await command('getText', 'runtime-thread-list-incomplete');
    assert.match(notice, /1/);
    await context.writeArtifactJson('tauri-partial-observed.json', { notice, retainedTaskId: tasks[1].taskId, snapshot: await debug() });
    await client.capture('tauri-partial-retains-b.png');
  } finally {
    await writeFile(metadata, original);
  }
  await renameA('Recovered Tauri A');
  await waitFor(async () => await count(selector('runtime-thread-list-incomplete')) === 0,
    15_000, 'Tauri complete-list recovery removes partial notice', 100, context.abortSignal);
  for (const address of tasks) await command('waitFor', row(address), { visible: true, timeoutMs: 5_000 });
  await context.writeArtifactJson('tauri-partial-recovered.json', { tasks, snapshot: await debug() });
  await client.capture('tauri-partial-recovered.png');
  return { realTauri: true, partialMetadataVisible: true, repeatedPartialRetainedB: true,
    repairedMetadataRecovered: true, modelTurns: 2, providerRequests: model.requests.length,
    successScreenshotReason: 'critical real Tauri partial notice, retained B, and recovery; complete deletion already covered by browser suite' };
}

async function findFixtureMetadata(root, threadId) {
  const directories = [root];
  for (let index = 0; index < directories.length; index += 1) {
    assert.ok(directories.length < 200, 'owned metadata lookup must remain bounded');
    const directory = directories[index];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && entry.name === 'thread-metadata.json' && basename(directory) === threadId) return path;
    }
  }
  return null;
}
