import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerFixture, fakeClient, validInitializeParams } from './workspace-app-server-broker.test-support.js';
import { gatewayRequestOutcome } from '../shared/gatewayRequestDeadline.js';

const method = 'thread/workspace/lookup';
test('negotiated workspace lookup reads metadata without claiming another client thread', async () => {
  const f = brokerFixture({ residentThreads: true });
  const client = fakeClient(); const original = fakeClient();
  f.broker.attach(client); f.broker.attach(original);
  try {
    await f.broker.receive(client, JSON.stringify({ id: 'init', method: 'initialize', params: {
      ...validInitializeParams(), capabilities: { experimental: { threadWorkspaceLookupV1: true } },
    } }));
    f.respond({ id: f.upstream[0].id, result: { protocolVersion: '2026-07-27', capabilities: {
      experimental: { residentThreads: true, threadWorkspaceLookupV1: true },
    } } });
    await new Promise(resolve => setImmediate(resolve));
    f.broker.threadOwners.set('old-thread', original);
    await f.broker.receive(client, JSON.stringify({ id: 'lookup', method, params: { threadId: 'old-thread', limit: 64 } }));
    const request = f.upstream.at(-1);
    assert.equal(request.method, method);
    f.respond({ id: request.id, result: { threadId: 'old-thread', candidates: [{ workspacePath: '/owned/old' }],
      completeness: 'complete', scannedProjects: 1, issueCount: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.messages.at(-1).result.candidates[0].workspacePath, '/owned/old');
    assert.equal(f.broker.threadOwners.get('old-thread'), original);
    assert.equal(client.messages[0].result.capabilities.experimental.threadWorkspaceLookupV1, true);
  } finally { f.broker.clearTransientState(); }
});

test('lookup has exact read-only classification without granting similarly named methods', () => {
  assert.equal(gatewayRequestOutcome(method), 'readOnly');
  assert.equal(gatewayRequestOutcome(`${method}/write`), 'unknown');
});
