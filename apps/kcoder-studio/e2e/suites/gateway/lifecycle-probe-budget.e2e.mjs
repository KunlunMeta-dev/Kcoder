import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { WorkspaceAppServerBroker } from '../../../src/workspace-app-server-broker.js';
import { appRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

await runE2E(import.meta.url, { testId: 'gateway-lifecycle-probe-timeout-budget', tier: 'full-integration',
  modelPolicy: 'model-independent real owned stdio backend, diagnostic timeout and recovery; no model calls', retainSuccessEvidence: true,
  evidenceReason: 'Repeated diagnostic timeouts remain bounded and late replies restore probe admission' }, async context => {
  const child = context.spawnOwned('lifecycle-backend', process.execPath,
    [resolve(appRoot, 'e2e/fixtures/pending-budget/backend.mjs'), context.pathInState('unused-owned-resource')], { stdin: 'pipe' });
  const broker = new WorkspaceAppServerBroker({ child, adapter: { rawPassthrough: true, fromUpstream: message => ({ upstream: [], client: [message] }) },
    maxMessageBytes: 1024 * 1024, serverId: 'owned', residentThreads: true, pendingBudget: { total: 8, perOwner: 2, ttlMs: 80 } });
  broker.initializeResponse = { result: { capabilities: { experimental: { serverResourceSnapshotV1: true } } } };
  for (let index = 0; index < 12; index++) assert.equal(await broker.idleShutdown.readResources(20), null);
  assert.equal(broker.requestLoad.total.inFlight, 2);
  assert.equal(broker.pendingLoad.admitted, 2);
  const client = { channel: 'runtime', messages: [], send(m) { this.messages.push(m); return true; }, pause() {}, resume() {}, close() {} };
  broker.attach(client); context.addCleanup('lifecycle client', () => { if (broker.clients.has(client)) broker.detach(client); });
  const request = (id, control) => broker.receive(client, JSON.stringify({ jsonrpc: '2.0', id, method: 'server/info', params: { control } }));
  request(1, 'healthy'); await waitFor(() => client.messages.find(m => m.id === 1), 5000, 'healthy owner admission');
  request(2, 'release'); await waitFor(() => client.messages.find(m => m.id === 2), 5000, 'late lifecycle replies');
  assert.equal(broker.requestLoad.total.inFlight, 0);
  const sample = await broker.idleShutdown.readResources(1000);
  assert.equal(sample.processId, child.pid);
  assert.ok(sample.residentBytes > 0);
  assert.equal(broker.pendingLoad.admitted, 0);
  await context.writeArtifactJson('lifecycle-probe-result.json', { attempts: 12, peakUnansweredDiagnostics: 2,
    healthyOwnerContinues: true, lateRepliesSettle: true, freshProbeAccepted: true, actualBackendRss: sample.residentBytes, modelCalls: 0 });
});
