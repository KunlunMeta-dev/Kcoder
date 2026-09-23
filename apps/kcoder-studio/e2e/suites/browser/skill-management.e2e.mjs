import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// QA: UI import includes Windows line endings and supporting files; verify new/old session
// snapshots, cancel deletion once, then archive through the UI without touching the source.
await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'skill-directory-import-new-session-and-archive-ui',
  tier: 'full-integration',
  modelPolicy: 'model-independent real browser/Gateway/app-server; no model requests',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'skill-ui' });
  const source = context.pathInState('source-skill');
  await mkdir(resolve(source, 'references'), { recursive: true });
  const content = '\uFEFF---\r\nname: ui-imported-skill\r\ndescription: Skill UI fixture\r\n---\r\nRead references/example.md.\r\n';
  await writeFile(resolve(source, 'SKILL.md'), content);
  await writeFile(resolve(source, 'references/example.md'), 'OWNED_REFERENCE');
  const profile = context.pathInState('profile');
  await context.writeStateJson('profile/settings.json', { providers: {} });
  const binary = resolve(repoRoot, 'target/debug/kcoder');
  const serversFile = await context.writeStateJson('servers.jsonc', [{ id: 'local', label: 'Skill fixture', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(gateway.baseUrl + '/plugins/manage', { waitUntil: 'domcontentloaded' });
    await page.locator('input[name="token"]').fill(gateway.authToken);
    await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')), page.locator('button[type="submit"]').click()]);
    await page.getByTestId('kcoder-plugin-tab-skills').waitFor({ timeout: 60000 });
    await page.getByTestId('kcoder-plugin-tab-skills').click();
    const panel = page.locator('#kcoder-plugin-panel');
    await page.getByTestId('kcoder-skill-import').waitFor();
    assert.equal(await panel.getByTestId('kcoder-skill-remove').count(), 0);
    const cookie = (await page.context().cookies(gateway.baseUrl)).map(item => item.name + '=' + item.value).join('; ');
    const token = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content');
    context.registerSecret(cookie); context.registerSecret(token);
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'local', token), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup('close skill management RPC', () => rpc.close());
    await initializeRpc(rpc, 'skill-ui');
    const before = await rpc.request('thread/start');
    const inventory = async threadId => (await rpc.request('device/execute', { command_key: 'ls_skills', threadId })).stdout;
    await page.getByTestId('kcoder-skill-import').getByRole('textbox').fill(source);
    await page.getByRole('button', { name: /导入技能|Import skill/ }).click();
    const row = panel.locator('article').filter({ hasText: 'ui-imported-skill' });
    await row.waitFor();
    assert.equal(await readFile(resolve(profile, 'skills/ui-imported-skill/SKILL.md'), 'utf8'), content);
    assert.equal(await readFile(resolve(profile, 'skills/ui-imported-skill/references/example.md'), 'utf8'), 'OWNED_REFERENCE');
    assert.ok(!(await inventory(before.thread.id)).some(skill => skill.name === 'ui-imported-skill'));
    const imported = await rpc.request('thread/start');
    assert.ok((await inventory(imported.thread.id)).some(skill => skill.name === 'ui-imported-skill'));
    await page.screenshot({ path: context.pathInArtifacts('skill-imported.png') });
    await row.getByTestId('kcoder-skill-remove').click();
    await row.getByRole('alertdialog').getByRole('button', { name: /^取消$|^Cancel$/ }).click();
    await row.getByTestId('kcoder-skill-remove').click();
    await row.getByRole('alertdialog').getByRole('button', { name: /^删除$|^Remove$/ }).click();
    await row.waitFor({ state: 'detached' });
    assert.equal(await stat(resolve(profile, 'skills/ui-imported-skill')).then(() => true, () => false), false);
    assert.ok((await readdir(resolve(profile, 'skills/.archive'))).some(name => name.startsWith('studio-')));
    assert.equal(await readFile(resolve(source, 'SKILL.md'), 'utf8'), content);
    const removed = await rpc.request('thread/start');
    assert.ok(!(await inventory(removed.thread.id)).some(skill => skill.name === 'ui-imported-skill'));
    assert.ok((await inventory(imported.thread.id)).some(skill => skill.name === 'ui-imported-skill'));
    for (const item of [before, imported, removed]) await rpc.request('thread/delete', { threadId: item.thread.id });
    await context.writeArtifactJson('skill-results.json', { importedThroughUi: true, supportFilesPreserved: true,
      windowsBytesPreserved: true, existingSessionUnchanged: true, newSessionReloaded: true, archivedThroughUi: true, sourcePreserved: true });
  } catch (error) {
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    await context.writeArtifactJson('failure-ui.json', { text: await page.locator('body').innerText().catch(() => '') });
    throw error;
  }
});
