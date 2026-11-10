import { observeFrontendInitialize, roundedMilliseconds as milliseconds, signInAndWaitSidebar } from '../../harness/browser-startup-observer.mjs';
import { prepareWebNativeBinary, webNativeModelOnlySettings, webNativeFixtureEnvironment } from '../../harness/web-search-native-session.mjs';
import { retainWebReplayWorkspace, exportWebNativeHistory } from '../../harness/web-search-history-evidence.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { initializeRpc, openPageGatewayRpc, closeRpcAndWait } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startWebSearchNetworkFixture } from '../../harness/web-search-network-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'zero-search-config-normal-chat-native-search-fetch-sources-and-durable-browser-restore',
  tier: 'full-integration',
  modelPolicy: 'Model-independent positive protocol/product chain: deterministic model and owned CONNECT/TLS source payloads; actual WebSearch/WebFetch, normal permission/Hook/Engine/State, bilingual light/dark source UI and keyboard interaction. No public search quality or native desktop claim.',
  prerequisites: 'Explicit web-network-test-fixture CLI build, fresh renderer, Chromium and OpenSSL; feature defaults off in release builds.',
  budgets: { modelRequests: 6, ordinaryModelRequests: 3, sourceQueries: 1, pageReads: 1, wallClockMs: 180000 },
  retainSuccessEvidence: true,
}, async context => {
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(180000)]);
  const build = await assertRendererBuildFresh(process.env.KCODER_E2E_RENDERER_SOURCE_ROOT ? { sourceRoot: process.env.KCODER_E2E_RENDERER_SOURCE_ROOT } : {});
  const checkpoint = process.env.KCODER_E2E_SEARCH_NATIVE_CHECKPOINT;
  const { binary, identity } = await prepareWebNativeBinary(context, { ...build, inputCheckpoint: checkpoint || 'explicit-feature-binary-checkpoint-not-supplied', rendererSourceRoot: process.env.KCODER_E2E_RENDERER_SOURCE_ROOT, rendererBuildRoot: process.env.KCODER_E2E_RENDERER_ROOT });
  if (process.env.KCODER_E2E_SEARCH_NATIVE_SHA256) assert.equal(identity.sha256, process.env.KCODER_E2E_SEARCH_NATIVE_SHA256);
  const network = await startWebSearchNetworkFixture(context);
  const temporaryWorkspace = await materializeWorkspace(context, 'minimal', { instanceId: `search-positive-${network.fixtureId}` });
  const workspace = await retainWebReplayWorkspace(context, temporaryWorkspace);
  const modelOnly = webNativeModelOnlySettings(network);
  const settingsFile = await context.writeStateJson('config/settings.json', modelOnly);
  const settingsBytes = await readFile(settingsFile);
  const doctor = context.spawnOwned('positive-feature-binary-doctor', binary, ['--cwd', workspace, '--settings-file', settingsFile, 'doctor'], { env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: resolve(settingsFile, '..') }) });
  let doctorText = ''; doctor.stdout.on('data', bytes => { doctorText += bytes.toString(); }); doctor.stderr.on('data', bytes => { doctorText += bytes.toString(); });
  await waitFor(() => doctor.exitCode !== null ? { code: doctor.exitCode } : null, 20000, 'actual feature binary doctor', 40, context.abortSignal);
  assert.equal(doctor.exitCode, 0);
  if (checkpoint) { assert.match(checkpoint, /^[a-f0-9]{40}$/); assert.ok(doctorText.includes(`build commit: ${checkpoint}`)); assert.ok(doctorText.includes('build dirty: false')); }
  await context.writeArtifactJson('actual-feature-binary.json', { ...identity, doctor: doctorText, expectedCheckpoint: checkpoint, claim: 'Explicit feature-test CLI identity; not a release installer' });
  assert.equal(modelOnly.web, undefined); assert.equal(modelOnly.mcp, undefined); assert.equal(modelOnly.mcp_servers, undefined);
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: '受控搜索验收', transport: 'local', runtime: 'kcoder', command: binary, workspace, settingsFile }]);
  const options = { workspace, kcoderBin: binary, serversFile, serversStore: context.pathInState('servers-store.json'), auth: true,
    env: webNativeFixtureEnvironment(context, network, { label: 'positive', configDir: resolve(settingsFile, '..') }),
  };
  const browser = await startChromium(context, { label: 'owned-search-positive-browser' });
  const browserContext = await browser.browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'UTC' });
  context.addCleanup('close owned search browser context', () => browserContext.close());
  const page = await browserContext.newPage(), pageErrors = [], routes = [], sentMethods = [], native = [], nativeErrors = [];
  let threadId, toolResultCount = 0, reader;
  const startup = { scope: 'One owned deterministic run; no cold/hot regression conclusion', initial: {}, restored: {}, uiInitialize: [] };
  let startupPhase = 'initial';
  startup.uiInitialize = observeFrontendInitialize(page, () => startupPhase);
  page.on('pageerror', error => pageErrors.push(context.redactText(error.message)));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) routes.push(new URL(frame.url()).pathname); });
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => { try { const frame = JSON.parse(String(payload)); if (frame.method) sentMethods.push(frame.method); } catch { /* Only protocol method names and timing are evidence. */ } });
    socket.on('framereceived', ({ payload }) => {
      let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
      if (frame.result?.thread?.id) threadId = frame.result.thread.id;
      const params = frame.params, item = params?.item;
      if (frame.method !== 'item/completed' || item?.type !== 'toolCall' || !item.webSources) return;
      const receipt = item.webSources;
      try {
        assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.identity.threadId, params.threadId); assert.equal(receipt.identity.turnId, params.turnId);
        assert.equal(receipt.identity.attemptId, params.attemptId); assert.equal(receipt.toolCallId, item.id);
        native.push(receipt); threadId = params.threadId; toolResultCount++;
      } catch (error) { nativeErrors.push(context.redactText(error.message)); }
    });
  });
  let gatewayStart = performance.now();
  let gateway = await startGateway(context, { ...options, label: 'search-positive-gateway' });
  startup.initial.gatewayStartToListeningMs = milliseconds(performance.now() - gatewayStart);
  const openReader = async current => {
    const rpc = await openPageGatewayRpc(context, page, current, `search reader ${current.port}`);
    await initializeRpc(rpc, 'owned-search-source-reader'); return rpc;
  };
  const signIn = current => signInAndWaitSidebar(page, current);
  try {
    startup.initial.gatewayStartToSidebarReadyMs = milliseconds(await signIn(gateway) - gatewayStart);
    const firstInitializeStart = performance.now(); reader = await openReader(gateway);
    startup.initial.observerRpcInitializeMs = milliseconds(performance.now() - firstInitializeStart);
    startup.initial.gatewayStartToObserverInitializedMs = milliseconds(performance.now() - gatewayStart);
    await openFreshConversation(page, workspace);
    assert.ok(!routes.some(route => route.startsWith('/settings')), 'The ordinary user flow cannot enter any settings page');
    startup.beforeFirstMessage = { sourceQueries: network.sourceCalls, modelGenerationRequests: network.observations.model.length, ordinaryModelRequests: network.mainModelCalls, pageReads: network.observations.pages.length };
    assert.deepEqual(startup.beforeFirstMessage, { sourceQueries: 0, modelGenerationRequests: 0, ordinaryModelRequests: 0, pageReads: 0 }, 'Startup and ordinary conversation creation must not run a search, model generation or page fetch');
    assert.equal(network.observations.methods.length, 0);
    await context.writeArtifactJson('initial-startup-before-message.json', startup);
    await page.getByTestId('chat-message-input').click(); await page.keyboard.insertText('请查找受控示例发布页，读取原文并给出来源。'); await page.getByTestId('send-message-button').click();
    await approveExpectedTool(page, 'WebSearch');
    await approveExpectedTool(page, 'WebFetch');
    await waitFor(async () => {
      if (network.observations.failures.length) throw new Error(`Owned fixture rejected the stage: ${network.observations.failures.join('; ')}`);
      return await page.getByTestId('message-assistant').filter({ hasText: network.marker }).last().isVisible() ? true : null;
    }, 60000, 'actual fetched body in final response', 50, context.abortSignal);
    await expect(page.getByTestId('pause-response-button')).toBeHidden({ timeout: 10000 });
    await waitFor(() => native.length === 2 && threadId ? true : null, 10000, 'two actual native source completions', 30, context.abortSignal);
    const search = native.find(receipt => receipt.operation === 'search'), fetched = native.find(receipt => receipt.operation === 'fetch');
    assert.ok(search && fetched); assert.equal(search.provider, 'exa-public'); assert.equal(search.sources.length, 12); assert.equal(fetched.sources.length, 1);
    for (const source of search.sources) { assert.equal(source.readStatus, 'summary_only'); assert.equal(source.publishedAt, '2026-10-30'); assert.equal(source.author, '夹具作者'); assert.match(source.sourceId, /^web-[0-9a-f-]{36}$/); }
    assert.equal(fetched.sources[0].url, network.pageUrl); assert.equal(fetched.sources[0].readStatus, 'read'); assert.equal(fetched.sources[0].publishedAt, undefined);
    await revealSources(page);
    const cards = page.getByTestId('native-web-sources'); await expect(cards).toHaveCount(2);
    const searchCard = cards.filter({ hasText: /搜索来源|Search sources/ }); await expect(searchCard.locator('a')).toHaveCount(10);
    await searchCard.getByRole('button', { name: /下一页|Next page/ }).click(); await expect(searchCard.locator('a')).toHaveCount(2);
    await searchCard.getByRole('button', { name: /上一页|Previous page/ }).click();
    await page.screenshot({ path: context.pathInArtifacts('native-search-fetch-sources-live.png'), fullPage: true });
    const before = await reader.request('thread/read', { threadId, limit: 100 });
    const persisted = sourceReceipts(before.messages); assert.equal(persisted.length, 2);
    assert.deepEqual(persisted.flatMap(receipt => receipt.sources.map(source => source.sourceId)).sort(), native.flatMap(receipt => receipt.sources.map(source => source.sourceId)).sort());
    const taskPath = new URL(page.url()).pathname + new URL(page.url()).search;
    await closeRpcAndWait(reader); reader = null;
    await context.stopOwned('search-positive-gateway');
    startupPhase = 'restored'; gatewayStart = performance.now();
    gateway = await startGateway(context, { ...options, authToken: gateway.authToken, label: 'search-positive-restored-gateway' });
    startup.restored.gatewayStartToListeningMs = milliseconds(performance.now() - gatewayStart);
    startup.restored.gatewayStartToSidebarReadyMs = milliseconds(await signIn(gateway) - gatewayStart);
    const restoredInitializeStart = performance.now(); reader = await openReader(gateway);
    startup.restored.observerRpcInitializeMs = milliseconds(performance.now() - restoredInitializeStart);
    startup.restored.gatewayStartToObserverInitializedMs = milliseconds(performance.now() - gatewayStart);
    const restored = await reader.request('thread/read', { threadId, limit: 100 });
    assert.deepEqual(sourceReceipts(restored.messages), persisted, 'Fresh app-server must reconstruct the exact native source receipts from durable history');
    await page.goto(gateway.baseUrl + taskPath, { waitUntil: 'domcontentloaded' });
    const task = page.getByTestId(`runtime-local-task-row-kcoder:local:${threadId}`);
    if (await task.count()) await task.click();
    await expect(page.getByTestId('message-assistant').filter({ hasText: network.marker }).last()).toBeVisible({ timeout: 30000 });
    await revealSources(page); await expect(page.getByTestId('native-web-sources')).toHaveCount(2);
    assert.equal(network.sourceCalls, 1); assert.equal(network.mainModelCalls, 3); assert.equal(network.observations.pages.length, 1);
    assert.ok(network.observations.connects.every(connect => connect.accepted), 'Every source connection must use the immutable owned public-IP map');
    assert.deepEqual(network.observations.failures, []); assert.deepEqual(pageErrors, []); assert.deepEqual(nativeErrors, []);
    assert.ok(!sentMethods.includes('settings/tools/selection/save')); assert.ok(!sentMethods.some(method => method.startsWith('webSearch/probe/')));
    assert.ok(!routes.some(route => route.startsWith('/settings'))); assert.deepEqual(await readFile(settingsFile), settingsBytes);
    await page.screenshot({ path: context.pathInArtifacts('native-search-fetch-sources-restored.png'), fullPage: true });
    await page.setViewportSize({ width: 700, height: 1000 });
    await expect(page.getByTestId('native-web-sources').first()).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: context.pathInArtifacts('native-search-fetch-sources-narrow.png'), fullPage: true });
    const ordinaryFlowRoutes = [...routes];
    const presentation = await verifySourcePresentationMatrix(page, context, gateway, taskPath, threadId, network.marker, persisted);
    assert.equal(network.sourceCalls, 1); assert.equal(network.mainModelCalls, 3); assert.equal(network.observations.pages.length, 1);
    assert.deepEqual(sourceReceipts((await reader.request('thread/read', { threadId, limit: 100 })).messages), persisted, 'Locale, theme and keyboard controls must preserve the original durable source identities');
    assert.deepEqual(await readFile(settingsFile), settingsBytes); assert.deepEqual(pageErrors, []); assert.deepEqual(nativeErrors, []);
    assert.ok(!routes.some(route => /^\/settings\/(?:tools|mcp|model-settings)/.test(route)), 'Presentation preferences must not enter tool, MCP or model settings');
    await closeRpcAndWait(reader); reader = null;
    await context.stopOwned('search-positive-restored-gateway');
    const history = await exportWebNativeHistory(context, threadId, settingsFile);
    assert.deepEqual(JSON.parse(await readFile(context.pathInArtifacts('native-session/model-connection.json'), 'utf8')), JSON.parse(settingsBytes.toString('utf8')), 'Retained public model connection must remain a valid unchanged configuration after redaction');
    await context.writeArtifactJson('startup-observations.json', startup);
    await context.writeArtifactJson('native-search-chain.json', { startup, fixtureId: network.fixtureId, threadId, sourceMetadata: persisted, observations: network.observations, routes, ordinaryFlowRoutes, presentation, sentMethods, toolResultCount, modelOnlySettingsUnchanged: true, noSearchSettings: true, noSearchKey: true, noMcpEntries: true, history,
      claim: 'Deterministic actual network/protocol/tool/state/browser chain; not public relevance, model autonomy or Electron/native-platform quality' });
    return { ordinaryConversation: true, noSearchSetup: true, actualNativeSearchFetch: true, nativeSources: 13, restoredFromFreshAppServer: true, noBusinessReplay: true, presentation, startup, history,
      successScreenshotReason: 'positive zero-search-config ordinary conversation, native receipts and fresh app-server durable source recovery' };
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('native-search-chain-failed.png'), fullPage: true }).catch(() => {});
    await context.writeArtifactJson('native-search-chain-failure.json', { message: String(error), pageErrors, nativeErrors, routes, sentMethods, native, observations: network.observations, body: (await page.locator('body').innerText()).slice(0, 16000) }); throw error;
  }
});

