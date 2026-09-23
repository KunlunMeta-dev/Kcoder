import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startOAuthMcpFixture } from '../../harness/oauth-mcp.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
for (const mode of ['exchange-failure','save-failure','discovery-failure','cancel-late-callback']) {
await runE2E(import.meta.url, { testId:`mcp-oauth-${mode}`,tier:'full-integration',modelPolicy:'model-independent real OAuth HTTP and private target storage failures; synthetic credentials only' }, async context => {
  const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:mode});
  const config=context.pathInState('config');
  let poisonedPath;
  let fixture;
  fixture=await startOAuthMcpFixture(context,{tokenFailure:mode==='exchange-failure',toolsListFailure:mode==='discovery-failure',beforeTokenResponse:mode==='save-failure'?async()=>{
    const key=JSON.stringify([fixture.root+'/',fixture.root+'/','fixture-client']);
    poisonedPath=resolve(config,'mcp-oauth',createHash('sha256').update(key).digest('hex')+'.json');
    await mkdir(poisonedPath);
  }:null});
  const model=await startApprovalModelFixture(context,{textOnly:true});
  await context.writeStateJson('config/settings.json',{active_provider:'fixture',providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'fixture',context_window_tokens:128000,max_output_tokens:1024,output_headroom_tokens:1024}},mcp_servers:[{name:'fault-probe',transport:'http',url:fixture.root+'/mcp'}]});
  await context.writeStateJson('config/credentials.json',{});
  const binary=process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder');
  const gateway=await startGateway(context,{workspace,kcoderBin:binary,env:{KCODER_CONFIG_DIR:config}});
  const token=await waitForGatewayRpcToken(context,gateway);
  const rpc=await openRpc(gatewayRpcUrl(gateway,'local',token));
  context.addCleanup('close fault OAuth RPC',()=>rpc.close());
  await initializeRpc(rpc,'oauth-fault-matrix');
  const login=await rpc.request('gateway/mcp/login',{server:{name:'fault-probe'}});
  context.registerSecret(login.authorizationUrl);
  let replacement;
  if(mode==='cancel-late-callback'){
    await rpc.request('mcp/cancel',{flowId:login.flowId});
    replacement=await rpc.request('gateway/mcp/login',{server:{name:'fault-probe'}});
    context.registerSecret(replacement.authorizationUrl);
  }
  const response=await fetch(login.authorizationUrl);
  const page=await response.text();
  assert.ok(!page.includes('access_token'),'callback page must not expose token payload');
  if(mode==='discovery-failure'){
    const completed=await rpc.waitFor(m=>m.method==='mcp/authorizationChanged'&&m.params.flowId===login.flowId,15000,'saved authorization');
    assert.equal(completed.params.status,'authorized');
    assert.equal((await rpc.request('mcp/list')).servers[0].authorization,'authorized');
    const {thread}=await rpc.request('thread/start',{});
    assert.ok(!JSON.stringify(await rpc.request('tools/catalog',{threadId:thread.id})).includes('oauth_probe'));
    const status=(await rpc.request('mcp/list')).servers[0];
    assert.equal(status.authorization,'authorized');
    assert.equal(status.lastConnectionAttempt,'unavailable','saved credentials must not imply discovered tools');
    await rpc.request('thread/delete',{threadId:thread.id});
  }else if(mode==='cancel-late-callback'){
    assert.ok(response.status>=400, `late callback rejected with HTTP ${response.status}`);
    assert.equal(fixture.events.filter(e=>e==='token-exchange').length,0);
    assert.notEqual((await rpc.request('mcp/list')).servers[0].authorization,'authorized');
    await (await fetch(replacement.authorizationUrl)).text();
    const completed=await rpc.waitFor(m=>m.method==='mcp/authorizationChanged'&&m.params.flowId===replacement.flowId,15000,'replacement flow authorization');
    assert.equal(completed.params.status,'authorized');
    assert.equal((await rpc.request('mcp/list')).servers[0].authorization,'authorized');
    assert.ok(!rpc.messages().some(m=>m.method==='mcp/authorizationChanged'&&m.params.flowId===login.flowId&&m.params.status==='authorized'));
  }else{
    const completed=await rpc.waitFor(m=>m.method==='mcp/authorizationChanged'&&m.params.flowId===login.flowId,15000,'failed authorization');
    assert.equal(completed.params.status,'failed');
    const expected=mode==='exchange-failure'?'token_exchange_failed':'credential_storage_failed';
    assert.equal(completed.params.message,expected);
    assert.ok(page.includes(expected));
    assert.ok(!JSON.stringify(completed).includes(config),'notification must not expose private storage path');
    if(poisonedPath)await rm(poisonedPath,{recursive:true});
    assert.notEqual((await rpc.request('mcp/list')).servers[0].authorization,'authorized');
  }
  assert.equal(fixture.events.filter(e=>e==='token-exchange').length,1);
  assert.equal(model.requests.length,0);
  return { mode, events:fixture.events, noModelRequests:true };
});
}
