import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';

/** Real Native metadata/lifecycle with a bounded loopback provider, never real models or user sessions. */
export async function runWindowsTaskBoardStatusProbe({ binary, root, environment }) {
  const profile = join(root, 'board-profile'), workspace = join(root, 'board-workspace');
  await mkdir(profile, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'AGENTS.md'), 'Owned status regression workspace; do not inspect parent directories.\n');
  let requests = 0;
  let expectedOutcome = 'completed';
  const observations = [];
  const provider = createServer(async (request, response) => {
    try {
      let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024); }
      const index = requests++;
      assert.ok(index < 9, 'provider fixture request budget');
      observations.push({ index, method: request.method, path: request.url, expectedOutcome });
      if (request.method === 'GET' && request.url?.endsWith('/models')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture', object: 'model' }] }));
        return;
      }
      if (expectedOutcome === 'failed') {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Owned deterministic failure' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Owned completed status result.' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch { response.writeHead(400); response.end('Owned fixture rejected request'); }
  });
  await new Promise(accept => provider.listen(0, '127.0.0.1', accept));
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1`;
  const settings = { credential_store: 'file', max_retries: 0, active_provider: 'nativeFixture', model: 'fixture', mcp_servers: [],
    providers: { nativeFixture: { api_format: 'openai_chat_completions', endpoint, default_model: 'fixture',
      authentication: { mode: 'none' }, discover_models: false, context_window_tokens: 128000, max_output_tokens: 256, output_headroom_tokens: 1024 } } };
  await writeFile(join(profile, 'settings.json'), JSON.stringify(settings));
  const child = spawn(binary, ['--cwd', workspace, 'app-server'], { cwd: workspace,
    env: { ...environment, KCODER_CONFIG_DIR: profile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.pipe(process.stderr);
  const client = new AppServerStdioClient('owned-task-status', child, { notificationHistoryLimit: 128 });
  const rpc = async (method, params) => {
    const reply = await client.request(method, params, 45000);
    assert.ok(!reply.error, `${method} rejected: ${reply.error?.message}`);
    return reply.result;
  };
  const readStatus = async threadId => {
    const result = await rpc('thread/list', { limit: 100 });
    const thread = result.threads.find(item => item.id === threadId);
    assert.ok(thread, 'original Native thread remains listed');
    return thread.runSummary;
  };
  async function pointerFor(directory, threadId, depth = 0) {
    assert.ok(depth <= 12);
    const entries = await readdir(directory, { withFileTypes: true });
    assert.ok(entries.length <= 4096);
    for (const entry of entries) {
      assert.equal(entry.isSymbolicLink(), false, 'owned fixture must not follow links');
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === 'recent-turn-error.json' && basename(dirname(path)) === threadId) return path;
      if (entry.isDirectory()) { const found = await pointerFor(path, threadId, depth + 1); if (found) return found; }
    }
    return null;
  }
  async function latestIdentity(pointer) {
    const directory = join(dirname(pointer), 'turn-attempts');
    const records = [];
    for (const leaf of await readdir(directory)) if (leaf.endsWith('.attempt.json')) records.push(JSON.parse(await readFile(join(directory, leaf), 'utf8')));
    records.sort((a, b) => b.accepted_at_ms - a.accepted_at_ms);
    assert.ok(records[0]?.identity);
    return records[0].identity;
  }
  try {
    await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-task-status-probe', version: '1' }, capabilities: { experimental: { threadRunSummaryV1: true } } });
    const { thread } = await rpc('thread/start', { cwd: workspace });
    async function turn(expected) {
      expectedOutcome = expected;
      const started = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Run the owned lifecycle fixture.' }] });
      const terminal = await client.waitForNotification(frame => frame.method === 'turn/completed' && frame.params.threadId === thread.id && frame.params.turn?.id === started.turn.id, 45000);
      assert.equal(terminal.params.turn.status, expected, JSON.stringify({ requests, observations }));
    }
    await turn('completed');
    const pointer = await pointerFor(join(profile, 'projects'), thread.id);
    assert.ok(pointer);
    const first = await latestIdentity(pointer);
    await writeFile(pointer, JSON.stringify({ version: 1, identity: null }));
    assert.equal((await readStatus(thread.id)).latestTurnStatus, 'completed', 'empty pointer must recover original completion');
    await unlink(pointer);
    assert.equal((await readStatus(thread.id)).latestTurnStatus, 'completed', 'missing pointer must recover original completion');
    await turn('failed');
    const second = await latestIdentity(pointer);
    await writeFile(pointer, JSON.stringify({ version: 1, identity: first }));
    assert.equal((await readStatus(thread.id)).latestTurnStatus, 'failed', 'old success must not conceal the new failure');
    await turn('completed');
    await writeFile(pointer, JSON.stringify({ version: 1, identity: second }));
    const current = await readStatus(thread.id);
    assert.equal(current.latestTurnStatus, 'completed', 'old failure must not override new completion');
    assert.equal(current.recentError, null);
    assert.ok(requests >= 3 && requests <= 9);
    return { passed: true, emptyPointerRecovered: true, missingPointerRecovered: true, oldSuccessCannotHideFailure: true,
      oldFailureCannotHideCompletion: true, fixtureProviderRequests: requests, fixtureHttpObservation: observations, realProviderRequests: 0,
      scope: 'actual packaged Windows Native; private synthetic session; no personal data or GUI acceptance' };
  } finally {
    child.stdin.end();
    try { await waitForStdioChildClose(child, 10000); }
    finally {
      client.closeReader();
      provider.closeAllConnections();
      await new Promise(accept => provider.close(accept));
    }
  }
}
