import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAndroidBuildEnvironment } from './android-signing-config.mjs';
import { createBuildEnvironment, createGradleEnvironment, parseArgs } from './package_mobile_android.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'kcoder-android-signing-config-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repository');
  await mkdir(root);
  return { base, root };
}

test('repository dotenv supplies only packaging defaults without shell evaluation or process mutation', async t => {
  const { root } = await fixture(t);
  const source = { PATH: '/usr/bin' };
  await writeFile(join(root, '.env'), [
    'export KCODER_ANDROID_KEYSTORE_PATH="/private/release signing.p12"',
    'KCODER_ANDROID_KEY_ALIAS=release # inline comment',
    'ANDROID_HOME=/sdk',
    'JAVA_HOME=/jdk',
    'GRADLE_USER_HOME=/gradle-cache',
    'KCODER_ANDROID_KEYSTORE_PASSWORD=must-not-load',
    'KCODER_ANDROID_KEY_PASSWORD=must-not-load-either',
    'KCODER_STUDIO_AUTH_TOKEN=unrelated-secret',
    'UNRELATED_COMMAND=$(exit 99)',
  ].join('\n'));
  const { environment, defaults } = await loadAndroidBuildEnvironment(root, source);
  assert.deepEqual(defaults, { keystore: '/private/release signing.p12', keyAlias: 'release' });
  assert.equal(environment.ANDROID_HOME, '/sdk');
  assert.equal(environment.JAVA_HOME, '/jdk');
  assert.equal(environment.GRADLE_USER_HOME, '/gradle-cache');
  assert.equal(environment.KCODER_ANDROID_KEYSTORE_PASSWORD, undefined);
  assert.equal(environment.KCODER_ANDROID_KEY_PASSWORD, undefined);
  assert.equal(environment.KCODER_STUDIO_AUTH_TOKEN, undefined);
  assert.equal(environment.UNRELATED_COMMAND, undefined);
  assert.deepEqual(source, { PATH: '/usr/bin' });
  const literal = '/private/$(touch should-never-run).p12';
  await writeFile(join(root, '.env'), `KCODER_ANDROID_KEYSTORE_PATH='${literal}'`);
  assert.equal((await loadAndroidBuildEnvironment(root, {})).defaults.keystore, literal);
});

test('CLI overrides process defaults, process overrides dotenv, and versionCode stays explicit', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, '.env'), 'KCODER_ANDROID_KEYSTORE_PATH=/private/repo.p12\nKCODER_ANDROID_KEY_ALIAS=repo');
  const { defaults } = await loadAndroidBuildEnvironment(root, {
    KCODER_ANDROID_KEYSTORE_PATH: '/private/process.p12', KCODER_ANDROID_KEY_ALIAS: 'process',
  });
  const fallback = parseArgs(['--version-code', '18'], defaults);
  assert.equal(fallback.keystore, '/private/process.p12');
  assert.equal(fallback.keyAlias, 'process');
  const explicit = parseArgs(['--version-code', '19', '--keystore', '/private/cli.p12', '--key-alias', 'cli'], defaults);
  assert.equal(explicit.keystore, '/private/cli.p12');
  assert.equal(explicit.keyAlias, 'cli');
  assert.throws(() => parseArgs([], defaults), /--version-code is required/);
  assert.throws(() => parseArgs(['--version-code', '1'], { keyAlias: 'release' }), /--keystore is required/);
});

