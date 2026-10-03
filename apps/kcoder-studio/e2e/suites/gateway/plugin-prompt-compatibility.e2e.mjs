import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { runE2E } from '../../harness/run-context.mjs';
if (process.env.KCODER_E2E_PUBLIC_MARKETPLACE !== '1') throw new Error('Explicit public marketplace access required');
// QA: public catalog + real managed install, current skill catalog and immutable
// generated-resource leases; no model response is used as correctness evidence.
await runE2E(import.meta.url, { testId: 'public-plugin-prompt-compatibility', tier: 'manual-live',
  modelPolicy: 'model-independent real marketplace packages and registered plugin prompt profiles' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  await context.writeStateJson('config/settings.json', { providers: {}, plugins: { installation: { proxy_url: process.env.KCODER_E2E_PLUGIN_PROXY || null } } });
  const gateway = await startGateway(context, { workspace, env: { KCODER_CONFIG_DIR: context.pathInState('config') } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token));
  context.addCleanup('close prompt RPC', () => rpc.close());
  await initializeRpc(rpc, 'plugin-prompt-compatibility');
  const rows = [];
  for (const [source, sample] of [
    ['https://download.codebuddy.cn/plugin-marketplace/codebuddy-plugins-official.zip', 'agent-sdk-dev'],
    ['https://cnb.cool/codebuddy/marketplace', 'agents-business-finance'],
  ]) {
    const added = await rpc.request('marketplace/add', { source }, 120000);
    const markets = await rpc.request('marketplace/list');
    const market = markets.marketplaces.find(value => value.id === added.marketplaceName);
    assert.ok(market);
    const entry = market.plugins.find(value => value.pluginId === `${sample}@${market.id}`);
    assert.ok(entry && entry.installPolicy !== 'NOT_AVAILABLE', sample);
    const installed = await rpc.request('plugin/install', { marketplaceName: market.id, pluginName: sample }, 60000);
    const names = installed.plugin.components.filter(value => value.kind === 'skill').map(value => value.name);
    assert.ok(names.some(name => name.startsWith('plugin:')), 'plugin prompt launcher must be visible');
    const catalog = (await rpc.request('device/execute', { command_key: 'ls_skills' })).stdout;
    const prompt = catalog.find(value => names.includes(value.name) && value.name.startsWith('plugin:'));
    assert.ok(prompt, 'new-session skill catalog includes adapted plugin');
    await access(prompt.path);
    const refreshed = (await rpc.request('device/execute', { command_key: 'ls_skills' })).stdout;
    assert.equal(refreshed.find(value => value.name === prompt.name).path, prompt.path, 'repeated catalog reads preserve profile paths');
    rows.push({ market: market.id, total: market.plugins.length, unavailable: market.plugins.filter(value => value.installPolicy === 'NOT_AVAILABLE').length, sample, launchers: names.length, compatibility: installed.plugin.compatibility });
    await rpc.request('plugin/uninstall', { pluginId: installed.plugin.id, purgeData: true });
  }
  await context.writeArtifactJson('prompt-compatibility.json', rows);
});
