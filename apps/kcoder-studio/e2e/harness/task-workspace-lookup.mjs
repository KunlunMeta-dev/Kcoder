import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, lstat, open as openFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createServer } from 'node:http';
import { AppServerStdioClient } from './app-server-stdio.mjs';

/** Two actual Native lifetimes, one private profile, and no Provider request. */
export async function unregisteredColdTaskFixture(context, binary) {
  let providerRequests = 0; let phase = 'fixture-start'; const providerHttp = [];
  const endpoint = createServer((request, response) => {
    providerRequests++; if (providerHttp.length < 32) providerHttp.push({ method: request.method, path: request.url, phase });
    response.writeHead(503).end();
  });
  await new Promise((resolve, reject) => { endpoint.once('error', reject); endpoint.listen(0, '127.0.0.1', resolve); });
  context.registerPort('cold-workspace-closed-provider', endpoint.address().port);
  context.addCleanup('close cold workspace Provider witness', async () => {
    endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve));
  });
  const profile = context.pathInState('native-profile');
  const original = context.pathInState('auto-workspace');
  const fallback = context.pathInState('saved-default-workspace');
  for (const path of [profile, original, fallback]) await mkdir(path, { recursive: true, mode: 0o700 });
  await context.writeStateJson('native-profile/settings.json', {
    active_provider: 'OwnedMetadata', model: 'metadata-only', history_enabled: true, max_retries: 0,
    providers: { OwnedMetadata: { api_format: 'openai_chat_completions',
      endpoint: `http://127.0.0.1:${endpoint.address().port}/v1`, authentication: { mode: 'none' },
      default_model: 'metadata-only', discover_models: false, no_proxy: true,
      context_window_tokens: 8192, max_output_tokens: 64, output_headroom_tokens: 64 } },
    cross_session_messages: { enabled: false }, mcp_servers: [],
  });
  let generation = 0;
  async function open(workspace) {
    const label = `cold-workspace-native-${++generation}`;
    const child = context.spawnOwned(label, binary, ['--cwd', workspace, 'app-server'], {
      cwd: workspace, env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: profile, KCODER_HOME: profile }), stdin: 'pipe',
    });
    const wire = new AppServerStdioClient(label, child);
    const originalRequest = wire.request.bind(wire);
    wire.request = (method, ...args) => { phase = `${label}:${method}`; return originalRequest(method, ...args); };
    context.addCleanup(`close ${label} protocol`, () => wire.closeReader());
    const request = async (method, params = {}) => {
      const response = await wire.request(method, params);
      assert.ok(!response.error, `${method} rejected with closed code ${response.error?.code}`);
      return response.result;
    };
    const initialized = await request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-workspace-metadata', version: '1' },
      capabilities: { experimental: { threadWorkspaceLookupV1: true, threadOwnershipErrorsV1: true } } });
    wire.write(undefined, 'initialized', {});
    return { wire, request, initialized, child, label, async stop() {
      await context.stopOwned(label); wire.closeReader();
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'original Native process must exit');
    } };
  }
  const first = await open(original);
  const created = await first.request('thread/start', { clientRequestId: randomUUID() });
  const threadId = created?.thread?.id;
  assert.ok(typeof threadId === 'string' && threadId.length > 0);
  const firstList = await first.request('thread/list', { limit: 100 });
  assert.ok(firstList.threads.some(row => row.id === threadId && row.cwd === original));
  const before = await first.request('runtime.workspaces.list', {});
  assert.ok(!before.items.some(row => row.workspacePath === original), 'original auto workspace is deliberately unregistered');
  async function originalHistoryWitness() {
    const projects = path.join(profile, 'projects');
    const names = await readdir(projects, { withFileTypes: true });
    assert.ok(names.length <= 8, 'fixture project inventory is bounded');
    const matches = [];
    for (const entry of names) {
      assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
      const file = path.join(projects, entry.name, `${threadId}.jsonl`);
      const metadata = await lstat(file, { bigint: true }).catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
      });
      if (!metadata) continue;
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n);
      assert.ok(metadata.size <= 1024n * 1024n);
      const statePath = path.join(projects, entry.name, threadId, 'state.json');
      const stateMetadata = await lstat(statePath, { bigint: true });
      assert.ok(stateMetadata.isFile() && !stateMetadata.isSymbolicLink() && stateMetadata.nlink === 1n);
      assert.ok(stateMetadata.size > 0n && stateMetadata.size <= 8n * 1024n * 1024n);
      const stored = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(stored.base_cwd ?? stored.cwd, original);
      matches.push({ sidecarMaterialized: true, sidecarBytes: String(stateMetadata.size), dev: String(metadata.dev), ino: String(metadata.ino), size: String(metadata.size),
        mtimeNs: String(metadata.mtimeNs), ctimeNs: String(metadata.ctimeNs),
        sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
    }
    assert.equal(matches.length, 1, 'original history is unique within the owned profile');
    return matches[0];

  }
  const materialized = await originalHistoryWitness();
  const originalPid = first.child.pid;
  await first.stop();
  const persisted = await open(original);
  const persistedList = await persisted.request('thread/list', { limit: 100, allowPartial: true });
  assert.equal(persistedList.completeness, 'complete');
  assert.equal(persistedList.issueCount, 0);
  assert.ok(persistedList.threads.some(row => row.id === threadId && row.cwd === original));
  const persistedRead = await persisted.request('thread/read', { threadId });
  assert.equal(persistedRead.thread.id, threadId);
  assert.equal(persistedRead.messages.filter(row => row.role === 'user').length, 0);
  await persisted.stop();
  const cold = await open(fallback);
  const current = await cold.request('thread/list', { limit: 100 });
  assert.ok(!current.threads.some(row => row.id === threadId), 'saved default cannot supply the original history');
  await context.writeArtifactJson('cold-workspace-preconditions.json', {
    actualNativeLifetimes: 3, durableClientRequestId: true, materialized, independentPersistedListAndRead: true, allOriginalReadersExited: true, originalNativePid: originalPid, originalNativeExited: true,
    threadId, originalWorkspace: original, savedDefaultWorkspace: fallback,
    originalWorkspaceUnregistered: true, defaultWorkspaceDoesNotContainThread: true, providerRequests,
  });
  return { cold, original, fallback, threadId, originalPid, open, get nativeLifetimes() { return generation; }, originalHistoryWitness, async disableHistory() {
    const settings = JSON.parse(await readFile(context.pathInState('native-profile/settings.json'), 'utf8'));
    const path = context.pathInState('native-profile/settings.json');
    const original = await lstat(path, { bigint: true });
    const file = await openFile(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const held = await file.stat({ bigint: true });
      assert.ok(held.isFile() && held.nlink === 1n && held.dev === original.dev && held.ino === original.ino);
      await file.truncate(0); await file.writeFile(`${JSON.stringify({ ...settings, history_enabled: false }, null, 2)}\n`); await file.sync();
    } finally { await file.close(); }
  }, get providerHttp() { return providerHttp; }, get providerRequests() { return providerRequests; } };
}
