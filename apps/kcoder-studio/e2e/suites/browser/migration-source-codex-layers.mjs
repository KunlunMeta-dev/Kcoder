import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { seedCodexLayerFixture } from './migration-codex-layers.mjs';

export async function seedSourceCodexLayers(context, source, destinationProfile, destinationWorkspace) {
  const fixture = await seedCodexLayerFixture(context, context.pathInState('history-source/workspace'), source.codex, source.profile);
  // Known ignored project fields retain notices; unknown blocking fields belong to the separate report test.
  const nearest = "model='codex-nearest-model'\nmodel_reasoning_effort='low'\n";
  const file = resolve(fixture.local, 'config.toml');
  await writeFile(file, nearest, { mode: 0o600 });
  fixture.files = fixture.files.map(([path, bytes]) => [path, path === file ? nearest : bytes]);
  const ignored = fixture.files.find(([path]) => path === resolve(fixture.project, 'config.toml'));
  ignored[1] = ignored[1].replace('[model_providers.', "openai_base_url='https://ignored.invalid'\nchatgpt_base_url='https://ignored.invalid'\napps_mcp_product_sku='ignored'\nexperimental_realtime_ws_base_url='wss://ignored.invalid'\n[model_providers.");
  await writeFile(ignored[0], ignored[1], { mode: 0o600 });
  await writeFile(resolve(destinationProfile, 'trusted-folders.json'), JSON.stringify({ trusted: [destinationWorkspace], never: [] }), { mode: 0o600 });
  return fixture;
}

