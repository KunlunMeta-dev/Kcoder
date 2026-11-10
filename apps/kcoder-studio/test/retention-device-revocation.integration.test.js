import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createMobileDeviceAuth, mobileDeviceStoreIdentity } from '../src/mobile-device-auth.js';
import { localRetentionRoute } from '../src/retention-device-revocation.js';
import { loadServers, storedServer } from '../src/server-config.js';
import { retentionTargetFingerprint } from '../src/retention-context.js';

const binary = process.env.KCODER_RETENTION_TEST_BIN;
const expectedBinarySha = process.env.KCODER_RETENTION_TEST_BIN_SHA256;
const studio = fileURLToPath(new URL('..', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = () => new Promise(done => setTimeout(done, 25));
async function bounded(predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await delay(); }
  throw new Error(`Timed out: ${label}`);
}
function managedChild(t, command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { if (stderr.length < 16_384) stderr += chunk; });
  const exited = once(child, 'close');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000); timeout.unref();
    try { await exited; } finally { clearTimeout(timeout); }
  };
  t.after(stop);
  return { child, stop, stderr: () => stderr };
}
function jsonl(process) {
  const pending = new Map(); let id = 0;
  createInterface({ input: process.child.stdout }).on('line', line => {
    const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id);
  });
  return async (method, params = {}, context) => {
    const requestId = ++id;
    const message = { jsonrpc: '2.0', id: requestId, method, params };
    if (context) { message.kcoderPrivateRetention = { version: 1, context, workspaceTargetId: 'local' }; message.params = { ...params, trustedContext: context }; }
    const response = new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`stdio ${method} failed: ${process.stderr()}`)); }, 10_000);
      pending.set(requestId, value => { clearTimeout(timer); done(value); });
    });
    process.child.stdin.write(`${JSON.stringify(message)}\n`);
    return response;
  };
}

