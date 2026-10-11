import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {testId:'native-tool-crash-recovery',tier:'manual-live',
  modelPolicy:'model-independent real app-server kill and persisted transcript in isolated Tauri'}, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder');
  const client = await startOwnedAiVerify(context, {
    tauriBin:process.env.KCODER_E2E_TAURI_BIN || resolve(appRoot,'renderer/src-tauri/target/debug/app'),
    kcoderBin:binary,rendererRoot:resolve(appRoot,'renderer/dist'),
  });
  const command = (action,id,args={}) => client.command(action,{selector:`[data-testid="${id}"]`,...args});
  try {
    await command('waitFor','desktop-sidebar');
    const fixture = await startApprovalModelFixture(context,{textOnly:true});
    await writeFile(client.settingsPath,JSON.stringify({permission_mode:'bypass',active_provider:'fixture',
      providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},
        endpoint:fixture.baseUrl,default_model:'fixture',context_window_tokens:128000,
        output_headroom_tokens:1024,max_output_tokens:1024,no_proxy:true}}}));
    const workspace = resolve(dirname(client.settingsPath),'../workspaces/tauri-verification');
    const seed = context.spawnOwned('crash-seed',binary,
      ['--settings-file',client.settingsPath,'--cwd',workspace,'app-server','--scenario','busy-wait'],
      {stdin:'pipe',env:context.isolatedEnvironment({KCODER_CONFIG_DIR:dirname(client.settingsPath),KCODER_TUI_LAB_STREAM_DELAY_MS:'1'})});
    const responses = new Map(); let started = false;
    const lines = createInterface({input:seed.stdout});
    lines.on('line',line=>{const frame=JSON.parse(line);if(frame.id)responses.set(frame.id,frame);
      if(frame.method==='item/started' && line.includes('tui-lab-busy-wait'))started=true;});
    const rpc = async (id,method,params)=>{
      seed.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
      const response=await waitFor(()=>responses.get(id),15000,method);
      assert.ok(!response.error,JSON.stringify(response.error));return response.result;
    };
    await rpc(1,'initialize',{protocolVersion:'2026-07-27',clientInfo:{name:'crash-test',version:'1'}});
    const {thread} = await rpc(2,'thread/start',{});
    await rpc(3,'turn/start',{threadId:thread.id,input:[{type:'text',text:'Crash recovery tool fixture'}]});
    await waitFor(()=>started,20000,'tool started');
    let readId = 4;
    await waitFor(async()=>{
      const live = await rpc(readId++,'thread/read',{threadId:thread.id,limit:50});
      return live.messages.flatMap(m=>m.blocks || []).some(b=>b.tool_use_id==='tui-lab-busy-wait' && b.status==='pending');
    },15000,'live tool persisted before crash');
    seed.kill('SIGKILL');
    await waitFor(()=>seed.exitCode!==null || seed.signalCode!==null,10000,'seed killed');
    lines.close(); await context.stopOwned('crash-seed');
    await client.command('navigate',{value:'/settings'});
    await client.command('navigate',{value:'/'});
    // Creating one ordinary conversation refreshes the target's history catalogue.
    await command('waitFor','chat-message-input');
    await command('fill','chat-message-input',{value:'Refresh recovery catalogue'});
    await command('waitFor','send-message-button',{enabled:true});
    await command('click','send-message-button');
    await command('waitFor','message-assistant',{timeoutMs:20000});
    const row = `[data-testid^="runtime-local-task-row-"][data-testid$="${thread.id}"]`;
    await client.command('waitFor',{selector:row,timeoutMs:30000});
    await client.command('click',{selector:row});
    await command('waitFor','message-assistant',{timeoutMs:20000});
    const spinning = '[data-testid="message-assistant"] .animate-spin';
    await waitFor(async()=>await client.command('getElementCount',{selector:spinning})==='0',10000,'restored tool not spinning');
    await client.command('navigate',{value:'/settings'});
    await client.command('navigate',{value:'/'});
    await client.command('click',{selector:row});
    await command('waitFor','message-assistant');
    assert.equal(await client.command('getElementCount',{selector:spinning}),'0');
    await command('click','processing-summary-toggle');
    await client.command('click',{selector:'[data-tool-detail-toggle]'});
    await command('waitFor','message-assistant',{text:'此工具已停止运行'});
    assert.equal(await client.command('getElementCount',{selector:spinning}),'0');
    await client.capture('native-tool-recovered.png');
    return {killed:true,reopened:true,noStaleSpinner:true};
  } catch(error) {client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
  finally {await client.stop();}
});