async function approveExpectedTool(page, name) {
  const card = page.getByTestId('request-user-input-card');
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card.getByTestId('permission-approval-content')).toContainText(name);
  await card.getByText(/^(?:仅允许这一次|Allow once)$/i).click();
  await expect(card).toBeHidden({ timeout: 10000 });
}

async function openFreshConversation(page, workspace) {
  const quick = page.getByTestId('project-new-conversation-button').first();
  if (await quick.count()) { await quick.click(); return; }
  await page.getByTestId('projects-create-button').click(); await page.getByTestId('project-create-local-option').click();
  const picker = page.getByTestId('standalone-folder-project-dialog'), path = picker.getByTestId('device-folder-path-input');
  await path.fill(workspace); await path.press('Enter'); await expect(path).toHaveValue(workspace);
  await picker.getByTestId('confirm-device-folder-picker-button').click();
  const dialog = page.getByTestId('local-project-create-dialog'); await dialog.getByTestId('local-project-create-name-input').fill('受控搜索验收');
  await dialog.getByTestId('confirm-local-project-create-button').click(); await expect(dialog).toBeHidden({ timeout: 30000 });
  await page.getByTestId('project-new-conversation-button').first().click();
}
async function revealSources(page, { keyboard = false } = {}) {
  const activate = button => keyboard ? button.press('Enter') : button.click();
  for (const button of await page.getByTestId('final-processing-toggle').all()) if (await button.getAttribute('aria-expanded') === 'false') await activate(button);
  const processing = page.getByTestId('processing-summary-toggle');
  for (const button of await processing.all()) if (await button.getAttribute('aria-expanded') === 'false') await activate(button);
  for (const button of await page.getByTestId('processing-activity-group-toggle').all()) if (await button.getAttribute('aria-expanded') === 'false') await activate(button);
  await expect(page.getByTestId('native-web-sources')).toHaveCount(2);
  for (const card of await page.getByTestId('native-web-sources').all()) { const button = card.getByRole('button').first(); if (await button.getAttribute('aria-expanded') === 'false') await activate(button); }
}
function sourceReceipts(messages) { return (messages || []).flatMap(message => (message.blocks || []).flatMap(block => block.webSources ? [block.webSources] : [])); }

