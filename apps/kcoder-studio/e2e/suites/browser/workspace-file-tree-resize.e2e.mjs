import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url,{testId:'file-tree-divider-real-mouse-and-keyboard',tier:'full-integration',modelPolicy:'model-independent real filesystem preview and pointer resizing'},async context=>{
 const {path:workspace}=await materializeWorkspace(context,'minimal');
 const file=resolve(workspace,'tree-width.txt');await writeFile(file,'FILE_TREE_RESIZE_FIXTURE');
 await context.writeStateJson('kcoder-home/settings.json',{providers:{}});
 const gateway=await startGateway(context,{workspace});const browser=await startChromium(context);
 const page=await browser.newPage({viewport:{width:1440,height:960}});
 try{
  await page.goto(gateway.baseUrl);await page.getByTestId('desktop-sidebar').waitFor();
  await page.getByTestId('toggle-right-workspace-panel-button').click();
  await page.getByTestId('right-workspace-file-option').click();
  await page.locator('button[data-item-path$="tree-width.txt"]').click();
  await page.getByTestId('workspace-file-preview-code-view').waitFor();
  const tree=page.getByTestId('workspace-file-tree-container'),handle=page.getByTestId('workspace-file-tree-resize-handle');
  const before=(await tree.boundingBox()).width,position=await handle.boundingBox();
  await page.mouse.move(position.x+position.width/2,position.y+position.height/2);
  await page.mouse.down();await page.mouse.move(position.x+position.width/2+48,position.y+position.height/2,{steps:8});await page.mouse.up();
  await waitFor(async()=> (await tree.boundingBox()).width<before-16,5000,'actual pointer reduces tree width');
  assert.ok(Math.abs((await tree.boundingBox()).width-(await page.getByTestId('workspace-file-tree').boundingBox()).width)<1,'inner tree follows container');
  await handle.press('End');
  const max=Number(await handle.getAttribute('aria-valuemax'));
  assert.ok(Math.abs((await tree.boundingBox()).width-max)<=1);
  await page.getByTestId('workspace-file-toggle-tree-button').click();await tree.waitFor({state:'hidden'});
  await page.getByTestId('workspace-file-toggle-tree-button').click();
  assert.ok(Math.abs((await tree.boundingBox()).width-max)<=1,'toggle retains allocation');
  await handle.press('Home');
  assert.ok(Math.abs((await tree.boundingBox()).width-Number(await handle.getAttribute('aria-valuemin')))<=1);
  await page.setViewportSize({width:900,height:600});
  const split=await page.getByTestId('workspace-file-split').boundingBox(),treeBox=await tree.boundingBox();
  assert.ok(treeBox.x>=split.x+split.width*0.5&&treeBox.x+treeBox.width<=split.x+split.width+1,'narrow pane leaves preview visible');
  await page.screenshot({path:context.pathInArtifacts('file-tree-resized.png')});
  assert.equal(await readFile(file,'utf8'),'FILE_TREE_RESIZE_FIXTURE');
  return {mouseDrag:true,keyboardBounds:true,toggleRetainsWidth:true,narrowPreviewVisible:true};
 }catch(error){await page.screenshot({path:context.pathInArtifacts('failure.png')}).catch(()=>{});throw error;}
 finally{await page.close();}
});
