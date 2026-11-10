import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { closeRpcAndWait } from '../../harness/rpc.mjs';
import { startWebSearchNetworkFixture } from '../../harness/web-search-network-fixture.mjs';
import { prepareWebNativeBinary, startWebNativeSession } from '../../harness/web-search-native-session.mjs';
import { WEB_SEARCH_METHODS as M } from '../../../shared/webSearchMethods.mjs';

await runE2E(import.meta.url, {
  testId: 'actual-gateway-native-status-probe-healthy-explicit-tool-authorization-owner-and-replay', tier: 'full-integration',
  modelPolicy: 'Model-independent real native diagnostic and owned TLS source. Default ASK denial is separate from explicitly allowed WebSearch; no model turn/public quality/platform claim.',
  budgets: { sourceQueries: 1, modelRequests: 0, pageReads: 0, wallClockMs: 120000 }, retainSuccessEvidence: true,
}, async context => {
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(120000)]);
  const { binary, identity } = await prepareWebNativeBinary(context, { inputCheckpoint: process.env.KCODER_E2E_SEARCH_NATIVE_CHECKPOINT || 'explicit-feature-binary-checkpoint-not-supplied' });
  const network = await startWebSearchNetworkFixture(context, { resultCount: 3 });
  const caps = { webSearchStatusV1: true, webSearchProbeV1: true };
  const ask = await startWebNativeSession(context, { binary, network, label: 'diagnostic-ask' });
  const askRpc = await ask.connect('owner', 'main', caps);
  let authorized, owner, peer, other;
  try {
    const askStatus = await askRpc.request(M.status, { mode: 'kcoder' });
    assert.equal(askStatus.webSearchVisible, true); assert.equal(askStatus.webFetchVisible, true);
    assert.deepEqual(askStatus.candidates, ['exa-public', 'searxng-bundled', 'bing-html']);
    await assert.rejects(askRpc.request(M.start, { mode: 'kcoder', requestId: 'normal-ask-boundary', expectedRevision: askStatus.revision }), /POLICY_DENIED/);
    assert.equal(network.sourceCalls, 0); assert.equal(network.observations.model.length, 0); assert.equal(network.observations.pages.length, 0);
    await ask.assertModelOnlySettings(); await closeRpcAndWait(askRpc); await context.stopOwned('diagnostic-ask-gateway');

    authorized = await startWebNativeSession(context, { binary, network, label: 'diagnostic-allowed', extraTarget: true, allowedTools: ['WebSearch'] });
    owner = await authorized.connect('owner', 'main', caps); peer = await authorized.connect('peer', 'main', caps); other = await authorized.connect('other-target', 'other', caps);
    const status = await owner.request(M.status, { mode: 'kcoder' });
    assert.ok(status.observations.every(observation => observation.status === undefined));
    assert.equal(network.sourceCalls, 0); assert.equal(network.observations.methods.length, 0);
    const binding = { requestId: 'healthy-fixed-diagnostic', expectedRevision: status.revision };
    await assert.rejects(owner.request(M.start, { ...binding, requestId: 'stale', expectedRevision: 'stale', mode: 'kcoder' }), /REVISION_CONFLICT/);
    const started = await owner.request(M.start, { ...binding, mode: 'kcoder' });
    assert.equal(started.state, 'running'); assert.equal(started.targetId, status.targetId); assert.equal(started.revision, status.revision);
    let receipt;
    await waitFor(async () => { receipt = await owner.request(M.read, binding); return receipt.state !== 'running'; }, 30000, 'actual successful native diagnostic', 40, context.abortSignal);
    assert.equal(receipt.state, 'completed'); assert.equal(receipt.targetId, status.targetId); assert.equal(receipt.requestId, binding.requestId); assert.equal(receipt.revision, status.revision);
    const response = receipt.response;
    assert.equal(response.status, 'success'); assert.equal(response.provider, 'exa-public'); assert.equal(response.page.results.length, 3);
    assert.equal(response.attempts.length, 1); assert.equal(response.attempts[0].requestSent, true);
    assert.equal(new Set(response.page.results.map(source => source.sourceId)).size, 3);
    for (const source of response.page.results) { assert.ok(source.sourceId); assert.ok(source.url.startsWith('https://example.com/')); assert.equal(source.publishedAt, '2026-10-30'); }
    for (let i = 0; i < 3; i++) assert.deepEqual(await owner.request(M.read, binding), receipt);
    assert.deepEqual(await owner.request(M.start, { ...binding, mode: 'kcoder' }), receipt);
    await assert.rejects(owner.request(M.read, { ...binding, expectedRevision: 'wrong-revision' }), /BINDING_CONFLICT/);
    for (const remote of [peer, other]) { assert.equal((await remote.request(M.read, binding)).state, 'unknown'); assert.equal((await remote.request(M.cancel, binding)).state, 'unknown'); }
    assert.deepEqual(await owner.request(M.read, binding), receipt);
    const updated = await owner.request(M.status, { mode: 'kcoder' });
    assert.equal(updated.revision, status.revision); assert.equal(updated.observations.find(row => row.provider === 'exa-public').status, 'success');
    assert.equal(network.sourceCalls, 1); assert.deepEqual(network.observations.queries, ['KCoder web search connectivity check']);
    assert.equal(network.observations.model.length, 0); assert.equal(network.observations.pages.length, 0); assert.deepEqual(network.observations.failures, []);
    assert.ok(owner.messages().every(frame => frame.method !== 'turn/started'));
    await authorized.assertSettingsUnchanged(); const settings = JSON.parse(await readFile(authorized.settingsFile, 'utf8'));
    assert.deepEqual(settings.allowed_tools, ['WebSearch']); assert.equal(settings.permission_mode, undefined); assert.equal(settings.web, undefined); assert.equal(settings.mcp_servers, undefined);
    await context.writeArtifactJson('native-positive-probe.json', { binary: identity, binaryCheckpoint: process.env.KCODER_E2E_SEARCH_NATIVE_CHECKPOINT || 'not supplied', defaultAsk: { status: askStatus, probeDenied: true, sourceQueries: 0 }, explicitToolAuthorization: ['WebSearch'], before: status, receipt, after: updated, observations: network.observations, modelTurns: 0, actualSourceQueries: 1, pageReads: 0 });
    return { actualNativeProbeHealthy: true, sourceCount: 3, fixedCountIsProductionContract: true, defaultAskNotAutoAuthorized: true, explicitToolAllowOnly: true, ownerRevisionAndNoReplay: true, modelTurns: 0, sourceQueries: 1, pageReads: 0 };
  } catch (error) { await context.writeArtifactJson('native-positive-probe-failure.json', { error: String(error), binary: identity, binaryCheckpoint: process.env.KCODER_E2E_SEARCH_NATIVE_CHECKPOINT || 'not supplied', observations: network.observations, ownerFrames: owner?.messages(), askFrames: askRpc.messages() }); throw error; }
  finally { for (const rpc of [other, peer, owner, askRpc]) await closeRpcAndWait(rpc); if (authorized) await context.stopOwned('diagnostic-allowed-gateway'); await context.stopOwned('diagnostic-ask-gateway'); }
});
