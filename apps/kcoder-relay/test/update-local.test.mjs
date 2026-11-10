import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preflightLocalUpdate, updateLocalGateway, verifyLocalUpdate } from '../src/update-local.mjs';
import { sha256 } from '../src/local-update-files.mjs';
import { createMobileWebStatic } from '../../kcoder-studio/src/mobile-web-static.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kc-relay-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = async (path, text, mode = 0o600) => { await mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); await writeFile(path, text, { mode }); };
  const source = join(root, 'release'); await mkdir(source);
  await file(join(source, '.gitignore'), 'node_modules/\ntarget\n');
  for (const name of ['apps/kcoder-relay/src/gateway.mjs', 'apps/kcoder-relay/src/client.mjs', 'apps/kcoder-studio/dev-server.mjs']) await file(join(source, name), '// owned fake release\n');
  for (const dependency of ['jsonc-parser', 'ssh2', 'ws']) {
    await file(join(source, 'node_modules', dependency, 'package.json'), JSON.stringify({ name: dependency, main: 'index.js' }));
    await file(join(source, 'node_modules', dependency, 'index.js'), 'module.exports = {};\n');
  }
  const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init','-q']); git(['add', '.']); git(['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-qm','owned fixture']);
  const configDir = join(root, 'config'); await mkdir(configDir, { mode: 0o700 });
  await file(join(configDir, 'settings.json'), '{"version":4}\n');
  const binary = join(root, 'kcoder'); await file(binary, '#!/bin/sh\nexit 0\n', 0o700);
  const envFile = join(root, 'existing.env'); const token = 'pairing-token-fixture-'.repeat(3);
  await file(envFile, `KCODER_RELAY_PUBLIC_URL=https://relay.invalid:8451\nKCODER_RELAY_LOCAL_GATEWAY=http://127.0.0.1:4186\nKCODER_RELAY_GATEWAY_SECRET=${token}\nKCODER_RELAY_CONFIG_DIR=/old/config\nKCODER_RELAY_KCODER_BIN=/old/kcoder\n`);
  const identityFile = join(root, 'identity.json');
  await file(identityFile, JSON.stringify({ version: 1, relayOrigin: 'https://relay.invalid:8451', gatewaySecretHash: sha256(token), id: 'existing-gateway', secret: 'identity-secret-fixture-'.repeat(3) }));
  const serversFile = join(root, 'servers.json');
  const originalServers = [{ id: 'local', label: 'Keep label', transport: 'local', workspace: root, command: '/old/immutable/kcoder', extra: 'keep' }, { id: 'remote', transport: 'ssh', workspace: '/peer', hostname: 'peer.invalid' }];
  await file(serversFile, JSON.stringify(originalServers));
  await chmod(serversFile, 0o664); // Existing install-local uses the caller's normal umask.
  const mobileRoot = join(root, 'mobile'); await mkdir(mobileRoot);
  const content = { 'index.html': '<html><script src="/__kcoder_mobile_mount_v1__/main.js"></script></html>', 'main.js': 'const base="/__kcoder_mobile_mount_v1__";', 'style.css': 'body { color: black; }' };
  for (const [name, bytes] of Object.entries(content)) await file(join(mobileRoot, name), bytes);
  const manifest = { version: 1, baseToken: '/__kcoder_mobile_mount_v1__', files: Object.entries(content).map(([path, bytes]) => ({ path, size: Buffer.byteLength(bytes), sha256: sha256(bytes), text: true, replacements: bytes.split('/__kcoder_mobile_mount_v1__').length - 1 })) };
  const manifestBytes = JSON.stringify(manifest); await file(join(mobileRoot, 'kcoder-mobile-web.json'), manifestBytes);
  const unitsDir = join(root, 'units'); await mkdir(unitsDir);
  for (const name of ['fixture-gateway.service', 'fixture-client.service']) await file(join(unitsDir, name), `[Service]\nExecStart=/bin/true\n# original ${name}\n`);
  const options = { source, sourceCommit: git(['rev-parse', 'HEAD']), envFile, configDir, serversFile, binary, binarySha256: sha256(await readFile(binary)), mobileRoot, mobileManifestSha256: sha256(manifestBytes), identityFile, unitsDir, node: realpathSync(process.execPath), localServerId: 'local', gatewayUnit: 'fixture-gateway.service', clientUnit: 'fixture-client.service' };
  const calls = []; const active = new Map([[options.gatewayUnit, true], [options.clientUnit, false]]);
  let failOperation; let validationCode = 0;
  const run = async (command, args, opts) => {
    calls.push({ command, args, opts });
    if (command === 'git') return { code: 0, stdout: git(args.slice(2)) };
    if (command === binary) { assert.deepEqual(args, ['config', 'validate']); assert.equal(opts.env.KCODER_CONFIG_DIR, configDir); assert.equal(opts.cwd, root); return { code: validationCode, stdout: '' }; }
    assert.equal(command, 'systemctl'); assert.equal(args[0], '--user');
    if (failOperation && failOperation(args)) return { code: 1, stdout: '' };
    if (args[1] === 'show') return { code: 0, stdout: active.get(args.at(-1)) ? 'active\n' : 'inactive\n' };
    if (['restart', 'start', 'stop'].includes(args[1])) active.set(args[2], args[1] !== 'stop');
    return { code: 0, stdout: '' };
  };
  const preserved = async () => Promise.all([envFile, identityFile, serversFile, join(configDir, 'settings.json')].map(path => readFile(path, 'utf8')));
  return { root, options, run, calls, active, originalServers, preserved, validation: code => { validationCode = code; }, fail: predicate => { failOperation = predicate; }, file, git };
}

