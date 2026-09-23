import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot,repoRoot,runE2E } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
if(!process.env.KCODER_E2E_TAURI_BIN)throw Error('Explicit owned Tauri binary required');
await runE2E(import.meta.url,{testId:'native-shortcut-conflict-focus-and-narrow-font-controls',tier:'manual-live',modelPolicy:'model-independent actual Tauri keyboard settings and private preferences'},async context=>{
 const client=await startOwnedAiVerify(context,{tauriBin:process.env.KCODER_E2E_TAURI_BIN,kcoderBin:process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder'),rendererRoot:resolve(appRoot,'renderer/dist')});
 const cmd=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
 try{
  await cmd('waitFor','desktop-sidebar');
  await client.command('navigate',{value:'/settings'});await cmd('waitFor','general-language-en-button');await cmd('click','general-language-en-button');
  await cmd('click','settings-nav-keyboard-shortcuts');await cmd('waitFor','keyboard-shortcut-record-openTerminal',{enabled:true});
  await cmd('click','keyboard-shortcut-record-openTerminal');await cmd('press','keyboard-shortcut-record-openTerminal',{key:'Control+b'});
  await cmd('waitFor','keyboard-shortcuts-error',{text:'already assigned'});
  await cmd('press','keyboard-shortcut-record-openTerminal',{key:'Escape'});
  await client.command('waitFor',{selector:'[data-testid="keyboard-shortcut-record-openTerminal"]:focus'});
  await cmd('click','keyboard-shortcut-record-openTerminal');await cmd('press','keyboard-shortcut-record-openTerminal',{key:'Control+Alt+k'});
  await cmd('waitFor','keyboard-shortcut-record-openTerminal',{text:'Ctrl Alt K'});
  await cmd('click','keyboard-shortcut-reset-openTerminal');await cmd('waitFor','keyboard-shortcut-record-openTerminal',{text:'Ctrl J'});
  await client.command('resizeWindow',{value:'400x500'});await cmd('waitFor','settings-compact-navigation');
  await cmd('scrollIntoView','keyboard-shortcut-record-openTerminal');await cmd('click','keyboard-shortcut-record-openTerminal');await cmd('press','keyboard-shortcut-record-openTerminal',{key:'Escape'});
  await client.capture('native-narrow-shortcuts.png');
  await client.command('resizeWindow',{value:'1280x720'});await cmd('click','settings-nav-appearance');
  await cmd('waitFor','appearance-ui-font-size-input');await cmd('fill','appearance-ui-font-size-input',{value:'16'});await cmd('press','appearance-ui-font-size-input',{key:'Enter'});
  assert.equal(await cmd('getValue','appearance-code-font-size-input'),'12');
  await cmd('fill','appearance-code-font-size-input',{value:'22'});await cmd('press','appearance-code-font-size-input',{key:'Enter'});
  assert.equal(await cmd('getValue','appearance-ui-font-size-input'),'16');
  await cmd('click','appearance-mode-dark');await cmd('click','appearance-reset-button');
  assert.equal(await cmd('getValue','appearance-ui-font-size-input'),'14');assert.equal(await cmd('getValue','appearance-code-font-size-input'),'12');
  await client.capture('native-font-reset.png');return {conflict:true,focusReturn:true,savedAndReset:true,narrowReachable:true,independentFontSizes:true};
 }catch(error){client.markFailed();await client.capture('failure.png').catch(()=>{});throw error;}
 finally{await client.stop();}
});
