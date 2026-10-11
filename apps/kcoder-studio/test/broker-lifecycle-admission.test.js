import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { WorkspaceAppServerBroker } from '../src/workspace-app-server-broker.js';

function fixture() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const writes = []; child.stdin.on('data', chunk => writes.push(JSON.parse(chunk.toString())));
  const broker = new WorkspaceAppServerBroker({ child, adapter: { rawPassthrough: true, fromUpstream: m => ({ upstream: [], client: [m] }) },
    maxMessageBytes: 1024 * 1024, serverId: 'owned', residentThreads: true, pendingBudget: { total: 4, perOwner: 2, ttlMs: 10 } });
  broker.initializeResponse = { result: { capabilities: { experimental: { serverResourceSnapshotV1: true } } } };
  return { child, broker, writes, reply(id, result) { child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); } };
}

test('timed out lifecycle probes retain bounded unknown admissions and allow late recovery', async t => {
  const f = fixture(); t.after(() => f.child.emit('close', 0));
  for (let index = 0; index < 4; index++) assert.equal(await f.broker.idleShutdown.readResources(2), null);
  assert.equal(f.writes.length, 2, 'retrying a hung lifecycle read cannot forward unbounded probes');
  assert.equal(f.broker.pendingLoad.admitted, 2);
  assert.equal(f.broker.requestLoad.total.inFlight, 2);
  assert.equal(f.broker.hasPendingWork, false, 'pure diagnostic reads do not suppress the authoritative idle shutdown gate');
  f.reply(f.writes[1].id, { processId: 1, instanceId: 'owned', residentBytes: 100, memorySource: 'linux-vmrss', includesChildren: false });
  f.reply(f.writes[0].id, { processId: 1, instanceId: 'owned', residentBytes: 100, memorySource: 'linux-vmrss', includesChildren: false });
  assert.equal(f.broker.requestLoad.total.inFlight, 0);
  const read = f.broker.idleShutdown.readResources(100);
  f.reply(f.writes.at(-1).id, { processId: 1, instanceId: 'owned', residentBytes: 100, memorySource: 'linux-vmrss', includesChildren: false });
  assert.equal((await read).residentBytes, 100);
  assert.equal(f.broker.hasPendingWork, false);
});
