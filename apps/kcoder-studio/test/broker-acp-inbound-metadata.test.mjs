import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture() {
  const child = new EventEmitter(); Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const broker = new WorkspaceAppServerBroker({ child, residentThreads: true, maxMessageBytes: 1024 * 1024, serverId: 'acp-metadata',
    adapter: { rawPassthrough: true, toUpstream: message => ({ upstream: [message], client: [] }), fromUpstream: message => ({ upstream: [], client: [message] }) } });
  const requests = []; let partial = '';
  child.stdin.on('data', bytes => { partial += bytes.toString('utf8'); while (partial.includes('\n')) { const end = partial.indexOf('\n'); requests.push(JSON.parse(partial.slice(0, end))); partial = partial.slice(end + 1); } });
  const client = () => { const owner = { channel: 'runtime', authorizationOwner: 'same-native-workspace', messages: [],
    send(value) { this.messages.push(value); return true; }, pause() {}, resume() {}, close() {} }; broker.attach(owner); return owner; };
  const initialize = async (owner, id, offered) => {
    broker.receive(owner, JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2026-07-27', clientInfo: { name: 'acp-metadata', version: '1' }, capabilities: { experimental: offered === undefined ? {} : { acpInboundV1: offered } } } }));
    await new Promise(resolve => setImmediate(resolve)); return requests.at(-1);
  };
  const reply = async (id, supported) => { child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2026-07-27', serverInfo: { name: 'actual-protocol-fixture', version: '1' }, capabilities: { experimental: { residentThreads: true, ...(supported ? { acpInboundV1: true } : {}) } } } }) + '\n'); await new Promise(resolve => setImmediate(resolve)); };
  return { broker, requests, client, initialize, reply };
}
for (const mode of ['cached', 'waiter']) test(`compiled ACP metadata survives a legacy first client (${mode}) without enabling undeclared peers`, async () => {
  const f = fixture(); try {
    const old = f.client(), current = f.client();
    const original = await f.initialize(old, 'old', undefined);
    assert.equal(original.params.capabilities.experimental.acpInboundV1, true, 'Shared backend consistently asks for readonly implementation metadata');
    if (mode === 'waiter') await f.initialize(current, 'current', true);
    await f.reply(original.id, true);
    if (mode === 'cached') await f.initialize(current, 'current', true);
    assert.equal(f.requests.length, 1, 'No second backend initialize or ACP process/session is created');
    assert.equal(current.messages.at(-1).result.capabilities.experimental.acpInboundV1, true);
    assert.equal(old.messages.at(-1).result.capabilities.experimental.acpInboundV1, false);
    const declined = f.client(); await f.initialize(declined, 'declined', false);
    assert.equal(declined.messages.at(-1).result.capabilities.experimental.acpInboundV1, false);
    assert.equal(f.requests.length, 1);
  } finally { f.broker.clearTransientState(); }
});
test('an old native backend never acquires ACP support from a new client claim', async () => {
  const f = fixture(); try {
    const current = f.client(); const original = await f.initialize(current, 'current', true); await f.reply(original.id, false);
    assert.notEqual(current.messages.at(-1).result.capabilities.experimental.acpInboundV1, true);
    assert.equal(f.requests.length, 1);
  } finally { f.broker.clearTransientState(); }
});
