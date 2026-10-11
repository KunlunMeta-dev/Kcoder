import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if(!process.env.KCODER_E2E_TAURI_BIN)throw new Error('Explicit native Tauri binary required');
await runE2E(import.meta.url,{testId:'native-effective-model-summary',tier:'manual-live',modelPolicy:'native UI and real HTTP model settings, deterministic loopback protocol'},async context=>{
  let release=false;
  const model=await startApprovalModelFixture(context,{responseSteps:({body})=>[
    {ready:()=>!JSON.stringify(body.messages).includes('NATIVE_PINNED')||release,delta:{content:'NATIVE_SUMMARY_DONE'}},{finishReason:'stop'}]});
  const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN,kcoderBin:resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
  const command=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
  try{
    await writeFile(client.settingsPath,JSON.stringify({active_provider:'summary',providers:{summary:{api_format:'openai_chat_completions',endpoint:model.baseUrl,
      default_model:'native-summary',authentication:{mode:'none'},context_window_tokens:64000,max_output_tokens:1024,output_headroom_tokens:1024,no_proxy:true}}}),{mode:0o600});
    await client.command('navigate',{value:'/'});await command('waitFor','project-new-conversation-button',{visible:true});await command('click','project-new-conversation-button');
    await command('waitFor','chat-message-input',{visible:true});await command('fill','chat-message-input',{value:'NATIVE_PINNED'});
    await command('waitFor','send-message-button',{enabled:true});await command('click','send-message-button');
    await waitFor(()=>model.requests.length===1,15000,'native first model request');assert.equal(model.requests[0].max_tokens,1024);
    await command('click','settings-button');await command('waitFor','settings-menu-button',{visible:true});await command('click','settings-menu-button');
    await command('waitFor','settings-nav-model-settings',{visible:true});await command('click','settings-nav-model-settings');
    await command('waitFor','provider-edit-summary::native-summary',{visible:true});await command('click','provider-edit-summary::native-summary');
    await client.command('fill',{selector:'[data-testid="provider-reasoning-policy-mode"]',value:'always_off'});
    await client.command('fill',{selector:'[data-testid="provider-reasoning-effort"]',value:'none'});
    await command('fill','provider-maxOutputTokens',{value:'2048'});await command('click','provider-save');
    await waitFor(async()=>String(await client.command('getText',{selector:'[role="status"]'})).includes('下一轮'),20000,'native saved model limit');
    await command('click','settings-back-button');await command('waitFor','model-selector-button',{enabled:true});await command('click','model-selector-button');
    await client.command('waitFor',{selector:'[data-testid="model-configuration-details"] > summary',visible:true});
    await client.command('click',{selector:'[data-testid="model-configuration-details"] > summary'});
    await command('waitFor','model-configuration-session_snapshot',{text:'1,024'});await command('waitFor','model-configuration-next_turn',{text:'2,048'});
    await command('waitFor','model-configuration-next_turn',{text:'声明固定关闭'});
    // Allow the declared 180 ms menu enter animation to settle before capture.
    await new Promise(resolve=>setTimeout(resolve,220));
    await client.command('click',{selector:'[data-testid="model-configuration-session_snapshot"] [data-testid="model-capability-declarations"] > summary'});
    await client.command('waitFor',{selector:'[data-testid="model-configuration-session_snapshot"] [data-testid="model-capability-declarations"]',text:'未知'});
    await client.capture('native-snapshot-next-turn.png');
    assert.ok(Number(await command('scrollToBottomAsUser','model-selector-menu')) > 0);
    await new Promise(resolve=>setTimeout(resolve,220));
    await client.capture('native-reasoning-policy.png');
    release=true;
    return {native:true,pinned:1024,next:2048};
  }catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
  finally{release=true;await client.stop();}
});
