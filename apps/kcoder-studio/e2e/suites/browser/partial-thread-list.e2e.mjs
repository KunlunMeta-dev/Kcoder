import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: 'partial-thread-list-retains-known-rows-until-complete',
  tier: 'full-integration',
  modelPolicy: 'model-independent list protocol and UI retention; two bounded loopback text-fixture turns, no model-quality assertion',
}, async context => {
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyResponse: 'FIXTURE_COMPLETE' });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'partial-list' });
  const settings = await context.writeStateJson('config/settings.json', {
    active_provider: 'fixture', providers: { fixture: {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: model.baseUrl,
      default_model: 'fixture', context_window_tokens: 128000, output_headroom_tokens: 8192,
      max_output_tokens: 8192, no_proxy: true,
    } },
  });
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Partial List Fixture', transport: 'local', command: binary, workspace, settingsFile: settings },
  ]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: dirname(settings) } });
  const rpcUrl = gatewayRpcUrl(gateway, 'local', await waitForGatewayRpcToken(context, gateway));
  let rpc = await openRpc(rpcUrl);
  context.addCleanup('close partial list fixture RPC', () => rpc.close());
  const initialized = await initializeRpc(rpc, 'partial-list-seed');
  assert.equal(initialized.capabilities.experimental.threadListCompleteness, true);
  const ids = [];
  for (const label of ['A', 'B']) {
    const id = (await rpc.request('thread/start', {})).thread.id;
    const turn = await rpc.request('turn/start', { threadId: id, input: [{ type: 'text', text: label }] });
    await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.threadId === id
      && message.params?.turnId === turn.turn.id, 15000, `seed ${label} turn`);
    await rpc.request('thread/metadata/update', { threadId: id, title: `List ${label}` });
    ids.push(id);
  }
  const metadataPath = await findMetadata(dirname(settings), ids[1]);
  assert.ok(metadataPath, 'the fixture must resolve its own B metadata before corruption');
  const originalMetadata = await readFile(metadataPath);
  // Release the seeding client's mutation ownership before exercising the real UI client.
  rpc.close();
  await waitFor(() => rpc.socket.readyState === rpc.socket.constructor.CLOSED, 5000, 'seed owner disconnect');
  rpc = await openRpc(rpcUrl);
  await initializeRpc(rpc, 'partial-list-observer');
  const browser = await startChromium(context);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const replies = [];
  const requests = [];
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(String(error)));
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        requests.push({ method: message.method, threadId: message.params?.threadId, title: message.params?.title });
      } catch { /* Ignore non-JSON frames. */ }
    });
    socket.on('framereceived', ({ payload }) => {
    try {
      const message = JSON.parse(String(payload));
      if (message.result?.completeness) replies.push(message.result.completeness);
    } catch { /* Other transport messages are irrelevant to this fixture. */ }
    });
  });
  const row = id => page.getByTestId(`runtime-local-task-row-kcoder:local:${id}`);
  const renameA = async title => {
    await row(ids[0]).click({ button: 'right' });
    await page.getByTestId(`runtime-local-task-menu-rename-kcoder:local:${ids[0]}`).click();
    await page.getByTestId(`rename-runtime-local-task-input-kcoder:local:${ids[0]}`).fill(title);
    await page.getByTestId(`confirm-rename-runtime-local-task-kcoder:local:${ids[0]}`).click();
    await waitFor(async () => (await row(ids[0]).innerText()).includes(title), 10000, 'rename committed and list refreshed');
  };
  let stage = 'baseline';
  try {
    await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 30000 });
    await waitFor(async () => (await page.getByTestId('project-item-button').count()) > 0, 15000, 'fixture workspace');
    for (const button of await page.getByTestId('project-item-button').all()) {
      if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
    }
    await row(ids[0]).waitFor();
    await row(ids[1]).waitFor();
    stage = 'partial';
    await writeFile(metadataPath, '{broken');
    await assert.rejects(rpc.request('thread/list', {}), /allowPartial|incomplete/);
    for (let index = 0; index < 3; index++) {
      const before = replies.length;
      await renameA(`Partial A ${index}`);
      await waitFor(() => replies.slice(before).includes('partial'), 10000, 'negotiated partial response');
      await page.getByTestId('runtime-thread-list-incomplete').first().waitFor();
      assert.equal(await row(ids[1]).isVisible(), true, 'partial refresh must retain B after repeated misses');
    }
    await page.screenshot({ path: context.pathInArtifacts('partial-retains-b.png') });
    stage = 'complete-after-delete';
    await writeFile(metadataPath, originalMetadata);
    await rpc.request('thread/delete', { threadId: ids[1] });
    for (let index = 0; index < 2; index++) {
      const before = replies.length;
      await renameA(`Complete A ${index}`);
      await waitFor(() => replies.slice(before).includes('complete'), 10000, 'complete confirmation');
    }
    await row(ids[1]).waitFor({ state: 'hidden', timeout: 10000 });
    await page.getByTestId('runtime-thread-list-incomplete').waitFor({ state: 'hidden' });
    assert.equal(await row(ids[0]).isVisible(), true);
    assert.equal(model.requests.length, 2);
    return { repeatedPartialRetainedB: true, completeDeletedB: true, healthyAVisible: true,
      negotiatedStatusReachedRenderer: true, oldClientRejectedPartial: true, modelRequests: 2,
      successScreenshotReason: 'critical partial notice and retained known conversation' };
  } catch (error) {
    const workspaces = await page.evaluate(async () => {
      const result = await window.__TAURI_INTERNALS__.invoke('local_executor_request', { method: 'runtime.tasks.list', params: {} });
      return result;
    }).catch(error => ({ error: String(error) }));
    await context.writeArtifactJson('failure.json', { stage, error: String(error), replies, requests, browserErrors, workspaces, body: await page.locator('body').innerText() });
    await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => undefined);
    throw error;
  } finally { await page.close(); }
});

async function findMetadata(root, id) {
  const directories = [root];
  for (let index = 0; index < directories.length; index++) {
    assert.ok(directories.length < 200, 'fixture traversal is bounded');
    const directory = directories[index];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile() && entry.name === 'thread-metadata.json' && basename(directory) === id) return path;
    }
  }
  return null;
}
