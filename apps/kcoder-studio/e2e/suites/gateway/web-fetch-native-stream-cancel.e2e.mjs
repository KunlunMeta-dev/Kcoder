import assert from 'node:assert/strict';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { closeRpcAndWait } from '../../harness/rpc.mjs';
import { startWebSearchNetworkFixture } from '../../harness/web-search-network-fixture.mjs';
import { prepareWebNativeBinary, startWebNativeSession, startWebNativeTurn, approveWebNativeSearch, approveWebNativeTool, completeWebNativeTurn } from '../../harness/web-search-native-session.mjs';

await runE2E(import.meta.url, {
  testId: 'native-search-then-fetch-html-stream-cancel-preserves-summary-peer-and-uncached-body-recovery', tier: 'full-integration',
  modelPolicy: 'Model-independent actual native WebSearch/WebFetch and owned TLS HTML streaming; deterministic tool selection is not public-search/model quality.',
  prerequisites: 'Feature-gated binary and model-only fresh profile; normal per-tool ASK approvals; no web settings/key/MCP entry.',
  budgets: { ordinaryModelRequests: 6, sourceQueries: 2, pageReads: 2, wallClockMs: 120000 }, retainSuccessEvidence: true,
}, async context => {
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(120000)]);
  const { binary } = await prepareWebNativeBinary(context);
  const network = await startWebSearchNetworkFixture(context, { scenario: 'cancel-fetch-stream', resultCount: 1 });
  const session = await startWebNativeSession(context, { binary, network, label: 'fetch-cancel' });
  const rpc = await session.connect('owner-and-peer');
  const sourceReceipts = history => history.messages.flatMap(message => (message.blocks || []).flatMap(block => block.webSources ? [block.webSources] : []));
  try {
    const owner = await startWebNativeTurn(rpc, 'WEBCASEOWNER 请搜索并读取原文。'); await approveWebNativeSearch(rpc, owner);
    await approveWebNativeTool(rpc, owner, 'WebFetch');
    await waitFor(() => network.gates.observations.some(gate => gate.name === 'owner-page-stream'), 10000, 'actual native HTML body partially received', 30, context.abortSignal);
    const peer = await startWebNativeTurn(rpc, 'WEBCASEPEER 请执行独立搜索。'); await approveWebNativeSearch(rpc, peer);
    await waitFor(() => network.gates.observations.some(gate => gate.name === 'peer-query'), 10000, 'peer source query actually in flight', 30, context.abortSignal);
    assert.equal((await rpc.request('turn/interrupt', owner)).interrupted, true);
    const interrupted = await completeWebNativeTurn(rpc, owner, 10000); assert.equal(interrupted.completed.params.turn.status, 'interrupted');
    const searches = interrupted.receipts.filter(receipt => receipt.operation === 'search');
    assert.equal(searches.length, 1); assert.equal(searches[0].status, 'success'); assert.equal(searches[0].sources[0].readStatus, 'summary_only');
    assert.ok(interrupted.receipts.filter(receipt => receipt.operation === 'fetch').every(receipt => receipt.sources.every(source => !['read', 'partial'].includes(source.readStatus))), 'An unreturned body cannot create a read badge');
    await waitFor(() => network.gates.observations.find(gate => gate.name === 'owner-page-stream')?.closedBeforeRelease, 10000, 'cancelled native reader closes its HTML response', 30, context.abortSignal);
    assert.equal(network.gates.release('peer-query'), true);
    const completedPeer = await completeWebNativeTurn(rpc, peer, 15000); assert.equal(completedPeer.completed.params.turn.status, 'completed'); assert.equal(completedPeer.receipts[0].status, 'success');
    const beforeLate = await rpc.request('thread/read', { threadId: owner.threadId, limit: 100 });
    assert.equal(network.gates.release('owner-page-stream'), true);
    await waitFor(() => network.gates.observations.find(gate => gate.name === 'owner-page-stream')?.replyAttempted, 3000, 'late HTML body reply after original cancellation', 30, context.abortSignal);
    assert.equal(network.gates.observations.find(gate => gate.name === 'owner-page-stream').transportClosedAtReply, true);
    const afterLate = await rpc.request('thread/read', { threadId: owner.threadId, limit: 100 }); assert.deepEqual(sourceReceipts(afterLate), sourceReceipts(beforeLate));
    const recovery = await startWebNativeTurn(rpc, 'WEBCASEFETCHRECOVERY 请重新读取原文。', owner.threadId); await approveWebNativeTool(rpc, recovery, 'WebFetch');
    const recovered = await completeWebNativeTurn(rpc, recovery, 15000); assert.equal(recovered.completed.params.turn.status, 'completed'); assert.equal(recovered.receipts.length, 1);
    const body = recovered.receipts[0]; assert.equal(body.operation, 'fetch'); assert.equal(body.sources.length, 1); assert.equal(body.sources[0].readStatus, 'read'); assert.equal(body.sources[0].cacheHit, false);
    assert.notEqual(body.sources[0].sourceId, searches[0].sources[0].sourceId); assert.equal(body.sources[0].url, network.pageUrl);
    assert.equal(network.observations.pages.length, 2); assert.equal(network.sourceCalls, 2); assert.equal(network.mainModelCalls, 6);
    assert.deepEqual(network.observations.failures, []); await session.assertModelOnlySettings();
    await context.writeArtifactJson('native-fetch-stream-cancel.json', { owner, peer, recovery, interrupted, completedPeer, recovered, beforeLate: sourceReceipts(beforeLate), afterLate: sourceReceipts(afterLate), observations: network.observations });
    return { actualSearchThenFetch: true, cancelledBodyNotPromotedToRead: true, peerContinued: true, lateBodyIgnored: true, sameThreadBodyRecoveryNotCached: true };
  } catch (error) { await context.writeArtifactJson('native-fetch-stream-cancel-failure.json', { message: String(error), observations: network.observations, frames: rpc.messages() }); throw error; }
  finally { network.gates.releaseAll(); await closeRpcAndWait(rpc); await context.stopOwned('fetch-cancel-gateway'); }
});
