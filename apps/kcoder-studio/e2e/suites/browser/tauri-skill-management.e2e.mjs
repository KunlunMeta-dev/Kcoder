import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startOwnedAiVerify } from '../../harness/ai-verify-client.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { appRoot, repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';

// QA: an isolated real WebView imports one owned skill, disables it and refreshes
// to verify persisted status while content remains installed, then re-enables it.
// Archive is still a separate explicit operation. No model request is required.

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN) throw new Error('KCODER_E2E_TAURI_BIN is required');
await runE2E(import.meta.url, {
  testId: 'tauri-skill-package-import-and-archive',
  tier: 'manual-live',
  modelPolicy: 'model-independent real Tauri/Gateway/app-server; owned package, no model request',
}, async context => {
  const source = context.pathInState('skill-source');
  await mkdir(resolve(source, 'references'), { recursive: true });
  const content = '\uFEFF---\r\nname: tauri-imported-skill\r\ndescription: Tauri import fixture\r\n---\r\nRead the reference.\r\n';
  await writeFile(resolve(source, 'SKILL.md'), content);
  await writeFile(resolve(source, 'references/example.md'), 'TAURI_REFERENCE');
  const client = await startOwnedAiVerify(context, {
    tauriBin: process.env.KCODER_E2E_TAURI_BIN,
    kcoderBin: process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'),
    rendererRoot: resolve(appRoot, 'renderer/dist'),
  });
  const remove = '[data-testid="kcoder-skill-remove"]';
  try {
    await client.command('navigate', { value: '/plugins/manage' });
    await client.command('waitFor', { selector: '[data-testid="kcoder-plugin-tab-skills"]', visible: true, timeoutMs: 15000 });
    await waitFor(async () => (await client.command('getText', { selector: '[data-testid="plugins-install-target"]' })).includes('/workspaces/tauri-verification'),
      15000, 'Tauri skill target bootstrap', 100, context.abortSignal);
    await client.command('click', { selector: '[data-testid="kcoder-plugin-tab-skills"]' });
    assert.equal(Number(await client.command('getElementCount', { selector: remove })), 0);
    const form = '[data-testid="kcoder-skill-import"]';
    await client.command('fill', { selector: form + ' input', value: source });
    await client.command('click', { selector: form + ' button[type="submit"]' });
    await client.command('waitFor', { selector: remove, enabled: true, timeoutMs: 15000 });
    assert.match(await client.command('getText', { selector: '#kcoder-plugin-panel' }), /tauri-imported-skill/);
    const root = resolve(dirname(client.settingsPath), 'skills');
    assert.equal(await readFile(resolve(root, 'tauri-imported-skill/SKILL.md'), 'utf8'), content);
    assert.equal(await readFile(resolve(root, 'tauri-imported-skill/references/example.md'), 'utf8'), 'TAURI_REFERENCE');
    const toggle='[data-skill-name="tauri-imported-skill"] [data-testid="kcoder-skill-toggle"]';
    await client.command('click', { selector:toggle });
    await client.command('waitFor', { selector:toggle, text:'已停用', timeoutMs:15000 });
    assert.equal(await readFile(resolve(root, 'tauri-imported-skill/SKILL.md'), 'utf8'), content);
    await client.command('click', { selector:'[data-testid="kcoder-plugins-refresh"]' });
    await client.command('waitFor', { selector:toggle, text:'已停用', enabled:true, timeoutMs:15000 });
    assert.equal(Number(await client.command('getElementCount', {selector:'[role="alert"]'})),0);
    await client.command('scrollIntoView', { selector:toggle });
    await client.capture('tauri-skill-disabled-still-installed.png');
    await client.command('navigate', { value:'/settings/appearance' });
    await client.command('waitFor', { selector:'[data-testid="appearance-mode-dark"]', enabled:true, timeoutMs:15000 });
    await client.command('click', { selector:'[data-testid="appearance-mode-dark"]' });
    await client.command('navigate', { value:'/plugins/manage' });
    await client.command('waitFor', { selector:'[data-testid="kcoder-plugin-tab-skills"]', enabled:true, timeoutMs:15000 });
    await client.command('click', { selector:'[data-testid="kcoder-plugin-tab-skills"]' });
    await client.command('waitFor', { selector:toggle, text:'已停用', enabled:true, timeoutMs:15000 });
    await client.command('scrollIntoView', { selector:toggle });
    await client.capture('tauri-skill-disabled-dark.png');
    await client.command('click', { selector:toggle });
    await client.command('waitFor', { selector:toggle, text:'已启用', enabled:true, timeoutMs:15000 });
    await client.capture('tauri-skill-imported.png');
    await client.command('click', { selector: remove });
    await client.command('click', { selector: '[role="alertdialog"] button:first-of-type' });
    await waitFor(async () => Number(await client.command('getElementCount', { selector: remove })) === 0,
      15000, 'Tauri skill archive', 100, context.abortSignal);
    assert.equal(await stat(resolve(root, 'tauri-imported-skill')).then(() => true, () => false), false);
    assert.ok((await readdir(resolve(root, '.archive'))).some(name => name.startsWith('studio-')));
    assert.equal(await readFile(resolve(source, 'SKILL.md'), 'utf8'), content);
    await context.writeArtifactJson('tauri-skill-results.json', {
      realTauri: true, importedThroughUi: true, supportFilesPreserved: true,
      archivedThroughUi: true, sourceUnchanged: true, builtinContentReadOnly: true,
      activationPersisted:true,disabledSkillStillInstalled:true,reEnabledThroughUi:true,
      lightAndDarkModeVerified:true,
    });
  } catch (error) {
    client.markFailed();
    await client.capture('tauri-failure.png').catch(() => {});
    await context.writeArtifactJson('tauri-failure-state.json', JSON.parse(await client.command('snapshot')));
    throw error;
  }
});
