import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startSourceDesktop } from '../../harness/source-desktop.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { nativeCodeFixture } from '../../harness/native-code-service.mjs';
import { registerOriginalCarrierCleanup } from '../../harness/native-systemd-carrier.mjs';
import { requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'composer-question-queue-native-lifecycle', tier: 'full-integration',
  modelPolicy: 'model-independent local Provider triggers real question tools through the actual Gateway, Rust app-server and production React workbench; no paid model',
  retainSuccessLogs: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'explicit composer lifecycle Native candidate');
  const fixture = await nativeCodeFixture(context, binary);
  assert.match(process.env.KCODER_E2E_KCODER_BIN_SHA256 ?? '', /^[a-f0-9]{64}$/, 'Pin the selected Native candidate SHA-256');
  assert.equal(fixture.imageSha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const runtimeDir = `/run/user/${process.getuid()}`;
  fixture.env = { ...fixture.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` };
  registerOriginalCarrierCleanup(context, fixture, 'composer-question-queue-native');
  let scene;
  const answerDeliveries = [];
  const toolOffers = [];
  const model = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    assert.ok(model.requests.length <= 18, 'Bound the number of deterministic Provider requests');
    const latestUser = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
    const latestText = typeof latestUser?.content === 'string' ? latestUser.content : JSON.stringify(latestUser?.content);
    answerDeliveries.push({ scene: scene.name,
      receivedEnteredAnswer: JSON.stringify(body.messages ?? []).includes(`ANSWER_${scene.name}`) });
    if (latestText?.includes(scene.follow)) return [
      { delta: { role: 'assistant', content: `FOLLOW_DONE_${scene.name}` } }, { finishReason: 'stop' },
    ];
    const toolAnswered = (body.messages ?? []).some(message => message.role === 'tool');
    if (toolAnswered) return [
      { delta: { role: 'assistant', content: `QUESTION_CONTINUED_${scene.name}` } },
      { ready: () => scene.finish, finishReason: 'stop' },
    ];
    const toolName = scene.async ? 'AskUserQuestionAsync' : 'AskUserQuestion';
    const advertised = body.tools?.some(tool => tool.function?.name === toolName) === true;
    toolOffers.push({ scene: scene.name, toolName, advertised });
    assert.ok(advertised, `${toolName} must be advertised by the actual app-server`);
    return [
      { delta: { role: 'assistant', content: `QUESTION_START_${scene.name}` } },
      { ready: () => scene.ask, delta: { tool_calls: [{ index: 0, id: `question-${scene.name}`,
        type: 'function', function: { name: toolName, arguments: JSON.stringify({ questions: [{
          question: `Which approach for ${scene.name}?`, header: 'Approach', multi_select: false,
          options: [{ label: 'Review first', description: 'Review the owned fixture.' },
            { label: 'Continue', description: 'Continue the owned fixture.' }],
        }] }) } }] } },
      { finishReason: 'tool_calls' },
    ];
  } });
  const settings = JSON.parse(await readFile(fixture.settings, 'utf8'));
  settings.tools.profile = 'full';
  // Async Ask is disabled in product defaults. Enable only the fixture's two
  // selected tools on this owned target; never rewrite a shared configuration.
  settings.tools.disabled = [];
  settings.tools.studio = { kcoder: ['AskUserQuestion', 'AskUserQuestionAsync'] };
  settings.allowed_tools = ['AskUserQuestion', 'AskUserQuestionAsync'];
  settings.providers['owned-code'].endpoint = model.baseUrl;
  settings.providers['owned-code'].default_model = 'composer-lifecycle-fixture';
  settings.providers['owned-code'].request_timeout_secs = 180;
  await writeFile(fixture.settings, JSON.stringify(settings), { mode: 0o600 });
  const serversFile = await context.writeStateJson('servers.json', [{
    id: 'local', label: 'Owned composer lifecycle', runtime: 'kcoder', transport: 'local',
    command: fixture.binary, workspace: fixture.workspace,
  }]);
  const host = process.env.KCODER_E2E_COMPOSER_HOST ?? 'browser';
  assert.ok(['browser', 'electron'].includes(host), 'Select browser or actual source Electron');
  const env = { HOME: fixture.home, KCODER_CONFIG_DIR: fixture.profile,
    KCODER_TARGET_DIR: process.env.KCODER_TARGET_DIR,
    XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: fixture.env.DBUS_SESSION_BUS_ADDRESS,
    KCODER_STUDIO_RENDERER_MODE: 'vite' };
  const desktop = host === 'electron' ? await startSourceDesktop(context, {
    label: 'composer-lifecycle-electron', profile: fixture.profile, servers: serversFile,
    workspace: fixture.workspace, kcoderBin: fixture.binary, env, startTimeoutMs: 120_000,
  }) : null;
  const gateway = desktop ? null : await startGateway(context, { workspace: fixture.workspace, serversFile,
    kcoderBin: fixture.binary, auth: true, startTimeoutMs: 120_000,
    env,
  });
  const chromium = desktop ? null : await startChromium(context, { label: 'composer-lifecycle-chromium' });
  const page = desktop?.page ?? await chromium.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const results = [];
  let phase = 'login';
  await context.writeArtifactJson('candidate.json', { binary, imageSha256: fixture.imageSha256,
    renderer: 'current source through authenticated Gateway-owned Vite', host, realAppServer: true,
    storageNativeTargetDir: process.env.KCODER_TARGET_DIR ?? null,
    nativeSourceCommit: 'not inferred from an existing binary', sharedDevModified: false });
  try {
    if (gateway) {
      await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
      await page.locator('input[name="token"]').fill(gateway.authToken);
      await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')),
        page.locator('button[type="submit"]').click()]);
    }
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 120_000 });
    for (const name of ['answer-narrow', 'cancel', 'async-answer']) {
      await page.setViewportSize({ width: 1280, height: 900 });
      phase = `${name}:create-and-stream`;
      console.log(`[composer lifecycle] ${phase}`);
      scene = { name, async: name === 'async-answer', ask: false, finish: false,
        follow: `FOLLOW_${name}`, cancelled: `CANCELLED_${name}` };
      const project = page.getByTestId('project-item').filter({ hasText: 'Owned composer lifecycle' }).first();
      await project.waitFor({ timeout: 120_000 });
      await project.hover();
      await project.getByTestId('project-new-conversation-button').click();
      const requestsBefore = model.requests.length;
      await send(page, `START_${name}`);
      await waitFor(async () => {
        if (await page.getByTestId('assistant-error-details-toggle').isVisible()) {
          await page.getByTestId('assistant-error-details-toggle').click();
          throw new Error(`Original turn failed: ${await page.getByTestId('assistant-error-details').innerText()}`);
        }
        const offer = toolOffers.find(offer => offer.scene === name);
        if (offer && !offer.advertised) throw new Error(`The owned fixture did not enable ${offer.toolName}`);
        return model.requests.length > requestsBefore && await page.getByTestId('message-assistant').filter({ hasText: `QUESTION_START_${name}` }).isVisible();
      }, 120_000, 'the original turn to reach the local Provider', 100, context.abortSignal);
      await send(page, scene.follow);
      await send(page, scene.cancelled);
      const queued = page.locator('[data-testid^="conversation-queue-row-"]').filter({ hasText: scene.follow });
      const cancelled = page.locator('[data-testid^="conversation-queue-row-"]').filter({ hasText: scene.cancelled });
      await queued.waitFor({ state: 'visible', timeout: 20_000 });
      await cancelled.waitFor({ state: 'visible', timeout: 20_000 });
      assert.deepEqual(await statusOrder(page, 'row'), ['queue']);
      await page.getByTestId('chat-message-input').fill(`DRAFT_${name}`);
      scene.ask = true;
      phase = `${name}:question-and-queue`;
      const dock = page.locator('[data-testid="desktop-floating-composer-card"]:visible, [data-testid="mobile-chat-input-dock"]:visible');
      const question = scene.async ? dock.locator('[data-testid^="async-question-card-"]')
        : dock.getByTestId('request-user-input-card');
      const questionTrigger = scene.async ? page.getByTestId('composer-status-trigger-questions')
        : page.locator('[data-testid^="composer-status-trigger-interaction:"]');
      await questionTrigger.waitFor({ timeout: 30_000 });
      if (await questionTrigger.getAttribute('aria-expanded') !== 'true') await questionTrigger.click();
      await question.waitFor({ state: 'visible', timeout: 30_000 });
      assert.equal(await queued.isVisible(), true, 'A real model question must not unmount the queue');
      assert.equal(await cancelled.isVisible(), true);
      if (scene.async) {
        assert.deepEqual(await statusOrder(page, 'row'), ['queue', 'questions'], 'First observed arrival order');
        assert.deepEqual(await statusOrder(page, 'panels'), ['questions', 'queue'], 'Newer panel appears above the queue');
        await question.locator('textarea').last().fill(`ANSWER_${name}`);
        const queueTrigger = page.getByTestId('composer-status-trigger-queue');
        await queueTrigger.click();
        await queueTrigger.click();
        assert.deepEqual(await statusOrder(page, 'panels'), ['queue', 'questions'], 'Reopened queue moves above the question');
        assert.equal(await question.locator('textarea').last().inputValue(), `ANSWER_${name}`);
      }
      await cancelled.locator('[data-testid^="queue-cancel-button-"]').click();
      await cancelled.waitFor({ state: 'detached' });
      if (scene.async) {
        assert.deepEqual(await statusOrder(page, 'row'), ['queue', 'questions'], 'Queue count update retains arrival order');
        assert.deepEqual(await statusOrder(page, 'panels'), ['queue', 'questions'], 'Queue count update retains opening order');
      }
      const expectedDraft = `${scene.cancelled}\n\nDRAFT_${name}`;
      if (scene.async) {
        phase = `${name}:switch-owner`;
        const sidebar = page.getByTestId('desktop-sidebar');
        await sidebar.getByText('START_answer-narrow', { exact: true }).click();
        await page.getByTestId('message-user').filter({ hasText: 'START_answer-narrow' }).waitFor();
        await page.getByTestId('composer-status-trigger-questions').waitFor({ state: 'detached' });
        await page.getByTestId('composer-status-trigger-queue').waitFor({ state: 'detached' });
        await sidebar.getByText(`START_${name}`, { exact: true }).click();
        await questionTrigger.waitFor();
        if (await questionTrigger.getAttribute('aria-expanded') !== 'true') await questionTrigger.click();
        await question.waitFor({ state: 'visible' });
        await queued.waitFor({ state: 'visible' });
        const restoredOrder = await statusOrder(page, 'row');
        assert.deepEqual([...restoredOrder].sort(), ['questions', 'queue']);
        assert.deepEqual(await statusOrder(page, 'panels'), [...restoredOrder].reverse(),
          'A new pane owner starts a fresh opening order without the previous manual ordering');
      }
      await page.screenshot({ path: context.pathInArtifacts(`${name}-question-and-queue.png`), fullPage: true });
      if (name === 'answer-narrow') {
        phase = `${name}:narrow-layout`;
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByTestId('mobile-chat-input-dock').waitFor({ timeout: 20_000 });
        await questionTrigger.waitFor();
        if (await questionTrigger.getAttribute('aria-expanded') !== 'true') await questionTrigger.click();
        await queued.waitFor({ state: 'visible', timeout: 10_000 });
        await question.waitFor({ state: 'visible', timeout: 10_000 });
        await page.screenshot({ path: context.pathInArtifacts('narrow-question-and-queue.png'), fullPage: true });
      }
      if (name === 'cancel') {
        await question.getByTestId('request-user-input-ignore-button').click();
        await question.waitFor({ state: 'detached', timeout: 20_000 });
        const interrupted = page.getByTestId('turn-process-summary').filter({
          has: page.getByTestId('turn-process-status').filter({ hasText: /^(已中断|Interrupted)$/ }),
        });
        await interrupted.waitFor({ state: 'visible', timeout: 20_000 });
        assert.equal(await interrupted.locator('.animate-spin').count(), 0, 'The cancelled original turn must stop its timer');
      } else {
        await question.locator('textarea').last().fill(`ANSWER_${name}`);
        await question.getByTestId('request-user-input-submit-button').click();
        await page.getByTestId('message-assistant').filter({ hasText: `QUESTION_CONTINUED_${name}` }).waitFor({ timeout: 30_000 });
        if (scene.async) {
          await waitFor(async () => ['answer_saved', 'queued', 'context_applied', 'started_turn'].includes(await question.getAttribute('data-status')),
            20_000, 'actual async answer receipt', 50, context.abortSignal);
        } else {
          await question.waitFor({ state: 'detached', timeout: 20_000 });
          assert.equal(await page.getByTestId('chat-message-input').innerText(), expectedDraft,
            'Cancelling a queued message restores its text ahead of the existing draft');
        }
      }
      scene.finish = true;
      phase = `${name}:drain`;
      await page.getByTestId('message-assistant').filter({ hasText: `FOLLOW_DONE_${name}` }).waitFor({ timeout: 60_000 });
      await queued.waitFor({ state: 'detached', timeout: 20_000 });
      await page.getByTestId('composer-status-trigger-queue').waitFor({ state: 'detached', timeout: 20_000 });
      if (scene.async) await page.getByTestId('composer-status-trigger-questions').waitFor({ state: 'detached', timeout: 20_000 });
      const cancelledWasSent = model.requests.some(body => {
        const user = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
        return JSON.stringify(user?.content).includes(scene.cancelled);
      });
      assert.equal(cancelledWasSent, false, 'Cancelled queued text must never reach the Provider');
      if (name !== 'cancel') assert.ok(answerDeliveries.some(receipt => receipt.scene === name && receipt.receivedEnteredAnswer),
        'The entered answer must reach a real subsequent Provider request');
      assert.equal(await page.getByTestId('chat-message-input').innerText(), expectedDraft,
        'Executing queued input must preserve the unsent draft');
      results.push({ name, realQuestionAndQueueCoexisted: true, cancellationPreserved: true,
        asyncCardOrderVerified: scene.async, crossTaskCardsIsolated: scene.async,
        narrowLayout: name === 'answer-narrow', cancelledTurnStopped: name === 'cancel', queueDrainedAfterQuestion: true });
      console.log(`[composer lifecycle] ${name}:passed`);
    }
    assert.deepEqual(errors, []);
    await context.writeArtifactJson('lifecycle.json', { results, answerDeliveries, toolOffers, providerRequests: model.requests.length, errors });
    return { host, results, providerRequests: model.requests.length, imageSha256: fixture.imageSha256 };
  } catch (error) {
    await context.writeArtifactJson('failure.json', { scene: scene?.name, phase, results, toolOffers, errors,
      providerRequests: model.requests.length, message: error.message });
    await page.screenshot({ path: context.pathInArtifacts('failure.png'), fullPage: true }).catch(() => {});
    await writeFile(context.pathInArtifacts('failure-dom.txt'), context.redactText(await page.locator('body').innerText().catch(() => '')), { mode: 0o600 });
    throw error;
  }
});

async function statusOrder(page, surface) {
  const selector = surface === 'row' ? '[data-status-item]' : '[data-status-panel]:visible';
  return page.locator(selector).evaluateAll(items => items.map(item =>
    item.dataset.statusItem ?? item.dataset.statusPanel));
}

async function send(page, text) {
  const input = page.getByTestId('chat-message-input');
  await input.waitFor({ state: 'visible', timeout: 30_000 });
  await input.fill(text);
  await page.getByTestId('send-message-button').click();
}
