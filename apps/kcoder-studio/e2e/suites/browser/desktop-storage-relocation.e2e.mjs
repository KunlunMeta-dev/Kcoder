import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from '../../../renderer/node_modules/@playwright/test/index.mjs';
import { appRoot, repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { assertRendererBuildFresh } from '../../harness/renderer-build.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
import { startOwnedDisplay } from '../../harness/ai-verify-gateway.mjs';
import { createShortChromiumTemp } from '../../harness/short-chromium-temp.mjs';
import { startSourceDesktop } from '../../harness/source-desktop.mjs';
import { openRpc } from '../../harness/rpc.mjs';
import { createStorageNativeInput, observeDesktopStorageHandoff } from '../../harness/desktop-storage-operation.mjs';
import { hashHistoryFile } from '../../harness/migration-large-history.mjs';

const rendererMode = process.env.KCODER_E2E_STORAGE_RENDERER_MODE || 'static';
const cleanupOldCopies = process.env.KCODER_E2E_STORAGE_CLEANUP === '1';
const crossFilesystem = process.env.KCODER_E2E_STORAGE_CROSS_VOLUME === '1';
assert.ok(['static', 'vite'].includes(rendererMode));
const build = rendererMode === 'static' ? await assertRendererBuildFresh() : { rendererMode: 'vite', prebuiltRenderer: false };
await runE2E(import.meta.url, {
  testId: 'desktop-settings-offline-storage-relocation', tier: 'manual-live',
  variantId: `${cleanupOldCopies ? `${rendererMode}-cleanup` : rendererMode}${crossFilesystem ? '-cross-filesystem' : ''}`,
  modelPolicy: 'model-independent real full Electron, native dialogs, original CLI/Gateway and restart; no model turns',
  retainSuccessLogs: true,
}, async context => {
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: actual Linux Electron /proc and X11 required');
  assert.equal(process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX, '1', 'UNMET_PREREQUISITE: explicit isolated VM opt-in required');
  const cli = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'Root Native CLI');
  const nativeTargetDir = resolve(repoRoot, process.env.KCODER_TARGET_DIR || process.env.CARGO_TARGET_DIR || 'target');
  const addon = join(nativeTargetDir, 'debug/libkcoder_native_storage.so');
  const inputs = ['apps/kcoder-studio/dev-server.mjs', 'apps/kcoder-studio/src/studio-vite-renderer.js',
    'apps/kcoder-studio/src/skill-node-runtime.mjs', 'apps/kcoder-studio/src/local-mcp-presets.mjs',
    'apps/kcoder-studio/desktop/main.mjs', 'apps/kcoder-studio/src/storage-paths.mjs',
    'apps/kcoder-studio/src/storage-operation-client.mjs', 'apps/kcoder-studio/desktop/storage-locations-controller.mjs',
    'apps/kcoder-studio/desktop/storage-browser-cache.mjs',
    'apps/kcoder-studio/e2e/harness/source-desktop.mjs', 'apps/kcoder-studio/e2e/harness/desktop-storage-operation.mjs',
    'apps/kcoder-studio/e2e/suites/browser/desktop-storage-relocation.e2e.mjs'];
  const runtimeIdentities = async () => ({ cli, cliSha256: await hashHistoryFile(cli),
    addon, addonSha256: await hashHistoryFile(addon),
    inputs: Object.fromEntries(await Promise.all(inputs.map(async path => [path, await hashHistoryFile(resolve(repoRoot, path))]))) });
  const beforeRuntime = await runtimeIdentities();
  if (process.env.KCODER_E2E_KCODER_BIN_SHA256) assert.equal(beforeRuntime.cliSha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  if (process.env.KCODER_E2E_STORAGE_ADDON_SHA256) assert.equal(beforeRuntime.addonSha256, process.env.KCODER_E2E_STORAGE_ADDON_SHA256);
  await context.writeArtifactJson('runtime-identities.json', beforeRuntime);
  const xdotool = await requireExecutable('/usr/bin/xdotool', 'native dialog input');
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'storage-move' });
  const home = context.pathInState('home');
  const scratch = crossFilesystem ? await context.createOwnedScratchDirectory('storage-electron-cross-filesystem', {
    baseDirectory: '/dev/shm', expectedFilesystemType: 0x1021994n,
    requiredBytes: 128n * 1024n * 1024n, reserveBytes: 64n * 1024n * 1024n,
  }) : null;
  let source = context.pathInState('data-A');
  let target = scratch ? context.pathInScratch(scratch, 'data-B') : context.pathInState('data-B');
  let cache = context.pathInState('cache');
  for (const path of [home, target, cache]) await mkdir(path, { recursive: true, mode: 0o700 });
  await context.writeStateJson('data-A/settings.json', { providers: {} });
  if (cleanupOldCopies) {
    await context.writeStateJson('data-A/cleanup-original.json', { owner: context.seed, original: true });
    await context.writeStateJson('data-A/cleanup-modified.json', { owner: context.seed, original: true });
  }
  await context.writeStateJson('home/.config/kcoder-storage.json', { version: 1, revision: 1, dataRoot: source, cacheRoot: cache });
  const originalSettings = await readFile(join(source, 'settings.json'));
  const locationPath = join(home, '.config/kcoder-storage.json');
  const display = await startOwnedDisplay(context);
  const temporary = await createShortChromiumTemp(context);
  const hostOptions = {
    usePersonalStorageSelection: true, ownedDisplay: display, workspace: workspace.path, kcoderBin: cli,
    startTimeoutMs: 60_000,
    env: { RUST_LIB_BACKTRACE: '1', KCODER_TARGET_DIR: nativeTargetDir,
      KCODER_STUDIO_RENDERER_MODE: rendererMode, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
      TMPDIR: temporary.path, TMP: temporary.path, TEMP: temporary.path },
  };
  const moves = [];
  const draft = `storage-unsent-draft-${context.seed}`;
  context.registerSecret(draft);
  const turnStarts = [];
  const observeTurns = page => page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    let frame; try { frame = JSON.parse(String(payload)); } catch { return; }
    if (frame.method === 'turn/start') turnStarts.push(frame.method);
  }));
  const openComposer = async page => {
    const project = page.getByTestId('project-item').first();
    await project.waitFor({ timeout: 60_000 });
    await project.hover();
    await project.getByTestId('project-new-conversation-button').click();
    await page.getByTestId('chat-message-input').waitFor({ timeout: 60_000 });
  };
  const assertSelectedViteCache = async (dataRoot, cacheRoot) => {
    if (rendererMode !== 'vite') return null;
    const skillLauncher = join(cacheRoot, 'gateway/skill-runtime/bin/node');
    const launcherInfo = await lstat(skillLauncher);
    assert.ok(launcherInfo.isFile() && !launcherInfo.isSymbolicLink());
    await assert.rejects(lstat(join(dataRoot, 'studio/gateway/skill-runtime')), { code: 'ENOENT' });
    const directory = join(cacheRoot, 'gateway/renderer-vite-cache');
    const metadataFile = join(directory, 'deps/_metadata.json');
    const metadata = await waitFor(async () => {
      const file = await lstat(metadataFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!file) return null;
      assert.ok(file.isFile() && !file.isSymbolicLink());
      const value = JSON.parse(await readFile(metadataFile, 'utf8'));
      return Object.keys(value.optimized ?? {}).length ? value : null;
    }, 30_000, 'actual selected Gateway Vite optimizer output', 100, context.abortSignal);
    for (const name of ['renderer-vite-cache', 'renderer-vite-relay-cache']) {
      await assert.rejects(lstat(join(dataRoot, 'studio/gateway', name)), { code: 'ENOENT' });
    }
    const httpCache = join(dataRoot, 'studio/desktop/Partitions/kcoder-studio-desktop/Cache');
    const httpCacheTarget = join(cacheRoot, 'browser-cache/desktop/kcoder-studio-desktop/http');
    assert.ok((await lstat(httpCache)).isSymbolicLink());
    assert.equal(await realpath(httpCache), httpCacheTarget);
    const httpCacheInfo = await lstat(httpCacheTarget);
    assert.ok(httpCacheInfo.isDirectory() && !httpCacheInfo.isSymbolicLink());
    return { directory, metadataSha256: await hashHistoryFile(metadataFile),
      optimizedDependencyCount: Object.keys(metadata.optimized).length, persistentGatewayCachesAbsent: true,
      skillLauncher, skillLauncherSha256: await hashHistoryFile(skillLauncher),
      persistentGatewaySkillRuntimeAbsent: true, relayOptimizerExercised: false,
      httpCache, httpCacheTarget, httpCacheEntries: await readdir(httpCacheTarget) };
  };
  let profileIdentity;
  for (let round = 1; round <= 2; round++) {
    const targetCache = round === 2 ? context.pathInState('cache-C') : cache;
    if (targetCache !== cache) await mkdir(targetCache, { mode: 0o700 });
    let filesystem;
    if (crossFilesystem) {
      const [from, to] = await Promise.all([stat(source, { bigint: true }), stat(target, { bigint: true })]);
      assert.notEqual(from.dev, to.dev, 'UNMET_PREREQUISITE: each actual Electron move must cross filesystems');
      filesystem = { source, target, sourceDevice: String(from.dev), targetDevice: String(to.dev) };
      await context.writeArtifactJson(`move-${round}-filesystems-before.json`, filesystem);
    }
    const originalLocation = await readFile(locationPath);
    let phase = 'startup', operationId = null, observer = null;
    const operation = async () => {
      try {
        const root = join(home, '.config/kcoder-storage-migrations');
        const id = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
        if (operationId) assert.equal(id, operationId, 'never replace an unknown original operation');
        const receipt = JSON.parse(await readFile(join(root, id, 'receipt.json'), 'utf8'));
        if (id === moves.at(-1)?.operationId) {
          assert.equal(receipt.phase, 'verified');
          assert.equal(receipt.disposition, 'complete');
          return null;
        }
        assert.equal(receipt.plan.target.dataRoot, target);
        assert.equal(receipt.plan.target.cacheRoot, targetCache);
        operationId ??= id;
        return receipt;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const desktop = await startSourceDesktop(context, { label: `storage-original-${round}`, ...hostOptions });
    const { page } = desktop;
    observeTurns(page);
    const mainUrl = await waitFor(() => desktop.output().match(/Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/)?.[1],
      10_000, 'owned main inspector', 100, context.abortSignal);
    const inspector = await openRpc(mainUrl);
    context.registerPort(`storage-main-inspector-${round}`, Number(new URL(mainUrl).port));
    context.addCleanup('close storage main observer', () => inspector.close());
    let sequence = 0;
    const evaluateMain = async expression => {
      const id = ++sequence;
      inspector.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      const response = await inspector.waitFor(value => value.id === id, 5000, 'owned Electron main observation');
      assert.equal(response.error, undefined);
      assert.equal(response.result?.exceptionDetails, undefined);
      return response.result.result.value;
    };
    const nativeInput = createStorageNativeInput(context, { display, xdotool, label: `storage-native-${round}` });
    try {
      observer = await observeDesktopStorageHandoff(context, { evaluateMain, nativeInput, cli, home, hostPid: desktop.child.pid, label: `storage-handoff-${round}` });
      await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60_000 });
      await context.writeArtifactJson(`move-${round}-source-vite-cache.json`, await assertSelectedViteCache(source, cache));
      const origin = new URL(page.url()).origin;
      const marker = `storage-origin-${context.seed}`;
      context.registerSecret(marker);
      await page.evaluate(value => localStorage.setItem('kcoder-owned-storage-move', value), marker);
      await page.context().addCookies([{ name: 'kcoder_owned_storage_move', value: marker, url: origin,
        expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, sameSite: 'Lax' }]);
      phase = 'source-composer-draft';
      await openComposer(page);
      if (round === 1) {
        await page.getByTestId('chat-message-input').click();
        await page.keyboard.insertText(draft);
      }
      await expect(page.getByTestId('chat-message-input')).toContainText(draft);
      await waitFor(() => page.evaluate(content => {
        return Object.keys(localStorage).some(key => {
          if (!key.startsWith('kcoder.composer-drafts.v1:')) return false;
          try { return JSON.parse(localStorage.getItem(key) ?? 'null')?.content === content; }
          catch { return false; }
        });
      }, draft), 15_000, 'actual composer input persisted by the original draft codec', 100, context.abortSignal);
      await page.goto(`${origin}/settings/storage`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('storage-locations-panel').waitFor();
      await expect(page.getByTestId('storage-locations-readonly')).toHaveCount(0);
      await expect(page.getByTestId('storage-location-path-dataRoot')).toContainText(source);
      await expect(page.getByTestId('storage-location-path-cacheRoot')).toContainText(cache);

      // Only title the actual native dialogs; retain their options, effects and results.
      await evaluateMain(`(() => {
        const { dialog } = process.getBuiltinModule('module').createRequire(process.cwd() + '/package.json')('electron');
        const open = dialog.showOpenDialog, confirm = dialog.showMessageBox;
        dialog.showOpenDialog = (window, options) => open.call(dialog, window, { ...options, title: 'KCoder storage picker fixture' });
        dialog.showMessageBox = (window, options) => confirm.call(dialog, window, { ...options, title: 'KCoder storage stop fixture' });
        return true;
      })()`);
      phase = 'native-picker';
      for (const [kind, directory] of [['data', target], ...(targetCache !== cache ? [['cache', targetCache]] : [])]) {
        await page.getByTestId(`storage-location-pick-${kind}`).click();
        await nativeInput(['search', '--sync', '--onlyvisible', '--name', '^KCoder storage picker fixture$']);
        await nativeInput(['key', '--clearmodifiers', 'ctrl+l']);
        await nativeInput(['type', '--clearmodifiers', '--delay', '0', directory]);
        await nativeInput(['key', '--clearmodifiers', 'Return']);
        await nativeInput(['key', '--clearmodifiers', 'alt+o']);
      }
      await page.getByTestId('storage-location-preview').waitFor({ timeout: 15_000 });
      phase = 'preview';
      await page.getByTestId('storage-location-preview').click();
      await waitFor(async () => {
        if (await page.getByTestId('storage-location-action-error').count()) {
          throw new Error(`Native preview rejected: ${JSON.stringify(await observer.planFailure())}`);
        }
        return await page.getByTestId('storage-location-plan').count();
      }, 20_000, 'actual storage preview', 100, context.abortSignal);
      await expect(page.getByTestId('storage-location-plan')).toContainText(target);
      await expect(page.getByTestId('storage-location-plan')).toContainText(targetCache);
      assert.equal(await operation(), null);
      assert.deepEqual(await readFile(locationPath), originalLocation);
      await page.screenshot({ path: context.pathInArtifacts(`move-${round}-preview.png`) });
      phase = 'confirm';
      await page.getByTestId('storage-location-stop-migrate').click();
      await page.getByTestId('storage-location-confirm-submit').click();
      await nativeInput(['search', '--sync', '--onlyvisible', '--name', '^KCoder storage stop fixture$']);
      await nativeInput(['key', '--clearmodifiers', 'Right', 'Return']);
      phase = 'handoff';
      const childReceipt = await waitFor(() => observer.receipt().catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
      }), 15_000, 'actual handed-off child', 100, context.abortSignal);
      await context.writeArtifactJson(`move-${round}-handoff-owner.json`, childReceipt);
      inspector.close();
      await waitFor(async () => {
        const receipt = await operation();
        const members = await observer.sourceMembers();
        if (members.length) {
          assert.ok(!receipt || ['planned', 'stopping'].includes(receipt.phase),
            'copy must not begin while original Electron processes remain alive');
          assert.deepEqual(await readFile(locationPath), originalLocation);
        }
        return !members.length && desktop.child.exitCode !== null;
      }, 30_000, 'original desktop and its process group fully exited before copy', 50, context.abortSignal);
      assert.equal(desktop.child.exitCode, 0);
      phase = 'offline-operation';
      const completed = await waitFor(async () => {
        const receipt = await operation();
        if (receipt?.errorCode || receipt?.disposition === 'deferred') {
          throw new Error(`Original storage operation stopped: ${receipt.errorCode || receipt.disposition}`);
        }
        if (receipt?.phase === 'verified' && receipt.disposition === 'complete') return receipt;
        if (!(await observer.members()).length) {
          const latest = await operation();
          if (latest?.phase === 'verified' && latest.disposition === 'complete') return latest;
          throw new Error('STORAGE_EXECUTOR_EXITED_WITH_UNSETTLED_RECEIPT');
        }
        return null;
      }, 90_000, 'original operation complete after read-only verification', 100, context.abortSignal);
      const selected = JSON.parse(await readFile(locationPath, 'utf8'));
      assert.equal(selected.dataRoot, target);
      assert.equal(selected.cacheRoot, targetCache);
      if (filesystem) {
        assert.equal(String((await stat(target, { bigint: true })).dev), filesystem.targetDevice);
        await context.writeArtifactJson(`move-${round}-filesystems-after.json`, filesystem);
      }
      assert.equal(selected.operationId, operationId);
      assert.deepEqual(await readFile(join(source, 'settings.json')), originalSettings);
      assert.deepEqual(await readFile(join(target, 'settings.json')), originalSettings);
      await assert.rejects(readFile(join(target, 'kcoder-storage-pending.json')), { code: 'ENOENT' });
      const currentIdentity = await readFile(join(target, '.profile-identity.json'));
      if (profileIdentity) assert.deepEqual(currentIdentity, profileIdentity, 'a second move must not add a physical binding or compatibility layer');
      else profileIdentity = currentIdentity;
      phase = 'restarted-desktop';
      const restartStarted = Date.now();
      const restartWindows = new Map();
      let restartedWindow;
      try { restartedWindow = await waitFor(async () => {
        for (const member of await observer.members()) {
          const windows = await nativeInput(['search', '--onlyvisible', '--pid', String(member.pid)]).catch(error => {
            if (error.nativeWindowNotFound === true) return '';
            throw error;
          });
          for (const window of windows.split(/\s+/).filter(Boolean)) {
            const title = await nativeInput(['getwindowname', window]);
            if (!/KCoder Studio/.test(title)) continue;
            // The restricted startup window has the same title but no Quit menu.
            const geometry = await nativeInput(['getwindowgeometry', '--shell', window]);
            const key = `${window}:${geometry}`;
            if (restartWindows.size < 16 && !restartWindows.has(key)) restartWindows.set(key,
              { pid: member.pid, window, title, geometry, elapsedMs: Date.now() - restartStarted });
            if (Number(geometry.match(/^WIDTH=(\d+)$/m)?.[1]) >= 960 &&
                Number(geometry.match(/^HEIGHT=(\d+)$/m)?.[1]) >= 640) return window;
          }
        }
        return null;
      }, hostOptions.startTimeoutMs, 'real restarted Electron window', 250, context.abortSignal);
      } finally {
        await context.writeArtifactJson(`move-${round}-restart-windows.json`, {
          elapsedMs: Date.now() - restartStarted, window: restartedWindow ?? null,
          candidates: [...restartWindows.values()], members: await observer.members() });
      }
      await context.writeArtifactJson(`move-${round}-completed-operation.json`, completed);
      await nativeInput(['windowfocus', '--sync', restartedWindow]);
      await nativeInput(['key', '--clearmodifiers', 'ctrl+q']);
      await waitFor(async () => !(await observer.members()).length, 30_000,
        'restarted desktop exits through its real Quit command', 100, context.abortSignal);
      await observer.stop();
      await desktop.stop();
      phase = 'cold-desktop-read';
      const restored = await startSourceDesktop(context, { label: `storage-restored-${round}`, ...hostOptions });
      observeTurns(restored.page);
      await restored.page.getByTestId('desktop-sidebar').waitFor({ timeout: 60_000 });
      await context.writeArtifactJson(`move-${round}-target-vite-cache.json`, await assertSelectedViteCache(target, targetCache));
      assert.equal(new URL(restored.page.url()).origin, origin, 'preserve the actual browser origin and port');
      assert.equal(await restored.page.evaluate(() => localStorage.getItem('kcoder-owned-storage-move')), marker);
      const cookies = await restored.page.context().cookies(origin);
      assert.equal(cookies.find(cookie => cookie.name === 'kcoder_owned_storage_move')?.value, marker);
      await openComposer(restored.page);
      await expect(restored.page.getByTestId('chat-message-input')).toContainText(draft);
      await restored.page.goto(`${origin}/settings/storage`, { waitUntil: 'domcontentloaded' });
      await expect(restored.page.getByTestId('storage-location-path-dataRoot')).toContainText(target);
      await expect(restored.page.getByTestId('storage-location-path-cacheRoot')).toContainText(targetCache);
      await expect(restored.page.getByTestId('storage-location-operation')).toContainText(operationId);
      await restored.page.screenshot({ path: context.pathInArtifacts(`move-${round}-restored.png`) });
      if (cleanupOldCopies) {
        const theme = round === 1 ? 'light' : 'dark';
        await restored.page.goto(`${origin}/settings/appearance`, { waitUntil: 'domcontentloaded' });
        await restored.page.getByTestId(`appearance-mode-${theme}`).click();
        await restored.page.goto(`${origin}/settings/storage`, { waitUntil: 'domcontentloaded' });
        await restored.page.getByTestId('storage-cleanup-preview').waitFor();
        assert.equal(await restored.page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark');
        phase = 'old-copy-cleanup-preview';
        const originalCopy = await readFile(join(source, 'cleanup-original.json'));
        const modifiedCopy = Buffer.from(JSON.stringify({ owner: context.seed, changedAfterMigration: true }));
        const newCopy = Buffer.from(JSON.stringify({ owner: context.seed, createdAfterMigration: true }));
        await writeFile(join(source, 'cleanup-modified.json'), modifiedCopy);
        await writeFile(join(source, 'cleanup-new.json'), newCopy);
        await restored.page.getByTestId('storage-cleanup-preview').click();
        await waitFor(async () => {
          const error = restored.page.getByTestId('storage-location-action-error');
          if (await error.count()) throw new Error(`Old-copy preview rejected: ${await error.innerText()}`);
          return await restored.page.getByTestId('storage-cleanup-plan').count();
        }, 30_000, 'actual native old-copy cleanup preview', 100, context.abortSignal);
        assert.deepEqual(await readFile(join(source, 'cleanup-original.json')), originalCopy,
          'preview is not authorization to remove old copies');
        await restored.page.getByTestId('storage-cleanup-entry-details').click();
        await expect(restored.page.getByTestId('storage-cleanup-entries')).toContainText('cleanup-new.json');
        await expect(restored.page.getByTestId('storage-cleanup-entries')).toContainText('cleanup-modified.json');
        await restored.page.screenshot({ path: context.pathInArtifacts(`move-${round}-cleanup-preview.png`) });
        await restored.page.getByTestId('storage-cleanup-confirm').click();
        await restored.page.getByTestId('storage-cleanup-confirm-dialog').waitFor();
        await restored.page.screenshot({ path: context.pathInArtifacts(`move-${round}-cleanup-confirm.png`) });
        await restored.page.getByTestId('storage-cleanup-cancel').click();
        assert.deepEqual(await readFile(join(source, 'cleanup-original.json')), originalCopy,
          'cancelling independent cleanup preserves the original file');
        phase = 'old-copy-cleanup-confirm';
        await restored.page.getByTestId('storage-cleanup-confirm').click();
        await restored.page.getByTestId('storage-cleanup-submit').click();
        await restored.page.getByTestId('storage-cleanup-result').waitFor({ timeout: 30_000 });
        await assert.rejects(readFile(join(source, 'cleanup-original.json')), { code: 'ENOENT' });
        assert.deepEqual(await readFile(join(source, 'cleanup-modified.json')), modifiedCopy);
        assert.deepEqual(await readFile(join(source, 'cleanup-new.json')), newCopy);
        assert.deepEqual(await readFile(join(target, 'cleanup-original.json')), originalCopy);
        assert.deepEqual(await readFile(join(target, 'settings.json')), originalSettings);
        const cleanupReceipt = await operation();
        assert.equal(cleanupReceipt.plan.operationId, operationId);
        assert.equal(cleanupReceipt.disposition, 'complete');
        assert.equal(cleanupReceipt.phase, 'verified');
        const cleanup = cleanupReceipt.ownerReceipts['source-cleanup'];
        assert.equal(cleanup.version, 2);
        if (rendererMode === 'vite') {
          const result = await restored.page.evaluate(async ({ receipt, original }) => {
            const { sourceCleanupResult } = await import('/src/kcoder/storageLocations.ts');
            return sourceCleanupResult(receipt, original);
          }, { receipt: cleanupReceipt, original: { operationId, confirmation: cleanup.preview.confirmation } });
          assert.ok(result, 'the original renderer codec must reconcile the same compact cleanup receipt');
          assert.equal(result.operationId, operationId);
          assert.equal(result.confirmation, cleanup.preview.confirmation);
          assert.equal(result.entries.find(entry => entry.relativePath === 'cleanup-original.json').status, 'removed');
          assert.equal(result.entries.find(entry => entry.relativePath === 'cleanup-modified.json').status, 'retainedChanged');
          assert.equal(result.entries.find(entry => entry.relativePath === 'cleanup-new.json').status, 'retainedUnknown');
        }
        assert.equal(restored.child.exitCode, null, 'cleanup does not stop the active new-root instance');
        await expect(restored.page.getByTestId('storage-location-path-dataRoot')).toContainText(target);
        await context.writeArtifactJson(`move-${round}-cleanup-receipt.json`, cleanupReceipt);
        await restored.page.screenshot({ path: context.pathInArtifacts(`move-${round}-cleanup-result.png`) });
      }
      await restored.stop();
      moves.push({ operationId, source, target, sourceCache: cache, targetCache, cacheRootChanged: cache !== targetCache,
        ...(filesystem ? { filesystem } : {}), actualMain: true, nativePickerAndConfirmation: true, originalHostExited: true,
        originalOperationVerified: true, actualRelaunchedWindow: true, coldElectronBrowserStateRestored: true,
        actualComposerDraftRestored: true,
        sourceSettingsPreserved: !cleanupOldCopies, sourceSettingsPreservedBeforeCleanup: true,
        oldCopyCleanup: cleanupOldCopies, modelTurnsRequested: 0, installedPackageAcceptance: false });
    } catch (error) {
      if (!page.isClosed()) await page.screenshot({ path: context.pathInArtifacts(`move-${round}-failure.png`) }).catch(() => {});
      await context.writeArtifactJson(`move-${round}-failure-stage.json`, { phase, error: error.message,
        planFailure: await observer?.planFailure(), operation: await operation() });
      throw error;
    }
    source = target;
    cache = targetCache;
    target = context.pathInState('data-C');
    if (round === 1) await mkdir(target, { mode: 0o700 });
  }
  assert.notEqual(moves[0].operationId, moves[1].operationId, 'two completed user operations have distinct receipts');
  assert.equal(moves[1].cacheRootChanged, true, 'the second actual Electron operation must change the cache root');
  assert.equal(turnStarts.length, 0, 'restoring an unsent composer draft must never start a model turn');
  const afterRuntime = await runtimeIdentities();
  await context.writeArtifactJson('runtime-identities-after.json', afterRuntime);
  assert.deepEqual(afterRuntime, beforeRuntime, 'the actual-host run must keep the frozen Native runtime');
  const result = { moves, repeatedRelocation: true, stableProfileIdentityBytes: true, modelTurnsRequested: 0, crossFilesystem,
    installedPackageAcceptance: false, rendererBuild: build };
  await context.writeArtifactJson('two-moves-summary.json', result);
  return result;
});
