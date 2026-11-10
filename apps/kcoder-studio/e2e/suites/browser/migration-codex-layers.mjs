import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';

export async function seedCodexLayerFixture(context, root, codex, profile) {
  const cwd = resolve(root, 'packages/app');
  for (const path of [resolve(root, '.git'), resolve(root, '.codex'), resolve(cwd, '.codex'), codex]) await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(resolve(profile, 'trusted-folders.json'), JSON.stringify({ trusted: [root], never: [] }), { mode: 0o600 });
  const privateValue = 'SYNTHETIC_CODEX_LAYER_REPORT_PRIVATE'; context.registerSecret(privateValue);
  const base = "model='codex-user-model'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://codex-migration.example.invalid/v1'\nwire_api='responses'\nenv_key='CODEX_LAYER_API_KEY'\n";
  const named = "model='codex-profile-model'\nmodel_reasoning_effort='high'\n";
  const project = `model='codex-root-model'\nmodel_provider='ignored-project-provider'\n[model_providers.ignored-project-provider]\nexperimental_bearer_token='${privateValue}'\n`;
  const local = "model='codex-nearest-model'\nmodel_reasoning_effort='low'\n" + Array.from({ length: 13 }, (_, i) => `PRIVATE_UNKNOWN_CODEX_FIELD_${i}=true\n`).join('');
  const files = [[resolve(codex, 'config.toml'), base], [resolve(codex, 'review.config.toml'), named], [resolve(root, '.codex/config.toml'), project], [resolve(cwd, '.codex/config.toml'), local]];
  for (const [file, bytes] of files) await writeFile(file, bytes, { mode: 0o600 });
  return { cwd, codex, profile, project: resolve(root, '.codex'), local: resolve(cwd, '.codex'), files };
}

