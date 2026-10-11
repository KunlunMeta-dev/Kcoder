import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  assertSupportedHost,
  copyReleaseSources,
  createBuildEnvironment,
  createGradleArguments,
  createGradleEnvironment,
  parseArgs,
  parseBadging,
  preflight,
  runCommand,
  replaceReleaseSigningConfig,
  validateApkMetadata,
} from './package_mobile_android.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-mobile-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function packageFixture(root) {
  const mobile = join(root, 'apps/kcoder-studio/mobile');
  const shared = join(root, 'apps/kcoder-studio/shared');
  const dependencies = join(mobile, 'node_modules');
  await mkdir(join(mobile, 'src'), { recursive: true });
  await mkdir(shared, { recursive: true });
  await mkdir(join(dependencies, 'expo/bin'), { recursive: true });
  await mkdir(join(dependencies, 'esbuild/bin'), { recursive: true });
  await mkdir(join(dependencies, 'tool/bin'), { recursive: true });
  await mkdir(join(dependencies, '.bin'), { recursive: true });
  await writeFile(join(mobile, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(join(mobile, 'app.json'), JSON.stringify({ expo: { android: { package: 'dev.test.mobile' } } }));
  await writeFile(join(mobile, 'src/app.ts'), 'export const app = true;');
  await writeFile(join(mobile, '.env.production'), 'MOBILE_SECRET=must-not-copy');
  await mkdir(join(mobile, 'android/app'), { recursive: true });
  await writeFile(join(mobile, 'android/app/build.gradle'), 'stale native output');
  await writeFile(join(dependencies, 'expo/bin/cli'), 'fixture cli');
  await writeFile(join(dependencies, 'esbuild/bin/esbuild'), 'fixture esbuild');
  await writeFile(join(dependencies, 'tool/bin/cli.js'), 'fixture dependency');
  await symlink('../tool/bin/cli.js', join(dependencies, '.bin/cli'));
  await writeFile(join(dependencies, '.env.private'), 'DEPENDENCY_SECRET=must-not-copy');
  await writeFile(join(shared, 'contract.ts'), 'export const shared = true;');
  await writeFile(join(shared, '.env.local'), 'SHARED_SECRET=must-not-copy');
  return { mobile, shared, dependencies };
}

test('CLI requires an explicit version code, keystore and key alias', () => {
  assert.doesNotThrow(() => assertSupportedHost('linux'));
  assert.doesNotThrow(() => assertSupportedHost('darwin'));
  assert.throws(() => assertSupportedHost('win32'), /Linux and macOS/);
  assert.throws(() => parseArgs([]), /--version-code is required/);
  assert.throws(() => parseArgs(['--version-code', '1']), /--keystore is required/);
  assert.throws(() => parseArgs(['--version-code', '1', '--keystore', 'release.jks']), /--key-alias is required/);
  assert.throws(() => parseArgs(['--version-code', '0', '--keystore', 'release.jks', '--key-alias', 'release']), /positive 32-bit integer/);
  assert.throws(() => parseArgs(['--version-code', '1', '--keystore', 'release.jks', '--key-alias', 'release', '--mystery']), /Unknown option/);
  assert.deepEqual(parseArgs(['--version-code=42', '--keystore', '/tmp/key.jks', '--key-alias', 'chosen', '--offline', '--dry-run']), {
    versionCode: 42, keystore: '/tmp/key.jks', keyAlias: 'chosen', offline: true, dryRun: true, help: false,
  });
});

test('build subprocess environment is allowlisted and signing secrets stay out of arguments', () => {
  const secret = 'secret-value-that-must-not-be-an-argument';
  const source = {
    PATH: '/usr/bin', ANDROID_HOME: '/sdk', HTTPS_PROXY: 'https://proxy.example:443',
    KCODER_STUDIO_ALLOW_HTTP: '1', EXPO_PUBLIC_GATEWAY_URL: 'http://mock.invalid',
    NODE_AUTH_TOKEN: secret, NPM_TOKEN: secret, UNRELATED_PRIVATE_VALUE: secret,
  };
  const env = createBuildEnvironment({ sdk: '/sdk', buildToolsDir: '/sdk/build-tools/35', javaHome: '/jdk' }, source, { privateDir: '/run-private', offline: true });
  assert.equal(env.EXPO_NO_DOTENV, '1');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.EXPO_OFFLINE, '1');
  assert.equal(env.NPM_CONFIG_USERCONFIG, '/run-private/npmrc.user');
  assert.equal(env.NPM_CONFIG_GLOBALCONFIG, '/run-private/npmrc.global');
  assert.equal(env.KCODER_STUDIO_ALLOW_HTTP, undefined);
  assert.equal(env.EXPO_PUBLIC_GATEWAY_URL, undefined);
  assert.equal(env.NODE_AUTH_TOKEN, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.UNRELATED_PRIVATE_VALUE, undefined);
  assert.ok(!Object.values(env).includes(secret));
  assert.throws(() => createBuildEnvironment({}, { HTTPS_PROXY: `https://user:${secret}@proxy.example` }), error => error.message.includes('embedded credentials') && !error.message.includes(secret));

  const gradleEnv = createGradleEnvironment(env, { keystoreCopy: '/private/key.jks', keyAlias: 'chosen' }, {
    KCODER_ANDROID_KEYSTORE_PASSWORD: secret,
  });
  assert.equal(gradleEnv.ORG_GRADLE_PROJECT_kcoderReleaseStorePassword, secret);
  assert.equal(gradleEnv.ORG_GRADLE_PROJECT_kcoderReleaseKeyPassword, secret);
  assert.equal(gradleEnv.ORG_GRADLE_PROJECT_kcoderReleaseKeyAlias, 'chosen');
  const gradleArgs = createGradleArguments('/private/android', { offline: true });
  assert.ok(gradleArgs.includes('-PreactNativeArchitectures=arm64-v8a'));
  assert.ok(gradleArgs.includes('--offline'));
  assert.ok(!gradleArgs.includes(secret));
});

