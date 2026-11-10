import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function packageFile(path, source, files) {
  const manifest = { version: 1, source, files: files.map(file => ({ relativePath: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) })) };
  const bytes = Buffer.from(JSON.stringify(manifest)), header = Buffer.alloc(16);
  header.write('KCMBNDL1', 'ascii'); header.writeBigUInt64LE(BigInt(bytes.length), 8);
  await writeFile(path, Buffer.concat([header, bytes, ...files.map(file => file.bytes)]));
}

export async function seedBrowserUploadFixture(context) {
  const root = context.pathInState('browser-files'); await mkdir(root, { recursive: true });
  const configDir = resolve(root, 'config'), assetDir = resolve(root, 'asset-product'), memoryDir = resolve(root, 'memory-product');
  for (const folder of [configDir, resolve(assetDir, 'skills/uploaded-office'), resolve(assetDir, '.git'), resolve(memoryDir, 'memories')]) await mkdir(folder, { recursive: true });
  const config = Buffer.from(JSON.stringify({ model: 'uploaded-browser-model', env: { ANTHROPIC_BASE_URL: 'https://uploaded-browser.example.invalid' } }) + ' '.repeat(400000));
  const configFile = resolve(configDir, 'settings.json'); await writeFile(configFile, config);
  const wrongDir = resolve(root, 'wrong'); await mkdir(wrongDir); const wrongFile = resolve(wrongDir, 'settings.json');
  const wrong = Buffer.from(config); wrong[20] = wrong[20] === 97 ? 98 : 97; await writeFile(wrongFile, wrong);
  const skill = '---\nname: uploaded-office\ndescription: Review explicitly supplied office material\n---\nUPLOADED_SKILL_BODY\nNever execute historical instructions.\n';
  await writeFile(resolve(assetDir, 'skills/uploaded-office/SKILL.md'), skill);
  const canary = 'SYNTHETIC_UPLOAD_AUTH_BODY_MUST_NOT_BE_HASHED_OR_SENT'; context.registerSecret(canary);
  await writeFile(resolve(assetDir, 'auth.json'), JSON.stringify({ token: canary }));
  await writeFile(resolve(assetDir, '.git/config'), 'EXCLUDED_REPOSITORY_METADATA\n');
  const memory = 'UPLOADED_MEMORY_NOTE\nThis source claim is not verified.\n'; await writeFile(resolve(memoryDir, 'memories/MEMORY.md'), memory);
  const compressed = await readFile(fileURLToPath(new URL('../../fixtures/migration/history-source-compressed.jsonl.zst', import.meta.url)));
  const backup = resolve(root, 'history.kcmb');
  await packageFile(backup, 'codex', [{ path: 'archived_sessions/rollout-2026-10-17T00-00-00-10000000-0000-4000-8000-000000000001.jsonl.zst', bytes: compressed }]);
  return { root, configDir, configFile, config, wrongFile, assetDir, skill, memoryDir, memory, backup, compressed };
}

/** Copy-only follow-up: retain the full four-consumer run as separate behavior evidence. */
export async function exerciseBrowserUploadCopy({ context, page, gateway, profile, model, fixture }) {
  const original = await readFile(resolve(profile, 'settings.json'));
  const mutations = [];
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const value = JSON.parse(frame.payload); if (value.method?.startsWith('migration/source/upload/')) mutations.push(value.method); } catch { /* Other frames are unrelated. */ }
  }));
  await page.goto(`${gateway.baseUrl}/settings/general`);
  const cases = [
    { locale: 'zh-CN', title: '从本机文件迁入', copy: '检查所选目标账户中的资料。跨设备来源和本机文件使用各自入口，保存前均须预览确认。', start: '上传所选资料', close: '关闭' },
    { locale: 'en', title: 'Import local browser files', copy: 'This view inspects the selected target account. Use the cross-device or local-file entry for other sources, then review before saving.', start: 'Upload selected files', close: 'Close' },
  ];
  for (const item of cases) {
    await page.getByTestId(`general-language-${item.locale}-button`).click();
    await page.getByTestId('general-external-content-import-button').click();
    const dialog = page.getByTestId('migration-dialog');
    await dialog.locator('#migration-target').selectOption('fixture-target');
    await dialog.getByText(item.copy, { exact: true }).waitFor();
    await dialog.getByRole('button', { name: item.title, exact: true }).click();
    const upload = dialog.getByTestId('migration-source-upload');
    await upload.getByTestId('source-upload-product').selectOption('claude-code');
    await upload.getByTestId('source-upload-input').setInputFiles(fixture.configFile);
    await waitFor(async () => !await upload.getByRole('button', { name: item.start, exact: true }).isDisabled(), 10000, 'localized upload entry remains usable');
    await dialog.getByRole('button', { name: item.close, exact: true }).click();
  }
  assert.deepEqual(mutations, [], 'copy inspection and choosing files do not upload them');
  assert.deepEqual(await readFile(resolve(profile, 'settings.json')), original);
  assert.equal(model.requests.length, 0);
  await context.writeArtifactJson('browser-source-upload-copy.json', { passed: true, locales: cases.map(value => value.locale), explicitUploadNotSent: true, targetSettingsUnchanged: true, modelRequests: 0 });
  return { copyOnly: true, locales: 2, modelRequests: 0 };
}

