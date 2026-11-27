import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startPackagedDesktop } from '../../harness/packaged-desktop.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { openPageGatewayRpc, initializeRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { webNativeModelOnlySettings } from '../../harness/web-search-native-session.mjs';
import { verifyManifest } from '../../../../../scripts/release/artifact-manifest.mjs';
import { acceptNativeToolApproval, observeNativeUiFrames } from '../../harness/native-tool-approval.mjs';
import { packagedFetchOptions } from '../../harness/packaged-fetch-case.mjs';

assert.equal(process.env.KCODER_E2E_WEB_EXTERNAL_NETWORK, '1', 'Explicit public search consent is required');
const identity=packagedFetchOptions();assert.equal(identity.caseId,'python-asyncio','The positive chain uses only its fixed official Python case');
const expectedCommit=identity.expectedCommit,expectedCli=identity.expectedCliSha256;
const expectedImage=process.env.KCODER_E2E_PACKAGED_APPIMAGE_SHA256??(!identity.explicitPackageIdentity?'27e000e7cbcbcf8e43add64ade07614bc3a0b275f246bf7a70aecbcd63b13726':undefined);
assert.match(expectedImage??'',/^[a-f0-9]{64}$/,'An exact final AppImage SHA256 is required for a new package');
const pageUrl='https://docs.python.org/3/library/asyncio-task.html';
async function sha(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
await runE2E(import.meta.url,{testId:'packaged-linux-actual-public-web-search-fetch-sources-and-owned-restart',tier:'manual-live',
 modelPolicy:'Deterministic local model protocol only; actual final AppImage/AppRun/Rust/public fixed official source. No paid model, D05 task grading or unsupported capture claim.',
 budgets:{logicalWebSearchCalls:1,webFetchCalls:1,modelGenerations:3,singleCallWallClockMs:140000,wallClockMs:360000},retainSuccessEvidence:true},async context=>{
 context.abortSignal=AbortSignal.any([context.abortSignal,AbortSignal.timeout(360000)]);
 const root=identity.root, image=resolve(process.env.KCODER_E2E_PACKAGED_APPIMAGE||'');
 assert.equal(await sha(image),expectedImage);
 await verifyManifest(resolve(root,'resources'),{expectedCommit});assert.equal(await sha(resolve(root,'resources/bin/kcoder')),expectedCli);
 const display=await startOwnedDisplay(context);const workspace=await materializeWorkspace(context,'minimal',{instanceId:'native-public-web'});
 let searchCalls=0,fetchCalls=0,ordinary=0;
 const model=await startApprovalModelFixture(context,{modelList:{ids:['owned-search-model']},responseSteps:({body})=>{
  const names=(body.tools||[]).map(t=>t.function?.name||t.name);if(!names.includes('WebSearch'))return[{delta:{content:'固定原生功能验收'},finishReason:'stop'}];
  assert.ok(++ordinary<=3,'No extra model step/retry may replay the public search');
  const results=(body.messages||[]).filter(m=>m.role==='tool');
  if(results.length===0){assert.equal(++searchCalls,1);return[{delta:{tool_calls:[{index:0,id:'native-public-search',type:'function',function:{name:'WebSearch',arguments:JSON.stringify({query:'Python asyncio Task cancellation official documentation',allowed_domains:['docs.python.org'],num_results:1,freshness:'live'})}}]},finishReason:'tool_calls'}];}
  if(results.length===1){const text=JSON.stringify(results[0].content);if(!/Search status: (?:success|partial)/.test(text))return[{delta:{content:'固定搜索未成功；不重试。'},finishReason:'stop'}];assert.equal(++fetchCalls,1);return[{delta:{tool_calls:[{index:0,id:'native-public-fetch',type:'function',function:{name:'WebFetch',arguments:JSON.stringify({url:pageUrl,prompt:'Read the official Task cancellation section and its CancelledError guidance.'})}}]},finishReason:'tool_calls'}];}
  assert.ok(JSON.stringify(results[1].content).includes('CancelledError'));return[{delta:{content:`原生搜索和官方原文读取已完成。NATIVEWEBE205\n\n[Python官方文档](${pageUrl})`},finishReason:'stop'}];
 }});
 const settings=webNativeModelOnlySettings({modelUrl:model.baseUrl});const settingsFile=await context.writeStateJson('home/settings.json',settings), bytes=await readFile(settingsFile);
 const servers=await context.writeStateJson('servers.json',[{id:'local',label:'原生正式包验收',transport:'local',command:resolve(root,'resources/bin/kcoder'),workspace:workspace.path,settingsFile}]);
 let desktop,rpc,threadId;let frames=[];const receipts=[],snapshots=[],approvals=[];const runStart=performance.now();
 try{
  desktop=await startPackagedDesktop(context,{root,label:'native-public-desktop',entry:'AppRun',servers,workspace:workspace.path,environment:{DISPLAY:display.display,XAUTHORITY:display.authority}});
  const page=desktop.page;
  frames=observeNativeUiFrames(page,{now:()=>Math.round(performance.now()-runStart)});
  const collectReceipts=()=>{receipts.length=0;for(const {direction,frame:f}of frames){if(direction!=='received')continue;const item=f.params?.item;if(f.method==='item/completed'&&item?.webSources){const source=item.webSources;assert.equal(source.identity.threadId,f.params.threadId);assert.equal(source.identity.turnId,f.params.turnId);assert.equal(source.toolCallId,item.id);receipts.push(source);threadId=f.params.threadId;}}};
  rpc=await openPageGatewayRpc(context,page,{baseUrl:new URL(page.url()).origin,wsUrl:new URL(page.url()).origin.replace('http:','ws:')},'native public source reader');await initializeRpc(rpc,'native-public-read');
  const input=page.getByTestId('chat-message-input');await input.fill('请检索Python官方asyncio任务取消文档，并读取 https://docs.python.org/3/library/asyncio-task.html 后给出来源。');await page.getByTestId('send-message-button').click();
  for(const name of ['WebSearch','WebFetch']){
   const approved=await acceptNativeToolApproval(page,frames,name,{signal:context.abortSignal,timeoutMs:140000});
   approvals.push(approved);threadId=approved.params.threadId;
   snapshots.push({phase:`${name}-accepted`,value:await rpc.request('thread/read',{threadId,limit:100})});
   const started=frames.find(row=>row.direction==='received'&&row.frame.method==='item/started'&&row.frame.params?.threadId===threadId&&row.frame.params?.turnId===approved.params.turnId&&row.frame.params?.item?.type==='toolCall'&&row.frame.params.item.name===name)?.frame;
   assert.ok(started,`native ${name} item/started must precede its permission`);
   const approvedAt=frames.find(row=>row.frame===approved).atMs;
   const remaining=Math.max(1,140000-(performance.now()-runStart-approvedAt));
   const terminal=await waitFor(()=>frames.find(row=>row.direction==='received'&&row.frame.method==='item/completed'&&row.frame.params?.threadId===threadId&&row.frame.params?.turnId===approved.params.turnId&&row.frame.params?.item?.id===started.params.item.id),remaining,`native ${name} item terminal`,50,context.abortSignal);
   snapshots.push({phase:`${name}-terminal`,value:await rpc.request('thread/read',{threadId,limit:100})});
   assert.equal(terminal.frame.params.item.status,'completed',`${name} actual terminal status`);
  }
  await waitFor(()=>frames.some(row=>row.direction==='received'&&row.frame.method==='turn/completed'&&row.frame.params?.threadId===threadId&&row.frame.params?.turnId===approvals[0].params.turnId),15000,'same native turn terminal',40,context.abortSignal);
  snapshots.push({phase:'turn-terminal',value:await rpc.request('thread/read',{threadId,limit:100})});
  collectReceipts();
  await expect(page.getByTestId('message-assistant').filter({hasText:'NATIVEWEBE205'}).last()).toBeVisible({timeout:15000});assert.equal(receipts.length,2,'actual native source receipts');
  const search=receipts.find(r=>r.operation==='search'), fetched=receipts.find(r=>r.operation==='fetch');assert.ok(search.sources.length>=1);assert.ok(search.sources.every(s=>s.readStatus==='summary_only'));assert.equal(fetched.sources[0].url,pageUrl);assert.ok(['read','partial'].includes(fetched.sources[0].readStatus));
  for(const toggle of ['final-processing-toggle','processing-summary-toggle','processing-activity-group-toggle'])for(const button of await page.getByTestId(toggle).all())if(await button.getAttribute('aria-expanded')==='false')await button.click();
  await expect(page.getByTestId('native-web-sources')).toHaveCount(2);for(const card of await page.getByTestId('native-web-sources').all()){const b=card.getByRole('button').first();if(await b.getAttribute('aria-expanded')==='false')await b.click();}
  await page.screenshot({path:context.pathInArtifacts('packaged-linux-chat-sources.png'),fullPage:true});const before=await waitFor(async()=>{const snapshot=await rpc.request('thread/read',{threadId,limit:100});return snapshot.messages.some(message=>message.fileChangesCapture?.limitations?.includes('captureIncomplete'))?false:snapshot;},15000,'native snapshot capture completion before restart',100,context.abortSignal);const url=new URL(page.url()).pathname+new URL(page.url()).search;
  await page.goto(new URL(page.url()).origin+'/settings/appshots');await expect(page.getByTestId('appshots-settings-page')).toBeVisible({timeout:30000});await expect(page.getByTestId('appshots-settings-error')).toHaveCount(0);await page.screenshot({path:context.pathInArtifacts('packaged-linux-appshots-standard-unsupported.png'),fullPage:true});
  const appshotsText=await page.getByTestId('appshots-settings-page').innerText();assert.match(appshotsText,/macOS|不支持|unsupported/i);
  await closeRpcAndWait(rpc);rpc=null;await desktop.stop();
  desktop=await startPackagedDesktop(context,{root,label:'native-public-restored',entry:'AppRun',servers,workspace:workspace.path,environment:{DISPLAY:display.display,XAUTHORITY:display.authority}});
  rpc=await openPageGatewayRpc(context,desktop.page,{baseUrl:new URL(desktop.page.url()).origin,wsUrl:new URL(desktop.page.url()).origin.replace('http:','ws:')},'native restored reader');await initializeRpc(rpc,'native-restored-read');const restored=await rpc.request('thread/read',{threadId,limit:100});
  const sources=h=>h.messages.flatMap(m=>(m.blocks||[]).flatMap(b=>b.webSources?[b.webSources]:[]));assert.deepEqual(sources(restored),sources(before));assert.deepEqual(restored.messages,before.messages);await desktop.page.goto(new URL(desktop.page.url()).origin+url);await expect(desktop.page.getByTestId('message-assistant').filter({hasText:'NATIVEWEBE205'}).last()).toBeVisible({timeout:30000});await desktop.page.screenshot({path:context.pathInArtifacts('packaged-linux-restored.png'),fullPage:true});
  assert.equal(searchCalls,1);assert.equal(fetchCalls,1);assert.equal(ordinary,3);assert.deepEqual(await readFile(settingsFile),bytes);
  await context.writeArtifactJson('native-packaged-public-web.json',{appImage:image,appImageSha256:expectedImage,cliSha256:expectedCli,sourceCommit:expectedCommit,before,restored,receipts,threadId,frames,snapshots,approvals,searchCalls,fetchCalls,modelProtocolSteps:ordinary,paidModelCalls:0,restoredWithoutReplay:true,appshots:{unsupportedOnLinux:true,text:appshotsText,captureTested:false}});
  return{nativeAppRun:true,publicLogicalSearch:1,publicPageRead:1,paidModels:0,sourceReceipts:receipts.length,ownedRestart:true,appshotsUnsupported:true};
 }catch(error){
  if(threadId&&rpc)try{snapshots.push({phase:'beforeCleanupFailure',value:await rpc.request('thread/read',{threadId,limit:100},5000)});}catch(snapshotError){snapshots.push({phase:'snapshotUnavailable',error:String(snapshotError)});}
  if(desktop)await desktop.page.screenshot({path:context.pathInArtifacts('native-public-failure.png'),fullPage:true}).catch(()=>{});
  await context.writeArtifactJson('native-public-failure.json',{error:String(error),searchCalls,fetchCalls,ordinary,receipts,modelRequests:model.requests.length,frames,snapshots,approvals,networkStage:'unknown unless actual terminal identifies it; no elapsed-time inference'});throw error;
 }
 finally{await closeRpcAndWait(rpc);if(desktop)await desktop.stop();}
});
