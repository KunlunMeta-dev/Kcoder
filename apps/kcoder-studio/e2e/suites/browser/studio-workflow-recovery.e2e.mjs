import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// QA: image-only first/follow-up input, failed creation recovery, goal deletion,
// and settings unarchive must round-trip through the real Gateway and app-server.
// The fixture tests transport/state, not image recognition or model judgment.
await runE2E(import.meta.url, {
  testId: 'studio-image-goal-archive-recovery', tier: 'full-integration',
  modelPolicy: 'model-independent HTTP/SSE input and lifecycle verification', retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'workflow-recovery' });
  const projectPath = resolve(workspace, 'project');
  const profile = context.pathInState('profile');
  await mkdir(projectPath); await mkdir(profile);
  let initialGoalToolSeen = false;
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    if (JSON.stringify(body.messages).includes('INITIAL_GOAL_PROTOCOL') && !body.messages.some(message => message.role === 'tool')) {
      assert.ok(body.tools.some(tool => tool.function?.name === 'update_goal'), 'Initial goal must expose its update tool in the first model request');
      initialGoalToolSeen = true;
      return [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'complete-fixture-goal', type: 'function', function: {
        name: 'update_goal', arguments: JSON.stringify({ status: 'complete' }),
      } }] } }, { finishReason: 'tool_calls' }];
    }
    return [{ delta: { role: 'assistant', content: 'WORKFLOW_REPLY' } }, { finishReason: 'stop' }];
  } });
  const settingsFile = await context.writeStateJson('profile/settings.json', { active_provider: 'fixture', providers: {
    fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl, default_model: 'fixture',
      context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 8192, no_proxy: true, max_retries: 0 },
  } });
  await context.writeStateJson('profile/credentials.json', { fixture: { type: 'api', key: 'synthetic-workflow-fixture' } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Workflow host', transport: 'local',
    command: resolve(repoRoot, 'target/debug/kcoder'), workspace, settingsFile }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  let stage = 'login';
  const wire = [];
  const errors = [];
  page.on('pageerror', error => errors.push({ stage, message: error.message }));
  page.on('response', response => { if (response.status() >= 400) errors.push({ stage, status: response.status(), path: new URL(response.url()).pathname }); });
  let socketId = 0;
  page.on('websocket', socket => {
    const id = ++socketId;
    const record = (direction, event) => {
      try {
        const frame = JSON.parse(String(event.payload));
        wire.push({ at: Date.now(), stage, socket: id, direction, id: frame.id, method: frame.method,
          errorCode: frame.error?.code, resultKeys: frame.result ? Object.keys(frame.result) : undefined });
        if (wire.length > 500) wire.shift();
      } catch {}
    };
    socket.on('framesent', event => record('sent', event));
    socket.on('framereceived', event => record('received', event));
  });
  let moved = false;
  const rpc = (method, params = {}) => page.evaluate(({ method, params }) => window.__TAURI_INTERNALS__.invoke('local_executor_request', { method, params }), { method, params });
  const project = () => page.getByTestId('project-item').filter({ hasText: 'Workflow project' }).first();
  const expand = async () => { const toggle = project().getByTestId('project-item-button'); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click(); };
  const settle = async count => {
    await page.waitForFunction(count => [...document.querySelectorAll('[data-testid="message-assistant"]')].filter(node => node.textContent.includes('WORKFLOW_REPLY')).length === count && !document.querySelector('[data-testid="pause-response-button"]'), count, { timeout: 45000 });
  };
  const input = async text => {
    const editor = page.getByTestId('chat-message-input');
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-message-input"]')?.getAttribute('contenteditable') === 'true');
    await editor.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(text);
    assert.equal((await editor.innerText()).trim(), text, 'Typed draft must remain in the composer');
  };
  const attach = async () => {
    await page.getByTestId('add-context-button').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('attach-files-button').click();
    await (await chooser).setFiles({ name: 'only-image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH5sAAAAASUVORK5CYII=', 'base64') });
    await page.getByTestId('attachment-badge').first().waitFor({ timeout: 30000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="uploading-attachment-badge"]'));
  };
  try {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 30000 });
    await rpc('runtime.projects.upsert_local', { deviceId: 'local', projectKey: 'workflow-project', name: 'Workflow project', roots: [projectPath] });
    await page.reload(); await project().waitFor({ timeout: 30000 });
    stage = 'image-only-first';
    await project().getByTestId('project-new-conversation-button').click();
    await attach();
    assert.equal((await page.getByTestId('chat-message-input').innerText()).trim(), '');
    await page.getByTestId('send-message-button').click();
    await settle(1);
    const taskId = new URL(page.url()).searchParams.get('taskId');
    assert.ok(taskId?.startsWith('kcoder:local:'));
    const address = { deviceId: 'local', workspacePath: projectPath, taskId };
    const hasImage = request => request.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'));
    assert.ok(model.requests.some(hasImage), 'Image must reach the provider as an image block');
    stage = 'image-only-followup';
    await attach(); await page.getByTestId('send-message-button').click(); await settle(2);
    assert.ok(model.requests.at(-1).messages.filter(message => message.role === 'user').at(-1).content.some(part => part.type === 'image_url'));
    stage = 'text-after-image';
    await input('TEXT_AFTER_IMAGE'); await page.getByTestId('send-message-button').click(); await settle(3);
    stage = 'goal-clear';
    await rpc('runtime.tasks.goal.set', { address, objective: 'Goal deletion fixture', status: 'active' });
    await page.reload(); await page.getByTestId('goal-status-bar').waitFor({ timeout: 30000 });
    await page.getByTestId('clear-goal-button').click();
    await page.getByTestId('goal-status-bar').waitFor({ state: 'detached', timeout: 30000 });
    assert.equal((await rpc('runtime.tasks.goal.get', { address })).goal, null);
    await page.reload(); await page.getByTestId('message-user').filter({ hasText: 'TEXT_AFTER_IMAGE' }).waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId('goal-status-bar').count(), 0);
    stage = 'settings-unarchive';
    await expand();
    await page.getByTestId(`runtime-local-task-row-${taskId}`).hover();
    await page.getByTestId(`runtime-local-task-archive-${taskId}`).click();
    await page.waitForTimeout(3300);
    assert.ok((await rpc('runtime.archived_conversations.list')).items.some(item => item.taskId === taskId));
    await page.getByTestId('settings-button').click();
    await page.getByTestId('settings-menu-button').click();
    await page.getByTestId('settings-nav-archived-conversations').click();
    await page.locator('[data-testid^="archived-unarchive-button-"]').first().click();
    await page.getByTestId('archived-unarchive-success').waitFor({ timeout: 30000 });
    await page.getByTestId('settings-back-button').click();
    await project().waitFor({ timeout: 30000 }); await expand();
    await page.getByTestId(`runtime-local-task-row-${taskId}`).waitFor({ timeout: 30000 });
    assert.equal((await rpc('runtime.archived_conversations.list')).items.some(item => item.taskId === taskId), false);
    stage = 'creation-failure-retry';
    await project().getByTestId('project-new-conversation-button').click();
    await input('FAIL_BEFORE_CREATE');
    await rename(projectPath, `${projectPath}.held`); moved = true;
    await page.getByTestId('send-message-button').click();
    await page.locator('[data-testid^="runtime-task-creation-error-"]').first().waitFor({ timeout: 30000 });
    await rename(`${projectPath}.held`, projectPath); moved = false;
    await input('RECOVERED_AFTER_CREATE_FAILURE');
    await page.getByTestId('send-message-button').click(); await settle(1);
    assert.notEqual(new URL(page.url()).searchParams.get('taskId'), taskId);
    const recoveredId = new URL(page.url()).searchParams.get('taskId');
    stage = 'initial-goal-completion';
    await project().getByTestId('project-new-conversation-button').click();
    await input('/goal INITIAL_GOAL_PROTOCOL');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('goal-draft-pill').waitFor({ timeout: 10000 });
    await page.getByTestId('send-message-button').click();
    await page.waitForFunction(previous => {
      const id = new URL(location.href).searchParams.get('taskId');
      return id?.startsWith('kcoder:local:') && id !== previous;
    }, recoveredId, { timeout: 30000 });
    const goalAddress = { ...address, taskId: new URL(page.url()).searchParams.get('taskId') };
    await page.waitForFunction(async address => {
      const result = await window.__TAURI_INTERNALS__.invoke('local_executor_request', { method: 'runtime.tasks.goal.get', params: { address } });
      return result.goal?.status === 'complete';
    }, goalAddress, { timeout: 30000 });
    await page.getByTestId('goal-status-bar').waitFor({ state: 'detached', timeout: 30000 });
    assert.ok(initialGoalToolSeen);
    stage = 'initial-goal-pro-delete';
    await project().getByTestId('project-new-conversation-button').click();
    await input('/goal-pro STRICT_GOAL_DELETE_FIXTURE');
    await page.getByTestId('send-message-button').click();
    await page.getByTestId('goal-draft-pill').waitFor({ timeout: 10000 });
    await page.getByTestId('send-message-button').click();
    await page.waitForFunction(previous => {
      const id = new URL(location.href).searchParams.get('taskId');
      return id?.startsWith('kcoder:local:') && id !== previous;
    }, goalAddress.taskId, { timeout: 30000 });
    const strictAddress = { ...address, taskId: new URL(page.url()).searchParams.get('taskId') };
    const strictGoal = (await rpc('runtime.tasks.goal.get', { address: strictAddress })).goal;
    assert.equal(strictGoal.mode, 'strict');
    assert.equal(strictGoal.objective, 'STRICT_GOAL_DELETE_FIXTURE');
    await assert.rejects(rpc('runtime.tasks.goal.set', { address: strictAddress, objective: strictGoal.objective, mode: 'strict', status: 'complete' }), /verifier|strict/i);
    await page.getByTestId('goal-status-bar').waitFor({ timeout: 30000 });
    await page.getByTestId('clear-goal-button').click();
    await page.getByTestId('goal-status-bar').waitFor({ state: 'detached', timeout: 30000 });
    assert.equal((await rpc('runtime.tasks.goal.get', { address: strictAddress })).goal, null);
    await page.screenshot({ path: context.pathInArtifacts('workflow-recovered.png') });
    return { imageOnlyFirst: true, imageOnlyFollowup: true, providerReceivedImages: true, goalClear: true,
      initialGoalToolSeen, initialGoalCompleted: true, initialGoalPro: true, goalProClear: true, strictGatePreserved: true,
      settingsUnarchive: true, failedCreationRetry: true, requests: model.requests.length };
  } catch (error) {
    await context.writeArtifactJson('failure.json', { stage, error: error.message, body: await page.locator('body').innerText(), wire, errors });
    await page.screenshot({ path: context.pathInArtifacts('failure.png') });
    throw error;
  } finally {
    if (moved) await rename(`${projectPath}.held`, projectPath);
  }
});
