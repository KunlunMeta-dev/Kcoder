import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, lstat, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const stateLeaf = 'windows-storage-relocation-private.json';

/** Chromium needs short physical paths; retain failed migrations for reconciliation. */
export async function createShortStorageTarget(context, fixtureRoot, sid, accepted) {
  const root = join(fixtureRoot, `m-${context.seed}`);
  await mkdir(root);
  const identity = await lstat(root, { bigint: true });
  const owner = { owner: context.seed, sid };
  const cleanup = context.pathInArtifacts('short-storage-target-cleanup.json');
  await writeFile(join(root, '.owner.json'), JSON.stringify(owner), { flag: 'wx' });
  context.addCleanup('settle only this short storage target', async () => {
    const current = await lstat(root, { bigint: true });
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.deepEqual(JSON.parse(await readFile(join(root, '.owner.json'), 'utf8')), owner);
    const remove = accepted();
    if (remove) await rm(root, { recursive: true, maxRetries: 10, retryDelay: 100 });
    await writeFile(cleanup, JSON.stringify({ root, removed: remove,
      retainedForReconciliation: !remove, originalIdentityConfirmed: true }), { flag: 'wx', mode: 0o600 });
  });
  const data = join(root, 'data'), cache = join(root, 'cache');
  await mkdir(data); await mkdir(cache);
  return { root, data, cache };
}

/** Compare configured models, excluding runtime capabilities, probes and revisions. */
export function modelConfigurationSnapshot(value) {
  assert.ok(Array.isArray(value.profiles));
  const fields = ['id', 'apiFormat', 'endpoint', 'model', 'contextWindowTokens', 'maxOutputTokens', 'chatProtocol',
    'reasoningEffort', 'reasoningPolicy', 'extraBody', 'isProviderDefault', 'authentication', 'isDefault', 'apiKeyConfigured'];
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return value.profiles.map(profile => {
    assert.equal(typeof profile.id, 'string'); assert.equal(typeof profile.model, 'string');
    return canonical(Object.fromEntries(fields.map(key => [key, profile[key] ?? null])));
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function optionalIdentityHash(dataRoot, file) {
  if (file === null) return null;
  try { return sha(await readFile(join(dataRoot, file))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function nativeIdentitySnapshot(dataRoot) {
  const identities = [];
  for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
    if (!/^integration-[a-f0-9]{64}$/.test(entry.name)) continue;
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink());
    let record;
    try { record = await readFile(join(dataRoot, entry.name, 'native-identity.jsonl')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const header = JSON.parse(record.toString('utf8').split(/\r?\n/)[0]);
    assert.equal(typeof header.profileIdentity, 'string'); assert.ok(header.profileIdentity.length > 0);
    const head = await readFile(join(dataRoot, entry.name, 'native-identity-head.jsonl'));
    identities.push({ directory: entry.name, profileIdentity: header.profileIdentity, recordSha256: sha(record), headSha256: sha(head) });
  }
  assert.equal(identities.length, 1, 'The real history entry must establish one original Native identity');
  return identities;
}

export function validateWindowsStorageVolume(receipt, { owner, qaSid, sourceRoot }) {
  assert.equal(receipt.version, 1); assert.equal(receipt.owner, owner); assert.equal(receipt.qaSid, qaSid);
  assert.match(receipt.root, /^[A-Z]:\\$/); assert.match(receipt.volumeSerialNumber, /^[a-f0-9]{8}$/i);
  assert.notEqual(receipt.root.toLowerCase(), win32.parse(sourceRoot).root.toLowerCase(), 'Owned VHD must be another volume');
  assert.equal(receipt.dataRoot, win32.join(receipt.root, `kcoder-storage-${owner}`, 'data'));
  assert.equal(receipt.cacheRoot, win32.join(receipt.root, `kcoder-storage-${owner}`, 'cache'));
  return { dataRoot: receipt.dataRoot, cacheRoot: receipt.cacheRoot };
}

/** Vendor input only. The actual importer creates all Native history/attachment identities. */
export async function prepareWindowsStorageHistory({ request, profile, workspace }) {
  const directory = join(profile.userProfile, '.claude/projects/storage-owned-acceptance');
  await mkdir(directory, { recursive: true });
  const rows = [
    { type: 'user', uuid: 'owned-text', sessionId: request.owner, cwd: workspace,
      message: { role: 'user', content: `STORAGE_OWNED_HISTORY_${request.owner}` } },
    { type: 'user', uuid: 'owned-image', parentUuid: 'owned-text', sessionId: request.owner, cwd: workspace,
      message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } }] } },
    { type: 'assistant', uuid: 'owned-answer', parentUuid: 'owned-image', sessionId: request.owner, cwd: workspace,
      message: { role: 'assistant', content: 'Recorded owned history. No tool or model execution is requested.' } },
  ];
  await writeFile(join(directory, request.owner + '.jsonl'), rows.map(JSON.stringify).join('\n') + '\n', { flag: 'wx' });
}

// The same authenticated /rpc user entry used by existing Windows history fixtures.
async function openOwnedStorageRpc() {
  const url = new URL('/rpc', location.href); url.protocol = 'ws:'; url.searchParams.set('server', 'local');
  url.searchParams.set('token', document.querySelector('meta[name="kcoder-rpc-token"]').content);
  const socket = new WebSocket(url), pending = new Map(); let sequence = 0;
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data), row = pending.get(frame.id); if (!row) return;
    pending.delete(frame.id); clearTimeout(row.timer);
    frame.error ? row.reject(Error(`Owned storage RPC failed: ${row.method}`)) : row.accept(frame.result);
  });
  socket.addEventListener('close', () => { for (const row of pending.values()) { clearTimeout(row.timer); row.reject(Error('Owned storage RPC closed')); } pending.clear(); });
  await new Promise((accept, reject) => { const timer = setTimeout(() => reject(Error('Owned storage RPC open timeout')), 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); accept(); }, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const request = (method, params = {}) => new Promise((accept, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`Owned storage RPC timeout: ${method}`)); }, 30000);
    pending.set(id, { accept, reject, timer, method }); socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  await request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'windows-storage-acceptance', version: '1' } });
  window.__kcoderOwnedStorageRpc = { request, close: () => socket.close() }; return true;
}

