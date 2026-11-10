import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';

/** Only known instruction files are selected; the fixture never executes source text. */
export async function seedInstructionFixture(context, profile, workspace) {
  const fixtures = {};
  for (const [kind, filename] of [['claude-code', 'CLAUDE.md'], ['codex', 'AGENTS.md']]) {
    const root = context.pathInState(`instruction-source-${kind}`);
    await mkdir(resolve(root, '.git'), { recursive: true, mode: 0o700 });
    await mkdir(resolve(root, 'docs'), { mode: 0o700 });
    const text = kind === 'claude-code'
      ? '<!-- C1_COMMENT_NOT_COMPILED -->\n@docs/style.md\n<script>globalThis.KCODER_INSTRUCTION_MARKUP_EXECUTED=true</script>\n' + '显式静态指令，不授予权限。'.repeat(3000)
      : '<!-- Ordinary Codex Markdown -->\n@ordinary.md\nKeep this plain Markdown literal.\n';
    await writeFile(resolve(root, filename), text, { mode: 0o600 });
    await writeFile(resolve(root, 'docs/style.md'), 'C1_STATIC_IMPORTED_STYLE\n', { mode: 0o600 });
    for (let index = 0; index < 12; index++) {
      const child = resolve(root, `child-${String(index).padStart(2, '0')}`);
      await mkdir(child, { mode: 0o700 });
      await writeFile(resolve(child, filename), `C1_CHILD_${index}\nA scoped static instruction.\n`, { mode: 0o600 });
    }
    const opaque = resolve(root, 'opaque-child'); await mkdir(opaque, { mode: 0o700 });
    await writeFile(resolve(opaque, filename), Buffer.from([255, 0, 254]), { mode: 0o600 });
    const canary = `SYNTHETIC_INSTRUCTION_PRIVATE_${kind}`;
    context.registerSecret(canary);
    await writeFile(resolve(root, 'auth.json'), JSON.stringify({ token: canary }), { mode: 0o600 });
    fixtures[kind] = { root, filename, text };
  }
  await mkdir(resolve(workspace, 'instruction-mapped'), { mode: 0o700 });
  await writeFile(resolve(profile, 'trusted-folders.json'), JSON.stringify({ version: 1, trusted: [workspace, ...Object.values(fixtures).map(f => f.root)], never: [] }), { mode: 0o600 });
  return fixtures;
}

