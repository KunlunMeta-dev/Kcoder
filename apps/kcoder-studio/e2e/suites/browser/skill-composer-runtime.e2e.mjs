import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'kcoder-skills-vendor-independent-dollar-slash-selection', tier: 'full-integration', modelPolicy: 'deterministic local HTTP fixture; no external model' }, async context => {
  const {path:workspace}=await materializeWorkspace(context,'minimal',{instanceId:'skill-composer'});
  const model=await startApprovalModelFixture(context,{textOnly:true,textOnlyResponse:'SKILL_REFERENCE_RECEIVED'});
  const profile=context.pathInState('profile');
  await context.writeStateJson('profile/settings.json',{active_provider:'openai',tools:{disabled:['*']},providers:{openai:{api_format:'openai_chat_completions',authentication:{mode:'none'},endpoint:model.baseUrl,default_model:'DeepSeek-V4.1-Flash',context_window_tokens:64000,max_output_tokens:1024,output_headroom_tokens:1024}}});
  const skill=resolve(profile,'skills/composer-fixture/SKILL.md');await mkdir(resolve(profile,'skills/composer-fixture'),{recursive:true});await writeFile(skill,'---\nname: composer-fixture\ndescription: Owned composer skill fixture\n---\nExplain the selected task.\n');
  const binary=process.env.KCODER_E2E_KCODER_BIN||resolve(repoRoot,'target/debug/kcoder');
  const gateway=await startGateway(context,{workspace,kcoderBin:binary,env:{KCODER_CONFIG_DIR:profile}});await waitForGatewayRpcToken(context,gateway);
  const browser=await startChromium(context);const page=await browser.newPage({viewport:{width:1280,height:900}});
  try {
    await page.goto(gateway.baseUrl);const input=page.getByTestId('chat-message-input');
    for(const prefix of ['$','/']) {
      await input.fill(prefix+'composer-fixture');const option=page.getByTestId(prefix==='$'?'local-skill-option-composer-fixture':'slash-command-option-skill-composer-fixture');await option.waitFor();assert.equal(await option.isEnabled(),true);
      if(prefix==='$') await option.click();else await input.press('Enter');
      await page.getByTestId('local-skill-chip-composer-fixture').waitFor();
      await page.screenshot({path:context.pathInArtifacts(prefix==='$'?'dollar-click.png':'slash-keyboard.png')});
      if(prefix==='$') await input.fill('');
    }
    await page.getByTestId('send-message-button').click();
    await waitFor(()=>model.requests.length>0,15000,'skill reference reaches model request');
    assert.ok(JSON.stringify(model.requests[0].messages).includes('composer-fixture'));
    assert.ok(JSON.stringify(model.requests[0].messages).includes(skill));
    await page.getByText('SKILL_REFERENCE_RECEIVED',{exact:true}).waitFor({timeout:15000});
    await context.writeArtifactJson('skill-composer-result.json',{provider:'openai',model:'DeepSeek-V4.1-Flash',dollarClick:true,slashKeyboard:true,referenceReachedHttp:true,requests:model.requests.length});
  } catch(error) {await page.screenshot({path:context.pathInArtifacts('failure.png')});throw error;}
});
