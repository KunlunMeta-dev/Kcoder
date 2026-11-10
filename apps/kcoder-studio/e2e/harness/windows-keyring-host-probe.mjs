import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, lstat, open } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { promisify } from 'node:util';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const exists = async path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function checkedJson(path, limit = 128 * 1024) {
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit);
  return JSON.parse(await readFile(path, 'utf8'));
}
async function save(path, value, fresh = false) {
  const temporary = path + '.' + randomUUID() + '.tmp', file = await open(temporary, 'wx');
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  if (fresh) assert.equal(await exists(path), false);
  await rename(temporary, path);
}
async function noSecrets(path, secrets, state = { files: 0, bytes: 0 }, depth = 0) {
  assert.ok(depth <= 12);
  const { readdir } = await import('node:fs/promises');
  for (const name of await readdir(path)) {
    assert.ok(++state.files <= 512); const leaf = join(path, name), stat = await lstat(leaf);
    assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) { await noSecrets(leaf, secrets, state, depth + 1); continue; }
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 16 * 1024 * 1024);
    state.bytes += stat.size; assert.ok(state.bytes <= 64 * 1024 * 1024);
    if (stat.size === 0) continue; // Empty coordination locks contain no plaintext and may be held by fs2.
    const bytes = await readFile(leaf);
    for (const secret of secrets) assert.equal(bytes.includes(Buffer.from(secret)), false, 'host_target_plaintext_leak');
  }
}

