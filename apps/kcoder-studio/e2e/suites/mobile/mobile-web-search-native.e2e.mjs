import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { runE2E, waitFor } from '../../harness/run-context.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { login } from '../../harness/http.mjs';
import { openRpc, gatewayRpcUrl, initializeRpc, closeRpcAndWait, isTurnCompletion } from '../../harness/rpc.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { prepareWebNativeBinary, webNativeModelOnlySettings, webNativeFixtureEnvironment } from '../../harness/web-search-native-session.mjs';
import { startWebSearchNetworkFixture } from '../../harness/web-search-network-fixture.mjs';
import { observeNativeUiFrames } from '../../harness/native-tool-approval.mjs';
import { buildGatewayMobileWebManifest } from '../../../mobile/scripts/gateway-mobile-web-manifest.mjs';

const legacyBinary = '92481a6a1df52a40238cb89405383681e4a043a77e4a96bfa2f4b92cb7acbe1e';
assert.equal(process.env.KCODER_E2E_SEARCH_NATIVE_SHA256!==undefined,process.env.KCODER_E2E_SEARCH_NATIVE_CHECKPOINT!==undefined,'Supply fixture SHA and source checkpoint together');
const expectedBinary = process.env.KCODER_E2E_SEARCH_NATIVE_SHA256 || legacyBinary;
const expectedCheckpoint = process.env.KCODER_E2E_SEARCH_NATIVE_CHECKPOINT || 'ff8e0617eda2227b3b4c44a3202c6cfb8a37ecf9';
assert.match(expectedBinary,/^[a-f0-9]{64}$/);assert.match(expectedCheckpoint,/^[a-f0-9]{40}$/);
await runE2E(import.meta.url, {
  testId: 'mobile-web-real-gateway-native-search-fetch-sources-stop-error-and-late-isolation', tier: 'full-integration',
  modelPolicy: 'Model-independent Mobile Web UI over actual Gateway/Engine/State and actual native WebSearch/WebFetch, normal ASK, owned TLS/MCP. Zero public traffic and paid models. Not Android/iOS native or model-quality evidence.',
  prerequisites: 'Explicit frozen feature-test CLI 92481a6/ff8e; verified official Mobile Web dist with unchanged Mobile production inputs; Chromium/OpenSSL.',
  budgets: { publicQueries: 0, paidModels: 0, nativeSearchTurns: 4, nativePageReads: 1, wallClockMs: 240000 }, retainSuccessEvidence: true,
}, async context => {
  context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(240000)]);
  const { binary, identity } = await prepareWebNativeBinary(context, { inputCheckpoint: expectedCheckpoint });
  assert.equal(identity.sha256, expectedBinary);
  const probeWorkspace = await materializeWorkspace(context, 'minimal', { instanceId: 'mobile-native-binary-identity' });
  const probeSettings = await context.writeStateJson('identity/config/settings.json', { credential_store: 'file', ...webNativeModelOnlySettings({ modelUrl: 'http://127.0.0.1:9/v1' }) });
  const doctor = context.spawnOwned('mobile-feature-binary-doctor', binary, ['--cwd', probeWorkspace.path, '--settings-file', probeSettings, 'doctor'], { env: context.isolatedEnvironment({ KCODER_CONFIG_DIR: resolve(probeSettings, '..') }) });
  let doctorText = ''; doctor.stdout.on('data', bytes => { doctorText += bytes.toString(); }); doctor.stderr.on('data', bytes => { doctorText += bytes.toString(); });
  await waitFor(() => doctor.exitCode !== null ? { code: doctor.exitCode } : null, 20000, 'actual feature binary doctor', 40, context.abortSignal);
  assert.equal(doctor.exitCode, 0); assert.ok(doctorText.includes(`build commit: ${expectedCheckpoint}`));
  if(expectedBinary!==legacyBinary)assert.ok(doctorText.includes('build dirty: false'),'A new fixture input must have a clean source identity');
  await context.writeArtifactJson('actual-feature-binary.json', { ...identity, doctor: doctorText, expectedCheckpoint, buildDirty:doctorText.includes('build dirty: true'), claim: expectedBinary===legacyBinary?'Legacy dirty ff8e fixture CLI protocol evidence; not release/current clean-source evidence':'Clean explicitly frozen feature-test CLI; not release binary' });

  const mobilePaths = ['apps/kcoder-studio/mobile/src','apps/kcoder-studio/mobile/scripts','apps/kcoder-studio/mobile/package.json','apps/kcoder-studio/shared/webSources.ts'];
  const changed = execFileSync('git',['diff','--name-only',expectedCheckpoint,'HEAD','--',...mobilePaths],{encoding:'utf8'}).trim().split('\n').filter(Boolean).filter(path=>! /\.(test|spec)\./.test(path));
  assert.deepEqual(changed,[],'Align an unchanged Mobile production client with the fixture binary');
  await context.writeArtifactJson('mobile-source-alignment.json',{nativeCheckpoint:expectedCheckpoint,harnessCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),paths:mobilePaths,changedProductionInputs:changed,legacyDirtyBinary:expectedBinary===legacyBinary,androidNativeClaim:false});
  const input = process.env.KCODER_E2E_MOBILE_DIST;
  assert.ok(input && input.startsWith('/'), 'An explicit existing official Mobile dist is required');
  const original = JSON.parse(await readFile(resolve(input, 'kcoder-mobile-web.json'), 'utf8'));
  assert.deepEqual(await buildGatewayMobileWebManifest(input), original);
  const mobileRoot = context.pathInState('mobile-web');
  await cp(input, mobileRoot, { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await buildGatewayMobileWebManifest(mobileRoot), original);
  await context.writeArtifactJson('mobile-dist-input.json', { input, manifest: original, copiedToOwnedState: true,
    sourceCheckpoint: '5a188e945; Mobile production inputs unchanged through caf232b94 and from ff8e0617e',
    claim: 'Official Mobile Web build, independent Expo client; no Android/iOS native claim' });
  const browser = await startChromium(context, { label: 'owned-mobile-native-browser' });
  const results = [];
  for (const scenario of ['positive', 'cancel-stream', 'unavailable']) {
    const network = await startWebSearchNetworkFixture(context, { scenario, resultCount: scenario === 'positive' ? 12 : 1 });
    const workspace = await materializeWorkspace(context, 'minimal', { instanceId: `mobile-native-${scenario}` });
    const document = webNativeModelOnlySettings(network);
    const settingsFile = await context.writeStateJson(`${scenario}/config/settings.json`, document);
    const bytes = await readFile(settingsFile);
    assert.deepEqual(Object.keys(document).sort(), ['active_provider', 'providers']);
    const serversFile = await context.writeStateJson(`${scenario}/servers.json`, [{ id: 'local', label: 'Owned native source', transport: 'local', command: binary, workspace: workspace.path, settingsFile }]);
    const gateway = await startGateway(context, { label: `mobile-native-${scenario}-gateway`, auth: true, workspace: workspace.path, kcoderBin: binary, serversFile,
      serversStore: context.pathInState(`${scenario}/servers-store.json`), env: { ...webNativeFixtureEnvironment(context, network, { label: scenario, configDir: resolve(settingsFile, '..') }),
        KCODER_STUDIO_MOBILE_WEB_ROOT: mobileRoot, KCODER_STUDIO_WEB_ROOT: process.env.KCODER_E2E_RENDERER_ROOT } });
    const browserContext = await browser.browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'UTC' });
    context.addCleanup(`close mobile ${scenario} browser context`, () => browserContext.close());
    const page = await browserContext.newPage(); const frames = observeNativeUiFrames(page); const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(context.redactText(error.message)));
    const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
    const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
    const reader = await openRpc(gatewayRpcUrl(gateway, 'local', token), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close mobile ${scenario} readonly RPC`, () => closeRpcAndWait(reader));
    await initializeRpc(reader, `mobile-native-${scenario}-reader`);
    try {
      await pair(page, gateway);
      await createTask(page, scenario === 'cancel-stream' ? 'WEBCASEOWNER 运行受控网页搜索。' : '检索受控示例发布页并读取原文。');
      await approve(page, frames, 'WebSearch');
      const owner = await currentTurn(frames);
      if (scenario === 'positive') {
        await approve(page, frames, 'WebFetch');
        await completed(frames, owner, context);
        await expect(page.getByText(network.marker, { exact: false }).last()).toBeVisible({ timeout: 10000 });
        const receipts = nativeReceipts(frames, owner);
        assert.equal(receipts.length, 2); assert.equal(receipts[0].sources.length, 12); assert.equal(receipts[1].sources[0].readStatus, 'read');
        await reveal(page);
        const cards = page.getByTestId('native-web-sources'); await expect(cards).toHaveCount(2);
        const search = cards.filter({ hasText: /搜索来源|Search sources/ }); await expect(search.getByRole('link')).toHaveCount(10);
        await search.getByRole('button', { name: /下一页|Next page/ }).click(); await expect(search.getByRole('link')).toHaveCount(2);
        await page.screenshot({ path: context.pathInArtifacts('mobile-native-sources-page-2.png'), fullPage: true });
        const before = await reader.request('thread/read', { threadId: owner.threadId, limit: 100 });
        await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.getByTestId('message-input')).toBeVisible({ timeout: 30000 });
        await reveal(page); await expect(page.getByTestId('native-web-sources')).toHaveCount(2);
        assert.deepEqual(historySources(await reader.request('thread/read', { threadId: owner.threadId, limit: 100 })), historySources(before));
        assert.equal(network.sourceCalls, 1); assert.equal(network.mainModelCalls, 3); assert.equal(network.observations.pages.length, 1);
        await page.screenshot({ path: context.pathInArtifacts('mobile-native-sources-restored.png'), fullPage: true });
        results.push({ scenario, nativeSources: 13, reloadWithoutBusinessReplay: true });
      } else if (scenario === 'cancel-stream') {
        await waitFor(() => network.gates.observations.find(gate => gate.name === 'owner-stream'), 10000, 'actual source SSE gate', 30, context.abortSignal);
        await expect(page.getByTestId('stop-turn')).toBeVisible();
        await page.evaluate(() => {
          const timing = window.__ownedMobileStopTiming = { clickAt: null, feedbackAt: null, settledAt: null };
          document.querySelector('[data-testid="stop-turn"]').addEventListener('click', () => {
            timing.clickAt = performance.now();
            const before = document.querySelector('[data-testid="stop-turn"]')?.textContent;
            const observer = new MutationObserver(() => {
              const control = document.querySelector('[data-testid="stop-turn"]');
              if (timing.feedbackAt === null && (!control || control.getAttribute('aria-disabled') === 'true' || control.disabled === true || control.textContent !== before)) timing.feedbackAt = performance.now();
              if (!control) { timing.settledAt = performance.now(); observer.disconnect(); }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
          }, { once: true });
        });
        const clickHostAt = performance.now();
        const closed = waitFor(() => network.gates.observations.find(gate => gate.name === 'owner-stream')?.closedBeforeRelease ? { observedAt: performance.now() } : null, 10000, 'native owner socket closed', 10, context.abortSignal).catch(error=>({error:String(error)}));
        await page.getByTestId('stop-turn').click();
        await expect(page.getByTestId('stop-turn')).toHaveCount(0);
        const uiTiming = await page.evaluate(() => window.__ownedMobileStopTiming);
        assert.ok(uiTiming.clickAt !== null && uiTiming.feedbackAt !== null && uiTiming.settledAt !== null);
        const terminal = await completed(frames, owner, context); assert.equal(terminal.frame.params.turn.status, 'interrupted');
        const closure = await closed; assert.equal(closure.error,undefined);
        const stopTiming = { uiClickToFeedbackMs: Math.round((uiTiming.feedbackAt - uiTiming.clickAt) * 10) / 10,
          uiClickToStopControlSettledMs: Math.round((uiTiming.settledAt - uiTiming.clickAt) * 10) / 10, uiTargetMs: 500,
          uiWithinTarget: uiTiming.feedbackAt - uiTiming.clickAt <= 500,
          nativeInterruptedReceiptAfterHostDispatchMs: Math.max(0, Math.round(terminal.atMs - clickHostAt)),
          nativeSocketClosureObservedAfterHostDispatchMs: Math.round(closure.observedAt - clickHostAt), socketPollingIntervalMs: 10,
          clock: 'browser performance.now for actual click/DOM settlement; separate host performance.now for native receipt/socket observation',
          scope: 'One observed Mobile Web stop; first control disable/text change/removal is UI feedback, removal is settlement; no p50/p95 or native Android claim' };
        await context.writeArtifactJson('mobile-stop-timing.json', stopTiming);
        assert.ok(stopTiming.uiWithinTarget, 'Actual Mobile stop feedback must meet the plan target');
        const beforeLate = await reader.request('thread/read', { threadId: owner.threadId, limit: 100 });
        await page.getByTestId('message-input').fill('WEBCASEPEER 新回合执行独立受控搜索。'); await page.getByTestId('send-message').click();
        await approve(page, frames, 'WebSearch', owner.turnId); const peer = await currentTurn(frames, owner.turnId);
        await waitFor(() => network.gates.observations.find(gate => gate.name === 'peer-query'), 10000, 'next real source turn gate', 30, context.abortSignal);
        network.gates.release('owner-stream'); await waitFor(() => network.gates.observations.find(gate => gate.name === 'owner-stream')?.replyAttempted, 3000, 'late actual upstream reply', 30, context.abortSignal);
        assert.equal(network.gates.observations.find(gate => gate.name === 'owner-stream').transportClosedAtReply, true);
        await expect(page.getByTestId('stop-turn')).toBeVisible();
        assert.ok(!frames.some(row => row.frame.method === 'turn/completed' && row.frame.params?.threadId === peer.threadId && row.frame.params?.turnId === peer.turnId));
        assert.deepEqual(historySources(await reader.request('thread/read', { threadId: owner.threadId, limit: 100 })).filter(receipt => receipt.identity.turnId === owner.turnId), historySources(beforeLate));
        network.gates.release('peer-query'); await completed(frames, peer, context); await expect(page.getByTestId('stop-turn')).toHaveCount(0);
        const peerSources = nativeReceipts(frames, peer); assert.equal(peerSources.length, 1); assert.equal(peerSources[0].sources.length, 1);
        assert.ok(nativeReceipts(frames, owner).every(receipt => receipt.status !== 'success' && receipt.sources.length === 0));
        await reveal(page); await page.screenshot({ path: context.pathInArtifacts('mobile-native-stopped-late-and-next-turn.png'), fullPage: true });
        results.push({ scenario, mobileStopInterruptedNativeTurn: true, lateResponseDidNotSettleNextTurn: true, nextTurnCompleted: true, stopTiming });
      } else {
        await completed(frames, owner, context); await expect(page.getByTestId('stop-turn')).toHaveCount(0);
        const receipts = nativeReceipts(frames, owner); assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'failed'); assert.equal(receipts[0].sources.length, 0);
        await reveal(page); await expect(page.getByTestId('native-web-sources')).toHaveCount(1);
        await expect(page.getByTestId('native-web-sources')).toContainText(/失败|Failed/i);
        await page.screenshot({ path: context.pathInArtifacts('mobile-native-error-terminal.png'), fullPage: true });
        results.push({ scenario, nativeErrorVisible: true, noPendingStop: true });
      }
      assert.deepEqual(await readFile(settingsFile), bytes); assert.deepEqual(network.observations.failures, []);
      await context.writeArtifactJson(`cases/${scenario}.json`, { scenario, frames, result: results.at(-1), observations: network.observations, pageErrors,
        thread: await reader.request('thread/read', { threadId: owner.threadId, limit: 100 }), realMobileWeb: true, actualGatewayNative: true, publicCalls: 0, paidModels: 0 });
    } catch (error) {
      await page.screenshot({ path: context.pathInArtifacts(`mobile-${scenario}-failure.png`), fullPage: true }).catch(() => {});
      await context.writeArtifactJson(`cases/${scenario}-failure.json`, { error: String(error), frames, observations: network.observations, pageErrors, body: (await page.locator('body').innerText()).slice(0, 14000) }); throw error;
    } finally {
      network.gates.releaseAll(); await closeRpcAndWait(reader); await browserContext.close(); await context.stopOwned(`mobile-native-${scenario}-gateway`);
    }
  }
  return { results, featureTestBinary: identity, publicCalls: 0, paidModels: 0, claim: 'Actual Mobile Web/Gateway/native protocol and rendering; not final release CLI or Android/iOS native' };
});

async function pair(page, gateway) {
  const response = await page.goto(gateway.baseUrl + '/mobile/', { waitUntil: 'domcontentloaded' }); assert.equal(response.status(), 200);
  await page.getByTestId('welcome-direct-connection').click(); await page.getByTestId('gateway-endpoint').fill(gateway.baseUrl);
  await page.getByTestId('gateway-token').fill(gateway.authToken); await page.getByTestId('gateway-connect').click(); await expect(page.getByTestId('new-workspace')).toBeVisible({ timeout: 30000 });
}
async function createTask(page, prompt) {
  await page.getByTestId('new-workspace').click(); await expect(page.getByTestId('new-task-draft')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('message-input').fill(prompt); await expect(page.getByTestId('send-message')).toBeEnabled({ timeout: 15000 }); await page.getByTestId('send-message').click();
}
async function approve(page, frames, name, previousTurn) {
  const row = await waitFor(() => frames.find(row => row.direction === 'received' && row.frame.method === 'approval/request' && row.frame.params?.action?.name === name && row.frame.params?.turnId !== previousTurn), 30000, `Mobile native ${name} ASK`, 40);
  await expect(page.getByTestId('approval-card')).toContainText(name); await page.getByTestId('approval-accept').click();
  await waitFor(() => frames.some(frame => frame.direction === 'sent' && frame.frame.id === row.frame.id && frame.frame.result?.decision === 'accept')
    && frames.some(frame => frame.frame.method === 'approval/resolved' && frame.frame.params?.approvalId === row.frame.params.approvalId && frame.frame.params?.threadId === row.frame.params.threadId && frame.frame.params?.turnId === row.frame.params.turnId), 10000, 'matching Mobile ASK broker receipt', 30);
}
async function currentTurn(frames, previous) {
  return waitFor(() => { const row = frames.findLast(row => row.direction === 'received' && row.frame.method === 'turn/started' && row.frame.params?.turn?.id !== previous); return row && { threadId: row.frame.params.threadId, turnId: row.frame.params.turn.id }; }, 10000, 'real mobile turn identity', 30);
}
async function completed(frames, turn, context) { return waitFor(() => frames.find(row => row.direction === 'received' && isTurnCompletion(row.frame, turn.threadId, turn.turnId)), 30000, 'real Mobile native turn terminal', 40, context.abortSignal); }
function nativeReceipts(frames, turn) { return frames.filter(row => row.direction === 'received' && row.frame.method === 'item/completed' && row.frame.params?.threadId === turn.threadId && row.frame.params?.turnId === turn.turnId).flatMap(row => row.frame.params.item?.webSources ? [row.frame.params.item.webSources] : []); }
function historySources(history) { return history.messages.flatMap(message => (message.blocks || []).flatMap(block => block.webSources ? [block.webSources] : [])); }
async function reveal(page) {
  for (const selector of ['[data-testid$="-toggle"][aria-expanded="false"]:visible', '[data-testid^="native-sources-toggle-"][aria-expanded="false"]:visible']) {
    for (let index = 0; index < 20; index++) {
      const first = page.locator(selector).first(); if (!await first.count()) break; await first.click();
    }
  }
}
