import assert from 'node:assert/strict';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { closeRpcAndWait } from '../../harness/rpc.mjs';
import { startWebSearchNetworkFixture } from '../../harness/web-search-network-fixture.mjs';
import { prepareWebNativeBinary, startWebNativeSession, startWebNativeTurn, approveWebNativeSearch, completeWebNativeTurn } from '../../harness/web-search-native-session.mjs';

await runE2E(import.meta.url, {
  testId: 'native-search-four-inflight-sources-fifth-queued-cancel-wrong-target-and-owner-isolation', tier: 'full-integration',
  modelPolicy: 'Model-independent actual native ordinary turns, saturation and source dispatch observations. No public-search/model-quality claim.',
  prerequisites: 'Feature-gated native binary and owned TLS sources; model-only fresh profile, ordinary ASK approvals.',
  budgets: { ordinaryModelRequests: 9, sourceQueries: 4, wallClockMs: 120000 }, retainSuccessEvidence: true,
}, async context => {
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(120000)]);
  const { binary } = await prepareWebNativeBinary(context);
  const network = await startWebSearchNetworkFixture(context, { scenario: 'cancel-queue', resultCount: 1 });
  const session = await startWebNativeSession(context, { binary, network, label: 'queued-cancel', extraTarget: true });
  const rpc = await session.connect('owner'), other = await session.connect('wrong-target', 'other');
  const active = [];
  try {
    for (let i = 1; i <= 4; i++) {
      const key = `WEBCASEACTIVE${i}`, turn = await startWebNativeTurn(rpc, `${key} 请执行独立搜索。`);
      await approveWebNativeSearch(rpc, turn); active.push({ ...turn, key });
      await waitFor(() => network.gates.observations.some(gate => gate.name === key), 15000, `actual source request ${i} in flight`, 30, context.abortSignal);
    }
    assert.equal(network.sourceCalls, 4);
    const queued = await startWebNativeTurn(rpc, 'WEBCASEQUEUED 请执行第五个独立搜索。');
    const approval = await approveWebNativeSearch(rpc, queued);
    await rpc.waitFor(frame => frame.method === 'approval/resolved' && frame.params?.requestId === approval.id, 10000, 'fifth native tool authorization resolved');
    await rpc.waitFor(frame => frame.method === 'item/started' && frame.params?.threadId === queued.threadId && frame.params?.item?.type === 'toolCall', 10000, 'fifth native tool started');
    const pendingHistory = await rpc.request('thread/read', { threadId: queued.threadId, limit: 100 });
    assert.equal((await other.request('turn/interrupt', queued)).interrupted, false, 'A different real Gateway target cannot cancel this active native owner');
    assert.equal(network.sourceCalls, 4); assert.equal(network.observations.methods.filter(method => method === 'initialize').length, 4);
    assert.ok(network.gates.observations.every(gate => !gate.closedBeforeRelease));
    assert.equal((await rpc.request('turn/interrupt', queued)).interrupted, true);
    const interrupted = await completeWebNativeTurn(rpc, queued, 10000); assert.equal(interrupted.completed.params.turn.status, 'interrupted');
    assert.ok(interrupted.receipts.every(receipt => receipt.sources.length === 0 && receipt.status !== 'success'));
    assert.ok(network.gates.observations.every(gate => !gate.closedBeforeRelease), 'Cancelling a waiting owner must not close an active peer response');
    const completed = [];
    for (const turn of active) assert.equal(network.gates.release(turn.key), true);
    for (const turn of active) {
      const outcome = await completeWebNativeTurn(rpc, turn, 20000); assert.equal(outcome.completed.params.turn.status, 'completed');
      assert.equal(outcome.receipts.length, 1); assert.equal(outcome.receipts[0].status, 'success'); assert.equal(outcome.receipts[0].sources.length, 1);
      completed.push({ ...turn, receipt: outcome.receipts[0] });
    }
    assert.equal(new Set(completed.flatMap(turn => turn.receipt.sources.map(source => source.sourceId))).size, 4);
    assert.equal(network.sourceCalls, 4); assert.ok(network.observations.queries.every(query => !query.includes('WEBCASEQUEUED')));
    const durable = await rpc.request('thread/read', { threadId: queued.threadId, limit: 100 });
    assert.ok(durable.messages.flatMap(message => (message.blocks || []).flatMap(block => block.webSources ? [block.webSources] : [])).every(receipt => receipt.sources.length === 0 && receipt.status !== 'success'));
    assert.deepEqual(network.observations.failures, []); await session.assertModelOnlySettings();
    await context.writeArtifactJson('native-queued-cancel.json', { queued, interrupted, active: completed, pendingHistory, durableCancelled: durable, observations: network.observations, wrongTargetRejected: true });
    return { fourActualSourcesInFlight: true, fifthWaitingNativeCallCancelledBeforeDispatch: true, wrongTargetRejected: true, fourPeersCompletedAfterCancellation: true, sourceQueries: network.sourceCalls };
  } catch (error) { await context.writeArtifactJson('native-queued-cancel-failure.json', { message: String(error), active, observations: network.observations, frames: rpc.messages() }); throw error; }
  finally { network.gates.releaseAll(); await closeRpcAndWait(other); await closeRpcAndWait(rpc); await context.stopOwned('queued-cancel-gateway'); }
});
