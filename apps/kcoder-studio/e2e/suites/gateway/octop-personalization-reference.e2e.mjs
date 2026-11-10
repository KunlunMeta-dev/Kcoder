import assert from 'node:assert/strict';
import { startOctopReference } from '../../harness/octop-reference.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { runE2E } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url,{testId:'octop-personalization-isolated-source-reference',tier:'manual-live',modelPolicy:'Original H20 source in an isolated account/profile; no production mutations, credentials, channels or models.'},async context=>{
  const reference=await startOctopReference(context);
  const browser=await startChromium(context);
  const page=await browser.newPage({viewport:process.env.KCODER_E2E_OCTOP_CHAT_REFERENCE === '1' ? {width:1650,height:968} : {width:1365,height:960},locale:'zh-CN'});
  await page.addInitScript(({token})=>{localStorage.setItem('auth_token',token);localStorage.setItem('i18nextLng','zh');localStorage.setItem('theme','light');localStorage.setItem('octop:theme','light')},{token:reference.token});
  if (process.env.KCODER_E2E_OCTOP_CHAT_REFERENCE === '1') {
    const unusedKey = 'owned-reference-no-external-service'; context.registerSecret(unusedKey);
    await reference.post('/admin/providers', {name:'owned-reference',kind:'openai',base_url:'http://127.0.0.1:1/v1',api_key:unusedKey,models:[{id:'owned-model',name:'Owned model'}]});
    const agent = await reference.post('/agents', {default_model:'owned-reference/owned-model',name: 'Owned original task expert', description: 'Original task protocol', system_prompt: 'Owned visual reference; no execution', icon_name: 'bot'});
    assert.ok(agent.agent_id);
    await page.goto(`${reference.baseUrl}/chat/${encodeURIComponent(agent.agent_id)}`);
    await page.getByPlaceholder(/搜索专家或会话/).waitFor({timeout:15000}).catch(async error => { await page.screenshot({path:context.pathInArtifacts('octop-chat-reference-failure.png')}); await context.writeArtifactJson('octop-chat-reference-failure.json',{url:page.url(),body:(await page.locator('body').innerText()).slice(0,8000)}); throw error; });
    await page.screenshot({path:context.pathInArtifacts('octop-expert-conversation-reference.png')});
    await context.writeArtifactJson('octop-expert-conversation-reference.json', {revision:reference.revision, isolatedAccount:true, productionMutated:false, modelCalls:0, geometry:await page.locator('[class*="chatInput"]').first().boundingBox()});
    return {sourceRevision:reference.revision, originalChatReference:true, modelCalls:0};
  }
  await page.goto(`${reference.baseUrl}/personalization/skills`);
  await page.getByRole('tab',{name:'已安装技能',exact:true}).waitFor({timeout:30000});
  await page.getByText('暂无技能',{exact:true}).waitFor({timeout:30000});
  const root=page.locator('[class*="skillsTabs"]').first();
  await root.screenshot({path:context.pathInArtifacts('octop-personalization-skills-empty.png'),animations:'disabled'});
  await page.screenshot({path:context.pathInArtifacts('octop-personalization-page.png')});
  const dimensions={empty:await root.boundingBox()};
  await page.getByRole('button',{name:'创建技能',exact:true}).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').screenshot({path:context.pathInArtifacts('octop-create-skill.png'),animations:'disabled'});
  await page.getByRole('dialog').getByRole('button',{name:/^(关闭|Close)$/,exact:true}).first().click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.goto(`${reference.baseUrl}/personalization/channels`);
  await page.locator('[class*="channelsPanel"]').first().waitFor({timeout:30000}).catch(async error=>{await page.screenshot({path:context.pathInArtifacts('reference-channels-failure.png')});await context.writeArtifactJson('reference-channels-failure.json',{url:page.url(),body:(await page.locator('body').innerText()).slice(0,6000)});throw error});
  const channels=page.locator('[class*="channelsPanel"]').first();
  await channels.screenshot({path:context.pathInArtifacts('octop-personalization-channels.png'),animations:'disabled'});
  dimensions.channels=await channels.boundingBox();
  const channelStyles=await channels.evaluate(root=>[root,...root.querySelectorAll('[class]')].slice(0,24).map(el=>({className:String(el.className),font:getComputedStyle(el).font,lineHeight:getComputedStyle(el).lineHeight,height:el.getBoundingClientRect().height})));
  await context.writeArtifactJson('reference-channel-styles.json',channelStyles);
  await context.writeArtifactJson('reference-proof.json',{sourceRevision:reference.revision,indexSha256:reference.indexSha256,isolatedAccount:true,productionMutated:false,modelCalls:0,dimensions});
  assert.ok(dimensions.empty.width>500);
  return {sourceRevision:reference.revision,modelCalls:0};
});