export async function rpcClient({ renderer, evaluate }) {
  await evaluate(renderer, `(${openOwnedStorageRpc})()`);
  return (method, params = {}) => evaluate(renderer, `window.__kcoderOwnedStorageRpc.request(${JSON.stringify(method)},${JSON.stringify(params)})`);
}

export async function attachmentBytes(rpc, selection) {
  const chunk = await rpc('migration/history/attachment/chunk', { selection, offset: 0, limit: 256 * 1024 });
  assert.equal(chunk.nextOffset, null); const bytes = Buffer.from(chunk.dataBase64, 'base64');
  assert.equal(sha(bytes), chunk.dataSha256); assert.deepEqual(bytes, image); return chunk.receipt;
}

export async function seedWindowsStorageClientState(flow, { source, target, profileIdentityFile = '.profile-identity.json', persistedDraft = true }) {
  assert.equal(typeof persistedDraft, 'boolean');
  const { request, renderer, evaluate, until } = flow;
  const rpc = await rpcClient(flow);
  const settings = await readFile(join(source.dataRoot, 'settings.json'));
  const identitySha256 = await optionalIdentityHash(source.dataRoot, profileIdentityFile);
  const configuredModels = modelConfigurationSnapshot(await rpc('runtime.providers.list', {}));
  const providers = sha(JSON.stringify(configuredModels));
  const discovery = await rpc('migration/history/discover', { source: 'claude-code' });
  assert.equal(discovery.items.length, 1, 'Only this owned account history fixture may be imported');
  const created = await rpc('migration/history/create', { catalogId: discovery.catalogId, sourceHandle: discovery.items[0].sourceHandle, requestId: request.owner });
  await rpc('migration/history/run', { jobId: request.owner, expectedSequence: created.job.sequence });
  await until(async () => { const value = await rpc('migration/history/read', { jobId: request.owner }); if (value.job.stage === 'failed') throw Error('Owned historical seed failed'); return value.workerRunning === false && value.job.stage === 'normalized'; });
  const transcript = await rpc('migration/history/transcript', { jobId: request.owner }); assert.equal(transcript.items.length, 3);
  const selection = { jobId: request.owner, position: 1, blockIndex: 0 };
  await rpc('migration/history/attachment/run', { selection });
  await until(async () => { const value = await rpc('migration/history/attachment/read', { selection }); if (value.job?.stage === 'failed') throw Error('Owned historical attachment seed failed'); return value.workerRunning === false && value.job?.stage === 'ready'; });
  const attachment = await attachmentBytes(rpc, selection);
  const origin = await evaluate(renderer, 'location.origin'), cookie = { name: 'kcoder_storage_owned_migration', value: request.owner, url: origin,
    httpOnly: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 3600 };
  assert.equal((await renderer.request('Network.setCookie', cookie)).success, true);
  await evaluate(renderer, `(async()=>{const menus=await window.kcoderDesktopMenu.list('en');for(const menu of menus){const item=menu.entries?.find(row=>row.id==='newChat');if(item){await window.kcoderDesktopMenu.invoke(menu.index,item.position);return true}}throw Error('Owned new-chat menu unavailable')})()`);
  await until(() => evaluate(renderer, 'Boolean(document.querySelector(\'[data-testid="chat-message-input"]\'))'));
  await evaluate(renderer, 'document.querySelector(\'[data-testid="chat-message-input"]\').focus();true');
  const draft = `STORAGE_UNSENT_DRAFT_${request.owner}`; await renderer.request('Input.insertText', { text: draft });
  const draftState = persistedDraft ? await until(() => evaluate(renderer, `(()=>{const key=Object.keys(localStorage).find(key=>key.startsWith('kcoder.composer-drafts.v1:')&&JSON.parse(localStorage.getItem(key)||'null')?.content===${JSON.stringify(draft)});return key?{key,value:localStorage.getItem(key),url:location.href}:null})()`)) : null;
  if (!persistedDraft) await until(() => evaluate(renderer, `document.querySelector('[data-testid="chat-message-input"]')?.textContent===${JSON.stringify(draft)}`));
  const state = { owner: request.owner, source, target, settingsSha256: sha(settings), identitySha256, profileIdentityFile, providersSha256: providers,
    configuredModelCount: configuredModels.length,
    historyJobId: request.owner, transcriptCount: 3, attachment, selection, origin, draftState, persistedDraft, cookieName: cookie.name };
  return state;
}

