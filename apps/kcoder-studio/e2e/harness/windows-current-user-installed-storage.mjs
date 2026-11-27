import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCdpClient } from './windows-cdp-document.cjs';
import { modelConfigurationSnapshot, rpcClient, observeWindowsStorageHandoff } from './windows-storage-relocation.mjs';

// One explicit current-user acceptance run. The outer owner preserves/restores
// the original selection and installation; no Provider or model request is made.
assert.equal(process.platform, 'win32');
const request = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
const sourceDebug = request.kind === 'source-debug';
const resumeAfterFirstMove = request.resumeAfterFirstMove === true;
const migrationTimeoutMs = sourceDebug ? 900000 : 300000;
const inputStarted = Date.now();
const fileHash = async path => {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(path)) value.update(chunk);
  return value.digest('hex');
};
const marker = JSON.parse(await readFile(join(request.root, '.owner.json'), 'utf8'));
assert.equal(marker.owner, request.owner);
assert.equal(marker.scope, sourceDebug ? 'current-user-debug-storage' : 'current-user-installed-storage');
assert.equal(marker.installDirectory, request.installDirectory);
assert.equal(marker.expectedHostSha256, request.expectedHostSha256);
assert.equal(process.env.KCODER_E2E_ALLOW_CURRENT_USER_STORAGE_MIGRATION, '1');
const execute = promisify(execFile), ps = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const identity = sourceDebug ? {
  hostPath: join(request.installDirectory, 'electron/electron.exe'),
  nativePath: join(request.sourceStudio, 'bin/kcoder.exe'),
  nativeSha256: await fileHash(join(request.sourceStudio, 'bin/kcoder.exe')),
} : await (await import('./installed-desktop-identity.mjs')).verifyInstalledDesktop(request.installDirectory, {
  manifestSha256: request.manifestSha256, hostSha256: request.expectedHostSha256,
  expectedCommit: request.expectedCommit,
});
assert.equal(identity.nativeSha256, request.expectedCliSha256);
if (sourceDebug) {
  assert.equal(await fileHash(identity.hostPath), request.expectedHostSha256);
  for (const file of request.sourceInputs) {
    assert.ok(!file.path.includes('..') && !file.path.startsWith('/') && !file.path.includes('\\'));
    assert.equal(await fileHash(join(request.sourceStudio, file.path)), file.sha256);
  }
} else assert.equal(JSON.parse(await readFile(join(request.installDirectory, 'resources/kcoder-release-manifest.json'), 'utf8')).versions.studio, request.expectedVersion);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, label, timeout = 120000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (/\bDESKTOP_(?:STORAGE|BROWSER_CACHE)_STARTUP_FAILED\b/.test(output)) throw Error('Actual desktop storage startup failed');
    const value = await predicate(); if (value) return value; await pause(100);
  }
  throw Error('Current-user installed storage deadline: ' + label);
};
const result = { owner: request.owner, version: request.expectedVersion, sourceCommit: request.expectedCommit,
  actualInstalledPackage: !sourceDebug, sourceOnly: sourceDebug, modelTurnsRequested: 0, observedTurnStarts: 0, phases: [] };
result.inputVerificationMs = Date.now() - inputStarted;
const record = async phase => { result.phases.push(phase); await writeFile(join(request.root, 'flow-progress.json'), JSON.stringify(result)); };
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^KCODER_|^ELECTRON_RUN_AS_NODE$/i.test(name)));
Object.assign(environment, { TEMP: join(request.root, 'tmp'), TMP: join(request.root, 'tmp'),
  KCODER_INCLUDE_BUNDLED_PROFILES: '0', KCODER_TRAINING_UPLOAD_URL: 'disabled-for-test',
  KCODER_STUDIO_WORKSPACE: request.workspace,
  KCODER_STUDIO_SERVERS: JSON.stringify([{ id: 'local', transport: 'local', command: identity.nativePath,
    label: sourceDebug ? 'Current-user Debug acceptance' : 'Current-user installed acceptance', cwd: request.workspace }]) });
