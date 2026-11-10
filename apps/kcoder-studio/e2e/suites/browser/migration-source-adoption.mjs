import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, mkdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { holdOwnedExistingFileLease } from '../../harness/owned-file-lease.mjs';

export async function seedAdoptionSourceFixture(fixture) {
  const text=JSON.stringify({model:'received-office-model',env:{ANTHROPIC_BASE_URL:'https://received-office.example.invalid'}})+'\n';
  const file=resolve(fixture.claude,'settings.json');await writeFile(file,text,{mode:0o600});
  const skillDir=resolve(fixture.claude,'skills/received-office-skill'),skillText='---\nname: received-office-skill\ndescription: Review explicitly supplied office material\n---\nPreserve the supplied documents. Do not execute historical commands.\n';
  await mkdir(skillDir,{recursive:true,mode:0o700});await writeFile(resolve(skillDir,'SKILL.md'),skillText,{mode:0o600});
  return{file,text,skillDir,skillText,history:fixture.files.find(item=>item.source==='codex'&&item.compressed)};
}

/** The received capsule creates previews; publication and rollback use the existing ordinary batch UI. */
export async function exerciseSourceAdoption({context,page,gateway,workspace,fixture,destinationProfile,model,directories}) {
  const observer=await openOwnedMobileRpc(context,gateway,'fixture-target',workspace);
  const originalSettings=await readFile(resolve(destinationProfile,'settings.json'));
  const prepared=[],reads=[],transfers=[],opens=[],controls=[];let dropPrepare=true,lost=null;
  const directoryQueries=[];let lostDirectory=null,dropDirectory=!!directories;
  const directoryRoute=async route=>{
    const body=route.request().postDataJSON();
    if(body.query.kind!=='directory_select'||!dropDirectory)return route.continue();
    dropDirectory=false;const response=await route.fetch();assert.equal(response.status(),200);
    lostDirectory=await response.json();await route.abort('failed');
  };
  const onRequest=request=>{
    const url=request.url();if(!url.includes('/api/migration/'))return;
    if(url.endsWith('/source-session/query')&&request.postDataJSON().query.kind==='directory_select')directoryQueries.push(request.postDataJSON());
    if(url.endsWith('/source-session/open'))opens.push(request.postDataJSON());
    if(url.endsWith('/source-transfer/run'))transfers.push(request.postDataJSON());
    if(url.endsWith('/source-transfer/adoption-prepare'))prepared.push(request.postDataJSON());
    if(url.endsWith('/source-transfer/adoption-read'))reads.push(request.postDataJSON());
    if(/\/source-transfer\/adoption-(?:cancel|resume)$/.test(new URL(url).pathname))controls.push({mode:url.split('/').at(-1),...request.postDataJSON()});
  };
  await page.route('**/api/migration/source-transfer/adoption-prepare',async route=>{
    if(!dropPrepare)return route.continue();dropPrepare=false;
    const response=await route.fetch();assert.equal(response.status(),200,'Native preview intent must be accepted before losing its reply');
    lost=await response.json();await route.abort('failed');
  });
  if(directories)await page.route('**/api/migration/source-session/query',directoryRoute);
  page.on('request',onRequest);
  try{
    const dialog=page.getByTestId('migration-dialog');
    await selectAdvancedMigration(dialog, 'source');
    let browser=page.getByTestId('migration-source-browser');
    await browser.locator('#migration-source-device').selectOption('history-source-target');
    if(directories)await chooseSourceDirectory(browser,directories.claude);
    await browser.getByRole('button',{name:'查找可迁移内容',exact:true}).click();
    if(directories){
      await waitFor(()=>lostDirectory,15000,'accepted explicit directory acknowledgement deliberately lost');
      const find=browser.getByRole('button',{name:'查找可迁移内容',exact:true});
      await waitFor(async()=>!await find.isDisabled(),10000,'unknown directory selection must settle without default discovery');
      assert.equal(await browser.getByRole('checkbox',{name:/Claude Code.*用户配置/}).count(),0);
      await find.click();
    }
    const config=browser.getByRole('checkbox',{name:/Claude Code.*用户配置/});await config.waitFor();
    await config.check();
    await browser.getByRole('button',{name:'传输所选资料（1）',exact:true}).click();
    await browser.getByTestId('migration-transfer-status').getByText('资料已接收',{exact:true}).waitFor({timeout:30000});
    assert.equal(transfers.length,1);
    // The first publish now depends on the target-owned capsule, not the old source path.
    await rename(fixture.file,resolve(fixture.file,'../settings-withheld.json'));
    let panel=browser.getByTestId('migration-source-adoption');
    await panel.getByTestId('migration-adoption-expand').click();
    await panel.getByTestId('migration-adoption-received-row').waitFor();
    assert.equal(await panel.getByTestId('migration-adoption-received-row').count(),1);
    await panel.getByRole('checkbox').first().check();
    await panel.getByTestId('migration-adoption-prepare').click();
    await waitFor(()=>lost,15000,'owned lost adoption prepare response');
    await panel.getByText('保留了原始意图，尚未观察到原生结果',{exact:true}).waitFor();
    assert.equal(prepared.length,1);const originalAdoption=prepared[0].locator.adoptionId;
    assert.deepEqual(await readFile(resolve(destinationProfile,'settings.json')),originalSettings,'preparing a preview cannot publish settings');
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByTestId('general-external-content-import-button').click();
    await page.locator('#migration-target').selectOption('fixture-target');
    await selectAdvancedMigration(page, 'source');
    browser=page.getByTestId('migration-source-browser');
    assert.equal(await browser.locator('#migration-source-device').inputValue(),'','recovery cannot select or reopen a source');
    const records=browser.getByTestId('migration-transfer-records');await records.locator('summary').click();
    await records.getByRole('button',{name:'刷新',exact:true}).click();
    await records.getByRole('button',{name:'查询目标回执',exact:true}).click();
    await records.getByTestId('migration-recovered-transfer').getByText('资料已接收',{exact:true}).waitFor();
    panel=records.getByTestId('migration-source-adoption');await panel.getByTestId('migration-adoption-expand').click();
    const intents=panel.getByTestId('migration-adoption-records');await intents.locator('summary').click();
    await intents.getByRole('button',{name:'读取原任务状态',exact:true}).click();
    await waitFor(()=>reads.some(item=>item.locator?.adoptionId===originalAdoption||item.adoptionId===originalAdoption),10000,'read only the original adoption identity');
    const ready=panel.getByText('预览就绪，尚未保存',{exact:true});
    const resume=panel.getByTestId('migration-adoption-resume');
    await waitFor(async()=>await ready.count()>0||await resume.count()>0,15000,'original preparation state or explicit resume');
    if(!await ready.count()){
      await resume.click();await panel.getByTestId('migration-adoption-confirm-input').fill('RESUME');await panel.getByTestId('migration-adoption-confirm-submit').click();
    }
    await ready.waitFor({timeout:30000});
    assert.equal(prepared.length,1,'reopening a lost prepare receipt cannot create another intent');
    assert.deepEqual(await readFile(resolve(destinationProfile,'settings.json')),originalSettings);
    const open=panel.locator('[data-testid^="migration-adoption-open-"]').first();
    const jobId=(await open.getAttribute('data-testid')).slice('migration-adoption-open-'.length);
    await open.click();
    await page.getByRole('heading',{name:'选择迁移内容',exact:true}).waitFor();
    const items=await observer.rpc.request('migration/items',{jobId});
    assert.equal(items.providers.length,1);const providerItem=items.items.find(item=>item.id===items.providers[0].itemId);
    const row=page.getByTestId('migration-content-item').filter({has:page.getByRole('checkbox',{name:`选择 ${providerItem.sourceName}`,exact:true})});
    await row.getByRole('button',{name:'配置',exact:true}).click();
    await row.getByLabel('保存后的连接名称',{exact:true}).fill('ReceivedOffice');
    await row.getByLabel('上下文额度',{exact:true}).fill('128000');
    await row.getByLabel('输出预留额度',{exact:true}).fill('8192');
    await row.getByLabel('最大输出额度',{exact:true}).fill('8192');
    await row.getByRole('button',{name:'保存选项并选择',exact:true}).click();
    await page.getByRole('button',{name:'确认所选内容',exact:true}).click();
    await page.getByRole('heading',{name:'确认批量计划',exact:true}).waitFor();
    assert.deepEqual(await readFile(resolve(destinationProfile,'settings.json')),originalSettings);
    await page.getByRole('button',{name:'开始批量迁移',exact:true}).click();
    await page.getByRole('heading',{name:'迁移结果',exact:true}).waitFor({timeout:30000});
    await waitFor(async()=>JSON.parse(await readFile(resolve(destinationProfile,'settings.json'),'utf8')).providers.ReceivedOffice,10000,'ordinary batch saves the received configuration');
    let settings=JSON.parse(await readFile(resolve(destinationProfile,'settings.json'),'utf8'));
    assert.equal(settings.active_provider,JSON.parse(originalSettings.toString()).active_provider);
    assert.equal(settings.providers.ReceivedOffice.default_model,'received-office-model');
    await page.getByTestId('migration-dialog').getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByTestId('general-external-content-import-button').click();await page.locator('#migration-target').selectOption('fixture-target');
    await page.getByRole('button',{name:'迁移记录',exact:true}).click();
    await page.getByRole('button').filter({hasText:/Claude Code · .*已迁入 1 \/ 1 项/}).first().click();
    await page.getByRole('button',{name:'撤销本次导入',exact:true}).click();
    await page.getByText('本次新增内容已撤销',{exact:true}).waitFor({timeout:30000});
    settings=JSON.parse(await readFile(resolve(destinationProfile,'settings.json'),'utf8'));
    assert.deepEqual(settings,JSON.parse(originalSettings.toString()));
    assert.equal(await readFile(resolve(fixture.file,'../settings-withheld.json'),'utf8'),fixture.text);
    assert.equal(model.requests.length,0);assert.equal(transfers.length,1);assert.equal(prepared.length,1);
    await context.writeArtifactJson('source-adoption-configuration-roundtrip.json',{passed:true,requestId:transfers[0].requestId,adoptionId:originalAdoption,jobId,
      lostPrepareReply:true,preparedCount:prepared.length,transferredCount:transfers.length,originalIntentReadOnlyRecovery:true,
      sourceWithheldAfterReceiving:true,previewDidNotPublish:true,ordinaryBatchConfirmedSaved:true,reopenedAndOrdinaryUndo:true,
      targetSettingsRestored:true,modelRequests:0,scope:'Actual Browser/Gateway/two isolated Native profiles; not real remote OS/native desktop/installer.'});
    const consumers=await exerciseAdditionalAdoptionConsumers({context,page,observer:observer.rpc,fixture,destinationProfile,model,directories});
    const assetControl=controls.filter(item=>item.locator.adoptionId===prepared[1].locator.adoptionId);
    assert.deepEqual(assetControl.map(item=>item.mode),['adoption-cancel','adoption-resume']);
    assert.ok(assetControl.every(item=>item.locator.requestId===prepared[1].locator.requestId));
    assert.ok(assetControl[1].expectedControl.cancelWatermark>0,'resume must acknowledge the original cancellation watermark');
    assert.equal(prepared.length,3);assert.equal(transfers.length,3);
    await context.writeArtifactJson('source-adoption-stable-controls.json',{passed:true,adoptionIds:prepared.map(item=>item.locator.adoptionId),
      assetControlModes:assetControl.map(item=>item.mode),assetAdoptionId:prepared[1].locator.adoptionId,
      resumeControl:assetControl[1].expectedControl,prepareCount:prepared.length,transferCount:transfers.length,modelRequests:0});
    if(directories){
      assert.equal(directoryQueries.length,4);assert.deepEqual(directoryQueries[1],directoryQueries[0],'lost directory reply must reuse the original child and selection ID');
      assert.equal(directoryQueries[2].query.params.directory,directories.claude);
      assert.equal(directoryQueries[3].query.params.directory,directories.codex);
      await context.writeArtifactJson('source-directory-adoption-roundtrip.json',{passed:true,nonDefaultProductDirectories:true,
        lostSelectReplyReconciled:true,originalSelectionId:directoryQueries[0].query.params.selectionId,directorySelectRequests:4,
        discoveryModes:['configuration','assets','history'],normalBatchSavedReopenedAndUndone:true,sourceAndUserSettingsPreserved:true,modelRequests:0});
    }
    await page.screenshot({path:context.pathInArtifacts('received-config-normal-batch-undone.png')});
    return{receivedConfigurationAdopted:true,normalBatchUndo:true,...consumers,modelRequests:0};
  }finally{page.off('request',onRequest);if(directories)await page.unroute('**/api/migration/source-session/query',directoryRoute);await page.unroute('**/api/migration/source-transfer/adoption-prepare');await observer.close();}
}