export async function runHostProbe({ phase, root, owner, expectedRoot, handoff }) {
  assert.equal(process.platform, 'win32'); assert.ok(['write', 'reopen', 'cleanup'].includes(phase));
  assert.match(owner, /^[a-f0-9-]{36}$/); assert.equal(basename(root), 'kcoder-package-' + owner);
  const runtime = await checkedJson(join(handoff, 'host-runtime.json'));
  assert.equal(runtime.owner, owner); assert.equal(runtime.version, 1);
  const cli = join(handoff, 'host-cli.exe'), helper = join(handoff, 'security-helper.exe');
  for (const [leaf, digest] of [['host-cli.exe', runtime.cliSha256], ['security-helper.exe', runtime.helperSha256],
    ['host-node.exe', runtime.nodeSha256], ['host-probe.mjs', runtime.probeSha256], ['app-server-stdio.mjs', runtime.stdioSha256]]) {
    assert.match(digest, /^[a-f0-9]{64}$/); assert.equal(hash(await readFile(join(handoff, leaf))), digest);
  }
  const native = async mode => {
    const args = [mode, root, owner, ...(mode === '--vault-root' ? [] : [expectedRoot])];
    const { stdout } = await execute(helper, args, { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
    return JSON.parse(stdout.trim());
  };
  assert.equal((await native('--vault-root')).rootIdentity, expectedRoot);
  const supplied = await checkedJson(join(handoff, 'host-fixture-source.json'), 8192);
  assert.equal(supplied.owner, owner);
  const secrets = [supplied.provider, supplied.mcp, supplied.canary];
  for (const secret of secrets) assert.match(secret, /^[a-f0-9]{64}$/);
  const profile = join(root, 'credential-profile'), workspace = join(root, 'host-workspace'), source = join(root, 'host-claude');
  const locatorPath = join(root, 'host-request-intent.json');
  const providerName = 'HostProvider' + owner.replaceAll('-', ''), mcpName = 'host-mcp-' + owner.replaceAll('-', '');
  let locator;
  if (phase === 'write') {
    assert.equal(await exists(locatorPath), false);
    for (const directory of [profile, workspace, source]) await mkdir(directory);
    const baseline = { credential_store: 'keyring', mcp_servers: [], providers: {} };
    await writeFile(join(profile, 'settings.json'), JSON.stringify(baseline), { flag: 'wx' });
    const marker = join(workspace, 'source-program-must-not-run.marker');
    const sourceDoc = { model: 'fixture', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: supplied.provider },
      mcpServers: { docs: { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value ran`], env: { TOKEN: supplied.mcp } } } };
    await writeFile(join(source, 'settings.json'), JSON.stringify(sourceDoc), { flag: 'wx' });
    await writeFile(join(source, 'auth.json'), supplied.canary, { flag: 'wx' });
    await writeFile(join(root, 'host-source-digests.json'), JSON.stringify({ owner, providerSha256: hash(supplied.provider), mcpSha256: hash(supplied.mcp) }), { flag: 'wx' });
    locator = { version: 1, owner, sourceHash: hash(await readFile(join(source, 'settings.json'))), canaryHash: hash(supplied.canary),
      jobId: null, planId: null, applySequence: null, applyRequestId: randomUUID(), undoRequestId: randomUUID(), applyMayHaveRun: false, baseline };
    await save(locatorPath, locator, true);
    const binding = await native('--host-bind'); assert.equal(binding.bound, true);
    assert.equal(binding.storageQuerySucceeded, true); assert.equal(binding.storageFileNodesKnown, false);
    locator.storageQuerySucceeded = true; locator.storageFileNodesKnown = false; await save(locatorPath, locator);
  } else {
    locator = await checkedJson(locatorPath); assert.equal(locator.owner, owner); assert.equal(locator.version, 1);
  }

  let child = null, client = null, failure, processes = 0, requests = 0;
  let stderrTail = '', leaked = false;
  const inspect = text => {
    for (const secret of secrets) if (text.includes(secret)) leaked = true;
    assert.equal(leaked, false, 'host_output_plaintext_leak');
  };
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PATH', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemDrive']
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  Object.assign(environment, { KCODER_CONFIG_DIR: profile, CLAUDE_CONFIG_DIR: source, HOME: root, CODEX_HOME: join(root, 'unused-codex'),
    TEMP: workspace, TMP: workspace, NO_COLOR: '1' });
  const rpc = async (method, params = {}, allowError = false) => {
    assert.ok(method === 'initialize' || method.startsWith('migration/') || method === 'mcp/list'); requests++;
    const frame = await client.request(method, params, 15000); inspect(JSON.stringify(frame));
    if (!allowError) assert.equal(frame.error, undefined, 'host_rpc_error');
    return allowError ? frame : frame.result;
  };
  const stop = async () => {
    if (!child) return;
    child.stdin.end(); await waitForStdioChildClose(child, 10000, 'owned keyring Native Host');
    assert.equal(child.exitCode, 0); assert.equal(leaked, false); child = null; client = null;
  };
  const start = async () => {
    assert.equal(child, null);
    // The outer suspended-process C# Job owns this complete inherited descendant tree.
    child = spawn(cli, ['--cwd', workspace, 'app-server'], { cwd: workspace, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    processes++; child.stderr.on('data', data => { const text = stderrTail + data.toString('utf8');
      for (const secret of secrets) if (text.includes(secret)) leaked = true; stderrTail = text.slice(-128); });
    client = new AppServerStdioClient('owned-windows-keyring-host', child, { defaultTimeoutMs: 15000 });
    const original = client.onLine.bind(client); client.onLine = line => { inspect(line); original(line); };
    const info = await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-windows-keyring-host', version: '1' } });
    for (const name of ['migrationCredentialsV1', 'migrationMcpCredentialsV1', 'migrationBatchMcpCredentialsV1']) assert.equal(info.capabilities.experimental[name], true);
  };
  const read = async () => rpc('migration/read', { jobId: locator.jobId });
  const audit = async () => { const value = await native('--host-capture'); assert.equal(value.nativeHostPublishedBindingsVerified, true); return value; };
  const undo = async () => {
    const current = await read();
    if (current.job.status !== 'rolled_back') {
      const value = await rpc('migration/batch/rollback', { jobId: locator.jobId, planId: locator.planId,
        requestId: locator.undoRequestId, expectedSequence: current.job.sequence });
      assert.equal(value.job.status, 'rolled_back');
    }
    const privateRead = await rpc('migration/batch/mcp/credential/read', { jobId: locator.jobId });
    assert.ok(privateRead.plans.length === 1 && privateRead.plans.every(plan => plan.phase === 'undone'));
  };

  try {
    if (phase === 'write') {
      await start(); assert.deepEqual((await rpc('mcp/list')).servers, []);
      const found = await rpc('migration/discover', { sources: ['claude-code'] }); assert.equal(found.sources.length, 1);
      const scanned = await rpc('migration/batch/scan', { sourceIds: [found.sources[0].sourceId] }); locator.jobId = scanned.job.jobId; await save(locatorPath, locator);
      const items = await rpc('migration/items', { jobId: locator.jobId }); assert.equal(items.providers.length, 1); assert.equal(items.mcps.length, 1);
      const parameters = { jobId: locator.jobId, expectedSequence: scanned.job.sequence,
        choices: [{ kind: 'provider', itemId: items.providers[0].itemId, targetName: providerName, contextWindowTokens: 64000, outputHeadroomTokens: 8192, maxOutputTokens: 8192 },
          { kind: 'mcp', itemId: items.mcps[0].itemId, targetName: mcpName, enableAfterImport: false }],
        credentials: [{ itemId: items.providers[0].itemId, source: 'configuration', consentApiKey: false }],
        mcpCredentials: [{ itemId: items.mcps[0].itemId, fields: [{ kind: 'environment', name: 'TOKEN' }], consentPrivateValues: true }] };
      assert.equal((await rpc('migration/batch/plan', parameters, true)).error?.message, 'migration_credential_consent_required');
      assert.equal((await read()).job.sequence, scanned.job.sequence);
      parameters.credentials[0].consentApiKey = true; parameters.mcpCredentials[0].consentPrivateValues = false;
      assert.equal((await rpc('migration/batch/plan', parameters, true)).error?.message, 'migration_mcp_private_consent_required');
      assert.equal((await read()).job.sequence, scanned.job.sequence);
      parameters.mcpCredentials[0].consentPrivateValues = true;
      const planned = await rpc('migration/batch/plan', parameters);
      assert.equal(planned.batch.credentialActions, 2); assert.equal(planned.batch.atomicCredentials, true);
      const privatePlan = await rpc('migration/batch/mcp/credential/read', { jobId: locator.jobId });
      assert.equal(privatePlan.plans.length, 1);
      for (const method of ['migration/mcp/credential/apply', 'migration/mcp/credential/undo']) {
        const rejected = await rpc(method, { jobId: locator.jobId, expectedSequence: planned.job.sequence, planId: privatePlan.plans[0].planId }, true);
        assert.equal(rejected.error?.message, 'migration_credential_group_operation_required');
      }
      locator.planId = planned.batch.planId; locator.applySequence = planned.job.sequence; locator.applyMayHaveRun = true; await save(locatorPath, locator);
      const discarded = await client.sendWithoutWaitingForResponse('migration/batch/apply', { jobId: locator.jobId, planId: locator.planId,
        requestId: locator.applyRequestId, expectedSequence: locator.applySequence });
      const deadline = Date.now() + 20000; let published;
      do { published = await read(); if (published.batch?.publishedCredentials === 2) break; assert.ok(Date.now() < deadline); await pause(); } while (true);
      assert.equal(published.batch.committedActions, published.batch.totalActions);
      // The workflow reconciles through read; this only checks that the harness discarded the late reply.
      await client.waitForDiscardedResponse(discarded);
      assert.ok(client.discardedResponseIds.includes(discarded));
      const proof = await audit(); assert.equal(proof.mcpDisabled, true);
      await noSecrets(profile, secrets); assert.equal(await exists(join(workspace, 'source-program-must-not-run.marker')), false);
      await stop();
      return { status: 'passed', stage: 'native_host_group_published_pending_independent_reopen', hostMigrationVerified: true,
        storageQuerySucceeded: locator.storageQuerySucceeded, storageFileNodesKnown: locator.storageFileNodesKnown,
        forcedKeyring: true, publishedCredentials: 2, providerAndMcpSameGroup: true, explicitConsentEnforced: true,
        applyReceiptDiscardedAndReadReconciled: true, nativeAudit: proof, targetFilesAndRpcContainNoOriginalValues: true,
        oldSourceToolsExecuted: 0, modelTurnsStarted: 0, appServerProcessesClosed: processes, rpcRequests: requests };
    }
    if (phase === 'reopen') {
      await rename(source, join(root, 'host-claude-retired'));
      await start(); const current = await read(); assert.equal(current.batch.publishedCredentials, 2);
      await audit();
      const repeated = await rpc('migration/batch/apply', { jobId: locator.jobId, planId: locator.planId,
        requestId: locator.applyRequestId, expectedSequence: locator.applySequence });
      assert.equal(repeated.job.sequence, current.job.sequence); assert.equal(repeated.batch.publishedCredentials, 2);
      await undo(); await noSecrets(profile, secrets); await stop();
      const proof = await native('--host-final'); assert.equal(proof.originalReferencesUndone, true);
      assert.equal(hash(await readFile(join(root, 'host-claude-retired', 'settings.json'))), locator.sourceHash);
      assert.equal(hash(await readFile(join(root, 'host-claude-retired', 'auth.json'))), locator.canaryHash);
      assert.equal(await exists(join(workspace, 'source-program-must-not-run.marker')), false);
      return { status: 'passed', stage: 'native_host_reopened_source_offline_and_rolled_back', independentHostReopen: true,
        originalRequestReceiptReconciled: true, sourceOfflineUndo: true, nativeAudit: proof,
        targetFilesAndRpcContainNoOriginalValues: true, sourceBytesUnchanged: true, oldSourceToolsExecuted: 0,
        modelTurnsStarted: 0, appServerProcessesClosed: processes, rpcRequests: requests };
    }
    if (!locator.applyMayHaveRun) return native('--host-unused-final');
    // A failed caller can only revoke its confirmed original publication, never replay apply.
    await start(); const current = await read();
    if (current.job.status !== 'rolled_back') {
      assert.equal(current.batch.publishedCredentials, 2, 'host_publication_unknown_retain_original_intent');
      await audit(); await undo();
    }
    await stop(); const final = await native('--host-final');
    assert.equal(final.systemEntryAbsenceVerified, true); await noSecrets(profile, secrets);
    return { ...final, hostScope: true, appServerProcessesClosed: processes, rpcRequests: requests };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await stop(); } catch { if (!failure) throw Error('host_process_close_unconfirmed'); }
    // No errors, frames, environment or source values are emitted by this worker.
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'host-probe.mjs') {
  const [phase, root, owner, expectedRoot, handoff] = process.argv.slice(2);
  try { console.log(JSON.stringify(await runHostProbe({ phase, root, owner, expectedRoot, handoff }))); }
  catch { console.error('owned_native_host_probe_failed'); process.exitCode = 2; }
}