/** Passive birth-bound observation shared by installed and source desktop flows. */
export async function observeWindowsStorageHandoff({ main, evaluate, powershell, identity }, observer) {
  await evaluate(main, `(()=>{const cp=process.getBuiltinModule('child_process'),fs=process.getBuiltinModule('fs'),original=cp.ChildProcess.prototype.spawn;
    cp.ChildProcess.prototype.spawn=function(options){const result=original.call(this,options);if(options.file===${JSON.stringify(identity.nativePath)}&&options.args[1]==='--internal-storage-operation-v1'&&options.args[2]==='handoff'){
      const text=cp.execFileSync(${JSON.stringify(powershell)},['-NoProfile','-NonInteractive','-Command','(Get-Process -Id '+this.pid+' -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()'],{windowsHide:true,encoding:'utf8'}).trim();
      fs.writeFileSync(${JSON.stringify(observer)},JSON.stringify({pid:this.pid,creationFileTime:text,parentPid:process.pid,detached:options.detached===true}),{flag:'wx'});
    }return result};return true})()`);
}

export async function runWindowsStorageRelocation(flow) {
  const { request, root, profile, identity, env, workspace, app, born, renderer, main, evaluate, native, until, waitClosed, execute, powershell } = flow;
  const source = JSON.parse(await readFile(join(profile.userProfile, '.config/kcoder-storage.json'), 'utf8'));
  let volume;
  try { volume = JSON.parse(await readFile(join(root, 'windows-storage-owned-volume.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const target = volume ? validateWindowsStorageVolume(volume, { owner: request.owner, qaSid: profile.sid, sourceRoot: source.dataRoot })
    : { dataRoot: join(root, 'moved data 中文'), cacheRoot: join(root, 'moved cache 中文') };
  for (const path of Object.values(target)) { await mkdir(path, { recursive: true }); assert.deepEqual(await readdir(path), []); }
  const state = await seedWindowsStorageClientState(flow, { source, target });
  state.nativeIdentity = await nativeIdentitySnapshot(source.dataRoot);
  const origin = state.origin;
  state.crossVolume = Boolean(volume); state.volumeSerialNumber = volume?.volumeSerialNumber;
  await writeFile(join(root, stateLeaf), JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  const observer = join(root, 'windows-storage-handoff.json');
  // Passive observation of the actual one-shot. No source/binary/plan is replaced.
  await observeWindowsStorageHandoff(flow, observer);
  const sample = async () => {
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$all=@(Get-CimInstance Win32_Process);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${app.pid});do{$changed=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)-and !$ids.Contains([int]$p.ProcessId)){[void]$ids.Add([int]$p.ProcessId);$changed=$true}}}while($changed);@($all|Where-Object{$ids.Contains([int]$_.ProcessId)}|ForEach-Object{@{pid=$_.ProcessId;creationFileTime=$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();image=$_.ExecutablePath}})|ConvertTo-Json -Compress`;
    const value = JSON.parse((await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true, env })).stdout || '[]');
    return Array.isArray(value) ? value : [value];
  };
  const originalWriters = await sample(); assert.ok(originalWriters.some(row => row.pid === app.pid && row.creationFileTime === born));
  await evaluate(main, `(()=>{const {dialog}=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');const open=dialog.showOpenDialog,confirm=dialog.showMessageBox;dialog.showOpenDialog=(window,options)=>open.call(dialog,window,{...options,title:'KCoder storage relocation picker'});dialog.showMessageBox=(window,options)=>confirm.call(dialog,window,{...options,title:'KCoder storage relocation confirm'});return true})()`);
  await renderer.request('Page.navigate', { url: origin + '/settings/storage' });
  const click = async id => until(() => evaluate(renderer, `(()=>{const item=document.querySelector('[data-testid=${JSON.stringify(id)}]');if(!item||item.disabled)return false;item.click();return true})()`));
  await until(() => evaluate(renderer, 'Boolean(document.querySelector(\'[data-testid="storage-locations-panel"]\'))'));
  for (const [kind, folder] of [['data', target.dataRoot], ['cache', target.cacheRoot]]) {
    await click(`storage-location-pick-${kind}`);
    await native(`relocate-${kind}`, 'KCoder storage relocation picker', 'folder', undefined, folder);
  }
  await click('storage-location-preview');
  await until(() => evaluate(renderer, 'Boolean(document.querySelector(\'[data-testid="storage-location-plan"]\'))'));
  const previewImage = await renderer.request('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(root, 'windows-storage-relocation-preview.png'), Buffer.from(previewImage.data, 'base64'));
  await click('storage-location-stop-migrate'); await click('storage-location-confirm-submit');
  let relocationFinished = false;
  try {
    await native('relocate-confirm', 'KCoder storage relocation confirm', 'button', 'Stop and migrate|停止并迁移');
    const handoff = await until(async () => { try { return JSON.parse(await readFile(observer, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }, 15000, true);
    assert.equal(handoff.parentPid, app.pid); assert.equal(handoff.detached, true); assert.match(handoff.creationFileTime, /^\d+$/);
    let operationId, lastReceiptVersion;
    const samples = [];
    const operation = async () => {
      try { const id = JSON.parse(await readFile(join(profile.userProfile, '.config/kcoder-storage-migrations/current.json'), 'utf8'));
        operationId ??= id; assert.equal(id, operationId);
        const bytes = await readFile(join(profile.userProfile, '.config/kcoder-storage-migrations', id, 'receipt.json'), 'utf8');
        const value = JSON.parse(bytes), version = sha(bytes);
        if (version !== lastReceiptVersion) { await writeFile(join(root, 'windows-storage-operation-last.json'), bytes); lastReceiptVersion = version; }
        return value;
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const exactGone = async rows => {
      const identities = rows.map(row => `@{pid=${row.pid};birth='${row.creationFileTime}'}`).join(',');
      const script = `$ErrorActionPreference='Stop';@(${identities})|ForEach-Object{$p=Get-Process -Id $_.pid -ErrorAction SilentlyContinue;if($p-and $p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()-ceq $_.birth){throw 'Original storage writer still alive'}};'gone'`;
      try { await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true, env }); return true; } catch { return false; }
    };
    await until(async () => { const current = await operation(), gone = await exactGone(originalWriters);
      if (samples.length < 128) samples.push({ at: Date.now(), phase: current?.phase ?? null, disposition: current?.disposition ?? null, originalWritersGone: gone });
      if (!gone) { assert.ok(!current || ['planned', 'stopping'].includes(current.phase), 'Copy cannot begin before all original writers exit'); assert.deepEqual(JSON.parse(await readFile(join(profile.userProfile, '.config/kcoder-storage.json'), 'utf8')), source); }
      return gone;
    }, 45000, true);
    assert.deepEqual(await waitClosed(15000, 'Original storage host exit unconfirmed'), { code: 0, signal: null });
    const completed = await until(async () => { const value = await operation(); if (value?.errorCode || value?.disposition === 'deferred') throw Error('Original installed migration failed: ' + value.errorCode); return value?.phase === 'verified' && value.disposition === 'complete' ? value : null; }, 180000, true);
    assert.equal(completed.plan.operationId, operationId);
    assert.equal(completed.plan.target.dataRoot, target.dataRoot); assert.equal(completed.plan.target.cacheRoot, target.cacheRoot);
    const committed = JSON.parse(await readFile(join(profile.userProfile, '.config/kcoder-storage.json'), 'utf8'));
    assert.equal(committed.operationId, operationId); assert.equal(committed.revision, source.revision + 1);
    assert.equal(sha(await readFile(join(source.dataRoot, 'settings.json'))), state.settingsSha256); assert.equal(sha(await readFile(join(target.dataRoot, 'settings.json'))), state.settingsSha256);
    assert.deepEqual(await nativeIdentitySnapshot(source.dataRoot), state.nativeIdentity);
    assert.deepEqual(await nativeIdentitySnapshot(target.dataRoot), state.nativeIdentity);
    state.targetIdentitySha256 = await optionalIdentityHash(target.dataRoot, state.profileIdentityFile);
    if (state.identitySha256 !== null) assert.equal(state.targetIdentitySha256, state.identitySha256);
    else {
      assert.equal(await optionalIdentityHash(source.dataRoot, state.profileIdentityFile), null, 'The retained source must not receive a fabricated marker');
      const marker = JSON.parse(await readFile(join(target.dataRoot, '.profile-identity.json'), 'utf8'));
      assert.equal(marker.logicalSeed, state.nativeIdentity[0].profileIdentity, 'The product-created target seed retains the actual original Native identity');
    }
    state.operationId = operationId; await writeFile(join(root, stateLeaf), JSON.stringify(state), { mode: 0o600 });
    await writeFile(join(root, 'windows-storage-relocation-result.json'), JSON.stringify({ operationId, source, target, handoff, originalWriters, samples, originalWritersGone: true,
      phase: completed.phase, disposition: completed.disposition, crossVolume: Boolean(volume), volumeSerialNumber: volume?.volumeSerialNumber,
      modelCalls: 0, sourceRetained: true, identityPreserved: true }), { mode: 0o600 });
    // The actual restart has no test inspector switches. Address only its owned native menu.
    const restarted = await until(async () => {
      const script = `$ErrorActionPreference='Stop';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$rows=@(Get-CimInstance Win32_Process -Filter "Name='kcoder-studio.exe'"|Where-Object{$_.ExecutablePath -ieq '${identity.hostPath.replaceAll("'", "''")}' -and $_.ProcessId -ne ${app.pid}}|ForEach-Object{$p=Get-Process -Id $_.ProcessId;if($p.MainWindowHandle -ne 0){@{pid=$p.Id;creationFileTime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}}});$rows|ConvertTo-Json -Compress`;
      const text = (await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true, env })).stdout.trim();
      if (!text) return null; const rows = JSON.parse(text), list = Array.isArray(rows) ? rows : [rows]; assert.equal(list.length, 1); return list[0];
    }, 120000, true);
    await native('relocate-restarted-quit', 'KCoder Studio', 'quit', undefined, undefined, restarted);
    await until(() => exactGone([restarted, handoff]), 30000, true);
    relocationFinished = true;
    return { passed: true, operationId, target, crossVolume: Boolean(volume), originalWritersGone: true, oneShotGone: true, actualRestartObserved: true,
      restartedNormalQuit: true, sourceRetained: true, identityPreserved: true, modelCalls: 0, normalExit: { code: 0, signal: null } };
  } finally {
    if (!relocationFinished && app.exitCode !== null) {
      // Only this run's installed bytes under this QA SID may outlive the old host.
      // Stopping failed owned resources is separate from replaying the operation.
      const prefix = request.installDirectory.replaceAll("'", "''").replace(/\\?$/, '\\');
      const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$stopped=@();foreach($row in @(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath-and $_.ExecutablePath.StartsWith('${prefix}',[StringComparison]::OrdinalIgnoreCase)})){$p=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue;if(!$p){continue};$held=$p.Handle;if((Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid).Sid-cne '${request.sid}'){throw 'Failed cleanup SID changed'};$birth=$row.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();if($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()-cne $birth){throw 'Failed cleanup birth changed'};& taskkill.exe /PID $p.Id /T /F 2>$null|Out-Null;if(!$p.WaitForExit(5000)){throw 'Failed owned product process exit unconfirmed'};$stopped+=@{pid=$p.Id;creationFileTime=$birth}};@{stopped=$stopped;scope='original-owned-installation-and-QA-SID';operationReplayed=$false}|ConvertTo-Json -Depth 4 -Compress`;
      const result = await execute(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true, env });
      await writeFile(join(root, 'windows-storage-failure-process-cleanup.json'), result.stdout, { mode: 0o600 });
    }
  }
}

export async function verifyWindowsStorageRelocatedRead(flow) {
  const { root, request, renderer, evaluate, identity, execute, workspace, env } = flow;
  const state = JSON.parse(await readFile(join(root, stateLeaf), 'utf8')); assert.equal(state.owner, request.owner);
  const rpc = await rpcClient(flow);
  assert.equal(await evaluate(renderer, 'location.origin'), state.origin);
  assert.equal(sha(JSON.stringify(modelConfigurationSnapshot(await rpc('runtime.providers.list', {})))), state.providersSha256);
  assert.equal(await optionalIdentityHash(state.target.dataRoot, state.profileIdentityFile), state.targetIdentitySha256);
  assert.deepEqual(await nativeIdentitySnapshot(state.target.dataRoot), state.nativeIdentity);
  assert.equal(sha(await readFile(join(state.target.dataRoot, 'settings.json'))), state.settingsSha256);
  assert.equal((await rpc('migration/history/transcript', { jobId: state.historyJobId })).items.length, state.transcriptCount);
  assert.deepEqual(await attachmentBytes(rpc, state.selection), state.attachment);
  const cookies = (await renderer.request('Network.getCookies', { urls: [state.origin] })).cookies;
  assert.equal(cookies.find(cookie => cookie.name === state.cookieName)?.value, request.owner);
  assert.equal(await evaluate(renderer, `localStorage.getItem(${JSON.stringify(state.draftState.key)})`), state.draftState.value);
  await renderer.request('Page.navigate', { url: state.draftState.url });
  await flow.until(() => evaluate(renderer, `document.querySelector('[data-testid="chat-message-input"]')?.textContent===${JSON.stringify(`STORAGE_UNSENT_DRAFT_${request.owner}`)}`));
  const options = { cwd: workspace, env, timeout: 30000, windowsHide: true };
  const previous = JSON.parse((await execute(identity.nativePath, ['config', 'get', 'max_retries'], options)).stdout);
  assert.ok(Number.isInteger(previous)); const next = previous === 1 ? 2 : 1;
  await execute(identity.nativePath, ['config', 'set', 'max_retries', String(next), '--scope', 'user'], options);
  // A project overlay can win the effective read without changing this user write.
  assert.equal(JSON.parse(await readFile(join(state.target.dataRoot, 'settings.json'), 'utf8')).max_retries, next);
  assert.notEqual(sha(await readFile(join(state.target.dataRoot, 'settings.json'))), state.settingsSha256);
  assert.equal(sha(await readFile(join(state.source.dataRoot, 'settings.json'))), state.settingsSha256);
  return { operationId: state.operationId, crossVolume: state.crossVolume, modelConfigurationRetained: true, configuredModelCount: state.configuredModelCount, logicalIdentityRetained: true, historyRecordsRead: state.transcriptCount,
    identityEvidence: 'original-native-epoch-bytes-and-history-attachment', historicalAttachmentSha256: state.attachment.sha256, originalOriginRetained: true, persistentCookieRetained: true,
    actualUnsentDraftRetained: true, sourceRetained: true, actualNativeNewDirectoryWrite: true, modelCalls: 0 };
}
