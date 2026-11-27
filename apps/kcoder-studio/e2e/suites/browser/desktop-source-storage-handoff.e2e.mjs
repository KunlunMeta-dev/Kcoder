import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat, readdir, rename, realpath, rm } from 'node:fs/promises';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appRoot, repoRoot, runE2E, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { readWindowsCurrentIdentity } from '../../../src/windows-current-identity.mjs';
import { loadStorageNative } from '../../../src/storage-lease.mjs';
import { hashHistoryFile } from '../../harness/migration-large-history.mjs';
import { waitForStdioChildClose } from '../../harness/app-server-stdio.mjs';
import { startSourceDesktop, invokeDesktopMenu } from '../../harness/source-desktop.mjs';
import { rpcClient, modelConfigurationSnapshot, createShortStorageTarget } from '../../harness/windows-storage-relocation.mjs';

await runE2E(import.meta.url, {
  testId: 'windows-source-desktop-current-user-storage-handoff', tier: 'manual-live',
  modelPolicy: 'Actual source Electron settings, Native migration and restart under one owned Windows Job; no model turns.',
  retainSuccessEvidence: true, retainSuccessLogs: true,
  evidenceReason: 'Current-user locator changes require exact restoration and original operation receipts.',
}, async context => {
  assert.equal(process.platform, 'win32', 'UNMET_PREREQUISITE: actual Windows required');
  assert.equal(process.env.KCODER_E2E_ALLOW_CURRENT_USER_STORAGE_MIGRATION, '1', 'Explicit current-profile migration authorization required');
  const account = await readWindowsCurrentIdentity();
  const fixtureRoot = dirname(repoRoot), fixture = JSON.parse((await readFile(join(fixtureRoot, '.owner.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(fixture.sid, account.sid); assert.equal(fixtureRoot.toLowerCase(), `c:\\kcoder-widget-${fixture.owner}`.toLowerCase());
  const sourceOwnerRoot = process.env.KCODER_E2E_STORAGE_COPY_OWNER_ROOT, dataRoot = process.env.KCODER_E2E_STORAGE_COPY_DATA;
  assert.ok(sourceOwnerRoot && dataRoot && isAbsolute(sourceOwnerRoot) && isAbsolute(dataRoot));
  const owner = JSON.parse((await readFile(join(sourceOwnerRoot, '.owner.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(owner.owner, process.env.KCODER_E2E_STORAGE_COPY_OWNER); assert.equal(owner.sid, account.sid);
  const inside = relative(sourceOwnerRoot, dataRoot);
  assert.ok(inside && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
  assert.ok((await lstat(dataRoot)).isDirectory() && !(await lstat(dataRoot)).isSymbolicLink());
  assert.equal((await realpath(dataRoot)).toLowerCase(), dataRoot.toLowerCase());
  const cli = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN, 'pinned Windows Debug CLI');
  assert.equal(await hashHistoryFile(cli), process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const electron = await requireExecutable(process.env.KCODER_E2E_ELECTRON_BIN, 'pinned Electron');
  assert.equal(await hashHistoryFile(electron), process.env.KCODER_E2E_ELECTRON_BIN_SHA256);
  const execute = promisify(execFile), powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const observe = async () => JSON.parse((await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '@{sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;live=@(Get-Process -Name kcoder-studio,kcoder,kcoder-copy-debug,electron -ErrorAction SilentlyContinue).Count}|ConvertTo-Json -Compress'],
  { windowsHide: true, encoding: 'utf8', timeout: 10_000 })).stdout);
  const caller = await observe(); assert.ok(caller.sessionId > 0); assert.equal(caller.live, 0, 'Existing desktop/Native writer must be left untouched');
  const control = join(account.userProfile, '.config'), location = join(control, 'kcoder-storage.json');
  const operations = join(control, 'kcoder-storage-migrations');
  for (const path of [location, operations]) await assert.rejects(lstat(path), { code: 'ENOENT' });
  const leaves = ['settings.json', 'credentials.json', '.env'];
  const snapshot = async root => Object.fromEntries(await Promise.all(leaves.map(async leaf => [leaf, await hashHistoryFile(join(root, leaf))])));
  const personalRoot = join(account.userProfile, '.config/kcoder'), personalBefore = await snapshot(personalRoot);
  const sourceBefore = await snapshot(dataRoot), identityBefore = await readFile(join(dataRoot, '.profile-identity.json'));
  const register = value => { if (typeof value === 'string' && value.length >= 8) context.registerSecret(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(register); };
  for (const leaf of ['settings.json', 'credentials.json']) register(JSON.parse(await readFile(join(dataRoot, leaf), 'utf8')));
  for (const line of (await readFile(join(dataRoot, '.env'), 'utf8')).split(/\r?\n/)) { const match = line.match(/^\s*(?:export\s+)?\w+\s*=\s*(.*?)\s*$/); if (match) register(match[1].replace(/^(['"])(.*)\1$/, '$2')); }
  let fullyAccepted = false, personalRestored = false;
  const target = await createShortStorageTarget(context, fixtureRoot, account.sid, () => fullyAccepted && personalRestored);
  const targetData = target.data, targetCache = target.cache;
  const originalDesktop = join(dataRoot, 'studio/desktop'), savedDesktop = join(sourceOwnerRoot, `desktop-before-main-${context.seed}`);
  await assert.rejects(lstat(savedDesktop), { code: 'ENOENT' });
  const sourceCache = process.env.KCODER_E2E_STORAGE_COPY_CACHE;
  assert.ok(sourceCache && isAbsolute(sourceCache));
  const cacheInside = relative(sourceOwnerRoot, sourceCache);
  assert.ok(cacheInside && cacheInside !== '..' && !cacheInside.startsWith(`..${sep}`) && !isAbsolute(cacheInside));
  assert.ok((await lstat(sourceCache)).isDirectory() && !(await lstat(sourceCache)).isSymbolicLink());
  const initial = { version: 1, revision: 1, dataRoot, cacheRoot: sourceCache };
  const initialBytes = Buffer.from(JSON.stringify(initial));
  const native = await loadStorageNative();
  const withControl = async action => {
    const gate = native.tryExclusive(control, 'kcoder-storage.lock', false); assert.ok(gate, 'Current-user storage owner busy');
    try { native.verify(gate); const result = await action(); native.verify(gate); return result; } finally { native.close(gate); }
  };
  let selectionWritten = false, browserSaved = false, committed = false;
  const progressFile = context.pathInState('progress.json');
  const operationArchive = context.pathInArtifacts('original-operation-archive');
  const selectionArchive = context.pathInArtifacts('test-selection-final.json');
  const restorationArtifact = context.pathInArtifacts('restoration.json');
  context.addCleanup('restore only this run current-user selection and copied browser', async () => {
    assert.equal((await observe()).live, 0, 'A desktop/Native writer appeared; preserve current state');
    if (selectionWritten) await withControl(async () => {
      const current = await readFile(location);
      if (!current.equals(initialBytes)) {
        const selected = JSON.parse(current); assert.equal(selected.dataRoot, targetData); assert.equal(selected.cacheRoot, targetCache);
        const receipt = JSON.parse(await readFile(join(operations, selected.operationId, 'receipt.json'), 'utf8'));
        assert.equal(receipt.phase, 'verified'); assert.equal(receipt.disposition, 'complete');
        assert.equal(receipt.plan.from.dataRoot, dataRoot); assert.equal(receipt.plan.target.dataRoot, targetData);
        committed = true;
      }
      const hasOperations = await lstat(operations).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (hasOperations) {
        const entries = await readdir(operations), id = JSON.parse(await readFile(join(operations, 'current.json'), 'utf8'));
        const receipt = JSON.parse(await readFile(join(operations, id, 'receipt.json'), 'utf8'));
        assert.equal(receipt.plan.from.dataRoot, dataRoot); assert.equal(receipt.plan.target.dataRoot, targetData);
        assert.ok(receipt.disposition === 'complete' || receipt.disposition === 'deferred', 'Unknown original operation must remain for reconciliation');
        assert.deepEqual(entries.sort(), [id, 'current.json'].sort(), 'Concurrent operation must be preserved');
        await rename(operations, operationArchive);
      }
      await rename(location, selectionArchive);
      selectionWritten = false;
    });
    if (browserSaved) {
      const marker = JSON.parse(await readFile(join(originalDesktop, 'kcoder-source-e2e-owner.json'), 'utf8'));
      assert.equal(marker.owner, context.seed);
      await rm(originalDesktop, { recursive: true, maxRetries: 10, retryDelay: 100 });
      await rename(savedDesktop, originalDesktop); browserSaved = false;
    }
    assert.deepEqual(await snapshot(personalRoot), personalBefore, 'Personal settings/credentials/environment changed');
    await writeFile(restorationArtifact, JSON.stringify({ personalConfigurationUnchanged: true,
      locatorAbsentAgain: true, operationsAbsentAgain: true, copiedBrowserRestored: true, sourceOnly: true }), { flag: 'wx', mode: 0o600 });
    personalRestored = true;
    if (committed && !fullyAccepted) throw Error('Personal state restored; verified test destination retained for original-operation readback');
  }, { timeoutMs: 30_000 });
  // Preserve the copied original browser. A fresh browser prevents unsent personal
  // queues from replaying; the actual Native configuration/history stays intact.
  await rename(originalDesktop, savedDesktop); browserSaved = true;
  await mkdir(originalDesktop); await writeFile(join(originalDesktop, 'kcoder-source-e2e-owner.json'), JSON.stringify({ owner: context.seed }), { flag: 'wx' });
  await withControl(async () => { await writeFile(location, initialBytes, { flag: 'wx', mode: 0o600 }); selectionWritten = true; });
  await context.writeStateJson('.owner.json', { owner: fixture.owner, sid: account.sid, fixtureRoot, scope: 'storage-source-migration',
    runOwner: context.seed, targetData, targetCache });
  const temporary = context.pathInState('tmp'); await mkdir(temporary);
  const resultFile = context.pathInState('worker-result.json');
  const input = await context.writeStateJson('worker-input.json', { owner: context.seed, root: context.stateDir,
    home: account.userProfile, electron, cli, studio: appRoot, sessionId: caller.sessionId,
    handoff: context.pathInState('original-handoff.json'),
    targetData, targetCache, progress: progressFile, result: resultFile,
    previewImage: context.pathInArtifacts('migration-preview.png'), failureImage: context.pathInArtifacts('failure.png'),
    operationReceipt: context.pathInArtifacts('verified-operation.json') });
  const workspace = process.env.KCODER_E2E_STORAGE_COPY_PROJECT; assert.ok(workspace && isAbsolute(workspace));
  const child = context.spawnOwned('source-storage-flow', process.execPath,
    [join(appRoot, 'e2e/harness/windows-source-storage-worker.mjs'), input], {
      cwd: appRoot, env: context.isolatedEnvironment({ HOME: account.userProfile, USERPROFILE: account.userProfile,
        APPDATA: account.appData, LOCALAPPDATA: account.localAppData,
        TEMP: temporary, TMP: temporary, TMPDIR: temporary, ELECTRON_RUN_AS_NODE: '',
        KCODER_TRAINING_MODE: 'true', KCODER_TRAINING_UPLOAD_URL: 'disabled-for-test', KCODER_INCLUDE_BUNDLED_PROFILES: '0',
        KCODER_STUDIO_KCODER_BIN: cli, KCODER_STUDIO_WORKSPACE: workspace, KCODER_STUDIO_RENDERER_MODE: 'static',
        KCODER_STUDIO_SERVERS: JSON.stringify([{ id: 'local', transport: 'local', command: cli, label: 'Owned Debug', cwd: workspace }]),
      }),
    });
  try {
    // A failed worker can leave the automatically restarted desktop in the Job.
    // Read its explicit result before waiting for that entire Job's stdio EOF.
    const result = await waitFor(async () => {
      try { return JSON.parse(await readFile(resultFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      try { const value = JSON.parse(await readFile(progressFile, 'utf8')); if (value.error) throw Error(`Source storage ${value.stage}: ${value.error}`); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      return false;
    }, 360_000, 'actual source storage result', 100, context.abortSignal);
    // Automatic restart is intentionally still running in this Job. Dispose the
    // observed host before cold read; natural product Quit is tested below.
    await context.stopOwned('source-storage-flow');
    assert.deepEqual(await snapshot(dataRoot), sourceBefore); assert.deepEqual(await snapshot(targetData), sourceBefore);
    assert.deepEqual(await readFile(join(targetData, '.profile-identity.json')), identityBefore);
    const marker = `storage-owned-${context.seed}`, draft = `STORAGE_UNSENT_DRAFT_${context.seed}`;
    context.registerSecret(marker); context.registerSecret(draft);
    const restored = await startSourceDesktop(context, { label: 'source-storage-cold', usePersonalStorageSelection: true,
      workspace, kcoderBin: cli, startTimeoutMs: 90_000,
      env: { KCODER_TRAINING_MODE: 'true', KCODER_TRAINING_UPLOAD_URL: 'disabled-for-test', KCODER_INCLUDE_BUNDLED_PROFILES: '0',
        KCODER_STUDIO_RENDERER_MODE: 'static', KCODER_STUDIO_SERVERS: JSON.stringify([{ id: 'local', transport: 'local', command: cli, label: 'Owned Debug', cwd: workspace }]) } });
    const page = restored.page; await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60_000 });
    assert.equal(new URL(page.url()).origin, result.origin);
    assert.equal(await page.evaluate(() => localStorage.getItem('kcoder-owned-storage-main')), marker);
    const partition = await page.context().newCDPSession(page);
    try { assert.equal((await partition.send('Network.getCookies', { urls: [result.origin] })).cookies
      .find(row => row.name === 'kcoder_owned_storage_main')?.value, marker); }
    finally { await partition.detach(); }
    const rpc = await rpcClient({ renderer: null, evaluate: (_client, expression) => page.evaluate(expression) });
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(hash(modelConfigurationSnapshot(await rpc('runtime.providers.list', {}))), result.providersSha256);
    const threads = (await rpc('thread/list', { limit: 20 })).threads;
    assert.ok(result.threadIds.every(id => threads.some(thread => thread.id === id)));
    const messages = (await rpc('thread/read', { threadId: result.transcriptThreadId, limit: 10 })).messages;
    assert.equal(hash(messages.map(({ id, role, content, timestampMs }) => ({ id, role, content, timestampMs }))), result.transcriptSha256);
    await page.evaluate(() => window.__kcoderOwnedStorageRpc.close());
    await page.goto(result.origin + result.draftUrl);
    await page.getByTestId('chat-message-input').waitFor({ timeout: 30_000 });
    await waitFor(() => page.getByTestId('chat-message-input').evaluate((node, value) => node.value === value, draft),
      15_000, 'restored unsent composer draft', 100, context.abortSignal);
    await page.goto(result.origin + '/settings/storage');
    assert.ok((await page.getByTestId('storage-location-path-dataRoot').innerText()).includes(targetData));
    await page.screenshot({ path: context.pathInArtifacts('cold-storage-restored.png') });
    const options = { cwd: workspace, timeout: 30_000, windowsHide: true,
      env: { ...process.env, KCODER_TRAINING_MODE: 'true', KCODER_INCLUDE_BUNDLED_PROFILES: '0' } };
    const previous = JSON.parse((await execute(cli, ['config', 'get', 'max_retries'], options)).stdout);
    assert.ok(Number.isInteger(previous)); const next = previous === 1 ? 2 : 1;
    await execute(cli, ['config', 'set', 'max_retries', String(next), '--scope', 'user'], options);
    // Project or explicit overlays may retain a different effective value.
    assert.equal(JSON.parse(await readFile(join(targetData, 'settings.json'), 'utf8')).max_retries, next);
    assert.notEqual((await snapshot(targetData))['settings.json'], sourceBefore['settings.json']);
    assert.deepEqual(await snapshot(dataRoot), sourceBefore);
    await invokeDesktopMenu(page, 'quit');
    assert.deepEqual(await waitForStdioChildClose(restored.child, 30_000, 'actual cold Desktop menu Quit'), { code: 0, signal: null });
    await restored.stop();
    const accepted = { ...result, browserStateColdReadStillRequired: false, cookieAndOriginRetained: true,
      actualUnsentDraftRetained: true, originalHistoryAndModelsRetained: true, actualNewRootConfigWrite: true, actualColdProductMenuQuit: true };
    await context.writeArtifactJson('main-flow-result.json', accepted); fullyAccepted = true; return accepted;
  } finally {
    await context.stopOwned('source-storage-flow');
    for (const name of (await readdir(context.stateDir)).filter(name => /^windows-storage-native-.*\.json$/.test(name))) {
      await context.writeArtifactJson(name, JSON.parse((await readFile(context.pathInState(name), 'utf8')).replace(/^\uFEFF/, '')));
    }
    try { await context.writeArtifactJson('last-flow-progress.json', JSON.parse(await readFile(progressFile, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
});
