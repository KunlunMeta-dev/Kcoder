import assert from 'node:assert/strict';
import { readFile,writeFile,stat } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot,repoRoot,runE2E,waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if(!process.env.KCODER_E2E_TAURI_BIN)throw Error('Explicit Tauri binary required');
await runE2E(import.meta.url,{testId:'native-user-hooks-save-new-conversation-and-delete',tier:'manual-live',modelPolicy:'model-independent real native editor, actual configuration and Shell side effects'},async context=>{
 const model=await startApprovalModelFixture(context,{responseSteps:()=>[{delta:{role:'assistant',content:'NATIVE_HOOK_REPLY'},finishReason:'stop'}]});
 const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN,kcoderBin:process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
 const workspace=resolve(dirname(dirname(client.settingsPath)),'workspaces/tauri-verification'),marker=resolve(workspace,'native-hook-count');
 const cmd=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
 try{
  await cmd('waitFor','desktop-sidebar');
  await writeFile(client.settingsPath,JSON.stringify({active_provider:'fixture',providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'fixture',context_window_tokens:1000000,max_output_tokens:1024,output_headroom_tokens:1024,no_proxy:true}}}));
  await client.command('navigate',{value:'/settings/personal/models'});await cmd('waitFor','provider-edit-fixture::fixture');await cmd('click','provider-edit-fixture::fixture');await cmd('waitFor','provider-save',{enabled:true});await cmd('click','provider-save');await client.command('waitFor',{selector:'[role="status"]',text:'已保存',timeoutMs:15000});
  await client.command('navigate',{value:'/settings/hooks'});await cmd('waitFor','hooks-json');
  await cmd('fill','hooks-json',{value:JSON.stringify({UserPromptSubmit:[{hooks:[{type:'command',shell:'bash',command:'printf native >> native-hook-count',timeout:5}]}]})});
  await cmd('click','hooks-save');await waitFor(async()=> (await cmd('getText','hooks-settings-page')).includes('新会话读取修改'),10000,'native Hook save');
  assert.equal(await stat(marker).then(()=>true,()=>false),false);
  const turn=async()=>{await client.command('navigate',{value:'/'});await cmd('waitFor','project-new-conversation-button');await cmd('click','project-new-conversation-button');await cmd('waitFor','chat-message-input');await cmd('fill','chat-message-input',{value:'NATIVE_USER_HOOK'});await cmd('waitFor','send-message-button',{enabled:true});await cmd('click','send-message-button');await cmd('waitFor','message-assistant',{text:'NATIVE_HOOK_REPLY',timeoutMs:30000});};
  await turn();assert.equal(await readFile(marker,'utf8'),'native');
  await client.command('navigate',{value:'/settings/hooks'});await cmd('waitFor','hooks-json');await cmd('click','hooks-clear');await cmd('waitFor','hooks-confirm');await cmd('click','hooks-confirm-confirm');
  await waitFor(async()=> (await cmd('getValue','hooks-json')).trim()==='{}',10000,'native user Hook deletion');
  await turn();assert.equal(await readFile(marker,'utf8'),'native');
  await client.command('navigate',{value:'/settings/appearance'});await cmd('waitFor','appearance-mode-dark');await cmd('click','appearance-mode-dark');
  await client.command('navigate',{value:'/settings'});await cmd('waitFor','general-language-en-button');await cmd('click','general-language-en-button');
  await client.command('navigate',{value:'/settings/hooks'});await cmd('waitFor','hooks-json');assert.doesNotMatch(await cmd('getText','hooks-settings-page'),/[\u3400-\u9fff]/);
  await client.capture('native-user-hooks-en-dark.png');return {native:true,saved:true,ranOnce:true,deletedForNewConversation:true,englishDark:true};
 }catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
 finally{await client.stop();}
});
