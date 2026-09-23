import assert from 'node:assert/strict';
import { copyFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('Explicit Tauri binary required');
await runE2E(import.meta.url, { testId:'tauri-mcp-connection-failure-and-recovery',tier:'manual-live',modelPolicy:'model-independent real native UI, actual stdio MCP, loopback text fixture' }, async context => {
  const model=await startApprovalModelFixture(context,{textOnly:true,textOnlyResponse:'MCP_STATUS_DONE'});
  const script=resolve(appRoot,'e2e/harness/component-probe-mcp.cjs');
  const recovering=context.pathInState('recovering.cjs');
  const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN,kcoderBin:process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
  const cmd=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
  try {
    await cmd('waitFor','desktop-sidebar',{visible:true});
    const key='owned-status-fixture';context.registerSecret(key);
    await writeFile(resolve(dirname(client.settingsPath),'credentials.json'),JSON.stringify({fixture:{type:'api',key}}),{mode:0o600});
    await writeFile(client.settingsPath,JSON.stringify({active_provider:'fixture',max_retries:0,
      providers:{fixture:{api_format:'openai_chat_completions',endpoint:model.baseUrl,default_model:'fixture-model',no_proxy:true,context_window_tokens:128000,max_output_tokens:1024,output_headroom_tokens:1024}},
      mcp_servers:[{name:'healthy',transport:'stdio',command:process.execPath,args:[script,context.pathInState('healthy-calls')]},{name:'recovering',transport:'stdio',command:process.execPath,args:[recovering,context.pathInState('recovery-calls')]}]}),{mode:0o600});
    await client.command('navigate',{value:'/settings/personal/models'});
    await cmd('waitFor','provider-edit-fixture::fixture-model',{timeoutMs:15000});
    const conversation=async()=>{
      await client.command('navigate',{value:'/'});
      await cmd('waitFor','project-new-conversation-button',{timeoutMs:15000});
      await cmd('click','project-new-conversation-button');
      await cmd('waitFor','chat-message-input',{visible:true});
      await cmd('fill','chat-message-input',{value:'MCP_STATUS_PROBE'});
      await cmd('waitFor','send-message-button',{enabled:true});
      await cmd('click','send-message-button');
      await cmd('waitFor','message-assistant',{text:'MCP_STATUS_DONE',timeoutMs:30000});
      await client.command('navigate',{value:'/plugins/manage'});
      await cmd('waitFor','kcoder-plugin-tab-mcp',{timeoutMs:15000});
      await cmd('click','kcoder-plugin-tab-mcp');
      await cmd('waitFor','kcoder-mcp-connection-status',{timeoutMs:15000});
    };
    await conversation();
    await waitFor(async()=>/上次连接失败/.test(await cmd('getText','kcoder-mcp-management')),10000,'native failed connection');
    assert.match(await cmd('getText','kcoder-mcp-management'),/上次连接成功/);
    await client.capture('mcp-connection-failed.png');
    await copyFile(script,recovering);
    await conversation();
    await waitFor(async()=>! /上次连接失败/.test(await cmd('getText','kcoder-mcp-management')),10000,'native recovered connection');
    assert.match(await cmd('getText','kcoder-mcp-management'),/上次连接成功/);
    await client.capture('mcp-connection-recovered.png');
  }catch(error){client.markFailed();await client.capture('mcp-status-failure.png').catch(()=>{});throw error;}
});
