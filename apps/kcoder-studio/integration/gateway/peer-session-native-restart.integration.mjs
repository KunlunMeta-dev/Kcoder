import assert from 'node:assert/strict';
import { requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { peerNativeFixture } from '../../e2e/harness/peer-native-runtime.mjs';

process.umask(0o077);
await runIntegration(import.meta.url, {
  testId: 'peer-session-native-source-restart',
  tier: 'full-integration',
  modelPolicy: 'Actual Native source process restart and Gateway routing with controlled authenticated socket subjects and deterministic provider. No HTTP-login, SSH, GUI or real-model claim.',
}, async context => {
  if (process.platform !== 'linux') throw new Error('This owned Native image acceptance requires Linux');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'peer candidate');
  const fixture = await peerNativeFixture(context, binary);
  return fixture.withRouteDiagnostics(async () => {
    const source = await fixture.clientFor('a'), destination = await fixture.clientFor('b');
    const a = await fixture.seed(source, 'a'), b = await fixture.seed(destination, 'b');
    const targets = [];
    let cursor;
    for (let page = 0; page < 16; page++) {
      const discovered = await source.request('thread/agentMessage/targets', { sourceThreadId: a.id,
        ...(cursor ? { cursor } : {}) });
      targets.push(...discovered.targets); cursor = discovered.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, undefined, 'the owned global target set was completely paged');
    const target = targets.find(row => row.address?.threadId === b.id);
    assert.ok(target?.allowedModes.includes('enqueue_only'));
    const text = 'OWNED_NATIVE_PEER_SOURCE_RESTART';
    fixture.holdSourceChecks();
    const receipt = await source.request('thread/agentMessage/send', {
      sourceThreadId: a.id,
      message: { targetThreadId: b.id, targetAddress: target.address,
        clientMessageId: 'owned-peer-restart', mode: 'enqueue_only', text },
    });
    assert.equal(receipt.status, 'queued');
    await waitFor(() => fixture.checksSeen() > 0, 15_000, 'destination waits for original Source verification');
    const originalPid = fixture.endpoints.get('a').child.pid;
    source.close();
    await fixture.stopEndpoint('a');
    const reader = await fixture.clientFor('a');
    const replacementPid = fixture.endpoints.get('a').child.pid;
    assert.notEqual(replacementPid, originalPid);
    // Do not resume the Source until the destination proves a native peer row.
    // Its new process must authorize the original operation from cold facts.
    fixture.releaseSourceChecks();
    let history;
    await waitFor(async () => {
      history = await destination.request('thread/read', { threadId: b.id, limit: 100 });
      return history.messages.some(row => row.role === 'peer_agent' && row.content === text);
    }, 30_000, 'native peer history after original Source process exits');
    assert.equal(history.messages.filter(row => row.role === 'peer_agent' && row.content === text).length, 1);
    assert.equal(history.messages.filter(row => row.role === 'user').length, 1);
    let settled;
    await waitFor(async () => {
      settled = await fixture.readAcceptedDestinationReceipt(receipt);
      return settled.receipt?.status === 'applied';
    }, 30_000, 'original destination authoritative Applied before activating Source');
    assert.equal(settled.receipt.messageId, receipt.messageId);
    await reader.request('thread/resume', { threadId: a.id });
    let final;
    await waitFor(async () => {
      final = await reader.request('thread/agentMessage/get', {
        sourceThreadId: a.id, query: { clientMessageId: 'owned-peer-restart' },
      });
      return final.receipt?.status === 'applied';
    }, 15_000, 'original message receipt after Source resume');
    assert.equal(final.receipt.messageId, receipt.messageId);
    assert.deepEqual(final.receipt.sourceAddress, receipt.sourceAddress);
    assert.deepEqual(final.receipt.targetAddress, receipt.targetAddress);
    await context.writeArtifactJson('peer-native-restart-assertions.json', {
      originalPid, replacementPid, sourceActivatedOnlyAfterPeerHistory: true, sourceActivatedOnlyAfterDestinationApplied: true,
      originalMessageId: receipt.messageId, finalStatus: final.receipt.status,
      peerRows: 1, fakeUserPrompts: 0, sourceAddress: receipt.sourceAddress,
      destination: receipt.targetAddress, checks: fixture.checksSeen(),
    });
    return { originalNativeSourceRestarted: true, providerBehaviorProven: false };
  });
});
