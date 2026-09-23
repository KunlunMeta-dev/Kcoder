import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {testId:'effective-model-summary-snapshot-versus-next-turn',tier:'full-integration',
  modelPolicy:'real HTTP settings/probe/turn parameters and safe UI metadata; deterministic protocol fixture'}, async context=>{
  let releaseFirst=false;
  const model=await startApprovalModelFixture(context,{responseSteps:({body})=>[
    {ready:()=>!JSON.stringify(body.messages).includes('PINNED_FIRST') || releaseFirst,delta:{content:'SUMMARY_DONE'}},
    {finishReason:'stop'},
  ]});
  const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:'model-summary'});
  const profile=context.pathInState('profile');
  const secret='private-vendor-body-value';context.registerSecret(secret);
  await context.writeStateJson('profile/settings.json',{active_provider:'summary',providers:{summary:{
    api_format:'openai_chat_completions',endpoint:model.baseUrl,default_model:'summary-model',authentication:{mode:'none'},
    no_proxy:true,context_window_tokens:64000,max_output_tokens:1024,output_headroom_tokens:1024,
    extra_body:{temperature:0.2,vendor_secret:secret},
  }}});
  const serversFile=await context.writeStateJson('servers.json',[{id:'local',label:'Summary target',transport:'local',command:resolve(repoRoot,'target/debug/kcoder'),workspace}]);
  const gateway=await startGateway(context,{workspace,serversFile,auth:true,env:{KCODER_CONFIG_DIR:profile}});
  const browser=await startChromium(context);const page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('websocket', socket => socket.on('framereceived', frame => { try { const value=JSON.parse(String(frame.payload)); if(value.error) context.writeArtifactJson('rpc-error.json',{code:value.error.code,message:context.redactText(value.error.message)}).catch(()=>{}); } catch {} }));
  await page.goto(gateway.baseUrl);await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/login')),page.locator('button[type="submit"]').click()]);
  await page.getByTestId('project-new-conversation-button').first().click();
  await page.getByTestId('chat-message-input').fill('PINNED_FIRST');await page.getByTestId('send-message-button').click();
  await waitFor(()=>model.requests.length===1,15000,'first turn accepted');
  assert.equal(model.requests[0].max_tokens,1024);
  await page.getByTestId('model-selector-button').click();
  await page.getByTestId('model-configuration-details').locator(':scope > summary').click();
  const initialCapabilities=page.getByTestId('model-configuration-next_turn').getByTestId('model-capability-declarations');
  await initialCapabilities.locator(':scope > summary').click();
  assert.ok((await initialCapabilities.innerText()).includes('未知'));
  assert.ok(!(await initialCapabilities.innerText()).includes('medium'));
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-button').click();await page.getByTestId('settings-menu-button').click();
  await page.getByTestId('settings-nav-model-settings').click();
  await page.getByTestId('provider-edit-summary::summary-model').click();
  await page.getByTestId('provider-reasoning-policy-mode').selectOption('optional');
  await page.getByTestId('provider-policy-effort-high').check();
  await page.getByTestId('provider-capability-reasoning').check();
  await page.getByTestId('provider-reasoning-effort').selectOption('high');
  await page.getByTestId('provider-maxOutputTokens').fill('2048');await page.getByTestId('provider-save').click();
  await waitFor(async()=> (await page.locator('[role="status"]').allTextContents()).some(text=>text.includes('下一轮')),20000,'new model settings saved');
  await page.getByTestId('settings-back-button').click();
  await page.getByTestId('model-selector-button').click();
  await page.getByTestId('model-configuration-details').locator(':scope > summary').click();
  const next=page.getByTestId('model-configuration-next_turn');
  const active=page.getByTestId('model-configuration-session_snapshot');
  await next.waitFor();await active.waitFor();
  assert.match(await next.innerText(),/可开关/);
  assert.match(await next.innerText(),/2,048/);assert.match(await active.innerText(),/1,024/);
  const details=await page.getByTestId('model-configuration-details').innerText();
  assert.ok(details.includes('local'));assert.ok(details.includes('共享运行账号'));
  assert.ok(!details.includes(secret) && !details.includes('vendor_secret'));
  await page.screenshot({path:context.pathInArtifacts('snapshot-and-next-turn.png')});
  await page.keyboard.press('Escape');releaseFirst=true;
  await page.getByTestId('pause-response-button').waitFor({state:'detached',timeout:15000});
  await page.getByTestId('model-selector-button').click();
  await page.getByTestId('model-control-menu-model').click();
  await page.getByTestId('model-option-summary::summary-model').click();
  await page.getByTestId('model-control-reasoning-none').click();
  await page.screenshot({path:context.pathInArtifacts('declared-reasoning-controls.png'),animations:'disabled'});
  await page.keyboard.press('Escape');
  await page.getByTestId('chat-message-input').fill('NEXT_CONFIGURED_TURN');await page.getByTestId('send-message-button').click();
  await waitFor(()=>model.requests.some(request=>JSON.stringify(request.messages).includes('NEXT_CONFIGURED_TURN')),15000,'next turn');
  assert.equal(model.requests.at(-1).max_tokens,2048);
  assert.equal(model.requests.at(-1).reasoning_effort,'none');
  await page.getByTestId('pause-response-button').waitFor({state:'detached',timeout:15000});
  await page.goto(`${gateway.baseUrl}/settings`);
  await page.getByTestId('general-language-en-button').click();
  page.on('websocket', socket => socket.on('framereceived', frame => { try { const value=JSON.parse(String(frame.payload)); if(value.error) context.writeArtifactJson('rpc-error.json',{code:value.error.code,message:context.redactText(value.error.message)}).catch(()=>{}); } catch {} }));
  await page.goto(gateway.baseUrl);
  await page.getByTestId('desktop-sidebar').locator('[data-testid^="runtime-local-task-row-"]').filter({hasText:'PINNED_FIRST'}).first().click();
  await page.getByTestId('model-selector-button').click();
  await page.getByTestId('model-configuration-details').locator(':scope > summary').click();
  const english=await page.getByTestId('model-configuration-details').innerText();
  assert.match(english,/Effective model settings/);assert.doesNotMatch(english,/[\u3400-\u9fff]/);
  await page.screenshot({path:context.pathInArtifacts('english-model-details.png'),animations:'disabled'});
  return {pinnedOutput:1024,nextOutput:2048,secretsExcluded:true,scopeVisible:true,englishDetails:true};
});
