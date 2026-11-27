import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { expect } from '../../renderer/node_modules/@playwright/test/index.mjs';
import { runE2E, waitFor } from './run-context.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { assertRendererBuildFresh } from './renderer-build.mjs';
import { startChromium } from './chromium.mjs';
import { signInAndWaitSidebar } from './browser-startup-observer.mjs';
import { startWebSearchNetworkFixture } from './web-search-network-fixture.mjs';
import { prepareWebNativeBinary, startWebNativeSession, webNativeModelOnlySettings } from './web-search-native-session.mjs';

/** Explicit capture variant of the existing Tools suite, with actual native receipts. */
export async function captureWebSearchBrowserEvidence(sourceUrl) {
  const scope = process.env.KCODER_E2E_SEARCH_UI_CAPTURE_SCOPE || 'all';
  assert.ok(['all', 'probes', 'conversation'].includes(scope));
  await runE2E(sourceUrl, {
    testId: 'native-browser-existing-tools-probe-success-policy-denial-fallback-and-fetch-403', tier: 'full-integration',
    modelPolicy: 'Actual Browser/Gateway/native tools and permissions against owned TLS origins. Fixed local model choices only drive one normal ASK turn; source receipts and fetch failure are native, no public web or paid model.',
    retainSuccessEvidence: true,
    budgets: { diagnosticQueries: 1, fallbackPrimaryQueries: 1, fallbackBingQueries: 1, pageFetchAttempts: 1, ordinaryModelResponses: 3, wallClockMs: 180000 },
  }, async context => {
    context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(180000)]);
    const checkpoint = process.env.KCODER_E2E_SEARCH_NATIVE_CHECKPOINT;
    assert.match(checkpoint || '', /^[a-f0-9]{40}$/);
    const build = await assertRendererBuildFresh(process.env.KCODER_E2E_RENDERER_SOURCE_ROOT ? { sourceRoot: process.env.KCODER_E2E_RENDERER_SOURCE_ROOT } : {});
    const { binary, identity } = await prepareWebNativeBinary(context, { ...build, inputCheckpoint: checkpoint, rendererRoot: process.env.KCODER_E2E_RENDERER_ROOT });
    assert.equal(identity.sha256, process.env.KCODER_E2E_SEARCH_NATIVE_SHA256);
    const doctorWorkspace = await materializeWorkspace(context, 'minimal', { instanceId: 'capture-binary-identity' });
    const doctorSettings = await context.writeStateJson('identity/config/settings.json', { credential_store: 'file', ...webNativeModelOnlySettings({ modelUrl: 'http://127.0.0.1:9/v1' }) });
    const doctor = context.spawnOwned('capture-feature-doctor', binary, ['--cwd', doctorWorkspace.path, '--settings-file', doctorSettings, 'doctor'], { env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: resolve(doctorSettings, '..') }) });
    let doctorText = ''; doctor.stdout.on('data', bytes => { doctorText += bytes.toString(); }); doctor.stderr.on('data', bytes => { doctorText += bytes.toString(); });
    await waitFor(() => doctor.exitCode !== null ? { code: doctor.exitCode } : null, 20000, 'actual capture CLI doctor', 40, context.abortSignal);
    assert.equal(doctor.exitCode, 0); assert.ok(doctorText.includes(`build commit: ${checkpoint}`)); assert.ok(doctorText.includes('build dirty: false'));
    await context.writeArtifactJson('actual-feature-binary.json', { ...identity, checkpoint, doctor: doctorText, releaseBinary: false });
    const browser = await startChromium(context, { label: 'owned-tools-capture-browser' });
    const cases = [];
    for (const authorized of scope === 'conversation' ? [] : [false, true]) {
      const name = authorized ? 'probe-success' : 'probe-permission-denied';
      const network = await startWebSearchNetworkFixture(context, { resultCount: 3 });
      const session = await startWebNativeSession(context, { binary, network, label: name, targetId: 'local', ...(authorized ? { allowedTools: ['WebSearch'] } : {}) });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
      context.addCleanup(`close ${name} page`, () => page.close());
      const observed = observePage(page);
      try {
        await signInAndWaitSidebar(page, session.gateway);
        await page.goto(`${session.gateway.baseUrl}/settings/tools`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('tool-selections-target')).toHaveValue('local', { timeout: 30000 });
        await page.getByTestId('tool-selections-search').fill('WebSearch');
        const detail = page.getByTestId('web-search-details');
        await detail.getByRole('button').first().click();
        await waitFor(() => observed.status.length ? true : null, 15000, 'actual browser status receipt', 30, context.abortSignal);
        assert.equal(network.sourceCalls, 0); assert.equal(network.observations.model.length, 0);
        await detail.getByRole('button', { name: /检查搜索|Check search/ }).click();
        if (authorized) {
          await expect(detail).toContainText(/搜索可用，返回 3 条结果|Search available.*3/, { timeout: 30000 });
          await waitFor(() => observed.probes.some(result => result.state === 'completed') ? true : null, 10000, 'healthy native probe receipt', 30, context.abortSignal);
          const receipt = observed.probes.findLast(result => result.state === 'completed');
          assert.equal(receipt.response.status, 'success'); assert.equal(receipt.response.provider, 'exa-public'); assert.equal(receipt.response.page.results.length, 3);
          assert.equal(network.sourceCalls, 1); assert.equal(network.observations.model.length, 0);
        } else {
          await expect(detail.getByRole('alert')).toContainText(/目标策略不允许本次搜索|target policy/i, { timeout: 15000 });
          assert.ok(observed.errors.some(error => /POLICY_DENIED/.test(JSON.stringify(error))));
          assert.equal(network.sourceCalls, 0);
        }
        assert.equal(observed.methods.filter(method => method === 'webSearch/probe/start').length, 1);
        assert.deepEqual(observed.pageErrors, []); assert.deepEqual(network.observations.failures, []);
        await page.screenshot({ path: context.pathInArtifacts(`${name}.png`), fullPage: true });
        await session.assertSettingsUnchanged();
        const record = { case: name, actualBrowserRpc: observed, actualNetwork: network.observations, sourceQueries: network.sourceCalls, modelTurns: 0, screenshot: `${name}.png` };
        cases.push(record); await context.writeArtifactJson(`${name}.json`, record);
      } catch (error) {
        await page.screenshot({ path: context.pathInArtifacts(`${name}-failed.png`), fullPage: true }).catch(() => {});
        await context.writeArtifactJson(`${name}-failure.json`, { error: String(error), observed, observations: network.observations, body: (await page.locator('body').innerText()).slice(0, 16000) }); throw error;
      } finally { await page.close(); await context.stopOwned(`${name}-gateway`); }
    }
    if (scope === 'probes') return { cases, scope, publicWebRequests: 0, paidModels: 0, actualFeatureIdentity: identity, screenshotsOnlyExistingUi: true };
    const network = await startWebSearchNetworkFixture(context, { scenario: 'fallback-fetch-denied', resultCount: 1 });
    const session = await startWebNativeSession(context, { binary, network, label: 'fallback-fetch-denied', targetId: 'local' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
    context.addCleanup('close fallback capture page', () => page.close());
    const observed = observePage(page);
    try {
      await signInAndWaitSidebar(page, session.gateway);
      await createConversation(page, session.workspace);
      await page.getByTestId('chat-message-input').click(); await page.keyboard.insertText('请运行受控搜索并读取找到的原文。'); await page.getByTestId('send-message-button').click();
      await approve(page, 'WebSearch'); await approve(page, 'WebFetch');
      await expect(page.getByTestId('message-assistant').filter({ hasText: network.marker }).last()).toBeVisible({ timeout: 60000 });
      await expect(page.getByTestId('pause-response-button')).toBeHidden({ timeout: 15000 });
      const search = observed.tools.find(item => item.name === 'WebSearch'), fetched = observed.tools.find(item => item.name === 'WebFetch');
      assert.ok(search?.webSources); assert.ok(fetched);
      assert.equal(search.webSources.provider, 'bing-html'); assert.equal(search.webSources.sources.length, 1);
      assert.deepEqual(search.webSources.attempts.map(attempt => attempt.provider), ['exa-public', 'searxng-bundled', 'bing-html']);
      assert.deepEqual(search.webSources.attempts.map(attempt => attempt.requestSent), [true, false, true]);
      assert.equal(fetched.status, 'failed'); assert.match(JSON.stringify(fetched.output), /403/);
      assert.equal(network.sourceCalls, 1); assert.equal(network.mainModelCalls, 3); assert.equal(network.observations.searches.length, 1); assert.equal(network.observations.pages.length, 1);
      assert.deepEqual(network.observations.failures, []); assert.deepEqual(observed.pageErrors, []);
      await expandProcessing(page);
      const sources = page.getByTestId('native-web-sources').filter({ hasText: 'bing-html' });
      await expect(sources).toBeVisible();
      const toggle = sources.getByRole('button').first(); if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      await expect(sources.locator('a')).toHaveCount(1);
      await expect(sources.getByTestId('native-source-switch')).toContainText(/已切换来源|Source switched/);
      const attempts = sources.getByTestId('native-source-attempt'); await expect(attempts).toHaveCount(3);
      assert.deepEqual(await attempts.evaluateAll(rows => rows.map(row => ({ provider: row.dataset.provider, status: row.dataset.attemptStatus }))), search.webSources.attempts.map(attempt => ({ provider: attempt.provider, status: attempt.status })));
      await sources.screenshot({ path: context.pathInArtifacts('conversation-fallback-provider.png'), animations: 'disabled' });
      const failure = page.getByTestId('web-tool-output').filter({ hasText: '403' }); await expect(failure).toBeVisible();
      await failure.scrollIntoViewIfNeeded();
      await page.screenshot({ path: context.pathInArtifacts('conversation-fetch-restricted-403.png'), fullPage: true });
      await failure.screenshot({ path: context.pathInArtifacts('fetch-restricted-native-output.png'), animations: 'disabled' });
      await session.assertModelOnlySettings();
      const record = { case: 'fallback-fetch-restricted', nativeTools: observed.tools, observations: network.observations, ordinaryModelResponses: 3, normalAskApprovals: ['WebSearch', 'WebFetch'], successfulPageReads: 0,
        visibleProvider: 'bing-html', attemptsRenderedAsNativeMetadata: true, attemptsRetainedInActualReceipt: true, screenshots: ['conversation-fallback-provider.png', 'conversation-fetch-restricted-403.png', 'fetch-restricted-native-output.png'] };
      cases.push(record); await context.writeArtifactJson('conversation-fallback-fetch-restricted.json', record);
    } catch (error) {
      await page.screenshot({ path: context.pathInArtifacts('conversation-capture-failed.png'), fullPage: true }).catch(() => {});
      await context.writeArtifactJson('conversation-capture-failure.json', { error: String(error), observed, observations: network.observations, body: (await page.locator('body').innerText()).slice(0, 20000) }); throw error;
    } finally { await page.close(); await context.stopOwned('fallback-fetch-denied-gateway'); }
    return { cases, publicWebRequests: 0, paidModels: 0, actualFeatureIdentity: identity, screenshotsOnlyExistingUi: true };
  });
}

