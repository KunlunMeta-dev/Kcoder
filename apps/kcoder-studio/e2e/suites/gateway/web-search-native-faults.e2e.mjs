import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runE2E } from '../../harness/run-context.mjs';
import { closeRpcAndWait } from '../../harness/rpc.mjs';
import { startWebSearchNetworkFixture } from '../../harness/web-search-network-fixture.mjs';
import { prepareWebNativeBinary, startWebNativeSession, startWebNativeTurn, approveWebNativeSearch, completeWebNativeTurn } from '../../harness/web-search-native-session.mjs';

await runE2E(import.meta.url, {
  testId: 'native-search-owned-tls-primary-outage-allowed-fallback-all-failed-versus-empty', tier: 'full-integration',
  modelPolicy: 'Model-independent actual normal Gateway/app-server turns and WebSearch objects; fixed model choices and owned CONNECT/TLS source faults. No public search or model-quality claim.',
  prerequisites: 'Explicit web-network-test-fixture CLI build; OpenSSL; owned missing SearXNG component. No search settings/keys/MCP entries.',
  budgets: { ordinaryModelRequests: 8, logicalToolSearches: 4, exaSourceQueries: 4, bingLogicalSearches: 3, bingHttpRequests: 4, redirectHttpRequests: 2, wallClockMs: 240000 }, retainSuccessEvidence: true,
}, async context => {
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(240000)]);
  const { binary } = await prepareWebNativeBinary(context), cases = [];
  for (const scenario of ['fallback', 'unavailable', 'empty', 'bing-redirect']) {
    const network = await startWebSearchNetworkFixture(context, { scenario, resultCount: 1 });
    const session = await startWebNativeSession(context, { binary, network, label: scenario });
    const rpc = await session.connect('owner');
    try {
      const turn = await startWebNativeTurn(rpc); await approveWebNativeSearch(rpc, turn);
      const outcome = await completeWebNativeTurn(rpc, turn);
      assert.equal(outcome.completed.params.turn.status, 'completed');
      assert.equal(outcome.receipts.length, 1);
      const receipt = outcome.receipts[0]; assert.equal(receipt.operation, 'search');
      assert.equal(receipt.identity.threadId, turn.threadId); assert.equal(receipt.identity.turnId, turn.turnId);
      const started = rpc.messages().find(frame => frame.method === 'item/started' && frame.params?.threadId === turn.threadId && frame.params?.turnId === turn.turnId && frame.params?.item?.id === receipt.toolCallId);
      assert.equal(started?.params.item.name, 'WebSearch', 'Receipt must bind the actual native tool call');
      const providers = receipt.attempts.map(attempt => attempt.provider);
      if (scenario === 'empty') {
        assert.equal(receipt.status, 'empty'); assert.equal(receipt.provider, 'exa-public'); assert.equal(receipt.failure, undefined);
        assert.deepEqual(providers, ['exa-public']); assert.equal(receipt.sources.length, 0);
        assert.equal(network.observations.searches.length, 0, 'An authoritative empty result cannot silently trigger a fallback');
      } else {
        assert.deepEqual(providers, ['exa-public', 'searxng-bundled', 'bing-html']);
        assert.deepEqual(receipt.attempts.map(attempt => attempt.requestSent), [true, false, true]);
        assert.equal(receipt.attempts[0].error, 'network'); assert.equal(receipt.attempts[1].error, 'component_unavailable');
        assert.equal(network.observations.searches.length, scenario === 'bing-redirect' ? 2 : 1);
        if (scenario === 'fallback' || scenario === 'bing-redirect') {
          assert.equal(receipt.status, 'success'); assert.equal(receipt.provider, 'bing-html'); assert.equal(receipt.failure, undefined);
          assert.equal(receipt.attempts[2].status, 'success'); assert.equal(receipt.sources.length, 1);
          assert.equal(receipt.sources[0].url, network.pageUrl); assert.equal(receipt.sources[0].readStatus, 'summary_only');
          assert.match(receipt.sources[0].sourceId, /^web-[0-9a-f-]{36}$/);
          if (scenario === 'bing-redirect') {
            assert.deepEqual(network.observations.searches.map(item => item.host), ['www.bing.com', 'cn.bing.com']);
            assert.deepEqual(network.observations.searches.map(item => item.query), ['受控示例发布页 原始公告', '受控示例发布页 原始公告']);
            assert.deepEqual(network.observations.searches.map(item => item.market), ['zh-CN', 'zh-CN']);
            assert.deepEqual(network.observations.connects.filter(item => ['13.107.21.200:443','13.107.21.201:443'].includes(item.destination)).map(item => item.destination), ['13.107.21.200:443','13.107.21.201:443']);
            assert.deepEqual(network.observations.tls.filter(item => ['www.bing.com','cn.bing.com'].includes(item.host)).map(item => item.host), ['www.bing.com','cn.bing.com']);
          }
        } else {
          assert.equal(receipt.status, 'failed'); assert.equal(receipt.provider, undefined); assert.equal(receipt.sources.length, 0);
          assert.equal(receipt.failure, 'network'); assert.ok(receipt.attempts.every(attempt => attempt.status === 'failed'));
        }
      }
      assert.equal(network.sourceCalls, 1); assert.equal(network.mainModelCalls, 2);
      assert.deepEqual(network.observations.failures, []); assert.ok(network.observations.connects.every(item => item.accepted));
      const restored = await rpc.request('thread/read', { threadId: turn.threadId, limit: 100 });
      const durable = restored.messages.flatMap(message => (message.blocks || []).flatMap(block => block.webSources ? [block.webSources] : []));
      assert.deepEqual(durable, outcome.receipts);
      await session.assertModelOnlySettings();
      const settings = JSON.parse(await readFile(session.settingsFile)); assert.equal(settings.web, undefined); assert.equal(settings.mcp_servers, undefined);
      const result = { scenario, ...turn, receipt, observations: network.observations, logicalToolSearches: 1, exaBusinessRequests: network.sourceCalls, bingLogicalSearches: scenario === 'empty' ? 0 : 1, bingHttpRequests: network.observations.searches.length, redirectHttpRequests: scenario === 'bing-redirect' ? 2 : 0, durableNativeReceipt: true, noSearchConfiguration: true };
      await context.writeArtifactJson(`cases/${scenario}/native-outcome.json`, result); cases.push({ scenario, status: receipt.status, attempts: receipt.attempts });
    } catch (error) {
      await context.writeArtifactJson(`cases/${scenario}/failure.json`, { message: String(error), observations: network.observations, frames: rpc.messages() }); throw error;
    } finally { await closeRpcAndWait(rpc); await context.stopOwned(`${scenario}-gateway`); }
  }
  return { cases, noPublicNetworkForwarding: true, actualNativeToolReceipts: true, noSearchSettingsKeysOrMcp: true };
});