test('check-only preflight validates config without any service or state write; inferred path mode is retained', async t => {
  const f = await fixture(t); const before = await f.preserved();
  const plan = await preflightLocalUpdate(f.options, { run: f.run });
  assert.equal(plan.gatewayId, 'existing-gateway'); assert.deepEqual(await f.preserved(), before);
  assert.equal(f.calls.filter(call => call.command === 'systemctl').length, 0);
  assert.equal((await readdir(f.options.source)).includes('target'), false);
  assert.deepEqual(await readdir(f.options.unitsDir), [f.options.clientUnit, f.options.gatewayUnit]);
});
test('config-v4 rejection is before lock, backup, units and release server copy', async t => {
  const f = await fixture(t); f.validation(1); const before = await f.preserved();
  await assert.rejects(updateLocalGateway(f.options, { run: f.run }), /config-validation/);
  assert.deepEqual(await f.preserved(), before); assert.equal(f.calls.some(call => call.command === 'systemctl'), false);
  assert.equal((await readdir(f.options.source)).includes('target'), false);
  assert.equal((await readdir(f.options.unitsDir)).length, 2);
});
test('commit preserves original servers/workspace/identity, units reference only paths and canonical release-owned server copy', async t => {
  const f = await fixture(t); const before = await f.preserved();
  const sharedTarget = join(f.root, 'shared-target'); await mkdir(sharedTarget); await symlink(sharedTarget, join(f.options.source, 'target'));
  const result = await updateLocalGateway(f.options, { run: f.run, healthCheck: async () => ({ authenticated: true }) });
  const receipt = JSON.parse(await readFile(result.receiptFile, 'utf8')); assert.equal(receipt.status, 'committed');
  assert.ok(receipt.serversFile.startsWith(sharedTarget + '/')); assert.equal(await stat(result.receiptFile).then(info => info.mode & 0o777), 0o600);
  const effective = JSON.parse(await readFile(receipt.serversFile, 'utf8'));
  assert.deepEqual(effective, f.originalServers.map(server => server.id === 'local' ? { ...server, command: f.options.binary } : server));
  assert.deepEqual(await f.preserved(), before);
  assert.equal((await stat(f.options.serversFile)).mode & 0o777, 0o664);
  for (const name of receipt.units) {
    const unit = await readFile(join(f.options.unitsDir, name), 'utf8');
    assert.ok(unit.includes(`WorkingDirectory=${f.options.source}\n`)); assert.doesNotMatch(unit, /WorkingDirectory="/);
    for (const key of ['KCODER_RELAY_ENV_FILE', 'KCODER_RELAY_IDENTITY_FILE', 'KCODER_RELAY_CONFIG_DIR', 'KCODER_RELAY_KCODER_BIN', 'KCODER_RELAY_SERVERS_FILE', 'KCODER_STUDIO_MOBILE_WEB_ROOT']) assert.ok(unit.includes(`${key}=`));
    assert.doesNotMatch(unit, /pairing-token-fixture|identity-secret-fixture/);
  }
  assert.doesNotMatch(JSON.stringify(receipt), /pairing-token-fixture|identity-secret-fixture/);
  assert.deepEqual(f.calls.filter(call => call.command === 'systemctl' && call.args[1] === 'restart').map(call => call.args[2]), receipt.units);
  assert.equal((await readdir(f.options.unitsDir)).includes('.kcoder-relay-update.lock'), false);
  // Exercise actual systemd parsing offline; no user service is touched.
  execFileSync('systemd-analyze', ['verify', '--man=no', ...receipt.units.map(name => join(f.options.unitsDir, name))], { stdio: ['ignore', 'pipe', 'pipe'] });
});
test('restart failure restores exact old units and prior active/inactive states', async t => {
  const f = await fixture(t); const before = await f.preserved();
  const old = await Promise.all([f.options.gatewayUnit, f.options.clientUnit].map(name => readFile(join(f.options.unitsDir, name), 'utf8')));
  f.fail(args => args[1] === 'restart' && args[2] === f.options.clientUnit);
  await assert.rejects(updateLocalGateway(f.options, { run: f.run }), /rolled-back/);
  assert.deepEqual(await Promise.all([f.options.gatewayUnit, f.options.clientUnit].map(name => readFile(join(f.options.unitsDir, name), 'utf8'))), old);
  assert.deepEqual(await f.preserved(), before); assert.equal(f.active.get(f.options.gatewayUnit), true); assert.equal(f.active.get(f.options.clientUnit), false);
  const tx = (await readdir(join(f.options.source, 'target')))[0];
  assert.equal(JSON.parse(await readFile(join(f.options.source, 'target', tx, 'receipt.json'), 'utf8')).status, 'rolled-back');
});
test('cancellation after unit write restores old state and records cancelled without interrupting rollback', async t => {
  const f = await fixture(t); let cancelled = false;
  const run = async (...args) => { const result = await f.run(...args); if (args[0] === 'systemctl' && args[1][1] === 'daemon-reload') cancelled = true; return result; };
  await assert.rejects(updateLocalGateway(f.options, { run, checkCancelled: () => { if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'UPDATE_CANCELLED' }); } }), /rolled-back/);
  assert.equal(f.active.get(f.options.gatewayUnit), true); assert.equal(f.active.get(f.options.clientUnit), false);
  const tx = (await readdir(join(f.options.source, 'target')))[0]; const receipt = JSON.parse(await readFile(join(f.options.source, 'target', tx, 'receipt.json'), 'utf8'));
  assert.equal(receipt.cancelled, true); assert.equal(receipt.rollbackErrors.length, 0); assert.equal((await readdir(f.options.unitsDir)).length, 2);
});
test('rollback failure remains explicit and concurrent lock is never stolen', async t => {
  const f = await fixture(t); const lock = join(f.options.unitsDir, '.kcoder-relay-update.lock'); await mkdir(lock, { mode: 0o700 });
  await assert.rejects(updateLocalGateway(f.options, { run: f.run }), { code: 'EEXIST' }); assert.equal((await stat(lock)).isDirectory(), true); await rm(lock, { recursive: true });
  f.fail(args => args[1] === 'restart' || args[1] === 'start');
  await assert.rejects(updateLocalGateway(f.options, { run: f.run }), /rollback-incomplete/);
  const tx = (await readdir(join(f.options.source, 'target')))[0];
  const receipt = JSON.parse(await readFile(join(f.options.source, 'target', tx, 'receipt.json'), 'utf8')); assert.deepEqual(receipt.rollbackErrors, [`start:${f.options.gatewayUnit}`]);
  assert.equal((await stat(lock)).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).transaction, join(f.options.source, 'target', tx));
  const calls = f.calls.filter(call => call.command === 'systemctl').length;
  const units = await Promise.all(receipt.units.map(name => readFile(join(f.options.unitsDir, name), 'utf8')));
  await assert.rejects(updateLocalGateway(f.options, { run: f.run }), { code: 'EEXIST' });
  assert.equal(f.calls.filter(call => call.command === 'systemctl').length, calls);
  assert.deepEqual(await Promise.all(receipt.units.map(name => readFile(join(f.options.unitsDir, name), 'utf8'))), units);
});
test('source, dependencies, runtime, artifacts and configuration overrides refuse before writes', async t => {
  for (const fault of ['dirty', 'dependency', 'binary', 'manifest', 'identity', 'node', 'store', 'inline', 'settings', 'profile', 'public-access', 'during-validation']) {
    const f = await fixture(t);
    if (fault === 'dirty') await f.file(join(f.options.source, 'apps/kcoder-relay/src/client.mjs'), '// changed\n');
    if (fault === 'dependency') await rm(join(f.options.source, 'node_modules/ssh2'), { recursive: true });
    if (fault === 'binary') f.options.binarySha256 = '0'.repeat(64);
    if (fault === 'manifest') await f.file(join(f.options.mobileRoot, 'main.js'), 'changed');
    if (fault === 'identity') await f.file(f.options.identityFile, JSON.stringify({ version: 1, relayOrigin: 'https://other.invalid', gatewaySecretHash: '0'.repeat(64), id: 'peer', secret: 'secret-fixture-'.repeat(4) }));
    if (fault === 'node') f.options.node = f.options.binary;
    if (fault === 'public-access') await f.file(f.options.envFile, await readFile(f.options.envFile, 'utf8') + 'KCODER_STUDIO_PUBLIC_ACCESS_URL=https://relay.invalid:8451/g/wrong-id\n');
    if (fault === 'store' || fault === 'inline') await f.file(f.options.envFile, await readFile(f.options.envFile, 'utf8') + `KCODER_STUDIO_SERVERS${fault === 'store' ? '_STORE' : ''}=unsupported-override\n`);
    if (fault === 'settings' || fault === 'profile') { const servers = structuredClone(f.originalServers); servers[0][fault === 'settings' ? 'settingsFile' : 'profile'] = 'other'; await f.file(f.options.serversFile, JSON.stringify(servers)); }
    const run = async (...args) => { const result = await f.run(...args); if (fault === 'during-validation' && args[0] === f.options.binary) await f.file(join(f.options.source, 'apps/kcoder-relay/src/gateway.mjs'), '// drift during validation\n'); return result; };
    const units = await Promise.all([f.options.gatewayUnit, f.options.clientUnit].map(name => readFile(join(f.options.unitsDir, name), 'utf8')));
    await assert.rejects(updateLocalGateway(f.options, { run })); assert.equal(f.calls.some(call => call.command === 'systemctl'), false); assert.equal((await readdir(f.options.unitsDir)).length, 2);
    assert.deepEqual(await Promise.all([f.options.gatewayUnit, f.options.clientUnit].map(name => readFile(join(f.options.unitsDir, name), 'utf8'))), units);
  }
});
test('cleanup preserves a lock directory replaced by another owner', async t => {
  const f = await fixture(t); const lock = join(f.options.unitsDir, '.kcoder-relay-update.lock');
  await updateLocalGateway(f.options, { run: f.run, healthCheck: async () => {
    await rename(lock, join(f.root, 'original-owned-lock')); await mkdir(lock, { mode: 0o700 });
    await f.file(join(lock, 'owner.json'), '{"owner":"replacement"}\n'); return { authenticated: true };
  } });
  assert.equal(await readFile(join(lock, 'owner.json'), 'utf8'), '{"owner":"replacement"}\n');
});
test('health checks use authenticated APIs and actual signed-mount HTTP resource bytes, then delete only their owned session', async t => {
  const f = await fixture(t); const plan = await preflightLocalUpdate(f.options, { run: f.run }); const calls = [];
  let corruptRegistration = false;
  let serve = createMobileWebStatic({ root: f.options.mobileRoot, publicOrigins: new Set([plan.publicUrl.origin]), publicAccessUrl: new URL(`${plan.publicUrl.origin}/g/${plan.gatewayId}`), pairingToken: plan.env.KCODER_RELAY_GATEWAY_SECRET, contentSecurityPolicy: "script-src 'self'", directPort: () => server.address().port });
  const server = createServer(async (request, response) => {
    calls.push({ path: request.url, method: request.method, authorization: request.headers.authorization });
    if (corruptRegistration && request.url === '/mobile/') {
      const end = response.end.bind(response);
      response.end = body => {
        const original = Buffer.from(body).toString('utf8');
        const corrupted = original.replace('serviceWorker', 'serviceWorxer');
        assert.notEqual(corrupted, original, 'the real Gateway response must contain the registered offline mechanism');
        return end(Buffer.from(corrupted));
      };
    }
    if (request.url === '/api/mobile/pairing/relay') {
      assert.equal(request.headers['x-kcoder-relay-validation'], plan.env.KCODER_RELAY_GATEWAY_SECRET);
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ kind: 'temporary', token: 'f'.repeat(64), expiresAt: Date.now() + 60000,
        publicBaseUrl: plan.publicUrl.origin + '/g/' + plan.gatewayId,
        connectionRoutes: { version: 1, gatewayId: 'a'.repeat(64), publicKey: 'b'.repeat(64), endpoints: [{ kind: 'public', url: plan.publicUrl.origin + '/g/' + plan.gatewayId }] } })); return;
    }
    if (request.url === '/api/mobile/session') {
      if (request.method === 'POST') { for await (const _ of request) {} response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ accessToken: 'owned-health-session' })); }
      else { assert.equal(request.headers.authorization, 'Bearer owned-health-session'); response.writeHead(204); response.end(); } return;
    }
    if (request.url === '/api/servers') { assert.equal(request.headers.authorization, 'Bearer owned-health-session'); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ servers: plan.effectiveServers })); return; }
    if (!await serve(request, response, new URL(request.url, 'http://localhost').pathname)) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  plan.endpoint = new URL(`http://127.0.0.1:${server.address().port}`);
  plan.env.KCODER_RELAY_LOCAL_GATEWAY = plan.endpoint.origin;
  const result = await verifyLocalUpdate(plan);
  assert.equal(result.authenticated, true); assert.deepEqual(result.mobileResources, ['index.html', 'main.js', 'style.css']);
  assert.equal(calls.at(-1).method, 'DELETE'); assert.equal(calls.filter(call => call.path === '/api/servers')[0].authorization, 'Bearer owned-health-session');
  corruptRegistration = true;
  await assert.rejects(verifyLocalUpdate(plan), /Served Mobile resource differs from release/);
  assert.equal(calls.at(-1).method, 'DELETE', 'a mismatched resource still releases only the owned health session');
  corruptRegistration = false;
  const sessions = calls.filter(call => call.path === '/api/mobile/session').length;
  serve = createMobileWebStatic({ root: f.options.mobileRoot, publicOrigins: new Set([plan.publicUrl.origin]), pairingToken: plan.env.KCODER_RELAY_GATEWAY_SECRET, contentSecurityPolicy: "script-src 'self'", directPort: () => server.address().port });
  await assert.rejects(verifyLocalUpdate(plan), /Expected values to be strictly equal/);
  assert.equal(calls.filter(call => call.path === '/api/mobile/session').length, sessions, 'wrong unsigned presentation fails before session creation');
});
