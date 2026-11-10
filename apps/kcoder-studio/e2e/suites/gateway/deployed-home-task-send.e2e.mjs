import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { startChromium } from '../../harness/chromium.mjs';
import { login } from '../../harness/http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'deployed-home-create-send-reload-continue', tier: 'manual-live',
  modelPolicy: 'Explicit public deployment acceptance: one run-owned ordinary task, two short text model turns, 90 seconds each, no replay. Archive only this task after reconciling its original receipts. No existing task input or platform send.',
}, async context => {
  assert.equal(process.env.KCODER_E2E_DEPLOYED_TASK_SEND, '1');
  assert.equal(process.env.KCODER_E2E_REAL_MODEL, '1');
  const base = new URL(process.env.KCODER_E2E_DEPLOYED_DESKTOP_URL);
  assert.equal(base.protocol, 'https:');
  assert.ok(!base.search && !base.hash && !base.username && !base.password);
  const rpcBase = process.env.KCODER_E2E_DEPLOYED_RPC_BASE_URL;
  assert.match(rpcBase, /^http:\/\/127\.0\.0\.1:\d+$/);
  const serverId = process.env.KCODER_E2E_DEPLOYED_SERVER_ID;
  const workspacePath = process.env.KCODER_E2E_DEPLOYED_WORKSPACE;
  const projectLabel = process.env.KCODER_E2E_DEPLOYED_PROJECT_LABEL;
  assert.ok(serverId && workspacePath && projectLabel);
  const file = process.env.KCODER_E2E_DEPLOYED_ENV_FILE;
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() && (info.mode & 0o077) === 0);
  const line = (await readFile(file, 'utf8')).split(/\r?\n/).find(value => value.startsWith('KCODER_STUDIO_AUTH_TOKEN='));
  assert.ok(line);
  const token = line.slice(line.indexOf('=') + 1).replace(/^['"]|['"]$/g, '');
  context.registerSecret(token);
  const cookie = await login(rpcBase, token);
  context.registerSecret(cookie);
  const rpcUrl = new URL(gatewayRpcUrl({ wsUrl: rpcBase.replace('http:', 'ws:') }, serverId, 'cookie-auth'));
  rpcUrl.searchParams.set('workspace', workspacePath);
  const rpc = await openRpc(rpcUrl.href, { headers: { Cookie: cookie, Origin: rpcBase } });
  context.addCleanup('close deployment task observation RPC', () => closeRpcAndWait(rpc));
  await initializeRpc(rpc, 'deployed-home-task-observer', {
    taskSourcesV1: true, interactionBindingV1: true, threadRuntimeHandoffV1: true,
    threadCreationReceiptsV1: true, turnReceiptsV1: true, turnSubmissionV1: true,
  });
  const originalTaskIds = new Set((await rpc.request('thread/list', { limit: 100 })).threads.map(task => task.id));
  const calls = [], errors = [], completions = [];
  let threadId, creationId, closed = false;
  const reconcileAndArchive = async () => {
    if (closed) return;
    if (!threadId && creationId) {
      const receipt = await rpc.request('thread/creation/read', { clientRequestId: creationId });
      threadId = receipt.receipt?.threadId;
    }
    if (!threadId) return;
    assert.ok(!originalTaskIds.has(threadId), 'Cleanup must never select a pre-existing task');
    const state = await rpc.request('thread/read', { threadId });
    const active = new Set();
    for (const message of state.messages) {
      if (message.role !== 'user' || !message.clientMessageId) continue;
      const { receipt } = await rpc.request('turn/receipt/read', { threadId, clientMessageId: message.clientMessageId });
      assert.notEqual(receipt?.status, 'unknown', 'Unknown execution must be reconciled before cleanup');
      if (receipt?.status === 'running') active.add(receipt.turnId);
    }
    for (const turnId of active) await rpc.request('turn/interrupt', { threadId, turnId });
    if (active.size) await waitFor(async () => {
      const current = await rpc.request('thread/read', { threadId });
      return current.thread.status === 'idle';
    }, 15000, 'owned task interruption before archive');
    const archivedAt = new Date().toISOString();
    const archived = await rpc.request('thread/metadata/update', { threadId, archivedAt });
    assert.equal(archived.thread.archivedAt, archivedAt);
    closed = true;
  };
  context.addCleanup('reconcile and archive only the run-owned task', reconcileAndArchive);
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1510, height: 968 },
    ignoreHTTPSErrors: process.env.KCODER_E2E_DEPLOYED_SELF_SIGNED === '1' });
  context.addCleanup('close deployment home-task page', () => page.close());
  page.on('websocket', socket => {
    const target = new URL(socket.url()).searchParams.get('server');
    if (target !== serverId) return;
    const pending = new Map();
    socket.on('framesent', frame => {
      let value;
      try { value = JSON.parse(String(frame.payload)); } catch { return; }
      if (!['thread/start', 'thread/resume', 'thread/metadata/update', 'turn/start'].includes(value.method)) return;
      const row = { method: value.method, threadId: value.params?.threadId, clientMessageId: value.params?.clientMessageId };
      if (value.method === 'thread/start') {
        if (creationId) errors.push({ method: row.method, reason: 'Duplicate task creation request' });
        else creationId = value.params?.clientRequestId;
        if (!creationId) errors.push({ method: row.method, reason: 'Missing creation identity' });
      }
      calls.push(row);
      pending.set(value.id, row);
    });
    socket.on('framereceived', frame => {
      let value;
      try { value = JSON.parse(String(frame.payload)); } catch { return; }
      const row = pending.get(value.id);
      if (row) {
        if (value.error) errors.push({ method: row.method, code: value.error.code, reason: value.error.message });
        if (row.method === 'thread/start' && value.result?.thread) {
          threadId = value.result.thread.id;
          if (originalTaskIds.has(threadId) || value.result.thread.cwd !== workspacePath)
            errors.push({ method: row.method, reason: 'Task ownership or workspace mismatch' });
        }
        if (row.method === 'turn/start' && value.result?.turn) row.turnId = value.result.turn.id;
        pending.delete(value.id);
      }
      if (value.method === 'turn/completed' && value.params?.threadId === threadId)
        completions.push({ id: value.params.turnId, status: value.params.turn?.status });
      if (value.method === 'item/started' && value.params?.threadId === threadId && value.params?.item?.type === 'toolCall')
        errors.push({ method: value.method, reason: 'Text-only deployment turn exceeded its zero-tool budget' });
    });
  });
  const prefix = base.pathname.replace(/\/$/, '');
  const loginUrl = new URL(`${base.origin}${prefix}/login`);
  loginUrl.searchParams.set('token', token);
  loginUrl.searchParams.set('returnTo', `${prefix}/`);
  try {
    await page.goto(loginUrl.href, { waitUntil: 'commit' });
    const project = page.getByTestId('project-item').filter({ hasText: projectLabel }).first();
    await project.waitFor({ timeout: 120000 });
    await project.hover();
    await project.getByTestId('project-new-conversation-button').click();
    const markers = [0, 1].map(index => `KC_DEPLOY_${randomUUID().replaceAll('-', '').slice(0, 12)}_${index}`);
    for (let index = 0; index < markers.length; index++) {
      if (index) {
        await page.reload();
        const row = page.locator(`[data-testid^="runtime-local-task-row-"][data-testid$=":${threadId}"]`).first();
        await row.waitFor({ timeout: 75000 });
        await row.click();
      }
      await page.getByTestId('chat-message-input').click();
      await page.keyboard.insertText(`部署验收，只回复“${markers[index]}”，不要调用工具。`);
      await page.getByTestId('send-message-button').click();
      const deadline = Date.now() + 90000;
      while (!completions.some(value => value.id === calls.filter(call => call.method === 'turn/start')[index]?.turnId)) {
        assert.deepEqual(errors, [], 'The real creation/resume/send path must not reject an original command');
        assert.ok(Date.now() < deadline, 'The owned model turn did not finish within its budget; do not replay it');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.equal(completions.find(value => value.id === calls.filter(call => call.method === 'turn/start')[index].turnId).status, 'completed');
      await page.getByTestId('message-assistant').filter({ hasText: markers[index] }).waitFor();
    }
    const history = await rpc.request('thread/read', { threadId });
    for (const marker of markers) {
      assert.equal(history.messages.filter(message => message.role === 'user' && message.content.includes(marker)).length, 1);
      assert.equal(history.messages.filter(message => message.role === 'assistant' && message.content.includes(marker)).length, 1);
    }
    assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
    assert.equal(calls.filter(call => call.method === 'turn/start').length, 2);
    assert.deepEqual(errors, []);
    await context.writeArtifactJson('home-task-send-proof.json', { threadId, creationId, calls, completions, markers, realProvider: true, reloadContinuationVerified: true });
    await page.screenshot({ path: context.pathInArtifacts('home-task-send.png') });
    // Release this page's Gateway ownership before the observer archives its task.
    await page.close();
    await reconcileAndArchive();
    return { threadId, realModelTurns: 2, taskCreations: 1, archived: closed, sameTaskAfterReload: true };
  } catch (error) {
    await context.writeArtifactJson('home-task-send-failure.json', { threadId, creationId, calls, completions, errors, reason: String(error).slice(0, 1500) });
    await page.screenshot({ path: context.pathInArtifacts('home-task-send-failure.png') }).catch(() => {});
    throw error;
  }
});
