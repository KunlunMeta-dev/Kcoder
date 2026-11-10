import assert from 'node:assert/strict';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { closeRpcAndWait } from '../../harness/rpc.mjs';
import { startWebSearchNetworkFixture } from '../../harness/web-search-network-fixture.mjs';
import { prepareWebNativeBinary, startWebNativeSession, startWebNativeTurn, approveWebNativeSearch, completeWebNativeTurn } from '../../harness/web-search-native-session.mjs';

await runE2E(import.meta.url, {
  testId: 'native-search-real-tls-and-stream-cancel-owner-peer-late-response', tier: 'full-integration',
  modelPolicy: 'Model-independent normal native tool turns with actual owned CONNECT/TLS/SSE transport cancellation; fixed model choices are not model or public-search quality.',
  prerequisites: 'Explicit web-network-test-fixture CLI binary; OpenSSL; no web settings/search key/MCP entry.',
  budgets: { ordinaryModelRequests: 8, sourceQueries: 4, wallClockMs: 180000 }, retainSuccessEvidence: true,
}, async context => {
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(180000)]);
  const { binary } = await prepareWebNativeBinary(context), cases = [];
  const scenarios = process.env.KCODER_E2E_WEB_CANCEL_CASE ? [process.env.KCODER_E2E_WEB_CANCEL_CASE] : ['cancel-tls', 'cancel-stream'];
  assert.ok(scenarios.every(value => ['cancel-tls', 'cancel-stream'].includes(value)));
  for (const scenario of scenarios) {
    const network = await startWebSearchNetworkFixture(context, { scenario, resultCount: 1 });
    const session = await startWebNativeSession(context, { binary, network, label: scenario });
    const rpc = await session.connect('owner-and-peer');
    const gateName = scenario === 'cancel-tls' ? 'owner-tls' : 'owner-stream';
    try {
      const owner = await startWebNativeTurn(rpc, 'WEBCASEOWNER 请执行受控搜索。'); await approveWebNativeSearch(rpc, owner);
      await waitFor(() => network.gates.observations.find(gate => gate.name === gateName), 10000, 'real source transport paused', 30, context.abortSignal);
      const peer = await startWebNativeTurn(rpc, 'WEBCASEPEER 请执行独立受控搜索。'); await approveWebNativeSearch(rpc, peer);
      await waitFor(() => network.gates.observations.find(gate => gate.name === 'peer-query'), 10000, 'actual peer source request waiting', 30, context.abortSignal);
      const wrong = await rpc.request('turn/interrupt', { threadId: owner.threadId, turnId: 'turn-not-the-owner' });
      assert.equal(wrong.interrupted, false, 'A wrong turn identity cannot cancel an active source owner');
      assert.ok(!rpc.messages().some(frame => frame.method === 'turn/completed' && frame.params?.threadId === owner.threadId));
      assert.equal((await rpc.request('turn/interrupt', owner)).interrupted, true);
      const interrupted = await completeWebNativeTurn(rpc, owner, 10000); assert.equal(interrupted.completed.params.turn.status, 'interrupted');
      assert.ok(interrupted.receipts.every(receipt => receipt.status !== 'success' && receipt.sources.length === 0));
      await waitFor(() => network.gates.observations.find(gate => gate.name === gateName)?.closedBeforeRelease, 10000, 'actual cancelled TLS/body socket close', 30, context.abortSignal);
      assert.equal(network.gates.release('peer-query'), true);
      const completedPeer = await completeWebNativeTurn(rpc, peer, 15000); assert.equal(completedPeer.completed.params.turn.status, 'completed');
      assert.equal(completedPeer.receipts.length, 1); assert.equal(completedPeer.receipts[0].status, 'success');
      assert.equal(completedPeer.receipts[0].identity.threadId, peer.threadId);
      assert.equal(completedPeer.receipts[0].sources.length, 1);
      const beforeLate = await rpc.request('thread/read', { threadId: owner.threadId, limit: 100 });
      assert.equal(network.gates.release(gateName), true);
      await waitFor(() => network.gates.observations.find(gate => gate.name === gateName)?.replyAttempted, 3000, 'late upstream reply after cancellation', 30, context.abortSignal);
      assert.equal(network.gates.observations.find(gate => gate.name === gateName).transportClosedAtReply, true);
      if (scenario === 'cancel-tls') { assert.ok(network.observations.clientHelloBytes > 0); assert.equal(network.gates.observations.find(gate => gate.name === gateName).remoteEndedBeforeRelease, true); }
      const afterLate = await rpc.request('thread/read', { threadId: owner.threadId, limit: 100 });
      const receipts = history => history.messages.flatMap(message => (message.blocks || []).flatMap(block => block.webSources ? [block.webSources] : []));
      assert.deepEqual(receipts(afterLate), receipts(beforeLate), 'A late source reply must not change cancelled native history');
      assert.ok(receipts(afterLate).every(receipt => receipt.status !== 'success' && receipt.sources.length === 0));
      const peerHistory = await rpc.request('thread/read', { threadId: peer.threadId, limit: 100 });
      assert.deepEqual(receipts(peerHistory), completedPeer.receipts, 'Source records remain with the actual peer turn');
      assert.equal(network.observations.queries.filter(query => query.includes('WEBCASEOWNER')).length, scenario === 'cancel-tls' ? 0 : 1);
      assert.equal(network.observations.queries.filter(query => query.includes('WEBCASEPEER')).length, 1);
      assert.equal(network.observations.methods.filter(method => method === 'initialize').length, scenario === 'cancel-tls' ? 1 : 2);
      assert.deepEqual(network.observations.failures, []); await session.assertModelOnlySettings();
      const result = { scenario, owner, peer, wrongIdentityRejected: true, ownerOutcome: interrupted, peerOutcome: completedPeer, observations: network.observations, cancelledSources: receipts(afterLate) };
      await context.writeArtifactJson(`cases/${scenario}/native-cancel.json`, result); cases.push({ scenario, ownerInterrupted: true, peerCompleted: true, nativeSocketClosedBeforeLateReply: true });
    } catch (error) {
      await context.writeArtifactJson(`cases/${scenario}/failure.json`, { error: String(error), observations: network.observations, frames: rpc.messages() }); throw error;
    } finally { network.gates.releaseAll(); await closeRpcAndWait(rpc); await context.stopOwned(`${scenario}-gateway`); }
  }
  return { cases, actualNativeTools: true, noSourceRecordFromLateReply: true, noSearchSettingsKeysOrMcp: true };
});