test('LocalOs durable revocation traverses actual Gateway and Rust stdio; pending original jobs survive restart', {
  skip: process.platform !== 'linux' || !binary || !expectedBinarySha, timeout: 90_000,
}, async t => {
  assert.equal(digest(await readFile(binary)), expectedBinarySha);
  const root = await mkdtemp(join(tmpdir(), 'kc-revoke-stdio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'), workspace = join(root, 'workspace'), store = join(root, 'gateway', 'servers.json');
  await mkdir(config, { mode: 0o700 }); await mkdir(workspace); await mkdir(dirname(store), { mode: 0o700 });
  const settings = join(config, 'settings.json');
  await writeFile(settings, JSON.stringify({ active_provider: 'offline', providers: { offline: {
    api_format: 'openai_chat_completions', endpoint: 'http://127.0.0.1:1/v1', default_model: 'never-called',
    context_window_tokens: 128000, output_headroom_tokens: 8192, max_output_tokens: 8192, no_proxy: true,
  } } }));
  const token = 'owned-revocation-gateway-token';
  const draft = { id: 'local', label: 'Local', runtime: 'kcoder', transport: 'local', command: resolve(binary), workspace, settingsFile: settings };
  await writeFile(store, JSON.stringify([draft]));
  const [target] = await loadServers({ env: { KCODER_STUDIO_SERVERS_STORE: store }, repoRoot: resolve(studio, '../..'), appServerBin: binary, workspace });
  const key = JSON.stringify([JSON.stringify(storedServer(target)), await realpath(workspace)]);
  const fingerprint = retentionTargetFingerprint(target, undefined, key);
  const auth = createMobileDeviceAuth({ directory: dirname(store), identity: mobileDeviceStoreIdentity(token) });
  const grants = []; for (let i = 0; i < 4; i++) grants.push(await auth.pair(`owned-${i}`));
  const verifier = await auth.privateRetentionVerifier();
  const route = localRetentionRoute({ targetId: 'local', targetFingerprint: fingerprint, workspacePath: await realpath(workspace) });
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, KCODER_CONFIG_DIR: config,
    KCODER_STUDIO_KCODER_BIN: binary, KCODER_STUDIO_WORKSPACE: workspace, KCODER_STUDIO_SERVERS_STORE: store,
    KCODER_STUDIO_AUTH_TOKEN: token, KCODER_STUDIO_PORT: '0', KCODER_STUDIO_HOST: '127.0.0.1',
    KCODER_STUDIO_TEST_DISABLE_AUTH: '0' };
  delete env.KCODER_HOME; delete env.KCODER_STUDIO_MOCK;
  delete env.KCODER_PRIVATE_RETENTION_PARENT_V1; delete env.KCODER_PRIVATE_RETENTION_VERIFIER_V1;
  const seed = managedChild(t, binary, ['--settings-file', settings, '--cwd', workspace, 'app-server', '--retention-parent-v1', 'local-os'], {
    env: { ...env, KCODER_PRIVATE_RETENTION_VERIFIER_V1: `v1.${Buffer.from(JSON.stringify(verifier)).toString('base64url')}` }, cwd: workspace,
  });
  const rpc = jsonl(seed);
  const initialized = await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'owned-retention-stdio', version: '1' } });
  assert.equal(initialized.result.capabilities.experimental.stagedAttachmentRetentionReceiptsV1, false);
  const admission = initialized.result.attachmentUploadAdmission; assert.equal(admission.version, 1);
  const uploads = [];
  for (let i = 0; i < 3; i++) {
    await auth.registerRetentionRoute({ deviceId: grants[i].deviceId, authorizationGeneration: grants[i].authorizationGeneration, route });
    const context = { gatewayNamespaceId: verifier.gatewayNamespaceId, deviceId: grants[i].deviceId,
      authorizationGeneration: grants[i].authorizationGeneration, targetFingerprint: fingerprint, principal: { kind: 'localOs' } };
    const nonce = String(i + 1).padStart(32, '0');
    const params = { ownerRequest: { clientOwnerRequestId: `o1.${admission.rootNamespace}.${admission.admissionEpoch}.${nonce}`, immutableParameters: { purpose: 'attachment-upload' } },
      clientUploadId: `u1.${admission.rootNamespace}.${admission.admissionEpoch}.${nonce}` };
    const bytes = Buffer.from(`owned-source-${i}`);
    const saved = await rpc('attachment/retention/upload/save', { ...params, filename: 'source.txt', size: bytes.length,
      contentSha256: digest(bytes), contentBase64: bytes.toString('base64') }, context);
    assert.equal(saved.result?.lookup.recovery.state, 'sealed', JSON.stringify(saved));
    const stage = saved.result.lookup.recovery.stageRef;
    const physical = join(config, 'attachment-retention-v1', 'data', `u-entry-${stage.entryId}`);
    assert.deepEqual(await readFile(physical), bytes, 'actual RootLeaf payload exists before cleanup');
    uploads.push({ context, params, stage, physical, bytes });
  }
  // A live stdio connection does not retain owner leases between RPCs.
  // Hold the exact manifest FDs in an owned helper to exercise actual Busy.
  const leases = uploads.map(upload => join(config, 'attachment-retention-v1', 'leases', `owner-v2-${upload.stage.ownerId}.manifest`));
  const leaseHolder = managedChild(t, 'python3', ['-c', String.raw`
import fcntl, os, sys
files = []
for path in sys.argv[1:]:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    files.append(fd)
print('leases-held', flush=True)
sys.stdin.buffer.read()
for fd in files:
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)
`, ...leases], { env, cwd: root });
  let leaseOutput = ''; leaseHolder.child.stdout.on('data', chunk => { leaseOutput += chunk; });
  await bounded(() => {
    assert.equal(leaseHolder.child.exitCode, null, leaseHolder.stderr());
    return leaseOutput.includes('leases-held');
  }, 'exact owned manifest leases held');
  async function gateway() {
    const process = managedChild(t, processExecPath, ['dev-server.mjs'], { env, cwd: studio });
    let output = ''; process.child.stdout.on('data', chunk => { output += chunk; });
    const base = await bounded(() => output.match(/KCoder Studio: (http:\/\/[^\s]+)/)?.[1], 'Gateway listener');
    return { ...process, base };
  }
  const processExecPath = process.execPath;
  const first = await gateway();
  const login = await fetch(`${first.base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  // Pairing was seeded in the durable store; establish the actual Gateway
  // in-memory transport sessions through its supported refresh endpoint.
  for (let i = 0; i < grants.length; i++) {
    const refreshed = await fetch(`${first.base}/api/mobile/session/refresh`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: grants[i].refreshToken, rotationId: `owned-stdio-refresh-${i}` }) });
    assert.equal(refreshed.status, 200);
    Object.assign(grants[i], await refreshed.json());
  }
  const commands = [
    ['/api/mobile/session', { authorization: `Bearer ${grants[0].accessToken}` }],
    [`/api/mobile/pairing/devices/${grants[1].deviceId}`, { cookie }],
    [`/api/mobile/devices/${grants[2].deviceId}`, { authorization: `Bearer ${grants[3].accessToken}` }],
  ];
  for (const [path, headers] of commands) {
    const response = await fetch(`${first.base}${path}`, { method: 'DELETE', headers: { ...headers, origin: first.base, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 204, path);
  }
  await bounded(async () => {
    const state = JSON.parse(await readFile(join(config, 'attachment-retention-v1', 'state'), 'utf8'));
    return Object.keys(state.device_revocations ?? {}).length === 3;
  }, 'all three actual Rust durable replay fences', 45_000);
  const pending = await auth.pendingRetentionRevocations();
  assert.equal(pending.length, 3, 'active original owner leases keep durable cleanup pending');
  const originalStatements = pending.map(job => job.statement).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  await first.stop(); await seed.stop(); await leaseHolder.stop();
  assert.deepEqual((await auth.pendingRetentionRevocations()).map(job => job.statement).sort((a, b) => a.deviceId.localeCompare(b.deviceId)), originalStatements);
  const second = await gateway();
  await bounded(async () => (await auth.pendingRetentionRevocations()).length === 0, 'actual trusted Rust cleanup completion after restart');
  for (let i = 0; i < 3; i++) {
    await assert.rejects(auth.refresh(grants[i].refreshToken, 'owned-revocation-refresh'));
    assert.deepEqual(await auth.revokeAndReadProof(grants[i].deviceId), originalStatements.find(value => value.deviceId === grants[i].deviceId));
  }
  await second.stop();
  const verify = managedChild(t, binary, ['--settings-file', settings, '--cwd', workspace, 'app-server', '--retention-parent-v1', 'local-os'], { env, cwd: workspace });
  const read = jsonl(verify); await read('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'readback', version: '1' } });
  for (const upload of uploads) {
    const response = await read('attachment/retention/upload/read', upload.params, upload.context);
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.equal(response.result?.lookup.outcome, 'present', JSON.stringify(response));
    assert.equal(response.result.lookup.recovery.state, 'cancelled', JSON.stringify(response));
    assert.equal(Object.hasOwn(response.result.lookup.recovery, 'stageRef'), false);
    await assert.rejects(readFile(upload.physical), { code: 'ENOENT' });
    const replay = await read('attachment/retention/upload/save', { ...upload.params, filename: 'source.txt', size: upload.bytes.length,
      contentSha256: digest(upload.bytes), contentBase64: upload.bytes.toString('base64') }, upload.context);
    assert.ok(replay.error, 'same revoked epoch cannot admit a fresh source after restart');
  }
  await verify.stop();
  assert.equal(digest(await readFile(binary)), expectedBinarySha);
});
