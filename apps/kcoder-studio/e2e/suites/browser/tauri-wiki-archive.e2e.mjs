import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { smallCollectionFixture } from '../../fixtures/wiki/archive-client.mjs';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'native-wiki-stream-collection-import-export-cancel', tier: 'full-integration',
  modelPolicy: 'No model calls: synthetic picker files come from a real owned Gateway archive export; native UI and persistence only' }, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const fixture = await smallCollectionFixture(context, binary);
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN || resolve(repoRoot, 'target/split-tauri-native/debug/app'),
    kcoderBin: binary, rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const cmd = (action, id, args = {}) => client.command(action, { selector: `[data-testid="${id}"]`, ...args });
  try {
    const configuration = JSON.parse(await readFile(client.settingsPath, 'utf8'));
    await writeFile(client.settingsPath, JSON.stringify({ ...configuration, active_provider: 'offline', providers: {
      offline: { api_format: 'openai_chat_completions', endpoint: 'http://127.0.0.1:1', default_model: 'offline', context_window_tokens: 128000, max_output_tokens: 4096, output_headroom_tokens: 4096, authentication: { mode: 'none' }, no_proxy: true },
    } }));
    await cmd('waitFor', 'knowledge-button'); await cmd('click', 'knowledge-button');
    await cmd('waitFor', 'knowledge-enable', { enabled: true }); await cmd('click', 'knowledge-enable');
    await cmd('waitFor', 'knowledge-create', { enabled: true }); await cmd('click', 'knowledge-create');
    await cmd('fill', 'wiki-create-input', { value: 'Existing default' });
    await cmd('click', 'wiki-create-confirm');
    await cmd('waitFor', 'knowledge-library-picker', { text: 'Existing default' });
    const preferredLibrary = await cmd('getValue', 'knowledge-library-picker');
    await client.command('click', { selector: 'summary[aria-label="管理 Wiki"]' });
    await cmd('waitFor', 'wiki-archive-import', { enabled: true }); await cmd('click', 'wiki-archive-import');
    await cmd('waitFor', 'wiki-archive-files', { enabled: true });
    // Missing part is refused before staging; the picker remains usable for correction.
    await cmd('fill', 'wiki-archive-files', { value: JSON.stringify([{ name: 'collection.kwiki.json', text: JSON.stringify(fixture.manifest) }]) });
    await client.command('waitFor', { selector: '[data-testid="wiki-archive-transfer"]', text: 'Missing', timeoutMs: 10000 });
    await cmd('fill', 'wiki-archive-files', { value: JSON.stringify([
      { name: 'collection.kwiki.json', text: JSON.stringify(fixture.manifest) },
      { name: fixture.manifest.segments[0].name, contentBase64: fixture.bytes.toString('base64') },
    ]) });
    await cmd('waitFor', 'knowledge-library-picker', { text: 'Native archive evidence', timeoutMs: 30000 });
    await cmd('waitFor', 'wiki-archive-progress', { text: '导入已完成' });
    assert.equal(await cmd('getValue', 'knowledge-library-picker'), preferredLibrary, 'restoration preserves the real selected default');
    await cmd('click', 'wiki-archive-close');
    await waitFor(async () => await cmd('getElementCount', 'wiki-archive-transfer') === '0', 5000, 'archive dialog close');
    const importedLibrary = await client.command('getAttribute', { selector: '[data-testid="knowledge-library-picker"] option:first-child', value: 'value' });
    assert.notEqual(importedLibrary, preferredLibrary);
    await cmd('fill', 'knowledge-library-picker', { value: importedLibrary });
    await waitFor(async () => await cmd('getValue', 'knowledge-library-picker') === importedLibrary, 5000, 'explicit imported Wiki selection');
    await cmd('click', 'knowledge-tab-sources');
    await client.command('waitFor', { selector: '#wiki-content-panel', text: 'evidence.txt', timeoutMs: 10000 });
    await client.command('click', { selector: '[data-testid^="wiki-source-row-"]' });
    await cmd('waitFor', 'wiki-original-reader', { text: 'Stable immutable evidence' });
    await cmd('click', 'wiki-original-reader-close');
    await client.command('click', { selector: 'summary[aria-label="管理 Wiki"]' });
    await cmd('click', 'wiki-archive-export');
    await cmd('waitFor', 'wiki-archive-export-start', { enabled: true }); await cmd('click', 'wiki-archive-export-start');
    await cmd('waitFor', 'wiki-archive-part-0', { enabled: true, timeoutMs: 30000 });
    assert.equal(await cmd('getAttribute', 'wiki-archive-manifest', { value: 'disabled' }), '');
    await client.capture('wiki-archive-ready.png');
    await cmd('click', 'wiki-archive-close');
    await client.command('click', { selector: 'summary[aria-label="管理 Wiki"]' });
    await cmd('click', 'wiki-archive-export');
    await cmd('waitFor', 'wiki-archive-export-start', { enabled: true }); await cmd('click', 'wiki-archive-export-start');
    await cmd('waitFor', 'wiki-archive-part-0', { enabled: true, timeoutMs: 30000 });
    await cmd('click', 'wiki-archive-close');
    return { realDomainCollectionImported: true, originalReadable: true, missingPartRejected: true, exportReopenedAfterOwnerCancel: true };
  } catch (error) { client.markFailed(); throw error; }
  finally { await client.stop(); }
});
