import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(t) {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true, serverId: 'owned-expert',
    maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: message => ({ upstream: [message], client: [] }),
      fromUpstream: message => ({ upstream: [], client: [message] }) } });
  t.after(() => broker.clearTransientState());
  const requests = [];
  child.stdin.on('data', bytes => requests.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const client = (channel = 'runtime') => {
    const peer = { channel, messages: [], send(message) { this.messages.push(message); return true; },
      pause() {}, resume() {}, close() {} };
    broker.attach(peer); return peer;
  };
  const send = async (peer, id, method, params) => {
    const count = requests.length;
    broker.receive(peer, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    await new Promise(resolve => setImmediate(resolve));
    return requests.length > count ? requests.at(-1) : null;
  };
  const initialize = (peer, id, offered) => send(peer, id, 'initialize', {
    protocolVersion: '2026-07-27', clientInfo: { name: 'owned-expert-client', version: '1' },
    capabilities: { experimental: offered === undefined ? {} : { agentTurnConfigurationV1: offered } },
  });
  const respond = async (request, result) => {
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    await new Promise(resolve => setImmediate(resolve));
  };
  const ready = (request, supported = true) => respond(request, {
    protocolVersion: '2026-07-27', capabilities: { experimental: { residentThreads: true,
      ...(supported ? { agentTurnConfigurationV1: true } : {}) } },
  });
  return { broker, requests, client, send, initialize, respond, ready };
}

for (const mode of ['cached', 'waiter']) test(`expert creation survives a management-first backend (${mode})`, async t => {
  const f = fixture(t), management = f.client('control'), runtime = f.client();
  const original = await f.initialize(management, 'management', undefined);
  assert.equal(original.params.capabilities.experimental.agentDefinitionsV1, true);
  const initialize = peer => f.send(peer, 'runtime', 'initialize', {
    protocolVersion: '2026-07-27', clientInfo: { name: 'expert-runtime', version: '1' },
    capabilities: { experimental: { agentDefinitionsV1: true, studioWorkModesV1: true } },
  });
  if (mode === 'waiter') await initialize(runtime);
  await f.respond(original, { protocolVersion: '2026-07-27', capabilities: { experimental: {
    residentThreads: true, agentDefinitionsV1: true, studioWorkModesV1: true,
  } } });
  if (mode === 'cached') await initialize(runtime);
  assert.equal(management.messages.at(-1).result.capabilities.experimental.agentDefinitionsV1, false);
  assert.equal(runtime.messages.at(-1).result.capabilities.experimental.agentDefinitionsV1, true);
  const agentDefinition = { id: 'personal.expert', version: '1', definitionSha256: 'a'.repeat(64) };
  const started = await f.send(runtime, 'create-expert', 'thread/start', { agentDefinition, studioWorkMode: 'kcoder' });
  assert.ok(started, JSON.stringify(runtime.messages.at(-1)));
  assert.deepEqual(started.params.agentDefinition, agentDefinition);
  assert.equal(f.requests.filter(request => request.method === 'initialize').length, 1);
  const legacy = f.client(); await f.initialize(legacy, 'legacy', false);
  assert.equal(legacy.messages.at(-1).result.capabilities.experimental.agentDefinitionsV1, false);
  assert.equal(await f.send(legacy, 'unnegotiated-expert', 'thread/start', { agentDefinition }), null);
  assert.match(legacy.messages.at(-1).error.message, /agentDefinitionsV1/);
});

test('an older backend cannot gain expert creation support from a newer frontend', async t => {
  const f = fixture(t), current = f.client();
  const request = await f.send(current, 'current', 'initialize', {
    protocolVersion: '2026-07-27', clientInfo: { name: 'expert-runtime', version: '1' },
    capabilities: { experimental: { agentDefinitionsV1: true } },
  });
  await f.ready(request, false);
  assert.notEqual(current.messages.at(-1).result.capabilities.experimental.agentDefinitionsV1, true);
  assert.equal(await f.send(current, 'expert', 'thread/start', {
    agentDefinition: { id: 'personal.expert', version: '1', definitionSha256: 'a'.repeat(64) },
  }), null);
  assert.match(current.messages.at(-1).error.message, /agentDefinitionsV1/);
});

for (const mode of ['cached', 'waiter']) test(`expert negotiation survives a legacy first client (${mode})`, async t => {
  const f = fixture(t), legacy = f.client(), current = f.client();
  const original = await f.initialize(legacy, 'legacy', undefined);
  assert.equal(original.params.capabilities.experimental.agentTurnConfigurationV1, true);
  if (mode === 'waiter') await f.initialize(current, 'current', true);
  await f.ready(original);
  if (mode === 'cached') await f.initialize(current, 'current', true);
  assert.equal(legacy.messages.at(-1).result.capabilities.experimental.agentTurnConfigurationV1, false);
  assert.equal(current.messages.at(-1).result.capabilities.experimental.agentTurnConfigurationV1, true);
  const declined = f.client(); await f.initialize(declined, 'declined', false);
  assert.equal(declined.messages.at(-1).result.capabilities.experimental.agentTurnConfigurationV1, false);
  assert.equal(f.requests.length, 1, 'The shared backend initializes once regardless of client order');
  assert.equal(await f.send(legacy, 'old-expert', 'thread/expert', { threadId: 'thread' }), null);
  assert.match(legacy.messages.at(-1).error.message, /negotiation/);
});

test('a capable frontend cannot invent expert support on an older Native backend', async t => {
  const f = fixture(t), current = f.client();
  await f.ready(await f.initialize(current, 'current', true), false);
  assert.notEqual(current.messages.at(-1).result.capabilities.experimental.agentTurnConfigurationV1, true);
  assert.equal(await f.send(current, 'expert', 'thread/expert', { threadId: 'thread' }), null);
  assert.match(current.messages.at(-1).error.message, /negotiation/);
});

test('expert reads and changes retain the original task owner and reject invalid revisions', async t => {
  const f = fixture(t), owner = f.client(), peer = f.client();
  await f.ready(await f.initialize(owner, 'owner', true));
  await f.initialize(peer, 'peer', true);
  const resume = await f.send(owner, 'resume', 'thread/resume', { threadId: 'thread' });
  await f.respond(resume, { thread: { id: 'thread' } });
  const read = await f.send(owner, 'read', 'thread/expert', { threadId: 'thread' });
  assert.ok(read);
  await f.respond(read, { threadId: 'thread', revision: 0, expert: null, turns: [] });
  const change = await f.send(owner, 'change', 'thread/expert', {
    threadId: 'thread', change: { expectedRevision: 0, expert: null },
  });
  assert.ok(change);
  await f.respond(change, { threadId: 'thread', revision: 1, expert: null, turns: [] });
  assert.equal(await f.send(peer, 'foreign', 'thread/expert', { threadId: 'thread' }), null);
  assert.ok(peer.messages.at(-1).error);
  assert.equal(await f.send(owner, 'invalid', 'thread/expert', {
    threadId: 'thread', change: { expectedRevision: -1, expert: null },
  }), null);
  assert.match(owner.messages.at(-1).error.message, /Invalid/);
  assert.equal(f.broker.threadOwners.get('thread'), owner);
  assert.equal(f.requests.some(request => request.method === 'thread/start' || request.method === 'turn/start'), false);
});
