import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function exerciseQuickHistory({ page, profile, model, context }) {
  const panel = page.getByTestId('migration-quick-history');
  await panel.waitFor();
  assert.equal(await page.getByTestId('migration-mode-plugins').count(), 0);
  await page.getByTestId('migration-quick-start').click();
  await panel.filter({ has: page.getByTestId('migration-quick-row') }).waitFor();
  await page.getByTestId('migration-quick-pause').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="migration-quick-history"]')?.dataset.phase === 'paused');
  await page.getByTestId('migration-quick-start').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="migration-quick-history"]')?.dataset.phase === 'complete', null, { timeout: 120000 });
  const progress = await page.getByTestId('migration-quick-progress').innerText();
  await context.writeArtifactJson('quick-history-progress.json', { progress });
  assert.ok(progress.includes('已导入 15') && progress.includes('需检查 0'), progress);
  assert.equal(await page.getByTestId('migration-quick-row').count(), 10);
  const native = async () => {
    const root = resolve(profile, 'projects'), result = [];
    for (const directory of await readdir(root, { withFileTypes: true })) if (directory.isDirectory())
      for (const name of await readdir(resolve(root, directory.name))) if (/^[a-zA-Z0-9]{5}\.jsonl$/.test(name)) result.push(`${directory.name}/${name}`);
    return result.sort();
  };
  const before = await native(); assert.equal(before.length, 15);
  await panel.getByRole('button', { name: '下一页', exact: true }).click();
  assert.equal(await page.getByTestId('migration-quick-row').count(), 5);
  await page.getByTestId('migration-quick-start').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="migration-quick-history"]')?.dataset.phase === 'complete', null, { timeout: 120000 });
  assert.deepEqual(await native(), before, 'Repeating the same import must reuse Native sessions');
  assert.equal(model.requests.length, 0);
  return { quickHistory: true, sources: 2, imported: 15, pagedResults: [10, 5], pausedAndContinued: true, noDuplicateSessions: true, modelRequests: 0 };
}
