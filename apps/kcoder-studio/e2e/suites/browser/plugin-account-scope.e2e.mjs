import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startSshFixture } from '../../harness/ssh-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot,runE2E,waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'plugin-queued-and-committed-replies-stay-in-account-scope',tier:'full-integration',modelPolicy:'synthetic authority, real SSH/Gateway/CLI/plugin installation, no model request'},async context=>{
 const {path:workspace}=await materializeWorkspace(context,'minimal');
 const source=context.pathInState('market');await mkdir(resolve(source,'.claude-plugin'),{recursive:true});await mkdir(resolve(source,'demo','.claude-plugin'),{recursive:true});
 await writeFile(resolve(source,'demo','.claude-plugin/plugin.json'),JSON.stringify({name:'scope-demo',version:'1.0.0',description:'Owned account scope plugin'}));
 await writeFile(resolve(source,'.claude-plugin/marketplace.json'),JSON.stringify({name:'scope-market',owner:{name:'Fixture'},plugins:[{name:'scope-demo',source:'./demo',version:'1.0.0'}]}));
 const accounts=[];for(const [index,username]of ['alice','bob'].entries()){const password=`synthetic-${username}`;context.registerSecret(password);await context.writeStateJson(`${username}/settings.json`,{providers:{}});accounts.push({username,password,configDir:context.pathInState(username),fixtureUid:2000+index,principalId:`0b6cfba4-5f61-4d17-9d92-3d60a1ef2f0${index}`});}
 const binary=resolve(process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'));const config=await context.writeStateJson('entry.json',{workspace,accounts,binary});const quote=value=>`'${value.replaceAll("'","'\\''")}'`;const launcher=context.pathInState('launcher');await writeFile(launcher,`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(repoRoot,'apps/kcoder-studio/e2e/harness/account-entry-fixture.mjs'))} ${quote(config)}\n`,{mode:0o700});
 const ssh=await startSshFixture(context,{forcedCommand:launcher});const serversFile=await context.writeStateJson('servers.json',[{id:'account',label:'Scope fixture',transport:'ssh',host:'127.0.0.1',port:ssh.port,user:ssh.user,workspace,security:{identity:{mode:'kcoder-account'}}}]);
 const gateway=await startGateway(context,{workspace,serversFile,auth:true,kcoderBin:binary,env:{...ssh.gatewayEnv,KCODER_CONFIG_DIR:context.pathInState('gateway-profile')}});const browser=await startChromium(context);const profile=await browser.browser.newContext();const control=await profile.newPage();const observer=await profile.newPage();
 const login=async username=>{await control.getByTestId('kcoder-account-username').fill(username);await control.getByTestId('kcoder-account-password').fill(`synthetic-${username}`);await control.getByTestId('kcoder-account-submit').click();await control.getByTestId('kcoder-account-logout').waitFor({timeout:20000});};
 const logout=async()=>{await control.getByTestId('kcoder-account-logout').click();await control.getByTestId('kcoder-account-confirm-logout').click();await control.getByTestId('kcoder-account-username').waitFor({timeout:15000});};
 const rpc=(method,params={})=>observer.evaluate(({method,params})=>window.__TAURI_INTERNALS__.invoke('local_executor_request',{method:'runtime.plugins.request',params:{deviceId:'account',method,params}}),{method,params});
 try{
  await control.goto(gateway.baseUrl);await control.locator('input[name="token"]').fill(gateway.authToken);await Promise.all([control.waitForURL(url=>!url.pathname.startsWith('/login')),control.locator('button[type="submit"]').click()]);await control.goto(gateway.baseUrl+'/settings/kcoder-servers');await login('alice');
  await observer.goto(gateway.baseUrl+'/plugins');await observer.getByTestId('plugins-add-marketplace-button').waitFor();await rpc('marketplace/add',{source,trustSourceDirectory:true});await observer.reload();await observer.getByTestId('plugins-marketplace-tab-scope-market').click();
  const install=observer.getByTestId('plugin-marketplace-install-scope-demo@scope-market');await install.waitFor({timeout:20000});
  await observer.evaluate(()=>{const invoke=window.__TAURI_INTERNALS__.invoke;window.__scopeInstallCalls=0;window.__scopeHoldMethod=null;window.__TAURI_INTERNALS__.invoke=async function(command,args){const method=args?.method==='runtime.plugins.request'?args.params?.method:null;if(method==='plugin/install')window.__scopeInstallCalls++;const result=await invoke(command,args);if(method&&method===window.__scopeHoldMethod){window.__scopeHoldMethod=null;window.__scopeHeld=true;await new Promise(resolve=>window.__scopeRelease=resolve)}return result;}});
  await observer.evaluate(()=>{window.__scopeHoldMethod='marketplace/list';window.__scopeHeld=false});await install.click();await waitFor(()=>observer.evaluate(()=>window.__scopeHeld),10000,'actual Alpha catalog reply held');
  await logout();await login('bob');await observer.getByText('bob',{exact:true}).waitFor({timeout:15000});await waitFor(async()=>!(await observer.locator('body').innerText()).includes('Owned account scope plugin'),15000,'Bob has no Alice catalog');await observer.evaluate(()=>window.__scopeRelease());await observer.waitForTimeout(100);
  assert.equal(await observer.evaluate(()=>window.__scopeInstallCalls),0,'queued Alice operation must not install into Bob');assert.equal((await rpc('plugin/list')).plugins.length,0);
  await logout();await login('alice');await observer.getByText('alice',{exact:true}).waitFor({timeout:15000});await observer.getByTestId('plugins-marketplace-tab-scope-market').click();await install.waitFor({timeout:20000});await observer.evaluate(()=>{window.__scopeHoldMethod='plugin/install';window.__scopeHeld=false});await install.click();await waitFor(()=>observer.evaluate(()=>window.__scopeHeld),15000,'actual Alice installation committed before reply');
  await logout();await login('bob');await observer.getByText('bob',{exact:true}).waitFor({timeout:15000});await waitFor(async()=>!(await observer.locator('body').innerText()).includes('Owned account scope plugin'),15000,'Bob catalog after actual Alice commit');await observer.evaluate(()=>window.__scopeRelease());await observer.waitForTimeout(100);
  assert.equal((await rpc('plugin/list')).plugins.length,0);assert.equal(await observer.getByTestId('plugin-marketplace-install-scope-demo@scope-market').count(),0);assert.ok(!(await observer.locator('body').innerText()).includes('scope-demo'));await observer.screenshot({path:context.pathInArtifacts('bob-no-alice-plugin.png')});
  await logout();await login('alice');await waitFor(async()=>(await rpc('plugin/list')).plugins.some(plugin=>plugin.id==='scope-demo@scope-market'),10000,'Alice installation remains owned');
  return {queuedOldWriteRejected:true,lateCommittedReplyIgnored:true,bobUnchanged:true,aliceInstallationPreserved:true};
 }catch(error){await observer.screenshot({path:context.pathInArtifacts('failure.png')}).catch(()=>{});throw error;}finally{await profile.close();}
});
