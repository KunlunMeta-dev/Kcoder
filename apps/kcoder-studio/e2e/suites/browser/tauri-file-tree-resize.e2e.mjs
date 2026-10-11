import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot,repoRoot,runE2E,waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if(!process.env.KCODER_E2E_TAURI_BIN)throw Error('Explicit Tauri binary required');
await runE2E(import.meta.url,{testId:'native-file-tree-real-pointer-divider',tier:'manual-live',modelPolicy:'model-independent owned X11 mouse drag, native tree/editor and keyboard'},async context=>{
 const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN,kcoderBin:resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
 const workspace=resolve(dirname(dirname(client.settingsPath)),'workspaces/tauri-verification');
 const file=resolve(workspace,'tree-width.txt');await writeFile(file,'NATIVE_TREE_RESIZE');
 const cmd=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
 const metric=async id=>JSON.parse(await cmd('getElementMetrics',id))[0];
 try{
  await cmd('waitFor','desktop-sidebar');await cmd('click','toggle-right-workspace-panel-button');await cmd('waitFor','right-workspace-file-option');await cmd('click','right-workspace-file-option');
  const item='[data-testid="workspace-file-tree-pierre"] >>> button[data-item-path$="tree-width.txt"]';
  await client.command('waitFor',{selector:item});await client.command('click',{selector:item});await cmd('waitFor','workspace-file-preview-code-view');
  const before=await metric('workspace-file-tree-container'),handle=await metric('workspace-file-tree-resize-handle');
  const x=Math.round(handle.left+handle.width/2),y=Math.round(handle.top+handle.height/2);
  await client.command('dragPointer',{value:`${x},${y}:${x+48},${y}`});
  await waitFor(async()=> (await metric('workspace-file-tree-container')).width<before.width-16,5000,'trusted native pointer resizes tree');
  await cmd('press','workspace-file-tree-resize-handle',{key:'End'});
  const expanded=await metric('workspace-file-tree-container');assert.ok(expanded.width>before.width-16);
  await cmd('click','workspace-file-toggle-tree-button');
  await waitFor(async()=> (await metric('workspace-file-tree-container')).width===0,5000,'native tree hidden');
  await cmd('click','workspace-file-toggle-tree-button');
  await waitFor(async()=>Math.abs((await metric('workspace-file-tree-container')).width-expanded.width)<1,5000,'native toggle restores width');
  await client.command('resizeWindow',{value:'900x600'});
  const geometry=await waitFor(async()=>{
    const split=await metric('workspace-file-split'),tree=await metric('workspace-file-tree-container');
    return tree.left>=split.left+split.width*0.5&&tree.right<=split.right+1 ? {split,tree}:null;
  },5000,'native resized pane bounds settle');
  await context.writeArtifactJson('native-split-geometry.json',geometry);
  await client.capture('native-file-tree-resized.png');
  assert.equal(await readFile(file,'utf8'),'NATIVE_TREE_RESIZE');
  return {nativeMouseDrag:true,keyboard:true,toggle:true,narrow:true};
 }catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
 finally{await client.stop();}
});
