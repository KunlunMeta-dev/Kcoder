import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'storage-scan-switch-and-targeted-cleanup', tier: 'full-integration', modelPolicy: 'model-independent real per-target processes and storage; delayed delivery of one actual scan response' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal');
  const targets = [];
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  for (const id of ['alpha', 'beta']) {
    const config = context.pathInState(id);
    await context.writeStateJson(`${id}/settings.json`, { providers: {} });
    await mkdir(resolve(config, 'logs/llm-request'), { recursive: true });
    await writeFile(resolve(config, 'logs/llm-request/owned.json'), id.repeat(1000));
    const launcher = context.pathInState(`${id}-launcher`);
    await writeFile(launcher, `#!/bin/sh\nexport KCODER_CONFIG_DIR=${quote(config)}\nexec ${quote(resolve(repoRoot, 'target/debug/kcoder'))} "$@"\n`, { mode: 0o700 });
    targets.push({ id, label: id, transport: 'local', command: launcher, workspace });
  }
  const serversFile = await context.writeStateJson('servers.json', targets);
  const gateway = await startGateway(context, { workspace, serversFile });
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  try {
    await page.goto(`${gateway.baseUrl}/settings/storage`);
    await waitFor(async () => (await page.getByTestId('storage-total').innerText()).includes(context.pathInState('alpha')), 15000, 'alpha report');
    await page.evaluate(() => {
      const api = window.__TAURI_INTERNALS__; const invoke = api.invoke;
      api.invoke = async (command, args) => {
        const result = await invoke(command, args);
        if (!window.__storageHeld && command === 'local_executor_request' && args?.method === 'runtime.diagnostics.request' && args.params?.serverId === 'alpha' && args.params?.method === 'diagnostics/storage/read') {
          window.__storageHeld = true;
          await new Promise(resolve => { window.__releaseStorage = resolve; });
        }
        return result;
      };
    });
    await page.getByTestId('storage-refresh').click();
    await waitFor(() => page.evaluate(() => window.__storageHeld === true), 15000, 'real alpha scan response held');
    await page.getByTestId('storage-target').selectOption('beta');
    await waitFor(async () => (await page.getByTestId('storage-total').innerText()).includes(context.pathInState('beta')), 15000, 'beta report');
    await page.getByTestId('storage-clean-debug-logs').click();
    await page.getByTestId('storage-clean-dialog-confirm').click();
    await waitFor(async () => !(await stat(context.pathInState('beta/logs/llm-request/owned.json')).then(() => true, () => false)), 15000, 'beta logs removed');
    await page.getByTestId('storage-clean-dialog').waitFor({ state: 'detached' });
    await waitFor(() => page.getByTestId('storage-refresh').isEnabled(), 10000, 'cleanup report committed to UI');
    await page.evaluate(() => window.__releaseStorage());
    assert.equal(await readFile(context.pathInState('alpha/logs/llm-request/owned.json'), 'utf8'), 'alpha'.repeat(1000));
    assert.ok((await page.getByTestId('storage-total').innerText()).includes(context.pathInState('beta')));
    assert.equal(await page.getByTestId('storage-target').inputValue(), 'beta');
    assert.match(await page.getByTestId('storage-scan-completeness').innerText(), /扫描已完成/);
    assert.match(await page.getByTestId('storage-scan-time').innerText(), /扫描时间/);
    const previous = await page.getByTestId('storage-total').innerText();
    await mkdir(context.pathInState('beta/logs/llm-request'), { recursive: true });
    await writeFile(context.pathInState('beta/logs/llm-request/after.json'), 'new data'.repeat(1000));
    await page.evaluate(() => {
      const api = window.__TAURI_INTERNALS__; const invoke = api.invoke;
      api.invoke = async (command, args) => {
        const result = await invoke(command, args);
        if (!window.__cancelHeld && command === 'local_executor_request' && args?.method === 'runtime.diagnostics.request' && args.params?.serverId === 'beta' && args.params?.method === 'diagnostics/storage/read') {
          window.__cancelHeld = true;
          await new Promise(resolve => { window.__releaseCancelled = resolve; });
        }
        return result;
      };
    });
    await page.getByTestId('storage-refresh').click();
    await waitFor(() => page.evaluate(() => window.__cancelHeld === true), 10000, 'scan response awaiting UI delivery');
    await page.getByTestId('storage-cancel-scan').click();
    await page.getByText('本次扫描已取消，保留上一次结果。', { exact: true }).waitFor();
    await page.evaluate(() => window.__releaseCancelled());
    assert.equal(await page.getByTestId('storage-total').innerText(), previous);
    await page.screenshot({ path: context.pathInArtifacts('beta-cleaned.png') });
    return { oldScanIgnored: true, betaCleaned: true, alphaUnchanged: true, cancelledReplyIgnored: true, scanMetadataVisible: true };
  } finally { await page.close(); }
});
