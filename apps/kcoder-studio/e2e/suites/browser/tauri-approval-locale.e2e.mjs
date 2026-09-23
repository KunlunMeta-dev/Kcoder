import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot,repoRoot,runE2E } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if(!process.env.KCODER_E2E_TAURI_BIN)throw Error('Explicit owned Tauri required');
await runE2E(import.meta.url,{testId:'native-permission-card-language-change-canonical-decision',tier:'manual-live',modelPolicy:'deterministic local tool approval; no external model'},async context=>{
 const model=await startApprovalModelFixture(context,{responseSteps:({body})=>!JSON.stringify(body.messages).includes('APPROVAL_LOCALE_FIXTURE')?[{delta:{content:'OK'},finishReason:'stop'}]:body.messages.at(-1)?.role==='tool'?[{delta:{content:'APPROVAL_LOCALE_DONE'},finishReason:'stop'}]:[{delta:{role:'assistant',tool_calls:[{index:0,id:'locale-approval',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'printf approved > approval-locale-marker'})}}]}},{finishReason:'tool_calls'}]});
 const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN,kcoderBin:process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
 const cmd=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
 try{
  await cmd('waitFor','desktop-sidebar');await writeFile(client.settingsPath,JSON.stringify({active_provider:'fixture',permission_mode:'ask',providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'fixture',context_window_tokens:1000000,max_output_tokens:1024,output_headroom_tokens:1024,no_proxy:true}}}));
  await client.command('navigate',{value:'/settings/personal/models'});await cmd('waitFor','provider-edit-fixture::fixture');await cmd('click','provider-edit-fixture::fixture');await cmd('click','provider-save');await client.command('waitFor',{selector:'[role="status"]',text:'已保存',timeoutMs:15000});
  await client.command('navigate',{value:'/'});await cmd('waitFor','chat-message-input');await cmd('fill','chat-message-input',{value:'APPROVAL_LOCALE_FIXTURE'});await cmd('waitFor','send-message-button',{enabled:true});await cmd('click','send-message-button');
  await cmd('waitFor','permission-approval-content',{timeoutMs:30000});await cmd('waitFor','request-user-input-card',{text:'权限请求'});
  assert.ok((await cmd('getText','request-user-input-card')).includes('仅允许这一次'));
  await client.capture('approval-zh.png');
  await client.command('navigate',{value:'/settings'});await cmd('waitFor','general-language-en-button');await cmd('click','general-language-en-button');await client.command('navigate',{value:'/'});
  await cmd('waitFor','request-user-input-card',{text:'Permission request'});await cmd('waitFor','permission-approval-content');
  const bodyText=await client.command('getText',{selector:'body'});
  await context.writeArtifactJson('english-han-lines.json',bodyText.split('\n').filter(line=>/[\u3400-\u9fff]/.test(line)));
  assert.doesNotMatch(bodyText,/[\u3400-\u9fff]/,'Application-owned pending tool and approval text must follow English');
  await client.capture('approval-en.png');
  await client.command('click',{selector:'[data-testid="request-user-input-card"] [data-testid^="request-user-input-option-"]'});
  await cmd('waitFor','message-assistant',{text:'APPROVAL_LOCALE_DONE',timeoutMs:30000});return {liveLanguageSwitch:true,canonicalDecisionAccepted:true,originalTechnicalDetailsRetained:true};
 }catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
 finally{await client.stop();}
});
