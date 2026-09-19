import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium as playwrightChromium } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { appRoot, repoRoot, runE2E, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
// QA: real UI -> Gateway -> Rust mode dispatch and persisted goal lifecycle.
// Fixed provider replies isolate protocol/state from model planning quality.
await runE2E(import.meta.url, {
  testId: 'execution-modes-and-goal-audit', tier: 'full-integration',
  modelPolicy: 'model-independent typed dispatch, lifecycle, and rendering', retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'execution-modes' });
  const profile = context.pathInState('profile');
  await mkdir(profile);
  let audited = false;
  let plannerCalls = 0;
  let synthesisCalls = 0;
  let advisoryCalls = 0;
  const text = content => [{ delta: { role: 'assistant', content } }, { finishReason: 'stop' }];
  const call = (name, args) => [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: `mode-${Date.now()}-${Math.random().toString(36).slice(2)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }, { finishReason: 'tool_calls' }];
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    const tools = (body.tools ?? []).map(tool => tool.function?.name);
    if (tools.includes('SubmitMoaDraft') && JSON.stringify(body.messages).includes('MODE_CANCEL_PLAN')) return [{ready:()=>false,delta:{content:'must never finish'}}];
    if ((tools.includes('SubmitMoaDraft') || tools.includes('SubmitMoaFinal')) && body.messages.some(message => message.role === 'tool')) return text('MODE_SUBMISSION_RECORDED');
    if (tools.includes('SubmitMoaDraft')) { plannerCalls += 1; return call('SubmitMoaDraft', { content: '# Draft\nMODE_PLAN_DRAFT\nInspect, implement, and verify.' }); }
    if (tools.includes('SubmitMoaFinal')) { synthesisCalls += 1; return call('SubmitMoaFinal', { content: '# Final plan\nMODE_PLAN_FINAL\n1. Inspect.\n2. Implement.\n3. Verify.' }); }
    const messages = JSON.stringify(body.messages);
    if (messages.includes('concise private guidance for the acting assistant')) { advisoryCalls += 1; return text('MODE_PRIVATE_ADVICE'); }
    if (messages.includes('MODE_GOAL_AUDIT') && messages.includes('[system] Continue working toward the active') && !audited) {
      audited = true;
      assert.ok(tools.includes('update_goal'));
      return call('update_goal', { status: 'complete' });
    }
    return text('MODE_REPLY');
  }});
  const settingsFile = await context.writeStateJson('profile/settings.json', {
    active_provider: 'fixture', goal_max_auto_continuations: 2,
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl, default_model: 'acting', context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 8192, no_proxy: true, max_retries: 0 } },
    moa: { enabled: true, default_preset: 'protocol-test', max_reference_workers: 2, presets: { 'protocol-test': { enabled: true, reference_models: [{ provider: 'fixture', model: 'reference' }], aggregator: { provider: 'fixture', model: 'acting' }, reference_max_tokens: 512, aggregator_max_tokens: 512 } } },
    moa_plan: { enabled: true, preset: 'protocol-test', draft_max_turns: 3, draft_max_tokens: 512, synthesis_max_tokens: 512, draft_timeout_secs: 30, max_planner_workers: 2 },
  });
  await context.writeStateJson('profile/credentials.json', { fixture: { type: 'api', key: 'synthetic-mode-fixture' } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Modes fixture', transport: 'local', command: resolve(repoRoot, 'target/debug/kcoder'), workspace, settingsFile }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const rpc = (method, params = {}) => page.evaluate(({method,params}) => window.__TAURI_INTERNALS__.invoke('local_executor_request', {method,params}), {method,params});
  const editor = page.getByTestId('chat-message-input');
  const assertModeFooter = async (currentPage, mode) => {
    await currentPage.getByTestId('execution-mode-footer').filter({ hasText: mode }).waitFor();
    const geometry = await currentPage.evaluate(() => {
      const footer = document.querySelector('[data-testid="execution-mode-footer"]');
      const composer = document.querySelector('[data-testid="project-chat-composer"]');
      const quickPhrase = composer.querySelector('[data-testid="quick-phrase-button"]');
      const box = footer.getBoundingClientRect();
      const inputBox = composer.getBoundingClientRect();
      const phraseBox = quickPhrase.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right,
        composerTop: inputBox.top, composerBottom: inputBox.bottom,
        composerLeft: inputBox.left, composerRight: inputBox.right,
        phraseTop: phraseBox.top, phraseBottom: phraseBox.bottom,
        inside: composer.contains(footer),
        viewport: innerHeight, position: getComputedStyle(footer).position };
    });
    assert.ok(geometry.inside, `${mode} must be inside the composer`);
    assert.ok(geometry.top >= geometry.composerTop && geometry.bottom <= geometry.composerBottom,
      `${mode} must fit vertically inside the composer`);
    assert.ok(geometry.left >= geometry.composerLeft && geometry.right <= geometry.composerRight,
      `${mode} must fit horizontally inside the composer`);
    assert.ok(Math.min(geometry.bottom, geometry.phraseBottom) > Math.max(geometry.top, geometry.phraseTop),
      `${mode} must share the quick-phrase toolbar row`);
    assert.ok(geometry.bottom <= geometry.viewport, `${mode} must fit in the visible pane`);
    assert.ok(!['absolute', 'fixed'].includes(geometry.position), `${mode} must occupy normal layout space`);
  };
  const input = async value => { await editor.click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText(value); };
  const newChat = async () => {
    const project = page.getByTestId('project-item').filter({hasText:'Modes fixture'}).first();
    await project.waitFor({timeout:30000});
    await project.getByTestId('project-new-conversation-button').click();
    await editor.waitFor();
  };
  const settle = async marker => {
    await page.getByTestId('message-assistant').filter({hasText:marker}).last().waitFor({timeout:45000});
    await page.waitForFunction(() => !document.querySelector('[data-testid="pause-response-button"]'), undefined, {timeout:45000});
  };
  const address = () => ({deviceId:'local', workspacePath:workspace, taskId:new URL(page.url()).searchParams.get('taskId')});
  let stage = 'login';
  try {
    await page.goto(gateway.baseUrl);
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.getByTestId('desktop-sidebar').waitFor({timeout:30000});
    await newChat();
    stage = 'menu';
    await input('/');
    for (const mode of ['goal','goal-pro','orchestrate','moa','moa-plan']) await page.getByTestId(`slash-command-option-${mode}`).waitFor();
    assert.equal(await page.getByTestId('slash-command-option-ultgoal').count(), 0);
    await input('/orches'); await page.keyboard.press('Tab');
    assert.equal((await editor.innerText()).trim(), '/orchestrate');
    await page.keyboard.press('Enter');
    await page.getByTestId('execution-mode-draft').waitFor();
    await assertModeFooter(page, '/orchestrate');
    await page.setViewportSize({ width: 1100, height: 800 });
    await assertModeFooter(page, '/orchestrate');
    await page.setViewportSize({ width: 1440, height: 960 });
    stage = 'orchestrate';
    await input('MODE_ORCHESTRATE'); await page.getByTestId('send-message-button').click(); await settle('MODE_REPLY');
    const orchestrateAddress = address();
    assert.equal((await rpc('runtime.session.modes', {address:orchestrateAddress})).sessionMode, 'orchestrate');
    await page.reload(); await settle('MODE_REPLY');
    await page.getByTestId('execution-mode-draft').filter({hasText:'/orchestrate'}).waitFor({timeout:30000});
    await assertModeFooter(page, '/orchestrate');
    await input('/');
    await page.getByTestId('slash-command-menu').waitFor();
    assert.equal(await page.getByTestId('slash-command-option-orchestrate').count(), 0);
    stage = 'moa';
    await newChat(); await input('/moa MODE_MOA'); await page.keyboard.press('Enter');
    assert.equal((await editor.innerText()).trim(), 'MODE_MOA');
    await assertModeFooter(page, '/moa');
    await page.getByTestId('send-message-button').click(); await settle('MODE_REPLY');
    assert.ok(advisoryCalls > 0, 'MoA must invoke the shared advisory flow');
    const adviceBefore = advisoryCalls;
    assert.equal(await page.getByTestId('execution-mode-draft').count(), 0);
    await input('MODE_ORDINARY_AFTER_MOA'); await page.getByTestId('send-message-button').click();
    await page.getByTestId('message-user').filter({hasText:'MODE_ORDINARY_AFTER_MOA'}).waitFor();
    await settle('MODE_REPLY');
    assert.equal(advisoryCalls, adviceBefore, 'One-turn MoA must not leak into the next request');
    stage = 'moa-plan';
    await newChat(); await input('/moa-plan MODE_PLANNING'); await page.keyboard.press('Enter');
    await assertModeFooter(page, '/moa-plan');
    await page.getByTestId('send-message-button').click(); await settle('MODE_PLAN_FINAL');
    assert.ok(plannerCalls >= 2); assert.equal(synthesisCalls, 1);
    assert.equal(await page.getByTestId('message-assistant').filter({hasText:'MODE_PLAN_DRAFT'}).count(), 0);
    assert.ok((await readdir(resolve(workspace,'.kcoder/moa-plans'))).some(name => !name.startsWith('.')));
    stage = 'goal-audit';
    await newChat(); await input('/goal MODE_GOAL_AUDIT'); await page.keyboard.press('Enter');
    await page.getByTestId('send-message-button').click();
    const approval = page.getByTestId('request-user-input-card');
    await approval.waitFor({timeout:30000});
    await approval.getByText('Allow once', {exact:true}).click();
    await approval.waitFor({state:'detached',timeout:30000});
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="message-assistant"]')].filter(node => node.textContent.includes('MODE_REPLY')).length >= 2, undefined, {timeout:45000});
    await settle('MODE_REPLY');
    const goalAddress = address();
    assert.ok(audited, 'An answer without update_goal must trigger a completion audit');
    assert.equal((await rpc('runtime.tasks.goal.get', {address:goalAddress})).goal.status, 'complete');
    await page.getByTestId('goal-status-bar').waitFor({state:'detached',timeout:10000});
    assert.equal(await page.getByTestId('message-user').filter({hasText:'[system] Continue working'}).count(), 0);
    stage = 'cancel-planning';
    await newChat(); await input('/moa-plan MODE_CANCEL_PLAN'); await page.keyboard.press('Enter');
    await page.getByTestId('send-message-button').click();
    await waitFor(() => model.requests.some(body => (body.tools ?? []).some(tool => tool.function?.name === 'SubmitMoaDraft') && JSON.stringify(body.messages).includes('MODE_CANCEL_PLAN')),15000,'planning request',50,context.abortSignal);
    await page.getByTestId('pause-response-button').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="pause-response-button"]'),undefined,{timeout:15000});
    assert.equal((await readdir(resolve(workspace,'.kcoder/moa-plans'))).some(name => name.startsWith('.') && name.endsWith('.tmp')),false,'Cancellation removes unpublished staging directories');
    await input('MODE_AFTER_CANCEL'); await page.getByTestId('send-message-button').click(); await settle('MODE_REPLY');
    let nativeDesktopVerified = false;
    if (process.platform === 'linux') {
      stage = 'electron-remote';
      const electron = await requireExecutable(resolve(appRoot,'node_modules/electron/dist/electron'), 'Electron');
      const xvfb = await requireExecutable('/usr/bin/xvfb-run', 'Xvfb');
      let output = '';
      const child = context.spawnOwned('execution-modes-electron', xvfb, [
        '-a','-s','-screen 0 1440x960x24 -nolisten tcp',electron,...(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),'--disable-gpu',
        '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',resolve(appRoot,'desktop/remote-main.mjs'),
      ], {cwd:appRoot,env:context.isolatedEnvironment({
        KCODER_STUDIO_DESKTOP_USER_DATA_DIR:context.pathInState('electron-profile'),
        KCODER_STUDIO_REMOTE_URL:gateway.baseUrl,KCODER_STUDIO_REMOTE_TOKEN:gateway.authToken,
      })});
      for (const stream of [child.stdout,child.stderr]) stream.on('data', chunk => { output = `${output}${chunk}`.slice(-16000); });
      const cdp = await waitFor(() => {
        if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode})`);
        return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1];
      },30000,'Electron CDP',100,context.abortSignal);
      context.registerPort('electron-cdp',Number(new URL(cdp).port));
      const browser = await playwrightChromium.connectOverCDP(cdp);
      context.addCleanup('disconnect Electron CDP', () => browser.close());
      const nativePage = await waitFor(() => browser.contexts().flatMap(item => item.pages()).find(item => item.url().startsWith(gateway.baseUrl)),30000,'Electron window',100,context.abortSignal);
      await nativePage.getByTestId('desktop-sidebar').waitFor({timeout:30000});
      const nativeProject = nativePage.getByTestId('project-item').filter({hasText:'Modes fixture'}).first();
      await nativeProject.getByTestId('project-new-conversation-button').click();
      const nativeEditor = nativePage.getByTestId('chat-message-input');
      await nativeEditor.click(); await nativePage.keyboard.insertText('/moa-plan NATIVE_MODE_PLAN'); await nativePage.keyboard.press('Enter');
      await nativePage.getByTestId('execution-mode-draft').filter({hasText:'/moa-plan'}).waitFor();
      await assertModeFooter(nativePage, '/moa-plan');
      await nativePage.getByTestId('send-message-button').click();
      await nativePage.getByTestId('message-assistant').filter({hasText:'MODE_PLAN_FINAL'}).waitFor({timeout:45000});
      assert.equal(synthesisCalls, 2);
      nativeDesktopVerified = true;
    }
    assert.deepEqual(errors, []);
    return { orchestrateRestored:true, moaOneTurn:true, plannerCalls, synthesisCalls, goalAuditCompleted:audited, planningCancellationRecovered:true, nativeDesktopVerified };
  } catch (error) {
    await context.writeArtifactJson('failure.json', {stage, errors, plannerCalls, synthesisCalls, advisoryCalls, audited});
    await page.screenshot({path:context.pathInArtifacts('failure.png'),fullPage:true});
    throw error;
  }
});
