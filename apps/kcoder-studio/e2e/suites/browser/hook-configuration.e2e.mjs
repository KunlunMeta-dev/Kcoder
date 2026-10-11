import { isDeepStrictEqual } from 'node:util';
import assert from 'node:assert/strict';
import { readFile,writeFile,stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway,waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl,initializeRpc,openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot,runE2E,waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'studio-user-hook-crud-and-target-scope',tier:'full-integration',modelPolicy:'model-independent real targets, CAS conflict, late actual RPC response and Shell Hook execution'},async context=>{
 const {path:workspace}=await materializeWorkspace(context,'minimal');
 const model=await startApprovalModelFixture(context,{responseSteps:()=>[{delta:{role:'assistant',content:'HOOK_UI_REPLY'},finishReason:'stop'}]});
 const binary=process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder');
 const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
 const targets=[];
 for(const id of ['alpha','beta']){
  await context.writeStateJson(`${id}/settings.json`,{active_provider:'fixture',providers:{fixture:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'fixture',context_window_tokens:64000,max_output_tokens:1024,output_headroom_tokens:1024,no_proxy:true}}});
  const launcher=context.pathInState(`${id}-launcher`);
  await writeFile(launcher,`#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(context.pathInState(id))}\nexec ${quote(binary)} "$@"\n`,{mode:0o700});
  targets.push({id,label:id,transport:'local',command:launcher,workspace});
 }
 const serversFile=await context.writeStateJson('servers.json',targets);
 const gateway=await startGateway(context,{workspace,serversFile,kcoderBin:binary});const browser=await startChromium(context);
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 const hook=command=>({UserPromptSubmit:[{hooks:[{type:'command',shell:'bash',command,timeout:5}]}]});
 try{
  await page.goto(gateway.baseUrl+'/settings/hooks');await page.getByTestId('hooks-json').waitFor();
  await page.evaluate(()=>{window.__hookDocumentIdentity='same-running-Studio'});
  await page.getByTestId('hooks-json').fill('{invalid');await page.getByTestId('hooks-save').click();await page.getByRole('alert').waitFor();
  assert.equal(JSON.parse(await readFile(context.pathInState('alpha/settings.json'),'utf8')).hooks,undefined);
  const configuration=hook('printf a >> alpha-hook-count');
  await page.getByTestId('hooks-json').fill(JSON.stringify(configuration));await page.getByTestId('hooks-save').click();
  await waitFor(async()=>await page.getByTestId('hooks-save').isDisabled()&&!await page.getByTestId('hooks-json').isDisabled(),10000,'Hook save acknowledged');
  assert.equal(await stat(resolve(workspace,'alpha-hook-count')).then(()=>true,()=>false),false,'save validates without executing');
  await page.getByTestId('settings-back-button').click();
  const project=page.locator('[data-testid="project-item"]:visible').filter({hasText:'alpha'}).first();await project.hover();await project.getByTestId('project-new-conversation-button').click();
  await page.getByTestId('chat-message-input').click();await page.keyboard.insertText('HOOK_UI_TURN');await page.getByTestId('send-message-button').click();
  await page.getByText('HOOK_UI_REPLY',{exact:true}).waitFor({timeout:30000});
  assert.equal(await readFile(resolve(workspace,'alpha-hook-count'),'utf8'),'a');
  assert.equal(await page.evaluate(()=>window.__hookDocumentIdentity),'same-running-Studio');
  await page.getByTestId('settings-button').click();await page.getByTestId('settings-menu-button').click();await page.getByTestId('settings-nav-hooks').click();await page.getByTestId('hooks-json').waitFor();
  const token=await waitForGatewayRpcToken(context,gateway),rpc=await openRpc(gatewayRpcUrl(gateway,'alpha',token));context.addCleanup('close Hook conflict writer',()=>rpc.close());await initializeRpc(rpc,'hook-conflict-writer');
  const baseline=await rpc.request('hooks/config/read');const external=hook('printf external >> external-hook-count');
  await rpc.request('hooks/config/update',{hooks:external,expectedRevision:baseline.revision});
  await page.getByTestId('hooks-json').fill(JSON.stringify(hook('printf draft >> draft-hook-count')));await page.getByTestId('hooks-save').click();await page.getByRole('alert').waitFor();
  assert.ok((await page.getByTestId('hooks-json').inputValue()).includes('draft-hook-count'));
  assert.deepEqual(JSON.parse(await readFile(context.pathInState('alpha/settings.json'),'utf8')).hooks,external);
  await page.getByTestId('hooks-refresh').click();await page.getByTestId('hooks-confirm-confirm').click();
  await waitFor(async()=> (await page.getByTestId('hooks-json').inputValue()).includes('external-hook-count'),10000,'explicit reload');
  await page.evaluate(()=>{const bridge=window.__TAURI_INTERNALS__,invoke=bridge.invoke;bridge.invoke=async(command,args)=>{const result=await invoke(command,args);if(!window.__hookHeld&&command==='local_executor_request'&&args?.method==='runtime.hooks.configuration.read'&&args.params?.deviceId==='alpha'){window.__hookHeld=true;await new Promise(resolve=>{window.__releaseHook=resolve})}return result}});
  await page.getByTestId('hooks-refresh').click();await waitFor(()=>page.evaluate(()=>window.__hookHeld===true),10000,'actual Alpha response held');
  await page.getByTestId('hooks-target').selectOption('beta');await page.getByTestId('hooks-json').waitFor();
  const beta=hook('printf beta >> beta-hook-count');await page.getByTestId('hooks-json').fill(JSON.stringify(beta));await page.getByTestId('hooks-save').click();
  await waitFor(async()=>isDeepStrictEqual(JSON.parse(await readFile(context.pathInState('beta/settings.json'),'utf8')).hooks,beta),10000,'Beta saved');
  await page.evaluate(()=>window.__releaseHook());assert.equal(await page.getByTestId('hooks-target').inputValue(),'beta');
  assert.deepEqual(JSON.parse(await page.getByTestId('hooks-json').inputValue()),beta);
  await page.getByTestId('hooks-clear').click();await page.getByTestId('hooks-confirm-close').click();assert.deepEqual(JSON.parse(await readFile(context.pathInState('beta/settings.json'),'utf8')).hooks,beta);
  await page.getByTestId('hooks-clear').click();await page.getByTestId('hooks-confirm-confirm').click();
  await waitFor(async()=>!('hooks' in JSON.parse(await readFile(context.pathInState('beta/settings.json'),'utf8'))),10000,'user hooks deleted');
  assert.deepEqual(JSON.parse(await readFile(context.pathInState('alpha/settings.json'),'utf8')).hooks,external);
  await page.screenshot({path:context.pathInArtifacts('hooks-target-beta-cleared.png')});
  return {saveDoesNotExecute:true,newConversationExecutes:true,noRestart:true,conflictPreservesDraft:true,lateAlphaIgnored:true,betaOnlyDeleted:true};
 }catch(error){await page.screenshot({path:context.pathInArtifacts('failure.png')}).catch(()=>{});throw error;}
 finally{await page.close();}
});
