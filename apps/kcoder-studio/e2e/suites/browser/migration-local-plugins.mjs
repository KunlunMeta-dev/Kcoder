import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Extend the registered migration flow with an owned, inert local-plugin fixture. */
export async function exerciseLocalPluginMigration({ context, page, observer, profile, sourceRoot }) {
  assert.equal(resolve(sourceRoot), context.pathInState('sources/claude'));
  const initialization = observer.messages().find(value => value.result?.capabilities)?.result;
  assert.equal(initialization?.capabilities?.experimental?.migrationLocalPluginsV1, true,
    'the actual host must advertise its independent plugin migration capability');
  const name = 'migration-browser-plugin';
  const packageRoot = resolve(sourceRoot, `plugins/cache/browser-fixture/${name}/1.0.0`);
  const index = resolve(sourceRoot, 'plugins/installed_plugins.json');
  const marker = context.pathInState('plugin-source-must-not-run');
  const program = resolve(packageRoot, 'source-command.sh');
  const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;
  const files = new Map([
    [resolve(packageRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `sh ${quoted(program)}` }] }] },
      mcpServers: { 'plugin-source-fixture': { command: 'sh', args: [program] } } })],
    [resolve(packageRoot, 'skills/evidence/SKILL.md'), '---\nname: evidence\ndescription: Read supplied evidence\n---\nReport only the supplied evidence.\n'],
    [program, `#!/bin/sh\nprintf invoked > ${quoted(marker)}\n`],
    [index, JSON.stringify({ version: 2, plugins: { [`${name}@browser-fixture`]: [
      { scope: 'user', version: '1.0.0', installPath: packageRoot },
    ] } })],
  ]);
  const batchName = 'migration-unified-batch-plugin';
  const batchRoot = resolve(sourceRoot, `plugins/cache/browser-fixture/${batchName}/1.0.0`);
  const batchProgram = resolve(batchRoot, 'source-command.sh');
  files.set(resolve(batchRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: batchName,
    version: '1.0.0', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `sh ${quoted(batchProgram)}` }] }] } }));
  files.set(batchProgram, `#!/bin/sh\nprintf invoked > ${quoted(marker)}\n`);
  files.set(index, JSON.stringify({ version: 2, plugins: {
    [`${name}@browser-fixture`]: [{ scope: 'user', version: '1.0.0', installPath: packageRoot }],
    [`${batchName}@browser-fixture`]: [{ scope: 'user', version: '1.0.0', installPath: batchRoot }],
  } }));
  for (const [file, contents] of files) {
    await mkdir(resolve(file, '..'), { recursive: true });
    await writeFile(file, contents);
  }
  const unchanged = async () => {
    for (const [file, contents] of files) assert.equal(await readFile(file, 'utf8'), contents);
    assert.equal(await readFile(marker).then(() => true, error => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }), false, 'source Hook/MCP command must never execute');
  };
  const dialog = page.getByTestId('migration-dialog');
  await dialog.getByTestId('migration-mode-plugins').click();
  const panel = dialog.getByTestId('migration-plugins');
  await panel.getByTestId('migration-plugin-record-refresh').waitFor();
  assert.equal(await dialog.getByTestId('migration-batch-history-picker').count(), 0,
    'standalone local plugins do not silently join a configuration/history batch');
  await panel.getByTestId('migration-plugin-discover').click();
  const candidate = panel.locator('[data-testid^="migration-plugin-candidate-"]').filter({ hasText: name });
  await candidate.getByRole('button', { name: '准备插件包', exact: true }).click();
  await panel.getByTestId('migration-plugin-apply').waitFor();
  const result = panel.getByTestId('migration-plugin-result');
  const operationId = (await result.locator('details code').first().textContent()).trim();
  assert.match(operationId, /^[a-f0-9-]{36}$/);
  const prepared = await observer.request('migration/plugin/read', { operationId });
  assert.equal(prepared.job.stage, 'ready');
  assert.equal(prepared.job.imported, false);
  assert.equal(prepared.workerRunning, false);
  assert.ok(!(await observer.request('plugin/list', { all: true })).plugins.some(plugin => plugin.name === name));
  await unchanged();
  await panel.getByTestId('migration-plugin-apply').click();
  const confirmation = page.getByTestId('migration-plugin-confirmation');
  await confirmation.waitFor();
  assert.equal((await observer.request('migration/plugin/read', { operationId })).job.imported, false,
    'opening confirmation cannot publish an installation');
  await confirmation.getByTestId('migration-plugin-confirm').click();
  await panel.getByTestId('migration-plugin-undo').waitFor();
  const imported = await observer.request('migration/plugin/read', { operationId });
  assert.equal(imported.job.stage, 'imported');
  assert.equal(imported.job.imported, true);
  assert.equal(imported.workerRunning, false);
  const targetId = imported.job.targetId;
  const installed = (await observer.request('plugin/read', { pluginId: targetId })).plugin;
  assert.equal(installed.enabled, false);
  assert.equal((await observer.request('plugin/list', { all: true })).plugins.filter(plugin => plugin.id === targetId).length, 1);
  await unchanged();
  await page.screenshot({ path: context.pathInArtifacts('migration-local-plugin-imported.png') });
  await selectAdvancedMigration(dialog, 'batch');
  await dialog.getByTestId('migration-mode-plugins').click();
  await panel.getByTestId(`migration-plugin-open-${operationId}`).click();
  await panel.getByTestId('migration-plugin-undo').click();
  await confirmation.waitFor();
  assert.equal((await observer.request('migration/plugin/read', { operationId })).job.stage, 'imported');
  await confirmation.getByTestId('migration-plugin-confirm').click();
  await result.getByText('已撤销本次安装', { exact: true }).waitFor();
  const undone = await observer.request('migration/plugin/read', { operationId });
  assert.equal(undone.job.stage, 'undone');
  assert.equal(undone.job.imported, true, 'undo retains the historical Imported fact');
  assert.ok(!(await observer.request('plugin/list', { all: true })).plugins.some(plugin => plugin.id === targetId));
  assert.ok(await readFile(resolve(profile, 'plugin-migrations-v1', operationId, 'job.json')));
  await unchanged();
  await page.screenshot({ path: context.pathInArtifacts('migration-local-plugin-undone.png') });
  await selectAdvancedMigration(dialog, 'batch');
  await dialog.getByTestId('migration-batch-plugin-picker-toggle').click();
  const batchPicker = dialog.getByTestId('migration-plugins');
  await batchPicker.getByTestId('migration-plugin-discover').click();
  await batchPicker.locator('[data-testid^="migration-plugin-candidate-"]').filter({ hasText: batchName })
    .getByRole('button', { name: '准备插件包', exact: true }).click();
  await batchPicker.getByTestId('migration-plugin-select-batch').waitFor();
  assert.equal(await batchPicker.getByTestId('migration-plugin-apply').count(), 0,
    'the batch picker cannot accidentally install outside the shared confirmation');
  const batchOperation = (await batchPicker.getByTestId('migration-plugin-result').locator('details code').first().textContent()).trim();
  await batchPicker.getByTestId('migration-plugin-select-batch').click();
  await dialog.getByTestId('migration-batch-selected-plugins').getByText(batchName, { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '预览所选来源', exact: true }).click();
  await dialog.getByRole('heading', { name: '选择迁移内容', exact: true }).waitFor();
  await dialog.getByTitle(batchName, { exact: true }).waitFor();
  assert.equal((await observer.request('migration/plugin/read', { operationId: batchOperation })).job.imported, false);
  await dialog.getByRole('button', { name: '确认所选内容', exact: true }).click();
  await dialog.getByRole('heading', { name: '确认批量计划', exact: true }).waitFor();
  assert.equal((await observer.request('migration/plugin/read', { operationId: batchOperation })).job.imported, false);
  await dialog.getByRole('button', { name: '开始批量迁移', exact: true }).click();
  await dialog.getByText('已迁入 1 / 1 项', { exact: true }).waitFor();
  const batchImported = await observer.request('migration/plugin/read', { operationId: batchOperation });
  assert.equal(batchImported.job.stage, 'imported');
  assert.match(batchImported.job.batchJobId, /^mig-[a-f0-9]{32}$/);
  assert.equal((await observer.request('plugin/read', { pluginId: batchImported.job.targetId })).plugin.enabled, false);
  await page.screenshot({ path: context.pathInArtifacts('migration-unified-plugin-imported.png') });
  await dialog.getByRole('button', { name: '撤销本次导入', exact: true }).click();
  await dialog.getByText('本次新增内容已撤销', { exact: true }).waitFor();
  assert.equal((await observer.request('migration/plugin/read', { operationId: batchOperation })).job.stage, 'undone');
  await unchanged();
  await context.writeArtifactJson('migration-unified-plugin-roundtrip.json', { operationId: batchOperation,
    batchJobId: batchImported.job.batchJobId, targetId: batchImported.job.targetId,
    explicitReadyPackageSelection: true, noStandaloneApplyInPicker: true, sharedPreviewAndConfirmation: true,
    defaultDisabled: true, parentOwnsUndo: true, sourceUnchanged: true, sourceCommandExecuted: false,
    scope: 'Actual Browser/Gateway/app-server prepared-plugin selection and unified batch installation/undo; not Windows or complete project mapping.' });
  await context.writeArtifactJson('migration-local-plugin-roundtrip.json', { operationId, targetId,
    independentCapability: true, standaloneBranch: true, explicitPreparation: true,
    confirmationBeforeInstall: true, defaultDisabled: true, reopenedFromRecord: true,
    explicitUndo: true, importedFactAndAuditRetained: true, sourceUnchanged: true,
    sourceCommandExecuted: false,
    sourceFiles: [...files].map(([file, text]) => ({ relativePath: file.slice(sourceRoot.length + 1),
      sha256: createHash('sha256').update(text).digest('hex') })),
    scope: 'Actual registered Browser/Gateway/app-server local-package workflow; no unified plugin batch, native desktop installation or Windows C3 acceptance claim.' });
}
