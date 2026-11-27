import assert from 'node:assert/strict';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { runE2E } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {testId:'settings-draft-survives-layout-breakpoints',tier:'full-integration',modelPolicy:'model-independent real viewport resizing and settings persistence'},async context=>{
 const {path:workspace}=await materializeWorkspace(context,'minimal');
 await context.writeStateJson('kcoder-home/settings.json',{providers:{}});
 const gateway=await startGateway(context,{workspace,auth:true});
 const browser=await startChromium(context);
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 try{
  const login = await page.request.post(`${gateway.baseUrl}/login`, {
    form: { token: gateway.authToken }, maxRedirects: 0,
  });
  assert.equal(login.status(), 303, 'the connector inventory needs an authenticated Gateway browser session');
  await page.goto(`${gateway.baseUrl}/settings`);
  await page.getByRole('region', {name:'资料导入'}).waitFor();
  await page.screenshot({path:context.pathInArtifacts('desktop-settings.png')});
  const search = page.getByRole('searchbox', {name:'搜索设置'});
  await search.fill('API 密钥');
  await page.getByTestId('settings-nav-model-settings').click();
  await page.getByTestId('kcoder-provider-settings-page').waitFor();
  assert.equal(new URL(page.url()).pathname, '/settings/personal/models');
  await page.goto(`${gateway.baseUrl}/settings/personal/quick-phrases`);
  await page.getByTestId('quick-phrase-edit-default-summary-progress').click();
  await page.getByTestId('quick-phrase-title-input').fill('Unsaved resize draft');
  const original=await page.getByTestId('quick-phrase-title-input').elementHandle();
  await page.setViewportSize({width:400,height:300});
  await page.getByTestId('settings-compact-navigation').waitFor();
  assert.equal(await page.getByTestId('quick-phrase-title-input').inputValue(),'Unsaved resize draft');
  assert.equal(await original.evaluate(element=>element.isConnected),true,'same input remains mounted');
  await page.getByTestId('quick-phrase-save-button').scrollIntoViewIfNeeded();
  const box=await page.getByTestId('quick-phrase-save-button').boundingBox();
  assert.ok(box.x>=0&&box.x+box.width<=401&&box.y>=0&&box.y+box.height<=301,'save reachable at narrow/200%-equivalent layout');
  await page.screenshot({path:context.pathInArtifacts('narrow-editor-draft.png')});
  await page.setViewportSize({width:1280,height:900});
  assert.equal(await original.evaluate(element=>element.isConnected),true);
  assert.equal(await page.getByTestId('quick-phrase-title-input').inputValue(),'Unsaved resize draft');
  await page.getByTestId('quick-phrase-save-button').click();
  await page.getByTestId('quick-phrase-editor').waitFor({state:'hidden'});
  await page.setViewportSize({width:400,height:600});
  await page.getByTestId('settings-compact-directory').click();
  const directory = page.getByRole('dialog');
  await directory.getByRole('searchbox').fill('字号');
  await directory.getByTestId('mobile-settings-appearance-button').click();
  await page.getByTestId('appearance-mode-dark').waitFor();
  await page.getByTestId('settings-compact-directory').click();
  await directory.getByTestId('mobile-settings-quick-phrases-button').click();
  await page.getByText('Unsaved resize draft',{exact:true}).waitFor();
  await page.getByTestId('settings-compact-directory').click();
  await directory.getByRole('searchbox').fill('语言');
  await directory.getByTestId('mobile-settings-general-button').click();
  await page.getByTestId('general-language-en-button').waitFor();
  await page.getByTestId('settings-return-to-conversation').click();
  assert.equal(new URL(page.url()).pathname,'/');
  await page.setViewportSize({width:1680,height:960});
  await page.goto(`${gateway.baseUrl}/settings`);
  assert.equal(await page.getByTestId('settings-nav-channels').count(), 0);
  await page.getByTestId('general-language-en-button').waitFor();
  await page.getByTestId('general-external-content-import-button').waitFor();
  await page.getByTestId('settings-nav-model-settings').click();
  await page.getByTestId('provider-new').waitFor();
  assert.equal(await page.getByTestId('provider-migration-card').count(), 0);
  await page.getByTestId('settings-nav-execution-defaults').click();
  await page.getByTestId('execution-permission-defaults').waitFor();
  assert.equal(await page.getByTestId('target-custom-instructions').count(), 0);
  await page.goto(`${gateway.baseUrl}/settings/channels/?from=bookmark#connections`);
  await checkIndependentConnectors(page, context, 'desktop');
  assert.equal(new URL(page.url()).search + new URL(page.url()).hash, '?from=bookmark#connections');
  return {draftPreserved:true,sameInput:true,compactNavigation:true,desktopAndCompactSearch:true};
 }catch(error){await page.screenshot({path:context.pathInArtifacts('failure.png')}).catch(()=>{});throw error;}
 finally{await page.close();}
});

async function checkIndependentConnectors(page, context, layout) {
  await page.getByTestId('channels-page').waitFor();
  assert.equal(new URL(page.url()).pathname, '/channels');
  assert.equal(await page.getByTestId('settings-return-to-conversation').isVisible(), false);
  await page.getByTestId('channel-add-connection').click();
  await page.getByTestId('channel-add-connection-qq').waitFor();
  await page.getByRole('dialog').getByRole('button', {name:/^(关闭|Close)$/i}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.screenshot({path:context.pathInArtifacts(`connectors-${layout}.png`)});
}
