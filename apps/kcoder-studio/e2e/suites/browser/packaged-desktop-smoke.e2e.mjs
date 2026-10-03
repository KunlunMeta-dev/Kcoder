import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { startPackagedDesktop } from '../../harness/packaged-desktop.mjs';
import { runE2E, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';

// Uses the actual packaged Electron, Gateway, renderer and CLI. The fixture only
// removes model-quality variance from configuration, focus and restart assertions.
await runE2E(import.meta.url, { testId: 'packaged-desktop-model-save-focus-and-restart', tier: 'manual-live',
  modelPolicy: 'model-independent packaged transport and lifecycle; owned HTTP fixture' }, async context => {
  if (!process.env.KCODER_E2E_PACKAGED_DIR) throw new Error('UNMET_PREREQUISITE: KCODER_E2E_PACKAGED_DIR is required');
  const root = resolve(process.env.KCODER_E2E_PACKAGED_DIR);
  const windows = process.platform === 'win32';
  const cli = await requireExecutable(join(root, 'resources/bin', windows ? 'kcoder.exe' : 'kcoder'), 'packaged CLI');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'packaged-model' });
  const fixture = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: ({ userText }) => {
    const round = /packaged-round-(\d+)/.exec(userText)?.[1];
    return round === undefined ? 'PACKAGED_PROBE_OK' : `PACKAGED_REPLY_OK_${round}`;
  } });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Package fixture', transport: 'local', command: cli, workspace: workspace.path }]);
  await context.writeStateJson('home/settings.json', { providers: {} });
  await context.writeStateJson('home/credentials.json', {});
  for (let round = 0; round < 2; round++) {
    const label = `packaged-desktop-${round}`;
    const { page, stop } = await startPackagedDesktop(context, {
      root, label, servers, workspace: workspace.path,
    });
    const origin = new URL(page.url()).origin;
    await page.goto(origin + '/settings/personal/models', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('provider-new').waitFor();
    if (round === 0) {
      await page.getByTestId('provider-new').click();
      for (const [field, value] of Object.entries({ id: 'packaged-fixture', endpoint: fixture.baseUrl, model: 'packaged-model', apiKey: 'synthetic-package-key', 'extra-body': '{"temperature":0.2}' })) {
        await page.getByTestId(`provider-${field}`).fill(value);
      }
      await page.getByTestId('provider-save').click();
    }
    await page.locator('[data-testid^="provider-edit-packaged-fixture"]').waitFor({ timeout: 45000 });
    await page.locator('[data-testid^="provider-edit-packaged-fixture"]').click();
    assert.deepEqual(JSON.parse(await page.getByTestId('provider-extra-body').inputValue()), { temperature: 0.2 });
    await page.getByTestId('settings-back-button').click();
    const editor = page.getByTestId('chat-message-input');
    const marker = `packaged-round-${round}`;
    await editor.click(); await page.keyboard.insertText(`Reply briefly: ${marker}`);
    await page.getByTestId('send-message-button').click();
    await waitFor(() => fixture.requests.some(request => JSON.stringify(request.messages).includes(marker)), 45000, 'fresh packaged model request');
    await page.getByText(`PACKAGED_REPLY_OK_${round}`, { exact: true }).waitFor({ timeout: 45000 }).catch(async error => {
      await page.screenshot({ path: context.pathInArtifacts(`round-${round}-failure.png`) });
      await context.writeArtifactJson(`round-${round}-failure.json`, { modelRequests: fixture.requests.length, models: fixture.requests.map(request => request.model) });
      throw error;
    });
    await editor.click(); await page.keyboard.insertText('input-ready-after-reply');
    assert.match(await editor.innerText(), /input-ready-after-reply/);
    await context.writeArtifactJson(`round-${round}.json`, { configurationRestored: true, reply: true, composerFocusable: true, modelRequests: fixture.requests.length });
    await stop();
  }
});
