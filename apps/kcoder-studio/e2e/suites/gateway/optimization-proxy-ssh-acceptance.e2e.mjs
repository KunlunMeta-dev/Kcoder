import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { startPluginProxyFixture } from '../../harness/plugin-proxy-fixture.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E } from '../../harness/run-context.mjs';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'optimization-proxy-actual-local-and-owned-ssh-cached-source-download', tier: 'manual-live',
  modelPolicy: 'model-independent actual HTTPS proxy and read-only public marketplace clone; no model, plugin install, or Hook execution',
}, async context => {
  if (process.env.KCODER_E2E_PUBLIC_MARKETPLACE !== '1') throw Error('UNMET_PREREQUISITE: explicit read-only public marketplace acceptance required');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'proxy-ssh' });
  const proxy = await startPluginProxyFixture(context, { upstreamProxy: process.env.KCODER_E2E_UPSTREAM_PROXY });
  const ssh = await startSshFixture(context);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const servers = [];
  for (const target of ['local','ssh']) {
    const profile = context.pathInState(target);
    await context.writeStateJson(`${target}/settings.json`, { active_provider: 'offline',
      providers: { offline: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
        endpoint: 'http://127.0.0.1:1/v1', default_model: 'offline', context_window_tokens: 128000,
        max_output_tokens: 1024, output_headroom_tokens: 1024, no_proxy: true } },
      plugins: { installation: { auto_detect_proxy: false, proxy_scan_ports: [proxy.badPort,proxy.goodPort], proxy_url: 'http://127.0.0.1:1' } } });
    const wrapper = context.pathInState(target, 'owned-kcoder');
    await writeFile(wrapper, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(profile)}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
    servers.push({ id: target, label: `Owned proxy ${target}`, transport: target === 'ssh' ? 'ssh' : 'local', command: wrapper,
      workspace, ...(target === 'ssh' ? {host:'127.0.0.1',port:ssh.port,user:ssh.user} : {}) });
  }
  const serversFile = await context.writeStateJson('servers.json', servers);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: ssh.gatewayEnv });
  const token = await waitForGatewayRpcToken(context, gateway);
  const results = [];
  for (const target of ['local','ssh']) {
    const rpc = await openRpc(gatewayRpcUrl(gateway, target, token));
    context.addCleanup(`close ${target} proxy acceptance RPC`, () => rpc.close());
    await initializeRpc(rpc, `proxy-source-${target}`);
    const scan = await rpc.request('plugin/proxy/configure', { enabled: true }, 30000);
    assert.equal(scan.detectedUrl, `http://127.0.0.1:${proxy.goodPort}`);
    assert.equal(scan.source, 'scan', 'independent selected target has no borrowed successful cache');
    assert.equal(scan.quickChecks, 0);
    const bytesBefore = proxy.counts.forwardedBytes;
    const added = await rpc.request('marketplace/add', { source: 'https://github.com/anthropics/skills.git' }, 60000);
    assert.ok(proxy.counts.forwardedBytes - bytesBefore > 32768, 'actual catalog clone travels through owned selected proxy');
    const cached = await rpc.request('plugin/proxy/status');
    assert.equal(cached.source, 'cache');
    assert.equal(cached.checkedPorts, 0);
    assert.equal(cached.quickChecks, 1);
    assert.ok(cached.targetHosts.every(origin => new URL(origin).hostname === 'github.com'));
    const bytesBeforeRefresh = proxy.counts.forwardedBytes;
    await rpc.request('marketplace/refresh', {marketplaceName:added.marketplaceName},60000);
    assert.ok(proxy.counts.forwardedBytes > bytesBeforeRefresh, 'repeat source fetch is real network IO');
    const refreshed = await rpc.request('plugin/proxy/status');
    assert.equal(refreshed.source, 'cache');
    assert.equal(refreshed.checkedPorts, 0);
    const rescanned = await rpc.request('plugin/proxy/configure', {enabled:true},30000);
    assert.equal(rescanned.source, 'scan');
    assert.equal(rescanned.quickChecks, 0);
    const disabled = await rpc.request('plugin/proxy/configure', {enabled:false});
    assert.equal(disabled.autoDetect,false);
    assert.equal(disabled.detectedUrl,null);
    assert.equal(disabled.configuredUrl,'http://127.0.0.1:1');
    results.push({target,scan:{source:scan.source,checkedPorts:scan.checkedPorts,quickChecks:scan.quickChecks},
      cached:{source:cached.source,checkedPorts:cached.checkedPorts,quickChecks:cached.quickChecks,targetHosts:cached.targetHosts},
      realDownload:true,realRepeatDownload:true,rescanDiscardsCache:true,disablePreservesManual:true});
  }
  await context.writeArtifactJson('proxy-local-ssh-evidence.json',{results,counts:proxy.counts,
    scope:'independent owned local and loopback SSH profiles, actual TLS and Git source operations; no physical-host/Windows/macOS inference'});
  return {passed:true,actualLocal:true,actualLoopbackSsh:true,independentTargetCaches:true};
});
