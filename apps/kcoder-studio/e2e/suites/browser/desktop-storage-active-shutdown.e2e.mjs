import assert from 'node:assert/strict';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { createShortChromiumTemp } from '../../harness/short-chromium-temp.mjs';
import { startSourceDesktop } from '../../harness/source-desktop.mjs';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { hashHistoryFile } from '../../harness/migration-large-history.mjs';
import { waitForSelectedModel } from '../../harness/model-selector.mjs';
import { desktopStorageObservation, observeDesktopStorageHandoff, storageProcessStat, storageProcessGroupMembers } from '../../harness/desktop-storage-operation.mjs';

const electronModule = "process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron')";
// Keep every newly created fixture directory private to this test process tree.
process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'desktop-storage-active-tool-offline-shutdown', tier: 'manual-live', variantId: 'vite',
  modelPolicy: 'model-independent controlled SSE selects one owned Bash; actual Electron, Native tool, queue and offline migration',
  retainSuccessLogs: true,
}, async context => {
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: actual Linux Electron and /proc required');
  assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1', 'UNMET_PREREQUISITE: isolated VM opt-in required');
  const cli = await requireExecutable(resolve(repoRoot, 'target/debug/kcoder'), 'Root Native CLI');
  const addon = resolve(repoRoot, 'target/debug/libkcoder_native_storage.so');
  const inputPaths = [
    'apps/kcoder-studio/e2e/suites/browser/desktop-storage-active-shutdown.e2e.mjs',
    'apps/kcoder-studio/e2e/harness/desktop-storage-operation.mjs',
    'apps/kcoder-studio/e2e/harness/source-desktop.mjs',
    'apps/kcoder-studio/e2e/harness/approval-model.mjs',
    'apps/kcoder-studio/dev-server.mjs',
    'apps/kcoder-studio/src/skill-node-runtime.mjs',
    'apps/kcoder-studio/src/local-mcp-presets.mjs',
    'apps/kcoder-studio/desktop/main.mjs',
    'apps/kcoder-studio/desktop/additional-window.mjs',
    'apps/kcoder-studio/desktop/storage-locations-controller.mjs',
    'apps/kcoder-studio/desktop/storage-startup.mjs',
    'apps/kcoder-studio/desktop/storage-installation.mjs',
    'apps/kcoder-studio/desktop/gateway-process.mjs',
    'apps/kcoder-studio/src/storage-paths.mjs',
    'apps/kcoder-studio/src/storage-startup.mjs',
    'apps/kcoder-studio/src/migrations/storage-startup.mjs',
    'apps/kcoder-studio/src/migrations/windows-registered-sources.mjs',
    'apps/kcoder-studio/src/migrations/gateway-storage-domains.mjs',
    'apps/kcoder-studio/src/storage-operation-client.mjs',
    'apps/kcoder-studio/src/storage-lease.mjs',
    'apps/kcoder-studio/renderer/src/components/settings/StorageLocationsPanel.tsx',
    'apps/kcoder-studio/renderer/src/features/workbench/pendingInputStorage.ts',
    'apps/kcoder-studio/renderer/src/features/workbench/WorkbenchProvider.tsx',
    'apps/kcoder-studio/renderer/src/features/workbench/runtimeConversationCache.ts',
    'apps/kcoder-studio/renderer/src/components/layout/pane/usePaneQueueDispatch.ts',
    'apps/kcoder-studio/renderer/src/components/layout/pane/usePaneSend.ts',
  ];
  const runtimeIdentities = async () => ({
    cli, cliSha256: await hashHistoryFile(cli), addon, addonSha256: await hashHistoryFile(addon),
    inputs: Object.fromEntries(await Promise.all(inputPaths.map(async path => [path, await hashHistoryFile(resolve(repoRoot, path))]))),
  });
  const beforeIdentities = await runtimeIdentities();
  const { cliSha256, addonSha256 } = beforeIdentities;
  if (process.env.KCODER_E2E_KCODER_BIN_SHA256) assert.equal(cliSha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  if (process.env.KCODER_E2E_STORAGE_ADDON_SHA256) assert.equal(addonSha256, process.env.KCODER_E2E_STORAGE_ADDON_SHA256);
  await context.writeArtifactJson('runtime-identities.json', beforeIdentities);
  const xdotool = await requireExecutable('/usr/bin/xdotool', 'native dialog input');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'storage-active-tool' });
  const home = context.pathInState('home'), source = context.pathInState('data-A');
  const target = context.pathInState('data-B'), cache = context.pathInState('cache');
  for (const path of [home, source, target, cache]) await mkdir(path, { recursive: true, mode: 0o700 });
  const toolPidPath = join(workspace.path, 'storage-tool.pid');
  const initial = 'STORAGE_ACTIVE_TOOL_INITIAL', queued = 'STORAGE_QUEUE_RETAIN_ORIGINAL', draft = 'STORAGE_UNSENT_COMPOSER_DRAFT';
  const postMoveOutput = 'STORAGE_POST_MOVE_TEXT_ONLY_COMPLETED';
  const model = await startApprovalModelFixture(context, {
    responseSteps: ({ requestNumber, body }) => {
      assert.ok(requestNumber <= 2, 'controlled fixture accepts only the original tool turn and the explicitly resumed original input');
      if (requestNumber === 2) {
        const user = [...body.messages].reverse().find(message => message.role === 'user');
        assert.ok(JSON.stringify(user?.content).includes(queued), 'only the explicitly resumed original queue input may request the second response');
        assert.ok(!JSON.stringify(user?.content).includes(draft), 'resuming the queue must preserve the unsent composer draft');
        return [{ delta: { role: 'assistant', content: postMoveOutput } }, { finishReason: 'stop' }];
      }
      return [
      { delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'storage-active-bash-original', type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({
          command: `printf '%s' "$$" > '${toolPidPath}'; printf 'STORAGE_BASH_STARTED\\n'; sleep 180`,
          description: 'Owned storage shutdown lifecycle fixture', timeout: 240000,
        }) } }] } },
      { finishReason: 'tool_calls' },
      ];
    },
  });
  await context.writeStateJson('data-A/settings.json', {
    active_provider: 'storage-lifecycle', max_retries: 0, credential_store: 'file', permission_mode: 'yolo',
    session_memory: { enabled: false }, allowed_tools: ['bash'], tools: { profile: 'nano', disabled: [] },
    integrations: { office: { enabled: false }, connectivity: { enabled: false }, services: { enabled: false } },
    providers: { 'storage-lifecycle': {
      api_format: 'openai_chat_completions', authentication: { mode: 'none' }, discover_models: false,
      endpoint: model.baseUrl, default_model: 'storage-lifecycle-model', context_window_tokens: 128000,
      output_headroom_tokens: 1024, max_output_tokens: 1024, request_timeout_secs: 240, no_proxy: true, extra_body: {},
    } },
  });
  await context.writeStateJson('home/.config/kcoder-storage.json', { version: 1, revision: 1, dataRoot: source, cacheRoot: cache });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Storage active fixture',
    runtime: 'kcoder', transport: 'local', command: cli, workspace: workspace.path }]);
  const locationPath = join(home, '.config/kcoder-storage.json');
  const originalLocation = await readFile(locationPath);
  const display = await startOwnedDisplay(context), temporary = await createShortChromiumTemp(context);
  const hostOptions = { usePersonalStorageSelection: true, ownedDisplay: display, workspace: workspace.path, servers,
    kcoderBin: cli, startTimeoutMs: 60000,
    env: { KCODER_STUDIO_RENDERER_MODE: 'vite', XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
      TMPDIR: temporary.path, TMP: temporary.path, TEMP: temporary.path } };
  const desktop = await startSourceDesktop(context, { label: 'storage-active-original', ...hostOptions });
  const { page } = desktop;
  const observation = await desktopStorageObservation(context, { desktop, display, xdotool, label: 'storage-active' });
  const { evaluateMain, nativeInput } = observation;
  const handoff = await observeDesktopStorageHandoff(context, { evaluateMain, cli, home, hostPid: desktop.child.pid, label: 'storage-active-handoff' });
  let phase = 'busy-turn', operationId, toolIdentity, toolGroupIdentity, planId;
  const operations = [];
  const observeOperations = observedPage => observedPage.on('websocket', socket => {
    const sent = new Map();
    socket.on('framesent', ({ payload }) => {
      let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
      if (!['thread/start', 'turn/start', 'turn/interrupt'].includes(frame.method)) return;
      const entry = { phase, method: frame.method, clientMessageId: frame.params?.clientMessageId, threadId: frame.params?.threadId };
      operations.push(entry); sent.set(frame.id, entry);
    });
    socket.on('framereceived', ({ payload }) => {
      let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
      const entry = sent.get(frame.id); if (!entry) return;
      entry.threadId ??= frame.result?.thread?.id; entry.turnId = frame.result?.turn?.id;
      entry.ok = !frame.error && Object.hasOwn(frame, 'result'); sent.delete(frame.id);
    });
  });
  observeOperations(page);
  const receipt = async () => {
    try {
      const root = join(home, '.config/kcoder-storage-migrations');
      const id = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
      operationId ??= id;
      assert.equal(id, operationId, 'retain the original operation identity');
      if (planId) assert.equal(id, planId);
      return JSON.parse(await readFile(join(root, id, 'receipt.json'), 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const toolMembers = async () => {
    const members = await storageProcessGroupMembers(toolGroupIdentity.group, { includeHome: false });
    for (const member of members) {
      assert.equal(member.session, toolGroupIdentity.session, 'observe only the original tool session');
      assert.equal(member.uid, process.getuid());
      assert.ok(BigInt(member.started) >= BigInt(toolGroupIdentity.started));
      if (member.pid === toolGroupIdentity.pid) assert.equal(member.started, toolGroupIdentity.started);
    }
    return members;
  };
  const readQueued = candidate => candidate.evaluate(marker => {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith('kcoder.pending-inputs.v2:')) continue;
      try { const row = JSON.parse(localStorage.getItem(key)).row; if (row?.content.includes(marker)) return row; } catch {}
    }
    return null;
  }, queued);
  try {
    await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
    const launcher = await lstat(join(cache, 'gateway/skill-runtime/bin/node'));
    assert.ok(launcher.isFile() && !launcher.isSymbolicLink(), 'generated launchers belong to the selected cache root');
    await assert.rejects(lstat(join(source, 'studio/gateway/skill-runtime')), { code: 'ENOENT' });
    const origin = new URL(page.url()).origin;
    const project = page.getByTestId('project-item').filter({ hasText: 'Storage active fixture' }).first();
    await project.waitFor({ timeout: 60000 }); await project.hover();
    await project.getByTestId('project-new-conversation-button').click();
    await waitForSelectedModel(page, 'storage-lifecycle-model', 60000);
    await page.getByTestId('chat-message-input').click(); await page.keyboard.insertText(initial);
    await page.getByTestId('send-message-button').click();
    const pid = await waitFor(async () => {
      try { return Number(await readFile(toolPidPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }, 60000, 'actual Native Bash process starts', 100, context.abortSignal);
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    toolIdentity = storageProcessStat(pid, await readFile(`/proc/${pid}/stat`, 'utf8'));
    toolGroupIdentity = storageProcessStat(toolIdentity.group, await readFile(`/proc/${toolIdentity.group}/stat`, 'utf8'));
    assert.equal(toolGroupIdentity.pid, toolGroupIdentity.group);
    assert.equal(toolGroupIdentity.session, toolIdentity.session);
    const initialToolGroup = await toolMembers();
    assert.ok(initialToolGroup.length >= 2, 'observe the actual tool shell and its running child');
    assert.equal(model.requests.length, 1);
    const taskUrl = page.url();
    await page.getByTestId('chat-message-input').click(); await page.keyboard.insertText(queued);
    await page.getByTestId('send-message-button').click();
    const queuedRow = page.locator('[data-testid^="conversation-queue-row-"]').filter({ hasText: queued });
    await queuedRow.waitFor({ timeout: 10000 });
    const originalQueue = await waitFor(() => readQueued(page), 10000, 'original queued input identity');
    assert.equal(originalQueue.status, 'queued');
    await page.getByTestId('chat-message-input').click(); await page.keyboard.insertText(draft);
    await expect(page.getByTestId('chat-message-input')).toContainText(draft);
    await page.screenshot({ path: context.pathInArtifacts('active-bash-queue-draft.png') });
    await context.writeArtifactJson('original-turn-tool-queue.json', { toolIdentity, toolGroupIdentity, initialToolGroup,
      originalQueue, operations, taskUrl, modelRequests: model.requests.length });

    phase = 'additional-window-and-tray';
    await page.getByTestId('desktop-menu-0').click();
    await page.getByRole('menuitem', { name: '新建窗口', exact: true }).click();
    const settings = await waitFor(() => desktop.browser.contexts().flatMap(item => item.pages())
      .find(candidate => candidate !== page && candidate.url().startsWith(origin)), 15000, 'real additional window', 100, context.abortSignal);
    await settings.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
    const tray = await page.evaluate(() => window.kcoderDesktopHost.setPreferences({ closeToTrayEnabled: true, language: 'en' }));
    assert.equal(tray.available, true);
    await page.evaluate(() => window.kcoderDesktopHost.hideToTray());
    assert.equal(await evaluateMain(`${electronModule}.BrowserWindow.getAllWindows().filter(window => !window.isVisible()).length`), 1);
    assert.ok((await toolMembers()).length > 0);
    await settings.goto(`${origin}/settings/storage`, { waitUntil: 'domcontentloaded' });
    await settings.getByTestId('storage-locations-panel').waitFor();
    await evaluateMain(`(() => { const { dialog } = ${electronModule}; const open = dialog.showOpenDialog, confirm = dialog.showMessageBox;
      dialog.showOpenDialog = (window, options) => open.call(dialog, window, { ...options, title: 'KCoder active storage picker' });
      dialog.showMessageBox = (window, options) => confirm.call(dialog, window, { ...options, title: 'KCoder active storage stop' }); return true; })()`);
    const previewTarget = async () => {
      phase = 'native-picker';
      await settings.getByTestId('storage-location-pick-data').click();
      await nativeInput(['search', '--sync', '--onlyvisible', '--name', '^KCoder active storage picker$']);
      await nativeInput(['key', '--clearmodifiers', 'ctrl+l']);
      await nativeInput(['type', '--clearmodifiers', '--delay', '0', target]);
      await nativeInput(['key', '--clearmodifiers', 'Return']); await nativeInput(['key', '--clearmodifiers', 'alt+o']);
      await settings.getByTestId('storage-location-preview').waitFor({ timeout: 15000 });
      phase = 'preview';
      await settings.getByTestId('storage-location-preview').click();
      await waitFor(async () => {
        if (await settings.getByTestId('storage-location-action-error').count()) throw new Error(`Preview rejected: ${JSON.stringify(await handoff.planFailure())}`);
        return await settings.getByTestId('storage-location-plan').count();
      }, 20000, 'busy tool preview', 100, context.abortSignal);
      const previous = planId;
      planId = await waitFor(async () => {
        const id = await handoff.planId(); return id && id !== previous ? id : null;
      }, 5000, 'actual preview operation identity', 50, context.abortSignal);
    };
    await previewTarget();
    const cancelledPlanId = planId;
    phase = 'cancel-means-wait';
    await settings.getByTestId('storage-location-stop-migrate').click();
    await settings.getByTestId('storage-location-confirm-submit').click();
    await nativeInput(['search', '--sync', '--onlyvisible', '--name', '^KCoder active storage stop$']);
    await nativeInput(['key', '--clearmodifiers', 'Escape']);
    await expect(settings.getByTestId('storage-location-notice')).toContainText(/已取消|cancelled/i, { timeout: 10000 });
    assert.ok((await toolMembers()).length > 0, 'cancel preserves the original running tool group');
    assert.equal(await receipt(), null); assert.deepEqual(await readFile(locationPath), originalLocation);
    assert.equal(model.requests.length, 1);
    assert.equal((await readQueued(page)).id, originalQueue.id);
    await context.writeArtifactJson('cancelled-preview-no-operation.json', { cancelledPlanId, receipt: null,
      sourceSelectionPreserved: true, originalQueueId: originalQueue.id, toolGroupMembers: await toolMembers(), providerRequests: model.requests.length });
    await previewTarget();
    assert.notEqual(planId, cancelledPlanId, 'a cancelled preview was never handed off as a migration operation');

    phase = 'explicit-stop-handoff';
    await settings.getByTestId('storage-location-stop-migrate').click();
    await settings.getByTestId('storage-location-confirm-submit').click();
    await nativeInput(['search', '--sync', '--onlyvisible', '--name', '^KCoder active storage stop$']);
    await nativeInput(['key', '--clearmodifiers', 'Right', 'Return']);
    const childReceipt = await waitFor(() => handoff.receipt().catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
      15000, 'original busy operation handoff', 100, context.abortSignal);
    await context.writeArtifactJson('handoff-owner.json', childReceipt);
    observation.close();
    let samples = 0;
    await waitFor(async () => {
      const current = await receipt(), members = await handoff.sourceMembers(), toolRunning = (await toolMembers()).length > 0; samples++;
      if (members.length || toolRunning) {
        assert.ok(!current || ['planned', 'stopping'].includes(current.phase), 'no copy before all original windows/Gateway/Native/tool exit');
        assert.deepEqual(await readFile(locationPath), originalLocation);
      }
      return !members.length && !toolRunning && desktop.child.exitCode !== null;
    }, 30000, 'complete busy host and Native tool shutdown', 50, context.abortSignal);
    assert.equal(desktop.child.exitCode, 0);
    phase = 'original-operation-complete';
    const completed = await waitFor(async () => {
      const current = await receipt();
      if (current?.errorCode || current?.disposition === 'deferred') throw new Error(`Operation failed: ${current.errorCode || current.disposition}`);
      return current?.phase === 'verified' && current.disposition === 'complete' ? current : null;
    }, 90000, 'original busy operation verified', 100, context.abortSignal);
    await context.writeArtifactJson('completed-operation.json', completed);
    assert.equal(JSON.parse(await readFile(locationPath, 'utf8')).operationId, operationId);
    assert.equal(model.requests.length, 1, 'migration and target verifier must not admit a model turn');
    // The designated relaunch is observed, then closed through its real Quit command.
    const restarted = await waitFor(async () => {
      for (const member of await handoff.members()) {
        const ids = await nativeInput(['search', '--onlyvisible', '--pid', String(member.pid)]).catch(() => '');
        for (const id of ids.split(/\s+/).filter(Boolean)) {
          const geometry = await nativeInput(['getwindowgeometry', '--shell', id]);
          if (/KCoder Studio/.test(await nativeInput(['getwindowname', id])) && Number(geometry.match(/^WIDTH=(\d+)$/m)?.[1]) >= 960) return id;
        }
      }
      return null;
    }, 30000, 'designated restarted Electron window', 250, context.abortSignal);
    await nativeInput(['windowfocus', '--sync', restarted]); await nativeInput(['key', '--clearmodifiers', 'ctrl+q']);
    await waitFor(async () => !(await handoff.members()).length, 30000, 'restarted Electron real Quit', 100, context.abortSignal);
    await handoff.stop(); await desktop.stop();

    phase = 'cold-queue-draft-recovery';
    const restored = await startSourceDesktop(context, { label: 'storage-active-restored', ...hostOptions });
    observeOperations(restored.page);
    await restored.page.getByTestId('desktop-sidebar').waitFor({ timeout: 60000 });
    assert.equal(new URL(restored.page.url()).origin, origin);
    await restored.page.goto(taskUrl, { waitUntil: 'domcontentloaded' });
    await restored.page.getByTestId('chat-message-input').waitFor({ timeout: 60000 });
    const restoredQueue = await readQueued(restored.page);
    await context.writeArtifactJson('cold-queue-draft-observation.json', { operationId, originalQueue, restoredQueue,
      draftText: await restored.page.getByTestId('chat-message-input').textContent(), modelRequests: model.requests.length });
    await restored.page.screenshot({ path: context.pathInArtifacts('cold-queue-draft-recovery.png') });
    assert.ok(restoredQueue, 'original queued input must survive full Electron shutdown and migration');
    for (const key of ['id', 'ownerKey', 'clientMessageId', 'content', 'status', 'createdAt', 'modelId']) assert.equal(restoredQueue[key], originalQueue[key], `retain queue ${key}`);
    await expect(restored.page.locator('[data-testid^="conversation-queue-row-"]').filter({ hasText: queued })).toBeVisible();
    await expect(restored.page.getByTestId('resume-queue-button')).toBeVisible();
    await expect(restored.page.getByTestId('chat-message-input')).toContainText(draft);
    await expect(restored.page.getByTestId('message-user').filter({ hasText: initial })).toHaveCount(1);
    assert.equal(model.requests.length, 1, 'restored queue must not replay automatically');
    const terminalPresentation = () => restored.page.evaluate(() => ({
      summaries: [...document.querySelectorAll('[data-testid="turn-process-summary"]')].map(summary => ({
        status: summary.querySelector('[data-testid="turn-process-status"]')?.textContent,
        elapsed: summary.querySelector('[data-testid="turn-process-elapsed"]')?.textContent,
        spinning: Boolean(summary.querySelector('.animate-spin')),
      })),
      runningProcessingWindows: document.querySelectorAll('[data-testid="processing-window-toggle"]').length,
      thinkingSpinners: document.querySelectorAll('[data-testid="assistant-thinking-spinner"]').length,
    }));
    const settledPresentation = await waitFor(async () => {
      const observed = await terminalPresentation();
      return !observed.runningProcessingWindows && !observed.thinkingSpinners && observed.summaries.every(summary => !summary.spinning)
        ? observed : null;
    }, 10000, 'original cold turn has no running process presentation');
    await restored.page.waitForTimeout(1200);
    const laterPresentation = await terminalPresentation();
    assert.deepEqual(laterPresentation, settledPresentation, 'the original stopped turn must not keep advancing its visible elapsed time');
    await context.writeArtifactJson('original-turn-cold-terminal-presentation.json', {
      operationId, terminalProjectionLocated: settledPresentation.summaries.length > 0,
      first: settledPresentation, after1200ms: laterPresentation, providerRequests: model.requests.length,
    });
    assert.equal(model.requests.length, 1);

    phase = 'explicit-resume-original-queue-after-move';
    assert.equal(restoredQueue.status, 'queued', 'only an original never-accepted queued input may be explicitly sent');
    assert.equal(restoredQueue.turnId, undefined);
    const originalTurn = operations.find(entry => entry.phase === 'busy-turn' && entry.method === 'turn/start' && entry.ok);
    assert.ok(originalTurn?.turnId && originalTurn.threadId);
    await restored.page.getByTestId('resume-queue-button').click();
    await restored.page.getByTestId('message-assistant').filter({ hasText: postMoveOutput }).waitFor({ timeout: 60000 });
    assert.equal(model.requests.length, 2);
    assert.equal(restored.page.url(), taskUrl, 'continue the original migrated task');
    const resumedTurn = await waitFor(() => operations.find(entry => entry.clientMessageId === originalQueue.id && entry.ok && entry.turnId),
      15000, 'original queue clientMessageId acknowledged as a new turn');
    assert.equal(resumedTurn.threadId, originalTurn.threadId);
    assert.notEqual(resumedTurn.turnId, originalTurn.turnId);
    await expect(restored.page.getByTestId(`conversation-queue-row-${originalQueue.id}`)).toHaveCount(0, { timeout: 30000 });
    await waitFor(async () => !(await readQueued(restored.page)), 10000, 'original queued record settles durably');
    await expect(restored.page.getByTestId('message-user').filter({ hasText: queued })).toHaveCount(1);
    await expect(restored.page.getByTestId('message-user').filter({ hasText: initial })).toHaveCount(1);
    await expect(restored.page.getByTestId('chat-message-input')).toContainText(draft);
    assert.equal(model.requests.length, 2);
    assert.equal((await receipt()).plan.operationId, operationId);
    await context.writeArtifactJson('post-move-explicit-turn.json', { operationId, originalQueueId: originalQueue.id,
      originalTaskUrl: taskUrl, originalTurn, resumedTurn, originalQueueExplicitlyResumedAndSettled: true, originalDraftPreserved: true,
      providerRequests: model.requests.length, operations });
    await restored.stop();
    const afterIdentities = await runtimeIdentities();
    await context.writeArtifactJson('runtime-identities-after.json', afterIdentities);
    assert.deepEqual(afterIdentities, beforeIdentities, 'the frozen runtime and recorded flow inputs must remain unchanged throughout acceptance');
    const result = { operationId, originalTool: toolIdentity, nativeToolStopped: true, originalProcessGroupStopped: true,
      hiddenTrayWindowAndAdditionalWindowStopped: true, cancelPreservedRunningTool: true, originalQueueId: originalQueue.id,
      wholeToolProcessGroupStopped: true, queueAndDraftColdRecovery: true, originalTaskExplicitQueueTurnCompleted: true,
      cliSha256, addonSha256, shutdownSamples: samples, providerRequests: model.requests.length, externalModelCalls: 0,
      installedPackageAcceptance: false, supervisorFaultInjection: false };
    await context.writeArtifactJson('active-shutdown-summary.json', result); return result;
  } catch (error) {
    // Capture only this run's private X display while the restarted host exists.
    const visibleWindows = [];
    for (const member of await handoff.members().catch(() => [])) {
      const ids = await nativeInput(['search', '--onlyvisible', '--pid', String(member.pid)]).catch(() => '');
      for (const id of ids.split(/\s+/).filter(Boolean)) visibleWindows.push({ pid: member.pid, id,
        title: await nativeInput(['getwindowname', id]).catch(() => ''),
        geometry: await nativeInput(['getwindowgeometry', '--shell', id]).catch(() => '') });
    }
    await context.writeArtifactJson('failure-native-windows.json', visibleWindows);
    if (visibleWindows.length) {
      const capture = context.spawnOwned('storage-active-failure-display', '/usr/bin/ffmpeg', [
        '-nostdin', '-v', 'error', '-f', 'x11grab', '-video_size', '1280x900', '-i', display.display,
        '-frames:v', '1', context.pathInArtifacts('failure-owned-display.png'),
      ], { env: context.isolatedEnvironment({ DISPLAY: display.display, XAUTHORITY: display.authority }) });
      await waitFor(() => capture.exitCode !== null, 10000, 'owned failure screenshot', 50).catch(() => {});
    }
    if (!page.isClosed()) await page.screenshot({ path: context.pathInArtifacts('failure.png') }).catch(() => {});
    await context.writeArtifactJson('failure-stage.json', { phase, error: error.message, operationId, planId,
      receipt: await receipt(), toolIdentity, toolGroupIdentity, toolGroupMembers: toolGroupIdentity ? await toolMembers() : null,
      modelRequests: model.requests.length, operations, planFailure: await handoff.planFailure() });
    await context.writeArtifactJson('runtime-identities-after.json', await runtimeIdentities());
    throw error;
  }
});