/** Explicit Native selection and both client report surfaces; no provider turn or source program. */
export async function exerciseCodexLayers({ context, page, gateway, model, fixture, mobile = false, observations = [] }) {
  const observer = mobile ? null : await openRpc(gatewayRpcUrl(gateway, 'fixture-target', await waitForGatewayRpcToken(context, gateway)));
  if (observer) {
    context.addCleanup('close Codex-layers observer', () => closeRpcAndWait(observer));
    const init = await initializeRpc(observer, 'codex-layers-browser-observer');
    assert.equal(init.capabilities.experimental.migrationCodexLayersV1, true);
  }
  if (!mobile) {
    await selectAdvancedMigration(page, 'source');
    const browser = page.getByTestId('migration-source-browser');
    await browser.locator('#migration-source-device').selectOption('fixture-target');
    await browser.getByRole('button', { name: 'Codex', exact: true }).click();
    await browser.getByRole('button', { name: '查找可迁移内容', exact: true }).click();
    await browser.getByText('Codex · review.config.toml', { exact: true }).waitFor();
    const targetSettings = await readFile(resolve(fixture.profile, 'settings.json'), 'utf8');
    const transferRuns = [], transferReads = [], closedSessions = [], recoveryOpens = [], recoveredReads = [];
    let recovering = false;
    const operationObservations = [];
    const recordRequest = request => {
      if (recovering && request.url().endsWith('/api/migration/source-session/open')) recoveryOpens.push(request.postDataJSON().purpose);
      if (!request.url().endsWith('/api/migration/source-transfer/run')) return;
      const body = request.postDataJSON();
      transferRuns.push({ requestId: body.requestId, attemptId: body.attemptId });
    };
    const recordResponse = async response => {
      try {
        if (/\/api\/migration\/source-transfer\/(run|read|target-read)$/.test(new URL(response.url()).pathname)) {
          const body = await response.json();
          operationObservations.push({ method: new URL(response.url()).pathname.split('/').at(-1), status: response.status(),
            requestId: body.requestId, coordinatorState: body.coordinatorState, observation: body.observation,
            errorCode: typeof body.errorCode === 'string' && /^source_transfer_[a-z_]+$/.test(body.errorCode) ? body.errorCode : null,
            phase: body.result?.phase, sourceCaptureStatus: body.result?.sourceCapture?.status,
            sourceCaptureErrorCode: typeof body.result?.sourceCapture?.errorCode === 'string' && /^source_transfer_[a-z_]+$/.test(body.result.sourceCapture.errorCode) ? body.result.sourceCapture.errorCode : null,
            progressPhase: body.progress?.phase, targetWorkerRunning: body.result?.targetWorkerRunning });
        }
        if (response.url().endsWith('/api/migration/source-transfer/read') && response.ok()) {
          const body = await response.json();
          transferReads.push({ requestId: body.requestId, phase: body.result?.phase, receipt: body.result?.receipt });
        }
        if (response.url().endsWith('/api/migration/source-transfer/target-read') && response.ok()) {
          const body = await response.json();
          recoveredReads.push({ requestId: body.requestId, receipt: body.result?.receipt, sourceObserved: body.result?.sourceObserved });
        }
        if (response.url().endsWith('/api/migration/source-session/close') && response.ok()) {
          const body = await response.json();
          if (body.status === 'released') closedSessions.push(response.request().postDataJSON().purpose);
        }
      } catch { /* The UI must still provide the authoritative completion assertion below. */ }
    };
    page.on('request', recordRequest); page.on('response', recordResponse);
    try {
    await browser.getByText('Codex · review.config.toml', { exact: true }).locator('..').getByRole('checkbox').check();
    await browser.getByRole('button', { name: '传输所选资料（1）', exact: true }).evaluate(button => { button.click(); button.click(); });
    const transferStatus = browser.getByTestId('migration-transfer-status');
    await transferStatus.getByText('资料已接收', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(transferRuns.length, 1, 'rapid repeated clicks cannot create a second Native operation');
    assert.ok((await transferStatus.innerText()).includes('不代表目标配置或资产已经导入'));
    await transferStatus.getByRole('button', { name: '刷新', exact: true }).click();
    await waitFor(() => transferReads.findLast(value => value.phase === 'ready' && value.receipt), 10000, 'read the original Native transfer receipt');
    assert.equal(transferReads.at(-1).requestId, transferRuns[0].requestId);
    assert.equal(await readFile(resolve(fixture.profile, 'settings.json'), 'utf8'), targetSettings, 'received does not publish target configuration');
    await browser.getByRole('button', { name: '断开来源', exact: true }).click();
    await waitFor(() => closedSessions.includes('source') && closedSessions.includes('target'), 10000, 'release both owned transfer connections');
    await waitFor(async () => await browser.getByRole('button', { name: '断开来源', exact: true }).count() === 0, 10000, 'explicitly release the owned source child');
    await page.getByTestId('migration-dialog').getByRole('button', { name: '关闭', exact: true }).click();
    recovering = true;
    await page.getByTestId('general-external-content-import-button').click();
    await selectAdvancedMigration(page, 'source');
    const records = page.getByTestId('migration-transfer-records');
    await records.locator('summary').click();
    await records.getByRole('button', { name: '刷新', exact: true }).click();
    await records.getByRole('button', { name: '查询目标回执', exact: true }).click();
    await records.getByTestId('migration-recovered-transfer').getByText('资料已接收', { exact: true }).waitFor();
    await waitFor(() => recoveredReads.length === 1, 10000, 'read receipt through the original destination only');
    assert.deepEqual(recoveryOpens, ['target_recovery']);
    assert.equal(await page.locator('#migration-source-device').inputValue(), '', 'recovery does not choose or reconnect a source');
    assert.equal(recoveredReads[0].sourceObserved, false);
    assert.deepEqual(recoveredReads[0].receipt, transferReads.at(-1).receipt);
    assert.equal(transferRuns.length, 1);
    assert.equal(await readFile(resolve(fixture.profile, 'settings.json'), 'utf8'), targetSettings);
    await selectAdvancedMigration(page, 'batch');
    await waitFor(() => closedSessions.includes('target_recovery'), 10000, 'release the owned recovery connection');
    page.off('request', recordRequest); page.off('response', recordResponse);
    await context.writeArtifactJson('codex-source-transfer-received.json', { passed: true, runs: transferRuns,
      read: transferReads.at(-1), recoveredReads, recoveryOpens, targetSettingsUnchanged: true, closedSessions, modelRequests: 0 });
    await context.writeArtifactJson('codex-owned-source-discovery.json', { passed: true, sourceTarget: 'fixture-target', explicitSourceSelection: true, namedProfileFound: true, explicitSourceDisconnect: true, modelRequests: 0 });
    } finally {
      page.off('request', recordRequest); page.off('response', recordResponse);
      await context.writeArtifactJson('source-transfer-observations.json', operationObservations);
    }
  }
  if (mobile) {
    await page.getByTestId('migration-source-codex').click();
    await page.getByTestId('migration-include-project').click();
    await page.getByTestId('migration-discover-config').click();
  } else {
    await page.getByRole('button', { name: 'Codex', exact: true }).click();
    await page.getByLabel('同时检查当前受信任项目的配置', { exact: true }).check();
    await page.getByRole('button', { name: '查找可迁移内容', exact: true }).click();
  }
  const named = page.locator('[data-testid^="migration-source-row-"]').filter({ hasText: 'Codex · review.config.toml' });
  await named.waitFor();
  assert.equal(await page.getByTestId('migration-codex-report').count(), 0, 'discovery does not automatically select or display a composite');
  await named.locator('[data-testid^="migration-codex-merge-"]').click();
  const derived = page.locator('[data-testid^="migration-source-row-"]').filter({ has: page.getByTestId('migration-codex-report') });
  await derived.waitFor();
  for (const row of await page.locator('[data-testid^="migration-source-row-"]').all()) {
    const selected = mobile ? (await row.locator('[data-testid^="migration-config-source-"]').innerText()).startsWith('☑') : await row.getByRole('checkbox').isChecked();
    assert.equal(selected, await row.getByTestId('migration-codex-report').count() === 1, 'explicit model snapshot replaces every old single-file model selection');
  }
  let report = derived.getByTestId('migration-codex-report');
  await report.getByTestId('migration-codex-report-toggle').click();
  await waitFor(async () => await report.getByTestId('migration-codex-field').count() === 10, 15000, 'first ten Codex origins');
  let text = await report.innerText();
  for (const marker of mobile ? ['not establish', 'Selected profile', 'Project layer 2: Absent when captured', 'Git/worktree'] : ['不代表来源进程的最终配置', '所选 profile', '项目层 2: 捕获时不存在', 'Git/工作树']) assert.ok(text.includes(marker), `static report must include ${marker}`);
  const next = () => mobile ? report.getByRole('button', { name: 'Next', exact: true }) : report.getByTestId('migration-codex-next');
  await next().click();
  await waitFor(async () => (await report.innerText()).includes(mobile ? 'Page 2' : '第 2 页'), 10000, 'Codex origin second page');
  assert.ok(await report.getByTestId('migration-codex-field').count() <= 10);
  text += await report.innerText();
  for (const privateText of ['SYNTHETIC_', 'PRIVATE_UNKNOWN_CODEX_FIELD_', fixture.codex, 'codex-nearest-model']) assert.ok(!text.includes(privateText));
  await page.screenshot({ path: context.pathInArtifacts(mobile ? 'mobile-codex-layer-origins.png' : 'studio-codex-layer-origins.png') });
  if (mobile) { await page.getByTestId('migration-scan-selection').click(); await page.getByTestId('migration-batch-editor').waitFor(); }
  else { await page.getByRole('button', { name: '预览所选来源', exact: true }).click(); await page.getByTestId('migration-content-item').first().waitFor(); }
  const scan = mobile ? await waitFor(() => observations.findLast(row => row.method === 'migration/batch/scan' && row.responseJobId && !row.error), 10000, 'acknowledged Codex selection scan') : null;
  const jobs = observer ? await observer.request('migration/jobs/list', {}) : null;
  if (jobs) assert.equal(jobs.jobs.length, 1);
  const totalItems = mobile ? scan.totalItems : jobs.jobs[0].job.totalItems;
  assert.ok(totalItems >= 1, 'the explicit snapshot retains unresolved items rather than hiding them');
  const jobId = mobile ? scan.responseJobId : jobs.jobs[0].job.jobId;
  const items = observer ? await observer.request('migration/items', { jobId }) : null;
  if (items) {
    assert.equal(items.providers.length, 1, 'there is one merged model candidate, not duplicated single-file candidates');
    assert.equal(items.providers[0].model, 'codex-nearest-model');
    assert.equal(items.providers[0].endpoint, 'https://codex-migration.example.invalid/v1');
  }
  if (mobile) await waitFor(() => observations.some(row => row.method === 'migration/items' && row.requestJobId === jobId && row.providerCount === 1), 10000, 'Mobile loads exactly one merged model candidate');
  const target = items ? { kind: 'job', jobId, itemId: items.providers[0].itemId } : null;
  const saved = observer ? await observer.request('migration/codex/layers/read', { target }) : null;
  const renamed = [];
  for (const path of [fixture.codex, fixture.project, fixture.local]) { const destination = resolve(path, '../codex-source-withheld'); await rename(path, destination); renamed.push([path, destination]); }
  if (mobile) { await page.getByTestId('migration-close-job').click(); await page.getByTestId('migration-tab-records').click(); await page.getByTestId(`migration-batch-record-${jobId}`).click(); }
  else { await page.getByRole('button', { name: '迁移记录', exact: true }).click(); await page.getByRole('button').filter({ hasText: /^Codex ·/ }).first().click(); }
  report = page.getByTestId('migration-codex-report').first();
  await report.getByTestId('migration-codex-report-toggle').click();
  await waitFor(async () => await report.getByTestId('migration-codex-field').count() === 10, 15000, 'saved Codex report after source removal');
  if (observer) assert.deepEqual(await observer.request('migration/codex/layers/read', { target }), saved);
  else assert.ok(observations.some(row => row.method === 'migration/codex/layers/read' && row.reportStatus === 'available' && row.reportRows === 10 && row.reportTargetJobId === jobId));
  for (const [file, bytes] of fixture.files) {
    const [from, to] = renamed.find(([path]) => file.startsWith(`${path}/`));
    assert.equal(await readFile(to + file.slice(from.length), 'utf8'), bytes);
  }
  assert.equal(model.requests.length, 0);
  const result = { passed: true, platform: mobile ? 'Mobile Web Chromium' : 'Studio Browser Chromium', jobId, explicitProjectConsent: true, namedProfileSelected: true, duplicateSingleFileSelectionsReplaced: true, firstPageRows: 10, unresolvedRowsRetained: totalItems - 1, mergedProviderCount: 1, cachedOriginsAfterSourceRemoval: true, privateValuesUnknownNamesAndPathsHidden: true, staticBoundaryShown: true, sourceBytesUnchanged: true, modelRequests: 0 };
  await context.writeArtifactJson('codex-layer-results.json', result);
  if (observer) await closeRpcAndWait(observer);
  return result;
}
