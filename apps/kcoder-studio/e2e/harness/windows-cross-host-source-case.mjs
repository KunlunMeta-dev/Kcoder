import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, access, rename } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { assertNoMigrationInference } from './migration-no-inference.mjs';
import { seedCrossHostAdoptionSource, exerciseCrossHostAdoption, openCrossHostMigrationRpc } from './windows-cross-host-adoption.mjs';
import { closeRpcAndWait } from './rpc.mjs';
import { seedCrossHostContentSource, verifyCrossHostContentSource, crossHostWindowsTrustPaths } from './windows-cross-host-content-fixture.mjs';
import { CROSS_HOST_CONTENT_VERSION, requireCrossHostContentCapabilities, releaseCrossHostSourceSession } from './windows-cross-host-content-contract.mjs';
import { prepareCrossHostAssetTransfers, finishCrossHostAssetTransfers } from './windows-cross-host-content-assets.mjs';
import { CROSS_HOST_INSTRUCTION_TARGETS, prepareCrossHostPackageTransfers, finishCrossHostPackageTransfers } from './windows-cross-host-content-packages.mjs';
import { crossHostPrivateCanaries, seedCrossHostPrivateFields, assertNoCrossHostPlaintext, prepareCrossHostPrivateTransfer, finishCrossHostPrivateTransfer } from './windows-cross-host-content-private.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, duration = 25000) {
  const end = Date.now() + duration;
  while (Date.now() < end) { const result = await read(); if (result) return result; await pause(50); }
  throw Error(`Owned cross-host deadline: ${label}`);
}