test('private file supplies passwords only and they reach Gradle without entering the public build environment', async t => {
  const { root, base } = await fixture(t);
  const file = join(base, 'signing.env');
  await writeFile(file, 'KCODER_ANDROID_KEYSTORE_PASSWORD=fixture-store\nKCODER_ANDROID_KEY_PASSWORD=fixture-key\nNODE_AUTH_TOKEN=must-not-import', { mode: 0o600 });
  await writeFile(join(root, '.env'), `KCODER_ANDROID_SIGNING_ENV_FILE=${file}`);
  const { environment } = await loadAndroidBuildEnvironment(root, {});
  assert.equal(environment.KCODER_ANDROID_KEYSTORE_PASSWORD, 'fixture-store');
  assert.equal(environment.KCODER_ANDROID_KEY_PASSWORD, 'fixture-key');
  assert.equal(environment.NODE_AUTH_TOKEN, undefined);
  const build = createBuildEnvironment({ sdk: '/sdk', buildToolsDir: '/sdk/build-tools/36' }, environment);
  assert.equal(build.KCODER_ANDROID_KEYSTORE_PASSWORD, undefined);
  assert.equal(build.KCODER_ANDROID_SIGNING_ENV_FILE, undefined);
  const gradle = createGradleEnvironment(build, { keystoreCopy: '/private/copy', keyAlias: 'release' }, environment);
  assert.equal(gradle.ORG_GRADLE_PROJECT_kcoderReleaseStorePassword, 'fixture-store');
  assert.equal(gradle.ORG_GRADLE_PROJECT_kcoderReleaseKeyPassword, 'fixture-key');
  await writeFile(file, 'KCODER_ANDROID_KEYSTORE_PASSWORD=fixture-store');
  const fallback = await loadAndroidBuildEnvironment(root, {});
  assert.equal(createGradleEnvironment(build, {}, fallback.environment).ORG_GRADLE_PROJECT_kcoderReleaseKeyPassword, 'fixture-store');
});

test('an explicit SDK path wins over the other SDK variable in repository dotenv', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, '.env'), 'ANDROID_HOME=/repository-home\nANDROID_SDK_ROOT=/repository-root');
  const explicitRoot = await loadAndroidBuildEnvironment(root, { ANDROID_SDK_ROOT: '/process-root' });
  assert.equal(explicitRoot.environment.ANDROID_HOME, undefined);
  assert.equal(explicitRoot.environment.ANDROID_SDK_ROOT, '/process-root');
  const explicitHome = await loadAndroidBuildEnvironment(root, { ANDROID_HOME: '/process-home' });
  assert.equal(explicitHome.environment.ANDROID_HOME, '/process-home');
  assert.equal(explicitHome.environment.ANDROID_SDK_ROOT, undefined);
});

test('explicit process credentials skip operator files for isolated builds', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, '.env'), 'KCODER_ANDROID_SIGNING_ENV_FILE=/does-not-exist/operator.env');
  const { environment } = await loadAndroidBuildEnvironment(root, { KCODER_ANDROID_KEYSTORE_PASSWORD: 'explicit-process-password' });
  assert.equal(environment.KCODER_ANDROID_KEYSTORE_PASSWORD, 'explicit-process-password');
  assert.equal(environment.KCODER_ANDROID_KEY_PASSWORD, undefined);
});

test('password files must be outside the repository, private and free of links', async t => {
  const { root, base } = await fixture(t);
  const file = join(base, 'private.env');
  await writeFile(file, 'KCODER_ANDROID_KEYSTORE_PASSWORD=fixture-value', { mode: 0o600 });
  const load = path => loadAndroidBuildEnvironment(root, { KCODER_ANDROID_SIGNING_ENV_FILE: path });
  await chmod(file, 0o644);
  await assert.rejects(load(file), /mode 600/);
  await chmod(file, 0o600);
  const repoFile = join(root, 'secret.env');
  await writeFile(repoFile, 'fixture-value', { mode: 0o600 });
  await assert.rejects(load(repoFile), /outside the repository/);
  const symbolic = join(base, 'symbolic.env');
  await symlink(file, symbolic);
  await assert.rejects(load(symbolic), error => error.code === 'ELOOP');
  const hard = join(base, 'hard.env');
  await link(file, hard);
  await assert.rejects(load(hard), /regular file/);
  assert.equal(await readFile(file, 'utf8'), 'KCODER_ANDROID_KEYSTORE_PASSWORD=fixture-value');
});

test('missing dotenv keeps explicit-only callers working', async t => {
  const { root } = await fixture(t);
  const { environment, defaults } = await loadAndroidBuildEnvironment(root, { ANDROID_HOME: '/existing-sdk' });
  assert.deepEqual(defaults, { keystore: undefined, keyAlias: undefined });
  assert.equal(environment.ANDROID_HOME, '/existing-sdk');
});
