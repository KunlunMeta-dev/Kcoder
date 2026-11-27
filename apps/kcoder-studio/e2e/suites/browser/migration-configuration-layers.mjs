import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';

export async function seedConfigurationLayerFixture(context, workspace, source, profile) {
  await writeFile(resolve(profile, 'trusted-folders.json'), JSON.stringify({ trusted: [workspace], never: [] }), { mode: 0o600 });
  const secret = 'SYNTHETIC_LAYER_REPORT_WINNING_SECRET'; context.registerSecret(secret);
  const user = { model: 'layer-user-model', env: { ANTHROPIC_API_KEY: 'SYNTHETIC_LAYER_REPORT_LOWER_SECRET' } };
  context.registerSecret(user.env.ANTHROPIC_API_KEY);
  for (let i = 0; i < 13; i++) user[`PRIVATE_UNKNOWN_LAYER_FIELD_${i}`] = true;
  await writeFile(resolve(source, 'settings.json'), JSON.stringify(user), { mode: 0o600 });
  const project = resolve(workspace, '.claude');
  await mkdir(project, { recursive: true, mode: 0o700 });
  const local = JSON.stringify({ model: 'layer-local-model', env: { ANTHROPIC_API_KEY: secret } });
  await writeFile(resolve(project, 'settings.local.json'), local, { mode: 0o600 });
  return { source, project, user: JSON.stringify(user), local };
}

/** Real client controls and saved Native bindings; no source program or model is invoked. */
export async function exerciseConfigurationLayers({ context, page, gateway, model, fixture, mobile = false, observations = [] }) {
  const observer = mobile ? null : await openRpc(gatewayRpcUrl(gateway, 'fixture-target', await waitForGatewayRpcToken(context, gateway)));
  if (observer) {
    context.addCleanup('close configuration-layers observer', () => closeRpcAndWait(observer));
    const initialized = await initializeRpc(observer, 'configuration-layers-browser-observer');
    assert.equal(initialized.capabilities.experimental.migrationConfigurationLayersV1, true);
  }
  if (mobile) {
    await page.getByTestId('migration-source-claude-code').click();
    await page.getByTestId('migration-include-project').click();
    await page.getByTestId('migration-discover-config').click();
  } else {
    await page.getByLabel('同时检查当前受信任项目的配置', { exact: true }).check();
    await page.getByRole('button', { name: '查找可迁移内容', exact: true }).click();
  }
  let report = page.getByTestId('migration-layer-report').first();
  await report.getByTestId('migration-layer-toggle').click();
  await waitFor(async () => await report.getByTestId('migration-layer-field').count() === 10, 15000, 'first ten safe field origins');
  assert.ok((await report.innerText()).includes(mobile ? 'not the source application' : '不代表来源应用运行时'));
  const next = () => mobile ? report.getByRole('button', { name: 'Next', exact: true }) : report.getByTestId('migration-layer-next');
  await next().click();
  await waitFor(async () => (await report.innerText()).includes('/env/ANTHROPIC_API_KEY'), 10000, 'private field origin on second page');
  const text = await report.innerText();
  assert.ok(text.includes(mobile ? 'Winning layer: Project local' : '胜出层: 项目本地层'));
  assert.ok(text.includes(mobile ? 'Private value hidden' : '私有值已隐藏'));
  for (const privateText of ['SYNTHETIC_', 'PRIVATE_UNKNOWN_LAYER_FIELD_', fixture.source, 'layer-local-model']) assert.ok(!text.includes(privateText));
  assert.ok(await report.getByTestId('migration-layer-field').count() <= 10);
  await page.screenshot({ path: context.pathInArtifacts(mobile ? 'mobile-layer-origins.png' : 'studio-layer-origins.png') });
  if (mobile) {
    await page.getByRole('button', { name: /Claude Code · selected settings layers · project-effective$/ }).click();
    await page.getByTestId('migration-scan-selection').click();
    await page.getByTestId('migration-batch-editor').waitFor();
  } else {
    for (const box of await page.locator('label').filter({ hasText: /Claude Code/ }).getByRole('checkbox').all()) await box.uncheck();
    await page.getByText('Claude Code · selected settings layers', { exact: false }).locator('xpath=ancestor::label').getByRole('checkbox').check();
    await page.getByRole('button', { name: '预览所选来源', exact: true }).click();
    await page.getByTestId('migration-content-item').first().waitFor();
  }
  const scan = mobile ? await waitFor(() => observations.findLast(row => row.method === 'migration/batch/scan' && row.responseJobId && !row.error), 10000, 'acknowledged UI scan job') : null;
  const jobs = observer ? await observer.request('migration/jobs/list', {}) : null;
  if (jobs) assert.equal(jobs.jobs.length, 1);
  assert.equal(mobile ? scan.totalItems : jobs.jobs[0].job.totalItems, 1, 'only the explicitly selected layered configuration enters this batch');
  const jobId = mobile ? scan.responseJobId : jobs.jobs[0].job.jobId;
  const items = observer ? await observer.request('migration/items', { jobId }) : null;
  const target = items ? { kind: 'job', jobId, itemId: items.providers[0].itemId } : null;
  const saved = observer ? await observer.request('migration/configuration/layers', { target }) : null;
  if (saved) assert.equal(saved.status, 'available');
  await rename(fixture.source, resolve(fixture.source, '../layer-source-withheld'));
  await rename(fixture.project, resolve(fixture.project, '../layer-project-withheld'));
  if (mobile) {
    await page.getByTestId('migration-close-job').click();
    await page.getByTestId('migration-tab-records').click();
    await page.getByTestId(`migration-batch-record-${jobId}`).click();
  } else {
    await page.getByRole('button', { name: '迁移记录', exact: true }).click();
    await page.getByRole('button').filter({ hasText: /^Claude Code ·/ }).first().click();
  }
  report = page.getByTestId('migration-layer-report').first();
  await report.getByTestId('migration-layer-toggle').click();
  await waitFor(async () => await report.getByTestId('migration-layer-field').count() === 10, 15000, 'saved report after reopening without source');
  if (observer) assert.deepEqual(await observer.request('migration/configuration/layers', { target }), saved);
  else assert.ok(observations.some(row => row.method === 'migration/configuration/layers' && row.reportStatus === 'available' && row.reportRows === 10 && row.reportTargetJobId === jobId), 'the real Mobile connection reads the saved Native job report');
  assert.equal(await readFile(resolve(fixture.source, '../layer-source-withheld/settings.json'), 'utf8'), fixture.user);
  assert.equal(await readFile(resolve(fixture.project, '../layer-project-withheld/settings.local.json'), 'utf8'), fixture.local);
  assert.equal(model.requests.length, 0);
  const result = { passed: true, platform: mobile ? 'Mobile Web Chromium' : 'Studio Browser Chromium', jobId, firstPageRows: 10, explicitStaticBoundary: true, privateWinningLayerShown: true, valuesAndUnknownNamesHidden: true, missingProjectLayerShown: true, savedReportSurvivesSourceRemoval: true, sourceBytesUnchanged: true, modelRequests: 0 };
  await context.writeArtifactJson('configuration-layer-results.json', result);
  if (observer) await closeRpcAndWait(observer);
  return result;
}
