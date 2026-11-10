import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertAppIdentity, assertInstallAllowed, atomicJson, buildEnvironment, canonicalDeviceId, containedPath, executePhase, parseArgs, treeDigest, withRunLock } from './mobile-ios.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-ios-contract-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('CLI rejects ambiguous or injectable build/device identities', () => {
  for (const args of [
    ['--team', 'TEAM&<xml>'], ['--build-number', '1;echo'], ['--device', 'phone name'],
    ['--run', '/one', '--run', '/two'], ['--unknown'], ['--ref', '-h'], ['--run'],
  ]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(['--team', 'ABCDEFGHIJ', '--build-number', '2']).team, 'ABCDEFGHIJ');
});

test('build environment excludes tokens and inherited public Expo overrides', () => {
  const env = buildEnvironment({ HOME: '/home/test', PATH: '/bin', APPLE_PASSWORD: 'secret', EXPO_PUBLIC_GATEWAY: 'secret', KCODER_STUDIO_AUTH_TOKEN: 'secret', EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP: '1' });
  assert.equal(env.HOME, '/home/test');
  assert.equal(env.EXPO_NO_DOTENV, '1');
  assert.equal(env.EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP, undefined);
  assert.equal(JSON.stringify(env).includes('secret'), false);
  assert.equal(buildEnvironment({}, { 'allow-http': true }).EXPO_PUBLIC_KCODER_STUDIO_ALLOW_HTTP, '1');
});

test('run lock rejects a concurrent operator and releases only its own lock on failure', async t => {
  const run = await temporary(t);
  await withRunLock(run, async () => {
    assert.equal(JSON.parse(await readFile(join(run, '.operation-lock/owner.json'), 'utf8')).pid, process.pid);
    await assert.rejects(withRunLock(run, () => assert.fail('must not execute')), /locked/);
    assert.ok((await lstat(join(run, '.operation-lock'))).isDirectory());
  });
  await assert.rejects(withRunLock(run, () => { throw Error('owned failure'); }), /owned failure/);
  assert.equal((await readdir(run)).includes('.operation-lock'), false);
});

test('foreign symlinks and permissive run directories fail closed', async t => {
  const root = await temporary(t);
  const run = join(root, 'run');
  await mkdir(run, { mode: 0o700 });
  await writeFile(join(root, 'outside'), 'private');
  await symlink(join(root, 'outside'), join(run, 'escape'));
  await assert.rejects(containedPath(run, 'escape'), /escapes/);
  await assert.rejects(containedPath(run, '../outside'), /escapes/);
  await symlink(run, join(root, 'linked-run'));
  await assert.rejects(withRunLock(join(root, 'linked-run'), () => {}), /owned, private/);
  await chmod(run, 0o755);
  await assert.rejects(withRunLock(run, () => {}), /0700/);
});

test('receipt writes replace atomically and preserve private permissions', async t => {
  const run = await temporary(t);
  const path = join(run, 'receipt.json');
  await atomicJson(path, { installation: { status: 'unknown' } });
  await atomicJson(path, { installation: { status: 'installed' } });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).installation.status, 'installed');
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(run), ['receipt.json']);
});

test('artifact digest detects content and executable permission changes', async t => {
  const run = await temporary(t);
  const file = join(run, 'app');
  await writeFile(file, 'original', { mode: 0o600 });
  const initial = await treeDigest(run);
  await writeFile(file, 'tampered');
  assert.notEqual(await treeDigest(run), initial);
  await writeFile(file, 'original');
  assert.equal(await treeDigest(run), initial);
  await chmod(file, 0o700);
  assert.notEqual(await treeDigest(run), initial);
});

test('unknown and completed installation attempts cannot be blindly replayed', () => {
  assert.throws(() => assertInstallAllowed({}, 'phone-a'), /build/);
  assert.doesNotThrow(() => assertInstallAllowed({ built: {} }, 'phone-a'));
  for (const status of ['unknown', 'installed']) {
    const receipt = { built: {}, installations: { 'phone-a': { status } } };
    assert.throws(() => assertInstallAllowed(receipt, 'phone-a'), /never replayed/);
    assert.doesNotThrow(() => assertInstallAllowed(receipt, 'phone-b'));
  }
});

test('device aliases resolve to one canonical identity and ambiguous responses fail closed', () => {
  const udid = '00008120-00143c6228034032';
  const first = canonicalDeviceId({ result: { device: { identifier: 'core-device-id', hardwareProperties: { udid } } } });
  const second = canonicalDeviceId({ result: { hardwareProperties: { udid: udid.toUpperCase() } } });
  assert.equal(first, second);
  assert.throws(() => canonicalDeviceId({ result: {} }), /exactly one/);
  assert.throws(() => canonicalDeviceId([{ udid }, { udid: 'A'.repeat(40) }]), /exactly one/);
  assert.throws(() => assertInstallAllowed({ built: {}, installations: { [first]: { status: 'unknown' } } }, second), /never replayed/);
});

