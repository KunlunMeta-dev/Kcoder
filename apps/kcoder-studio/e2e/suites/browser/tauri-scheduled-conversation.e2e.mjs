import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
// QA: isolated native app and real scheduler/RPC. Without manual refresh, a new
// scheduled conversation must appear, open and display its persisted reply.
// RunContext owns the model fixture, profile, processes and cleanup.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {testId:'native-scheduled-conversation-list', tier:'manual-live', modelPolicy:'deterministic local provider; real scheduled delivery and native sidebar/history'}, async context => {
  const model = await startApprovalModelFixture(context, {textOnly:true, textOnlyChunks:['NATIVE_SCHEDULE_REPLY'], textOnlyChunkDelayMs:0});
  const client = await startOwnedAiVerify(context, {timezone:'UTC',tauriBin:process.env.KCODER_E2E_TAURI_BIN || resolve(appRoot,'renderer/src-tauri/target/debug/app'),kcoderBin:process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
  const cmd=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
  try {
    context.registerSecret('native-schedule-key');
    await writeFile(client.settingsPath,JSON.stringify({active_provider:'schedule',permission_mode:'yolo',providers:{schedule:{api_format:'openai_chat_completions',endpoint:model.baseUrl,default_model:'schedule',context_window_tokens:128000,max_output_tokens:4096,output_headroom_tokens:8192,no_proxy:true}}}));
    await writeFile(resolve(dirname(client.settingsPath),'credentials.json'),JSON.stringify({schedule:{type:'api',key:'native-schedule-key'}}),{mode:0o600});
    await cmd('waitFor','automations-button');await cmd('click','automations-button');
    await client.command('waitFor',{selector:'[data-testid="automation-prompt"]:enabled'});
    await cmd('fill','automation-prompt',{value:'NATIVE_SCHEDULE_LIST'});
    await cmd('fill','automation-at',{value:new Date(Date.now()+12000).toISOString().slice(0,19)});
    await cmd('click','automation-confirm');await cmd('click','automation-create');
    await cmd('waitFor','automation-job',{text:'NATIVE_SCHEDULE_LIST'});
    const row='[data-testid="desktop-sidebar"] [data-testid^="runtime-local-task-row-"]';
    await client.command('waitFor',{selector:row,text:'NATIVE_SCHEDULE_LIST',timeoutMs:45000});
    await client.command('click',{selector:row});
    await cmd('waitFor','message-user',{text:'NATIVE_SCHEDULE_LIST',timeoutMs:15000});
    await cmd('waitFor','message-assistant',{text:'NATIVE_SCHEDULE_REPLY',timeoutMs:15000});
    assert.ok(model.requests.some(request=>JSON.stringify(request.messages).includes('NATIVE_SCHEDULE_LIST')));
    await cmd('click','automations-button');
    await cmd('click','automation-tab-history');
    await cmd('waitFor','automation-run-history');
    await cmd('waitFor','automation-runs-refresh',{enabled:true});
    await cmd('click','automation-runs-refresh');
    await client.command('waitFor',{selector:'[data-testid="automation-run"][data-status="succeeded"]',text:'NATIVE_SCHEDULE_REPLY',timeoutMs:15000});
    await cmd('click','automation-run-open-thread');
    await cmd('waitFor','message-assistant',{text:'NATIVE_SCHEDULE_REPLY'});
    const receipt=await waitFor(async()=>{
      const value=JSON.parse(await readFile(resolve(client.runRoot,'state/workspaces/tauri-verification/.kcoder/cron/jobs.json'),'utf8'));
      const text=JSON.stringify(value);
      return text.includes('NATIVE_SCHEDULE_REPLY') ? value : null;
    },5000,'persisted actual scheduled reply evidence');
    const execution=receipt.receipts.find(item=>item.execution?.replyPreview==='NATIVE_SCHEDULE_REPLY')?.execution;
    assert.equal(execution?.status,'succeeded');
    assert.ok(execution.threadId && execution.turnId && execution.attemptId && execution.startedAt && execution.finishedAt);
    assert.equal(execution.requestId,`kcoder-automation-turn:${execution.triggerId}`);
    assert.equal(receipt.jobs.length,0,'removed one-shot still retains its linked execution evidence');
    await context.writeArtifactJson('native-schedule-execution.json',{executionEvidence:receipt,nativeHistoryOpen:true});
    await client.capture('native-scheduled-conversation-visible.png');
  } catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
  finally {await client.stop();}
});
