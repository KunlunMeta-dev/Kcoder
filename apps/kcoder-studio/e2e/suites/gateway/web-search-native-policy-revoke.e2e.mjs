import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { closeRpcAndWait } from '../../harness/rpc.mjs';
import { startWebSearchNetworkFixture } from '../../harness/web-search-network-fixture.mjs';
import { prepareWebNativeBinary, startWebNativeSession, startWebNativeTurn, approveWebNativeSearch, completeWebNativeTurn } from '../../harness/web-search-native-session.mjs';

await runE2E(import.meta.url, {
  testId: 'native-search-external-profile-revokes-inflight-and-next-turn-with-independent-profile-peer', tier: 'full-integration',
  modelPolicy: 'Model-independent actual native tools and owned MCP handshake; external policy mutation belongs only to this fixture. No public-search/model-quality claim.',
  prerequisites: 'Feature-gated CLI; fresh model-only profiles and normal ASK approvals; no search key/MCP entry.',
  budgets: { ordinaryModelRequests: 6, sourceQueries: 1, wallClockMs: 120000 }, retainSuccessEvidence: true,
}, async context => {
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(120000)]);
  const { binary } = await prepareWebNativeBinary(context);
  const network = await startWebSearchNetworkFixture(context, { scenario: 'revoke-handshake', resultCount: 1 });
  const ownerSession = await startWebNativeSession(context, { binary, network, label: 'revoke-owner' });
  const peerSession = await startWebNativeSession(context, { binary, network, label: 'revoke-peer' });
  const owner = await ownerSession.connect('owner'), peer = await peerSession.connect('independent-profile');
  try {
    await ownerSession.assertModelOnlySettings(); await peerSession.assertModelOnlySettings();
    const original = await startWebNativeTurn(owner, 'WEBCASEOWNER 请执行搜索。'); await approveWebNativeSearch(owner, original);
    await waitFor(() => network.gates.observations.some(gate => gate.name === 'owner-handshake'), 10000, 'actual native MCP initialize paused', 30, context.abortSignal);
    const peerTurn = await startWebNativeTurn(peer, 'WEBCASEPEER 请执行独立profile搜索。'); await approveWebNativeSearch(peer, peerTurn);
    await waitFor(() => network.gates.observations.some(gate => gate.name === 'peer-query'), 10000, 'independent native profile already reading its source', 30, context.abortSignal);
    const document = JSON.parse(await readFile(ownerSession.settingsFile, 'utf8'));
    assert.equal(document.web, undefined);
    // Simulate an external policy edit after dispatch; no settings/tool UI is involved.
    await writeFile(ownerSession.settingsFile, JSON.stringify({ ...document, web: { search: { providers: [] } } }));
    assert.equal(network.gates.release('owner-handshake'), true);
    const revoked = await completeWebNativeTurn(owner, original, 15000);
    assert.equal(revoked.completed.params.turn.status, 'completed'); assert.equal(revoked.receipts.length, 1);
    const receipt = revoked.receipts[0]; assert.equal(receipt.status, 'failed'); assert.equal(receipt.failure, 'policy_denied');
    assert.equal(receipt.sources.length, 0); assert.equal(receipt.attempts.length, 1);
    assert.equal(receipt.attempts[0].provider, 'exa-public'); assert.equal(receipt.attempts[0].requestSent, false);
    assert.equal(network.gates.release('peer-query'), true);
    const continuedPeer = await completeWebNativeTurn(peer, peerTurn, 15000);
    assert.equal(continuedPeer.completed.params.turn.status, 'completed'); assert.equal(continuedPeer.receipts.length, 1);
    assert.equal(continuedPeer.receipts[0].status, 'success'); assert.equal(continuedPeer.receipts[0].sources.length, 1);
    const next = await startWebNativeTurn(owner, 'WEBCASEAFTERREVOKE 请再次执行搜索。', original.threadId); await approveWebNativeSearch(owner, next);
    const blockedNext = await completeWebNativeTurn(owner, next, 15000);
    assert.equal(blockedNext.completed.params.turn.status, 'completed'); assert.equal(blockedNext.receipts.length, 1);
    assert.equal(blockedNext.receipts[0].failure, 'policy_denied'); assert.deepEqual(blockedNext.receipts[0].attempts, []); assert.deepEqual(blockedNext.receipts[0].sources, []);
    assert.equal(network.sourceCalls, 1); assert.ok(network.observations.queries.every(query => query.includes('WEBCASEPEER')));
    assert.deepEqual(network.observations.failures, []); await peerSession.assertModelOnlySettings();
    const history = await owner.request('thread/read', { threadId: original.threadId, limit: 100 });
    const durable = history.messages.flatMap(message => (message.blocks || []).flatMap(block => block.webSources ? [block.webSources] : []));
    assert.deepEqual(durable, [receipt, blockedNext.receipts[0]]);
    await context.writeArtifactJson('native-policy-revoke.json', { original, peerTurn, next, initialModelOnlyProfiles: true, fixtureExternalPolicyEdit: { searchProviders: [] }, revoked, continuedPeer, blockedNext, durable, observations: network.observations });
    return { inFlightQueryBlockedBeforeBusinessDispatch: true, sameThreadNextTurnUsesFreshPolicy: true, independentProfilePeerCompleted: true, initialNoSearchConfiguration: true, sourceQueries: network.sourceCalls };
  } catch (error) { await context.writeArtifactJson('native-policy-revoke-failure.json', { error: String(error), observations: network.observations, ownerFrames: owner.messages(), peerFrames: peer.messages() }); throw error; }
  finally { network.gates.releaseAll(); await closeRpcAndWait(peer); await closeRpcAndWait(owner); await context.stopOwned('revoke-peer-gateway'); await context.stopOwned('revoke-owner-gateway'); }
});
