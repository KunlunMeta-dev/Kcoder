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
const sources={A:'owned_provider_a',U:'owned_provider_unknown',S:'owned_provider_unsupported'};

/** Real ordinary Native/Gateway/UI with the existing owned issuer and receipts. */
export async function verifyNativeProviderRevocation(context){
 const binary=await requireExecutable(process.env.KCODER_E2E_KCODER_BIN,'explicit new ordinary Native CLI');
 const identity=await stat(binary),binarySha256=sha(await readFile(binary));assert.equal(identity.nlink,1);
 assert.equal(binarySha256,process.env.KCODER_E2E_KCODER_BIN_SHA256??process.env.KCODER_E2E_KCODER_SHA256);
 context.addCleanup('verify provider revocation original Native binary',async()=>{const after=await stat(binary);assert.deepEqual([after.dev,after.ino,after.size,after.nlink],[identity.dev,identity.ino,identity.size,1]);assert.equal(sha(await readFile(binary)),binarySha256);});
 const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:'provider-revocation'});
 const preResponseReceipts=[],requests=new Map();let rpc;
 const issuer=await startOAuthMcpFixture(context,{manualApproval:true,resourceScopes:['probe:read'],accountSubjects:['A','U','S'],providerRevocation:{},beforeRevocationResponse:async event=>{
  const requestId=requests.get(event.subject);assert.ok(requestId,'The original UI request must be observed before its POST');
  const receipt=await rpc.request('mcp/providerRevocation',{action:'read',requestId,server:{name:sources[event.subject],pluginId:null}},15000);
  assert.equal(receipt.phase,'unknown','The original durable receipt must precede the provider response');assert.equal(receipt.localCredentialsRemoved,false);
  preResponseReceipts.push({subject:event.subject,requestId,phase:receipt.phase,reason:receipt.reason});
 }});
 issuer.advertiseProviderRevocation(false);
 let phase='setup',selected='S',mayBeDenied=false;const protocol=[],uiProgress=[];
 const model=await startApprovalModelFixture(context,{responseSteps:({body})=>{
  assert.ok(model.requests.length<=24,'Bounded fixed protocol requests, no paid model');
  if(body.messages.at(-1)?.role==='tool')return [{delta:{content:'OWNED_PROVIDER_SOURCE_RESULT_OBSERVED'},finishReason:'stop'}];
  const tool=body.tools?.find(value=>value.function?.name.includes(sources[selected])&&value.function.name.includes('oauth_probe'));
  if(!tool){assert.ok(mayBeDenied,'An explicitly authorized source must be available before revocation');protocol.push({phase,source:selected,toolMissing:true});return [{delta:{content:'OWNED_ORIGINAL_SOURCE_UNAVAILABLE'},finishReason:'stop'}];}
  protocol.push({phase,source:selected,toolName:tool.function.name});
  return [{delta:{role:'assistant',tool_calls:[{index:0,id:'provider-'+phase,type:'function',function:{name:tool.function.name,arguments:'{}'}}]},finishReason:'tool_calls'}];
 }});
 await context.writeStateJson('profile/settings.json',{active_provider:'fixture',model:'owned-provider-protocol',credential_store:'file',permission_mode:'ask',max_retries:0,max_tokens:256,session_memory:{enabled:false},memory:{observer_mode:'disabled',structured_enabled:false,legacy_prompt_enabled:false},
  permission_rules:Object.values(sources).map(source=>({tool:`mcp__${source}__oauth_probe`,action:'allow'})),
  providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'owned-provider-protocol',context_window_tokens:128000,max_output_tokens:256,output_headroom_tokens:256,discover_models:false,no_proxy:true}},
  integrations:{connectivity:{enabled:true}},mcp_servers:Object.entries(sources).map(([subject,name])=>({name,transport:'http',url:issuer.root+'/mcp',policy:{oauth_account:'provider_'+subject.toLowerCase()}})),
 });
 await context.writeStateJson('profile/trusted-folders.json',{trusted:[workspace],never:[]});await context.writeStateJson('profile/credentials.json',{});
 const serversFile=await context.writeStateJson('servers.jsonc',[{id:'local',label:'Owned provider lifecycle target',runtime:'kcoder',transport:'local',command:binary,workspace}]);
 const gateway=await startGateway(context,{auth:true,workspace,serversFile,kcoderBin:binary,startTimeoutMs:60000,gatewayRoot:process.env.KCODER_E2E_GATEWAY_ROOT,env:{KCODER_CONFIG_DIR:context.pathInState('profile')}});
 const cookie=await login(gateway.baseUrl,gateway.authToken);context.registerSecret(cookie);
 const token=await waitForGatewayRpcToken(context,gateway,{headers:{cookie},expectedToken:'cookie-auth'});
 rpc=await openRpc(gatewayRpcUrl(gateway,'local',token),{headers:{Cookie:cookie,Origin:gateway.baseUrl}});context.addCleanup('close ordinary provider lifecycle RPC',()=>closeRpcAndWait(rpc));
 const initialized=await rpc.request('initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'ordinary-provider-revocation',version:'1'},capabilities:{experimental:{integrationScopeV1:true,connectivityV1:true,taskSourcesV1:true,taskSourceChoicesV1:true,studioWorkModesV1:true}}},60000);
 assert.equal(initialized.capabilities.experimental.mcpProviderRevocationV1,true,'Use a new normal Native build that includes live pre-dispatch validation');
 const scope=await rpc.request('integrations/scope/read',{});let serial=0;
 const call=async(method,payload,operationId,expectedRevision)=>{const result=await rpc.request('integrations/connectivity/'+method,{contractVersion:'parallel-v1',requestId:'provider-ui-'+(++serial),scope,timeoutMs:30000,payload,...(operationId?{operationId}:{}),...(expectedRevision?{expectedRevision}:{})},35000);assert.equal(result.status,'completed',result.error?.code??'original public control incomplete');return result.result;};
 const connections={};for(const subject of ['S','A','U'])connections[subject]=await call('prepareConnectionAction',{action:'save',connectionId:'provider-'+subject,kind:'tencent_docs',label:'Owned provider '+subject,configuration:{mcpServerName:sources[subject]},resourceGrants:[]},'save-provider-'+subject);
 const chromium=await startChromium(context),page=await chromium.newPage({viewport:{width:1280,height:900}});context.addCleanup('close provider lifecycle UI page',()=>page.close());
 const browserFailures=[];page.on('pageerror',()=>browserFailures.push('PAGE_SCRIPT_ERROR'));
 const threads=[];context.addCleanup('delete only owned provider lifecycle threads',async()=>{for(const id of threads.splice(0).filter(Boolean).reverse())await rpc.request('thread/delete',{threadId:id});});
 const row=subject=>page.locator('article').filter({has:page.getByRole('heading',{name:'Owned provider '+subject,exact:true})});
 const authPanel=()=>page.getByRole('region',{name:/^应用授权|^Application authorization/});
 const lifecycle=()=>page.getByRole('region',{name:/授权清理与回执|Authorization cleanup and receipts/});
 const open=async subject=>{await row(subject).getByRole('button',{name:/授权或更新私有凭证|Authorize or update private credentials/}).click();await lifecycle().waitFor({timeout:30000});return lifecycle();};
 const close=async()=>{const panel=authPanel();await panel.getByRole('button',{name:/取消授权|Cancel authorization/}).click();await panel.waitFor({state:'detached',timeout:15000});};
 const authorize=async subject=>{
  phase='authorize-'+subject+'-open';
  await open(subject);const panel=authPanel();await panel.getByRole('button',{name:/开始浏览器授权|Start browser authorization/}).click();const link=panel.getByRole('link',{name:/在浏览器授权|Authorize in browser/});await link.waitFor({timeout:30000});const uri=await link.getAttribute('href');context.registerSecret(uri);
  assert.equal(new URL(new URL(uri).searchParams.get('redirect_uri')).origin,gateway.baseUrl);
  const opening=page.waitForEvent('popup');await link.click();const popup=await opening;await popup.locator('#approve-'+subject).click({noWaitAfter:true});
  await waitFor(async()=>(await rpc.request('mcp/list',{})).servers.find(item=>item.name===sources[subject])?.authorization==='authorized',15000,'original Native '+subject+' authorization',50,context.abortSignal);
  phase='authorize-'+subject+'-refresh';
  await panel.getByRole('button',{name:/我已完成，刷新状态|Refresh authorization status/}).click();
  uiProgress.push({phase,panelsAfterClick:await panel.count(),browserPages:page.context().pages().length});
  await panel.waitFor({state:'detached',timeout:15000});if(!popup.isClosed())await popup.close();
  uiProgress.push({phase:'authorize-'+subject+'-closed',nativeAuthorized:true});
 };
 const reads=[];const run=async(subject,name,expectIo)=>{
  phase=name;selected=subject;mayBeDenied=!expectIo;const before={...issuer.requestCounts},boundary=new Set(rpc.messages());
  let id=threads[['A','U','S'].indexOf(subject)];
  if(!id){id=(await rpc.request('thread/start',{cwd:workspace,studioWorkMode:'kcoder'},45000)).thread.id;threads[['A','U','S'].indexOf(subject)]=id;}
  const accepted=await rpc.request('turn/start',{threadId:id,input:[{type:'text',text:'OWNED_PROVIDER_PHASE:'+name}],clientPresentation:{version:1,studioWorkMode:'kcoder'}},45000);
  const done=await rpc.waitFor(message=>!boundary.has(message)&&message.method==='turn/completed'&&message.params?.threadId===id&&message.params?.turnId===accepted.turn.id,45000,'original session '+name);
  const after={...issuer.requestCounts};if(expectIo){assert.equal(done.params.turn.status,'completed');assert.ok(after.mcp>before.mcp);}else{assert.equal(after.mcp,before.mcp,'The existing session contribution cannot send its old Bearer after fencing');assert.equal(after.refresh,before.refresh,'The old session cannot refresh after fencing');}
  const observation={subject,phase:name,threadId:id,turnId:accepted.turn.id,status:done.params.turn.status,before,after};reads.push(observation);return observation;
 };
 const observedRequests=[];
 const rememberRequest=async(subject,region)=>{
  const text=await region.locator('details').allTextContents();const id=text.join(' ').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];assert.ok(id,'The normal UI exposes its original metadata request identity');requests.set(subject,id);observedRequests.push({subject,requestId:id});return id;
 };
 try{
  await page.goto(gateway.baseUrl,{waitUntil:'domcontentloaded'});await page.locator('input[name="token"]').fill(gateway.authToken);await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);await page.getByTestId('connectivity-button').click();await page.getByTestId('native-connectivity-workspace').waitFor({timeout:30000});
  await authorize('S');issuer.advertiseProviderRevocation(true);await authorize('A');await authorize('U');
  for(const subject of ['A','U','S'])await run(subject,subject+'-original-session',true);
  // This source's original saved metadata did not declare an endpoint.
  let region=await open('S');await region.getByRole('button',{name:/准备提供方撤销|Prepare provider revocation/}).click();await region.getByRole('status').filter({hasText:/未提供可用的撤销方式|No supported revocation method/}).waitFor({timeout:15000});
  const unsupportedId=await rememberRequest('S',region);const unsupported=await rpc.request('mcp/providerRevocation',{action:'read',requestId:unsupportedId,server:{name:sources.S,pluginId:null}});assert.equal(unsupported.phase,'unsupported');assert.equal(unsupported.localCredentialsRemoved,false);assert.equal(issuer.providerRevocations.length,0);await region.screenshot({path:context.pathInArtifacts('ordinary-provider-unsupported-receipt.png')});await close();await run('S','S-unsupported-credentials-retained',true);
  region=await open('A');await region.getByRole('button',{name:/准备提供方撤销|Prepare provider revocation/}).click();await region.getByRole('status').filter({hasText:/原撤销请求已准备|original request is prepared/}).waitFor({timeout:15000});const acceptedId=await rememberRequest('A',region);assert.equal(issuer.providerRevocations.length,0);
  await region.getByRole('checkbox',{name:/向原授权已发现的提供方端点|Submit revocation to the provider endpoint/}).check();await region.getByRole('button',{name:/确认提供方撤销|Confirm provider revocation/}).click();await region.getByRole('status').filter({hasText:/提供方已接受原令牌|provider accepted revocation of the original token/}).waitFor({timeout:20000});
  const accepted=await rpc.request('mcp/providerRevocation',{action:'read',requestId:acceptedId,server:{name:sources.A,pluginId:null}});assert.equal(accepted.phase,'accepted');assert.equal(accepted.localCredentialsRemoved,false);assert.equal(issuer.providerRevocations.filter(item=>item.subject==='A').length,1);await region.screenshot({path:context.pathInArtifacts('ordinary-provider-accepted-receipt.png')});await close();await run('A','A-old-session-after-provider-acceptance',false);
  region=await open('A');await region.getByRole('checkbox',{name:/仅清除当前来源|Clear this source’s local authorization/}).check();await region.getByRole('button',{name:/清除本地授权并停用|Clear local authorization and disable/}).click();await region.getByRole('status').filter({hasText:/原生端已确认清除本地授权|Native confirmed local authorization clearing/}).waitFor({timeout:20000});
  const localText=(await region.locator('details').allTextContents()).join(' ');const localId=localText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];assert.ok(localId);
  const local=await call('readConnection',{connectionId:connections.A.id,localCleanupReceipt:{operationId:localId,connectionRef:{id:connections.A.id,revision:connections.A.revision}}});assert.equal(local.localAuthorizationCleanup.localRemoval,'accepted');assert.equal(local.localAuthorizationCleanup.providerRevocationRequested,false);assert.equal(local.localAuthorizationCleanup.availability,'disabled');assert.equal(issuer.providerRevocations.length,1);await close();
  issuer.setProviderRevocationMode('U','lost-ack');region=await open('U');await region.getByRole('button',{name:/准备提供方撤销|Prepare provider revocation/}).click();await region.getByRole('status').filter({hasText:/原撤销请求已准备|original request is prepared/}).waitFor({timeout:15000});const unknownId=await rememberRequest('U',region);
  await region.getByRole('checkbox',{name:/向原授权已发现的提供方端点|Submit revocation to the provider endpoint/}).check();await region.getByRole('button',{name:/确认提供方撤销|Confirm provider revocation/}).click();await region.getByRole('status').filter({hasText:/提供方结果未确认|provider outcome is unconfirmed/}).waitFor({timeout:20000});
  const unknown=await rpc.request('mcp/providerRevocation',{action:'read',requestId:unknownId,server:{name:sources.U,pluginId:null}});assert.equal(unknown.phase,'unknown');assert.equal(unknown.localCredentialsRemoved,false);await region.screenshot({path:context.pathInArtifacts('ordinary-provider-unknown-receipt.png')});const postCount=issuer.providerRevocations.length;await close();
  region=await open('U');await region.getByRole('status').filter({hasText:/提供方结果未确认|provider outcome is unconfirmed/}).waitFor({timeout:15000});assert.equal(await region.getByRole('button',{name:/准备提供方撤销|Prepare provider revocation/}).count(),0);await region.getByRole('button',{name:/读取原提供方回执|Read original provider receipt/}).click();assert.equal(issuer.providerRevocations.length,postCount);await close();
  await page.reload({waitUntil:'domcontentloaded'});if(!await page.getByTestId('native-connectivity-workspace').isVisible())await page.getByTestId('connectivity-button').click();await row('U').waitFor({timeout:30000});region=await open('U');await region.getByRole('status').filter({hasText:/提供方结果未确认|provider outcome is unconfirmed/}).waitFor({timeout:15000});assert.equal(await rememberRequest('U',region),unknownId);await close();
  await run('U','U-old-session-after-lost-provider-ack',false);assert.equal(issuer.providerRevocations.filter(item=>item.subject==='U').length,1);assert.equal(issuer.providerRevocations.length,2);assert.deepEqual(browserFailures,[]);assert.deepEqual(issuer.fixtureErrors,[]);
  await page.screenshot({path:context.pathInArtifacts('ordinary-provider-lifecycle-receipts.png')});
  const proof={binarySha256,formalApplicationUi:true,originalNativeManagement:true,controlledIssuer:true,providerAccepted:accepted,providerUnsupported:unsupported,providerUnknown:unknown,localCleanup:local.localAuthorizationCleanup,preResponseReceipts,observedRequests,providerRevocations:issuer.providerRevocations,requestCounts:issuer.requestCounts,reads,protocol,modelRequests:model.requests.length,paidModels:0,vendorAccountVerified:false,browserFailures,fixtureErrors:issuer.fixtureErrors};
  await context.writeArtifactJson('ordinary-native-provider-revocation-proof.json',proof);
  return {providerAcceptedOnly:true,unsupportedCredentialsRetained:true,unknownOriginalReopenedWithoutReplay:true,oldSessionsNoExtraMcpOrRefresh:true,localAndProviderReceiptsSeparate:true,actualProviderPosts:2,paidModels:0};
 }catch(error){let screenshotStatus='captured';await page.screenshot({path:context.pathInArtifacts('ordinary-provider-passive-failure.png'),timeout:2000}).catch(()=>{screenshotStatus='capture-failed';});const fixedUiCodes=(await page.locator('details code').allTextContents()).map(value=>/^[A-Z0-9_]{1,128}$/.test(value)?value:'NON_FIXED_UI_CODE');await context.writeArtifactJson('ordinary-provider-passive-failure.json',{phase,uiProgress,screenshotStatus,fixedUiCodes,issuerAccountEvents:issuer.accountEvents,observedRequests,preResponseReceipts,providerRevocations:issuer.providerRevocations,requestCounts:issuer.requestCounts,reads,protocol,modelRequests:model.requests.length,browserFailures,fixtureErrors:issuer.fixtureErrors});throw error;}
}