test('simulator, wrong bundle, wrong product version and wrong build cannot pass native identity check', () => {
  const valid = { CFBundleIdentifier: 'dev.kcoder.studio', CFBundleVersion: '2', CFBundleShortVersionString: '2.0.9', CFBundleSupportedPlatforms: ['iPhoneOS'] };
  const receipt = { productVersion: '2.0.9', buildNumber: '2' };
  assert.doesNotThrow(() => assertAppIdentity(valid, receipt));
  assert.throws(() => assertAppIdentity({ ...valid, CFBundleSupportedPlatforms: ['iPhoneSimulator'] }, receipt), /physical-device/);
  assert.throws(() => assertAppIdentity({ ...valid, CFBundleIdentifier: 'other.app' }, receipt), /identifier/);
  assert.throws(() => assertAppIdentity({ ...valid, CFBundleShortVersionString: '2.0.8' }, receipt), /product version/);
  assert.throws(() => assertAppIdentity(valid, { ...receipt, buildNumber: '3' }), /build number/);
});

test('all CLI entries expose help; dry-run does not create its run directory', async t => {
  const root = await temporary(t);
  const target = join(root, 'must-not-exist');
  const entries = ['prepare', 'build', 'export', 'install', 'deploy'];
  for (const entry of entries) {
    const path = fileURLToPath(new URL(`./${entry}_mobile_ios.mjs`, import.meta.url));
    const help = spawnSync(process.execPath, [path, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
  }
  const path = fileURLToPath(new URL('./deploy_mobile_ios.mjs', import.meta.url));
  const args = [path, '--run', target, '--team', 'ABCDEFGHIJ', '--build-number', '2', '--device', '00008120-00143C6228034032', '--dry-run'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).phases, ['prepare', 'build', 'install']);
  const exported = spawnSync(process.execPath, [...args, '--export-ipa'], { encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout).phases, ['prepare', 'build', 'export', 'install']);
  assert.deepEqual(await readdir(root), []);
});

test('installation persists uncertainty before device mutation and reconciles aliases without replay', async t => {
  const run = await temporary(t);
  const app = join(run, 'archive', 'App.app');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'main.jsbundle'), 'owned release fixture');
  const receipt = {
    schemaVersion: 1, sourceCommit: 'a'.repeat(40), team: 'ABCDEFGHIJ', buildNumber: '2', sourceFiles: {},
    built: { app: 'archive/App.app', appSha256: await treeDigest(app) },
  };
  await atomicJson(join(run, 'receipt.json'), receipt);
  const a = '00008120-00143C6228034032';
  const b = '00008120-00143C6228034033';
  let installations = 0;
  const context = {
    run, phase: 'install', env: {},
    async execute(executable, args) {
      if (executable === 'xcrun' && args.includes('details')) {
        const selected = args[args.indexOf('--device') + 1];
        await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({ result: { device: { hardwareProperties: { udid: selected === 'phone-b' ? b : a } } } }));
      } else if (executable === 'xcrun' && args.includes('install')) {
        installations += 1;
        const state = JSON.parse(await readFile(join(run, 'receipt.json'), 'utf8'));
        const selected = args[args.indexOf('--device') + 1] === 'phone-b' ? b : a;
        assert.equal(state.installations[selected].status, 'unknown', 'unknown must be durable before the device command');
        if (selected === a) throw Error('lost transport receipt after the device accepted installation');
      } else if (executable === 'xcrun' && args.includes('launch')) {
        throw Error('device locked after installation');
      } else if (executable === '/usr/bin/plutil') {
        if (args.at(-1).includes('entitlements-')) return JSON.stringify({ 'com.apple.developer.team-identifier': 'ABCDEFGHIJ' });
        if (args.includes('ExpirationDate')) return '<plist><date>2099-01-01T00:00:00Z</date></plist>';
        if (args.includes('ProvisionedDevices')) return JSON.stringify([a, b]);
        return JSON.stringify({ CFBundleIdentifier: 'dev.kcoder.studio', CFBundleVersion: '2', CFBundleSupportedPlatforms: ['iPhoneOS'] });
      }
      return '';
    },
  };
  await assert.rejects(executePhase(context, { device: 'phone-a' }), /lost transport/);
  assert.equal(JSON.parse(await readFile(join(run, 'receipt.json'), 'utf8')).installations[a].status, 'unknown');
  await assert.rejects(executePhase(context, { device: 'phone-a-other-alias' }), /never replayed/);
  assert.equal(installations, 1);
  await assert.rejects(executePhase(context, { device: 'phone-b', launch: true }), /device locked/);
  assert.equal(installations, 2);
  assert.equal(JSON.parse(await readFile(join(run, 'receipt.json'), 'utf8')).installations[b].status, 'installed');
});

test('changed archived bytes are rejected before the device installation command', async t => {
  const run = await temporary(t);
  const app = join(run, 'App.app');
  await mkdir(app);
  const bundle = join(app, 'main.jsbundle');
  await writeFile(bundle, 'original');
  await atomicJson(join(run, 'receipt.json'), {
    schemaVersion: 1, sourceCommit: 'a'.repeat(40), team: 'ABCDEFGHIJ', buildNumber: '2', sourceFiles: {},
    built: { app: 'App.app', appSha256: await treeDigest(app) },
  });
  await writeFile(bundle, 'changed');
  const context = { run, phase: 'install', env: {}, async execute(executable, args) {
    assert.equal(executable, 'xcrun');
    assert.ok(args.includes('details'), 'only the read-only device query may run');
    await writeFile(args[args.indexOf('--json-output') + 1], JSON.stringify({ udid: '00008120-00143C6228034032' }));
    return '';
  } };
  await assert.rejects(executePhase(context, { device: 'phone-a' }), /changed after verification/);
  assert.equal(JSON.parse(await readFile(join(run, 'receipt.json'), 'utf8')).installations, undefined);
});