async function verifySourcePresentationMatrix(page, context, gateway, taskPath, threadId, marker, receipts) {
  const search = receipts.find(receipt => receipt.operation === 'search');
  const fetched = receipts.find(receipt => receipt.operation === 'fetch');
  const cases = [];
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const language of ['en', 'zh-CN']) {
    for (const theme of ['light', 'dark']) {
      // Only ordinary client presentation preferences are changed, after the
      // zero-configuration native turn and durable restoration have completed.
      await page.goto(`${gateway.baseUrl}/settings/general`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId(`general-language-${language}-button`).click();
      await page.getByTestId('settings-nav-appearance').click();
      await page.getByTestId(`appearance-mode-${theme}`).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.goto(gateway.baseUrl + taskPath, { waitUntil: 'domcontentloaded' });
      const task = page.getByTestId(`runtime-local-task-row-kcoder:local:${threadId}`);
      if (await task.count()) await task.click();
      await expect(page.getByTestId('message-assistant').filter({ hasText: marker }).last()).toBeVisible({ timeout: 30000 });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await revealSources(page, { keyboard: true });
      const copy = language === 'en'
        ? { search: 'Search sources', fetch: 'Page reading', done: 'Completed', pages: 'Source pages', previous: 'Previous page', next: 'Next page', summary: 'Summary only', read: 'Read', published: 'Published', retrieved: 'Retrieved' }
        : { search: '搜索来源', fetch: '网页阅读', done: '已完成', pages: '来源分页', previous: '上一页', next: '下一页', summary: '仅摘要', read: '已读', published: '发布于', retrieved: '抓取于' };
      const searchCard = page.getByTestId('native-web-sources').filter({ hasText: copy.search });
      const fetchCard = page.getByTestId('native-web-sources').filter({ hasText: copy.fetch });
      await expect(searchCard).toHaveCount(1); await expect(fetchCard).toHaveCount(1);
      await expect(searchCard).toContainText(copy.done); await expect(fetchCard).toContainText(copy.read);
      await expect(searchCard).toContainText(copy.summary); await expect(searchCard).toContainText(`${copy.published} 2026-10-30`); await expect(searchCard).toContainText(copy.retrieved);
      await expect(searchCard.getByRole('navigation', { name: copy.pages, exact: true })).toBeVisible();
      await expect(fetchCard.locator('[data-source-id]')).toHaveAttribute('data-source-id', fetched.sources[0].sourceId);
      const toggle = searchCard.getByRole('button').first();
      await toggle.focus(); await expect(toggle).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(searchCard.locator('a')).toHaveCount(0);
      const collapsedScreenshot = `sources-${language}-${theme}-collapsed-keyboard.png`;
      await searchCard.screenshot({ path: context.pathInArtifacts(collapsedScreenshot), animations: 'disabled' });
      await page.keyboard.press('Space');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(searchCard.locator('a')).toHaveCount(10);
      assert.deepEqual(await sourceIds(searchCard), search.sources.slice(0, 10).map(source => source.sourceId));
      const previous = searchCard.getByRole('button', { name: copy.previous, exact: true });
      const next = searchCard.getByRole('button', { name: copy.next, exact: true });
      await expect(previous).toBeDisabled(); await expect(next).toBeEnabled();
      const firstPageScreenshot = `sources-${language}-${theme}-page-1-keyboard.png`;
      await searchCard.screenshot({ path: context.pathInArtifacts(firstPageScreenshot), animations: 'disabled' });
      const nextTabs = await tabToSourceControl(page, toggle, next);
      await page.keyboard.press('Enter');
      await expect(searchCard.locator('a')).toHaveCount(2); await expect(next).toBeDisabled(); await expect(previous).toBeEnabled();
      assert.deepEqual(await sourceIds(searchCard), search.sources.slice(10).map(source => source.sourceId));
      const secondPageScreenshot = `sources-${language}-${theme}-page-2-keyboard.png`;
      await searchCard.screenshot({ path: context.pathInArtifacts(secondPageScreenshot), animations: 'disabled' });
      const previousTabs = await tabToSourceControl(page, toggle, previous);
      await page.keyboard.press('Space'); await expect(searchCard.locator('a')).toHaveCount(10); await expect(previous).toBeDisabled();
      assert.deepEqual(await sourceIds(searchCard), search.sources.slice(0, 10).map(source => source.sourceId));
      const colors = await searchCard.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, foreground: getComputedStyle(element).color, border: getComputedStyle(element).borderColor, theme: document.documentElement.dataset.theme }));
      assert.notEqual(colors.background, 'rgba(0, 0, 0, 0)'); assert.notEqual(colors.background, colors.foreground);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      cases.push({ language, theme, colors, nextTabs, previousTabs, collapseKey: 'Enter', expandKey: 'Space', nextPageKey: 'Enter', previousPageKey: 'Space', firstPageSourceIds: search.sources.slice(0, 10).map(source => source.sourceId), secondPageSourceIds: search.sources.slice(10).map(source => source.sourceId), screenshots: [collapsedScreenshot, firstPageScreenshot, secondPageScreenshot] });
      await context.writeArtifactJson(`native-source-presentation-${language}-${theme}.json`, cases.at(-1));
    }
    const pair = cases.filter(item => item.language === language);
    assert.notEqual(pair[0].colors.background, pair[1].colors.background, 'Light and dark must apply distinct rendered source backgrounds');
  }
  assert.equal(cases.length, 4);
  await context.writeArtifactJson('native-source-presentation-matrix.json', { cases, completed: true });
  return { locales: ['en', 'zh-CN'], themes: ['light', 'dark'], cases, sourceIdentitiesPreserved: true, additionalSearches: 0, additionalPageReads: 0 };
}

async function tabToSourceControl(page, toggle, target) {
  await toggle.focus();
  for (let count = 1; count <= 16; count++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate(element => element === document.activeElement)) return count;
  }
  assert.fail('The enabled source pagination control must be keyboard reachable within its source card');
}

function sourceIds(card) { return card.locator('[data-source-id]').evaluateAll(nodes => nodes.map(node => node.dataset.sourceId)); }
