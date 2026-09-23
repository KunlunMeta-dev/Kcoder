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
 const gateway=await startGateway(context,{workspace});
 const browser=await startChromium(context);
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 try{
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
  await page.getByTestId('settings-compact-select').selectOption('appearance');
  await page.getByTestId('appearance-mode-dark').waitFor();
  await page.getByTestId('settings-compact-select').selectOption('quick-phrases');
  await page.getByText('Unsaved resize draft',{exact:true}).waitFor();
  await page.getByTestId('settings-compact-back').click();
  assert.equal(new URL(page.url()).pathname,'/');
  await page.getByTestId('mobile-empty-header').waitFor();
  return {draftPreserved:true,sameInput:true,compactNavigation:true,layoutAdoptedAfterExit:true};
 }catch(error){await page.screenshot({path:context.pathInArtifacts('failure.png')}).catch(()=>{});throw error;}
 finally{await page.close();}
});
