import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'native-tool-image-live-and-restored',tier:'manual-live',modelPolicy:'deterministic model requests real read tool and verifies screenshot bytes in subsequent provider request'},async context=>{
 const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN||resolve(appRoot,'renderer/src-tauri/target/debug/app'),kcoderBin:process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
 const cmd=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
 try{
  const png='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGNwaDgARAwHGhyACAAqDgYBxIhtdAAAAABJRU5ErkJggg==';
  const path=resolve(dirname(client.settingsPath),'../workspaces/tauri-verification/observation.png');
  await writeFile(path,Buffer.from(png,'base64'));
  let sawImage=false;
  const fixture=await startApprovalModelFixture(context,{responseSteps:({body})=>{
   const completed=body.messages.some(message=>message.role==='tool');
   if(completed){sawImage=JSON.stringify(body.messages).includes('data:image/png;base64,'+png);return [{delta:{content:'IMAGE_OBSERVATION_COMPLETE'},finishReason:'stop'}];}
   return [{delta:{role:'assistant',tool_calls:[{index:0,id:'observation',type:'function',function:{name:'read',arguments:JSON.stringify({file_path:path})}}]},finishReason:'tool_calls'}];
  }});
  await writeFile(client.settingsPath,JSON.stringify({permission_mode:'bypass',active_provider:'fixture',providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:fixture.baseUrl,default_model:'fixture',context_window_tokens:128000,max_output_tokens:1024,output_headroom_tokens:1024,no_proxy:true,capabilities:{text:true,tools:true,vision:true}}}}));
  await client.command('navigate',{value:'/settings/personal/models'});await cmd('waitFor','provider-edit-fixture::fixture');
  await client.command('navigate',{value:'/'});await cmd('waitFor','chat-message-input');
  await cmd('fill','chat-message-input',{value:'Inspect the synthetic observation image'});await cmd('waitFor','send-message-button',{enabled:true});await cmd('click','send-message-button');
  await cmd('waitFor','message-assistant',{text:'IMAGE_OBSERVATION_COMPLETE',timeoutMs:30000});assert.ok(sawImage,'provider request must contain exact image bytes');
  assert.equal(await cmd('getElementCount','computer-use-status'),'0','ordinary tool use must not claim desktop control');
  for(let round=0;round<2;round++){
   if(round){await client.command('navigate',{value:'/settings'});await client.command('navigate',{value:'/'});await client.command('click',{selector:'[data-testid^="runtime-local-task-row-"]'});await cmd('waitFor','message-assistant',{text:'IMAGE_OBSERVATION_COMPLETE'});}
   if(await cmd('getElementCount','final-processing-toggle')!=='0' && await cmd('getAttribute','final-processing-toggle',{value:'aria-expanded'})!=='true') await cmd('click','final-processing-toggle');
   if(await cmd('getElementCount','processing-summary-toggle')!=='0' && await cmd('getAttribute','processing-summary-toggle',{value:'aria-expanded'})!=='true') await cmd('click','processing-summary-toggle');
   if(await client.command('getAttribute',{selector:'[data-tool-detail-toggle]',value:'aria-expanded'})!=='true') await client.command('click',{selector:'[data-tool-detail-toggle]'});
   await cmd('waitFor','tool-image-observations');
   await client.command('waitFor',{selector:'[data-testid="tool-image-observations"] [role="status"]',text:'当前图像尺寸较小'});
   await client.command('click',{selector:'[data-testid="tool-image-observations"] button'});await cmd('waitFor','tool-image-preview');
   const src=await client.command('getAttribute',{selector:'[data-testid="tool-image-preview"] img',value:'src'});assert.equal(src,'data:image/png;base64,'+png);
   await client.command('click',{selector:'[data-testid="tool-image-preview"] button'});
   await waitFor(async()=>await cmd('getElementCount','tool-image-preview')==='0',5000,'preview closed');
  }
  await client.capture('native-tool-image-restored.png');
  const beforeApproval=fixture.requests.length;
  await cmd('fill','chat-message-input',{value:'Check unavailable desktop control'});
  await cmd('waitFor','computer-use-submit',{enabled:true});await cmd('click','computer-use-submit');
  await cmd('waitFor','computer-use-approval',{text:'当前目标暂不可使用桌面控制'});
  assert.equal(await client.command('getElementCount',{selector:'[data-testid="computer-use-confirm"]:disabled'}),'1');
  await client.capture('native-computer-use-unavailable.png');
  await client.command('press',{selector:'[data-testid="computer-use-approval"]',key:'Escape'});
  await waitFor(async()=>await cmd('getElementCount','computer-use-approval')==='0',5000,'approval closed');
  assert.equal(await cmd('getElementCount','computer-use-status'),'0','unavailable/cancelled approval must not claim a desktop lease');
  const additionalRequests=fixture.requests.slice(beforeApproval);
  await context.writeArtifactJson('approval-request-observations.json',additionalRequests.map(body=>({
    model:body.model,lastMessage:body.messages.at(-1),
  })));
  assert.ok(additionalRequests.every(body=>!JSON.stringify(body.messages).includes('Check unavailable desktop control')),
    'unavailable approval must not submit the new desktop task');
  assert.equal(fixture.requests.length,beforeApproval);
  return {modelReceivedImage:true,live:true,restored:true,unavailableApprovalDoesNotSend:true};
 }catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}finally{await client.stop();}
});
