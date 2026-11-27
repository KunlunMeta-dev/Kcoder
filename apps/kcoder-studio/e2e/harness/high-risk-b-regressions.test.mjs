import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { RunContext } from './run-context.mjs';
import { startCredentialObserver } from './credential-observer.mjs';
import { HeaderWebSocket } from './header-websocket.mjs';
import { startLiveModelObserver } from './live-model-observer.mjs';
import { artifactTransferPlan } from './windows-artifact-transfer.mjs';
import { nativePeerDiagnosticReader } from './native-stderr-diagnostics.mjs';
import { signalProcessTree, processTreeAlive, stopSupervisedProcess, supervisedChildEnvironment } from './owned-process.mjs';
import { isOwnedGatewayObserverProcess } from './broker-ownership-observer.mjs';
import { fileURLToPath } from 'node:url';
import { waitForSelectedModel } from './model-selector.mjs';
import { verifyProductionWidgetLifecycle } from './widget-production-lifecycle.mjs';
import vm from 'node:vm';

test('a supervised Gateway keeps the exact parent observer gate without extending it to descendants', () => {
  const original = { KCODER_E2E_BROKER_OWNERSHIP_OBSERVER: '1', KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID: '42' };
  const env = supervisedChildEnvironment(original, 43, 42);
  const scope = { env, parentPid: 43, mainThread: true, argv: ['node', fileURLToPath(new URL('../../dev-server.mjs', import.meta.url))] };
  assert.equal(isOwnedGatewayObserverProcess(scope), true);
  assert.equal(isOwnedGatewayObserverProcess({ ...scope, parentPid: 44 }), false);
  assert.equal(original.KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID, '42');
  assert.equal(supervisedChildEnvironment(original, 43, 99).KCODER_E2E_BROKER_OWNERSHIP_OBSERVER_OWNER_PID, '42');
});

test('supervisor stop reconciles a lost control write with the original retained close receipt', async () => {
  let closes = 0, attempts = 0, resolveClose;
  const identity = { pid: 42, nonce: 'owned-stop', closed: false, closedPromise: new Promise(resolve => { resolveClose = resolve; }) };
  const child = { pid: 42, stdin: { destroy() { if (identity.closed) return; closes++; identity.closed = true; resolveClose({ code: 1 }); } } };
  await stopSupervisedProcess(child, identity, { signal: async () => { attempts++; throw new Error('control receipt lost'); } });
  await stopSupervisedProcess(child, identity, { signal: async () => { attempts++; } });
  assert.equal(attempts, 1); assert.equal(closes, 1);
});

test('supervisor stop without a close receipt stays unconfirmed instead of authorizing state deletion', async () => {
  const child = { pid: 42, stdin: { destroy() {} } };
  const identity = { pid: 42, nonce: 'owned-stop', closed: false, closedPromise: new Promise(() => {}) };
  await assert.rejects(stopSupervisedProcess(child, identity, { timeoutMs: 10, signal: async () => {} }), { code: 'OWNED_SUPERVISOR_EXIT_UNCONFIRMED' });
  assert.equal(identity.closed, false);
});