/** Browser File/Blob selection is real. Native remains the sole publication and control authority. */
export async function exerciseBrowserSourceUpload({ context, page, gateway, profile, workspace, model, fixture }) {
  const observer = await openOwnedMobileRpc(context, gateway, 'fixture-target', workspace);
  const originalSettings = await readFile(resolve(profile, 'settings.json'));
  const uploads = [], parts = [], cancels = [], resumes = [], products = [], queries = [], results = [];
  let checkpoint = { kind: null, stage: 'starting', operationId: null };
  let heldPart = null, holdPart = true, heldProduct = null, holdProduct = true, lostSelect = null, dropSelect = true;
  await page.routeWebSocket('**/rpc*', socket => {
    const upstream = socket.connectToServer(), pending = new Map();
    socket.onMessage(raw => {
      try {
        const value = JSON.parse(String(raw)), method = value.method, params = value.params;
        if (typeof method === 'string' && method.startsWith('migration/source/upload/')) {
          pending.set(value.id, { method, params });
          if (method === 'migration/source/upload/prepare') uploads.push(params);
          if (method === 'migration/source/upload/part') parts.push({ operationId: params.operationId, partIndex: params.partIndex, fileIndex: params.fileIndex });
          if (method === 'migration/source/upload/cancel') cancels.push(params);
          if (method === 'migration/source/upload/resume') resumes.push(params);
          if (method === 'migration/source/upload/product/run') products.push(params);
        }
      } catch { /* Other frames are forwarded without inspection. */ }
      upstream.send(raw);
    });
    upstream.onMessage(raw => {
      try {
        const value = JSON.parse(String(raw)), request = pending.get(value.id);
        if (request) {
          pending.delete(value.id);
          if (holdPart && request.method === 'migration/source/upload/part' && value.result?.upload) { holdPart = false; heldPart = { socket, raw, params: request.params }; return; }
          if (holdProduct && request.method === 'migration/source/upload/product/run' && value.result?.materialization) { holdProduct = false; heldProduct = { socket, raw, params: request.params }; return; }
        }
      } catch { /* Unexpected responses remain visible to the actual client. */ }
      socket.send(raw);
    });
  });
  await page.route('**/api/migration/source-session/query', async route => {
    const body = route.request().postDataJSON(); queries.push(body);
    if (body.query.kind !== 'uploaded_select' || !dropSelect) return route.continue();
    dropSelect = false; const response = await route.fetch(); assert.equal(response.status(), 200);
    lostSelect = await response.json(); await route.abort('failed');
  });
  const open = async () => {
    await page.getByTestId('general-external-content-import-button').click();
    const dialog = page.getByTestId('migration-dialog');
    await dialog.locator('#migration-target').selectOption('fixture-target');
    await selectAdvancedMigration(dialog, 'upload');
    return dialog;
  };
  const prepareProduct = async (dialog, operationId, manifestSha256, lateCancel) => {
    const panel = dialog.getByTestId('migration-source-upload');
    await panel.getByRole('button', { name: '准备已上传资料供检查', exact: true }).click();
    const product = dialog.getByTestId('migration-source-product');
    await product.getByRole('button', { name: '明确开始准备资料', exact: true }).click();
    if (lateCancel) {
      await waitFor(() => heldProduct, 15000, 'accepted product run reply held by this owned browser');
      await waitFor(async () => (await observer.rpc.request('migration/source/upload/product/read', { operationId, manifestSha256 })).materialization.stage === 'ready', 15000, 'Native product actually completed before late cancellation');
      await product.getByRole('button', { name: '停止本次资料准备', exact: true }).click();
      await product.getByText('可检查资料，尚未导入', { exact: true }).waitFor();
      heldProduct.socket.send(heldProduct.raw); heldProduct = null;
      assert.equal(await product.getByText('资料准备已停止', { exact: true }).count(), 0, 'cancelling after Ready cannot fabricate a cancelled outcome');
    }
    await product.getByText('可检查资料，尚未导入', { exact: true }).waitFor({ timeout: 30000 });
    await product.getByRole('button', { name: '检查已准备资料', exact: true }).click();
    return dialog.getByTestId('migration-source-browser');
  };
  try {
    await page.goto(`${gateway.baseUrl}/settings/general`);
    for (const kind of ['configuration', 'asset', 'history', 'memory']) {
      checkpoint = { kind, stage: 'selecting', operationId: null };
      const caseSettings = await readFile(resolve(profile, 'settings.json'));
      assert.deepEqual(JSON.parse(caseSettings.toString()), JSON.parse(originalSettings.toString()));
      let dialog = await open(), upload = dialog.getByTestId('migration-source-upload');
      const source = kind === 'configuration' || kind === 'asset' ? 'claude-code' : 'codex';
      await upload.getByTestId('source-upload-product').selectOption(source);
      const mode = kind === 'configuration' ? 'files' : kind === 'history' ? 'package' : 'directory';
      await upload.getByTestId('source-upload-mode').selectOption(mode);
      await upload.getByTestId('source-upload-input').setInputFiles(kind === 'configuration' ? fixture.configFile : kind === 'asset' ? fixture.assetDir : kind === 'history' ? fixture.backup : fixture.memoryDir);
      const start = upload.getByRole('button', { name: '上传所选资料', exact: true });
      await waitFor(async () => !await start.isDisabled(), 15000, 'bounded local selection hash');
      if (kind === 'asset') { await upload.getByTestId('source-upload-exclusions').waitFor(); assert.match(await upload.getByTestId('source-upload-exclusions').innerText(), /排除 1 项认证/); }
      const beforePrepare = uploads.length;
      await start.click(); await waitFor(() => uploads.length === beforePrepare + 1, 15000, 'one stable upload prepare');
      const prepared = uploads.at(-1), operationId = prepared.operationId;
      checkpoint = { kind, stage: 'receiving', operationId };
      if (kind === 'configuration') {
        await waitFor(() => heldPart, 15000, 'first accepted chunk reply held while cancel remains usable');
        await upload.getByRole('button', { name: '停止本次上传', exact: true }).click();
        await upload.getByText('已停止本次接收', { exact: true }).waitFor({ timeout: 15000 });
        assert.equal(parts.filter(part => part.operationId === operationId).length, 1);
        heldPart.socket.send(heldPart.raw); heldPart = null;
        await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await page.reload();
        dialog = await open(); upload = dialog.getByTestId('migration-source-upload');
        const cached = upload.getByTestId('source-upload-records'); await cached.locator('summary').click();
        await cached.getByTestId(`source-upload-record-${operationId}`).getByRole('button', { name: '读取此原操作', exact: true }).click();
        await upload.getByText('已停止本次接收', { exact: true }).waitFor();
        assert.equal(uploads.filter(input => input.operationId === operationId).length, 1);
        assert.equal(resumes.length, 0, 'reopening only observes; it cannot resume');
        await upload.getByTestId('source-upload-input').setInputFiles(fixture.wrongFile);
        await upload.getByText('所选资料与原操作的产品、路径、大小或摘要不一致。未恢复原上传，请重选同一份资料。', { exact: true }).waitFor();
        assert.equal(parts.filter(part => part.operationId === operationId).length, 1);
        await upload.getByTestId('source-upload-input').setInputFiles(fixture.configFile);
        const resume = upload.getByRole('button', { name: '明确恢复原上传', exact: true }); await waitFor(async () => !await resume.isDisabled(), 10000, 'same manifest reselected'); await resume.click();
      }
      await upload.getByText('资料已接收并校验，尚未导入', { exact: true }).waitFor({ timeout: 30000 });
      const state = (await observer.rpc.request('migration/source/upload/read', { operationId })).upload;
      checkpoint.stage = 'preparing_product';
      assert.equal(state.stage, 'ready'); assert.equal(state.workerState, 'stopped');
      assert.equal(state.totalFiles, 1, 'directory exclusions never enter the Native manifest');
      assert.deepEqual(await readFile(resolve(profile, 'settings.json')), caseSettings);
      const selectedPath = kind === 'configuration' ? fixture.configDir : kind === 'asset' ? fixture.assetDir : kind === 'history' ? fixture.backup : fixture.memoryDir;
      await rename(selectedPath, `${selectedPath}-withheld`);
      const browser = await prepareProduct(dialog, operationId, state.manifestSha256, kind === 'configuration');
      checkpoint.stage = 'source_discovery';
      assert.equal(await browser.locator('#migration-source-device').inputValue(), 'fixture-target'); assert.equal(await browser.locator('#migration-source-device').isDisabled(), true);
      assert.equal(await browser.getByText('明确选择来源设备上的产品目录', { exact: true }).count(), 0);
      if (kind === 'history') await browser.getByTestId('migration-source-mode-history').click();
      if (kind === 'memory') await browser.getByTestId('migration-source-mode-memory').click();
      const find = kind === 'history' ? browser.getByTestId('migration-history-source-discover') : browser.getByRole('button', { name: kind === 'memory' ? '查找记忆来源' : '查找可迁移内容', exact: true });
      await find.click();
      if (kind === 'configuration') {
        await waitFor(() => lostSelect, 15000, 'accepted opaque selection reply deliberately lost');
        await waitFor(async () => !await find.isDisabled(), 10000, 'unknown selection settles without default discovery');
        assert.equal(await browser.getByRole('checkbox').count(), 0); await find.click();
      }
      if (kind === 'history') {
        const row = browser.getByTestId('migration-history-source-row'); await row.waitFor(); await row.getByRole('checkbox').check();
        await row.getByText(/原始压缩文件/).waitFor();
        await browser.getByTestId('migration-history-source-transfer').click();
      } else if (kind === 'memory') {
        await browser.getByTestId('migration-memory-source-row').getByRole('checkbox').check();
        await browser.getByRole('button', { name: '传输所选资料（1）', exact: true }).click();
      } else {
        await browser.getByRole('checkbox', { name: kind === 'configuration' ? /Claude Code\s+用户配置/ : /技能/ }).check();
        await browser.getByRole('button', { name: '传输所选资料（1）', exact: true }).click();
      }
      await browser.getByTestId('migration-transfer-status').getByText('资料已接收', { exact: true }).waitFor({ timeout: 30000 });
      checkpoint.stage = 'adoption_preview';
      const adoption = browser.getByTestId('migration-source-adoption'); await adoption.getByTestId('migration-adoption-expand').click();
      await adoption.getByTestId('migration-adoption-received-row').getByRole('checkbox').check();
      await adoption.getByTestId('migration-adoption-prepare').click();
      await adoption.getByText('预览就绪，尚未保存', { exact: true }).waitFor({ timeout: 30000 });
      const openBatch = adoption.locator('[data-testid^="migration-adoption-open-"]').first(), jobId = (await openBatch.getAttribute('data-testid')).slice('migration-adoption-open-'.length);
      await openBatch.click(); await dialog.getByRole('heading', { name: '选择迁移内容', exact: true }).waitFor();
      checkpoint.stage = 'ordinary_batch';
      const items = await observer.rpc.request('migration/items', { jobId });
      const item = items.items.find(item => item.category === (kind === 'configuration' ? 'provider' : kind === 'asset' ? 'skill' : kind)); assert.ok(item);
      const row = dialog.getByTestId('migration-content-item').filter({ has: page.getByRole('checkbox', { name: `选择 ${item.sourceName}`, exact: true }) });
      if (kind === 'configuration' || kind === 'memory') {
        await row.getByRole('button', { name: '配置', exact: true }).click();
        if (kind === 'configuration') {
          await row.getByLabel('保存后的连接名称', { exact: true }).fill('UploadedBrowser');
          await row.getByLabel('上下文额度', { exact: true }).fill('128000'); await row.getByLabel('输出预留额度', { exact: true }).fill('8192'); await row.getByLabel('最大输出额度', { exact: true }).fill('8192');
        } else {
          await row.getByLabel('保存后的资产名称', { exact: true }).fill('uploaded-browser-notes');
          assert.equal(await row.getByLabel('目标笔记作用域').inputValue(), ''); await row.getByLabel('目标笔记作用域').selectOption('global');
        }
        await row.getByRole('button', { name: '保存选项并选择', exact: true }).click();
      } else await row.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: '确认所选内容', exact: true }).click(); await dialog.getByRole('heading', { name: '确认批量计划', exact: true }).waitFor();
      assert.deepEqual(await readFile(resolve(profile, 'settings.json')), caseSettings);
      const plan = await observer.rpc.request('migration/batch/item/plan', { jobId, itemId: item.id });
      await dialog.getByRole('button', { name: '开始批量迁移', exact: true }).click(); await dialog.getByRole('heading', { name: '迁移结果', exact: true }).waitFor({ timeout: 30000 });
      const completed = await observer.rpc.request('migration/batch/read', { jobId }); assert.equal(completed.state.job.committedItems, 1); assert.equal(completed.state.job.hasUnconfirmedOutcomes, false);
      if (kind === 'configuration') assert.equal(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')).providers.UploadedBrowser.default_model, 'uploaded-browser-model');
      else if (kind === 'asset') { const text = await readFile(resolve(profile, 'skills', plan.item.targetName, 'SKILL.md'), 'utf8'); assert.match(text, /UPLOADED_SKILL_BODY/); assert.match(text, /default_enabled: false/); }
      else if (kind === 'history') { const archived = await observer.rpc.request('migration/history/read', { jobId: plan.item.historyJobId }); assert.equal(archived.job.archived, true); assert.ok(archived.job.normalization.normalizedRecords > 0); }
      else { const notes = await observer.rpc.request('migration/memory/list', {}); assert.equal(notes.totalRecords, 1); assert.equal(notes.items[0].enabled, false); assert.equal(notes.items[0].provenance.factsVerified, false); assert.equal(notes.items[0].provenance.sourceModifiedAtMs ?? null, null); }
      await dialog.getByRole('button', { name: '撤销本次导入', exact: true }).click(); await dialog.getByText('本次新增内容已撤销', { exact: true }).waitFor({ timeout: 30000 });
      checkpoint.stage = 'undone';
      assert.equal((await observer.rpc.request('migration/batch/read', { jobId })).state.job.status, 'rolled_back');
      assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), JSON.parse(originalSettings.toString()));
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      results.push({ kind, operationId, manifestSha256: state.manifestSha256, jobId, source: 'user_supplied', explicitUploadAndPreparation: true, ordinaryBatchImportedAndUndone: true });
    }
    assert.equal(uploads.length, 4); assert.equal(cancels.length, 1); assert.equal(resumes.length, 1);
    const first = uploads[0].operationId; assert.deepEqual(parts.filter(part => part.operationId === first).map(part => part.partIndex), [0, 1, 2, 3]);
    const selected = queries.filter(request => request.query.kind === 'uploaded_select'); assert.equal(selected.length, 5);
    assert.deepEqual(selected[0], selected[1], 'lost selection reply reuses the original dedicated child and opaque binding');
    const authorized = new Set();
    for (const request of queries) {
      assert.equal(request.session.targetId, 'fixture-target');
      if (request.query.kind === 'uploaded_select') authorized.add(request.session.sessionId);
      else assert.ok(authorized.has(request.session.sessionId), 'no configuration/history/memory query may run before uploaded authorization');
      assert.notEqual(request.query.kind, 'directory_select', 'browser paths never become Native directory authorization');
    }
    assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('browser-source-upload-roundtrip.json', { passed: true, results, cancelledWhileChunkReplyPending: true, staleAcceptedReplyIgnored: true,
      sameManifestRequiredAfterReload: true, uploadedSourceSelectionLostReplyReconciled: true, lateProductCancelDidNotFabricateCancelled: true,
      privateDirectoryEntriesExcludedBeforeHash: true, noSourceHomeFallback: true, modelRequests: 0 });
    return { browserFiles: true, consumers: results.length, ordinaryImportAndUndo: true, modelRequests: 0 };
  } catch (error) {
    await context.writeArtifactJson('browser-source-upload-checkpoint.json', { checkpoint, completed: results,
      uploads: uploads.map(value => ({ operationId: value.operationId, source: value.manifest.source, files: value.manifest.files.length })),
      parts, cancellations: cancels.length, resumes: resumes.length, products: products.length,
      queryKinds: queries.map(value => value.query.kind), modelRequests: model.requests.length });
    throw error;
  } finally {
    try { heldPart?.socket.send(heldPart.raw); heldProduct?.socket.send(heldProduct.raw) } catch { /* Only this run's held replies may already be closed. */ }
    await observer.close();
  }
}
