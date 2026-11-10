import { selectAdvancedMigration } from './migration-navigation.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { waitFor } from '../../harness/run-context.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function seedProjectsFixture(context, profile, workspace, binary) {
  const root = context.pathInState('project-inventory-source'), sourceProfile = resolve(root, 'profile'), home = resolve(root, 'home');
  const canary = 'SYNTHETIC_PROJECT_INVENTORY_PRIVATE_CANARY'; context.registerSecret(canary);
  await mkdir(sourceProfile, { recursive: true, mode: 0o700 }); await writeFile(resolve(sourceProfile, 'settings.json'), '{}\n', { mode: 0o600 });
  await writeFile(resolve(profile, 'trusted-folders.json'), JSON.stringify({ trusted: [workspace], never: [] }), { mode: 0o600 });
  const products = {};
  for (const kind of ['claude-code', 'codex']) {
    const product = resolve(home, kind === 'codex' ? '.codex' : '.claude'); await mkdir(product, { recursive: true, mode: 0o700 });
    const roots = Array.from({ length: 13 }, (_, index) => `Z:\\FOREIGN_NEVER_OPENED\\project-${String(index).padStart(2, '0')}`);
    if (kind === 'claude-code') {
      await writeFile(resolve(product, '.claude.json'), JSON.stringify({ oauthAccount: { token: canary }, projects: Object.fromEntries(roots.map(path => [path, { token: canary, hasTrustDialogAccepted: true }])) }), { mode: 0o600 });
    } else {
      const db = new DatabaseSync(resolve(product, 'state_5.sqlite'));
      try {
        db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,metadata TEXT,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL); CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project_id,position)); CREATE TABLE private_tokens(token TEXT);');
        db.prepare('INSERT INTO private_tokens VALUES(?)').run(canary);
        for (let index = 0; index < 13; index++) {
          const id = `original-${String(index).padStart(2, '0')}`;
          db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?)').run(id, `Source project ${index}`, canary, index, 123, 456);
          db.prepare('INSERT INTO project_roots VALUES(?,0,?)').run(id, roots[index]);
        }
      } finally { db.close(); }
    }
    products[kind] = { root: product, roots };
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`, launcher = context.pathInState('project-inventory-source-launcher');
  await writeFile(launcher, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(sourceProfile)}\nexport HOME=${quote(home)}\nexport CLAUDE_CONFIG_DIR=${quote(products['claude-code'].root)}\nexport CODEX_HOME=${quote(products.codex.root)}\nexec ${quote(binary)} "$@"\n`, { mode: 0o700 });
  return { products, canary, server: { id: 'project-inventory-source', label: 'Separate project inventory source', transport: 'local', command: launcher, workspace } };
}
async function ownedRegistry(profile) {
  const queue = [{ path: profile, depth: 0 }]; let entries = 0;
  while (queue.length) {
    const current = queue.shift();
    for (const row of await readdir(current.path, { withFileTypes: true })) {
      assert.ok(++entries <= 4096, 'bounded owned fixture registry search');
      const path = resolve(current.path, row.name);
      if (row.isFile() && row.name === 'client-workspaces.json') return path;
      if (row.isDirectory() && current.depth < 8) queue.push({ path, depth: current.depth + 1 });
    }
  }
  throw new Error('Native did not publish its owned workspace registry');
}