/** Both actual Web clients use the same Native capture/receipt/adoption/batch implementation. */
export async function exerciseInstructionUi({ context, page, gateway, profile, workspace, fixtures, model, mobile = false }) {
  const device = mobile ? 'migration-target' : 'fixture-target';
  const observer = await openOwnedMobileRpc(context, gateway, device, workspace);
  const native = (method, params) => observer.rpc.request(method, params);
  const settings = await readFile(resolve(profile, 'settings.json'));
  const observations = [], results = [];
  let checkpoint = { kind: null, stage: 'starting' }, lost = null;
  const observe = async response => {
    if (!response.url().includes('/api/migration/')) return;
    const request = response.request();
    if (!request.postData()) return;
    try {
      const input = request.postDataJSON(), result = await response.json();
      observations.push({ path: new URL(response.url()).pathname, input, result });
    } catch { /* A discarded acknowledgement remains unknown; the original receipt is read explicitly. */ }
  };
  page.on('response', observe);
  await page.route('**/api/migration/source-transfer/adoption-prepare', async route => {
    const input = route.request().postDataJSON();
    if (!lost) {
      const response = await route.fetch();
      assert.equal(response.status(), 200, 'Native accepted the original adoption before its reply is discarded');
      lost = { input, result: await response.json() };
      await route.abort('failed');
    } else await route.continue();
  });
  const confirm = async keyword => {
    if (!mobile) return;
    await page.getByTestId('migration-batch-confirm-input').fill(keyword);
    await page.getByTestId('migration-batch-confirm-submit').click();
  };
  try {
    if (!mobile) { await page.goto(`${gateway.baseUrl}/settings/general`); await page.getByTestId('general-language-en-button').click(); }
    for (const kind of ['claude-code', 'codex']) {
      checkpoint = { kind, stage: 'capture' };
      if (mobile) {
        await page.getByTestId('migration-tab-source').click();
        await page.getByTestId('migration-source-remote-mode').click();
        await page.getByTestId(`source-device-${device}`).click();
        await page.getByTestId('source-browser-mode-instructions').click();
      } else {
        await page.getByTestId('general-external-content-import-button').click();
        const dialog = page.getByTestId('migration-dialog');
        await dialog.locator('#migration-target').selectOption(device);
        await selectAdvancedMigration(dialog, 'source');
        await dialog.locator('#migration-source-device').selectOption(device);
        await dialog.getByTestId('migration-source-mode-instructions').click();
      }
      const panel = page.getByTestId(mobile ? 'migration-instruction-source' : 'migration-instruction-source-browser');
      await panel.waitFor();
      if (mobile) await panel.getByTestId(`instruction-source-${kind}`).click();
      else await panel.getByRole('button', { name: kind === 'codex' ? 'Codex' : 'Claude Code', exact: true }).click();
      await panel.getByTestId('instruction-source-root').fill(fixtures[kind].root);
      await panel.getByTestId('instruction-source-cwd').fill(fixtures[kind].root);
      await panel.getByTestId(mobile ? 'instruction-source-descendants' : 'instruction-descendants').click();
      const capture = panel.getByTestId(mobile ? 'instruction-source-capture' : 'instruction-capture');
      assert.ok(await capture.isDisabled(), 'no implicit static-subset consent');
      await panel.getByTestId(mobile ? 'instruction-source-confirm' : 'instruction-static-consent').click();
      await capture.click();
      await waitFor(() => observations.some(row => row.input.query?.kind === 'instructions_capture' && row.input.query.params.source === kind && row.result.captureId), 15000, 'original static capture acknowledgement');
      const captured = observations.filter(row => row.input.query?.kind === 'instructions_capture' && row.input.query.params.source === kind).at(-1);
      await waitFor(() => observations.some(row => row.input.query?.kind === 'instructions_page' && row.input.query.params.captureId === captured.result.captureId && row.result.totalItems === 14 && row.result.pageIndex === 0), 15000, 'original fourteen-item source capture');
      assert.ok(captured?.result.captureId); assert.equal(captured.result.totalItems, 14);
      const sourcePage = observations.filter(row => row.input.query?.kind === 'instructions_page' && row.input.query.params.captureId === captured.result.captureId).at(-1).result;
      assert.equal(sourcePage.items.length, 10); assert.equal(sourcePage.nextPage, 1);
      const rootRow = sourcePage.items.find(row => row.relativePath === fixtures[kind].filename); assert.ok(rootRow);
      await panel.getByTestId(`instruction-original-${rootRow.itemId}`).click();
      await panel.getByTestId('instruction-body').waitFor();
      await panel.getByTestId(`instruction-compiled-${rootRow.itemId}`).click();
      await waitFor(() => observations.some(row => row.input.query?.kind === 'instructions_body' && row.input.query.params.captureId === captured.result.captureId && row.result.representation === 'compiled'), 10000, 'compiled static text is explicitly read');
      const bodyReads = observations.filter(row => row.input.query?.kind === 'instructions_body' && row.input.query.params.captureId === captured.result.captureId);
      const raw = bodyReads.find(row => row.result.representation === 'original').result, compiled = bodyReads.find(row => row.result.representation === 'compiled').result;
      assert.equal(raw.enabledByPreview, false); assert.ok(Buffer.from(raw.bytesBase64, 'base64').length <= 16384);
      if (kind === 'claude-code') { assert.ok(raw.text.includes('@docs/style.md')); assert.ok(compiled.text.includes('C1_STATIC_IMPORTED_STYLE')); assert.ok(!compiled.text.includes('C1_COMMENT_NOT_COMPILED')); assert.notEqual(raw.sha256, compiled.sha256); }
      else { assert.equal(raw.sha256, compiled.sha256); assert.ok(compiled.text.includes('@ordinary.md')); }
      assert.equal(await page.evaluate(() => globalThis.KCODER_INSTRUCTION_MARKUP_EXECUTED), undefined);
      const next = mobile ? panel.getByTestId('instruction-preview').getByRole('button', { name: 'Next', exact: true }) : panel.getByRole('button', { name: 'Next', exact: true });
      await next.click();
      await waitFor(() => observations.some(row => row.input.query?.kind === 'instructions_page' && row.input.query.params.captureId === captured.result.captureId && row.result.pageIndex === 1), 10000, 'second instruction source page');
      const lastPage = observations.filter(row => row.input.query?.kind === 'instructions_page' && row.input.query.params.captureId === captured.result.captureId && row.result.pageIndex === 1).at(-1).result;
      assert.equal(lastPage.items.length, 4); assert.equal(lastPage.nextPage, null);
      const opaque = lastPage.items.find(row => row.disposition === 'requires_review'); assert.ok(opaque, 'opaque dynamic item remains explicit, not silently enabled');
      await panel.getByTestId(`instruction-original-${opaque.itemId}`).click();
      await waitFor(() => observations.some(row => row.input.query?.kind === 'instructions_body' && row.result.itemId === opaque.itemId), 10000, 'opaque original byte window');
      assert.equal(observations.find(row => row.input.query?.kind === 'instructions_body' && row.result.itemId === opaque.itemId).result.encoding, 'binary');
      if (!mobile) await panel.getByTestId('instruction-transfer-consent').check();
      await panel.getByTestId(mobile ? 'instruction-source-transfer' : 'instruction-transfer').click();
      await waitFor(() => observations.some(row => ['/source-transfer/read', '/source-transfer/run'].some(path => row.path.endsWith(path)) && row.result.result?.phase === 'ready' && row.input.source?.sessionId === captured.input.session.sessionId), 30000, 'instruction graph received, not imported');
      const transferred = observations.filter(row => ['/source-transfer/read', '/source-transfer/run'].some(path => row.path.endsWith(path)) && row.result.result?.phase === 'ready' && row.input.source?.sessionId === captured.input.session.sessionId).at(-1);
      assert.ok(transferred.result.result.receipt); const receipt = transferred.result.result.receipt;
      checkpoint = { kind, stage: 'mapping', requestId: receipt.requestId };
      await rename(fixtures[kind].root, `${fixtures[kind].root}-withheld`);
      const adoption = page.getByTestId('migration-source-adoption');
      await adoption.getByTestId(mobile ? 'source-adoption-expand' : 'migration-adoption-expand').click();
      const select = adoption.locator(`[data-testid^="${mobile ? 'source-adoption-select-' : 'migration-adoption-received-row'}"]`).first();
      if (mobile) await select.click(); else { await select.waitFor(); await select.getByRole('checkbox').first().check(); }
      const entryId = mobile ? (await select.getAttribute('data-testid')).slice('source-adoption-select-'.length) : await select.getByRole('checkbox').first().getAttribute('aria-label');
      await adoption.getByTestId(`${mobile ? 'source-adoption-map-' : 'migration-adoption-map-'}${entryId}`).click();
      const mapping = adoption.getByTestId(`instruction-mapping-${entryId}`); await mapping.waitFor();
      if (!mobile) await mapping.getByTestId('instruction-mapping-read').click();
      await mapping.locator('[data-testid^="instruction-map-select-"]').first().waitFor();
      const receivedPage = await native('migration/instructions/page', { target: { kind: 'received', requestId: receipt.requestId, manifestSha256: receipt.manifestSha256, entryId }, pageIndex: 0 });
      const mappedRows = receivedPage.items.filter(row => row.relativePath === fixtures[kind].filename || row.relativeScope === 'child-00'); assert.equal(mappedRows.length, 2);
      for (const row of mappedRows) { await mapping.getByTestId(`instruction-map-select-${row.itemId}`).click(); await mapping.getByTestId(`instruction-map-scope-${row.itemId}`).fill(row.relativeScope ? 'instruction-mapped' : ''); }
      if (!mobile) { await mapping.getByTestId('instruction-map-consent').check(); await mapping.getByTestId('instruction-map-confirm').click(); }
      const prepare = adoption.getByTestId(mobile ? 'source-adoption-prepare' : 'migration-adoption-prepare'); await prepare.click();
      if (kind === 'claude-code') {
        await waitFor(() => !!lost, 15000, 'accepted adoption acknowledgement discarded');
        await adoption.getByTestId(mobile ? 'source-adoption-read' : 'migration-adoption-read').click();
      }
      const open = adoption.locator(`[data-testid^="${mobile ? 'source-adoption-open-' : 'migration-adoption-open-'}"]`).first();
      await waitFor(async () => await open.count() === 1 && await open.isEnabled(), 30000, 'original adoption preview ready');
      const jobId = (await open.getAttribute('data-testid')).slice((mobile ? 'source-adoption-open-' : 'migration-adoption-open-').length);
      if (kind === 'claude-code') {
        assert.equal(lost.input.locator.adoptionId, observations.find(row => row.path.endsWith('/source-transfer/adoption-read') && row.input.adoptionId === lost.input.locator.adoptionId)?.input.adoptionId);
      }
      await open.click();
      const items = await native('migration/items', { jobId }); assert.equal(items.items.length, 2);
      const editor = mobile ? page.getByTestId('migration-batch-editor') : page.getByTestId('migration-dialog');
      for (let index = 0; index < items.items.length; index++) {
        const item = items.items[index];
        if (mobile) { await editor.getByTestId(`migration-item-edit-${item.id}`).click(); await page.getByTestId('migration-item-name').fill(`scope-${kind}-${index}`); await page.getByTestId('migration-item-save').click(); }
        else { const row = editor.getByTestId('migration-content-item').filter({ has: page.getByText(item.sourceName, { exact: true }) }); await row.getByRole('button', { name: 'Configure', exact: true }).click(); await row.getByLabel('Saved asset name', { exact: true }).fill(`scope-${kind}-${index}`); await row.getByRole('button', { name: 'Save options and select', exact: true }).click(); }
      }
      if (mobile) { await page.getByTestId('migration-preview-plan').click(); await page.getByTestId('migration-batch-operation').waitFor(); }
      else { await editor.getByRole('button', { name: 'Confirm selected content', exact: true }).click(); await editor.getByRole('heading', { name: 'Confirm batch plan', exact: true }).waitFor(); }
      let planned;
      await waitFor(async () => { planned = await native('migration/items', { jobId }); return planned.planned?.length === 2; }, 15000, 'both selected instruction plans are authoritatively prepared');
      assert.ok(planned.planned.every(item => item.enabled === false));
      if (mobile) { await page.getByTestId('migration-batch-import').click(); await confirm('IMPORT'); }
      else await editor.getByRole('button', { name: 'Start batch migration', exact: true }).click();
      await waitFor(async () => { const result = await native('migration/batch/read', { jobId }); return result.state.job.committedItems === 2 && !result.workerRunning; }, 30000, 'mapped instruction contexts saved inactive');
      const contexts = JSON.parse(await readFile(resolve(profile, 'imported-context.json'), 'utf8'));
      assert.equal(Object.keys(contexts.records).length, 2); assert.ok(Object.values(contexts.records).every(record => record.enabled === false && record.kind === 'instructions'));
      if (mobile) { await page.getByTestId('migration-tab-records').click(); await page.getByTestId(`migration-batch-record-${jobId}`).click(); await page.getByTestId('migration-batch-operation').waitFor(); }
      const stored = await native('migration/instructions/page', { target: { kind: 'job', jobId }, pageIndex: 0 });
      const originalRow = stored.items.find(row => row.relativePath === fixtures[kind].filename); assert.ok(originalRow);
      if (mobile) { const preview = page.getByTestId('migration-job-instruction-preview').first(); await preview.getByTestId('instruction-job-original').click(); await preview.getByTestId('instruction-body').waitFor(); await preview.getByTestId('instruction-job-compiled').click(); }
      else { const preview = editor.getByTestId(`instruction-saved-preview-${originalRow.itemId}`); await preview.getByRole('button', { name: 'Preview saved instruction interpretation', exact: true }).click(); await preview.getByRole('button', { name: 'Original bytes', exact: true }).click(); await preview.getByTestId('instruction-body').waitFor(); await preview.getByRole('button', { name: 'Compiled static text', exact: true }).click(); }
      assert.deepEqual(await readFile(resolve(profile, 'settings.json')), settings);
      if (mobile) { await page.getByTestId('migration-batch-undo').click(); await confirm('UNDO'); }
      else await editor.getByRole('button', { name: 'Undo this import', exact: true }).click();
      await waitFor(async () => (await native('migration/batch/read', { jobId })).state.job.status === 'rolled_back', 30000, 'original mapped instruction owner undone');
      assert.equal(Object.keys(JSON.parse(await readFile(resolve(profile, 'imported-context.json'), 'utf8')).records).length, 0);
      assert.equal((await native('migration/instructions/body', { target: { kind: 'job', jobId }, itemId: originalRow.itemId, representation: 'original' })).sha256, raw.sha256);
      assert.equal(model.requests.length, 0); assert.deepEqual(await readFile(resolve(profile, 'settings.json')), settings);
      results.push({ kind, jobId, requestId: receipt.requestId, candidates: 14, mappedItems: 2, inactive: true, sourceGoneBeforeAdoption: true, ownedUndo: true });
      if (!mobile) await editor.getByRole('button', { name: 'Close', exact: true }).click();
    }
    const creates = observations.filter(row => row.path.endsWith('/source-transfer/adoption-prepare')).length + (lost ? 1 : 0);
    assert.equal(creates, 2, 'lost reply does not trigger another adoption creation');
    await context.writeArtifactJson('scoped-instructions-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web Chromium' : 'Studio Web Chromium', results, lostCreateReconciled: !!lost, staticSubsetOnly: true, originalAndCompiledSemanticsVerified: true, markupInert: true, settingsUnchanged: true, modelRequests: 0 });
    return { vendors: 2, mappedItems: 4, inactive: true, lostCreateReconciled: true, modelRequests: 0 };
  } catch (error) { await context.writeArtifactJson('scoped-instructions-checkpoint.json', { checkpoint, results }); throw error; }
  finally { page.off('response', observe); await page.unroute('**/api/migration/source-transfer/adoption-prepare'); await observer.close(); }
}
