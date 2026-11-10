import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, rename, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway } from '../../harness/gateway.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, { testId: 'gateway-migration-source-session', tier: 'full-integration',
  modelPolicy: 'model-independent actual authenticated HTTP/Gateway/Native process ownership; no model turns' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const model = await startApprovalModelFixture(context, { responseSteps: () => [{delta:{role:'assistant',content:'UNEXPECTED'},finishReason:'stop'}] });
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', { credential_store: 'file', active_provider: 'fixture', providers: {
    fixture: { api_format: 'openai_chat_completions', authentication: {mode:'none'}, endpoint: model.baseUrl,
      default_model: 'fixture', context_window_tokens: 128000, max_output_tokens: 8192, output_headroom_tokens: 8192, no_proxy: true, discover_models: false },
  } });
  const source = context.pathInState('source');
  await context.writeStateJson('source/settings.json', {model:'inert-source-model'});
  await context.writeStateJson('profile/trusted-folders.json', { trusted: [workspace], never: [] });
  await mkdir(resolve(workspace, '.claude'), { recursive: true, mode: 0o700 });
  await writeFile(resolve(workspace, '.claude/settings.json'), JSON.stringify({ model: 'owned-project-model', ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`unobserved_field_${i}`, true])) }), { mode: 0o600 });
  const historyId=randomUUID();
  const historyRecord={type:'user',uuid:'message',sessionId:historyId,message:{role:'user',content:'Owned historical text'}};
  const historyFile=await context.writeStateJson(`source/projects/example/${historyId}.jsonl`,historyRecord);
  await writeFile(historyFile,JSON.stringify(historyRecord)+'\n',{mode:0o600});
  const destination = context.pathInState('destination');
  const sourceSettings = await readFile(resolve(profile,'settings.json'),'utf8');
  await context.writeStateJson('destination/settings.json',JSON.parse(sourceSettings));
  const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
  const launcher=context.pathInState('destination-launcher');
  await writeFile(launcher,`#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(destination)}\nexec ${quote(binary)} "$@"\n`,{mode:0o700});
  const serversFile = await context.writeStateJson('servers.json', [
    { id:'local',label:'Owned migration source',transport:'local',command:binary,workspace },
    { id:'destination',label:'Owned migration destination',transport:'local',command:launcher,workspace },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin:binary, auth:true, env:{KCODER_CONFIG_DIR:profile,CLAUDE_CONFIG_DIR:source} });
  async function login(currentGateway=gateway) {
    const response = await fetch(`${currentGateway.baseUrl}/api/mobile/session`, { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:currentGateway.authToken}) });
    assert.equal(response.status,200); const data=await response.json(); context.registerSecret(data.accessToken); return data.accessToken;
  }
  const first=await login(), second=await login();
  async function call(operation, payload, token=first, extra={}) {
    const response=await fetch(`${gateway.baseUrl}/api/migration/source-session/${operation}`,{method:'POST',
      headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`} : {}),...extra},body:JSON.stringify(payload)});
    return {status:response.status,body:await response.json()};
  }
  const input={sessionId:randomUUID(),purpose:'source',targetId:'local',workspacePath:workspace};
  assert.equal((await call('open',input,null)).status,401);
  assert.equal((await call('open',input,first,{origin:'https://untrusted.invalid'})).status,403);
  assert.equal((await call('open',{...input,principal:{kind:'localOs'}})).status,400);
  const opened=await call('open',input); assert.equal(opened.status,200,JSON.stringify(opened.body));
  assert.equal(opened.body.status,'ready'); assert.equal(opened.body.ownedChildren,1);
  assert.deepEqual(await call('open',input),opened,'same request reuses its own child');
  const configurations=await call('query',{session:input,query:{kind:'configuration',params:{sources:['claude-code']}}});
  assert.equal(configurations.status,200,JSON.stringify(configurations.body));
  assert.ok(configurations.body.sources.some(item=>item.kind==='claude-code'));
  const layered = await call('query', { session: input, query: { kind: 'configuration', params: { sources: ['claude-code'], includeProject: true } } });
  assert.equal(layered.status, 200, JSON.stringify(layered.body));
  const layerSource = layered.body.sources.find(item => item.kind === 'claude-code' && item.scope === 'project-effective');
  assert.ok(layerSource, 'the original owned child discovers the trusted Claude layer family');
  const reportQuery = pageIndex => ({ session: input, query: { kind: 'configuration_layers_read', params: { sourceId: layerSource.sourceId, pageIndex } } });
  const report = await call('query', reportQuery(0));
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.status, 'available');
  assert.deepEqual(report.body.target, { kind: 'source', sourceId: layerSource.sourceId });
  assert.equal(report.body.fields.length, 10);
  assert.equal(report.body.totalFields, 13);
  assert.equal(report.body.nextPage, 1);
  const secondReport = await call('query', reportQuery(1));
  assert.equal(secondReport.status, 200, JSON.stringify(secondReport.body));
  assert.equal(secondReport.body.fields.length, 3);
  assert.equal(secondReport.body.nextPage, null);
  assert.equal(JSON.stringify(report.body).includes('owned-project-model'), false, 'reports never expose values');
  assert.equal((await call('read', input)).body.ownedChildren, 1, 'layer reports reuse the original source child');
  for (const params of [{ target: { kind: 'job', jobId: 'peer' } }, { sourceId: layerSource.sourceId, path: '/private' }]) {
    assert.equal((await call('query', { session: input, query: { kind: 'configuration_layers_read', params } })).status, 400);
  }
  await context.writeArtifactJson('source-configuration-layer-report.json', { sourceId: layerSource.sourceId,
    pages: [report.body, secondReport.body], sameOriginalChild: true, rejectedTargetAndPath: true });

  const catalog=await call('query',{session:input,query:{kind:'history',params:{source:'claude-code'}}});
  assert.equal(catalog.status,200,JSON.stringify(catalog.body));
  const page=await call('query',{session:input,query:{kind:'history_page',params:{catalogId:catalog.body.catalogId,cursor:null}}});
  assert.equal(page.status,200,JSON.stringify(page.body));
  assert.equal(page.body.items.length,1);
  assert.equal(page.body.totalItems,1);
  assert.equal(page.body.problems.length,0);
  assert.equal((await call('query',{session:input,query:{kind:'configuration',params:{}}},second)).status,409);

  assert.equal((await call('read',input,second)).status,409);
  assert.equal((await call('close',input,second)).status,409);
  assert.equal((await call('read',input)).body.status,'ready','peer cannot terminate original');
  assert.equal((await call('read',{...input,workspacePath:resolve(workspace,'different')})).status,409);
  const destinationSession={...input,sessionId:randomUUID(),purpose:'target',targetId:'destination'};
  assert.equal((await call('open',destinationSession)).body.status,'ready');
  assert.equal((await call('query', { ...reportQuery(0), session: destinationSession })).status, 409, 'a target child cannot inspect the source report');
  async function transfer(operation,payload,{discard=false}={}) {
    const response=await fetch(`${gateway.baseUrl}/api/migration/source-transfer/${operation}`,{method:'POST',
      headers:{'content-type':'application/json',authorization:`Bearer ${first}`},body:JSON.stringify(payload)});
    if(discard){assert.equal(response.status,200);await response.body.cancel();return null;}
    return {status:response.status,body:await response.json()};
  }
  const requestId=randomUUID(),attemptId=randomUUID();
  const pair={requestId,source:input,target:destinationSession};
  const run={...pair,attemptId,selections:[{kind:'configuration',sourceId:configurations.body.sources.find(item=>item.kind==='claude-code').sourceId}]};
  await transfer('run',run,{discard:true});
  let receipt,completed;
  await waitFor(async()=>{
    const observed=await transfer('read',pair);
    assert.equal(observed.status,200,JSON.stringify(observed.body));
    if(observed.body.result?.phase!=='ready')return false;
    completed=observed.body;receipt=completed.result.receipt;return true;
  },20000,'durable transfer receipt after discarded HTTP acknowledgement',100,context.abortSignal);
  assert.equal(receipt.requestId,requestId);
  const duplicate=await transfer('run',run);
  assert.equal(duplicate.status,200,JSON.stringify(duplicate.body));
  assert.deepEqual(duplicate.body.result.receipt,receipt);
  assert.deepEqual(duplicate.body.result.targetState,completed.result.targetState);
  const reusedSession=await transfer('run',{...run,requestId:randomUUID(),attemptId:randomUUID()});
  assert.equal(reusedSession.status,409,'an existing source session cannot own a peer transfer');
  assert.equal(await readFile(resolve(profile,'settings.json'),'utf8'),sourceSettings);
  assert.equal(await readFile(resolve(destination,'settings.json'),'utf8'),sourceSettings,'received configuration is not silently installed');
  assert.equal((await call('close',destinationSession)).body.status,'released');
  const closed=await call('close',input); assert.equal(closed.status,200); assert.equal(closed.body.status,'released');
  assert.deepEqual((await call('read',input)).body,{status:'released',launching:false,ownedChildren:0});
  assert.equal((await call('query',{session:input,query:{kind:'configuration',params:{}}})).status,409,'closed source is not implicitly reopened');
  const recovered={...input,sessionId:randomUUID(),purpose:'target_recovery'};
  const recovery=await call('open',recovered,second); assert.equal(recovery.status,200,JSON.stringify(recovery.body));
  assert.equal(recovery.body.status,'ready');
  const revoked={...input,sessionId:randomUUID()};
  assert.equal((await call('open',revoked)).body.status,'ready');
  const logout=await fetch(`${gateway.baseUrl}/logout`,{method:'POST',redirect:'manual',headers:{origin:gateway.baseUrl,cookie:`kcoder_studio_session=${first}`}});
  assert.equal(logout.status,303);
  assert.equal((await call('read',revoked)).status,401);
  await waitFor(async () => {
    const observed=await call('read',revoked,second);
    return observed.status===200 && observed.body.status==='released';
  },10000,'revoked source child released without another authorized request',100,context.abortSignal);
  assert.equal((await call('read',recovered,second)).body.status,'ready','logout preserves peer child');
  assert.equal((await call('close',recovered,second)).body.status,'released');
  await context.stopOwned('gateway');
  const reopenedGateway=await startGateway(context,{label:'gateway-reopened',workspace,serversFile,kcoderBin:binary,auth:true,
    env:{KCODER_CONFIG_DIR:profile,CLAUDE_CONFIG_DIR:source}});
  const reopenedToken=await login(reopenedGateway);
  async function reopenedCall(lane,operation,payload){
    const response=await fetch(`${reopenedGateway.baseUrl}/api/migration/${lane}/${operation}`,{method:'POST',
      headers:{'content-type':'application/json',authorization:`Bearer ${reopenedToken}`},body:JSON.stringify(payload)});
    return {status:response.status,body:await response.json()};
  }
  const reopenedSource={...input,sessionId:randomUUID()};
  const reopenedTarget={...destinationSession,sessionId:randomUUID()};
  assert.equal((await reopenedCall('source-session','open',reopenedSource)).body.status,'ready');
  assert.equal((await reopenedCall('source-session','open',reopenedTarget)).body.status,'ready');
  const duplicateAfterRestart=await reopenedCall('source-transfer','run',{...run,source:reopenedSource,target:reopenedTarget});
  assert.equal(duplicateAfterRestart.status,200,JSON.stringify(duplicateAfterRestart.body));
  assert.equal(duplicateAfterRestart.body.coordinatorState,'unknown','old durable acceptance is not new execution authority');
  assert.equal(duplicateAfterRestart.body.errorCode,'source_transfer_attempt_unconfirmed');
  assert.deepEqual(duplicateAfterRestart.body.result.receipt,receipt);
  assert.equal((await reopenedCall('source-session','close',reopenedSource)).body.status,'released');
  assert.equal((await reopenedCall('source-session','close',reopenedTarget)).body.status,'released');
  await rename(source,context.pathInState('source-unavailable'));
  const targetOnly={...reopenedTarget,sessionId:randomUUID(),purpose:'target_recovery'};
  assert.equal((await reopenedCall('source-session','open',targetOnly)).body.status,'ready');
  const offlineRead=await reopenedCall('source-transfer','target-read',{requestId,target:targetOnly});
  assert.equal(offlineRead.status,200,JSON.stringify(offlineRead.body));
  assert.equal(offlineRead.body.result.sourceObserved,false);
  assert.deepEqual(offlineRead.body.result.receipt,receipt);
  assert.equal((await reopenedCall('source-session','close',targetOnly)).body.status,'released');
  assert.equal(model.requests.length,0,'no model requests');
  return { sourceConfigurationLayerReports:true, sourceReportPages:[10,3], authenticatedHttp:true, realNative:true, twoProfiles:true, gatewayRestartOldAttemptRefused:true, sourceOfflineTargetRead:true, discardedAcknowledgementReconciled:true, duplicateAttemptNotRepeated:true, ownedDiscovery:true, closedDiscoveryRejected:true, sameSessionReuse:true, peerIsolation:true,
    workspaceFence:true, revokedIdleCleanup:true, logoutPeerPreserved:true, explicitClose:true, targetRecoveryOpen:true, modelRequests:model.requests.length };
});
