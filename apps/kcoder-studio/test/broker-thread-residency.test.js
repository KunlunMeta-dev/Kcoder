import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';
import { allowsThreadResidencyNotification, projectThreadResidencyNotification, projectThreadResidencyResponse } from '../src/broker-thread-residency.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true, maxMessageBytes: 1024 * 1024, serverId: 'thread-residency',
    adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }), fromUpstream: message => ({ upstream: [], client: [message] }) } });
  const requests = []; let partial = '';
  child.stdin.on('data', bytes => {
    partial += bytes.toString('utf8');
    while (partial.includes('\n')) { const end = partial.indexOf('\n'); requests.push(JSON.parse(partial.slice(0, end))); partial = partial.slice(end + 1); }
  });
  const client = () => {
    const owner = { channel: 'runtime', authorizationOwner: 'same-workspace', messages: [],
      send(value) { this.messages.push(value); return true; }, pause() {}, resume() {}, close() {} };
    broker.attach(owner); return owner;
  };
  const initialize = (owner, id, experimental) => broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize',
    params: { protocolVersion: '2026-07-27', clientInfo: { name: 'thread-residency', version: '1' }, capabilities: { experimental } } }));
  const reply = value => child.stdout.write(JSON.stringify(value) + '\n');
  return { broker, requests, client, initialize, reply };
}

test('the shared backend always opts in while each client sees only its own residency capabilities', async () => {
  const f = fixture();
  const typed = f.client(), legacy = f.client();
  f.initialize(typed, 1, { threadResidencyV1: true, threadMaintenanceV1: true });
  await tick();
  const backend = f.requests.at(-1);
  assert.equal(backend.params.capabilities.experimental.threadResidencyV1, true);
  assert.equal(backend.params.capabilities.experimental.threadMaintenanceV1, true);
  f.reply({ jsonrpc: '2.0', id: backend.id, result: { protocolVersion: '2026-07-27', serverInfo: { name: 'fixture', version: '1' },
    capabilities: { experimental: { residentThreads: true, threadResidencyV1: true, threadMaintenanceV1: true } } } });
  await tick();
  f.initialize(legacy, 1, {});
  await tick();
  const experimental = owner => owner.messages.find(message => message.id === 1).result.capabilities.experimental;
  assert.equal(experimental(typed).threadResidencyV1, true);
  assert.equal(experimental(typed).threadMaintenanceV1, true);
  assert.equal(experimental(legacy).threadResidencyV1, false);
  assert.equal(experimental(legacy).threadMaintenanceV1, false);

  // The broker forwards; the typed rejection reaches only an opted-in client unchanged.
  for (const [owner, id] of [[typed, 7], [legacy, 8]]) {
    f.broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id, method: 'turn/start', params: { threadId: 'evicted-thread', input: [] } }));
    await tick();
    const upstream = f.requests.at(-1);
    assert.equal(upstream.method, 'turn/start');
    f.reply({ jsonrpc: '2.0', id: upstream.id, error: { code: -32027, message: 'thread is not resident; thread/resume it and retry',
      data: { threadId: 'evicted-thread', reason: 'capacity' } } });
    await tick();
  }
  assert.deepEqual(typed.messages.find(message => message.id === 7).error,
    { code: -32027, message: 'thread is not resident; thread/resume it and retry', data: { threadId: 'evicted-thread', reason: 'capacity' } });
  assert.deepEqual(legacy.messages.find(message => message.id === 8).error,
    { code: -32025, message: 'turn threadId does not match active thread' });
});

test('legacy clients keep pre-capability busy codes and never receive residency notifications', () => {
  const legacy = {}, typed = { threadResidencyV1: true, threadMaintenanceV1: true };
  const busy = { jsonrpc: '2.0', id: 3, error: { code: -32028, message: 'thread compact is in progress; retry after it completes',
    data: { threadId: 't', operation: 'compact' } } };
  assert.deepEqual(projectThreadResidencyResponse(busy, { client: legacy, method: 'turn/start' }).error,
    { code: -32003, message: 'Turn already running' });
  assert.equal(projectThreadResidencyResponse(busy, { client: legacy, method: 'thread/rollback' }).error.code, -32031);
  assert.equal(projectThreadResidencyResponse(busy, { client: typed, method: 'turn/start' }), busy);
  for (const method of ['thread/evicted', 'thread/maintenance']) {
    assert.equal(allowsThreadResidencyNotification({ method, params: { threadId: 't' } }, legacy), false);
    assert.equal(allowsThreadResidencyNotification({ method, params: { threadId: 't' } }, typed), true);
  }
  assert.equal(allowsThreadResidencyNotification({ method: 'turn/completed' }, legacy), true);
});

test('compaction cancellation preserves old payloads and requires the bound client', async () => {
  const f = fixture();
  const owner = f.client(), observer = f.client(), old = f.client();
  const opts = { threadMaintenanceV1: true, threadMaintenanceCancelV1: true };
  f.initialize(owner, 1, opts);
  await tick();
  const init = f.requests.at(-1);
  assert.equal(init.params.capabilities.experimental.threadMaintenanceCancelV1, true);
  f.reply({ jsonrpc: '2.0', id: init.id, result: {
    protocolVersion: '2026-07-27', serverInfo: { name: 'fixture', version: '1' },
    capabilities: { experimental: { residentThreads: true, ...opts } },
  } });
  await tick();
  f.initialize(observer, 1, opts);
  f.initialize(old, 1, { threadMaintenanceV1: true });
  await tick();
  const experimental = client => client.messages.find(message => message.id === 1).result.capabilities.experimental;
  assert.equal(experimental(owner).threadMaintenanceCancelV1, true);
  assert.equal(experimental(old).threadMaintenanceCancelV1, false);

  f.broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'thread/start', params: {} }));
  await tick();
  const started = f.requests.at(-1);
  assert.equal(started.method, 'thread/start');
  f.reply({ jsonrpc: '2.0', id: started.id, result: { thread: { id: 't', cwd: '/fixture' } } });
  await tick();

  const maintenanceId = '00000000-0000-4000-8000-000000000001';
  const params = { threadId: 't', maintenanceId };
  const message = { jsonrpc: '2.0', method: 'thread/maintenance', params: { ...params, operation: 'compact', status: 'started' } };
  assert.equal(projectThreadResidencyNotification(message, owner), message);
  assert.deepEqual(projectThreadResidencyNotification(message, old).params,
    { threadId: 't', operation: 'compact', status: 'started' });
  const cancel = client => f.broker.receive(client, JSON.stringify({
    jsonrpc: '2.0', id: 7, method: 'thread/maintenance/cancel', params,
  }));
  const before = f.requests.length;
  cancel(old);
  cancel(observer);
  await tick();
  assert.equal(old.messages.find(reply => reply.id === 7).error.code, -32601);
  assert.equal(observer.messages.find(reply => reply.id === 7).error.code, -32023);
  assert.equal(f.requests.length, before);

  cancel(owner);
  await tick();
  assert.equal(f.requests.at(-1).method, 'thread/maintenance/cancel');
  assert.deepEqual(f.requests.at(-1).params, params);
});