async function chooseSourceDirectory(browser,directory){
  await browser.getByTestId('migration-source-directory-explicit').check();
  await browser.getByTestId('migration-source-directory-path').fill(directory);
}

async function exerciseAdditionalAdoptionConsumers({context,page,observer,fixture,destinationProfile,model,directories}) {
  const results=[];
  for(const kind of ['asset','history']){
    const dialog=page.getByTestId('migration-dialog');await selectAdvancedMigration(dialog, 'source');
    const browser=page.getByTestId('migration-source-browser');await browser.locator('#migration-source-device').selectOption('history-source-target');
    if(kind==='asset'){
      if(directories)await chooseSourceDirectory(browser,directories.claude);
      await browser.getByRole('button',{name:'查找可迁移内容',exact:true}).click();
      await browser.getByRole('checkbox',{name:/Claude Code.*用户技能/}).check();
      await browser.getByRole('button',{name:'传输所选资料（1）',exact:true}).click();
    }else{
      await browser.getByTestId('migration-source-mode-history').click();const source=browser.getByTestId('migration-history-source-browser');
      await source.getByRole('button',{name:'Codex',exact:true}).click();
      if(directories)await chooseSourceDirectory(source,directories.codex);
      await source.getByTestId('migration-history-source-discover').click();
      await waitFor(async()=>await source.getByTestId('migration-history-source-row').count()===10,15000,'ten original history sources');
      await source.getByTestId('migration-history-source-next').click();
      await source.getByRole('checkbox',{name:fixture.history.title,exact:true}).check();
      await source.getByTestId('migration-history-source-transfer').click();
    }
    await browser.getByTestId('migration-transfer-status').getByText('资料已接收',{exact:true}).waitFor({timeout:30000});
    if(kind==='asset')await rename(fixture.skillDir,resolve(fixture.skillDir,'../received-skill-withheld'));
    else await rename(fixture.history.file,resolve(fixture.history.file,'../history-withheld.bin'));
    const panel=browser.getByTestId('migration-source-adoption');await panel.getByTestId('migration-adoption-expand').click();
    await panel.getByTestId('migration-adoption-received-row').waitFor();
    assert.equal(await panel.getByTestId('migration-adoption-received-row').count(),1);
    if(kind==='history'){
      await panel.getByText('历史中的项目仅保留为出处，不将其路径映射到目标。',{exact:true}).waitFor();
      assert.equal(await panel.locator('[data-testid^="migration-adoption-map-"]').count(),0);
    }
    await panel.getByRole('checkbox').first().check();
    if(kind==='asset'){
      // A peer holds this run's existing journal lease. Preview control stays independent.
      const release=await holdOwnedExistingFileLease(context,resolve(destinationProfile,'migrations/.lock'),'owned-adoption-journal-contention');
      try{
        const response=page.waitForResponse(value=>value.url().endsWith('/api/migration/source-transfer/adoption-prepare'));
        await panel.getByTestId('migration-adoption-prepare').click();await response;
        await new Promise(resolve=>setTimeout(resolve,200));
      }finally{await release();}
      await panel.getByTestId('migration-adoption-read').click();
      await panel.getByTestId('migration-adoption-cancel').waitFor();
      await panel.getByTestId('migration-adoption-cancel').click();
      assert.equal(await panel.getByTestId('migration-adoption-confirm-submit').isDisabled(),true);
      await panel.getByTestId('migration-adoption-confirm-input').fill('CANCEL');await panel.getByTestId('migration-adoption-confirm-submit').click();
      await panel.getByText('预览准备已停止，接收资料继续保留',{exact:true}).waitFor();
      await panel.getByTestId('migration-adoption-resume').click();await panel.getByTestId('migration-adoption-confirm-input').fill('RESUME');await panel.getByTestId('migration-adoption-confirm-submit').click();
    }else await panel.getByTestId('migration-adoption-prepare').click();
    await panel.getByText('预览就绪，尚未保存',{exact:true}).waitFor({timeout:30000});
    const button=panel.locator('[data-testid^="migration-adoption-open-"]').first();
    const jobId=(await button.getAttribute('data-testid')).slice('migration-adoption-open-'.length);
    await button.click();await dialog.getByRole('heading',{name:'选择迁移内容',exact:true}).waitFor();
    const pageItems=await observer.request('migration/items',{jobId});assert.equal(pageItems.items.length,1);
    const item=pageItems.items[0],selector=dialog.getByRole('checkbox',{name:`选择 ${item.sourceName}`,exact:true});
    await selector.check();
    await dialog.getByRole('button',{name:'确认所选内容',exact:true}).click();
    await dialog.getByRole('heading',{name:'确认批量计划',exact:true}).waitFor();
    const planned=await observer.request('migration/batch/item/plan',{jobId,itemId:item.id});
    const targetName=kind==='asset'?planned.item.targetName:null;
    if(kind==='asset'){
      assert.match(targetName,/^[a-z0-9][a-z0-9_.-]{0,63}$/);
      assert.equal(planned.item.enabled,false);
      assert.equal(await access(resolve(destinationProfile,'skills',targetName,'SKILL.md')).then(()=>true,()=>false),false,'preview cannot publish a skill');
    }
    await dialog.getByRole('button',{name:'开始批量迁移',exact:true}).click();
    await dialog.getByRole('heading',{name:'迁移结果',exact:true}).waitFor({timeout:30000});
    const completed=await observer.request('migration/batch/read',{jobId});
    assert.equal(completed.state.job.status,kind==='history'?'completed_with_issues':'completed');
    assert.equal(completed.state.job.committedItems,1);assert.equal(completed.state.job.hasUnconfirmedOutcomes,false);
    if(kind==='history'){
      const checked=await observer.request('migration/items',{jobId});assert.equal(checked.items[0].status,'committed');
      assert.deepEqual(checked.items[0].issues,[{code:'requires_review',severity:'warning',phase:'activation'}]);
    }
    let child=null;
    if(kind==='asset'){
      const installed=await readFile(resolve(destinationProfile,'skills',targetName,'SKILL.md'),'utf8');
      assert.ok(installed.endsWith(fixture.skillText.split('---\n')[2]),'Native adaptation must preserve the source body');
      assert.ok(installed.includes('default_enabled: false'),'Native activation remains disabled');
    }else{
      const detail=await observer.request('migration/batch/item/plan',{jobId,itemId:item.id});child=detail.item.historyJobId;assert.ok(child);
      const archived=await observer.request('migration/history/read',{jobId:child});assert.equal(archived.job.archived,true);assert.equal(archived.job.stage,'normalized');
      assert.ok(archived.job.normalization.normalizedRecords>0);
      assert.ok(archived.job.normalization.recordsWithDiagnostics>0,'incomplete historical tool data retains its Native warning');
    }
    // Use the ordinary rollback control. No adoption-specific writer can delete installed output.
    await dialog.getByRole('button',{name:'撤销本次导入',exact:true}).click();
    await dialog.getByText('本次新增内容已撤销',{exact:true}).waitFor({timeout:30000});
    assert.equal((await observer.request('migration/batch/read',{jobId})).state.job.status,'rolled_back');
    if(kind==='asset'){
      assert.equal(await access(resolve(destinationProfile,'skills',targetName)).then(()=>true,()=>false),false);
      assert.equal(await readFile(resolve(fixture.skillDir,'../received-skill-withheld/SKILL.md'),'utf8'),fixture.skillText);
    }else{
      assert.deepEqual(await readFile(resolve(fixture.history.file,'../history-withheld.bin')),fixture.history.bytes);
      const archived=await observer.request('migration/history/read',{jobId:child});assert.equal(archived.job.archived,true,'original import facts remain in audit');
    }
    results.push({kind,jobId,targetName,childJobId:child,receivedAndPreviewDidNotPublish:true,sourceWithheldBeforePreparing:true,
      normalBatchSavedAndUndone:true,explicitCancelAndResumeAfterOwnedContention:kind==='asset',historyProjectOnlyProvenance:kind==='history',
      historicalDiagnosticsRetained:kind==='history',sourceBytesPreserved:true});
  }
  assert.equal(model.requests.length,0);await context.writeArtifactJson('source-adoption-additional-consumers.json',{passed:true,results,modelRequests:0});
  return{receivedAssetAdopted:true,receivedHistoryAdopted:true};
}
