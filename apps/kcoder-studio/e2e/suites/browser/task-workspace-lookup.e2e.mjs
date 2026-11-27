import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runE2E, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { mayReloadColdStaticPage } from '../../harness/task-workspace-static-reload.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { openFullyColdWorkspaceBrowser, observeColdWorkspaceBrowser } from '../../harness/task-workspace-browser.mjs';

await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: 'browser-original-task-after-all-original-brokers-exit', tier: 'full-integration',
  modelPolicy: 'One owned deterministic seed inference; real cold Studio navigation after the original Native exits. No further Provider inference, paid model, path URL/cache or scenario.' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'fixed cold task Native');
  const f = await openFullyColdWorkspaceBrowser(context, binary);
  const wire = observeColdWorkspaceBrowser(f.page, f.threadId);
  await context.writeArtifactJson('cold-browser-preconditions.json', { originalProcess: f.originalProcess,
    initialWorkspaceHints: f.initialWorkspaceHints, originalThreadId: f.threadId, originalWorkspace: f.original,
    savedDefault: f.fallback, seedModelRequests: f.model.requests.length, routeParameters: ['deviceId', 'taskId'] });
  try {
    assert.deepEqual([...new URL(f.url).searchParams.keys()].sort(), ['deviceId', 'taskId']);
    const staticFailures = [];
    f.page.on('requestfailed', request => {
      if (request.failure()?.errorText === 'net::ERR_NETWORK_CHANGED')
        staticFailures.push({ url: request.url(), method: request.method(), error: request.failure().errorText });
    });
    await f.page.goto(f.url, { waitUntil: 'domcontentloaded' });
    let reloads = 0;
    const origin = new URL(f.gateway.baseUrl).origin;
    const loaded = await waitFor(async () => {
      if (mayReloadColdStaticPage({ origin, failures: staticFailures, rpcCount: wire.length, userActions: 0, reloads })) return 'static-reload';
      if (wire.length > 0 || await f.page.getByTestId('message-assistant').filter({ hasText: 'COLD_HISTORY_READY' }).isVisible()) return 'app-started';
      return null;
    }, 30_000, 'cold page static startup');
    if (loaded === 'static-reload') {
      assert.equal(f.model.requests.length, 1);
      reloads++;
      await context.writeArtifactJson('cold-static-get-reload.json', { reloads, rpcCountBefore: 0, userActionsBefore: 0,
        modelRequestsBefore: 1, failures: staticFailures.map(row => ({ method: row.method, path: new URL(row.url).pathname, error: row.error })) });
      await f.page.reload({ waitUntil: 'domcontentloaded' });
      assert.equal(f.model.requests.length, 1);
    }
    await waitFor(async () => {
      assert.equal(wire.some(row => row.method === 'thread/workspace/lookup' && row.errorCode), false, 'actual Native lookup refused');
      return f.page.getByTestId('message-assistant').filter({ hasText: 'COLD_HISTORY_READY' }).isVisible();
    }, 30_000, 'actual original cold history');
    await waitFor(() => f.page.getByTestId('session-messages-open').isEnabled(), 15_000, 'validated original thread communication entry');
    await f.page.getByTestId('session-messages-open').click();
    await f.page.getByTestId('session-messages-dialog').waitFor({ timeout: 15_000 });
    await waitFor(() => wire.some(row => row.method === 'thread/agentMessage/policy/read' && row.threadId === f.threadId && row.reply && !row.errorCode),
      15_000, 'the real communication panel reads the restored original thread');
    let targetPage = await waitFor(() => wire.findLast(row => row.method === 'thread/agentMessage/targets' &&
      row.threadId === f.threadId && row.reply && !row.errorCode && row.targets), 15_000, 'first real original session target page');
    for (let pageNumber = 1; targetPage.targets.nextCursor; pageNumber++) {
      assert.ok(pageNumber < 4, 'original target directory must finish within the bounded page budget');
      const cursor = targetPage.targets.nextCursor;
      const next = f.page.getByTestId('session-messages-dialog').getByRole('button', { name: /^(Next page|下一页)$/ });
      await next.waitFor({ timeout: 15_000 });
      await waitFor(() => next.isEnabled(), 15_000, 'formal original target continuation');
      const offset = wire.length;
      await next.click();
      targetPage = await waitFor(() => wire.slice(offset).find(row => row.method === 'thread/agentMessage/targets' &&
        row.threadId === f.threadId && row.reply && !row.errorCode && row.targets), 15_000, 'same original cursor target continuation');
      assert.equal(targetPage.requestCursor, cursor);
    }
    const scopeFailure = f.page.getByTestId('session-messages-dialog').getByText(/无法读取原会话范围|Could not read the original session scope/);
    assert.equal(await scopeFailure.isVisible(), false, 'the real original-scope failure must not be visible');
    assert.equal(wire.filter(row => row.method === 'thread/agentMessage/targets').length <= 4, true);
    const lookups = wire.filter(row => row.method === 'thread/workspace/lookup' && row.reply && !row.errorCode);
    assert.equal(wire.filter(row => row.method === 'thread/workspace/lookup').length, 1,
      'concurrent cold observers of the same original task must share one unfinished metadata discovery');
    assert.ok(lookups.some(row => row.lookup?.threadId === f.threadId && row.lookup.completeness === 'complete' &&
      row.lookup.issueCount === 0 && row.lookup.candidates.length === 1 && row.lookup.candidates[0].workspacePath === f.original));
    const rootConnection = wire.find(row => row.method === 'runtime.workspaces.list' && row.workspace === f.fallback && row.reply && !row.errorCode)?.connection;
    assert.ok(rootConnection, 'the root workspace directory must have an actual successful connection');
    assert.equal(lookups[0].connection, rootConnection, 'cold metadata borrows the already held root command connection');
    const rootThreadLists = wire.filter(row => row.method === 'thread/list' && row.workspace === f.fallback);
    assert.ok(rootThreadLists.length > 0 && rootThreadLists.every(row => row.connection === rootConnection && row.reply && !row.errorCode),
      'root candidate verification reuses the root connection');
    assert.ok(wire.some(row => row.method === 'thread/list' && row.matches?.some(thread => thread.id === f.threadId && thread.cwd === f.original)));
    assert.equal(wire.filter(row => row.method === 'thread/list' && row.workspace === f.original).length, 1,
      'cold candidate verification and hydration must consume the same original Native inventory');
    assert.ok(wire.some(row => row.method === 'thread/resume' && row.threadId === f.threadId && row.actualThreadId === f.threadId && !row.errorCode));
    assert.ok(wire.some(row => ['thread/read', 'thread/read/indexed'].includes(row.method) && row.threadId === f.threadId && row.actualThreadId === f.threadId && !row.errorCode));
    assert.equal(wire.some(row => ['thread/start', 'turn/start'].includes(row.method)), false);
    assert.equal(f.model.requests.length, 1, 'cold reads and panel entry cannot invoke another inference');
    await context.writeArtifactJson('cold-browser-proof.json', { originalProcess: f.originalProcess, initialWorkspaceHints: f.initialWorkspaceHints,
      taskId: f.taskId, threadId: f.threadId, originalWorkspace: f.original, savedDefault: f.fallback,
      routeParameters: ['deviceId', 'taskId'], modelRequests: 1, modelRequestsAfterOriginalExited: 0, actualNativeLookupAndOriginalPanel: true,
      coldDiscoveryLookupReads: lookups.length,
      coldDiscoveryBorrowsRootConnection: true,
      originalWorkspaceListReads: wire.filter(row => row.method === 'thread/list' && row.workspace === f.original).length,
      websocketInitializations: wire.filter(row => row.method === 'initialize').length,
      targetPages: wire.filter(row => row.method === 'thread/agentMessage/targets').length, finalTargetsCompleteness: targetPage.targets.completeness });
    const index = await readFile(process.env.KCODER_E2E_RENDERER_ROOT + '/index.html');
    await context.writeArtifactJson('renderer-input.json', { e2e: true, root: process.env.KCODER_E2E_RENDERER_ROOT,
      indexSha256: createHash('sha256').update(index).digest('hex') });
    return { originalPid: f.originalProcess.pid, coldOriginalTaskRecovered: true, communicationThreadId: f.threadId, seedModelRequests: 1, extraModelRequests: 0 };
  } finally {
    await context.writeArtifactJson('cold-browser-wire.json', wire);
    await f.page.screenshot({ path: context.pathInArtifacts('cold-browser.png'), fullPage: true }).catch(() => {});
  }
});
