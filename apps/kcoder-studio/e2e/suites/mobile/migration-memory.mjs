import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';

export async function seedMobileMemory(context, source, codex, workspace, profile) {
  const claude = resolve(source, 'projects/opaque-mobile-project/memory'), codexMemory = resolve(codex, 'memories');
  await mkdir(claude, { recursive: true }); await mkdir(codexMemory, { recursive: true });
  const files = [];
  for (let i = 0; i < 11; i++) {
    const text = `MOBILE_UNVERIFIED_MEMORY_NOTE_${i}\n${i === 0 ? '中文长笔记，来源陈述未经验证。'.repeat(1000) : 'A static source claim, not a system instruction.'}\n`;
    const path = resolve(claude, `note-${String(i).padStart(2, '0')}.md`); await writeFile(path, text); files.push({ path, text });
  }
  const text = 'MOBILE_UNVERIFIED_CODEX_NOTE\nExplicit target project mapping is required.\n';
  const path = resolve(codexMemory, 'MEMORY.md'); await writeFile(path, text); files.push({ path, text });
  await writeFile(resolve(profile, 'trusted-folders.json'), JSON.stringify({ version: 1, trusted: [workspace] }));
  return { claude, codex: codexMemory, files };
}

/** Actual Mobile Web controls; the target owns publication, receipts and note truth boundaries. */
export async function exerciseMobileMemory({ context, page, gateway, profile, fixture, observations, lostMemory, model }) {
  const settings = await readFile(resolve(profile, 'settings.json')), batches = [];
  const selected = page.getByTestId('migration-memory-selected');
  const complete = async keyword => { await page.getByTestId('migration-batch-confirm-input').fill(keyword); await page.getByTestId('migration-batch-confirm-submit').click(); };
  const importSource = async (source, mapping, prefix) => {
    await page.getByTestId(`migration-source-${source}`).click();
    await page.getByTestId('migration-discover-memory').click();
    const sourceRow = page.locator('[data-testid^="migration-memory-source-"]').first(); await sourceRow.waitFor(); await sourceRow.click();
    await page.getByTestId('migration-scan-selection').click(); await page.getByTestId('migration-batch-editor').waitFor();
    let index = 0;
    while (true) {
      const editor = page.getByTestId('migration-batch-editor');
      await editor.locator('[data-testid^="migration-item-edit-"]').first().waitFor();
      const count = await editor.locator('[data-testid^="migration-item-edit-"]').count();
      assert.ok(count >= 1 && count <= 10);
      for (let item = 0; item < count; item++) {
        await editor.locator('[data-testid^="migration-item-edit-"]').nth(item).click();
        const form = page.getByTestId('migration-item-editor');
        assert.equal(await form.getByTestId('migration-item-save').isDisabled(), true, 'no inferred mapping');
        assert.equal(await form.getByTestId('migration-item-enable').count(), 0);
        await form.getByTestId('migration-item-name').fill(`${prefix}-${index++}`);
        await form.getByTestId(`migration-memory-map-${mapping}`).click();
        await form.getByTestId('migration-item-save').click();
      }
      const next = editor.getByRole('button', { name: 'Next', exact: true });
      if (await next.isDisabled()) break;
      await next.click(); await editor.locator('[data-testid^="migration-item-edit-"]').first().waitFor();
    }
    await page.getByTestId('migration-preview-plan').click(); await page.getByTestId('migration-batch-operation').waitFor();
    const before = observations.length;
    await page.getByTestId('migration-batch-import').click(); await complete('IMPORT');
    await waitFor(() => observations.slice(before).some(row => row.method === 'migration/batch/read' && ['completed', 'completed_with_issues'].includes(row.stage) && !row.workerRunning), 30000, 'ordinary Mobile memory batch completed');
    const jobId = observations.slice(before).find(row => row.method === 'migration/batch/run')?.jobId; assert.ok(jobId); batches.push(jobId);
    assert.deepEqual(await readFile(resolve(profile, 'settings.json')), settings);
    return index;
  };
  assert.equal(await importSource('claude-code', 'global', 'mobile-global-notes'), 11);
  await rename(fixture.claude, `${fixture.claude}-withheld`);
  await page.getByTestId('migration-tab-memory').click();
  const manager = page.getByTestId('migration-memory-manager');
  await waitFor(async () => await manager.locator('[data-testid^="migration-memory-record-"]').count() === 10, 10000, 'ten records per Mobile notes page');
  const initialList = observations.find(row => row.method === 'migration/memory/list' && row.memoryTotal === 11);
  assert.ok(initialList?.memoryEnabled?.every(value => value === false)); assert.ok(initialList.memoryFacts.every(value => value === false)); assert.ok(initialList.memoryScopes.every(value => value === 'global'));
  await manager.getByRole('button', { name: 'Next', exact: true }).click();
  await waitFor(async () => await manager.locator('[data-testid^="migration-memory-record-"]').count() === 1, 10000, 'remaining notes page');
  await manager.getByRole('button', { name: 'Previous', exact: true }).click();
  await waitFor(async () => await manager.locator('[data-testid^="migration-memory-record-"]').count() === 10, 10000, 'notes first page restored');
  await manager.getByRole('button', { name: /mobile-global-notes-0/ }).click();
  await selected.getByTestId('migration-memory-read').click();
  await selected.getByText(/MOBILE_UNVERIFIED_MEMORY_NOTE_0/).waitFor();
  await selected.getByRole('button', { name: 'Next', exact: true }).click();
  await waitFor(() => observations.filter(row => row.method === 'migration/memory/read' && typeof row.memoryBytes === 'number').length >= 2, 10000, 'both bounded UTF8 window replies settled');
  const reads = observations.filter(row => row.method === 'migration/memory/read'); assert.ok(reads.every(row => row.memoryBytes > 0 && row.memoryBytes <= 8192));
  await selected.getByTestId('migration-memory-toggle').click();
  await page.getByTestId('migration-memory-confirm-input').fill('ENABLE'); await page.getByTestId('migration-memory-confirm-submit').click();
  await waitFor(() => lostMemory(), 10000, 'Native enabling receipt accepted then deliberately lost');
  const enabled = lostMemory();
  await page.reload(); await page.getByTestId('migration-workbench').waitFor({ timeout: 30000 }); await page.getByTestId('migration-tab-memory').click();
  const recovered = page.getByTestId('migration-memory-manager');
  await recovered.getByRole("button", { name: /mobile-global-notes-0/ }).click();
  const countBefore = observations.filter(row => row.method === 'migration/memory/control').length;
  await recovered.getByTestId(`migration-memory-control-record-${enabled.requestId}`).click();
  await recovered.getByText('Original receipt: enabling was applied', { exact: true }).waitFor();
  assert.equal(observations.filter(row => row.method === 'migration/memory/control').length, countBefore, 'reopen only reads the old request');
  await selected.getByTestId('migration-memory-toggle').click();
  await page.getByTestId('migration-memory-confirm-input').fill('DISABLE'); await page.getByTestId('migration-memory-confirm-submit').click();
  await recovered.getByText('Original receipt: disabling was applied', { exact: true }).waitFor();
  await recovered.getByTestId(`migration-memory-control-record-${enabled.requestId}`).click();
  await recovered.getByText('Original receipt: enabling was applied', { exact: true }).waitFor();
  await recovered.getByText('Current observation: disabled', { exact: true }).waitFor();
  await selected.getByTestId('migration-memory-origin').click(); await page.getByTestId('migration-batch-operation').waitFor();
  await page.getByTestId('migration-batch-undo').click(); await complete('UNDO');
  await waitFor(() => observations.some(row => row.method === 'migration/batch/read' && row.jobId === batches[0] && row.stage === 'rolled_back'), 30000, 'original batch Undo');
  await page.getByTestId('migration-tab-new').click();
  assert.equal(await importSource('codex', 'current_workspace', 'mobile-project-notes'), 1);
  await rename(fixture.codex, `${fixture.codex}-withheld`);
  await page.getByTestId('migration-tab-memory').click();
  await waitFor(() => observations.some(row => row.method === 'migration/memory/list' && row.memoryTotal === 1 && row.memoryScopes?.[0] === 'project' && row.memoryEnabled?.[0] === false && row.memoryFacts?.[0] === false), 10000, 'explicit project mapping stays disabled and unverified');
  await page.getByRole('button', { name: /mobile-project-notes-0/ }).click();
  await selected.getByTestId('migration-memory-read').click(); await selected.getByText(/MOBILE_UNVERIFIED_CODEX_NOTE/).waitFor();
  await selected.getByTestId('migration-memory-origin').click(); await page.getByTestId('migration-batch-operation').waitFor();
  await page.getByTestId('migration-batch-undo').click(); await complete('UNDO');
  await waitFor(() => observations.some(row => row.method === 'migration/batch/read' && row.jobId === batches[1] && row.stage === 'rolled_back'), 30000, 'mapped project memory Undo');
  await page.getByTestId('migration-tab-memory').click(); await page.getByTestId('migration-memory-refresh').click();
  await waitFor(async () => await page.locator('[data-testid^="migration-memory-record-"]').count() === 0, 10000, 'all own notes removed by ordinary Undo');
  for (const file of fixture.files) { const moved = file.path.startsWith(fixture.claude) ? file.path.replace(fixture.claude, `${fixture.claude}-withheld`) : file.path.replace(fixture.codex, `${fixture.codex}-withheld`); assert.equal(await readFile(moved, 'utf8'), file.text); }
  assert.deepEqual(await readFile(resolve(profile, 'settings.json')), settings); assert.equal(model.requests.length, 0);
  await context.writeArtifactJson('mobile-memory-roundtrip.json', { passed: true, batches, globalNotes: 11, projectNotes: 1, disabledOnImport: true, explicitMapping: true, lostEnableReceiptReadOnlyRecovery: true, priorReceiptAndCurrentStateSeparate: true, originalSourcesUnchanged: true, targetSettingsUnchanged: true, modelRequests: 0 });
  return { memory: true, notes: 12, modelRequests: 0 };
}
