import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';

export async function seedSourceClaudeLayers(source, workspace) {
  const project = resolve(workspace, '.claude');
  await mkdir(project, { recursive: true, mode: 0o700 });
  const file = resolve(project, 'settings.json');
  const bytes = JSON.stringify({ model: 'owned-source-layer-model',
    ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`unknown_field_${index}`, true])) });
  await writeFile(file, bytes, { mode: 0o600 });
  await writeFile(resolve(source.claude, 'settings.json'), JSON.stringify({ model: 'owned-user-layer-model' }), { mode: 0o600 });
  await writeFile(resolve(source.profile, 'trusted-folders.json'), JSON.stringify({ trusted: [workspace], never: [] }), { mode: 0o600 });
  return { file, bytes };
}

export async function exerciseSourceClaudeLayers({ context, page, fixture, destinationProfile, model }) {
  const original = await readFile(resolve(destinationProfile, 'settings.json'));
  const queries = [], reports = [];
  const onRequest = request => {
    if (request.url().endsWith('/api/migration/source-session/query')) queries.push(request.postDataJSON());
  };
  const onResponse = async response => {
    if (response.url().endsWith('/api/migration/source-session/query') && response.ok()) {
      try {
        const input = response.request().postDataJSON();
        if (input.query.kind === 'configuration_layers_read') reports.push({ input, value: await response.json() });
      } catch { /* The settled rows and explicit receipt assertions below remain authoritative. */ }
    }
  };
  page.on('request', onRequest); page.on('response', onResponse);
  try {
    const dialog = page.getByTestId('migration-dialog');
    await selectAdvancedMigration(dialog, 'source');
    const browser = page.getByTestId('migration-source-browser');
    await browser.locator('#migration-source-device').selectOption('history-source-target');
    await browser.getByRole('checkbox', { name: '同时检查当前受信任项目的配置', exact: true }).check();
    await browser.getByRole('button', { name: '查找可迁移内容', exact: true }).click();
    const panel = browser.getByTestId('migration-layer-report');
    await panel.waitFor();
    assert.equal(reports.length, 0, 'the report is passive before user disclosure');
    await panel.getByTestId('migration-layer-toggle').click();
    await waitFor(async () => await panel.getByTestId('migration-layer-field').count() === 10, 15000, 'first native source report page');
    await panel.getByTestId('migration-layer-next').click();
    await waitFor(async () => await panel.getByTestId('migration-layer-field').count() === 3, 15000, 'second native source report page');
    await waitFor(() => reports.length === 2, 5000, 'both source report receipts');
    const discovery = queries.find(value => value.query.kind === 'configuration');
    assert.ok(discovery);
    for (const [index, report] of reports.entries()) {
      assert.deepEqual(report.input.session, discovery.session, 'reports use the original source child');
      assert.equal(report.value.status, 'available');
      assert.equal(report.value.pageIndex, index);
      assert.equal(report.value.totalFields, 13);
      assert.deepEqual(report.value.target, { kind: 'source', sourceId: report.input.query.params.sourceId });
      assert.equal(JSON.stringify(report.value).includes('owned-source-layer-model'), false);
    }
    assert.equal(reports[0].input.query.params.sourceId, reports[1].input.query.params.sourceId);
    await page.screenshot({ path: context.pathInArtifacts('source-claude-layer-report.png') });
    assert.deepEqual(await readFile(resolve(destinationProfile, 'settings.json')), original);
    assert.equal(await readFile(fixture.file, 'utf8'), fixture.bytes);
    assert.equal(model.requests.length, 0);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await context.writeArtifactJson('source-claude-layer-report.json', { pages: reports.map(row => row.value), sameOriginalChild: true,
      sourceBytesUnchanged: true, targetSettingsUnchanged: true, modelRequests: 0 });
    return { passed: true, sameOriginalChild: true, rows: [10, 3], targetSettingsUnchanged: true, sourceBytesUnchanged: true, modelRequests: 0 };
  } finally {
    page.off('request', onRequest); page.off('response', onResponse);
  }
}
