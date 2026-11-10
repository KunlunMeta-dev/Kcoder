import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { clearPrivateMigrationRecovery } from '../../harness/migration-private-recovery.mjs';

export async function seedBrowserPrivateCredentials(context, fixture, sourceProgram) {
  const fields = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`PRIVATE_${String(index).padStart(2, '0')}`, `owned-${randomUUID()}`]));
  for (const value of Object.values(fields)) context.registerSecret(value);
  const file = resolve(fixture.claude, 'settings.json');
  await writeFile(file, JSON.stringify({ mcpServers: { notes: { command: 'sh', args: [sourceProgram], env: fields } } }), { mode: 0o600 });
  return { ...fixture, file, fields };
}

/** The fixture creates an ordinary received plan; every private action below uses real Studio UI. */
export async function exerciseBrowserPrivateCredentials({ context, page, gateway, workspace, fixture, destinationProfile, model, sourceProgram }) {
  const before = await readFile(resolve(destinationProfile, 'settings.json'));
  const observer = await openOwnedMobileRpc(context, gateway, 'fixture-target', workspace);
  const owned = [], calls = [];
  async function call(lane, operation, data) {
    const response = await page.request.post(`${gateway.baseUrl}/api/migration/${lane}/${operation}`, { data, headers: { origin: gateway.baseUrl } });
    const value = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(value));
    for (const secret of Object.values(fixture.fields)) assert.equal(JSON.stringify(value).includes(secret), false);
    return value;
  }
  const source = { sessionId: randomUUID(), purpose: 'source', targetId: 'history-source-target', workspacePath: workspace };
  const target = { sessionId: randomUUID(), purpose: 'target', targetId: 'fixture-target', workspacePath: workspace };
  let dropRun = true, dropPrepare = true, preparationStatus = null;
  const onRequest = request => {
    if (/\/api\/migration\/source-transfer\/private\//.test(request.url())) calls.push({ operation: request.url().split('/').at(-1), input: request.postDataJSON() });
  };
  page.on('request', onRequest);
  await page.route('**/api/migration/source-transfer/private/run', async route => {
    if (!dropRun) return route.continue();
    dropRun = false;
    const response = await route.fetch(); assert.equal(response.status(), 200);
    await route.abort('failed');
  });
  await page.route('**/api/migration/source-transfer/private/prepare', async route => {
    if (!dropPrepare) return route.continue();
    dropPrepare = false;
    const response = await route.fetch(); assert.equal(response.status(), 200);
    await route.abort('failed');
  });
  await page.route('**/api/migration/source-transfer/private/prepare-status', async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200); preparationStatus = await response.json();
    await route.fulfill({ response });
  });
  try {
    for (const session of [source, target]) { await call('source-session', 'open', session); owned.push(session); }
    const discovery = await call('source-session', 'query', { session: source, query: { kind: 'configuration', params: { sources: ['claude-code'] } } });
    const selected = discovery.sources.filter(row => row.kind === 'claude-code' && row.scope === 'user');
    assert.equal(selected.length, 1);
    const requestId = randomUUID(), pair = { requestId, source, target };
    await call('source-transfer', 'run', { ...pair, attemptId: randomUUID(), selections: selected.map(row => ({ kind: 'configuration', sourceId: row.sourceId })) });
    let receipt;
    await waitFor(async () => { const value = await call('source-transfer', 'read', pair); receipt = value.result?.receipt; return value.result?.phase === 'ready'; }, 30000, 'private UI original source receipt');
    const received = await call('source-transfer', 'received', { requestId, target, manifestSha256: receipt.manifestSha256, pageIndex: 0 });
    const locator = { requestId, adoptionId: randomUUID(), target };
    await call('source-transfer', 'adoption-prepare', { locator, manifestSha256: receipt.manifestSha256, selections: received.items.map(row => ({ entryId: row.entryId })) });
    let adoption;
    await waitFor(async () => { const value = await call('source-transfer', 'adoption-read', locator); adoption = value.state; return adoption?.jobs[0]?.previewReady && adoption.workerState === 'stopped'; }, 30000, 'ordinary received private plan');
    const jobId = adoption.jobs[0].jobId;
    const items = await observer.rpc.request('migration/items', { jobId }); assert.equal(items.mcps.length, 1);
    const original = await observer.rpc.request('migration/batch/read', { jobId });
    await observer.rpc.request('migration/batch/plan', { jobId, expectedSequence: original.state.job.sequence, choices: [
      { kind: 'mcp', itemId: items.mcps[0].itemId, targetName: 'browser-private-notes', cwd: null, enableAfterImport: false },
    ], includeDefaultItems: false });
    for (const session of owned.splice(0)) await call('source-session', 'close', session);
    const dialog = page.getByTestId('migration-dialog');
    await dialog.getByRole('button', { name: '迁移记录', exact: true }).first().click();
    await page.getByTestId(`migration-batch-record-${jobId}`).click();
    let panel = page.getByTestId('migration-private-credentials');
    await panel.getByRole('button', { name: /选择凭据来源/ }).click();
    await panel.getByRole('button', { name: '读取原始来源', exact: true }).click();
    await panel.getByRole('button', { name: /claude-code.*e000/ }).click();
    await panel.getByRole('button', { name: 'Separate history source', exact: true }).click();
    await panel.getByRole('button', { name: '读取原方案的凭据候选', exact: true }).click();
    const fields = panel.getByRole('checkbox', { name: /PRIVATE_/ });
    await fields.first().waitFor(); assert.equal(await fields.count(), 10);
    await fields.first().check();
    const candidate = fields.first().locator('xpath=../..');
    await candidate.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await panel.getByRole('checkbox', { name: /PRIVATE_/ }).count(), 2);
    await panel.getByRole('checkbox', { name: /PRIVATE_10/ }).check();
    await panel.getByRole('checkbox', { name: '授权传输所选 MCP 私密字段', exact: true }).check();
    const confirm = async word => { await panel.getByRole('textbox').fill(word); await panel.getByRole('button', { name: '确认', exact: true }).click(); };
    await panel.getByRole('button', { name: '确认私密传输', exact: true }).click(); await confirm('TRANSFER');
    await panel.getByRole('alert').waitFor();
    assert.equal(calls.filter(row => row.operation === 'run').length, 1);
    await panel.getByRole('button', { name: '读取原 offer 回执', exact: true }).last().click();
    await panel.getByRole('checkbox', { name: '将此已接收 offer 加入凭据准备', exact: true }).check();
    await panel.getByRole('button', { name: '读取原来源端状态', exact: true }).click();
    await waitFor(() => calls.some(row => row.operation === 'source-read'), 10000, 'private UI source-only observation');
    await panel.getByRole('button', { name: '确认给原批次准备凭据', exact: true }).click(); await confirm('PREPARE');
    await panel.getByRole('alert').waitFor(); assert.equal(calls.filter(row => row.operation === 'prepare').length, 1);
    const originalPrepare = calls.find(row => row.operation === 'prepare').input;
    const cacheLoss = await clearPrivateMigrationRecovery(page); assert.ok(cacheLoss.removed >= 2); assert.equal(cacheLoss.remaining, 0);
    await page.reload(); await page.getByTestId('general-external-content-import-button').click(); await dialog.waitFor();
    await page.locator('#migration-target').selectOption('fixture-target');
    await dialog.getByRole('button', { name: '迁移记录', exact: true }).first().click();
    await page.getByTestId(`migration-batch-record-${jobId}`).click(); panel = page.getByTestId('migration-private-credentials');
    await panel.getByRole('button', { name: /选择凭据来源/ }).click(); await panel.getByRole('button', { name: '读取原始来源', exact: true }).click();
    await panel.getByRole('button', { name: /claude-code.*e000/ }).click(); await panel.getByTestId('migration-private-preparation-read').click();
    await waitFor(async () => await panel.getByTestId('migration-private-preparation-status').innerText() === '原 offer 集合已准备。', 20000, 'target-only original preparation after local run/prepare cache loss');
    assert.equal(preparationStatus.phase, 'prepared'); assert.deepEqual(preparationStatus.offerIds, [originalPrepare.locator.offerId]);
    assert.equal(preparationStatus.expectedSequence, originalPrepare.expectedSequence); assert.deepEqual(preparationStatus.consent, originalPrepare.consent);
    assert.equal(calls.filter(row => row.operation === 'prepare').length, 1); assert.equal(calls.filter(row => row.operation === 'run').length, 1);
    assert.equal(await panel.getByTestId('migration-private-preparation-restore').count(), 0);
    await panel.getByRole('button', { name: '读取原批次预览', exact: true }).click();
    await rename(fixture.file, `${fixture.file}.withheld`);
    const apply = dialog.getByRole('button', { name: '开始批量迁移', exact: true });
    await waitFor(async () => !await apply.isDisabled(), 10000, 'private prepared ordinary apply'); await apply.click();
    await page.getByText('部分结果仍需要配置或核对', { exact: true }).first().waitFor({ timeout: 30000 });
    const published = await observer.rpc.request('migration/batch/read', { jobId });
    assert.equal(published.state.job.status, 'completed_with_issues');
    assert.equal(published.state.job.committedItems, 1);
    assert.equal(published.state.job.hasUnconfirmedOutcomes, false);
    assert.equal(published.state.batch.unresolvedActions, 0); assert.equal(published.state.batch.committedActions, published.state.batch.totalActions);
    const publishedItems = await observer.rpc.request('migration/items', { jobId }); assert.equal(publishedItems.items[0].status, 'committed');
    const mcpPlans = (await observer.rpc.request('migration/batch/mcp/credential/read', { jobId })).plans;
    assert.equal(mcpPlans.length, 1); assert.equal(mcpPlans[0].phase, 'published'); assert.equal(mcpPlans[0].fields.length, 2);
    assert.equal(mcpPlans[0].remainingFields, 10); assert.equal(mcpPlans[0].errorCode, null);
    const settings = JSON.parse(await readFile(resolve(destinationProfile, 'settings.json'), 'utf8'));
    assert.ok(settings.mcp_disabled_servers.includes('browser-private-notes'));
    for (const secret of Object.values(fixture.fields)) assert.equal(JSON.stringify(settings).includes(secret), false);
    await dialog.getByRole('button', { name: '撤销本次导入', exact: true }).click();
    await page.getByText('本次新增内容已撤销', { exact: true }).first().waitFor({ timeout: 30000 });
    assert.deepEqual(await readFile(resolve(destinationProfile, 'settings.json')), before);
    const undone = await observer.rpc.request('migration/batch/read', { jobId }); assert.equal(undone.state.job.status, 'rolled_back'); assert.equal(undone.state.job.hasUnconfirmedOutcomes, false);
    assert.equal((await observer.rpc.request('migration/batch/mcp/credential/read', { jobId })).plans[0].phase, 'undone');
    assert.equal(await access(`${sourceProgram}.marker`).then(() => true, () => false), false);
    assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('studio-private-credentials.json', { passed: true, jobId, requestId, selectedFields: 2, fieldPages: [10, 2],
      lostRunAck: true, runs: 1, lostPrepareAck: true, prepares: 1, preparationRecovery: { cacheLoss, status: preparationStatus },
      sourceOnlyRead: true, sourceGonePublication: true, ordinaryUndo: true, committedActions: published.state.batch.committedActions, mcpPublished: true, mcpUndone: true, modelRequests: 0 });
    await page.screenshot({ path: context.pathInArtifacts('studio-private-credentials-undone.png') });
    return { privateCredentialUi: true, modelRequests: 0 };
  } finally {
    page.off('request', onRequest);
    await page.unroute('**/api/migration/source-transfer/private/run'); await page.unroute('**/api/migration/source-transfer/private/prepare'); await page.unroute('**/api/migration/source-transfer/private/prepare-status');
    for (const session of owned) await call('source-session', 'close', session);
    await observer.close();
  }
}
