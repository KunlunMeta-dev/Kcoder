import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '../../renderer/node_modules/@playwright/test/index.mjs';
import { createCdpClient } from './windows-cdp-document.cjs';
import { rpcClient, modelConfigurationSnapshot, observeWindowsStorageHandoff } from './windows-storage-relocation.mjs';

// The enclosing RunContext owns this worker's Job until migration and restart end.
// Product Electron is a child, so its normal exit cannot close the test owner's Job.
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const execute = promisify(execFile), environment = process.env;
const powershell = join(environment.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
let lastProgress = {};
const progress = value => { lastProgress = { ...lastProgress, ...value }; return writeFile(input.progress, JSON.stringify(lastProgress), { mode: 0o600 }); };
const until = async (read, label, timeout = 90_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Windows source storage timeout: ${label}`);
};
const ps = async script => (await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64')], { env: environment, windowsHide: true, timeout: 15_000, encoding: 'utf8' })).stdout;
const literal = value => "'" + value.replaceAll("'", "''") + "'";
let output = '', browser, inspector, page, stage = 'start', operationId;
const app = spawn(input.electron, ['--disable-gpu', '--inspect=127.0.0.1:0', '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0', join(input.studio, 'desktop/main.mjs')], {
  cwd: input.studio, env: environment, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [app.stdout, app.stderr]) stream.on('data', bytes => {
  output = (output + bytes).slice(-32_768); process.stderr.write(bytes);
});
// Process exit is distinct from stdio close: a detached descendant may retain a
// pipe while the original kernel process has already exited.
const exited = new Promise((resolve, reject) => { app.once('error', reject); app.once('exit', (code, signal) => resolve({ code, signal })); });
const evaluate = async (client, expression) => {
  const value = await client.request('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.equal(value.exceptionDetails, undefined); return value.result?.value;
};
try {
  await progress({ stage, appPid: app.pid });
  const endpoint = await until(() => {
    if (app.exitCode !== null || output.includes('Error: KCoder Studio gateway exited before startup')) throw Error('Source desktop startup failed');
    return output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\S+)/)?.[1];
  }, 'CDP');
  browser = await chromium.connectOverCDP(endpoint);
  page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1:')), 'desktop page');
  await page.getByTestId('desktop-sidebar').waitFor({ timeout: 60_000 });
  const mainEndpoint = output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\S+)/)?.[1];
  assert.ok(mainEndpoint); inspector = createCdpClient(mainEndpoint); await inspector.ready;
  await observeWindowsStorageHandoff({ main: inspector, evaluate, powershell, identity: { nativePath: input.cli } }, input.handoff);
  const born = (await ps(`(Get-Process -Id ${app.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`)).trim();
  const actor = JSON.parse(await ps(`$p=Get-Process -Id ${app.pid};Add-Type -Path ${literal(join(input.studio, 'e2e/harness/windows-native-stream.cs'))};@{pid=$p.Id;window=$p.MainWindowHandle.ToInt64().ToString();sessionId=$p.SessionId;inJob=[KcoderOwnedNativeStreams]::InheritedJob($p.Handle)}|ConvertTo-Json -Compress`));
  assert.ok(actor.window !== '0'); assert.equal(actor.sessionId, input.sessionId); assert.equal(actor.inJob, true);
  const rpc = await rpcClient({ renderer: null, evaluate: (_client, expression) => page.evaluate(expression) });
  const models = modelConfigurationSnapshot(await rpc('runtime.providers.list', {}));
  assert.ok(models.length > 0);
  const history = await rpc('thread/list', { limit: 20 }); assert.ok(history.threads.length > 0);
  const transcript = await rpc('thread/read', { threadId: history.threads[0].id, limit: 10 }); assert.ok(transcript.messages.length > 0);
  const origin = new URL(page.url()).origin, marker = `storage-owned-${input.owner}`;
  await page.evaluate(value => localStorage.setItem('kcoder-owned-storage-main', value), marker);
  const partition = await page.context().newCDPSession(page);
  try {
    assert.equal((await partition.send('Network.setCookie', { name: 'kcoder_owned_storage_main', value: marker,
      url: origin, httpOnly: true, expires: Math.floor(Date.now() / 1000) + 3600 })).success, true);
  } finally { await partition.detach(); }
  // Start a draft in the original project through its real sidebar action.
  await page.getByTestId('project-item-button').first().hover();
  await page.getByTestId('project-new-conversation-button').first().click();
  await page.getByTestId('empty-project-title-button').waitFor({ timeout: 30_000 });
  const draft = `STORAGE_UNSENT_DRAFT_${input.owner}`;
  await page.getByTestId('chat-message-input').waitFor({ timeout: 30_000 });
  await page.getByTestId('chat-message-input').fill(draft);
  await until(() => page.evaluate(value => Object.keys(localStorage).some(key => key.startsWith('kcoder.composer-drafts.v1:')
    && JSON.parse(localStorage.getItem(key) || 'null')?.content === value), draft), 'actual persisted composer draft', 15_000);
  const draftUrl = new URL(page.url()).pathname + new URL(page.url()).search;
  // Validate the real editor's serialized-value contract before an expensive copy.
  await page.reload();
  await page.getByTestId('chat-message-input').waitFor({ timeout: 30_000 });
  await until(() => page.getByTestId('chat-message-input').evaluate((node, value) => node.value === value, draft),
    'source draft after ordinary reload', 15_000);
  await page.goto(origin + '/settings/storage');
  await page.getByTestId('storage-locations-panel').waitFor({ timeout: 60_000 });
  assert.equal(await page.getByTestId('storage-locations-readonly').count(), 0);
  await evaluate(inspector, `(()=>{const {dialog}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');const open=dialog.showOpenDialog,confirm=dialog.showMessageBox;dialog.showOpenDialog=(window,options)=>open.call(dialog,window,{...options,title:'KCoder storage relocation picker'});dialog.showMessageBox=(window,options)=>confirm.call(dialog,window,{...options,title:'KCoder storage relocation confirm'});return true})()`);
  const native = async (id, title, action, button, folder, host = { pid: app.pid, creationFileTime: born }) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(input.studio, 'e2e/harness/windows-storage-native-dialog.ps1'),
      '-OwnedRoot', input.root, '-ProcessId', String(host.pid), '-StartedFileTime', host.creationFileTime, '-ExpectedTitle', title,
      '-Action', action, '-OperationId', id];
    if (button) args.push('-ButtonText', button); if (folder) args.push('-Folder', folder);
    return JSON.parse((await execute(powershell, args, { env: environment, windowsHide: true, timeout: 40_000, encoding: 'utf8' })).stdout);
  };
  stage = 'pick'; await progress({ stage, appPid: app.pid, actor });
  for (const [kind, folder] of [['data', input.targetData], ['cache', input.targetCache]]) {
    await page.getByTestId(`storage-location-pick-${kind}`).click();
    await native(`source-${kind}`, 'KCoder storage relocation picker', 'folder', undefined, folder);
  }
  stage = 'preview'; await progress({ stage, appPid: app.pid });
  await page.getByTestId('storage-location-preview').click();
  await page.getByTestId('storage-location-plan').waitFor({ timeout: 60_000 });
  await page.screenshot({ path: input.previewImage });
  await page.getByTestId('storage-location-stop-migrate').click();
  await page.getByTestId('storage-location-confirm-submit').click();
  stage = 'confirm'; await progress({ stage, appPid: app.pid });
  await page.evaluate(() => window.__kcoderOwnedStorageRpc?.close());
  await browser.close(); browser = null;
  inspector.close(); inspector = null;
  await native('source-confirm', 'KCoder storage relocation confirm', 'button', 'Stop and migrate|停止并迁移');
  const control = join(input.home, '.config/kcoder-storage-migrations');
  operationId = await until(async () => {
    try { return JSON.parse(await readFile(join(control, 'current.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!page.isClosed() && await page.getByTestId('storage-location-action-error').count()) throw Error('Source migrate action rejected; original UI failure retained');
  }, 'original operation', 20_000);
  stage = 'handoff'; await progress({ stage, appPid: app.pid, born, operationId });
  const handoff = JSON.parse(await readFile(input.handoff, 'utf8'));
  assert.equal(handoff.parentPid, app.pid); assert.equal(handoff.detached, true);
  const exit = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Original source desktop did not exit')), 45_000); timer.unref(); })]);
  assert.deepEqual(exit, { code: 0, signal: null });
  const receipt = await until(async () => {
    const value = JSON.parse(await readFile(join(control, operationId, 'receipt.json'), 'utf8'));
    if (value.errorCode || value.disposition === 'deferred') throw Error(`Original source migration failed: ${value.errorCode ?? value.disposition}`);
    return value.phase === 'verified' && value.disposition === 'complete' ? value : null;
  }, 'one-shot verified receipt', 180_000);
  assert.equal(receipt.plan.operationId, operationId); assert.equal(receipt.plan.target.dataRoot, input.targetData);
  await writeFile(input.operationReceipt, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  stage = 'restarted'; await progress({ stage, appPid: app.pid, operationId });
  const restarted = await until(async () => {
    const text = await ps(`$rows=@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'"|Where-Object{$_.ExecutablePath -ieq ${literal(input.electron)} -and $_.ProcessId -ne ${app.pid}}|ForEach-Object{$p=Get-Process -Id $_.ProcessId;if($p.MainWindowHandle -ne 0){@{pid=$p.Id;creationFileTime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}}});$rows|ConvertTo-Json -Compress`);
    if (!text.trim()) return null; const value = JSON.parse(text), rows = Array.isArray(value) ? value : [value]; assert.equal(rows.length, 1); return rows[0];
  }, 'automatic restarted native window');
  const oneShot = await ps(`$p=Get-Process -Id ${handoff.pid} -ErrorAction SilentlyContinue;if($p -and $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ceq '${handoff.creationFileTime}'){'alive'}else{'gone'}`);
  assert.equal(oneShot.trim(), 'gone', 'The original one-shot must exit without test cleanup');
  await progress({ stage, appPid: app.pid, operationId, restarted, handoff, oneShotExitedBeforeCleanup: true });
  app.stdout.destroy(); app.stderr.destroy();
  await writeFile(input.result, JSON.stringify({ operationId, originalHost: actor, originalExit: exit, handoff, oneShotExited: true,
    phase: receipt.phase, disposition: receipt.disposition, configuredModelCount: models.length, origin, draftUrl,
    providersSha256: createHash('sha256').update(JSON.stringify(models)).digest('hex'),
    threadIds: history.threads.map(thread => thread.id), transcriptThreadId: history.threads[0].id,
    transcriptSha256: createHash('sha256').update(JSON.stringify(transcript.messages.map(({ id, role, content, timestampMs }) => ({ id, role, content, timestampMs })))).digest('hex'),
    originalProjectThreads: history.threads.length, transcriptMessages: transcript.messages.length,
    actualRestartObserved: true, restarted, automaticRestartCleanup: 'owned-test-job', sourceOnly: true, modelTurnsRequested: 0,
    installedPackageAccepted: false, browserStateColdReadStillRequired: true }), { flag: 'wx', mode: 0o600 });
} catch (error) {
  const draftDiagnostic = page && !page.isClosed() ? await page.evaluate(async expected => {
    const editor = document.querySelector('[data-testid="chat-message-input"]');
    const servers = (await (await fetch('/api/servers', { cache: 'no-store' })).json()).servers ?? [];
    const drafts = Object.keys(localStorage).filter(key => key.startsWith('kcoder.composer-drafts.v1:')).map(key => {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      const server = servers.find(server => key.includes(`:${server.id}:`));
      const scope = server ? JSON.stringify([server.authorityId, server.accountIdentity?.principalId ?? 'local', server.command, server.profile]) : null;
      return { key, contentMatches: value?.content === expected, accountScopeMatches: value?.scope === scope };
    });
    return { editorTag: editor?.tagName, editorSerializedLength: editor?.value?.length,
      editorMatches: editor?.value === expected, projectSelected: Boolean(document.querySelector('[data-testid="empty-project-title-button"]')),
      route: location.pathname + location.search, drafts };
  }, `STORAGE_UNSENT_DRAFT_${input.owner}`).catch(() => null) : null;
  await progress({ draftDiagnostic });
  await progress({ stage, appPid: app.pid, operationId, error: String(error.message) });
  if (page && !page.isClosed()) await page.screenshot({ path: input.failureImage, timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  inspector?.close(); await browser?.close().catch(() => {});
  // The enclosing Job still owns cleanup. Observation pipes must not keep a
  // failed worker alive until its deadline after the original host has exited.
  app.stdout.destroy(); app.stderr.destroy(); app.unref();
}
