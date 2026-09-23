import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { startChromium } from '../../harness/chromium.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'archived-navigation-and-readonly-history', tier: 'full-integration',
  modelPolicy: 'model-independent archived multi-page history, reopen and explicit restore; owned transport fixture' }, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const fixture = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: ({ requestNumber }) => `ARCHIVE_REPLY_${String(requestNumber).padStart(3, '0')}` });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'archived-read' });
  const settings = await context.writeStateJson('config/settings.json', { active_provider: 'fixture', providers: { fixture: {
    api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: fixture.baseUrl,
    default_model: 'fixture', context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192, no_proxy: true,
  } } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Archive fixture', transport: 'local', command: binary, workspace, settingsFile: settings }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: dirname(settings) } });
  const url = gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway));
  const seed = await openRpc(url); context.addCleanup('close archive seed', () => seed.close());
  await initializeRpc(seed, 'archive-seed');
  const { thread } = await seed.request('thread/start');
  const { turn } = await seed.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Archive preview fixture' }] });
  await seed.waitFor(m => m.method === 'turn/completed' && m.params?.threadId === thread.id && m.params?.turnId === turn.id, 30000, 'archive seed completion');
  // 31 committed turns exceed the preview's 50-message page without mutating private
  // session files. Every model-independent transport response has a unique marker.
  for (let index = 2; index <= 31; index++) {
    const next = await seed.request('turn/start', { threadId: thread.id,
      input: [{ type: 'text', text: `ARCHIVE_PROMPT_${String(index).padStart(3, '0')}` }] });
    await seed.waitFor(m => m.method === 'turn/completed' && m.params?.threadId === thread.id
      && m.params?.turnId === next.turn.id, 30000, `archive turn ${index}`);
  }
  const archivedAt = new Date().toISOString();
  await seed.request('thread/metadata/update', { threadId: thread.id, title: 'Archive preview fixture', archivedAt });
  // Real archived rows provide scrollable content without additional model calls.
  for (let index = 0; index < 18; index++) {
    const fork = await seed.request('thread/fork', { threadId: thread.id, lastTurnId: turn.id });
    await seed.request('thread/metadata/update', { threadId: fork.thread.id, title: `Archive scroll row ${index}`, archivedAt });
  }
  seed.close();
  const browser = await startChromium(context); const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(gateway.baseUrl); await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-menu-button').click();
  await page.getByTestId('settings-category-archived').click();
  await page.locator('[data-testid^="archived-open-button-"]').first().waitFor();
  const controls = page.getByTestId('archived-filter-controls');
  const topBefore = await controls.evaluate(element => element.getBoundingClientRect().top);
  await page.locator('[data-testid^="archived-open-button-"]').first().hover();
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(before => {
    const controls = document.querySelector('[data-testid="archived-filter-controls"]');
    return controls && controls.getBoundingClientRect().top < before - 250;
  }, topBefore, { timeout: 10000 });
  await controls.scrollIntoViewIfNeeded();
  await page.getByTestId('archived-search-input').fill('Archive preview fixture');
  const open = page.locator('[data-testid^="archived-open-button-"]').filter({ hasText: 'Archive preview fixture' });
  await open.click();
  const preview = page.getByTestId('archived-preview');
  await preview.getByText('ARCHIVE_REPLY_031', { exact: true }).waitFor();
  assert.equal(await preview.getByText('ARCHIVE_REPLY_001', { exact: true }).count(), 0,
    'first page must genuinely omit older messages');
  await preview.getByRole('button', { name: /更早|earlier/i }).click();
  await preview.getByText('ARCHIVE_REPLY_001', { exact: true }).waitFor();
  for (let index = 1; index <= 31; index++) {
    assert.equal(await preview.getByText(`ARCHIVE_REPLY_${String(index).padStart(3, '0')}`, { exact: true }).count(), 1,
      `reply ${index} must occur exactly once across pages`);
  }
  assert.equal(await preview.locator('article').count(), 62, 'all committed user/assistant messages appear once');
  assert.equal(await preview.getByRole('button', { name: /更早|earlier/i }).count(), 0);
  await page.getByTestId('archived-preview-close').click();
  await open.click();
  await preview.getByText('ARCHIVE_REPLY_031', { exact: true }).waitFor();
  assert.equal(await preview.getByText('ARCHIVE_REPLY_001', { exact: true }).count(), 0, 'reopening starts from a fresh last-page projection');
  await preview.getByRole('button', { name: /更早|earlier/i }).click();
  await preview.getByText('ARCHIVE_REPLY_001', { exact: true }).waitFor();
  assert.equal(await preview.locator('article').count(), 62);
  await page.getByTestId('archived-preview-close').click();
  assert.equal(await open.count(), 1, 'preview must not remove the archive row');
  const verify = await openRpc(url); context.addCleanup('close archive verifier', () => verify.close());
  await initializeRpc(verify, 'archive-verifier');
  const list = await verify.request('thread/list', { archived: true });
  assert.ok(JSON.stringify(list).includes(thread.id), 'viewing history must preserve server archive state');
  assert.equal(fixture.requests.length, 31, 'viewing, pagination and reopening must not issue model requests');
  await page.locator('[data-testid^="archived-unarchive-button-"]').click();
  await open.waitFor({ state: 'detached' });
  const afterRestore = await verify.request('thread/list', { archived: true });
  assert.ok(!JSON.stringify(afterRestore).includes(thread.id), 'explicit restore removes only the selected archive');
  const active = await verify.request('thread/list', { archived: false });
  assert.ok(JSON.stringify(active).includes(thread.id), 'restored thread appears in active history');
  assert.equal(fixture.requests.length, 31, 'restore is metadata-only');
  await context.writeArtifactJson('archive-readonly.json', { archivedAt, navigationClickable: true, filtersScrollWithContent: true, searchAfterScroll: true, previewLoaded: true, archivePreservedUntilExplicitRestore: true, pages: 2, committedMessages: 62, reopenVerified: true, restoreVerified: true });
});
