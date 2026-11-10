import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { waitFor } from '../../harness/run-context.mjs';
import { openOwnedMobileRpc } from '../../harness/owned-mobile-rpc.mjs';
import { exerciseProjectPluginUi } from './migration-project-plugins.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function seedUploadedPluginFixture(context, profile, workspace) {
  const marker = context.pathInState('UPLOADED_PLUGIN_MUST_NOT_EXECUTE'), packages = {};
  await writeFile(resolve(profile, 'trusted-folders.json'), JSON.stringify({ trusted: [workspace], never: [] }), { mode: 0o600 });
  for (const kind of ['claude-code', 'codex']) {
    const root = context.pathInState(`uploaded-plugin-files/${kind}`), name = kind === 'codex' ? 'uploaded-codex' : 'uploaded-claude', scope = kind === 'codex' ? 'user' : 'local';
    const prefix = `plugins/cache/owned-fixture/${name}/1.0.0`, format = kind === 'codex' ? '.codex-plugin' : '.claude-plugin';
    const files = [
      { path: `${prefix}/${format}/plugin.json`, bytes: Buffer.from(JSON.stringify({ name, version: '1.0.0', mcpServers: { inert: { command: 'sh', args: ['${PLUGIN_ROOT}/source-command.sh'] } }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'sh "${PLUGIN_ROOT}/source-command.sh"' }] }] } })) },
      { path: `${prefix}/skills/evidence/SKILL.md`, bytes: Buffer.from('---\nname: evidence\ndescription: Static uploaded package\n---\nNever execute this supplied fixture.\n') },
      { path: `${prefix}/source-command.sh`, bytes: Buffer.from(`#!/bin/sh\nprintf invoked > '${marker.replaceAll("'", "'\\''")}'\n`) },
    ];
    if (kind === 'claude-code') {
      files.push({ path: 'plugins/installed_plugins.json', bytes: Buffer.from(JSON.stringify({ version: 2, plugins: { [`${name}@owned-fixture`]: [{ scope, installPath: '/NOT_AUTHORIZED/original-device/plugin', projectPath: '/NOT_AUTHORIZED/original-project', version: '1.0.0' }] } })) });
      files.push({ path: 'settings.json', bytes: Buffer.from(JSON.stringify({ enabledPlugins: { [`${name}@owned-fixture`]: true } })) });
    } else files.push({ path: 'config.toml', bytes: Buffer.from(`[plugins."${name}@owned-fixture"]\nenabled=true\n`) });
    for (const file of files) { await mkdir(resolve(root, file.path, '..'), { recursive: true }); await writeFile(resolve(root, file.path), file.bytes); }
    const backup = context.pathInState(`uploaded-plugin-files/${kind}.kcmb`), manifest = { version: 1, source: kind, files: files.map(file => ({ relativePath: file.path, bytes: file.bytes.length, sha256: sha(file.bytes) })) };
    const metadata = Buffer.from(JSON.stringify(manifest)), header = Buffer.alloc(16); header.write('KCMBNDL1', 'ascii'); header.writeBigUInt64LE(BigInt(metadata.length), 8);
    await writeFile(backup, Buffer.concat([header, metadata, ...files.map(file => file.bytes)]));
    packages[kind] = { root, browserRoot: root, backup, name, scope, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes.length, 0) };
  }
  return { packages, marker };
}

