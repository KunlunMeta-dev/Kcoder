import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat, lstat } from 'node:fs/promises';
import { AppServerStdioClient } from './app-server-stdio.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { startApprovalModelFixture } from './approval-model.mjs';
import { startGateway } from './gateway.mjs';
import { login } from './http.mjs';
import { startChromium } from './chromium.mjs';

export async function openFullyColdWorkspaceBrowser(context, binary) {
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'COLD_HISTORY_READY' });
  const { path: original } = await materializeWorkspace(context, 'minimal', { instanceId: 'old-auto-workspace' });
  const { path: fallback } = await materializeWorkspace(context, 'minimal', { instanceId: 'saved-default-workspace' });
  const profile = context.pathInState('native-profile');
  await context.writeStateJson('native-profile/settings.json', {
    active_provider: 'ColdHistory', model: 'seed-v1', history_enabled: true, max_retries: 0,
    session_memory: { enabled: false }, cross_session_messages: { enabled: true }, mcp_servers: [],
    providers: { ColdHistory: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'seed-v1', authentication: { mode: 'none' }, no_proxy: true, discover_models: false,
      context_window_tokens: 128000, max_output_tokens: 128, output_headroom_tokens: 256 } },
  });
  const child = context.spawnOwned('original-cold-history-native', binary, ['--cwd', original, 'app-server'], {
    cwd: original, env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile, KCODER_HOME: profile }), stdin: 'pipe',
  });
  const seed = new AppServerStdioClient('cold-browser-seed', child);
  context.addCleanup('close original cold history reader', () => seed.closeReader());
  const image = await stat(`/proc/${child.pid}/exe`, { bigint: true });
  const expected = await stat(binary, { bigint: true });
  assert.equal(image.dev, expected.dev); assert.equal(image.ino, expected.ino);
  const birth = (await readFile(`/proc/${child.pid}/stat`, 'utf8')).split(') ').at(-1).split(' ')[19];
  const request = async (method, params = {}) => {
    const response = await seed.request(method, params);
    assert.ok(!response.error, `${method} rejected with closed code ${response.error?.code}`);
    return response.result;
  };
  await request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-cold-browser-seed', version: '1' } });
  seed.write(undefined, 'initialized', {});
  const { thread } = await request('thread/start', { model: 'ColdHistory::seed-v1', clientRequestId: randomUUID() });
  const terminalRead = seed.waitForNotification(frame => frame.method === 'turn/completed' &&
    frame.params?.threadId === thread.id, 30_000, 'one owned seed turn');
  const { turn } = await request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Persist one original cold history.' }] });
  const terminal = await terminalRead;
  assert.equal(terminal.params.turnId, turn.id);
  assert.equal(terminal.params.turn.status, 'completed');
  assert.equal(model.requests.length, 1);
  const saved = await request('thread/read', { threadId: thread.id });
  assert.ok(JSON.stringify(saved.messages).includes('COLD_HISTORY_READY'));
  const directoryFacts = [];
  for (const [label, path] of [['profile', profile], ['projects', profile + '/projects']]) {
    const info = await lstat(path, { bigint: true });
    directoryFacts.push({ label, directory: info.isDirectory(), symlink: info.isSymbolicLink(),
      uid: String(info.uid), gid: String(info.gid), mode: (Number(info.mode) & 0o777).toString(8),
      device: String(info.dev), inode: String(info.ino) });
  }
  await context.writeArtifactJson('cold-native-directory-facts.json', directoryFacts);
  const registry = await request('runtime.workspaces.list', {});
  assert.ok(!registry.items.some(row => row.workspacePath === original));
  await context.stopOwned('original-cold-history-native'); seed.closeReader();
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.equal(await stat(`/proc/${child.pid}`).then(() => true, () => false), false);
  const serverId = 'cold-history';
  const serversFile = await context.writeStateJson('servers.json', [{ id: serverId, label: 'Cold history fixture',
    transport: 'local', command: binary, workspace: fallback }]);
  const gateway = await startGateway(context, { workspace: fallback, serversFile, kcoderBin: binary, auth: true,
    env: { KCODER_CONFIG_DIR: profile, KCODER_HOME: profile, KCODER_STUDIO_DATA_DIR: context.pathInState('gateway-data'),
      NODE_OPTIONS: `--import=${new URL('./task-workspace-diagnostic.mjs', import.meta.url).pathname}`,
      KCODER_E2E_LOOKUP_DIAGNOSTIC_FILE: context.pathInArtifacts('native-lookup-diagnostic.json'), RUST_LOG: 'kcoder_cli_runtime::app_server::thread_workspace_lookup=debug' } });
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const inventoryResponse = await fetch(gateway.baseUrl + '/api/servers', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(inventoryResponse.status, 200);
  const inventory = await inventoryResponse.json();
  const target = inventory.servers.find(row => row.id === serverId);
  assert.ok(target);
  assert.equal(target.workspaceHints?.paths?.length ?? 0, 0, 'no original live broker hint can locate this history');
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const split = cookie.indexOf('=');
  await page.context().addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1),
    url: gateway.baseUrl, httpOnly: true, sameSite: 'Strict' }]);
  const taskId = `kcoder:${serverId}:${thread.id}`;
  const url = new URL('/runtime-tasks', gateway.baseUrl);
  url.searchParams.set('deviceId', serverId); url.searchParams.set('taskId', taskId);
  return { page, model, gateway, serverId, threadId: thread.id, taskId, url: url.href, original, fallback,
    originalProcess: { pid: child.pid, birth, exited: true, imageDevice: String(image.dev), imageInode: String(image.ino) },
    initialWorkspaceHints: target.workspaceHints ?? null };
}

export function observeColdWorkspaceBrowser(page, originalThreadId) {
  const wire = []; let next = 0;
  page.on('websocket', socket => {
    const connection = ++next, pending = new Map();
    const query = new URL(socket.url()).searchParams;
    const workspace = query.get('workspace');
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload)); if (!frame.method) return;
        const row = { connection, workspace, method: frame.method,
          threadId: frame.params?.threadId ?? frame.params?.sourceThreadId,
          ...(frame.method === 'thread/agentMessage/targets' ? { requestCursor: frame.params?.cursor ?? null } : {}) };
        wire.push(row); pending.set(frame.id, row);
      } catch { /* Only closed routing facts are observed. */ }
    });
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload)); const row = pending.get(frame.id); if (!row) return;
        pending.delete(frame.id); row.reply = true; row.errorCode = frame.error?.code;
        if (row.method === 'thread/workspace/lookup') row.lookup = frame.result;
        if (row.method === 'thread/agentMessage/targets' && frame.result) row.targets = {
          count: Array.isArray(frame.result.targets) ? frame.result.targets.length : null,
          completeness: frame.result.completeness, nextCursor: frame.result.nextCursor ?? null };
        if (row.method === 'thread/list') {
          row.matches = frame.result?.threads?.filter(thread => thread.id === originalThreadId).map(thread => ({ id: thread.id, cwd: thread.cwd }));
          row.completeness = frame.result?.completeness; row.issueCount = frame.result?.issueCount;
        }
        if (['thread/read', 'thread/read/indexed', 'thread/resume'].includes(row.method))
          row.actualThreadId = frame.result?.thread?.id;
      } catch { /* No request body, credential or full URL is retained. */ }
    });
  });
  return wire;
}
