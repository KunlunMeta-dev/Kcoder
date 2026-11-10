import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { startChromium } from '../../harness/chromium.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, gatewayRpcUrl, closeRpcAndWait } from '../../harness/rpc.mjs';
import { runE2E } from '../../harness/run-context.mjs';
import { INTEGRATION_CONTROL_CAPABILITIES } from '../../../shared/integrationControlMethods.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-home-task-feishu-bind-unbind', tier: 'manual-live',
  modelPolicy: 'Explicitly authorized existing Feishu discovery and tasks. Real public DOM and original Native binding receipts; no model, synthetic ingress or platform send.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_TASK_BINDING, '1');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_DESKTOP_URL);
  assert.equal(base.protocol, 'https:');
  assert.ok(!base.search && !base.hash && !base.username && !base.password);
  assert.match(base.pathname, /^\/g\/[a-f0-9]{32}\/?$/);
  const rpcBase = process.env.KCODER_E2E_DEPLOYED_RPC_BASE_URL;
  assert.match(rpcBase, /^http:\/\/127\.0\.0\.1:\d+$/);
  const serverId = process.env.KCODER_E2E_DEPLOYED_SERVER_ID;
  const connectionId = process.env.KCODER_E2E_DEPLOYED_EXPECT_CONNECTION_ID;
  const taskId = process.env.KCODER_E2E_DEPLOYED_BIND_THREAD;
  assert.ok(serverId && connectionId && taskId);
  const envPath = process.env.KCODER_E2E_DEPLOYED_ENV_FILE;
  const envStat = await lstat(envPath);
  assert.ok(envStat.isFile() && !envStat.isSymbolicLink() && envStat.uid === process.getuid() && (envStat.mode & 0o077) === 0);
  const line = (await readFile(envPath, 'utf8')).split(/\r?\n/).find(value => value.startsWith('KCODER_STUDIO_AUTH_TOKEN='));
  assert.ok(line);
  const token = line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, '');
  context.registerSecret(token);
  const cookie = await login(rpcBase, token);
  context.registerSecret(cookie);
  const rpc = await openRpc(gatewayRpcUrl({ baseUrl: rpcBase, wsUrl: rpcBase.replace('http', 'ws') }, serverId, 'cookie-auth'), {
    headers: { Cookie: cookie, Origin: rpcBase },
  });
  context.addCleanup('close original Native observation RPC', () => closeRpcAndWait(rpc));
  await rpc.request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'authorized-home-bind-acceptance', version: '1' },
    capabilities: { experimental: { ...Object.fromEntries(INTEGRATION_CONTROL_CAPABILITIES.map(key => [key, true])),
      integrationScopeV1: true, connectivityV1: true, integrationTaskStateV1: true, nativeChannelServicesV1: true,
      integrationOperationReceiptsV1: true, threadCreationReceiptsV1: true, threadRuntimeHandoffV1: true } } });
  const scope = await rpc.request('integrations/scope/read');
  let sequence = 0;
  const directory = async threadId => {
    const reply = await rpc.request('integrations/connectivity/readResourceGrant', {
      contractVersion: 'parallel-v1', scope, requestId: `home-binding-read-${++sequence}`, timeoutMs: 60000,
      payload: { connectionId, taskBindingQuery: { taskThreadId: threadId } },
    }, 75000);
    assert.equal(reply.status, 'completed');
    return reply.result;
  };
  const before = await directory(taskId);
  assert.equal(before.taskBinding, null, 'Select an existing unbound task; never overwrite an unknown task binding');
  assert.equal(before.externalChats.length, 1, 'This authorized acceptance selects the single existing real chat explicitly');
  const chat = before.externalChats[0];
  assert.equal(chat.range.platform, 'feishu');
  assert.equal(chat.range.chatKind, 'private');
  const tasks = (await rpc.request('thread/list', {})).threads.map(thread => thread.id);
  assert.ok(tasks.includes(taskId));
  let originalBinding = null;
  for (const thread of tasks) {
    const candidate = (await directory(thread)).taskBinding;
    if (candidate?.range.chatId === chat.range.chatId && candidate.range.topicId === chat.range.topicId) {
      assert.equal(originalBinding, null);
      originalBinding = candidate;
    }
  }
  const histories = async () => Object.fromEntries(await Promise.all(tasks.map(async threadId => [threadId,
    createHash('sha256').update(JSON.stringify(await rpc.request('thread/read', { threadId, limit: 250 }))).digest('hex')])));
  const historyBefore = await histories();
  await context.writeArtifactJson('original-before.json', { scope, connectionId, taskId, chat, originalBinding, bindingRefs: before.externalChatBindingRefs, historyBefore });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1510, height: 968 }, ignoreHTTPSErrors: process.env.KCODER_E2E_DEPLOYED_SELF_SIGNED === '1' });
  context.addCleanup('close owned public binding page', () => page.close());
  const prefix = base.pathname.replace(/\/$/, '');
  await page.goto(`${base.origin}${prefix}/login`);
  await page.locator('input[name="token"]').fill(token);
  await Promise.all([page.waitForURL(url => !url.pathname.endsWith('/login')), page.locator('button[type="submit"]').click()]);
  await page.goto(`${base.origin}${prefix}/`);
  const locales = await Promise.all(['zh-CN', 'en'].map(async locale => JSON.parse(await readFile(new URL(`../../../renderer/src/i18n/locales/${locale}/connectivity.json`, import.meta.url), 'utf8')).chatTasks));
  const names = key => new RegExp(`^(?:${locales.map(locale => locale[key].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
  const taskRow = thread => page.locator(`[data-testid^="runtime-local-task-row-"][data-testid$=":${thread}"]`);
  const open = async (thread, action) => {
    const target = taskRow(thread);
    await target.first().waitFor({ state: 'attached', timeout: 75000 });
    const project = page.getByTestId('project-item').filter({ has: target }).first();
    if (await project.count()) {
      const toggle = project.getByTestId('project-item-button');
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    }
    await target.first().click({ button: 'right' });
    await page.locator(`[data-testid^="runtime-local-task-menu-${action}-channel-"][data-testid$=":${thread}"]`).click();
    const dialog = page.getByTestId('task-channel-binding-dialog');
    await dialog.waitFor();
    const select = dialog.getByRole('combobox');
    await select.selectOption(connectionId, { timeout: 75000 });
    await dialog.getByTestId('task-channel-binding-picker').waitFor();
    return dialog;
  };
  const close = async dialog => dialog.getByRole('button', { name: names('close'), exact: true }).click();
  const binding = async thread => (await directory(thread)).taskBinding;
  const originalTask = originalBinding?.task?.threadId ?? null;
  const restore = async () => {
    if (!originalTask || (await binding(originalTask))?.task.threadId === originalTask) return;
    const existing = page.getByTestId('task-channel-binding-dialog');
    if (await existing.count()) await close(existing);
    const observed = await directory(originalTask);
    const dialog = await open(originalTask, 'bind');
    await dialog.getByRole('radio', { name: new RegExp(chat.range.chatId) }).check();
    await dialog.getByRole('button', { name: names('bindTask'), exact: true }).click();
    if (observed.externalChatBindingStates[chat.id] === 'active')
      await dialog.getByRole('button', { name: names('confirm'), exact: true }).click();
    await dialog.getByText(names('boundSucceeded'), { exact: true }).waitFor({ timeout: 75000 });
    const restored = await binding(originalTask);
    assert.equal(restored.task.threadId, originalTask);
    assert.equal(restored.id, originalBinding.id);
    await context.writeArtifactJson('original-binding-restored.json', { restored, restoredThroughPublicMenu: true });
    await close(dialog);
  };
  context.addCleanup('restore the explicitly observed original task binding', restore);
  try {
    const dialog = await open(taskId, 'bind');
    const radio = dialog.getByRole('radio', { name: new RegExp(chat.range.chatId) });
    await radio.check();
    await dialog.getByRole('button', { name: names('bindTask'), exact: true }).click();
    if (before.externalChatBindingStates[chat.id] === 'active') {
      await dialog.getByRole('button', { name: names('confirm'), exact: true }).click();
    }
    await dialog.getByText(names('boundSucceeded'), { exact: true }).waitFor({ timeout: 75000 });
    const active = await binding(taskId);
    assert.equal(active.task.threadId, taskId);
    assert.equal(active.range.chatId, chat.range.chatId);
    const originalOperation = (await directory(taskId)).externalChatBindingRefs[chat.id];
    assert.equal(originalOperation.revision, active.revision);
    await context.writeArtifactJson('actual-bound.json', { active });
    await page.screenshot({ path: context.pathInArtifacts('actual-home-bound.png') });
    await close(dialog);

    const unbindDialog = await open(taskId, 'unbind');
    await unbindDialog.getByRole('button', { name: names('unbind'), exact: true }).click();
    await unbindDialog.getByRole('button', { name: names('confirm'), exact: true }).click();
    await unbindDialog.getByText(names('unboundSucceeded'), { exact: true }).waitFor({ timeout: 75000 });
    assert.equal(await binding(taskId), null);
    await page.screenshot({ path: context.pathInArtifacts('actual-home-unbound.png') });
    await close(unbindDialog);
    await restore();
    assert.deepEqual(await histories(), historyBefore);
    assert.deepEqual((await rpc.request('thread/list', {})).threads.map(thread => thread.id).sort(), [...tasks].sort());
    return { realPublicHomeMenu: true, originalNativeBinding: true, realFeishuDiscovery: true,
      taskId, connectionId, originalTask, bindAndUnbind: true, historyPreserved: true, tasksCreated: 0,
      modelCalls: 0, platformMessagesSent: 0, realPlatformInputOutputRevalidated: false };
  } catch (error) {
    await context.writeArtifactJson('actual-failure.json', { alerts: await page.getByRole('alert').allTextContents(), taskBinding: await binding(taskId) });
    await page.screenshot({ path: context.pathInArtifacts('actual-home-failure.png') });
    throw error;
  }
});