/** Real source-only query, original transfer snapshot and ordinary project batch publication. */
export async function exerciseSourceCodexLayers({ context, page, gateway, fixture, destinationProfile, workspace, model }) {
  const observer = await openOwnedMobileRpc(context, gateway, 'fixture-target', workspace);
  const originalSettings = await readFile(resolve(destinationProfile, 'settings.json'));
  const queries = [], reports = [], selections = [], runs = [], closes = [];
  const onRequest = request => {
    if (request.url().endsWith('/api/migration/source-session/query')) queries.push(request.postDataJSON());
    if (request.url().endsWith('/api/migration/source-transfer/run')) runs.push(request.postDataJSON());
  };
  const onResponse = async response => {
    try {
      if (!response.ok()) return;
      if (response.url().endsWith('/api/migration/source-session/query')) {
        const body = response.request().postDataJSON(), value = await response.json();
        if (body.query.kind === 'codex_layers_read') reports.push(value);
        if (body.query.kind === 'codex_layers_select') selections.push(value);
      }
      if (response.url().endsWith('/api/migration/source-session/close') && (await response.json()).status === 'released') closes.push(response.request().postDataJSON());
    } catch { /* Visible completion and Native readback below remain authoritative. */ }
  };
  page.on('request', onRequest); page.on('response', onResponse);
  try {
    const dialog = page.getByTestId('migration-dialog');
    await selectAdvancedMigration(dialog, 'source');
    const browser = page.getByTestId('migration-source-browser');
    await browser.locator('#migration-source-device').selectOption('history-source-target');
    await browser.getByRole('button', { name: 'Codex', exact: true }).click();
    await browser.getByRole('checkbox', { name: '同时检查当前受信任项目的配置', exact: true }).check();
    await browser.getByRole('button', { name: '查找可迁移内容', exact: true }).click();
    const named = browser.locator('li').filter({ hasText: 'Codex · review.config.toml' });
    await named.waitFor(); await named.getByRole('checkbox').check();
    assert.equal(await browser.getByTestId('migration-codex-report').count(), 0);
    await named.getByRole('button', { name: '合并项目模型覆盖…', exact: true }).click();
    await waitFor(() => selections.length === 1, 10000, 'Native derived source identity');
    const derived = selections[0];
    assert.equal(derived.source.scope, 'codex-project-layers');
    assert.ok(derived.replacesSourceIds.includes(queries.find(value => value.query.kind === 'codex_layers_select').query.params.sourceId));
    const row = browser.locator('li').filter({ has: page.getByTestId('migration-codex-report') });
    await row.waitFor(); assert.equal(await row.getByRole('checkbox').isChecked(), true);
    assert.equal(await browser.getByRole('checkbox', { checked: true }).count(), 2, 'only the derived model plus project consent remain selected');
    let report = row.getByTestId('migration-codex-report');
    await report.getByTestId('migration-codex-report-toggle').click();
    await waitFor(async () => await report.getByTestId('migration-codex-field').count() === 10, 10000, 'ten safe source origins');
    await report.getByTestId('migration-codex-next').click();
    await waitFor(() => reports.some(value => value.pageIndex === 1), 10000, 'source report second page');
    assert.ok(await report.getByTestId('migration-codex-field').count() <= 10);
    for (const value of reports) for (const privateText of ['SYNTHETIC_', 'PRIVATE_UNKNOWN', fixture.codex, 'codex-nearest-model']) assert.ok(!JSON.stringify(value).includes(privateText));
    const sessionIds = queries.filter(value => value.query.kind.startsWith('codex_layers_')).map(value => value.session.sessionId);
    assert.equal(new Set(sessionIds).size, 1, 'selection and reports use the original owned source child');
    await browser.getByRole('button', { name: '传输所选资料（1）', exact: true }).click();
    await browser.getByTestId('migration-transfer-status').getByText('资料已接收', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(runs.length, 1); assert.deepEqual(runs[0].selections, [{ kind: 'configuration', sourceId: derived.source.sourceId }]);
    const renamed = [];
    for (const path of [fixture.codex, fixture.project, fixture.local]) { const to = resolve(path, '../codex-layer-withheld'); await rename(path, to); renamed.push([path, to]); }
    const panel = browser.getByTestId('migration-source-adoption');
    await panel.getByTestId('migration-adoption-expand').click();
    await panel.getByTestId('migration-adoption-received-row').waitFor();
    await panel.getByRole('checkbox').first().check();
    assert.equal(await panel.getByTestId('migration-adoption-prepare').isDisabled(), true, 'received project layers require explicit destination mapping');
    await panel.locator('[data-testid^="migration-adoption-map-"]').check();
    await panel.getByTestId('migration-adoption-prepare').click();
    await panel.getByText('预览就绪，尚未保存', { exact: true }).waitFor({ timeout: 30000 });
    const open = panel.locator('[data-testid^="migration-adoption-open-"]');
    const jobId = (await open.getAttribute('data-testid')).slice('migration-adoption-open-'.length);
    await open.click(); await dialog.getByRole('heading', { name: '选择迁移内容', exact: true }).waitFor();
    const items = await observer.rpc.request('migration/items', { jobId });
    assert.equal(items.providers.length, 1); assert.equal(items.providers[0].model, 'codex-nearest-model');
    assert.equal(items.providers[0].endpoint, 'https://codex-migration.example.invalid/v1');
    const provider = items.items.find(value => value.id === items.providers[0].itemId);
    const providerRow = dialog.getByTestId('migration-content-item').filter({ has: page.getByRole('checkbox', { name: `选择 ${provider.sourceName}`, exact: true }) });
    await providerRow.getByRole('button', { name: '配置', exact: true }).click();
    await providerRow.getByLabel('保存后的连接名称', { exact: true }).fill('CrossCodex');
    await providerRow.getByLabel('上下文额度', { exact: true }).fill('128000');
    await providerRow.getByLabel('输出预留额度', { exact: true }).fill('8192');
    await providerRow.getByLabel('最大输出额度', { exact: true }).fill('8192');
    await providerRow.getByRole('button', { name: '保存选项并选择', exact: true }).click();
    await dialog.getByRole('button', { name: '确认所选内容', exact: true }).click();
    await dialog.getByRole('heading', { name: '确认批量计划', exact: true }).waitFor();
    assert.deepEqual(await readFile(resolve(destinationProfile, 'settings.json')), originalSettings);
    await dialog.getByRole('button', { name: '开始批量迁移', exact: true }).click();
    await dialog.getByRole('heading', { name: '迁移结果', exact: true }).waitFor({ timeout: 30000 });
    const projectFile = resolve(workspace, '.kcoder/settings.json');
    await waitFor(async () => JSON.parse(await readFile(projectFile, 'utf8')).providers?.CrossCodex, 10000, 'original received snapshot published in destination project');
    assert.equal(JSON.parse(await readFile(projectFile, 'utf8')).providers.CrossCodex.default_model, 'codex-nearest-model');
    assert.deepEqual(await readFile(resolve(destinationProfile, 'settings.json')), originalSettings, 'source project layers cannot become user authority');
    await dialog.getByRole('button', { name: '撤销本次导入', exact: true }).click();
    await dialog.getByText('本次新增内容已撤销', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal((await observer.rpc.request('migration/batch/read', { jobId })).state.job.status, 'rolled_back');
    for (const [file, bytes] of fixture.files) { const [from, to] = renamed.find(([path]) => file.startsWith(`${path}/`)); assert.equal(await readFile(to + file.slice(from.length), 'utf8'), bytes); }
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await waitFor(() => closes.some(value => value.purpose === 'source'), 10000, 'original source child cleanup');
    assert.equal(model.requests.length, 0);
    const result = { passed: true, jobId, sourceLayerQuery: true, originalOwnedSourceSession: true, replacedSingleFiles: true, firstReportPage: 10,
      safeReportPaging: true, targetProjectMappingExplicit: true, sourceRemovedAfterReady: true, receivedSnapshotModelPreserved: true,
      ordinaryProjectBatchSavedAndUndone: true, userSettingsUnchanged: true, originalSourceBytesUnchanged: true, modelRequests: 0 };
    await context.writeArtifactJson('source-codex-layer-roundtrip.json', result); return result;
  } finally {
    await context.writeArtifactJson('source-codex-query-observations.json', { selections: selections.length, reportPages: reports.map(value => ({
      status: value.status, pageIndex: value.pageIndex, rows: value.fields?.length, totalFields: value.totalFields, nextPage: value.nextPage,
    })), queries: queries.map(value => ({ kind: value.query.kind, sourceId: value.query.params.sourceId, pageIndex: value.query.params.pageIndex })) });
    page.off('request', onRequest); page.off('response', onResponse); await observer.close();
  }
}
