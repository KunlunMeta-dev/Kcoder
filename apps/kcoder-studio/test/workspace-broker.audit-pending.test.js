import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

test('model-independent: unanswered backend requests stay bounded and load accounting matches retained requests', () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdin.resume();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const broker = new WorkspaceAppServerBroker({ child, adapter: { rawPassthrough: true }, maxMessageBytes: 1024 * 1024, serverId: 'fixture', residentThreads: true });
  const client = { channel: 'runtime', send() { return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client);
  for (let id = 1; id <= 1024; id++) broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id, method: 'server/info', params: { fixturePayload: 'x'.repeat(1024) } }));
  const observed = { pending: broker.pending.size, tracked: broker.requestLoad.total.inFlight, pendingWork: broker.hasPendingWork };
  console.log(JSON.stringify(observed));
  assert.ok(broker.pending.size <= 512, `backend retained ${broker.pending.size} unanswered requests`);
  assert.equal(broker.requestLoad.total.inFlight, broker.pending.size);
});
