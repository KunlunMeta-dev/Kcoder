import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';

export async function seedProjectPluginFixture(context, claude, codex, profile, workspace) {
  const marker = context.pathInState('PLUGIN_SOURCE_COMMAND_MUST_NOT_RUN');
  await writeFile(resolve(profile, 'trusted-folders.json'), JSON.stringify({ trusted: [workspace], never: [] }), { mode: 0o600 });
  const packages = {};
  for (const [kind, root, scope] of [['claude-code', claude, 'local'], ['codex', codex, 'project']]) {
    const name = kind === 'codex' ? 'transfer-codex-project' : 'transfer-claude-local';
    const packageRoot = resolve(root, `plugins/cache/owned-fixture/${name}/1.0.0`), format = kind === 'codex' ? '.codex-plugin' : '.claude-plugin';
    await mkdir(resolve(packageRoot, format), { recursive: true, mode: 0o700 });
    await mkdir(resolve(packageRoot, 'skills/evidence'), { recursive: true, mode: 0o700 });
    await writeFile(resolve(packageRoot, format, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', mcpServers: { inert: { command: 'sh', args: ['${PLUGIN_ROOT}/source-command.sh'] } }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sh \"${PLUGIN_ROOT}/source-command.sh\"' }] }] } }), { mode: 0o600 });
    await writeFile(resolve(packageRoot, 'skills/evidence/SKILL.md'), '---\nname: evidence\ndescription: Read supplied evidence\n---\nNever execute this synthetic fixture.\n', { mode: 0o600 });
    await writeFile(resolve(packageRoot, 'source-command.sh'), `#!/bin/sh\nprintf invoked > '${marker.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
    if (kind === 'claude-code') {
      await writeFile(resolve(root, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [`${name}@owned-fixture`]: [{ scope, projectPath: workspace, installPath: packageRoot, version: '1.0.0' }] } }), { mode: 0o600 });
      await mkdir(resolve(workspace, '.claude'), { recursive: true, mode: 0o700 });
      await writeFile(resolve(workspace, '.claude/settings.local.json'), JSON.stringify({ enabledPlugins: { [`${name}@owned-fixture`]: true } }), { mode: 0o600 });
    } else {
      await mkdir(resolve(workspace, '.codex'), { recursive: true, mode: 0o700 });
      await writeFile(resolve(workspace, '.codex/config.toml'), `[plugins."${name}@owned-fixture"]\nenabled=true\n`, { mode: 0o600 });
    }
    packages[kind] = { root, name, scope };
  }
  return { packages, marker };
}

/** The UI uses source-owned grants, received adoption, and the existing ordinary installer. */
export async function exerciseProjectPluginUi({ context, page, gateway, profile, workspace, fixture, model, mobile = false, openUploaded }) {
  const target = mobile ? 'migration-target' : 'fixture-target';
  const observer = await openOwnedMobileRpc(context, gateway, target, workspace);
  const native = (method, params) => observer.rpc.request(method, params);
  const original = await readFile(resolve(profile, 'settings.json')), results = [];
  let checkpoint = { kind: null, stage: 'starting' };
  try {
    if (!mobile) { await page.goto(`${gateway.baseUrl}/settings/general`); await page.getByTestId('general-language-en-button').click(); }
    for (const kind of ['claude-code', 'codex']) {
      checkpoint = { kind, stage: 'source-open' };
      if (openUploaded) await openUploaded(kind);
      else if (mobile) {
        await page.getByTestId('migration-tab-source').click(); await page.getByTestId('migration-source-remote-mode').click(); await page.getByTestId(`source-device-${target}`).click();
        const source = page.getByTestId('migration-source-browser'); await source.getByTestId(`source-browser-product-${kind}`).click(); await source.getByTestId('source-browser-mode-plugins').click();
        await source.getByTestId('source-browser-project-consent').click(); await source.getByTestId('source-browser-discover').click();
        await source.locator('[data-testid^="source-browser-select-"]').first().waitFor(); assert.equal(await source.locator('[data-testid^="source-browser-select-"]').count(), 1);
        await source.locator('[data-testid^="source-browser-select-"]').first().click(); await source.getByTestId('source-browser-transfer').click();
        await source.getByTestId('source-transfer-status').getByText('Sources received; not imported', { exact: true }).waitFor({ timeout: 30000 });
      } else {
        await page.getByTestId('general-external-content-import-button').click(); const dialog = page.getByTestId('migration-dialog'); await dialog.locator('#migration-target').selectOption(target);
        await selectAdvancedMigration(dialog, 'source'); const source = dialog.getByTestId('migration-source-browser'); await source.locator('#migration-source-device').selectOption(target);
        await source.getByTestId('migration-source-mode-plugins').click(); const panel = source.getByTestId('migration-plugin-source-browser');
        await panel.getByRole('button', { name: kind === 'codex' ? 'Codex' : 'Claude Code', exact: true }).click(); await panel.getByRole('checkbox', { name: /trusted source workspace/i }).check();
        await panel.getByRole('button', { name: 'Find migration sources', exact: true }).click(); await panel.getByTestId('migration-plugin-source-row').first().waitFor();
        assert.equal(await panel.getByTestId('migration-plugin-source-row').count(), 1); await panel.getByTestId('migration-plugin-source-row').getByRole('checkbox').check();
        await panel.getByRole('button', { name: /Transfer selected data/ }).click(); await panel.getByTestId('migration-transfer-status').getByText('Data received', { exact: true }).waitFor({ timeout: 30000 });
      }
      checkpoint = { kind, stage: 'received' };
      await rename(fixture.packages[kind].root, `${fixture.packages[kind].root}-withheld`);
      const adoption = page.getByTestId('migration-source-adoption'); await adoption.getByTestId(mobile ? 'source-adoption-expand' : 'migration-adoption-expand').click();
      if (mobile) { await adoption.locator('[data-testid^="source-adoption-select-"]').first().waitFor(); await adoption.locator('[data-testid^="source-adoption-select-"]').first().click(); if (fixture.packages[kind].scope !== 'user') await adoption.locator('[data-testid^="source-adoption-map-"]').first().click(); }
      else { const row = adoption.getByTestId('migration-adoption-received-row'); await row.waitFor(); await row.getByRole('checkbox').first().check(); if (fixture.packages[kind].scope !== 'user') await row.locator('[data-testid^="migration-adoption-map-"]').check(); }
      await adoption.getByTestId(mobile ? 'source-adoption-prepare' : 'migration-adoption-prepare').click(); await adoption.getByText(mobile ? 'Preview Ready; not saved' : 'Previews ready; nothing saved yet', { exact: true }).waitFor({ timeout: 30000 });
      const open = adoption.locator(`[data-testid^="${mobile ? 'source-adoption-open-' : 'migration-adoption-open-'}"]`).first();
      const jobId = (await open.getAttribute('data-testid')).split(mobile ? 'source-adoption-open-' : 'migration-adoption-open-')[1];
      const children = (await native('migration/plugin/list', {})).items.filter(row => row.batchJobId === jobId); assert.equal(children.length, 1); assert.equal(children[0].imported, false);
      await open.click(); checkpoint = { kind, stage: 'normal-preview', jobId };
      const items = (await native('migration/items', { jobId })).items;
      assert.equal(items.length, 1); assert.equal(items[0].category, 'plugin');
      const identifier = `received-${kind}-plugin`;
      if (mobile) {
        await page.getByTestId('migration-batch-editor').waitFor(); await page.getByTestId(`migration-item-edit-${items[0].id}`).click();
        await page.getByTestId('migration-item-name').fill(identifier); assert.equal(await page.getByTestId('migration-item-enable').count(), 0);
        await page.getByTestId('migration-item-save').click();
      } else {
        const row = page.getByTestId('migration-content-item').filter({ hasText: items[0].sourceName }); await row.getByRole('button', { name: 'Configure', exact: true }).click();
        await row.getByLabel('Plugin installation identifier (keeps the manifest display name)', { exact: true }).fill(identifier);
        await row.getByRole('button', { name: 'Save options and select', exact: true }).click();
      }
      if (mobile) { await page.getByTestId('migration-batch-editor').waitFor(); await page.getByTestId('migration-preview-plan').click(); await page.getByTestId('migration-batch-operation').waitFor(); await page.getByTestId('migration-batch-import').click(); await page.getByTestId('migration-batch-confirm-input').fill('IMPORT'); await page.getByTestId('migration-batch-confirm-submit').click(); }
      else { const dialog = page.getByTestId('migration-dialog'); await dialog.getByRole('button', { name: 'Confirm selected content', exact: true }).click(); await dialog.getByRole('button', { name: 'Start batch migration', exact: true }).click(); }
      await waitFor(async () => { const result = await native('migration/batch/read', { jobId }); return result.state.job.committedItems === 1 && !result.workerRunning; }, 30000, 'received project plugin installed via its original normal batch');
      assert.equal((await native('migration/batch/read', { jobId })).state.job.hasUnconfirmedOutcomes, false);
      const child = (await native('migration/plugin/read', { operationId: children[0].operationId })).job; assert.equal(child.imported, true); assert.equal(child.scope, fixture.packages[kind].scope);
      assert.ok(child.targetId.startsWith(`${identifier}@`));
      assert.equal((await native('plugin/read', { pluginId: child.targetId })).plugin.enabled, false);
      checkpoint = { kind, stage: 'original-undo', jobId };
      if (mobile) { await page.getByTestId('migration-tab-records').click(); await page.getByTestId(`migration-batch-record-${jobId}`).click(); await page.getByTestId('migration-batch-undo').click(); await page.getByTestId('migration-batch-confirm-input').fill('UNDO'); await page.getByTestId('migration-batch-confirm-submit').click(); }
      else { await page.getByTestId('migration-dialog').getByRole('button', { name: 'Close', exact: true }).click(); await page.getByTestId('general-external-content-import-button').click(); const dialog = page.getByTestId('migration-dialog'); await dialog.locator('#migration-target').selectOption(target); await dialog.getByRole('button', { name: 'Migration records', exact: true }).click(); await dialog.getByRole('button').filter({ hasText: `${kind === 'codex' ? 'Codex' : 'Claude Code'} ·` }).first().click(); await dialog.getByRole('button', { name: 'Undo this import', exact: true }).click(); }
      await waitFor(async () => (await native('migration/batch/read', { jobId })).state.job.status === 'rolled_back', 30000, 'unchanged project plugin undone by its original owner');
      const undone = (await native('migration/plugin/read', { operationId: child.operationId })).job;
      assert.equal(undone.imported, true); assert.equal(undone.stage, 'undone');
      assert.equal((await readFile(resolve(profile, 'settings.json'))).equals(original), true); results.push({ source: kind, scope: child.scope, jobId, childOperationId: child.operationId, undoStage: undone.stage, defaultDisabled: true, sourceRemoved: true, normalBatchUndo: true });
      if (!mobile) await page.getByTestId('migration-dialog').getByRole('button', { name: 'Close', exact: true }).click();
    }
    assert.equal(await access(fixture.marker).then(() => true, () => false), false); assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('project-plugin-transfer-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web Chromium' : 'Studio Web Chromium', results, modelRequests: 0, sourceCommandExecuted: false, targetUserSettingsUnchanged: true });
    return { sources: 2, defaultDisabledPlugins: 2, mappedDefaultDisabledPlugins: Object.values(fixture.packages).filter(row => row.scope !== 'user').length, ordinaryBatchUndo: true, modelRequests: 0 };
  } catch (error) { await context.writeArtifactJson('project-plugin-transfer-checkpoint.json', { checkpoint, results }); throw error; }
  finally { await observer.close(); }
}
