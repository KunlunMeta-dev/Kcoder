import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture(targetTransport) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const broker = new WorkspaceAppServerBroker({ child, targetTransport, serverId: 'owned-target', residentThreads: true,
    maxMessageBytes: 2 * 1024 * 1024, adapter: { rawPassthrough: true,
      toUpstream: frame => ({ upstream: [frame], client: [] }), fromUpstream: frame => ({ upstream: [], client: [frame] }) } });
  const sent = [];
  child.stdin.on('data', bytes => sent.push(JSON.parse(String(bytes))));
  const client = { channel: 'runtime', initialized: true, computerUseRecoveryV1: true, computerUseSessionAuthorizationV1: true,
    messages: [], send(frame) { this.messages.push(frame); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client); broker.threadOwners.set('original', client);
  client.initialized = true; client.computerUseRecoveryV1 = true; client.computerUseSessionAuthorizationV1 = true;
  return { broker, child, sent, client };
}

test('raw remote RPC cannot turn target Shell authorization into a desktop lease', () => {
  for (const transport of ['ssh', undefined]) {
    const { broker, child, sent, client } = fixture(transport);
    for (const [method, params] of [
      ['turn/start', { threadId: 'original', input: [], computerUse: { approved: true, target: 'local_windows_desktop' } }],
      ['computerUse/status', {}], ['computerUse/recover', { threadId: 'original', previousTurnId: 'before' }],
      ['computerUse/revoke', { threadId: 'original' }],
    ]) {
      broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: method, method, params }));
      assert.equal(sent.length, 0, `${transport}/${method}: desktop request forwarded to the execution target`);
      assert.equal(client.messages.at(-1)?.error?.code, -32602, `${transport}/${method}: must reject before upstream`);
      assert.match(client.messages.at(-1).error.message, /local.*desktop|desktop.*local/i);
      assert.equal(broker.threadOwners.get('original'), client);
      assert.equal(broker.activeTurns.size, 0);
    }
    child.emit('close', 0, null);
  }
});

test('local native desktop admission still forwards the original request and remote normal turns remain available', () => {
  for (const transport of ['local', 'ssh']) {
    const { broker, child, sent, client } = fixture(transport);
    const params = { threadId: 'original', input: [], ...(transport === 'local'
      ? { computerUse: { approved: true, target: 'local_windows_desktop' } } : {}) };
    broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'turn/start', params }));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].params, params);
    assert.equal(client.messages.some(frame => frame.error), false);
    child.emit('close', 0, null);
  }
});

test('desktop capability projection follows the captured target, not caller claims or backend support alone', () => {
  const names = ['computerUseTurnV1', 'computerUseStatusV1', 'computerUseRecoveryV1', 'computerUseSessionAuthorizationV1'];
  const original = { result: { capabilities: { experimental: Object.fromEntries(names.map(name => [name, true])) } } };
  for (const transport of ['local', 'ssh', undefined]) {
    const { broker, child, client } = fixture(transport);
    client.targetTransport = 'local';
    const projected = broker.projectWorkspaceReceiptCapability(original, client);
    for (const name of names) assert.equal(projected.result.capabilities.experimental[name], transport === 'local');
    for (const name of names) assert.equal(original.result.capabilities.experimental[name], true);
    child.emit('close', 0, null);
  }
});
