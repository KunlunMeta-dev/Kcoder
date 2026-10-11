import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'provider-usage-through-runtime-persistence-and-settings', tier: 'full-integration',
  modelPolicy: 'model-independent provider usage normalization and durable counters; loopback synthetic SSE only',
}, async context => {
  // QA: fresh profile, real SSE usage trailer -> Rust ledger -> RPC -> settings, then delete
  // the conversation and restart Gateway. Invalid params and missing usage remain explicit.
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'usage' });
  const options = { textOnly: true, textOnlyResponse: 'USAGE_FIXTURE_OK',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 } } };
  const model = await startApprovalModelFixture(context, options);
  const settingsFile = await context.writeStateJson('profile/settings.json', {
    active_provider: 'usage-fixture', max_retries: 0,
    providers: { 'usage-fixture': { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      default_model: 'usage-fixture', context_window_tokens: 128000, max_output_tokens: 4096,
      output_headroom_tokens: 4096, no_proxy: true } },
  });
  context.registerSecret('fixture-usage-key');
  await context.writeStateJson('profile/credentials.json', { 'usage-fixture': { type: 'api', key: 'fixture-usage-key' } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Usage fixture',
    transport: 'local', command: resolve(repoRoot, 'target/debug/kcoder'), workspace, settingsFile }]);
  const gatewayOptions = { workspace, serversFile, env: { KCODER_CONFIG_DIR: context.pathInState('profile') } };
  let gateway = await startGateway(context, { ...gatewayOptions, label: 'usage-first' });
  let rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
  context.addCleanup('close usage RPC', () => rpc.close());
  const initialized = await initializeRpc(rpc, 'usage-check');
  assert.equal(initialized.capabilities.experimental.usageHistory, true);
  assert.equal((await rpc.request('usage/stats')).history, null);
  await assert.rejects(rpc.request('usage/stats', { path: '/not-authorized' }), /empty parameter object/);
  const started = await rpc.request('thread/start');
  const threadId = started.thread.id;
  const turn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'PRIVATE_USAGE_PROMPT' }] });
  const completion = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.turn.id,
    30000, 'usage fixture completion');
  await context.writeArtifactJson('provider-check.json', { providerAttempts: model.requests.length,
    completion: completion.params, errors: rpc.messages().filter(message => message.method === 'error' || message.method === 'turn/error') });
  assert.equal(model.requests.length, 1, 'the usage request must reach the loopback provider');
  const first = await rpc.request('usage/stats');
  const counters = Object.values(first.history.days)[0]['usage-fixture'];
  assert.equal(counters.requests, 1);
  assert.equal(counters.inputTokens, 100);
  assert.equal(counters.outputTokens, 20);
  assert.equal(counters.totalTokens, 120);
  assert.equal(counters.cacheReadTokens, 80);
  assert.equal(counters.estimatedTotalRequests, 0);
  assert.equal(counters.unreportedRequests, 0);
  const ledger = await readFile(context.pathInState('profile/usage/usage.json'), 'utf8');
  assert.ok(!ledger.includes('PRIVATE_USAGE_PROMPT') && !ledger.includes('fixture-usage-key'));
  await rpc.request('thread/delete', { threadId });
  rpc.close();
  await context.stopOwned('usage-first');
  gateway = await startGateway(context, { ...gatewayOptions, label: 'usage-second' });
  rpc = await openRpc(gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway)));
  await initializeRpc(rpc, 'usage-reader');
  assert.deepEqual((await rpc.request('usage/stats')).history, first.history);
  const browser = await startChromium(context, { label: 'usage-browser' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const diagnostics = [];
  page.on('pageerror', error => diagnostics.push({ kind: 'script', message: error.message }));
  page.on('requestfailed', request => diagnostics.push({ kind: 'request', url: request.url().split('?')[0], error: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400) diagnostics.push({ kind: 'response', status: response.status(), url: response.url().split('?')[0] }); });
  try {
    await page.goto(`${gateway.baseUrl}/settings/usage`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('usage-totalTokens')).toHaveText('120', { timeout: 30000 });
    await expect(page.getByTestId('usage-table').locator('tbody tr')).toHaveCount(30);
    await page.getByTestId('usage-view-models').click();
    await expect(page.getByTestId('usage-table')).toContainText('usage-fixture');
    await expect(page.getByTestId('usage-table')).toContainText('80');
    await page.reload();
    await expect(page.getByTestId('usage-totalTokens')).toHaveText('120');
    await page.screenshot({ path: context.pathInArtifacts('usage-settings.png') });
    return { passed: true, providerAttempts: model.requests.length, usageTrailerPersisted: true,
      deletionAndRestartPreservedCounters: true, dailyRows: 30, modelBreakdown: true, metadataOnly: true };
  } catch (error) {
    await context.writeArtifactJson('renderer-diagnostics.json', { diagnostics: diagnostics.slice(-100),
      page: await page.evaluate(() => ({ text: document.body.innerText.slice(0, 4000), scripts: [...document.scripts].map(script => script.src) })).catch(() => null) });
    await page.screenshot({ path: context.pathInArtifacts('usage-failed.png') }).catch(() => {});
    throw error;
  }
});
