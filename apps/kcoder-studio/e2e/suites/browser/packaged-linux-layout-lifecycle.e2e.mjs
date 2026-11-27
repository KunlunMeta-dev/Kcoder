import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startPackagedDesktop } from '../../harness/packaged-desktop.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { verifyManifest } from '../../../../../scripts/release/artifact-manifest.mjs';
import { webNativeModelOnlySettings, webNativeBinaryIdentity } from '../../harness/web-search-native-session.mjs';
import { openPageGatewayRpc, initializeRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { acceptNativeToolApproval, observeNativeUiFrames } from '../../harness/native-tool-approval.mjs';
import { packagedFetchOptions } from '../../harness/packaged-fetch-case.mjs';

await runE2E(import.meta.url,{testId:'actual-linux-apprun-layout-unsupported-appshots-and-durable-owned-message',tier:'manual-live',modelPolicy:'Actual final AppImage native lifecycle and layout with local deterministic protocol. Zero public search/fetch, paid models or capture claim.',retainSuccessEvidence:true},async context=>{
 const {root,expectedCommit,expectedCliSha256}=packagedFetchOptions();await verifyManifest(resolve(root,'resources'),{expectedCommit});
 assert.equal((await webNativeBinaryIdentity(resolve(root,'resources/bin/kcoder'))).sha256,expectedCliSha256);
 const display=await startOwnedDisplay(context), workspace=await materializeWorkspace(context,'minimal',{instanceId:'native-layout-lifecycle'});
 const model=await startApprovalModelFixture(context,{modelList:{ids:['owned-search-model']},responseSteps:({body})=>{
  const results=(body.messages||[]).filter(message=>message.role==='tool');
  if(results.length<2)return[{delta:{tool_calls:[{index:0,id:`owned-native-approval-${results.length}`,type:'function',function:{name:'bash',arguments:JSON.stringify({command:`printf 'OWNED_NATIVE_APPROVAL_${results.length}\\n'`})}}]},finishReason:'tool_calls'}];
  return[{delta:{content:'NATIVE_OWNED_LIFECYCLE_E205'},finishReason:'stop'}];
 }});
 const settingsFile=await context.writeStateJson('home/settings.json',webNativeModelOnlySettings({modelUrl:model.baseUrl}));
 const servers=await context.writeStateJson('servers.json',[{id:'local',label:'原生生命周期验收',transport:'local',command:resolve(root,'resources/bin/kcoder'),workspace:workspace.path,settingsFile}]);
 const options={root,entry:'AppRun',servers,workspace:workspace.path,environment:{DISPLAY:display.display,XAUTHORITY:display.authority}};
 let desktop,rpc,before,after;let frames=[];
 try{
  desktop=await startPackagedDesktop(context,{...options,label:'native-layout-first'});let page=desktop.page;frames=observeNativeUiFrames(page);
  const origin=new URL(page.url()).origin;rpc=await openPageGatewayRpc(context,page,{baseUrl:origin,wsUrl:origin.replace('http:','ws:')},'native lifecycle reader');await initializeRpc(rpc,'native-lifecycle-read');
  await page.getByTestId('chat-message-input').fill('运行两次只打印受控标记的本地命令，然后返回生命周期标记；不调用任何网络工具。');await page.getByTestId('send-message-button').click();
  const approvals=[];for(let index=0;index<2;index++)approvals.push(await acceptNativeToolApproval(page,frames,'bash',{signal:context.abortSignal,timeoutMs:30000,command:`printf 'OWNED_NATIVE_APPROVAL_${index}\\n'`}));
  assert.notEqual(approvals[0].id,approvals[1].id);await expect(page.getByTestId('message-assistant').filter({hasText:'NATIVE_OWNED_LIFECYCLE_E205'}).last()).toBeVisible({timeout:45000});
  const list=await rpc.request('thread/list',{});const threadId=list.data?.[0]?.id||list.threads?.[0]?.id;assert.ok(threadId,'actual new native session must be discoverable');
  await waitFor(()=>frames.some(row=>row.direction==='received'&&row.frame.method==='turn/completed'&&row.frame.params?.threadId===threadId),10000,'local native turn terminal',40,context.abortSignal);
  before=await waitFor(async()=>{const snapshot=await rpc.request('thread/read',{threadId,limit:100});return snapshot.messages.some(message=>message.fileChangesCapture?.limitations?.includes('captureIncomplete'))?false:snapshot;},15000,'native file capture completion before durable restore snapshot',100,context.abortSignal);
  const taskPath=new URL(page.url()).pathname+new URL(page.url()).search;
  await page.screenshot({path:context.pathInArtifacts('linux-native-chat-lifecycle.png'),fullPage:true});
  await page.goto(origin+'/settings/appshots');await expect(page.getByTestId('appshots-settings-page')).toBeVisible({timeout:30000});await expect(page.getByTestId('appshots-settings-error')).toHaveCount(0);
  const section=page.getByTestId('appshots-settings-page');const text=await section.innerText();assert.match(text,/macOS|不支持|unsupported/i);await page.screenshot({path:context.pathInArtifacts('linux-appshots-standard-column-unsupported.png'),fullPage:true});
  const geometry=await section.evaluate(element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return{x:r.x,width:r.width,maxWidth:s.maxWidth,className:element.className};});assert.ok(geometry.className.includes('max-w-[var(--studio-page-column-width)]'));assert.ok(geometry.width>728&&geometry.width<=parseFloat(geometry.maxWidth)+1,'Use the actual shared standard column, not the old narrow column');
  await closeRpcAndWait(rpc);rpc=null;await desktop.stop();
  desktop=await startPackagedDesktop(context,{...options,label:'native-layout-restored'});page=desktop.page;const restoredOrigin=new URL(page.url()).origin;
  rpc=await openPageGatewayRpc(context,page,{baseUrl:restoredOrigin,wsUrl:restoredOrigin.replace('http:','ws:')},'native restored lifecycle reader');await initializeRpc(rpc,'native-lifecycle-restored');after=await rpc.request('thread/read',{threadId,limit:100});assert.deepEqual(after.messages,before.messages);
  await page.goto(restoredOrigin+taskPath);await expect(page.getByTestId('message-assistant').filter({hasText:'NATIVE_OWNED_LIFECYCLE_E205'}).last()).toBeVisible({timeout:30000});await page.screenshot({path:context.pathInArtifacts('linux-native-owned-restored.png'),fullPage:true});assert.equal(model.requests.length,3);
  await context.writeArtifactJson('linux-native-lifecycle.json',{root,source:expectedCommit,cliSha256:expectedCliSha256,threadId,actualAppRun:true,ownedRestartRestored:true,fixtureModelCalls:3,paidModels:0,publicSearch:0,publicFetch:0,approvals,frames,before,after,appshots:{supported:false,captureTested:false,text,geometry}});
  return{actualAppRun:true,ownedRestartRestored:true,appshotsLinuxUnsupported:true,publicSearch:0,publicFetch:0,paidModels:0};
 }catch(error){if(desktop)await desktop.page.screenshot({path:context.pathInArtifacts('linux-native-layout-failure.png'),fullPage:true}).catch(()=>{});await context.writeArtifactJson('linux-native-layout-failure.json',{error:String(error),modelRequests:model.requests.length,frames,before,after,observerRpc:rpc?.messages()});throw error;}
 finally{await closeRpcAndWait(rpc);if(desktop)await desktop.stop();}
});
