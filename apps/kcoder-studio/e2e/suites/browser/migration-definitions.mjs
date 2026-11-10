import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
export async function seedDefinitionFixture(context, claude, codex) {
  const marker = context.pathInState('definition-command-must-not-run');
  const command = `printf invoked > '${marker.replaceAll("'", "'\\''")}'`;
  const hooks = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, prompt: 'Not a runtime prompt', timeout: 10, async: true, statusMessage: 'source-only', once: true, model: 'inert', args: ['never'], description: 'source data', PRIVATE_UNKNOWN_HOOK_KEY: 'opaque source data' }] }] } };
  const text = '<script>globalThis.KCODER_DEFINITION_EXECUTED=true</script>\n' + '定义资料未经验证，不授予执行权限。'.repeat(2000);
  for (const root of [claude, codex]) await mkdir(resolve(root, 'agents'), { recursive: true, mode: 0o700 });
  const yaml = '---\nname: review\ndescription: inert source definition\nmodel: inert\ntools: Bash\ndisallowedTools: Write\npermissionMode: bypassPermissions\nskills: [never-load]\nmcpServers: [never-connect]\nhooks: {}\nmemory: project\nbackground: true\nPRIVATE_UNKNOWN_FIELD: opaque\n---\n' + text;
  const toml = `name='review'\ndescription='inert source definition'\nmodel='inert'\ndeveloper_instructions='''${text}'''\n` + Array.from({ length: 12 }, (_, i) => `PRIVATE_UNKNOWN_FIELD_${i}='opaque'`).join('\n') + '\n';
  await writeFile(resolve(claude, 'agents/review.md'), yaml, { mode: 0o600 });
  await writeFile(resolve(codex, 'agents/review.toml'), toml, { mode: 0o600 });
  await writeFile(resolve(claude, 'agents/opaque.md'), Buffer.from([255, 0, 254]), { mode: 0o600 });
  await writeFile(resolve(codex, 'agents/opaque.toml'), Buffer.from([255, 0, 254]), { mode: 0o600 });
  const settings = JSON.parse(await readFile(resolve(claude, 'settings.json'), 'utf8')); settings.hooks = hooks.hooks;
  await writeFile(resolve(claude, 'settings.json'), JSON.stringify(settings), { mode: 0o600 });
  await writeFile(resolve(codex, 'hooks.json'), JSON.stringify(hooks), { mode: 0o600 });
  return { roots: { 'claude-code': claude, codex }, marker, bodies: { 'claude-code': yaml, codex: toml } };
}
/** Real UI shares one ordinary Native batch; pending definitions never become runtime Agents/Hooks. */
export async function exerciseDefinitionUi({ context, page, gateway, profile, workspace, fixture, model, mobile = false }) {
  const target = mobile ? 'migration-target' : 'fixture-target', observer = await openOwnedMobileRpc(context, gateway, target, workspace);
  const original = JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), results = [];
  let checkpoint = { kind: null, stage: 'starting' };
  const native = (method, params) => observer.rpc.request(method, params);
  const confirm = async word => { if (mobile) { await page.getByTestId('migration-batch-confirm-input').fill(word); await page.getByTestId('migration-batch-confirm-submit').click(); } };
  try {
    if (!mobile) { await page.goto(`${gateway.baseUrl}/settings/general`); await page.getByTestId('general-language-en-button').click(); }
    for (const kind of ['claude-code', 'codex']) {
      checkpoint = { kind, stage: 'discover' };
      if (mobile) await page.getByTestId('migration-tab-definitions').click();
      else { await page.getByTestId('general-external-content-import-button').click(); const dialog = page.getByTestId('migration-dialog'); await dialog.locator('#migration-target').selectOption(target); await selectAdvancedMigration(dialog, 'definitions'); }
      const panel = page.getByTestId('migration-definition-sources'); await panel.getByRole('button', { name: kind === 'codex' ? 'Codex' : 'Claude Code', exact: true }).click();
      assert.equal(await panel.locator('[data-testid="definition-source-row"]').count(), 0, 'opening the tab does not discover automatically');
      await panel.getByTestId('definition-discover').click(); await panel.getByTestId('definition-source-row').first().waitFor();
      assert.ok(await panel.getByTestId('definition-source-row').count() <= 10);
      if (mobile) for (const row of await panel.locator('[data-testid^="definition-select-"]').all()) await row.click();
      else for (const box of await panel.getByRole('checkbox').all()) { const name = await box.getAttribute('type'); if (name === 'checkbox' && await box.locator('..').innerText().then(text => text.includes('Pending definition only'))) await box.check(); }
      await panel.getByTestId('definition-prepare').click();
      const editor = mobile ? page.getByTestId('migration-batch-editor') : page.getByTestId('migration-dialog');
      if (mobile) await editor.waitFor(); else await editor.getByRole('heading', { name: 'Select migration content', exact: true }).waitFor();
      let jobId;
      // Only this isolated profile's already created previews are listed; no alternate source grant is created.
      if (mobile) {
        const jobs = await native('migration/jobs/list', {}); jobId = jobs.jobs.find(row => row.job.status === 'ready' && row.selectedItems === 0)?.job.jobId;
      } else {
        const jobs = await native('migration/jobs/list', {}); jobId = jobs.jobs.find(row => row.job.status === 'ready' && row.selectedItems === 0)?.job.jobId;
      }
      assert.ok(jobId); const items = await native('migration/items', { jobId }); assert.equal(items.items.length, 3); assert.ok(items.items.every(row => ['agent', 'hook'].includes(row.category)));
      const review = items.items.find(row => row.sourceName.startsWith('review.')); assert.ok(review);
      checkpoint = { kind, stage: 'configure', jobId };
      if (!mobile) {
        const definitionRow = editor.getByTestId('migration-content-item').filter({ hasText: review.sourceName });
        await definitionRow.getByTestId('definition-report').click(); await definitionRow.getByTestId('definition-field-report').waitFor(); assert.equal(await definitionRow.getByTestId('definition-field').count(), 10);
        assert.ok(!(await definitionRow.getByTestId('definition-field-report').innerText()).includes('PRIVATE_UNKNOWN_FIELD'));
        await definitionRow.getByTestId('definition-field-report').getByRole('button', { name: 'Next', exact: true }).click(); await waitFor(async () => await definitionRow.getByTestId('definition-field').count() <= 10, 10000, 'second valueless definition field page');
      }
      for (let index = 0; index < items.items.length; index++) {
        const item = items.items[index];
        if (mobile) {
          await editor.getByTestId(`migration-item-edit-${item.id}`).click(); const form = page.getByTestId('migration-item-editor');
          assert.equal(await form.getByTestId('migration-item-enable').count(), 0); await form.getByTestId('migration-item-name').fill(`pending-${kind}-${index}`);
          if (item.id === review.id) { await form.getByTestId('definition-report').click(); await form.getByTestId('definition-field-report').waitFor(); assert.equal(await form.getByTestId('definition-field').count(), 10); assert.ok(!(await form.getByTestId('definition-field-report').innerText()).includes('PRIVATE_UNKNOWN_FIELD')); await form.getByTestId('definition-field-report').getByRole('button', { name: 'Next', exact: true }).click(); }
          await form.getByTestId('migration-item-save').click();
        } else {
          const row = editor.getByTestId('migration-content-item').filter({ hasText: item.sourceName }); await row.getByRole('button', { name: 'Configure', exact: true }).click();
          assert.equal(await row.getByText('Enable after import', { exact: true }).count(), 0); await row.getByLabel('Saved asset name', { exact: true }).fill(`pending-${kind}-${index}`); await row.getByRole('button', { name: 'Save options and select', exact: true }).click();
        }
      }
      if (mobile) await page.getByTestId('migration-preview-plan').click(); else await editor.getByRole('button', { name: 'Confirm selected content', exact: true }).click();
      if (mobile) await page.getByTestId('migration-batch-operation').waitFor(); else await editor.getByRole('heading', { name: 'Confirm batch plan', exact: true }).waitFor();
      const planned = await native('migration/batch/read', { jobId }); assert.ok(planned.state.batch.planId);
      const planItems = await native('migration/items', { jobId }); assert.ok(planItems.planned.every(row => row.enabled === false));
      if (mobile) { await page.getByTestId('migration-batch-operation').waitFor(); await page.getByTestId('migration-batch-import').click(); await confirm('IMPORT'); }
      else { await editor.getByRole('button', { name: 'Start batch migration', exact: true }).click(); await confirm('IMPORT'); }
      await waitFor(async () => { const state = await native('migration/batch/read', { jobId }); return state.state.job.committedItems === 3 && !state.workerRunning; }, 30000, 'three pending definitions saved without activation');
      await rename(fixture.roots[kind], `${fixture.roots[kind]}-withheld`); checkpoint.stage = 'source-free-read';
      assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), original);
      // Reopening and body reads use the original Native job/item, never a newest-name lookup.
      if (mobile) { await page.getByTestId('migration-tab-records').click(); await page.getByTestId(`migration-batch-record-${jobId}`).click(); await page.getByTestId('migration-batch-operation').waitFor(); }
      const root = mobile ? page.getByTestId('migration-batch-operation') : editor;
      const previews = root.getByTestId('migration-definition-preview'); await previews.first().waitFor();
      const position = items.items.findIndex(row => row.id === review.id), selectedPreview = previews.nth(position);
      await selectedPreview.getByTestId('definition-body').click(); await selectedPreview.getByTestId('definition-body-window').waitFor(); await selectedPreview.getByText('<script>globalThis.KCODER_DEFINITION_EXECUTED=true</script>', { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => globalThis.KCODER_DEFINITION_EXECUTED), undefined);
      await selectedPreview.getByTestId('definition-body-window').getByRole('button', { name: 'Next', exact: true }).click();
      const raw = await native('migration/definitions/body', { jobId, itemId: review.id }); assert.equal(raw.text, fixture.bodies[kind].slice(0, raw.text.length)); assert.ok(Buffer.byteLength(raw.text) <= 16384); assert.ok(raw.nextOffset);
      const opaque = items.items.find(row => row.sourceName.startsWith('opaque.')), opaqueRead = await native('migration/definitions/body', { jobId, itemId: opaque.id }); assert.equal(opaqueRead.encoding, 'binary'); assert.deepEqual(Buffer.from(opaqueRead.bytesBase64, 'base64'), Buffer.from([255, 0, 254]));
      const hook = items.items.find(row => row.category === 'hook'), hookRead = await native('migration/definitions/body', { jobId, itemId: hook.id }); assert.ok(!hookRead.text.includes('SYNTHETIC_NONHOOK_SECRET')); assert.match(hookRead.text, /definition-command-must-not-run/);
      if (mobile) { await page.getByTestId('migration-batch-undo').click(); await confirm('UNDO'); }
      else await editor.getByRole('button', { name: 'Undo this import', exact: true }).click();
      await waitFor(async () => (await native('migration/batch/read', { jobId })).state.job.status === 'rolled_back', 30000, 'same pending owner undone');
      assert.equal((await native('migration/definitions/body', { jobId, itemId: review.id })).sha256, raw.sha256, 'Undo retains the original audit snapshot');
      assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), original); results.push({ kind, jobId, committed: 3, disabled: true, sourceRemoved: true, bodyAfterUndoRetained: true });
      if (!mobile) await editor.getByRole('button', { name: 'Close', exact: true }).click();
    }
    // Restore only this run's original Claude directory to exercise the independent source child.
    await rename(`${fixture.roots['claude-code']}-withheld`, fixture.roots['claude-code']);
    checkpoint = { kind: 'source-session', stage: 'transfer' };
    if (mobile) { await page.getByTestId('migration-tab-source').click(); await page.getByTestId('migration-source-remote-mode').click(); await page.getByTestId(`source-device-${target}`).click(); const source = page.getByTestId('migration-source-browser'); await source.getByTestId('source-browser-product-claude-code').click(); await source.getByTestId('source-browser-mode-definitions').click(); await source.getByTestId('source-browser-discover').click(); await source.locator('[data-testid^="source-browser-select-"]').first().waitFor(); for (const row of await source.locator('[data-testid^="source-browser-select-"]').all()) await row.click(); await source.getByTestId('source-browser-transfer').click(); await source.getByTestId('source-transfer-status').getByText('Sources received; not imported', { exact: true }).waitFor({ timeout: 30000 }); }
    else { await page.getByTestId('general-external-content-import-button').click(); const dialog = page.getByTestId('migration-dialog'); await dialog.locator('#migration-target').selectOption(target); await selectAdvancedMigration(dialog, 'source'); const source = dialog.getByTestId('migration-source-browser'); await source.locator('#migration-source-device').selectOption(target); await source.getByTestId('migration-source-mode-definitions').click(); const definitions = source.getByTestId('migration-definition-source-browser'); await definitions.getByRole('button', { name: 'Find migration sources', exact: true }).click(); await definitions.getByTestId('migration-definition-source-row').first().waitFor(); for (const row of await definitions.getByTestId('migration-definition-source-row').all()) await row.getByRole('checkbox').check(); await definitions.getByRole('button', { name: /Transfer selected data/ }).click(); await definitions.getByTestId('migration-transfer-status').getByText('Data received', { exact: true }).waitFor({ timeout: 30000 }); }
    const adoption = page.getByTestId('migration-source-adoption'); await adoption.getByTestId(mobile ? 'source-adoption-expand' : 'migration-adoption-expand').click();
    if (mobile) { await adoption.locator('[data-testid^="source-adoption-select-"]').first().waitFor(); for (const row of await adoption.locator('[data-testid^="source-adoption-select-"]').all()) await row.click(); } else { await adoption.getByTestId('migration-adoption-received-row').first().waitFor(); for (const row of await adoption.getByTestId('migration-adoption-received-row').all()) await row.getByRole('checkbox').check(); }
    await adoption.getByTestId(mobile ? 'source-adoption-prepare' : 'migration-adoption-prepare').click(); await adoption.getByText(mobile ? 'Preview Ready; not saved' : 'Previews ready; nothing saved yet', { exact: true }).waitFor({ timeout: 30000 });
    const open = adoption.locator(`[data-testid^="${mobile ? 'source-adoption-open-' : 'migration-adoption-open-'}"]`).first(), sourceJob = (await open.getAttribute('data-testid')).split(mobile ? 'source-adoption-open-' : 'migration-adoption-open-')[1]; await open.click();
    const sourceItems = await native('migration/items', { jobId: sourceJob }); assert.equal(sourceItems.items.length, 3);
    for (let index = 0; index < sourceItems.items.length; index++) { const item = sourceItems.items[index]; if (mobile) { await page.getByTestId(`migration-item-edit-${item.id}`).click(); assert.equal(await page.getByTestId('migration-item-enable').count(), 0); await page.getByTestId('migration-item-name').fill(`received-definition-${index}`); await page.getByTestId('migration-item-save').click(); } else { const row = page.getByTestId('migration-content-item').filter({ hasText: item.sourceName }); await row.getByRole('button', { name: 'Configure', exact: true }).click(); await row.getByLabel('Saved asset name').fill(`received-definition-${index}`); await row.getByRole('button', { name: 'Save options and select', exact: true }).click(); } }
    if (mobile) { await page.getByTestId('migration-preview-plan').click(); await page.getByTestId('migration-batch-operation').waitFor(); await page.getByTestId('migration-batch-import').click(); await confirm('IMPORT'); } else { await page.getByRole('button', { name: 'Confirm selected content', exact: true }).click(); await page.getByRole('button', { name: 'Start batch migration', exact: true }).click(); await confirm('IMPORT'); }
    await waitFor(async () => { const value = await native('migration/batch/read', { jobId: sourceJob }); return value.state.job.committedItems === 3 && !value.workerRunning; }, 30000, 'received definitions committed only to the pending library');
    const receivedPlans = await native('migration/items', { jobId: sourceJob }); assert.ok(receivedPlans.planned.every(row => row.enabled === false));
    if (mobile) { await page.getByTestId('migration-batch-undo').click(); await confirm('UNDO'); } else await page.getByRole('button', { name: 'Undo this import', exact: true }).click();
    await waitFor(async () => (await native('migration/batch/read', { jobId: sourceJob })).state.job.status === 'rolled_back', 30000, 'received definition original batch Undo');
    assert.deepEqual(JSON.parse(await readFile(resolve(profile, 'settings.json'), 'utf8')), original);
    results.push({ kind: 'source-session-claude', jobId: sourceJob, committed: 3, disabled: true, transferredAndAdopted: true });
    assert.equal(await access(fixture.marker).then(() => true, () => false), false); assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('passive-definitions-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web Chromium' : 'Studio Web Chromium', results, fieldPageLimit: 10, bodyWindowLimit: 16384, rawMarkupInert: true, sourceCommandsNeverRun: true, targetRuntimeSettingsUnchanged: true, pendingOnly: true, modelRequests: 0 });
    return { vendors: 2, savedDefinitions: 9, pendingOnly: true, modelRequests: 0 };
  } catch (error) { await context.writeArtifactJson('passive-definitions-checkpoint.json', { checkpoint, results }); throw error; }
  finally { await observer.close(); }
}