function observePage(page) {
  const observed = { methods: [], status: [], probes: [], errors: [], tools: [], pageErrors: [] };
  page.on('pageerror', error => observed.pageErrors.push(String(error.message)));
  page.on('websocket', socket => {
    const pending = new Map();
    socket.on('framesent', ({ payload }) => { try { const frame = JSON.parse(String(payload)); if (frame.method) { observed.methods.push(frame.method); if (frame.id !== undefined) pending.set(frame.id, frame.method); } } catch { /* Observe typed frames only. */ } });
    socket.on('framereceived', ({ payload }) => { try {
      const frame = JSON.parse(String(payload)), method = pending.get(frame.id), result = frame.result;
      if (method?.startsWith('webSearch/')) { if (frame.error) observed.errors.push(frame.error); if (Array.isArray(result?.candidates)) observed.status.push(result); if (typeof result?.requestId === 'string') observed.probes.push(result); }
      if (frame.method === 'item/completed' && frame.params?.item?.type === 'toolCall') observed.tools.push({ ...frame.params.item, threadId: frame.params.threadId, turnId: frame.params.turnId, attemptId: frame.params.attemptId });
    } catch { /* Do not retain headers, tokens or unrelated RPC frames. */ } });
  });
  return observed;
}
async function approve(page, name) {
  const card = page.getByTestId('request-user-input-card'); await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card.getByTestId('permission-approval-content')).toContainText(name); await card.getByText(/^(?:仅允许这一次|Allow once)$/i).click(); await expect(card).toBeHidden({ timeout: 10000 });
}
async function expandProcessing(page) {
  for (const id of ['final-processing-toggle', 'processing-summary-toggle', 'processing-activity-group-toggle']) for (const button of await page.getByTestId(id).all()) if (await button.getAttribute('aria-expanded') === 'false') await button.click();
  for (const button of await page.locator('[data-tool-detail-toggle]').all()) if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}
async function createConversation(page, workspace) {
  const quick = page.getByTestId('project-new-conversation-button').first(); if (await quick.count()) { await quick.click(); return; }
  await page.getByTestId('projects-create-button').click(); await page.getByTestId('project-create-local-option').click();
  const picker = page.getByTestId('standalone-folder-project-dialog'), path = picker.getByTestId('device-folder-path-input');
  await path.fill(workspace); await path.press('Enter'); await expect(path).toHaveValue(workspace); await picker.getByTestId('confirm-device-folder-picker-button').click();
  const dialog = page.getByTestId('local-project-create-dialog'); await dialog.getByTestId('local-project-create-name-input').fill('受控搜索缺项截图');
  await page.getByTestId('confirm-local-project-create-button').click(); await expect(dialog).toBeHidden({ timeout: 30000 }); await page.getByTestId('project-new-conversation-button').first().click();
}
