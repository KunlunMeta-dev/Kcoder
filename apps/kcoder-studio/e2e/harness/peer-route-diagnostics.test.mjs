import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeerRouteDiagnostics } from './peer-route-diagnostics.mjs';

test('controlled route evidence projects closed fields and preserves failures under frequent receipt polling', () => {
  const recorder = createPeerRouteDiagnostics({});
  for (let i = 0; i < 4000; i++) recorder.observe({ lane: 'private', alias: 'a', method: 'agentMessage/router/sourceRead', phase: 'result',
    params: { text: 'PRIVATE_FIXTURE_BODY' }, proof: 'PRIVATE_FIXTURE_PROOF', environment: { TOKEN: 'PRIVATE_FIXTURE_CREDENTIAL' } });
  recorder.observe({ lane: 'private', alias: 'a', method: 'agentMessage/router/sourceCheckOriginal', phase: 'rejected', code: -32034,
    reason: 'peer_router_original_operation_unconfirmed', nativeReason: 'peer_message_original_source_changed',
    error: 'PRIVATE_FIXTURE_CREDENTIAL' });
  const value = recorder.snapshot(), bytes = JSON.stringify(value);
  assert.equal(value.events.length, 1); assert.equal(value.events[0].nativeReason, 'peer_message_original_source_changed');
  assert.equal(value.droppedDiagnostics, 0); assert.equal(value.counters[0].count, 4000);
  assert.equal(bytes.includes('PRIVATE_FIXTURE_'), false);
});

test('failure evidence is written in the active execution finally and preserves the original rejection', async () => {
  const original = new Error('owned assertion failed');
  let active = true, evidence;
  const recorder = createPeerRouteDiagnostics({ async writeArtifactJson(name, value) {
    assert.equal(active, true); assert.equal(name, 'peer-route-diagnostics.json'); evidence = value;
  } });
  await assert.rejects(recorder.withDiagnostics(async () => { throw original; }), error => error === original);
  active = false;
  assert.ok(evidence); assert.deepEqual(evidence.events, []);
});
