import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'native-completion-unread-and-read',tier:'manual-live',modelPolicy:'Controlled response completion; validates real backend lifecycle and unread UI, not model quality'},async context=>{
 const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN||resolve(appRoot,'renderer/src-tauri/target/debug/app'),kcoderBin:process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
 const cmd=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
 let released=false;
 try{
  const model=await startApprovalModelFixture(context,{responseSteps:()=>[{ready:()=>released,delta:{role:'assistant',content:'COMPLETION_BADGE_RESULT'},finishReason:'stop'}]});
  await writeFile(client.settingsPath,JSON.stringify({permission_mode:'bypass',active_provider:'fixture',providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'fixture',context_window_tokens:128000,max_output_tokens:1024,output_headroom_tokens:1024,no_proxy:true}}}));
  await client.command('navigate',{value:'/settings/personal/models'});await cmd('waitFor','provider-edit-fixture::fixture');
  await client.command('navigate',{value:'/'});await cmd('waitFor','chat-message-input');
  await cmd('fill','chat-message-input',{value:'Complete the controlled notification task'});
  await cmd('waitFor','send-message-button',{enabled:true});await cmd('click','send-message-button');
  await waitFor(()=>model.requests.length>0,15000,'model request started');
  const selector='[data-testid^="runtime-local-task-row-"]';
  await client.command('waitFor',{selector});
  const row=await client.command('getAttribute',{selector,value:'data-testid'});
  const taskId=row.slice('runtime-local-task-row-'.length);
  await client.command('navigate',{value:'/workflows'});await cmd('waitFor','workflow-workspace');
  released=true;
  await cmd('waitFor',`runtime-local-task-unread-dot-${taskId}`,{timeoutMs:20000});
  await client.capture('completion-unread.png');
  await cmd('click',row);
  await cmd('waitFor','message-assistant',{text:'COMPLETION_BADGE_RESULT'});
  await waitFor(async()=>await cmd('getElementCount',`runtime-local-task-unread-dot-${taskId}`)==='0',5000,'opening the conversation clears unread');
  await client.capture('completion-read.png');
  return {backgroundCompletionUnread:true,openingClearsUnread:true};
 }catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
 finally{released=true;const cleanup=await client.stop();assert.equal(cleanup.cleaned,true);}
});
