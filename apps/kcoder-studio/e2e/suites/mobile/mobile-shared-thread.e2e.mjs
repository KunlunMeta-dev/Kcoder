import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { startMobileDevelopmentServer } from '../../harness/mobile-development-server.mjs';
import { captureMobileExportSourceSnapshot } from '../../harness/mobile-export-source-snapshot.mjs';
import { materializeOwnedDependencies } from '../../harness/owned-dependencies.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';

process.umask(0o077);
await runE2E(import.meta.url, { testId: 'mobile-shared-thread', tier: 'full-integration', retainSuccessLogs: true,
  modelPolicy: 'Model-independent multi-device ownership, real Gateway/Rust app-server and two independent Mobile Web profiles; gated loopback provider, no personal sessions or paid inference',
}, async run => {
  const binary = await requireExecutable(resolve(repoRoot, 'target/debug/kcoder'), 'KCoder app-server');
  const snapshotRoot = run.pathInState('source');
  await run.writeArtifactJson('source.json', await captureMobileExportSourceSnapshot({ snapshotRoot, layout: 'preflight-source-root', sourceRoots: [
    { name: 'mobile', path: resolve(repoRoot, 'apps/kcoder-studio/mobile'), destination: 'apps/kcoder-studio/mobile' },
    { name: 'studio-shared', path: resolve(repoRoot, 'apps/kcoder-studio/shared'), destination: 'apps/kcoder-studio/shared' },
  ] }));
  const mobileRoot = resolve(snapshotRoot, 'apps/kcoder-studio/mobile');
  await materializeOwnedDependencies(run, { sourceRoot: resolve(repoRoot, 'apps/kcoder-studio/mobile/node_modules'), destination: resolve(mobileRoot, 'node_modules'), label: 'shared-mobile-dependencies' });
  const metro = await startMobileDevelopmentServer(run, { mobileRoot });
  const workspace = await materializeWorkspace(run, 'minimal', { instanceId: 'shared-thread' });
  const config = run.pathInState('config'); await mkdir(config, { mode: 0o700 }); await run.writeStateJson('config/settings.json', {});
  let release = false;
  const provider = await startApprovalModelFixture(run, { responseSteps: ({ body }) => {
    const prompt = JSON.stringify(body.messages.filter(row => row.role === 'user').at(-1)?.content);
    const latestUser = body.messages.findLastIndex(row => row.role === 'user');
    const hasToolResult = body.messages.slice(latestUser + 1).some(row => row.role === 'tool');
    if (prompt.includes('APPROVAL_ROUND') && !hasToolResult) return [{ delta: { role: 'assistant', tool_calls: [{
      index: 0, id: 'shared-approval-command', type: 'function', function: { name: 'bash',
        arguments: JSON.stringify({ command: "printf 'executed\\n' >> shared-approval-count.txt" }) },
    }] } }, { finishReason: 'tool_calls' }];
    if (prompt.includes('QUESTION_ROUND') && !hasToolResult) return [{ delta: { role: 'assistant', tool_calls: [{
      index: 0, id: 'shared-question', type: 'function', function: { name: 'AskUserQuestion', arguments: JSON.stringify({
        questions: [{ question: 'SHARED_QUESTION_PROMPT', header: 'Choice', options: [{ label: 'YES', description: 'Proceed' }, { label: 'NO', description: 'Stop' }], multi_select: false }],
      }) },
    }] } }, { finishReason: 'tool_calls' }];
    if (prompt.includes('APPROVAL_ROUND')) return [{ delta: { role: 'assistant', content: 'APPROVAL_FINISHED' } }, { finishReason: 'stop' }];
    if (prompt.includes('QUESTION_ROUND')) return [{ delta: { role: 'assistant', content: 'QUESTION_FINISHED' } }, { finishReason: 'stop' }];
    return [{ delta: { role: 'assistant', content: prompt.includes('ROUND_A') ? 'SHARED_PARTIAL_A' : 'SHARED_ANSWER' } },
      ...(prompt.includes('ROUND_A') ? [{ ready: () => release, delta: { content: ' SHARED_FINAL_A' } }] : []), { finishReason: 'stop' }];
  } });
  const settingsFile = await run.writeStateJson('settings.json', { active_provider: 'shared', permission_mode: 'ask', max_retries: 0, providers: {
    shared: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: provider.baseUrl,
      default_model: 'shared-model', context_window_tokens: 128000, max_output_tokens: 128, output_headroom_tokens: 4096,
      request_timeout_secs: 45, no_proxy: true, extra_body: {} },
  } });
  const serversFile = await run.writeStateJson('servers.json', [{ id: 'local', label: 'Shared target', transport: 'local', command: binary, workspace: workspace.path, settingsFile }]);
  const gateway = await startGateway(run, { auth: true, workspace: workspace.path, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: config, KCODER_STUDIO_MOBILE_WEB_ORIGINS: metro.baseUrl } });
  const seed = await openOwnedMobileRpc(run, gateway, 'local', workspace.path);
  const threadId = (await seed.rpc.request('thread/start', { cwd: workspace.path, clientRequestId: randomUUID() })).thread.id;
  await seed.rpc.request('thread/metadata/update', { threadId, title: 'Shared conversation' });
  await seed.rpc.request('turn/start', { threadId, clientMessageId: randomUUID(), input: [{ type: 'text', text: 'SEED_HISTORY' }] });
  await seed.rpc.waitFor(frame => frame.method === 'turn/completed' && frame.params?.threadId === threadId, 45_000, 'seed completion');
  await seed.close();
  const browser = await startChromium(run, { label: 'shared-browser', noSandbox: true });
  const diagnostics = [], pages = [];
  const ui = (page, id) => page.locator(`[data-testid="${id}"]:visible`);
  async function device(width, language, theme) {
    const page = await browser.newPage({ viewport: { width, height: 844 } }); pages.push(page);
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) diagnostics.push(run.redactText(message.text())); });
    page.on('pageerror', error => diagnostics.push(run.redactText(error.message)));
    await page.addInitScript(preferences => {
      if (location.protocol === 'http:' || location.protocol === 'https:')
        localStorage.setItem('kcoder-studio:mobile-app-preferences:v1', JSON.stringify(preferences));
    }, { language, theme, interfaceVersion: 'v3' });
    await page.goto(metro.baseUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await ui(page, 'welcome-direct-connection').click(); await ui(page, 'gateway-endpoint').fill(gateway.baseUrl);
    await ui(page, 'gateway-token').fill(gateway.authToken); await ui(page, 'gateway-connect').click();
    await ui(page, 'home-interface-v3').waitFor({ timeout: 45_000 });
    await ui(page, `thread-${threadId}`).click();
    await waitFor(() => ui(page, 'message-input').isEditable(), 45_000, 'shared conversation connected');
    await page.getByText('SEED_HISTORY', { exact: true }).waitFor();
    return page;
  }
  try {
    const a = await device(390, 'zh-CN', 'light');
    const b = await device(320, 'en', 'dark');
    await ui(a, 'message-input').fill('ROUND_A'); await ui(a, 'send-message').click();
    await b.getByText('SHARED_PARTIAL_A', { exact: false }).first().waitFor({ timeout: 45_000 });
    await b.getByText('ROUND_A', { exact: true }).waitFor({ timeout: 15_000 });
    // Reopening during an active peer turn must succeed without stealing its approval authority.
    await b.reload();
    await waitFor(() => ui(b, 'message-input').isVisible(), 45_000, 'peer rejoins an active turn');
    const competing = await openOwnedMobileRpc(run, gateway, 'local', workspace.path, { experimental: { gatewaySharedThreadsV1: true } });
    await competing.rpc.request('thread/resume', { threadId });
    await assert.rejects(competing.rpc.request('turn/start', { threadId, clientMessageId: randomUUID(), input: [{ type: 'text', text: 'MUST_NOT_EXECUTE' }] }), /Another device is responding/);
    await competing.close();
    release = true;
    await b.getByText('SHARED_FINAL_A', { exact: false }).first().waitFor({ timeout: 45_000 });
    await waitFor(() => ui(b, 'message-input').isEditable(), 30_000, 'second device can send after peer completion');
    await ui(b, 'message-input').fill('ROUND_B');
    await waitFor(() => ui(b, 'send-message').isEnabled(), 15_000, 'idle peer send is available');
    await ui(b, 'send-message').click();
    await a.getByText('ROUND_B', { exact: true }).waitFor({ timeout: 45_000 });
    await waitFor(() => ui(a, 'send-message').getAttribute('aria-label').then(Boolean), 15_000, 'first device remains usable');
    const receipts = await openOwnedMobileRpc(run, gateway, 'local', workspace.path, { experimental: { gatewaySharedThreadsV1: true } });
    await receipts.rpc.request('thread/resume', { threadId });
    await waitFor(() => ui(a, 'message-input').isEditable(), 30_000, 'peer idle before approval turn');
    await ui(a, 'message-input').fill('APPROVAL_ROUND');
    await waitFor(() => ui(a, 'send-message').isEnabled(), 15_000, 'approval send enabled');
    await ui(a, 'send-message').click();
    await ui(a, 'approval-accept').waitFor({ timeout: 45_000 });
    await ui(b, 'approval-accept').waitFor({ timeout: 45_000 });
    const approval = await receipts.rpc.waitFor(frame => frame.method === 'approval/request', 45_000, 'same approval reaches a third device');
    await a.screenshot({ path: run.pathInArtifacts('shared-approval-a.png') });
    await b.screenshot({ path: run.pathInArtifacts('shared-approval-b.png') });
    const reopenA = a.url();
    await a.goto('about:blank');
    await ui(b, 'approval-accept').click();
    const decision = await receipts.rpc.waitFor(frame => frame.method === 'approval/resolved' && frame.params?.requestId === approval.id, 45_000, 'shared approval receipt');
    assert.equal(decision.params.decision, 'accept');
    receipts.rpc.respond(approval.id, { decision: 'decline' });
    await b.getByText('APPROVAL_FINISHED', { exact: false }).first().waitFor({ timeout: 45_000 });
    await a.goto(reopenA, { waitUntil: 'domcontentloaded' });
    await a.getByText('APPROVAL_FINISHED', { exact: false }).first().waitFor({ timeout: 45_000 });
    await waitFor(async () => !await ui(a, 'approval-accept').isVisible() && !await ui(b, 'approval-accept').isVisible(), 15_000, 'approval resolved on both devices');
    assert.equal(await readFile(resolve(workspace.path, 'shared-approval-count.txt'), 'utf8'), 'executed\n');
    await ui(b, 'message-input').fill('QUESTION_ROUND');
    await waitFor(() => ui(b, 'send-message').isEnabled(), 15_000, 'question send enabled');
    await ui(b, 'send-message').click();
    // AskUserQuestion itself requires tool approval in ask mode before asking the question.
    await ui(a, 'approval-accept').waitFor({ timeout: 45_000 });
    await ui(b, 'approval-accept').waitFor({ timeout: 45_000 });
    await ui(a, 'approval-accept').click();
    await ui(a, 'question-card').waitFor({ timeout: 45_000 });
    await ui(b, 'question-card').waitFor({ timeout: 45_000 });
    const question = await receipts.rpc.waitFor(frame => frame.method === 'question/request', 45_000, 'shared question reaches third device');
    await a.locator('[data-testid^="question-option-"]').filter({ hasText: 'YES' }).click();
    await ui(a, 'question-submit').click();
    await receipts.rpc.waitFor(frame => frame.method === 'question/resolved' && frame.params?.requestId === question.id, 45_000, 'shared question receipt');
    receipts.rpc.respond(question.id, { answers: {} });
    await b.getByText('QUESTION_FINISHED', { exact: false }).first().waitFor({ timeout: 45_000 });
    await waitFor(async () => !await ui(a, 'question-card').isVisible() && !await ui(b, 'question-card').isVisible(), 15_000, 'question resolved everywhere');
    await receipts.close();
    await waitFor(async () => (await a.locator('[data-testid="message-input"]').getAttribute('placeholder')) !== null,
      15_000, 'peer remains connected');
    await a.screenshot({ path: run.pathInArtifacts('shared-device-a-390-zh-light.png') });
    await b.screenshot({ path: run.pathInArtifacts('shared-device-b-320-en-dark.png') });
    const observer = await openOwnedMobileRpc(run, gateway, 'local', workspace.path);
    const history = await observer.rpc.request('thread/read', { threadId, limit: 50 });
    const userTexts = history.messages.filter(row => row.role === 'user').map(row => row.content);
    assert.equal(userTexts.filter(text => text === 'ROUND_A').length, 1);
    assert.equal(userTexts.filter(text => text === 'ROUND_B').length, 1);
    assert.ok(!JSON.stringify(history).includes('MUST_NOT_EXECUTE'));
    await observer.close();
    assert.deepEqual(diagnostics, []);
    return { sharedStreaming: true, activeRejoin: true, alternateSend: true, simultaneousSendRejectedWithoutReplay: true,
      sharedApproval: true, sharedQuestion: true, firstReplyWins: true, controllerDisconnectHandoff: true,
      commandExecutionCount: 1, diagnostics };
  } catch (error) {
    for (let i = 0; i < pages.length; i++) {
      await pages[i].screenshot({ path: run.pathInArtifacts(`failure-device-${i}.png`) }).catch(() => {});
      await run.writeArtifactJson(`failure-device-${i}.json`, await pages[i].evaluate(() => ({
        body: document.body.innerText.slice(-6000),
        path: location.pathname,
      })).catch(() => ({})));
    }
    throw error;
  } finally {
    release = true;
    await run.writeArtifactJson('console.json', diagnostics);
    for (const page of pages) { await page.close(); }
  }
});