/** Both Web clients use actual source handles, canonical transfer, original adoption and ordinary batch transactions. */
export async function exerciseProjectsUi({ context, page, gateway, profile, workspace, fixture, model, mobile = false }) {
  const target = mobile ? 'migration-target' : 'fixture-target';
  const observer = await openOwnedMobileRpc(context, gateway, target, workspace), outcomes = [], transfers = [];
  const settings = await readFile(resolve(profile, 'settings.json'));
  let lost = null, checkpoint = { stage: 'start' };
  const request = value => { if (new URL(value.url()).pathname.endsWith('/api/migration/source-transfer/run')) transfers.push(value.postDataJSON()); };
  page.on('request', request);
  await page.route('**/api/migration/source-transfer/adoption-prepare', async route => {
    if (!lost) {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      lost = { input: route.request().postDataJSON() }; await route.abort('failed');
    } else await route.continue();
  });
  const enabled = (locator, label) => waitFor(async () => await locator.count() === 1 && !await locator.isDisabled(), 15000, label);
  const confirm = async keyword => { if (mobile) { await page.getByTestId('migration-batch-confirm-input').fill(keyword); await page.getByTestId('migration-batch-confirm-submit').click(); } };
  const records = async () => {
    if (mobile) await page.getByTestId('migration-tab-records').click();
    else { await page.goto(`${gateway.baseUrl}/settings/general`); await page.getByTestId('general-language-en-button').click(); await page.getByTestId('general-external-content-import-button').click(); await page.locator('#migration-target').selectOption(target); await page.getByRole('button', { name: 'Migration records', exact: true }).click(); }
  };
  try {
    if (!mobile) { await page.goto(`${gateway.baseUrl}/settings/general`); await page.getByTestId('general-language-en-button').click(); }
    for (const kind of ['claude-code', 'codex']) {
      checkpoint = { kind, stage: 'source_inventory' };
      if (mobile) { await page.getByTestId('migration-tab-source').click(); await page.getByTestId('migration-source-remote-mode').click(); await page.getByTestId('source-device-project-inventory-source').click(); await page.getByTestId('source-browser-mode-projects').click(); }
      else { await page.getByTestId('general-external-content-import-button').click(); const dialog = page.getByTestId('migration-dialog'); await dialog.locator('#migration-target').selectOption(target); await selectAdvancedMigration(dialog, 'source'); await dialog.locator('#migration-source-device').selectOption('project-inventory-source'); await dialog.getByTestId('migration-source-mode-projects').click(); }
      const panel = page.getByTestId(mobile ? 'migration-source-browser' : 'migration-project-source-browser');
      await panel.getByRole('button', { name: kind === 'codex' ? 'Codex' : 'Claude Code', exact: true }).click();
      await panel.getByTestId(mobile ? 'source-directory-explicit' : 'migration-source-directory-explicit').click();
      await panel.getByTestId(mobile ? 'source-directory-path' : 'migration-source-directory-path').fill(fixture.products[kind].root);
      if (mobile) await panel.getByTestId('source-browser-discover').click(); else await panel.getByRole('button', { name: 'Discover projects', exact: true }).click();
      const rows = mobile ? panel.locator('[data-testid^="source-browser-select-"]') : panel.getByTestId('migration-project-source-row');
      await waitFor(async () => await rows.count() === 10, 15000, 'ten original project rows');
      if (mobile) await rows.first().click(); else await rows.first().getByRole('checkbox').check();
      await panel.getByRole('button', { name: 'Next', exact: true }).click();
      await waitFor(async () => await rows.count() === 3, 15000, 'three original project rows on the second page');
      if (mobile) await rows.last().click(); else await rows.last().getByRole('checkbox').check();
      await panel.getByRole('button', { name: mobile ? 'Transfer selected sources' : 'Transfer selected data (2)', exact: true }).click();
      const status = panel.getByTestId(mobile ? 'source-transfer-status' : 'migration-transfer-status');
      await status.getByText(mobile ? 'Sources received; not imported' : 'Data received', { exact: true }).waitFor({ timeout: 30000 });
      const run = transfers.at(-1); assert.equal(run.selections.length, 2); assert.ok(run.selections.every(value => value.kind === 'projects'));
      assert.equal(new Set(run.selections.map(value => value.catalogId)).size, 1); assert.equal(run.source.targetId, fixture.server.id); assert.equal(run.target.targetId, target);
      const incoming = resolve(profile, 'migrations/source-transfer/incoming', run.requestId), manifest = JSON.parse(await readFile(resolve(incoming, 'manifest.json'), 'utf8'));
      assert.equal(manifest.entries.length, 2);
      for (const entry of manifest.entries) {
        assert.equal(entry.content.kind, 'project_inventory'); assert.equal(entry.content.format, 'kcoder-project-inventory/1');
        const body = await readFile(resolve(incoming, `${entry.id}.blob`)); assert.equal(sha(body), entry.sha256); assert.ok(!body.includes(Buffer.from('SQLite format'))); assert.ok(!body.includes(Buffer.from(fixture.canary)));
        const parsed = JSON.parse(body); assert.deepEqual(Object.keys(parsed).sort(), ['formatRevision', 'logicalOrigin', 'record', 'source', 'version']); assert.equal(parsed.record.roots.length, 1);
      }
      await rename(fixture.products[kind].root, `${fixture.products[kind].root}-withheld`);
      checkpoint.stage = 'adoption';
      const adoption = panel.getByTestId('migration-source-adoption');
      await adoption.getByTestId(mobile ? 'source-adoption-expand' : 'migration-adoption-expand').click();
      const selections = mobile ? adoption.locator('[data-testid^="source-adoption-select-"]') : adoption.getByTestId('migration-adoption-received-row').getByRole('checkbox');
      await waitFor(async () => await selections.count() === 2, 15000, 'two accepted project projections');
      for (let index = 0; index < 2; index++) { if (mobile) await selections.nth(index).click(); else await selections.nth(index).check(); }
      await adoption.getByTestId(mobile ? 'source-adoption-prepare' : 'migration-adoption-prepare').click();
      if (!outcomes.length) { await waitFor(() => lost, 15000, 'accepted adoption reply discarded'); await enabled(adoption.getByTestId(mobile ? 'source-adoption-read' : 'migration-adoption-read'), 'explicit original adoption read'); await adoption.getByTestId(mobile ? 'source-adoption-read' : 'migration-adoption-read').click(); }
      const open = adoption.locator(mobile ? '[data-testid^="source-adoption-open-"]' : '[data-testid^="migration-adoption-open-"]').first();
      await enabled(open, 'ordinary preview prepared from original received receipt');
      const jobId = (await open.getAttribute('data-testid')).slice((mobile ? 'source-adoption-open-' : 'migration-adoption-open-').length); await open.click();
      const items = await observer.rpc.request('migration/items', { jobId }); assert.equal(items.items.length, 2); assert.ok(items.items.every(item => item.category === 'project'));
      const destination = resolve(workspace, `new-mapped-${kind}`), nativeName = `New native ${kind}`; await mkdir(destination, { mode: 0o700 }); await writeFile(resolve(destination, 'USER_FILE'), 'KEEP_WORKTREE', { mode: 0o600 });
      checkpoint = { kind, stage: 'explicit_mapping', jobId };
      let registry, registryBytes;
      for (const [index, item] of items.items.entries()) {
        if (mobile) await page.getByTestId(`migration-item-edit-${item.id}`).click();
        else await page.getByTestId('migration-content-item').filter({ has: page.getByText(item.sourceName, { exact: true }) }).getByRole('button', { name: 'Configure', exact: true }).click();
        const mapping = page.getByTestId('migration-project-mapping'); await mapping.waitFor();
        await waitFor(async () => await mapping.getByTestId('migration-project-target').count() > 0 || await mapping.getByRole('alert').count() > 0, 15000, 'target metadata settled');
        assert.equal(await mapping.getByRole('alert').count(), 0, (await mapping.getByRole('alert').allTextContents()).join(' | '));

        if (index === 0) {
          if (!mobile) await mapping.getByText('Register another target directory', { exact: true }).first().click();
          assert.equal(await mapping.getByTestId('migration-project-register-path').inputValue(), '', 'foreign root is never prefilled as target authority');
          await mapping.getByTestId('migration-project-register-name').fill(nativeName); await mapping.getByTestId('migration-project-register-path').fill(destination); await mapping.getByTestId('migration-project-register').click();
          await mapping.getByRole('button', { name: nativeName, exact: true }).waitFor(); registry = await ownedRegistry(profile); registryBytes = await readFile(registry);
        }
        await mapping.getByRole('button', { name: nativeName, exact: true }).click();
        const root = mapping.getByTestId('migration-project-root-map');
        if (mobile) await root.filter({ hasText: destination }).click();
        else { await waitFor(async () => await root.locator('option').count() === 2, 15000, 'one explicit Native root'); await root.selectOption({ label: destination }); }
        await enabled(mapping.getByTestId('migration-project-map-save'), 'complete explicit root mapping'); await mapping.getByTestId('migration-project-map-save').click();
      }
      if (mobile) await page.getByTestId('migration-preview-plan').click(); else await page.getByRole('button', { name: 'Confirm selected content', exact: true }).click();
      if (mobile) { await enabled(page.getByTestId('migration-batch-import'), 'planned project batch'); await page.getByTestId('migration-batch-import').click(); await confirm('IMPORT'); }
      else await page.getByRole('button', { name: 'Start batch migration', exact: true }).click();
      await waitFor(async () => { const state = await observer.rpc.request('migration/batch/read', { jobId }); return !state.workerRunning && state.state.job.committedItems === 2; }, 30000, 'two ordinary project associations published');
      const saved = await observer.rpc.request('migration/batch/read', { jobId }); assert.equal(saved.state.job.status, 'completed'); assert.equal(saved.state.job.hasUnconfirmedOutcomes, false); assert.equal(saved.state.batch.unresolvedActions, 0);
      const associationsFile = resolve(profile, 'imported-project-associations/associations.json'), associations = JSON.parse(await readFile(associationsFile, 'utf8')); assert.equal(Object.keys(associations.records).length, 2);
      assert.deepEqual(await readFile(registry), registryBytes); assert.deepEqual(await readFile(resolve(profile, 'settings.json')), settings);
      checkpoint.stage = 'reopen_undo'; await records(); await page.getByTestId(`migration-batch-record-${jobId}`).click(); await page.getByTestId('migration-project-mapping').first().waitFor();
      if (mobile) { await enabled(page.getByTestId('migration-batch-undo'), 'original project batch ready to undo'); await page.getByTestId('migration-batch-undo').click(); await confirm('UNDO'); }
      else await page.getByRole('button', { name: 'Undo this import', exact: true }).click();
      await waitFor(async () => (await observer.rpc.request('migration/batch/read', { jobId })).state.job.status === 'rolled_back', 30000, 'only owned imported associations removed');
      assert.equal(Object.keys(JSON.parse(await readFile(associationsFile, 'utf8')).records).length, 0); assert.deepEqual(await readFile(registry), registryBytes); assert.equal(await readFile(resolve(destination, 'USER_FILE'), 'utf8'), 'KEEP_WORKTREE'); assert.deepEqual(await readFile(resolve(profile, 'settings.json')), settings);
      outcomes.push({ kind, jobId, requestId: run.requestId, explicitAcrossPages: 2, pageSizes: [10, 3], receivedEntries: 2, associationsPublished: 2, sourceGoneBeforeAdoption: true, registeredNewTargetPreservedByUndo: true });
      if (!mobile) await page.goto(`${gateway.baseUrl}/settings/general`);
    }
    assert.equal(transfers.length, 2); assert.equal(model.requests.length, 0);
    await context.writeArtifactJson('project-inventory-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web' : 'Studio Browser', outcomes, lostAdoptionAcknowledgementReadOriginal: !!lost, modelRequests: 0 });
    return { projectRegistries: 2, associations: 4, modelRequests: 0 };
  } catch (error) { await context.writeArtifactJson('project-inventory-checkpoint.json', { checkpoint, outcomes, transferRequests: transfers.map(value => ({ requestId: value.requestId, source: value.source, target: value.target, selections: value.selections })), modelRequests: model.requests.length }); throw error; }
  finally { page.off('request', request); await observer.close(); }
}