test('failed child output is redacted in stderr and kept only in a private mode-600 log', async t => {
  const root = await fixture(t);
  const privateDir = join(root, 'private');
  await mkdir(privateDir, { mode: 0o700 });
  const secret = 'must-not-appear-in-output';
  const proxy = 'https://proxy.example/credentialed-route';
  const output = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = chunk => { output.push(String(chunk)); return true; };
  try {
    await assert.rejects(runCommand({
      label: 'fixture-failure', command: process.execPath,
      args: ['-e', 'process.stdout.write(`${process.env.KCODER_ANDROID_KEYSTORE_PASSWORD}|${process.env.HTTPS_PROXY}`); process.exit(2)'],
      cwd: root, env: { PATH: process.env.PATH, KCODER_ANDROID_KEYSTORE_PASSWORD: secret, HTTPS_PROXY: proxy }, privateDir, secrets: [secret, proxy],
    }), error => error.message.includes('exit 2') && !error.message.includes(secret));
  } finally { process.stderr.write = originalWrite; }
  assert.ok(output.join('').includes('[REDACTED]'));
  assert.ok(!output.join('').includes(secret));
  assert.ok(!output.join('').includes(proxy));
  const logPath = join(privateDir, 'logs/fixture-failure.log');
  const log = await readFile(logPath, 'utf8');
  assert.ok(log.includes('[REDACTED]'));
  assert.ok(!log.includes(secret));
  assert.ok(!log.includes(proxy));
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(privateDir, 'logs'))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(privateDir, 'logs')), ['fixture-failure.log']);
});

test('preflight accepts a shared source tree without a package manifest and only checks keystore metadata', async t => {
  const root = await fixture(t);
  const sources = await packageFixture(root);
  const sdk = join(root, 'sdk');
  const buildTools = join(sdk, 'build-tools/35.0.0');
  const javaHome = join(root, 'jdk');
  await mkdir(buildTools, { recursive: true });
  await mkdir(join(javaHome, 'bin'), { recursive: true });
  for (const name of ['aapt', 'apksigner']) await writeFile(join(buildTools, name), 'fixture tool');
  for (const name of ['java', 'jar', 'keytool']) await writeFile(join(javaHome, 'bin', name), 'fixture tool');
  const keystore = join(root, 'private.jks');
  await writeFile(keystore, 'opaque-keystore-bytes');
  const args = parseArgs(['--version-code', '42', '--keystore', keystore, '--key-alias', 'release', '--sdk', sdk, '--java-home', javaHome]);
  const config = await preflight(args, { KCODER_ANDROID_KEYSTORE_PASSWORD: 'never-return-this-value' }, root);
  assert.equal(config.appId, 'dev.test.mobile');
  assert.equal(config.versionCode, 42);
  assert.equal(config.shared, sources.shared);
  assert.equal(config.passwordsConfigured, true);
  assert.ok(!Object.values(config).includes('never-return-this-value'));
  assert.equal(await readFile(keystore, 'utf8'), 'opaque-keystore-bytes');
});

test('private staging excludes env and old native output while copying dependency links inside the new tree', async t => {
  const root = await fixture(t);
  const sources = await packageFixture(root);
  const config = { ...sources };
  const workspace = join(root, 'private/workspace');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const staged = await copyReleaseSources(config, workspace);

  assert.equal(await readFile(join(staged.mobile, 'src/app.ts'), 'utf8'), 'export const app = true;');
  assert.equal(await readFile(join(staged.shared, 'contract.ts'), 'utf8'), 'export const shared = true;');
  await assert.rejects(readFile(join(staged.mobile, '.env.production')));
  await assert.rejects(readFile(join(staged.shared, '.env.local')));
  await assert.rejects(readFile(join(staged.mobile, 'android/app/build.gradle')));
  await assert.rejects(readFile(join(staged.dependencies, '.env.private')));
  assert.notEqual(await realpath(staged.dependencies), await realpath(sources.dependencies));
  const link = join(staged.dependencies, '.bin/cli');
  assert.equal(await readlink(link), '../tool/bin/cli.js');
  assert.equal(await readFile(link, 'utf8'), 'fixture dependency');
  assert.ok((await realpath(link)).startsWith(`${await realpath(staged.dependencies)}/`));
  const rootInfo = await lstat(staged.dependencies);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
});