test('Windows artifact leaves cannot escape the run or replace its ownership metadata', () => {
  const valid = { owner: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', root: 'D:\\owned', leaf: 'package.exe', sha256: 'a'.repeat(64), bytes: 123 };
  assert.equal(artifactTransferPlan(valid).leaf, 'package.exe');
  for (const leaf of ['.', '..', '.owner.json', '.parts-abc', 'package.', 'a..b', 'CON', 'nul.txt', 'COM1.exe', 'LPT9']) {
    assert.throws(() => artifactTransferPlan({ ...valid, leaf }));
  }
});

test('stderr diagnostics retain complete lines from a burst and expose consumer failures', () => {
  const frame = JSON.stringify({ event: 'native_channel_peer_control_unconfirmed', stage: 'original_ui_call', reasonSha256: 'a'.repeat(64) }) + '\n';
  const records = [], reader = nativePeerDiagnosticReader(record => records.push(record));
  reader(Buffer.from(frame + 'x'.repeat(16000) + '\n' + frame));
  assert.equal(records.length, 2);
  reader(Buffer.from('null\n'));
  const failing = nativePeerDiagnosticReader(() => { throw new Error('consumer-failure'); });
  assert.throws(() => failing(Buffer.from(frame)), /consumer-failure/);
});

test('invalid owned process group identities never reach the OS signal primitive', { skip: process.platform === 'win32' }, async t => {
  let signals = 0;
  t.mock.method(process, 'kill', () => { signals++; });
  for (const pgid of [null, undefined, 0, -1, Number.NaN]) {
    const identity = { pid: process.pid, pgid };
    await assert.rejects(signalProcessTree({}, identity, 'SIGTERM'), /group identity/);
    await assert.rejects(processTreeAlive({}, identity), /group identity/);
  }
  assert.equal(signals, 0);
});

test('selected model waiting retries a transient remount error within the same menu lease', async () => {
  let open = false, reads = 0;
  const trigger = { waitFor: async () => {}, getAttribute: async () => String(open), isVisible: async () => true,
    isEnabled: async () => true, click: async () => { open = !open; } };
  const current = { isVisible: async () => true, innerText: async ({ timeout }) => {
    assert.ok(timeout > 0 && timeout <= 1000);
    if (++reads === 1) throw Object.assign(new Error('transient remount'), { name: 'TimeoutError' });
    return 'original-model';
  } };
  assert.equal(await waitForSelectedModel({ getByTestId: id => id === 'model-selector-button' ? trigger : current }, 'original-model', 1000), 'original-model');
  assert.equal(reads, 2); assert.equal(open, false);
});

test('model waiting tolerates its first trigger disappearing without claiming an earlier menu lease', async () => {
  let open = false, inspected = 0;
  const trigger = { waitFor: async () => {}, getAttribute: async () => {
    if (++inspected === 1) throw Object.assign(new Error('trigger detached'), { name: 'TimeoutError' });
    return String(open);
  }, isVisible: async () => true, isEnabled: async () => true, click: async () => { open = !open; } };
  const current = { isVisible: async () => true, innerText: async () => 'original-model' };
  assert.equal(await waitForSelectedModel({ getByTestId: id => id === 'model-selector-button' ? trigger : current }, 'original-model', 1000), 'original-model');
  assert.ok(inspected > 1); assert.equal(open, false);
});

test('widget lifecycle releases its owned final-response gate on the first observation failure', async () => {
  let releases = 0;
  const failure = new Error('owned observation failed');
  await assert.rejects(verifyProductionWidgetLifecycle({}, { getByText: () => ({ waitFor: async () => { throw failure; } }) }, () => releases++), error => error === failure);
  assert.equal(releases, 1);
});

for (const kind of ['json', 'unterminated-sse']) {
  test(`live model observer retains usage for ${kind} without altering the upstream body`, async () => {
    const context = await RunContext.create(import.meta.url, { testId: `live-observer-${kind}` });
    try {
      const frame = { choices: [{ message: { tool_calls: [{ function: { name: 'Example', arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } };
      const body = kind === 'json' ? JSON.stringify(frame) : `data: ${JSON.stringify(frame)}`;
      const upstream = await ownedServer(context, 'model-upstream', (request, response) => {
        request.resume(); response.writeHead(200, { 'content-type': kind === 'json' ? 'application/json' : 'text/event-stream' }); response.end(body);
      });
      const observer = await startLiveModelObserver(context, upstream.origin, 1);
      const response = await fetch(`${observer.endpoint}/chat/completions`, { method: 'POST', body: '{}' });
      assert.equal(await response.text(), body);
      const [record] = observer.observations;
      assert.equal(record.inputUsage, 12); assert.equal(record.outputUsage, 8); assert.equal(record.stopReason, 'tool_calls');
      assert.deepEqual(record.tools, [{ name: 'Example', chars: 7, valid: true }]);
      await context.finish('passed', { diagnosticShapeOnly: true });
    } finally { if (!context.finished) await context.finish('failed', null, new Error('observer complete frame regression failed')); }
  });
}

test('live model observer aborts its owned upstream when the client disconnects', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'live-observer-disconnect' });
  try {
    let upstreamClosed;
    const closed = new Promise(resolve => { upstreamClosed = resolve; });
    const upstream = await ownedServer(context, 'model-upstream', (request, response) => {
      request.resume(); response.once('close', upstreamClosed); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: {}\n\n');
    });
    const observer = await startLiveModelObserver(context, upstream.origin, 1, { requestTimeoutMs: 30000 });
    const cancel = new AbortController();
    const response = await fetch(`${observer.endpoint}/chat/completions`, { method: 'POST', body: '{}', signal: cancel.signal });
    await response.body.getReader().read(); cancel.abort();
    await Promise.race([closed, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('upstream did not stop')), 1000); timeout.unref(); closed.then(() => clearTimeout(timeout)); })]);
    await context.finish('passed', { upstreamCancelled: true });
  } finally { if (!context.finished) await context.finish('failed', null, new Error('observer disconnect regression failed')); }
});

