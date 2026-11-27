import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';

/** First-use is an optional entry to the existing Native migration UI, not a second importer. */
export async function exerciseMigrationFirstUse({ context, page, gateway, browser, profile, model }) {
  const path = resolve(profile, 'settings.json'), original = await readFile(path);
  const records = [], turns = [], reads = [];
  const observe = selected => selected.on('websocket', socket => {
    const pending = new Set();
    socket.on('framesent', frame => {
      try {
        const message = JSON.parse(frame.payload);
        for (let value = message, depth = 0; value && typeof value === 'object' && depth < 3; value = value.params, depth++) {
          if (value.method === 'turn/start') turns.push(message.id);
          if (value.method === 'runtime.providers.list') pending.add(message.id);
        }
      } catch { /* Other transport frames are not provider reads or model turns. */ }
    });
    socket.on('framereceived', frame => {
      try { const message = JSON.parse(frame.payload); if (pending.delete(message.id) && !message.error) reads.push(message.id); } catch { /* Ignore non-JSON transport frames. */ }
    });
  });
  observe(page);
  await page.goto(`${gateway.baseUrl}/`);
  await page.getByTestId('empty-project-title-button').filter({ hasText: 'Migration target' }).waitFor();
  const first = page.getByTestId('migration-first-use');
  await first.getByTestId('migration-first-use-import').waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('migration-dialog').count(), 0, 'the first-use entry is not an automatic modal');
  await first.getByTestId('migration-first-use-import').click();
  let dialog = page.getByTestId('migration-dialog');
  await dialog.waitFor(); assert.equal(await dialog.locator('#migration-target').inputValue(), 'fixture-target');
  assert.equal(await dialog.locator('#migration-target').isDisabled(), true);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await first.getByTestId('migration-first-use-import').waitFor();
  assert.deepEqual(await readFile(path), original, 'closing first-use migration cannot publish anything');
  await first.getByTestId('migration-first-use-skip').click();
  const beforeReload = reads.length;
  await page.reload();
  await page.getByTestId('empty-project-title-button').filter({ hasText: 'Migration target' }).waitFor();
  await waitFor(() => reads.length > beforeReload, 10000, 'fresh authoritative provider read after skipping');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId('migration-first-use').count(), 0, 'skip survives a reload in this original target/account scope');
  assert.equal(await page.getByTestId('migration-dialog').count(), 0);
  assert.deepEqual(await readFile(path), original);

  // Another owned browser has its own client preference and the same authoritative target settings.
  const fresh = await browser.browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.addCleanup('close first-use manual-settings browser context', () => fresh.close());
  const manual = await fresh.newPage(); observe(manual);
  await manual.goto(`${gateway.baseUrl}/settings/model-settings`);
  const settings = manual.getByTestId('kcoder-provider-settings-page');
  await settings.getByTestId('migration-first-use-import').waitFor({ timeout: 30000 });
  const secret = 'SYNTHETIC_FIRST_USE_UNSENT_KEY'; context.registerSecret(secret);
  await settings.getByTestId('provider-id').fill('UnsentManual');
  await settings.getByTestId('provider-model').fill('unsent-manual-model');
  await settings.getByTestId('provider-apiKey').fill(secret);
  await settings.getByTestId('migration-first-use-import').click();
  dialog = manual.getByTestId('migration-dialog'); await dialog.waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await waitFor(async () => !(await settings.getByTestId('provider-id').isDisabled()), 10000, 'read-only refresh after closing migration');
  assert.equal(await settings.getByTestId('provider-id').inputValue(), 'UnsentManual');
  assert.equal(await settings.getByTestId('provider-apiKey').inputValue(), secret);
  assert.deepEqual(await readFile(path), original);
  await settings.getByTestId('migration-first-use-import').click();
  dialog = manual.getByTestId('migration-dialog'); await dialog.waitFor();
  assert.equal(await dialog.locator('#migration-target').inputValue(), 'fixture-target');
  await selectAdvancedMigration(dialog, 'single');
  await dialog.getByRole('button', { name: '查找可迁移内容', exact: true }).click();
  await dialog.getByRole('button', { name: /Claude Code · 用户配置/ }).click();
  await dialog.getByLabel('保存后的连接名称').fill('FirstImported');
  await dialog.getByLabel('上下文额度', { exact: true }).fill('128000');
  await dialog.getByLabel('输出预留额度', { exact: true }).fill('8192');
  await dialog.getByLabel('最大输出额度', { exact: true }).fill('8192');
  await dialog.getByRole('button', { name: '生成迁移预览', exact: true }).click();
  await dialog.getByRole('heading', { name: '确认迁移', exact: true }).waitFor();
  assert.deepEqual(await readFile(path), original);
  await dialog.getByRole('button', { name: '开始迁移', exact: true }).click();
  await dialog.getByText('连接配置已保存', { exact: true }).waitFor({ timeout: 30000 });
  await waitFor(async () => JSON.parse(await readFile(path, 'utf8')).providers.FirstImported, 10000, 'existing Native importer publishes the first connection');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.active_provider, null, 'first-use does not choose a default automatically');
  assert.equal(saved.providers.UnsentManual, undefined, 'the unsent manual editor is not a migration payload');
  assert.ok(!JSON.stringify(saved).includes(secret));
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await waitFor(async () => !(await settings.getByTestId('provider-id').isDisabled()), 10000, 'refresh saved definitions without replacing the old draft');
  assert.equal(await settings.getByTestId('provider-id').inputValue(), 'UnsentManual');
  assert.equal(await settings.getByTestId('provider-model').inputValue(), 'unsent-manual-model');
  assert.equal(await settings.getByTestId('provider-apiKey').inputValue(), secret);
  assert.equal(await settings.getByTestId('migration-first-use-import').count(), 0, 'an existing explicit definition does not restart first-use import');
  await manual.goto(`${gateway.baseUrl}/`);
  await manual.getByTestId('desktop-empty-hero-column').waitFor();
  await manual.getByText('已有模型连接，还需补齐配置', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await manual.getByTestId('migration-first-use-import').count(), 0);
  await manual.reload();
  await manual.getByText('已有模型连接，还需补齐配置', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await manual.getByTestId('migration-dialog').count(), 0);
  assert.equal(model.requests.length, 0); assert.equal(turns.length, 0);
  records.push({ emptySettingsConfirmed: true, optionalEntryNotModal: true, originalTargetPinned: true, closeReturnsToGuide: true,
    skipPersistsWithoutTargetWrites: true, manualDraftPreservedOnCloseAndImport: true, nativeImportSaved: true,
    existingDefinitionDoesNotRestartFirstUse: true, incompleteConnectionExplained: true, defaultUnchanged: true, modelRequests: 0 });
  await context.writeArtifactJson('migration-first-use-roundtrip.json', { passed: true, records });
  return { firstUseEntry: true, skip: true, existingImporter: true, unsentDraftPreserved: true, defaultUnchanged: true, modelRequests: 0 };
}
