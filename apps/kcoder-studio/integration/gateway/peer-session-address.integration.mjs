import assert from 'node:assert/strict';
import { requireExecutable, runIntegration } from '../../e2e/harness/run-context.mjs';
import { peerNativeFixture } from '../../e2e/harness/peer-native-runtime.mjs';

process.umask(0o077);
await runIntegration(import.meta.url, { testId: 'peer-navigation-canonical-native-identity', tier: 'full-integration',
  modelPolicy: 'Two actual Native profiles and ordinary Gateway identity/read paths with controlled authenticated socket subjects and deterministic seed turns. No HTTP-login, SSH, GUI or autonomous-model claim.' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed peer Native');
  const fixture = await peerNativeFixture(context, binary);
  const source = await fixture.clientFor('a'), destination = await fixture.clientFor('b');
  const a = await fixture.seed(source, 'a'), b = await fixture.seed(destination, 'b');
  async function discover(client, sourceThreadId, targetThreadId) {
    let cursor;
    for (let page = 0; page < 16; page++) {
      const result = await client.request('thread/agentMessage/targets', { sourceThreadId, ...(cursor ? { cursor } : {}) });
      const target = result.targets.find(row => row.address?.threadId === targetThreadId);
      if (target) return target.address;
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    throw new Error('Owned original target was not discovered');
  }
  const addressB = await discover(source, a.id, b.id), addressA = await discover(destination, b.id, a.id);
  assert.notEqual(addressA.targetId, addressB.targetId);
  const original = await destination.request('thread/read', { threadId: b.id, limit: 100 });
  const constrained = await destination.request('thread/read', { threadId: b.id, limit: 100, expectedSessionAddress: addressB });
  assert.deepEqual(constrained.messages, original.messages);
  let comparisonRefused = false;
  const originalSend = destination.client.send;
  destination.client.send = frame => {
    if (frame.error?.code === -32034 && frame.error.message === 'SESSION_ADDRESS_EXPECTATION_UNAVAILABLE') comparisonRefused = true;
    return originalSend(frame);
  };
  try {
    await assert.rejects(destination.request('thread/read', { threadId: b.id, limit: 100,
      expectedSessionAddress: { ...addressA, threadId: b.id } }), /CHANNEL_TASK_REJECTED/);
  } finally { destination.client.send = originalSend; }
  assert.equal(comparisonRefused, true, 'the actual identity comparison rejected a same-ID locator from another Native');
  const after = await destination.request('thread/read', { threadId: b.id, limit: 100 });
  assert.deepEqual(after.messages, original.messages);
  await context.writeArtifactJson('peer-session-address-assertions.json', {
    actualNativeProcesses: 2, actualGatewayBroker: true, syntheticAuthenticatedSocketSubjects: true,
    deterministicProvider: true, originalAddress: addressB, otherNativeAddress: addressA,
    canonicalHistoryConstraintPreserved: true, otherNativeIdentityRejected: true, historyUnchanged: true,
  });
  return { canonicalNativeHistoryConstraint: true, providerBehaviorProven: false };
});