export async function runCrossHostSourceCase({ root, binary, environment, connection }) {
  assert.equal(process.platform, 'win32');
  assert.equal(connection.contentVersion, CROSS_HOST_CONTENT_VERSION, 'the full content fixture must be explicitly frozen with this run');
  const windowsAccount = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim().split('\\');
  assert.equal(windowsAccount.length, 2);
  const sidScript = "$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;$b=New-Object byte[] $s.BinaryLength;$s.GetBinaryForm($b,0);$h=[Security.Cryptography.SHA256]::Create();try{@{sid=$s.Value;sha256=([BitConverter]::ToString($h.ComputeHash($b))).Replace('-','').ToLowerInvariant()}|ConvertTo-Json -Compress}finally{$h.Dispose()}";
  const windowsIdentity = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(sidScript, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true, encoding: 'utf8' }));
  const windowsSid = windowsIdentity.sid;
  assert.match(windowsSid, /^S-1-\d+(?:-\d+)+$/);
  assert.match(windowsIdentity.sha256, /^[a-f0-9]{64}$/);
  environment = { ...environment, USERDOMAIN: windowsAccount[0], USERNAME: windowsAccount[1] };
  assert.equal(sha(await readFile(join(root, 'gateway.tar'))), connection.gatewayBundleSha256);
  assert.equal(sha(await readFile(join(root, 'ssh.exe'))), connection.sshWrapperSha256);
  const gatewayRoot = join(root, 'gateway'); await mkdir(gatewayRoot);
  execFileSync('tar.exe', ['-xf', join(root, 'gateway.tar'), '-C', gatewayRoot], { timeout: 10000, windowsHide: true });
  const manifest = JSON.parse(await readFile(join(gatewayRoot, 'source-manifest.json'), 'utf8'));
  for (const entry of manifest.files) assert.equal(sha(await readFile(join(gatewayRoot, ...entry.path.split('/')))), entry.sha256);
  const realSsh = execFileSync('where.exe', ['ssh.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
  assert.ok(realSsh.toLowerCase() !== join(root, 'ssh.exe').toLowerCase());
  await writeFile(join(root, 'real-ssh-path.txt'), realSsh);
  const quoted = path => '"' + path.replaceAll('\\', '/') + '"';
  await writeFile(join(root, 'ssh-config'), ['Host *', `  IdentityFile ${quoted(join(root, 'client-key'))}`,
    `  UserKnownHostsFile ${quoted(join(root, 'known_hosts'))}`, '  StrictHostKeyChecking yes', '  IdentitiesOnly yes',
    '  GlobalKnownHostsFile none', '  PasswordAuthentication no', '  KbdInteractiveAuthentication no', '  BatchMode yes', ''].join('\n'));
  const keyAcl = "$ErrorActionPreference='Stop';$p='" + join(root, 'client-key').replaceAll("'", "''") +
    "';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));Set-Acl -LiteralPath $p -AclObject $acl";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(keyAcl, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true });
  const remote = `${connection.user}@${connection.host}`;
  const peerArgs = ['-n', '-p', String(connection.port), remote, '/usr/bin/uname', '-s'];
  const directOs = execFileSync(realSsh, ['-F', join(root, 'ssh-config'), ...peerArgs],
    { timeout: 15000, windowsHide: true, encoding: 'utf8', env: environment }).trim();
  assert.equal(directOs, 'Linux');
  const remoteOs = execFileSync(join(root, 'ssh.exe'), peerArgs,
    { timeout: 15000, windowsHide: true, encoding: 'utf8', env: environment }).trim();
  assert.equal(remoteOs, 'Linux', 'the owned SSH endpoint must be the real Linux host');
  const source = join(root, 'windows-source'), profile = join(root, 'windows-profile'), workspace = join(root, 'workspace');
  for (const path of [source, profile]) await mkdir(path);
  const marker = join(root, 'source-hook-must-not-run');
  const historyOriginal = await readFile(join(gatewayRoot, 'fixtures/history-source-compressed.jsonl.zst'));
  const historyDecoded = await readFile(join(gatewayRoot, 'fixtures/history-source-compressed.jsonl'));
  const windowsSource = await seedCrossHostPrivateFields(source, 'windows', await seedCrossHostAdoptionSource(source, 'windows', marker, historyOriginal, historyDecoded));
  const windowsContent = await seedCrossHostContentSource(source, 'windows', marker);
  for (const scopes of Object.values(CROSS_HOST_INSTRUCTION_TARGETS)) for (const scope of Object.values(scopes)) await mkdir(join(workspace, ...scope.split('/')), { recursive: true, mode: 0o700 });
  await writeFile(join(profile, 'trusted-folders.json'), JSON.stringify({ version: 1, trusted: crossHostWindowsTrustPaths([workspace, ...Object.values(windowsContent.instructionRoots)]), never: [] }));
  const modelRequests = [];
  const model = createServer((request, response) => { modelRequests.push({ method: request.method, path: request.url }); response.writeHead(500); response.end('unexpected fixture request'); });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const settings = JSON.stringify({ credential_store: 'file', mcp_servers: [], hooks: {}, active_provider: 'fixture', providers: {
    fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' }, endpoint: `http://127.0.0.1:${model.address().port}/v1`,
      default_model: 'fixture', discover_models: false, no_proxy: true, context_window_tokens: 128000, max_output_tokens: 2048, output_headroom_tokens: 4096 },
  } });
  await writeFile(join(profile, 'settings.json'), settings);
  const targets = [{ id: 'windows', label: 'Owned Windows', transport: 'local', command: binary, workspace },
    { id: 'linux', label: 'Owned Linux SSH', transport: 'ssh', host: connection.host, user: connection.user, port: connection.port,
      command: connection.command, workspace: connection.workspace }];
  const servers = join(root, 'servers.json'); await writeFile(servers, JSON.stringify(targets));
  const web = join(root, 'web'); await mkdir(web); await writeFile(join(web, 'index.html'), '<!doctype html><title>Owned R1 transport fixture</title>');
  const authToken = randomBytes(24).toString('base64url');
  const env = { ...environment, PATH: root + delimiter + environment.PATH, KCODER_STUDIO_HOST: '127.0.0.1', KCODER_STUDIO_PORT: '0',
    KCODER_STUDIO_ALLOWED_HOSTS: '127.0.0.1,localhost', KCODER_STUDIO_WORKSPACE: workspace, KCODER_STUDIO_KCODER_BIN: binary,
    KCODER_STUDIO_SERVERS_FILE: servers, KCODER_STUDIO_WEB_ROOT: web, KCODER_STUDIO_AUTH_TOKEN: authToken,
    KCODER_CONFIG_DIR: profile, CLAUDE_CONFIG_DIR: source, CODEX_HOME: join(source, 'codex'), NODE_ENV: 'test', KCODER_E2E_CHILD_EVENTS: join(root, 'cross-host-child-events.jsonl') };
  const gateway = spawn(process.execPath, ['--import', pathToFileURL(join(root, 'windows-cross-host-child-events.mjs')).href, join(gatewayRoot, 'dev-server.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', diagnostic = ''; gateway.stdout.on('data', data => { output = (output + data).slice(-16384); });
  gateway.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-16384); });
  const results = [], completedStages = [], sessionReleases = [], openedSessions = new Set(), readUnknownsByRequest = new Map(); let sessionToken = '', rpcToken = '', readUnknowns = 0;
  try {
    const port = await until(() => {
      assert.equal(gateway.exitCode, null, 'owned Gateway exited before listening');
      return /KCoder Studio: http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
    }, 'Windows Gateway startup');
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(base + '/api/mobile/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: authToken }) });
    assert.equal(login.status, 200); const credentials = await login.json(), token = credentials.accessToken;
    sessionToken = token; rpcToken = credentials.rpcToken;
    async function call(lane, operation, value, discard = false, readonlyObserve = false) {
      assertNoCrossHostPlaintext(value);
      const response = await fetch(`${base}/api/migration/${lane}/${operation}`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(value) });
      if (discard && response.status === 200) { await response.body.cancel(); return; }
      const body = await response.json();
      assertNoCrossHostPlaintext(body);
      if (readonlyObserve && lane === 'source-transfer' && operation === 'read' && response.status === 409 && body.error === 'source_transfer_outcome_unknown') {
        readUnknowns++; const count = (readUnknownsByRequest.get(value.requestId) ?? 0) + 1; readUnknownsByRequest.set(value.requestId, count);
        assert.ok(count <= 8, 'each original request read remains bounded, never authorizing replay');
        await pause(250); return null;
      }
      assert.equal(response.status, 200, `${lane}/${operation}: ${JSON.stringify(body)}`);
      if (lane === 'source-session' && operation === 'open') openedSessions.add(value.sessionId);
      return body;
    }
    const closeSession = async session => {
      sessionReleases.push(await releaseCrossHostSourceSession({ call, until, session })); openedSessions.delete(session.sessionId);
    };
    const selector = (targetId, purpose, authorizedWorkspace) => ({ sessionId: randomUUID(), purpose, targetId, workspacePath: authorizedWorkspace ?? (targetId === 'windows' ? workspace : connection.workspace) });
    const connect = async targetId => {
      const rpc = await openCrossHostMigrationRpc(base, credentials, targetId, targetId === 'windows' ? workspace : connection.workspace);
      const original = rpc.request.bind(rpc);
      rpc.request = async (method, params) => {
        assertNoCrossHostPlaintext(params);
        try { const value = await original(method, params); assertNoCrossHostPlaintext(value); return value; }
        catch (error) { throw new Error(`${method}: ${error.message}`, { cause: error }); }
      };
      return rpc;
    };
    const targetFiles = targetId => {
      const selectedProfile = targetId === 'windows' ? profile : connection.profile;
      const bound = relative => {
        assert.ok(relative.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'));
        return targetId === 'windows' ? join(selectedProfile, ...relative.split('/')) : selectedProfile + '/' + relative;
      };
      const remoteFile = (command, path, args = []) => {
        assert.ok(['/bin/cat', '/usr/bin/test'].includes(command));
        assert.match(path, /^\/[A-Za-z0-9_./-]+$/);
        return execFileSync(join(root, 'ssh.exe'), ['-p', String(connection.port), remote, command, ...args, path],
          { timeout: 15000, windowsHide: true, env: environment, maxBuffer: 1024 * 1024 });
      };
      return {
        read(relative) { const file = bound(relative); return targetId === 'windows' ? readFile(file) : remoteFile('/bin/cat', file); },
        async exists(relative) {
          const file = bound(relative);
          if (targetId === 'windows') return access(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
          try { remoteFile('/usr/bin/test', file, ['-e']); return true; }
          catch (error) { if (error.status === 1) return false; throw error; }
        },
      };
    };
    for (const [from, to] of [['windows', 'linux'], ['linux', 'windows']]) {
      const capabilities = {};
      for (const [peer, targetId] of [['source', from], ['target', to]]) {
        const rpc = await connect(targetId);
        try { requireCrossHostContentCapabilities(rpc.crossHostCapabilities); capabilities[peer] = rpc.crossHostCapabilities; }
        finally { await closeRpcAndWait(rpc); }
      }
      const sourceSession = selector(from, 'source'), targetSession = selector(to, 'target');
      await call('source-session', 'open', sourceSession); await call('source-session', 'open', targetSession);
      const catalog = await call('source-session', 'query', { session: sourceSession, query: { kind: 'configuration', params: { sources: ['claude-code'] } } });
      const ids = catalog.sources.map(value => value.sourceId);
      const descriptors = await call('source-session', 'query', { session: sourceSession, query: { kind: 'source_bindings', params: { sourceIds: ids } } });
      const selected = descriptors.bindings.find(value => value.family === 'configuration');
      const asset = descriptors.bindings.find(value => value.family === 'assets');
      assert.ok(selected && asset, 'the actual Native registry classifies configuration and skill sources');
      const history = await call('source-session', 'query', { session: sourceSession, query: { kind: 'history', params: { source: 'codex' } } });
      assert.equal(history.items.length, 1); assert.equal(history.nextCursor, null);
      const pair = { requestId: randomUUID(), source: sourceSession, target: targetSession };
      const run = { ...pair, attemptId: randomUUID(), selections: [{ kind: 'configuration', sourceId: selected.sourceId },
        { kind: 'assets', sourceId: asset.sourceId }, { kind: 'history', catalogId: history.catalogId, sourceHandle: history.items[0].sourceHandle }] };
      await call('source-transfer', 'run', run, true);
      const final = await until(async () => { const read = await call('source-transfer', 'read', pair, false, true); return read?.result?.phase === 'ready' ? read : false; }, `${from} to ${to} Ready`);
      const duplicate = await call('source-transfer', 'run', run); assert.deepEqual(duplicate.result.receipt, final.result.receipt);
      assert.equal(final.result.receipt.requestId, pair.requestId);
      completedStages.push({ direction: `${from}->${to}`, kind: 'legacy-three', phase: 'ready', requestId: pair.requestId });
      await closeSession(sourceSession); await closeSession(targetSession);
      const openPair = async ({ sourceWorkspace } = {}) => {
        const source = selector(from, 'source', sourceWorkspace), target = selector(to, 'target');
        await call('source-session', 'open', source); await call('source-session', 'open', target); return { source, target };
      };
      const closePair = async session => { await closeSession(session.source); await closeSession(session.target); };
      const assetTransfers = await prepareCrossHostAssetTransfers({ call, until, from, to, capabilities, openPair, closePair });
      completedStages.push(...assetTransfers.map(value => ({ direction: `${from}->${to}`, kind: value.kind, phase: 'ready', requestId: value.pair.requestId })));
      const packageTransfers = await prepareCrossHostPackageTransfers({ call, until, from, to, capabilities, openPair, closePair,
        metadata: from === 'windows' ? windowsContent : connection.contentFixture });
      completedStages.push(...packageTransfers.map(value => ({ direction: `${from}->${to}`, kind: value.kind, phase: 'ready', requestId: value.pair.requestId })));
      const privateSession = await openPair(); let privateTransfer;
      try { privateTransfer = await prepareCrossHostPrivateTransfer({ call, until, ...privateSession, from, to, capabilities, targetWorkspace: to === 'windows' ? workspace : connection.workspace, connect: () => connect(to) }); }
      finally { await closePair(privateSession); }
      completedStages.push({ direction: `${from}->${to}`, kind: 'private', phase: 'prepared', requestId: privateTransfer.pair.requestId });
      if (from === 'windows') await rename(source, source + '-offline');
      else {
        const remote = `${connection.user}@${connection.host}`;
        execFileSync(join(root, 'ssh.exe'), ['-p', String(connection.port), remote, '/bin/mv', connection.source, connection.source + '-offline'], { timeout: 15000, windowsHide: true });
      }
      const common = { call, until, connect: () => connect(to), files: targetFiles(to) };
      const recover = async (value, consume) => {
        const recovery = selector(to, 'target_recovery'); await call('source-session', 'open', recovery);
        try {
        const reopened = await call('source-transfer', 'target-read', { requestId: value.pair.requestId, target: recovery });
        assert.equal(reopened.result.sourceObserved, false); assert.deepEqual(reopened.result.receipt, value.receipt);
        return await consume(recovery);
        } finally { await closeSession(recovery); }
      };
      const assetResults = [], packageResults = [];
      for (const value of assetTransfers) assetResults.push(...await recover(value, recovery => finishCrossHostAssetTransfers({ ...common, recovery, transfers: [value] })));
      for (const value of packageTransfers) packageResults.push(...await recover(value, recovery => finishCrossHostPackageTransfers({ ...common, recovery, transfers: [value] })));
      const privateResult = await recover(privateTransfer, recovery => finishCrossHostPrivateTransfer({ ...common, recovery, prepared: privateTransfer }));
      const targetOnly = selector(to, 'target_recovery'); await call('source-session', 'open', targetOnly);
      const offline = await call('source-transfer', 'target-read', { requestId: pair.requestId, target: targetOnly });
      assert.equal(offline.result.sourceObserved, false); assert.deepEqual(offline.result.receipt, final.result.receipt);
      const adopted = await exerciseCrossHostAdoption({ call, until, recovery: targetOnly, pair, receipt: final.result.receipt, from, to,
        connect: () => connect(to),
        closeRecovery: closeSession,
        reopenRecovery: async () => { const value = selector(to, 'target_recovery'); await call('source-session', 'open', value); return value; },
        files: targetFiles(to), expected: from === 'windows' ? windowsSource : connection.sourceFixture });
      results.push({ direction: `${from}->${to}`, ready: true, receipt: final.result.receipt, discardedAcknowledgementReconciled: true,
        sameAttemptNotRepeated: true, sourceOfflineTargetReceipt: true, ...adopted,
        contents: [...assetResults, ...packageResults, privateResult] });
    }
    for (const item of windowsSource.files) assert.equal(sha(await readFile(join(source + '-offline', ...item.path.split('/')))), item.sha256);
    const contentIntegrity = await verifyCrossHostContentSource(source + '-offline', windowsContent);
    assert.deepEqual(JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8')), JSON.parse(settings));
    await assert.rejects(access(marker)); const httpAudit = assertNoMigrationInference(modelRequests);
    const nativeIdentity = JSON.parse(await readFile(join(profile, 'migrations/source-transfer/native.json'), 'utf8'));
    assert.match(nativeIdentity.account, /^windows:[a-f0-9]{64}$/);
    assert.equal(nativeIdentity.account, `windows:${windowsIdentity.sha256}`);
    assert.equal(openedSessions.size, 0);
    return { passed: true, actualGatewayPlatform: process.platform, actualSshClient: realSsh,
      windowsSourceSha256: windowsSource.files.find(item => item.path === 'settings.json').sha256,
      nativeAccountKind: 'windows_sid', nativeAccountSha256: sha(nativeIdentity.account),
      windowsSid, dedicatedAccountIsolationClaim: false, contentVersion: CROSS_HOST_CONTENT_VERSION, contentIntegrity, sessionReleases,
      gatewaySourceSha256: sha(JSON.stringify(manifest)), results, windowsSettingsRestored: true, windowsSourceUnchanged: true,
      modelRequests: 0, httpAudit, readUnknowns, sourceHooksExecuted: 0, publishedSettings: true, allPublishedOutputsUndone: true };
  } catch (error) {
    const redact = value => [authToken, sessionToken, rpcToken, ...crossHostPrivateCanaries('windows'), ...crossHostPrivateCanaries('linux')].filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value);
    let descendants = '';
    try {
      const events = (await readFile(join(root, 'cross-host-child-events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const spawned = events.filter(event => event.event === 'spawn' && Number.isSafeInteger(event.pid));
      const owned = spawned.map(event => '@{Pid=' + event.pid + ';Start=' + event.at + ';End=' + (events.find(other => other.pid === event.pid && other.event === 'exit')?.at ?? Date.now()) + '}');
      const script = "$ErrorActionPreference='Stop';$items=@(" + owned.join(',') + ");$out=@();foreach($i in $items){if(Get-CimInstance Win32_Process -Filter ('ProcessId='+$i.Pid)){continue};foreach($p in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$i.Pid))){$t=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();if($t -ge $i.Start -and $t -le $i.End){$out+=@{pid=$p.ProcessId;parent=$p.ParentProcessId;name=$p.Name;created=$t}}}};ConvertTo-Json -InputObject @($out) -Compress";
      descendants = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
    } catch { descendants = 'Owned child observation unavailable'; }
    await writeFile(join(root, 'cross-host-diagnostic.txt'), redact(String(error.stack) + '\n' + diagnostic +
      '\nCompleted directions: ' + JSON.stringify(results) + '\nCompleted stages (Ready is not publication): ' + JSON.stringify(completedStages) + '\nOwned descendants: ' + descendants));
    throw error;
  } finally {
    gateway.kill(); await until(() => gateway.exitCode !== null || gateway.signalCode !== null, 'owned Gateway exit', 5000);
    await new Promise(resolve => model.close(resolve));
  }
}