async function ownedServer(context, label, handler) {
  const server = createServer(handler);
  context.addCleanup(`close ${label}`, async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.registerPort(label, server.address().port);
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

test('credential observer rejects a request target that overrides its pinned upstream', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'credential-observer-target' });
  try {
    let received = 0;
    const trap = await ownedServer(context, 'external-target-trap', (_request, response) => { received++; response.end('unexpected'); });
    const upstream = await ownedServer(context, 'pinned-upstream', (_request, response) => { received++; response.end('unexpected'); });
    const observer = await startCredentialObserver(context, upstream.origin, { label: 'observer', oldKey: 'synthetic-old', newKey: 'synthetic-new' });
    for (const path of [`//127.0.0.1:${trap.server.address().port}/collect`, `${trap.origin}/collect`]) {
      await new Promise(resolve => {
        const request = httpRequest(observer.endpoint, { method: 'POST', path }, response => { response.resume(); response.once('end', resolve); });
        request.once('error', resolve);
        request.end('synthetic-payload');
      });
    }
    assert.equal(received, 0);
    await context.finish('passed', { escapedRequests: 0 });
  } finally { if (!context.finished) await context.finish('failed', null, new Error('observer target regression failed')); }
});

test('credential observer forwards a delta before the upstream stream completes', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'credential-observer-streaming' });
  try {
    let release;
    const upstream = await ownedServer(context, 'streaming-upstream', (request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: first\n\n');
      release = () => response.end('data: last\n\n');
    });
    const observer = await startCredentialObserver(context, upstream.origin, { label: 'observer', oldKey: 'synthetic-old', newKey: 'synthetic-new' });
    const response = await fetch(`${observer.endpoint}/chat/completions`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /data: first/);
    release();
    let last = '';
    for (;;) { const part = await reader.read(); if (part.done) break; last += new TextDecoder().decode(part.value); }
    assert.match(last, /data: last/);
    await context.finish('passed', { incrementalDelivery: true });
  } finally { if (!context.finished) await context.finish('failed', null, new Error('observer streaming regression failed')); }
});

test('HeaderWebSocket completes a client initiated close without a write after end', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'header-websocket-close' });
  try {
    const fixture = await ownedServer(context, 'websocket-listener', (_request, response) => response.end());
    const server = new WebSocketServer({ server: fixture.server });
    context.addCleanup('close websocket peers', async () => { for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); });
    const socket = new HeaderWebSocket(fixture.origin.replace('http:', 'ws:'));
    const errors = [];
    socket.addEventListener('error', event => errors.push(event.message));
    const closed = new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
    context.addCleanup('close owned client transport', () => socket.socket.destroy());
    await Promise.race([new Promise(resolve => socket.addEventListener('open', resolve, { once: true })), once(socket.socket, 'error')]);
    socket.close();
    await closed;
    assert.deepEqual(errors, []);
    await context.finish('passed', { gracefulClose: true });
  } finally { if (!context.finished) await context.finish('failed', null, new Error('websocket close regression failed')); }
});
