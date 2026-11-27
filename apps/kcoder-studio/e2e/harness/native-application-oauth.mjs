import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {startApprovalModelFixture} from './approval-model.mjs';
import {startOAuthMcpFixture} from './oauth-mcp.mjs';
import {startGateway,waitForGatewayRpcToken} from './gateway.mjs';
import {login} from './http.mjs';
import {closeRpcAndWait,gatewayRpcUrl,openRpc} from './rpc.mjs';
import {requireExecutable,waitFor} from './run-context.mjs';
import {materializeWorkspace} from './workspace-fixture.mjs';
import {startChromium} from './chromium.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyNativeApplicationOAuth(context){
 const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN,'explicit frozen Native CLI');
 const identity=await stat(binary),binarySha=sha(await readFile(binary));
 assert.equal(identity.nlink,1);assert.equal(binarySha,process.env.KCODER_E2E_KCODER_BIN_SHA256);
 context.addCleanup('verify original OAuth Native binary',async()=>{
  const actual=await stat(binary);assert.deepEqual([actual.dev,actual.ino,actual.size,actual.nlink],[identity.dev,identity.ino,identity.size,1]);
  assert.equal(sha(await readFile(binary)),binarySha);
 });
 const {path:workspace}=await materializeWorkspace(context,'minimal');
 const issuer=await startOAuthMcpFixture(context,{manualApproval:true,resourceScopes:['probe:read']});
 const model=await startApprovalModelFixture(context,{responseSteps:()=>{throw new Error('No model work is authorized by OAuth configuration');}});
 await context.writeStateJson('profile/settings.json',{
  active_provider:'fixture',model:'owned-oauth-ui',credential_store:'file',max_retries:0,max_tokens:128,
  session_memory:{enabled:false},memory:{observer_mode:'disabled',structured_enabled:false,legacy_prompt_enabled:false},
  providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,
   default_model:'owned-oauth-ui',context_window_tokens:128000,max_output_tokens:128,output_headroom_tokens:128,discover_models:false,no_proxy:true}},
  integrations:{connectivity:{enabled:true}},
  mcp_servers:[{name:'owned-application-oauth',transport:'http',url:issuer.root+'/mcp'}],
 });
 await context.writeStateJson('profile/trusted-folders.json',{trusted:[workspace],never:[]});
 const serversFile=await context.writeStateJson('servers.jsonc',[{id:'local',label:'Owned application OAuth target',runtime:'kcoder',transport:'local',command:binary,workspace}]);
 const gateway=await startGateway(context,{auth:true,workspace,serversFile,kcoderBin:binary,startTimeoutMs:60000,
  gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT,env:{KCODER_CONFIG_DIR:context.pathInState('profile')}});
 const cookie=await login(gateway.baseUrl,gateway.authToken);context.registerSecret(cookie);
 const token=await waitForGatewayRpcToken(context,gateway,{headers:{cookie},expectedToken:'cookie-auth'});
 const rpc=await openRpc(gatewayRpcUrl(gateway,'local',token),{headers:{Cookie:cookie,Origin:gateway.baseUrl}});
 context.addCleanup('close original application OAuth RPC',()=>closeRpcAndWait(rpc));
 await rpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'native-application-oauth-ui',version:'1'},capabilities:{experimental:{integrationScopeV1:true,connectivityV1:true}}},60000);
 const scope=await rpc.request('integrations/scope/read',{});
 let serial=0;
 const control=async(payload,operationId,expectedRevision)=>{
  const reply=await rpc.request('integrations/connectivity/prepareConnectionAction',{contractVersion:'parallel-v1',requestId:`oauth-ui-${++serial}`,scope,timeoutMs:30000,
   operationId,payload,...(expectedRevision?{expectedRevision}:{})},35000);
  assert.equal(reply.status,'completed',reply.error?.code??'Original application control did not complete');return reply.result;
 };
 const connection=await control({action:'save',connectionId:'owned-application-oauth',kind:'tencent_docs',label:'Owned OAuth application',configuration:{mcpServerName:'owned-application-oauth'},resourceGrants:[]},'owned-oauth-save');
 assert.equal((await rpc.request('mcp/list',{})).servers[0].authorization,'notAuthorized');
 const chromium=await startChromium(context);
 const page=await chromium.newPage({viewport:{width:1280,height:900}});
 const methods=[],failures=[];
 const observe=body=>{
  if(body?.method==='runtime.plugins.request')methods.push(body.params?.method??'unknown');
  if(body?.command==='local_executor_request'&&body.args?.method==='runtime.plugins.request')methods.push(body.args.params?.method??'unknown');
 };
 page.on('websocket',socket=>socket.on('framesent',({payload})=>{try{observe(JSON.parse(String(payload)));}catch{}}));
 page.on('pageerror',()=>failures.push('PAGE_SCRIPT_ERROR'));
 page.on('request',request=>{
  if(request.method()!=='POST')return;
  try{
   observe(request.postDataJSON());
  }catch{}
 });
 try{
  await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
  await page.getByTestId('connectivity-button').click();
  await page.getByTestId('native-connectivity-workspace').waitFor({timeout:30000});
  const row=page.locator('article').filter({has:page.getByRole('heading',{name:'Owned OAuth application',exact:true})});
  await row.waitFor({timeout:30000});
  const openAuthorization=async()=>{
   await row.getByRole('button',{name:/授权或更新私有凭证|Authorize or update private credentials/}).click();
   const panel=page.getByRole('region',{name:/应用授权|Application authorization/});
   await panel.getByRole('button',{name:/开始浏览器授权|Start browser authorization/}).click();
   const link=panel.getByRole('link',{name:/在浏览器授权|Authorize in browser/});
   await link.waitFor({timeout:30000});
   const url=await link.getAttribute('href');context.registerSecret(url);
   assert.equal(new URL(new URL(url).searchParams.get('redirect_uri')).origin,gateway.baseUrl);
   return {panel,link,url};
  };
  const first=await openAuthorization();
  await first.panel.getByRole('button',{name:/取消授权|Cancel authorization/}).click();
  await first.panel.waitFor({state:'detached',timeout:15000});
  // The issuer's old code cannot complete the cancelled original Native handle.
  const lateUrl=new URL(first.url);lateUrl.pathname='/approve';context.registerSecret(lateUrl.href);
  const late=await fetch(lateUrl);await late.text();
  assert.equal(issuer.events.filter(event=>event==='token-exchange').length,0);
  assert.equal((await rpc.request('mcp/list',{})).servers[0].authorization,'notAuthorized');
  const second=await openAuthorization();
  assert.notEqual(second.url,first.url,'An explicit new authorization owns a fresh flow');
  const opened=page.waitForEvent('popup');await second.link.click();const popup=await opened;
  await popup.locator('#approve').click({noWaitAfter:true});
  await waitFor(async()=>((await rpc.request('mcp/list',{})).servers[0].authorization==='authorized'),15000,'original Native OAuth authorization receipt',50,context.abortSignal);
  assert.equal(issuer.events.filter(event=>event==='token-exchange').length,1);
  await second.panel.getByRole('button',{name:/我已完成，刷新状态|Refresh authorization status/}).click();
  await second.panel.waitFor({state:'detached',timeout:15000});
  await page.screenshot({path:context.pathInArtifacts('native-application-oauth-authorized.png')});
  if(!popup.isClosed())await popup.close();
  await control({action:'disconnect',connectionId:connection.id},'owned-oauth-disconnect',connection.revision);
  assert.equal((await rpc.request('mcp/list',{})).servers[0].authorization,'notAuthorized');
  assert.equal(model.requests.length,0);assert.deepEqual(failures,[]);
  await context.writeArtifactJson('native-application-original-oauth.json',{binarySha256:binarySha,
   formalApplicationUi:true,existingNativeOAuthHandle:true,existingGatewayCallbackOrigin:true,
   cancelledOriginalFlowLateCallbackRejected:true,actualTokenExchanges:1,explicitNewFlowAuthorized:true,
   originalApplicationDisconnectRevoked:true,modelRequests:0,providerCost:'none',vendorAccountVerified:false,
   browserScriptErrors:failures,observedFormalMethods:methods,issuerEvents:issuer.events});
 }catch(error){
  const codes=(await page.locator('details code').allTextContents()).map(code=>/^[A-Z0-9_]{1,128}$/.test(code)?code:'NON_FIXED_UI_ERROR');
  await context.writeArtifactJson('native-oauth-passive-failure.json',{modelRequests:model.requests.length,observedFormalMethods:methods,issuerEvents:issuer.events,browserScriptErrors:failures,fixedUiCodes:codes,nativeRegionVisible:await page.getByTestId('native-connectivity-workspace').isVisible().catch(()=>false)});
  throw error;
 }finally{await page.close();}
}
