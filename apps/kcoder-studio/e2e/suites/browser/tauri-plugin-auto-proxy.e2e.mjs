import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startPluginProxyFixture } from '../../harness/plugin-proxy-fixture.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (process.env.KCODER_E2E_PUBLIC_MARKETPLACE !== '1' || !process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit public-marketplace and Tauri prerequisites required');
await runE2E(import.meta.url, { testId:'tauri-plugin-proxy-failover',tier:'manual-live',modelPolicy:'owned false-positive and working proxies, real GitHub catalog via TLS, no model or hooks' }, async context => {
  const proxy = await startPluginProxyFixture(context, { upstreamProxy: process.env.KCODER_E2E_UPSTREAM_PROXY });
  const client = await startOwnedAiVerify(context, { tauriBin:process.env.KCODER_E2E_TAURI_BIN,kcoderBin:process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist') });
  const settings = JSON.parse(await readFile(client.settingsPath,'utf8'));
  settings.plugins ??= {}; settings.plugins.installation ??= {};
  Object.assign(settings.plugins.installation,{auto_detect_proxy:false,proxy_scan_ports:[proxy.badPort,proxy.goodPort],proxy_url:'http://127.0.0.1:1'});
  await writeFile(client.settingsPath,JSON.stringify(settings));
  const selector = id => `[data-testid="${id}"]`;
  const click = id => client.command('click',{selector:selector(id)});
  try {
    await client.command('navigate',{value:'/plugins'});
    await waitFor(async () => (await client.command('getText',{selector:selector('plugins-install-target')})).includes('/workspaces/tauri-verification'),15000,'target bootstrap');
    await client.command('waitFor',{selector:`${selector('plugins-auto-proxy-switch')}:not(:disabled)`,timeoutMs:15000});
    await click('plugins-auto-proxy-switch');
    await client.command('waitFor',{selector:selector('plugins-auto-proxy'),text:`http://127.0.0.1:${proxy.goodPort}`,timeoutMs:30000});
    assert.ok(proxy.counts.bad>=2,'open first port must be rejected by actual TLS verification');
    assert.ok(proxy.events.lastIndexOf('good')>proxy.events.lastIndexOf('bad'));
    const enabled=JSON.parse(await readFile(client.settingsPath,'utf8'));
    assert.equal(enabled.plugins.installation.auto_detect_proxy,true);
    assert.equal(enabled.plugins.installation.proxy_url,'http://127.0.0.1:1','manual fallback is preserved');
    const before=proxy.counts.forwardedBytes;
    await client.command('press',{selector:selector('plugins-marketplace-selector'),key:'ArrowDown'});
    await client.command('waitFor',{selector:'[role="option"][data-value="preset:anthropic-skills"]'});
    await client.command('click',{selector:'[role="option"][data-value="preset:anthropic-skills"]'});
    await client.command('waitFor',{selector:selector('plugin-marketplace-install-document-skills@anthropic-agent-skills'),timeoutMs:60000});
    assert.ok(proxy.counts.forwardedBytes-before>32768,'catalog clone must actually travel through the detected proxy');
    // Reopening consumes the authoritative proxy telemetry after actual catalog
    // downloads, rather than retaining the initial scan result in component state.
    await client.command('navigate',{value:'/settings'});
    await client.command('navigate',{value:'/plugins'});
    await client.command('waitFor',{selector:selector('plugins-proxy-details'),text:'0 个端口',timeoutMs:15000});
    await client.command('waitFor',{selector:selector('plugins-proxy-details'),text:'1 次缓存快验'});
    await client.command('click',{selector:`${selector('plugins-proxy-details')} summary`});
    await client.command('waitFor',{selector:selector('plugins-proxy-details'),text:'已重新验证近期成功代理'});
    await client.command('waitFor',{selector:selector('plugins-proxy-details'),text:'github.com'});
    await client.capture('auto-proxy-used.png');
    const badBeforeRescan=proxy.counts.bad;
    await click('plugins-auto-proxy-rescan');
    await client.command('waitFor',{selector:selector('plugins-auto-proxy'),text:`http://127.0.0.1:${proxy.goodPort}`,timeoutMs:30000});
    await waitFor(()=>proxy.counts.bad>badBeforeRescan,15000,'explicit rescan discards the recent cache');
    await click('plugins-auto-proxy-switch');
    await waitFor(async()=>JSON.parse(await readFile(client.settingsPath,'utf8')).plugins.installation.auto_detect_proxy===false,15000,'automatic proxy disabled');
    await context.writeArtifactJson('proxy-results.json',{sequentialFailover:true,verifiedProxy:`http://127.0.0.1:${proxy.goodPort}`,counts:proxy.counts,downloadUsedProxy:true,nativeCacheReadback:{checkedPorts:0,quickChecks:1,targetHosts:['github.com']},explicitRescanInvalidatesCache:true,manualPreserved:true,disabled:true});
  } catch(error) {client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
  finally {await client.stop();}
});