/** Only chooser bytes enter Native. The common helper performs the original batch install and Undo. */
export async function exerciseUploadedPluginUi({ context, page, gateway, profile, workspace, fixture, model, mobile = false, observations = [] }) {
  const observer = await openOwnedMobileRpc(context, gateway, mobile ? 'migration-target' : 'fixture-target', workspace), uploads = [], queries = [], results = [];
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const value = JSON.parse(frame.payload); if (value.method === 'migration/source/upload/prepare') uploads.push(value.params); } catch { /* Other frames are unrelated. */ }
  }));
  await page.route('**/api/migration/source-session/query', async route => { queries.push(route.request().postDataJSON()); await route.continue(); });
  const prepares = () => mobile ? observations.filter(row => row.method === 'migration/source/upload/prepare') : uploads;
  const enabled = (locator, label) => waitFor(async () => await locator.count() === 1 && !await locator.isDisabled(), 15000, label);
  try {
    const result = await exerciseProjectPluginUi({ context, page, gateway, profile, workspace, fixture, model, mobile,
      openUploaded: async kind => {
        const entry = fixture.packages[kind], before = prepares().length;
        let upload;
        if (mobile) {
          await page.getByTestId('migration-tab-source').click(); upload = page.getByTestId('migration-source-upload');
          await upload.getByTestId(`source-upload-product-${kind}`).click(); await upload.getByTestId(`source-upload-mode-${kind === 'codex' ? 'package' : 'directory'}`).click();
        } else {
          await page.getByTestId('general-external-content-import-button').click(); const dialog = page.getByTestId('migration-dialog'); await dialog.locator('#migration-target').selectOption('fixture-target');
          await dialog.getByRole('button', { name: 'Import local browser files', exact: true }).click(); upload = dialog.getByTestId('migration-source-upload');
          await upload.getByTestId('source-upload-product').selectOption(kind); await upload.getByTestId('source-upload-mode').selectOption(kind === 'codex' ? 'package' : 'directory');
        }
        await upload.getByTestId('source-upload-input').setInputFiles(kind === 'codex' ? entry.backup : entry.browserRoot);
        const start = mobile ? upload.getByTestId('source-upload-start') : upload.getByRole('button', { name: 'Upload selected files', exact: true });
        await enabled(start, 'the explicit plugin file set was hashed'); await start.click();
        await waitFor(() => prepares().length === before + 1, 15000, 'one stable Native upload identity');
        const input = prepares().at(-1), operationId = input.operationId;
        if (!mobile) { assert.equal(input.manifest.source, kind); assert.equal(input.manifest.files.length, entry.files); }
        const use = mobile ? upload.getByTestId('source-upload-use') : upload.getByRole('button', { name: 'Prepare uploaded source for inspection', exact: true });
        await enabled(use, 'all explicit plugin bytes were received');
        const state = (await observer.rpc.request('migration/source/upload/read', { operationId })).upload;
        assert.equal(state.stage, 'ready'); assert.equal(state.source, kind); assert.equal(state.totalFiles, entry.files); assert.equal(state.totalBytes, entry.bytes);
        await rename(entry.browserRoot, `${entry.browserRoot}-withheld`);
        if (kind === 'codex') await rename(entry.backup, `${entry.backup}-withheld`);
        await use.click(); const product = page.getByTestId('migration-source-product');
        await (mobile ? product.getByTestId('source-product-run') : product.getByRole('button', { name: 'Explicitly prepare source files', exact: true })).click();
        const inspect = mobile ? product.getByTestId('source-product-inspect') : product.getByRole('button', { name: 'Inspect prepared source', exact: true });
        await enabled(inspect, 'Native materialized the exact manifest'); await inspect.click();
        const browser = page.getByTestId('migration-source-browser');
        await browser.getByTestId(mobile ? 'source-browser-mode-plugins' : 'migration-source-mode-plugins').click();
        if (mobile) {
          assert.equal(await browser.getByTestId('source-browser-project-consent').count(), 0);
          await browser.getByTestId('source-browser-discover').click();
          const row = browser.locator('[data-testid^="source-browser-select-"]'); await row.waitFor(); assert.equal(await row.count(), 1); await row.click();
          await browser.getByTestId('source-browser-transfer').click();
          await browser.getByTestId('source-transfer-status').getByText('Sources received; not imported', { exact: true }).waitFor({ timeout: 30000 });
        } else {
          const plugin = browser.getByTestId('migration-plugin-source-browser'); assert.equal(await plugin.getByRole('checkbox', { name: /trusted source workspace/i }).count(), 0);
          await plugin.getByRole('button', { name: 'Find migration sources', exact: true }).click();
          const row = plugin.getByTestId('migration-plugin-source-row'); await row.waitFor(); assert.equal(await row.count(), 1); await row.getByRole('checkbox').check();
          await plugin.getByRole('button', { name: /Transfer selected data/ }).click(); await plugin.getByTestId('migration-transfer-status').getByText('Data received', { exact: true }).waitFor({ timeout: 30000 });
        }
        const selected = queries.filter(row => row.query.kind === 'uploaded_select').at(-1), discovered = queries.filter(row => row.query.kind === 'plugins').at(-1);
        assert.equal(selected.query.params.operationId, operationId); assert.equal(selected.query.params.manifestSha256, state.manifestSha256);
        assert.equal(discovered.session.sessionId, selected.session.sessionId); assert.equal(discovered.query.params.includeUploaded, true); assert.equal(discovered.query.params.includeProject, false);
        assert.deepEqual(discovered.query.params.sources, [kind]);
        // After transfer even the owned source materialization is withheld; received Native bytes remain authoritative.
        entry.root = resolve(profile, 'migrations/source-transfer/browser-products', operationId, 'product');
        results.push({ kind, operationId, manifestSha256: state.manifestSha256, originalChooserFilesGone: true, independentTargetMapping: entry.scope !== 'user' });
      } });
    assert.equal(prepares().length, 2); assert.equal(queries.filter(row => row.query.kind === 'plugins').length, 2);
    assert.ok(!queries.some(row => row.query.kind === 'directory_select'));
    await context.writeArtifactJson('uploaded-plugin-roundtrip.json', { passed: true, platform: mobile ? 'Mobile Web Chromium' : 'Studio Web Chromium', results, ...result, sourcePathsNeverAuthorized: true, actualCopiedBytesBoundToUploadManifest: true });
    return { ...result, uploadedPlugins: true, directoryAndVersionedBackup: true };
  } finally { await observer.close(); }
}