test('private staging rejects dependency links that leave node_modules and a linked dependency root', async t => {
  const root = await fixture(t);
  const sources = await packageFixture(root);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'private.js'), 'must not be copied');
  const escapingLink = join(sources.dependencies, 'escape');
  await symlink(relative(sources.dependencies, outside), escapingLink);
  await assert.rejects(copyReleaseSources(sources, join(root, 'stage')), /escapes node_modules/);
  await rm(escapingLink);
  await symlink(join(sources.dependencies, 'tool/bin/cli.js'), escapingLink);
  await assert.rejects(copyReleaseSources(sources, join(root, 'stage-absolute')), /Absolute dependency symlinks/);

  const linkedRoot = join(root, 'linked-node-modules');
  await symlink(sources.dependencies, linkedRoot);
  await assert.rejects(copyReleaseSources({ ...sources, dependencies: linkedRoot }, join(root, 'stage-linked')), /real directory, not a symbolic link/);
});

test('release signing override requires explicit alias-backed signing and never stores passwords in Gradle text', () => {
  const gradle = `plugins { id 'com.android.application' }\nandroid {\n  signingConfigs { debug { storeFile file('debug.keystore') } }\n  buildTypes {\n    debug { signingConfig signingConfigs.debug }\n    release { signingConfig signingConfigs.debug }\n  }\n}\n`;
  const patched = replaceReleaseSigningConfig(gradle);
  assert.match(patched, /release\s*\{\s*signingConfig signingConfigs\.kcoderRelease\s*\}/);
  assert.match(patched, /kcoderRelease\s*\{[\s\S]*?findProperty\('kcoderReleaseStorePassword'\)[\s\S]*?findProperty\('kcoderReleaseKeyPassword'\)/);
  assert.match(patched, /debug\s*\{ signingConfig signingConfigs\.debug \}/);
  assert.doesNotMatch(patched, /password\s*=\s*['"][^'"]+['"]/i);
  assert.throws(() => replaceReleaseSigningConfig(gradle.replace('signingConfigs.debug }\n  }', 'signingConfigs.custom }\n  }')), /signingConfig pointing to debug/);
});

test('APK contract verifies version, release manifest, arm64-only native code, and Hermes bytecode', () => {
  const badging = `package: name='dev.test.mobile' versionCode='42' versionName='1.2.3'\nsdkVersion:'24'\ntargetSdkVersion:'35'\n`;
  assert.deepEqual(parseBadging(badging), {
    packageName: 'dev.test.mobile', versionCode: 42, versionName: '1.2.3', targetSdk: 35, debuggable: false,
  });
  const manifest = `A: android:debuggable(0x0101000f)=(type 0x12)0x0\nA: android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0`;
  const entries = 'assets/index.android.bundle\nlib/arm64-v8a/libreactnative.so\n';
  const hermesHeader = Buffer.from('c61fbc03c103191f', 'hex');
  assert.equal(validateApkMetadata({ badging, manifest, entries, hermesHeader, expectedVersionCode: 42, expectedPackage: 'dev.test.mobile' }).targetSdk, 35);
  assert.throws(() => validateApkMetadata({ badging, manifest, entries, hermesHeader, expectedVersionCode: 43, expectedPackage: 'dev.test.mobile' }), /versionCode/);
  assert.throws(() => validateApkMetadata({ badging, manifest: manifest.replace('0x0\n', '0xffffffff\n'), entries, hermesHeader, expectedVersionCode: 42, expectedPackage: 'dev.test.mobile' }), /debuggable/);
  assert.throws(() => validateApkMetadata({ badging, manifest: manifest.replace('android:usesCleartextTraffic(0x010104ec)=(type 0x12)0x0', 'android:usesCleartextTraffic(0x010104ec)=(type 0x12)0xffffffff'), entries, hermesHeader, expectedVersionCode: 42, expectedPackage: 'dev.test.mobile' }), /cleartext/);
  assert.throws(() => validateApkMetadata({ badging, manifest, entries: entries + 'lib/x86_64/libreactnative.so\n', hermesHeader, expectedVersionCode: 42, expectedPackage: 'dev.test.mobile' }), /non-arm64/);
  assert.throws(() => validateApkMetadata({ badging, manifest, entries, hermesHeader: Buffer.alloc(8), expectedVersionCode: 42, expectedPackage: 'dev.test.mobile' }), /Hermes bytecode/);
});