if (sourceDebug) Object.assign(environment, { KCODER_STUDIO_KCODER_BIN: identity.nativePath,
  RUST_LIB_BACKTRACE: '1',
  KCODER_STUDIO_WEB_ROOT: request.rendererDirectory,
  KCODER_E2E_PROCESS_SUPERVISOR_BIN: join(request.sourceStudio, 'bin/kcoder-process-supervisor.exe') });
const applicationRoot = sourceDebug ? request.sourceStudio : join(request.installDirectory, 'resources/gateway');
let main, renderer, app, output = '', born, originalExit, eventPort;
const evaluate = async (client, expression) => {
  const value = await client.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.equal(value.exceptionDetails, undefined, 'Actual application evaluation failed'); return value.result?.value;
};
const native = async (id, title, action, folder, button) => {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(request.harnessDirectory, 'windows-storage-native-dialog.ps1'), '-OwnedRoot', request.root,
    '-ProcessId', String(app.pid), '-StartedFileTime', born, '-ExpectedTitle', title, '-Action', action, '-OperationId', id];
  if (folder) args.push('-Folder', folder); if (button) args.push('-ButtonText', button);
  const value = await execute(ps, args, { windowsHide: true, timeout: 45000, encoding: 'utf8' });
  return JSON.parse(value.stdout.replace(/^\uFEFF/, ''));
};
const quit = async () => {
  await evaluate(renderer, `(async()=>{for(const menu of await window.kcoderDesktopMenu.list('en')){const item=menu.entries?.find(row=>row.id==='quit');if(item){void window.kcoderDesktopMenu.invoke(menu.index,item.position);return true}}throw Error('Quit unavailable')})()`);
  // An attached Node inspector can keep Electron waiting for its debugger
  // after normal Quit. Detach our clients before observing the real exit.
  renderer.close(); main.close(); renderer = main = null;
  const exit = await Promise.race([originalExit, pause(30000).then(() => { throw Error('Actual Quit unconfirmed'); })]);
  assert.deepEqual(exit, { code: 0, signal: null });
  result.coldExit = exit;
};
const attach = async port => {
  const target = await until(async () => {
    try {
      const values = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return values.find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
    } catch { return null; }
  }, 'committed application page', 300000);
  renderer = createCdpClient(target.webSocketDebuggerUrl, { onEvent: message => {
    if (message.method !== 'Network.webSocketFrameSent') return;
    try { if (JSON.parse(message.params.response.payloadData).method === 'turn/start') result.observedTurnStarts++; } catch {}
  } }); await renderer.ready; await renderer.request('Network.enable');
  await until(() => evaluate(renderer, 'Boolean(document.querySelector(\'[data-testid="desktop-sidebar"]\'))'), 'application sidebar');
};
const launch = async () => {
  output = '';
  app = spawn(identity.hostPath, ['--disable-gpu', '--inspect=127.0.0.1:0', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    ...(sourceDebug ? [join(request.sourceStudio, 'desktop/main.mjs')] : [])],
    { cwd: sourceDebug ? request.sourceStudio : request.installDirectory, env: environment, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  originalExit = new Promise((resolve, reject) => { app.once('exit', (code, signal) => resolve({ code, signal })); app.once('error', reject); });
  for (const stream of [app.stdout, app.stderr]) stream.on('data', data => { output = (output + data).slice(-32768); });
  const birth = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${app.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  born = birth.stdout.trim(); assert.match(born, /^\d+$/);
  await writeFile(join(request.root, 'owned-host.json'), JSON.stringify({ pid: app.pid, birth: born, executable: identity.hostPath, owner: request.owner }));
  const inspector = await until(() => {
    if (app.exitCode !== null) throw Error('Installed host exited before CDP');
    return output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\S+)/)?.[1];
  }, 'original inspector');
  main = createCdpClient(inspector); await main.ready;
  const debuggerUrl = new URL(await until(() => output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\S+)/)?.[1], 'browser CDP'));
  eventPort = Number(debuggerUrl.port); await attach(eventPort);
  assert.equal(await evaluate(main, "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron').app.getPath('userData')"), join(request.currentData, 'studio/desktop'));
};
let accepted = false;
try {
  await record('verified-installed-inputs');
  if (request.verifyCompletedOperationId) {
    // Continue read-only acceptance after an already settled handoff. Never
    // execute, retry or replace its operation to recover a test-driver failure.
    const selection = JSON.parse(await readFile(join(process.env.USERPROFILE, '.config/kcoder-storage.json'), 'utf8'));
    assert.equal(selection.operationId, request.verifyCompletedOperationId);
    assert.equal(selection.dataRoot, request.targetData);
    const receipt = JSON.parse(await readFile(join(process.env.USERPROFILE, '.config/kcoder-storage-migrations', selection.operationId, 'receipt.json'), 'utf8'));
    assert.equal(receipt.phase, 'verified'); assert.equal(receipt.disposition, 'complete');
    assert.equal(receipt.plan.from.dataRoot, request.currentData);
    assert.equal(receipt.plan.target.dataRoot, request.targetData);
    for (const file of request.fixedRootFiles) assert.equal(await fileHash(join(request.targetData, file.path)), file.sha256);
    assert.ok(request.identityFiles?.length > 0, 'Original Native identity evidence is required');
    for (const file of request.identityFiles) assert.equal(await fileHash(join(request.targetData, file.path)), file.sha256);
    request.currentData = request.targetData;
    await launch(); await record('completed-move-cold-desktop-ready');
    const rpc = await rpcClient({ renderer, evaluate });
    const models = modelConfigurationSnapshot(await rpc('runtime.providers.list', {}));
    const threads = (await rpc('thread/list', { limit: 20 })).threads;
    assert.equal(models.length, request.expectedModelCount);
    assert.equal(threads.length, request.expectedHistoryCount);
    let messages;
    for (const thread of threads) { const rows = (await rpc('thread/read', { threadId: thread.id, limit: 10 })).messages; if (rows.length) { messages = rows; break; } }
    assert.equal(messages?.length, request.expectedTranscriptMessages);
    const origin = await evaluate(renderer, 'location.origin');
    const cookies = (await renderer.request('Network.getCookies', { urls: [origin] })).cookies;
    assert.equal(cookies.find(cookie => cookie.name === 'kcoder_owned_storage_main')?.value, request.owner);
    assert.equal(await evaluate(renderer, "localStorage.getItem('kcoder-owned-storage-main')"), request.owner);
    const draft = `STORAGE_UNSENT_DRAFT_${request.owner}`;
    assert.ok(await evaluate(renderer, `Object.keys(localStorage).some(key=>key.startsWith('kcoder.composer-drafts.v1:')&&JSON.parse(localStorage.getItem(key)||'null')?.content===${JSON.stringify(draft)})`));
    await evaluate(renderer, `(async()=>{for(const menu of await window.kcoderDesktopMenu.list('en')){const item=menu.entries?.find(row=>row.id==='newChat');if(item){await window.kcoderDesktopMenu.invoke(menu.index,item.position);return true}}throw Error('Actual new-chat menu unavailable')})()`);
    await until(() => evaluate(renderer, `document.querySelector('[data-testid="chat-message-input"]')?.textContent===${JSON.stringify(draft)}`), 'moved draft restored by the actual composer');
    await record('completed-move-config-history-cookie-draft-read');
    await writeFile(join(request.root, 'cold-restored.png'), Buffer.from((await renderer.request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await quit();
    await until(async () => (await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', `@((Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith('${request.installDirectory.replaceAll("'", "''")}\\',[StringComparison]::OrdinalIgnoreCase)})).Count`], { windowsHide: true, encoding: 'utf8', timeout: 10000 })).stdout.trim() === '0', 'completed move cold instance exit');
    assert.equal(result.observedTurnStarts, 0);
    Object.assign(result, { verificationOnly: true, operationId: selection.operationId, configurationBytesRetained: true, originalNativeIdentityBytesRetained: true,
      configuredModelCount: models.length, originalHistoryCount: threads.length, transcriptMessages: messages.length,
      cookieRetained: true, localStorageRetained: true, actualDraftRetained: true, actualColdQuit: true, passed: true });
    await record('completed-move-read-only-acceptance-passed'); accepted = true;
  } else {
  const location = join(process.env.USERPROFILE, '.config/kcoder-storage.json');
  const originalSelection = await readFile(location);
  if (resumeAfterFirstMove) {
    const selected = JSON.parse(originalSelection);
    assert.equal(selected.dataRoot, request.currentData);
    assert.equal(selected.cacheRoot, request.currentCache);
    assert.equal(selected.operationId, request.owner);
  } else assert.equal(hash(originalSelection), request.originalSelectionSha256);
  const { createStorageOperationClient } = await import(pathToFileURL(join(applicationRoot, 'src/storage-operation-client.mjs')));
  const moveEnv = { ...environment, KCODER_STORAGE_CONTEXT_V1: JSON.stringify({ version: 1,
    home: process.env.USERPROFILE, platformConfig: process.env.APPDATA, overrides: {},
    record: JSON.parse(originalSelection), consumer: 'desktop', development: false }) };
  const operationClient = createStorageOperationClient({ program: identity.nativePath, env: moveEnv,
    cwd: request.root, ownerRuntime: { program: identity.hostPath,
      applicationRoot, runAsNode: true } });
  const runNative = (mode, input) => new Promise((resolve, reject) => {
    const started = Date.now();
    const child = execFile(identity.nativePath, ['--internal-storage-operation-v1', mode,
      ...(['resume', 'retry'].includes(mode) ? [request.owner] : [])], {
      cwd: request.root, windowsHide: true, timeout: mode === 'plan' ? 15000 : migrationTimeoutMs, maxBuffer: 1024 * 1024,
      env: { ...moveEnv, KCODER_STORAGE_OWNER_RUNTIME_V1: JSON.stringify({ program: identity.hostPath,
        applicationRoot, runAsNode: true }) },
    }, async (error, stdout, stderr) => {
      try {
        await writeFile(join(request.root, `native-${mode}.stdout.json`), stdout, { flag: 'wx' });
        await writeFile(join(request.root, `native-${mode}.stderr.log`), stderr, { flag: 'wx' });
        await writeFile(join(request.root, `native-${mode}.process.json`), JSON.stringify({ exitCode: error?.code ?? 0,
          signal: error?.signal ?? null, killed: error?.killed ?? false, elapsedMs: Date.now() - started }));
        if (error) reject(Error(`Native ${mode} failed: ${[...new Set(stderr.match(/\b[A-Z][A-Z_]{5,}\b/g) ?? [])].join(',') || 'unclassified'}`));
        else resolve(JSON.parse(stdout));
      } catch (failure) { reject(failure); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input));
  });
  if (resumeAfterFirstMove) {
    await record('continuing-verified-first-move-without-replay');
  } else if (request.retryFirstOperation === true) {
    const failed = await operationClient.status(request.owner);
    assert.equal(failed.plan.operationId, request.owner);
    assert.equal(failed.plan.from.dataRoot, request.originalData);
    assert.equal(failed.plan.target.dataRoot, request.currentData);
    assert.ok(failed.errorCode, 'Unknown operation results must be reconciled before retry');
    await record('retry-original-failed-operation');
    await runNative(failed.disposition === 'active' ? 'resume' : 'retry', null);
  } else {
    const plan = await runNative('plan', { operationId: request.owner, dataRoot: request.currentData,
      cacheRoot: request.currentCache, launchIntent: 'verifyOnly' });
    assert.equal(plan.operationId, request.owner); assert.equal(plan.from.dataRoot, request.originalData);
    await writeFile(join(request.root, 'first-plan.json'), JSON.stringify(plan));
    await record('first-offline-move-started');
    await runNative('execute', plan);
  }
  const firstReceipt = await operationClient.status(request.owner);
  assert.equal(firstReceipt.phase, 'verified'); assert.equal(firstReceipt.disposition, 'complete');
  await writeFile(join(request.root, 'first-verified-operation.json'), JSON.stringify(firstReceipt));
  result.firstOperationId = request.owner;
  for (const file of request.fixedRootFiles ?? []) {
    assert.ok(['settings.json', 'credentials.json', '.env'].includes(file.path));
    assert.equal(hash(await readFile(join(request.currentData, file.path))), file.sha256);
  }
  result.originalConfigurationBytesRetained = (request.fixedRootFiles?.length ?? 0) > 0;
  // Keep the copied personal browser intact outside the second move. A fresh
  // owned browser cannot dispatch the person's existing unsent frontend queue.
  if (resumeAfterFirstMove) {
    assert.ok((await lstat(join(request.root, 'personal-browser-preserved'))).isDirectory());
    assert.ok((await lstat(join(request.currentData, 'studio/desktop'))).isDirectory());
  } else {
    await rename(join(request.currentData, 'studio/desktop'), join(request.root, 'personal-browser-preserved'));
    await mkdir(join(request.currentData, 'studio/desktop'));
  }
  await launch(); await record('initial-desktop-ready');
  let rpc = await rpcClient({ renderer, evaluate });
  const models = modelConfigurationSnapshot(await rpc('runtime.providers.list', {})); assert.ok(models.length > 0);
  const threads = (await rpc('thread/list', { limit: 20 })).threads; assert.ok(threads.length > 0, 'Original project history must be readable');
  let messages, historyThreadId;
  for (const thread of threads) {
    const restored = (await rpc('thread/read', { threadId: thread.id, limit: 10 })).messages;
    if (restored.length) { messages = restored; historyThreadId = thread.id; break; }
  }
  assert.ok(messages?.length > 0, 'An existing nonempty transcript must remain readable');
  const transcript = rows => hash(rows.map(({ id, role, content, timestampMs }) => ({ id, role, content, timestampMs })));
  const expected = { providers: hash(models), transcript: transcript(messages), threadId: historyThreadId };
  result.configuredModelCount = models.length; result.originalHistoryCount = threads.length; result.transcriptMessages = messages.length;
  await record('models-and-original-history-read');
  const origin = await evaluate(renderer, 'location.origin'), draft = `STORAGE_UNSENT_DRAFT_${request.owner}`;
  await evaluate(renderer, `localStorage.setItem('kcoder-owned-storage-main',${JSON.stringify(request.owner)});true`);
  assert.equal((await renderer.request('Network.setCookie', { name: 'kcoder_owned_storage_main', value: request.owner,
    url: origin, httpOnly: true, expires: Math.floor(Date.now() / 1000) + 3600 })).success, true);
  const click = selector => until(() => evaluate(renderer, `(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)return false;node.click();return true})()`), `ready application control ${selector}`);
  await evaluate(renderer, `(async()=>{for(const menu of await window.kcoderDesktopMenu.list('en')){const item=menu.entries?.find(row=>row.id==='newChat');if(item){await window.kcoderDesktopMenu.invoke(menu.index,item.position);return true}}throw Error('Actual new-chat menu unavailable')})()`);
  await until(() => evaluate(renderer, 'Boolean(document.querySelector(\'[data-testid="chat-message-input"]\'))'), 'actual new conversation');
  await evaluate(renderer, 'document.querySelector(\'[data-testid="chat-message-input"]\').focus();true');
  await renderer.request('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await renderer.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await renderer.request('Input.insertText', { text: draft });
  await until(() => evaluate(renderer, `Object.keys(localStorage).some(key=>key.startsWith('kcoder.composer-drafts.v1:')&&JSON.parse(localStorage.getItem(key)||'null')?.content===${JSON.stringify(draft)})`), 'persisted actual draft');
  await record('actual-draft-persisted');
  const draftUrl = await evaluate(renderer, 'location.href');
  await writeFile(join(request.root, 'desktop-before-handoff.json'), JSON.stringify({ owner: request.owner,
    expected, origin, draftUrl, configuredModelCount: models.length, originalHistoryCount: threads.length,
    transcriptMessages: messages.length }));
  await renderer.request('Page.reload');
  await until(() => evaluate(renderer, `(()=>{const input=document.querySelector('[data-testid="chat-message-input"]');return(input?.value??input?.textContent)===${JSON.stringify(draft)}})()`), 'draft after ordinary reload');
  await record('actual-draft-reloaded');
  await evaluate(renderer, `window.__kcoderOwnedStorageRpc?.close();location.href=${JSON.stringify(origin + '/settings/storage')};true`);
  await until(() => evaluate(renderer, 'Boolean(document.querySelector(\'[data-testid="storage-locations-panel"]\'))'), 'actual storage settings');
  await observeWindowsStorageHandoff({ main, evaluate, powershell: ps, identity }, join(request.root, 'original-handoff.json'));
  await evaluate(main, `(()=>{const {dialog}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');const open=dialog.showOpenDialog,confirm=dialog.showMessageBox;dialog.showOpenDialog=(window,options)=>open.call(dialog,window,{...options,title:'KCoder storage relocation picker'});dialog.showMessageBox=(window,options)=>confirm.call(dialog,window,{...options,title:'KCoder storage relocation confirm'});return true})()`);
  for (const [kind, path] of [['data', request.targetData], ['cache', request.targetCache]]) {
    await click(`[data-testid="storage-location-pick-${kind}"]`);
    await native(`pick-${kind}`, 'KCoder storage relocation picker', 'folder', path);
  }
  await click('[data-testid="storage-location-preview"]');
  await until(() => evaluate(renderer, 'Boolean(document.querySelector(\'[data-testid="storage-location-plan"]\'))'), 'migration preview');
  await writeFile(join(request.root, 'migration-preview.png'), Buffer.from((await renderer.request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const writerObservation = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `$rows=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith('${request.installDirectory.replaceAll("'", "''")}\\',[StringComparison]::OrdinalIgnoreCase)}|ForEach-Object{$p=Get-Process -Id $_.ProcessId;@{pid=$p.Id;birth=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}});ConvertTo-Json -InputObject $rows -Compress`],
  { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  result.originalWriters = JSON.parse(writerObservation.stdout);
  assert.ok(result.originalWriters.some(row => row.pid === app.pid));
  await click('[data-testid="storage-location-stop-migrate"]'); await click('[data-testid="storage-location-confirm-submit"]');
  await native('confirm-move', 'KCoder storage relocation confirm', 'button', null, 'Stop and migrate|停止并迁移');
  renderer.close(); main.close(); renderer = main = null;
  const control = join(process.env.USERPROFILE, '.config/kcoder-storage-migrations');
  const id = await until(async () => {
    try {
      const candidate = JSON.parse(await readFile(join(control, 'current.json'), 'utf8'));
      if (candidate === request.owner) return null;
      const receipt = JSON.parse(await readFile(join(control, candidate, 'receipt.json'), 'utf8'));
      assert.equal(receipt.plan.from.dataRoot, request.currentData);
      assert.equal(receipt.plan.target.dataRoot, request.targetData);
      return candidate;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, 'new operation belonging to the confirmed preview');
  result.operationId = id; await record('original-operation-started');
  assert.deepEqual(await Promise.race([originalExit, pause(45000).then(() => { throw Error('Original host exit unconfirmed'); })]), { code: 0, signal: null });
  await until(() => {
    return result.originalWriters.every(row => { try { process.kill(row.pid, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; } });
  }, 'all original desktop/Gateway/backend processes exited', 45000);
  result.originalWritersGone = true;
  const receipt = await until(async () => {
    const value = JSON.parse(await readFile(join(control, id, 'receipt.json'), 'utf8'));
    if (value.errorCode || value.disposition === 'deferred') throw Error('Migration failed: ' + (value.errorCode ?? value.disposition));
    return value.phase === 'verified' && value.disposition === 'complete' ? value : null;
  }, 'original verified receipt', migrationTimeoutMs);
  assert.equal(receipt.plan.from.dataRoot, request.currentData); assert.equal(receipt.plan.target.dataRoot, request.targetData);
  await writeFile(join(request.root, 'verified-operation.json'), JSON.stringify(receipt));
  await record('migration-verified');
  const handoff = JSON.parse(await readFile(join(request.root, 'original-handoff.json'), 'utf8'));
  // Packaged relaunch intentionally drops diagnostic switches. Observe its real
  // window, then stop that exact birth for a separately launched cold read.
  const program = identity.hostPath.replaceAll("'", "''");
  const restarted = await until(async () => {
    const value = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', `$rows=@(Get-CimInstance Win32_Process -Filter "Name='${sourceDebug ? 'electron.exe' : 'kcoder-studio.exe'}'"|Where-Object{$_.ExecutablePath -ieq '${program}' -and $_.ProcessId -ne ${app.pid}}|ForEach-Object{$p=Get-Process -Id $_.ProcessId;if($p.MainWindowHandle -ne 0){@{pid=$p.Id;birth=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();session=$p.SessionId}}});ConvertTo-Json -InputObject $rows -Compress`], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    const rows = JSON.parse(value.stdout); assert.ok(rows.length <= 1, 'Ambiguous restarted host');
    return rows[0];
  }, 'actual automatically restarted window');
  assert.equal(restarted.session, request.sessionId);
  const stopped = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${restarted.pid};$held=$p.Handle;if($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne '${restarted.birth}' -or $p.Path -ine '${program}'){throw 'Restart owner changed'};$shot=Get-Process -Id ${handoff.pid} -ErrorAction SilentlyContinue;if($shot -and $shot.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq '${handoff.creationFileTime}'){throw 'Original executor still alive'};& taskkill.exe /PID ${restarted.pid} /T /F|Out-Null;if($LASTEXITCODE -ne 0){throw 'Restarted test host stop unconfirmed'};@{pid=${restarted.pid};birth='${restarted.birth}';oneShotExitedBeforeCleanup=$true;stop='exact-owned-tree-for-cold-read'}|ConvertTo-Json -Compress`], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  result.restartObservation = JSON.parse(stopped.stdout);
  const quiescent = async () => {
    const value = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', `@((Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith('${request.installDirectory.replaceAll("'", "''")}\\',[StringComparison]::OrdinalIgnoreCase)})).Count`], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    return value.stdout.trim() === '0';
  };
  await until(quiescent, 'restarted instance normal exit');
  assert.equal(handoff.parentPid, app.pid); result.originalHostExited = true; result.automaticRestartObserved = true;
  request.currentData = request.targetData;
  await launch(); await record('cold-desktop-ready');
  rpc = await rpcClient({ renderer, evaluate });
  assert.equal(hash(modelConfigurationSnapshot(await rpc('runtime.providers.list', {}))), expected.providers);
  assert.equal(transcript((await rpc('thread/read', { threadId: expected.threadId, limit: 10 })).messages), expected.transcript);
  assert.equal(await evaluate(renderer, 'location.origin'), origin);
  assert.equal(await evaluate(renderer, "localStorage.getItem('kcoder-owned-storage-main')"), request.owner);
  assert.equal((await renderer.request('Network.getCookies', { urls: [origin] })).cookies.find(row => row.name === 'kcoder_owned_storage_main')?.value, request.owner);
  await evaluate(renderer, `window.__kcoderOwnedStorageRpc.close();location.href=${JSON.stringify(draftUrl)};true`);
  await until(() => evaluate(renderer, `(()=>{const input=document.querySelector('[data-testid="chat-message-input"]');return(input?.value??input?.textContent)===${JSON.stringify(draft)}})()`), 'actual unsent draft cold read');
  await writeFile(join(request.root, 'cold-restored.png'), Buffer.from((await renderer.request('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await quit(); await until(quiescent, 'cold instance complete normal exit');
  assert.equal(result.observedTurnStarts, 0);
  Object.assign(result, { modelsRetained: true, originalHistoryRetained: true, cookieRetained: true,
    localStorageRetained: true, actualDraftRetained: true, actualColdQuit: true, phase: 'verified', disposition: 'complete', passed: true });
  await record('accepted'); accepted = true;
  }
} catch (error) {
  result.passed = false; result.error = String(error.message);
  if (app && born && /\bDESKTOP_(?:STORAGE|BROWSER_CACHE)_STARTUP_FAILED\b/.test(output)) {
    result.nativeStartupError = await native('startup-diagnostic', 'KCoder Studio', 'observe').catch(() => null);
  }
  if (renderer) await renderer.request('Page.captureScreenshot', { format: 'png' }).then(value => writeFile(join(request.root, 'failure.png'), Buffer.from(value.data, 'base64'))).catch(() => {});
} finally {
  renderer?.close(); main?.close();
  // Do not turn a failed/unknown migration into a replay or overwrite. The outer
  // owner reconciles the original receipt before exact PID/birth cleanup.
  app?.stdout?.destroy(); app?.stderr?.destroy(); app?.unref();
  await writeFile(join(request.root, 'flow-result.json'), JSON.stringify(result, null, 2));
}
process.exit(accepted ? 0 : 1);
