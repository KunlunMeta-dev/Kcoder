import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if(!process.env.KCODER_E2E_TAURI_BIN)throw new Error('Explicit Tauri binary required');
for(const mode of ['exchange','storage'])await runE2E(import.meta.url,{testId:`tauri-mcp-oauth-${mode}-failure`,tier:'manual-live',modelPolicy:'model-independent real Tauri control and target OAuth failure; displayed authorization URL followed via HTTP, external native opener excluded'},async context=>{
  const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN,kcoderBin:process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
  let fixture;
  fixture=await startOAuthMcpFixture(context,{tokenFailure:mode==='exchange',beforeTokenResponse:mode==='storage'?async()=>{
    const key=JSON.stringify([fixture.root+'/',fixture.root+'/','fixture-client']);
    await mkdir(resolve(dirname(client.settingsPath),'mcp-oauth',createHash('sha256').update(key).digest('hex')+'.json'));
  }:null});
  const panel='[data-testid="kcoder-mcp-management"]';
  try{
    const settings=JSON.parse(await readFile(client.settingsPath,'utf8'));
    settings.mcp_servers=[{name:'Owned OAuth failure',transport:'http',url:fixture.root+'/mcp'}];
    await writeFile(client.settingsPath,JSON.stringify(settings),{mode:0o600});
    await client.command('navigate',{value:'/plugins/manage'});
    await client.command('waitFor',{selector:'[data-testid="kcoder-plugin-tab-mcp"]',timeoutMs:15000});
    await waitFor(async()=> (await client.command('getText',{selector:'[data-testid="plugins-install-target"]'})).includes('/workspaces/tauri-verification'),15000,'target bootstrap');
    await client.command('click',{selector:'[data-testid="kcoder-plugin-tab-mcp"]'});
    await client.command('waitFor',{selector:panel+' [data-testid="kcoder-mcp-auth-action"]',timeoutMs:15000});
    await client.command('click',{selector:panel+' [data-testid="kcoder-mcp-auth-action"]'});
    const link='[data-testid="kcoder-mcp-open-authorization"]';
    await client.command('waitFor',{selector:link,timeoutMs:15000});
    const url=await client.command('getAttribute',{selector:link,value:'href'});context.registerSecret(url);
    const response=await fetch(url);assert.equal(response.status,502);await response.text();
    const expected=mode==='storage'?'授权凭据未能保存到此目标':'授权服务器未能完成凭据兑换';
    await waitFor(async()=> (await client.command('getText',{selector:panel})).includes(expected),15000,'localized OAuth failure');
    const text=await client.command('getText',{selector:panel});
    assert.ok(!text.includes(dirname(client.settingsPath)));
    assert.ok(!text.includes('access_token'));
    await client.capture(`oauth-${mode}-failure.png`);
  }catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
});
