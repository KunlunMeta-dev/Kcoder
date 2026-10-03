import { startWikiModelFixture } from '../../harness/wiki-model.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, {testId:'native-knowledge-opt-in-catalog',tier:'manual-live',modelPolicy:'Real Provider transport with deterministic Wiki responses; validates import, task persistence and UI, not model quality'}, async context => {
  const client = await startOwnedAiVerify(context, {
    tauriBin:process.env.KCODER_E2E_TAURI_BIN || resolve(appRoot,'renderer/src-tauri/target/debug/app'),
    kcoderBin:process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot,'target/debug/kcoder'),
    rendererRoot:resolve(appRoot,'renderer/dist'),
  });
  const cmd=(action,id,args={})=>client.command(action,{selector:`[data-testid="${id}"]`,...args});
  const saved=async()=>JSON.parse(await readFile(client.settingsPath,'utf8'));
  try {
    const model=await startWikiModelFixture(context);
    const configuration=await saved();
    await writeFile(client.settingsPath,JSON.stringify({...configuration,active_provider:'wiki-fixture',providers:{'wiki-fixture':{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'wiki-fixture',context_window_tokens:128000,max_output_tokens:8192,output_headroom_tokens:8192,no_proxy:true}}}));
    await cmd('waitFor','knowledge-button');
    await cmd('click','knowledge-button');
    await cmd('waitFor','knowledge-enable',{enabled:true});
    assert.notEqual((await saved()).knowledge?.enabled,true);
    await cmd('click','knowledge-enable');
    await cmd('waitFor','knowledge-create',{enabled:true});
    await waitFor(async()=>(await saved()).knowledge?.enabled===true,5000,'target Wiki enabled');
    // QA: opening/cancelling creates nothing; blank names cannot submit; typed name persists.
    await cmd('click','knowledge-create');
    await cmd('waitFor','wiki-create-input');
    assert.equal(await cmd('getValue','wiki-create-input'),'');
    assert.equal(await cmd('getAttribute','wiki-create-confirm',{value:'disabled'}),'');
    await cmd('press','wiki-create-input',{key:'Escape'});
    await waitFor(async()=>await cmd('getElementCount','wiki-create-dialog')==='0',5000,'create cancelled');
    assert.equal(await cmd('getElementCount','knowledge-library-picker'),'0');
    await cmd('click','knowledge-create');
    await cmd('fill','wiki-create-input',{value:'  产品资料  '});
    await cmd('waitFor','wiki-create-confirm',{enabled:true});
    await cmd('click','wiki-create-confirm');
    await cmd('waitFor','knowledge-library-picker',{text:'产品资料'});
    await cmd('waitFor','knowledge-library-picker');
    await cmd('fill','wiki-import-files',{value:JSON.stringify([{name:'unsupported.exe',text:'not a Wiki document'},{name:'protocol.html',text:'<!doctype html><html><head><title>产品说明</title><script>window.WIKI_SCRIPT_EXECUTED=true</script></head><body><p>产品支持协议 A。</p></body></html>'}])});
    await client.command('waitFor',{selector:'[data-testid^="wiki-page-row-"]',text:'协议兼容性',timeoutMs:20000});
    await client.command('click',{selector:'[data-testid^="wiki-page-row-"][aria-label="协议兼容性"]'});
    await cmd('waitFor','wiki-reader',{text:'产品支持协议 A。'});
    await new Promise(resolve=>setTimeout(resolve,250));
    await cmd('click','wiki-citation-0');
    await cmd('waitFor','wiki-source-preview',{text:'产品支持协议 A。'});
    await new Promise(resolve=>setTimeout(resolve,250));
    await client.capture('wiki-reader.png');
    await cmd('click','wiki-reader-back');
    assert.equal(model.requests.length,2);
    await cmd('fill','wiki-import-files',{value:JSON.stringify([{name:'supplement.md',text:'待审核：产品支持协议 A，部署条件需要确认。'}])});
    await cmd('waitFor','wiki-review-open',{enabled:true,timeoutMs:20000});
    await cmd('click','wiki-review-open');
    await cmd('waitFor','wiki-review-proposed',{text:'产品支持协议 A。'});
    await client.capture('wiki-review.png');
    await cmd('click','wiki-review-accept');
    await waitFor(async()=>await cmd('getElementCount','wiki-review-dialog')==='0',5000,'Wiki review closes after persisted approval');
    await client.command('waitFor',{selector:'#wiki-content-panel',text:'补充协议',timeoutMs:10000});
    assert.equal(model.requests.length,4);
    await cmd('fill','wiki-import-files',{value:JSON.stringify([{name:'rejected.md',text:'待审核：另一份资料的适用条件尚未核实。'}])});
    await cmd('waitFor','wiki-review-open',{enabled:true,timeoutMs:20000});
    await cmd('click','wiki-review-open');
    await cmd('waitFor','wiki-review-proposed');
    await cmd('click','wiki-review-reject');
    await waitFor(async()=>await cmd('getElementCount','wiki-review-open')==='0',10000,'rejected review leaves no pending action');
    assert.equal(await client.command('getElementCount',{selector:'[data-testid^="wiki-page-row-"]'}),'5');
    assert.equal(model.requests.length,6);
    await client.command('click',{selector:'[data-testid^="wiki-page-row-"][aria-label="协议兼容性"]'});
    await cmd('waitFor','wiki-reader-edit',{enabled:true});
    await cmd('click','wiki-reader-edit');
    await cmd('fill','wiki-edit-body',{value:'# 协议兼容性\n\n产品支持协议 A。\n\n这是人工补充的验收备注。'});
    await cmd('click','wiki-edit-save');
    await cmd('waitFor','wiki-reader',{text:'人工补充的验收备注'});
    await cmd('click','wiki-reader-history');
    await cmd('waitFor','wiki-history-version-1');
    await cmd('click','wiki-history-version-1');
    await cmd('waitFor','wiki-history-restore',{enabled:true});
    await cmd('click','wiki-history-restore');
    await cmd('waitFor','wiki-reader',{text:'产品支持协议 A。'});
    await client.capture('wiki-restored.png');
    await cmd('click','wiki-reader-back');
    await client.command('click',{selector:'summary[aria-label="管理 Wiki"]'});
    await cmd('click','wiki-rename');
    await cmd('fill','wiki-rename-input',{value:'产品知识'});
    await cmd('click','wiki-rename-save');
    await cmd('waitFor','knowledge-library-picker',{text:'产品知识'});
    await cmd('click','knowledge-retrieval-enabled');
    await waitFor(async()=>await cmd('getAttribute','knowledge-retrieval-enabled',{value:'aria-checked'})==='false',5000,'retrieval off independently');
    assert.equal(await cmd('getAttribute','knowledge-organization-enabled',{value:'aria-checked'}),'true');
    await cmd('waitFor','wiki-import-text',{enabled:true});
    assert.equal(await cmd('getElementCount','wiki-search'),'0');
    await cmd('click','knowledge-retrieval-enabled');
    await cmd('waitFor','wiki-search');




    const directory=resolve(client.runRoot,'wiki-selected-directory');
    await mkdir(directory,{recursive:true});
    await writeFile(resolve(directory,'folder.md'),'目录中的合成资料：产品支持协议 A。');
    await cmd('click','wiki-import-directory');
    await cmd('fill','device-folder-path-input',{value:directory});
    await cmd('press','device-folder-path-input',{key:'Enter'});
    assert.equal(await cmd('getValue','device-folder-path-input'),directory);
    await cmd('waitFor','confirm-device-folder-picker-button',{enabled:true});
    await cmd('click','confirm-device-folder-picker-button');
    await cmd('waitFor','wiki-directory-confirm',{enabled:true});
    await client.capture('wiki-directory-preview.png');
    await cmd('click','wiki-directory-confirm');
    await client.command('waitFor',{selector:'#wiki-content-panel',text:'folder.md',timeoutMs:20000});
    assert.equal(model.requests.length,8);

    await cmd('waitFor','knowledge-organization-enabled',{enabled:true});
    await cmd('waitFor','knowledge-tab-pages');
    await cmd('click','knowledge-tab-sources');
    assert.equal(await cmd('getAttribute','knowledge-tab-sources',{value:'aria-selected'}),'true');
    await new Promise(resolve=>setTimeout(resolve,250));
    await client.capture('knowledge-sources.png');
    await client.command('click',{selector:'[data-testid^="wiki-source-row-"]'});
    await cmd('waitFor','wiki-original-reader');
    await cmd('waitFor','wiki-original-download',{enabled:true});
    await client.capture('wiki-original-download.png');
    await cmd('waitFor','wiki-original-reader-close',{enabled:true});
    await cmd('click','wiki-original-reader-close');
    await waitFor(async()=>await cmd('getElementCount','wiki-original-reader')==='0',5000,'source reader closes by button');
    await client.command('click',{selector:'[data-testid^="wiki-source-row-"]'});
    await cmd('waitFor','wiki-original-reader-close',{enabled:true});
    await cmd('click','wiki-original-reader-close');
    await waitFor(async()=>await cmd('getElementCount','wiki-original-reader')==='0',5000,'source reader can reopen and close');

    await cmd('click','knowledge-tab-pages');
    await new Promise(resolve=>setTimeout(resolve,250));
    await client.capture('knowledge-enabled.png');
    await cmd('click','knowledge-organization-enabled');
    await cmd('waitFor','knowledge-retrieval-enabled',{enabled:true});
    assert.equal(await cmd('getAttribute','knowledge-retrieval-enabled',{value:'aria-checked'}),'true');
    await cmd('waitFor','wiki-search');
    assert.equal(await cmd('getAttribute','knowledge-create',{value:'disabled'}),'');
    await cmd('click','knowledge-retrieval-enabled');
    await cmd('waitFor','knowledge-enable',{enabled:true});
    await waitFor(async()=>(await saved()).knowledge?.enabled===false,5000,'target Wiki disabled');
    assert.equal(await cmd('getAttribute','knowledge-organization-enabled',{value:'aria-checked'}),'false');
    await new Promise(resolve=>setTimeout(resolve,250));
    await client.capture('knowledge-disabled.png');
    await cmd('click','knowledge-enable');
    await cmd('waitFor','knowledge-library-picker');
    await client.command('navigate',{value:'/'});
    await cmd('click','knowledge-button');
    await cmd('waitFor','knowledge-library-picker');
    await client.command('navigate',{value:'/settings/personal/models'});
    await client.command('waitFor',{selector:'[data-testid="provider-new"]'});
    await client.capture('model-settings-icons.png');
    return {defaultOff:true,targetSettingPersisted:true,libraryPreservedAcrossDisable:true};
  } catch(error) {client.markFailed(); const detail=await client.command('getText',{selector:'[role="alert"]'}).catch(()=>null); if(detail) await writeFile(context.pathInArtifacts('ui-error.txt'),String(detail)); await client.capture('failure.png').catch(()=>{});throw error;}
  finally {const cleanup=await client.stop();assert.equal(cleanup.cleaned,true);}
});
