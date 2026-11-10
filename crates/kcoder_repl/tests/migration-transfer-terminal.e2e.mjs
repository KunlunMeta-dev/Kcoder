// Actual node-pty → KCoder → official xterm/WebGL; HTTP is a fixed protocol fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from '../../../tools/tui-lab/node_modules/ws/wrapper.mjs';
import { chromium } from '../../../tools/tui-lab/node_modules/@playwright/test/index.mjs';
import { parseArgs, defaultCommandString, browserLaunchOptions } from '../../../tools/tui-lab/lib/runner-options.mjs';
import { createRunContext } from '../../../tools/tui-lab/lib/run-context.mjs';
import { defaultWorkspaceTemplate, repoRoot, runContextRuntime } from '../../../tools/tui-lab/lib/runtime-paths.mjs';
import { startSession } from '../../../tools/tui-lab/lib/session.mjs';
import { typeHumanText, waitForTerminalText } from '../../../tools/tui-lab/lib/terminal-interaction.mjs';
import { writeStartMeta, writeJsonArtifact, writeTextArtifact, writeFailureArtifacts } from '../../../tools/tui-lab/lib/runtime-artifacts.mjs';
import { attachBrowserConsole } from '../../../tools/tui-lab/lib/browser-evidence.mjs';

assert.equal(process.platform, 'linux', 'this acceptance uses Linux PTY ownership');
const options = parseArgs(['run', '--software-webgl', '--cols', '160', '--rows', '60', ...process.argv.slice(2)], { defaultWorkspaceTemplate });
assert.ok(options.description); options.repoRoot = repoRoot;
const artifacts = await createRunContext(options, 'migration-transfer-terminal', runContextRuntime());
const binary = path.join(artifacts.configHome, 'owned-bin/kcoder');
await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
await fs.copyFile(process.env.KCODER_MIGRATION_TUI_BINARY || path.join(repoRoot, 'target/debug/kcoder'), binary);
await fs.chmod(binary, 0o700);
options.commandOverride = `exec '${binary.replaceAll("'", "'\\''")}' --cwd {workspace} tui-dev --scenario full-turn`;
const runOptions = { ...options, runDir: artifacts.dir, workspaceDir: artifacts.workspace, requestsDir: artifacts.requestsDir, configHome: artifacts.configHome };
const command = defaultCommandString(runOptions);
await writeStartMeta(artifacts, runOptions, command, 'migration-transfer-terminal');
await fs.mkdir(artifacts.configDir, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(artifacts.configDir, 'settings.json'), JSON.stringify({ provider: 'local', local_base_url: 'http://127.0.0.1:9', api_format: 'openai_chat_completions', model: 'fixture-model' }), { mode: 0o600 });
const requestId = '11111111-1111-4111-8111-111111111111';
const input = path.join(artifacts.configDir, 'transfer-read.json');
await fs.writeFile(input, JSON.stringify({ requestId, target: { sessionId: '22222222-2222-4222-8222-222222222222', purpose: 'target_recovery', targetId: 'owned-target' } }), { mode: 0o600 });
const calls = [];
const rpcCalls = [];
const fixture = createServer(async (request, response) => {
  const parts = []; for await (const bytes of request) parts.push(bytes);
  calls.push({ method: request.method, url: request.url });
  let result;
  if (request.url === '/api/servers') result = { servers: [{ id: 'owned-target', label: 'PTY protocol fixture', transport: 'local', command: 'PRIVATE_COMMAND_MUST_NOT_APPEAR' }] };
  else {
    assert.equal(request.url, '/api/migration/source-transfer/target-read');
    assert.equal(JSON.parse(Buffer.concat(parts)).requestId, requestId);
    result = { requestId, coordinatorState: 'idle', observation: 'unobserved', result: null, progress: null, errorCode: null };
  }
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
});
const sockets = new WebSocketServer({ noServer: true });
fixture.on('upgrade', (request, socket, head) => {
  assert.equal(request.headers.authorization, `Bearer ${'1'.repeat(64)}`);
  const selected = new URL(request.url, 'http://fixture.invalid');
  assert.equal(selected.pathname, '/rpc'); assert.equal(selected.searchParams.get('server'), 'owned-target');
  sockets.handleUpgrade(request, socket, head, connection => {
    connection.on('message', bytes => {
      const request = JSON.parse(bytes); rpcCalls.push(request.method);
      const result = request.method === 'initialize'
        ? { protocolVersion: '2026-07-27', capabilities: { experimental: { migrationBatchV1: true, migrationBatchWorkersV1: true } } }
        : { state: { job: { jobId: 'mig-11111111111111111111111111111111', sourceId: 'opaque-fixture', status: 'ready', sequence: 1,
          totalItems: 1, committedItems: 0, requiresActionItems: 0 }, source: 'claude-code', plans: [], mcpPlans: [], assetPlans: [], issues: [] },
        workerRunning: false, workerError: null, progress: null };
      assert.ok(['initialize', 'migration/batch/read'].includes(request.method));
      connection.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  });
});
await new Promise(resolveListen => fixture.listen(0, '127.0.0.1', resolveListen));
const port = fixture.address().port;
await writeJsonArtifact(path.join(artifacts.dir, 'owned-http-fixture.json'), { port, pid: process.pid, owner: 'migration-transfer-terminal test', fixedProtocolFixture: true });
let session, browser, page;
const browserConsole = [], trace = [];
const oldToken = process.env.KCODER_OWNED_TRANSFER_PTY_ACCESS;
process.env.KCODER_OWNED_TRANSFER_PTY_ACCESS = '1'.repeat(64);
try {
  session = await startSession(runOptions);
  if (oldToken === undefined) delete process.env.KCODER_OWNED_TRANSFER_PTY_ACCESS; else process.env.KCODER_OWNED_TRANSFER_PTY_ACCESS = oldToken;
  browser = await chromium.launch(browserLaunchOptions(options));
  page = await browser.newPage({ viewport: { width: 1600, height: 1250 } }); attachBrowserConsole(page, browserConsole);
  await page.goto(session.url); await page.waitForFunction(() => window.tuiLab?.ready, null, { timeout: options.timeoutMs });
  await waitForTerminalText(page, 'TUI dev mode', options.timeoutMs);
  assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
  const prefix = `/migrate transfer --gateway http://127.0.0.1:${port} --access-token-env KCODER_OWNED_TRANSFER_PTY_ACCESS`;
  async function submit(suffix, expected) {
    await page.evaluate(() => window.tuiLab.focus()); await typeHumanText(page, `${prefix} ${suffix}`); await page.evaluate(() => window.tuiLab.sendInput('\r'));
    await waitForTerminalText(page, expected, 20000); trace.push({ operation: suffix.split(' ').slice(0, 2), expected });
    return page.evaluate(() => window.tuiLab.text());
  }
  const targets = await submit('targets', 'PTY protocol fixture'); assert.ok(!targets.includes('PRIVATE_COMMAND_MUST_NOT_APPEAR'));
  await submit(`copy target-read --input "${input}"`, '"observation": "unobserved"');
  assert.equal(calls.length, 2);
  await page.screenshot({ path: path.join(artifacts.dir, 'terminal-target-only-observation.png') });
  await submit(`copy target-finish --input "${input}"`, 'source_transfer_confirmation_required');
  assert.equal(calls.length, 2, 'missing confirmation must not reach even the HTTP fixture');
  const batchInput = path.join(artifacts.configDir, 'remote-batch-read.json');
  await fs.writeFile(batchInput, JSON.stringify({ jobId: 'mig-11111111111111111111111111111111' }), { mode: 0o600 });
  await submit(`batch --target-id owned-target read --input "${batchInput}"`, '"sourceId": "opaque-fixture"');
  assert.deepEqual(rpcCalls, ['initialize', 'migration/batch/read']);
  await page.screenshot({ path: path.join(artifacts.dir, 'terminal-remote-batch-read.png') });
  const requests = await fs.readdir(artifacts.requestsDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.equal(requests.filter(name => name.endsWith('.json')).length, 0, 'migration commands never enter model requests');
  const assertions = { ok: true, renderer: 'webgl', protocolFixture: true, nativeTransferClaimed: false,
    targetsAllowlisted: true, targetRecoveryRead: true, confirmationBeforeHttp: true, remoteBatchRead: true, modelRequests: 0,
    binarySha256: createHash('sha256').update(await fs.readFile(binary)).digest('hex'), calls, rpcCalls, trace };
  await writeTextArtifact(path.join(artifacts.dir, 'screen.txt'), await page.evaluate(() => window.tuiLab.text()));
  await writeJsonArtifact(path.join(artifacts.dir, 'assertions.json'), assertions);
  await browser.close(); browser = undefined; await session.stop(); await session.exitPromise;
  await writeJsonArtifact(path.join(artifacts.dir, 'meta.json'), { ...assertions, ptyExit: session.getExitInfo(), diagnostics: session.getDiagnostics() });
  console.log(JSON.stringify({ ok: true, directory: artifacts.dir }));
} catch (error) {
  await writeFailureArtifacts({ artifacts, runOptions, command, mode: 'migration-transfer-terminal', session, page, browserConsole, trace, error }); throw error;
} finally {
  if (oldToken === undefined) delete process.env.KCODER_OWNED_TRANSFER_PTY_ACCESS; else process.env.KCODER_OWNED_TRANSFER_PTY_ACCESS = oldToken;
  if (browser) await browser.close(); if (session) await session.stop();
  for (const client of sockets.clients) client.terminate();
  await new Promise(resolveClose => sockets.close(resolveClose));
  await new Promise(resolveClose => { fixture.close(resolveClose); fixture.closeAllConnections(); });
}
