import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { stageGatewayNpmPackage } from './stage-studio-gateway-npm.mjs';
import { storageNativeBuildInputs } from '../../apps/kcoder-studio/desktop/storage-native-resources.mjs';
import { resolveStorageRuntimeResources } from '../../apps/kcoder-studio/src/storage-runtime-resources.mjs';
import { pathToFileURL } from 'node:url';

function hostTarget() {
  return { electronPlatformName: process.platform, arch: process.arch === 'arm64' ? 3 : 1 };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-gateway-npm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repo');
  const sourceRoot = join(repository, 'apps/kcoder-studio');
  await mkdir(join(sourceRoot, 'src'), { recursive: true });
  await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({
    name: '@kcoder/studio', version: '1.0.0', files: ['package.json', 'src', 'bin', 'gateway-resources'],
  }));
  await writeFile(join(sourceRoot, 'README.md'), 'fixture\n');
  await writeFile(join(sourceRoot, 'src/storage-lease.mjs'), 'export {};\n');
  await writeFile(join(sourceRoot, 'src/ignored.test.mjs'), 'must not be copied\n');
  const stageRoot = join(root, 'owned-stage/package');
  await mkdir(dirname(stageRoot), { recursive: true });
  const destination = join(root, 'packages');
  return { root, repository, sourceRoot, stageRoot, destination };
}

function packageStages(f, { wrongAddonSource = false } = {}) {
  const env = { CARGO_TARGET_DIR: 'target/native-build' };
  const inputs = storageNativeBuildInputs(hostTarget(), {
    repositoryRoot: f.repository, env, destinationRoot: f.stageRoot,
  });
  return {
    env,
    stageAddon: async (context, options) => {
      assert.deepEqual(context, hostTarget());
      assert.equal(options.repositoryRoot, f.repository);
      await mkdir(dirname(inputs.destination), { recursive: true });
      await writeFile(inputs.destination, 'mock native artifact');
      return {
        source: wrongAddonSource ? join(f.root, 'another-checkout', 'libstorage.so') : inputs.source,
        destination: inputs.destination,
      };
    },
    stageChannel: async ({ destination }) => {
      await mkdir(join(destination, 'src/applications'), { recursive: true });
      await mkdir(join(destination, 'src/channels'), { recursive: true });
      await writeFile(join(destination, 'package.json'), JSON.stringify({ name: '@kunlunmeta/kcoder-channel-host' }));
      await writeFile(join(destination, 'channel-resource-manifest.json'), JSON.stringify({
        schemaVersion: 1, name: '@kunlunmeta/kcoder-channel-host', entry: 'src/applications/stdio.mjs',
      }));
      await writeFile(join(destination, 'src/applications/store-bootstrap.mjs'), 'export {};\n');
      await writeFile(join(destination, 'src/channels/store-relocation.mjs'), 'export {};\n');
      return { componentRoot: destination };
    },
  };
}

test('Gateway npm staging preserves the allowlist and installs package-local channel and native resources', async t => {
  const f = await fixture(t);
  const stages = packageStages(f);
  const target = storageNativeBuildInputs(hostTarget(), {
    repositoryRoot: f.repository, env: stages.env, destinationRoot: f.stageRoot,
  }).target;
  let manifestRoot, packInput;
  const result = await stageGatewayNpmPackage({
    ...f,
    env: stages.env,
    listFiles: async () => ['package.json', 'README.md', 'src/storage-lease.mjs'],
    stageAddon: stages.stageAddon,
    stageChannel: stages.stageChannel,
    createManifest: async root => { manifestRoot = root; },
    pack: async (root, output) => {
      packInput = { root, output };
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'kcoder-studio-1.0.0.tgz'), 'fixture archive');
      return JSON.stringify([{ filename: 'kcoder-studio-1.0.0.tgz' }]);
    },
  });

  assert.equal(result.stageRoot, f.stageRoot);
  assert.equal(result.packageFile, join(f.destination, `kcoder-studio-1.0.0-${target}.tgz`));
  assert.equal(result.platform, target);
  assert.equal(result.addonPath, join(f.stageRoot, 'bin/kcoder-native-storage.node'));
  assert.equal(result.channelHostRoot, join(f.stageRoot, 'gateway-resources/kcoder-channel-host'));
  assert.equal(manifestRoot, f.stageRoot);
  assert.equal(packInput.root, f.stageRoot);
  assert.ok(basename(packInput.output).startsWith('.pending-'));
  assert.equal(await readFile(join(f.stageRoot, 'src/storage-lease.mjs'), 'utf8'), 'export {};\n');
  await assert.rejects(lstat(join(f.stageRoot, 'src/ignored.test.mjs')), { code: 'ENOENT' });
  assert.equal(await readFile(result.addonPath, 'utf8'), 'mock native artifact');
  assert.equal(JSON.parse(await readFile(join(result.channelHostRoot, 'package.json'), 'utf8')).name,
    '@kunlunmeta/kcoder-channel-host');
  const runtime = await resolveStorageRuntimeResources({
    moduleUrl: pathToFileURL(join(f.stageRoot, 'src/storage-lease.mjs')).href,
    applicationRoot: f.stageRoot,
  });
  assert.equal(runtime.layout, 'npm');
  assert.equal(runtime.nativeAddonPath, result.addonPath);
  assert.equal(runtime.channelHostRoot, join(result.channelHostRoot, 'src'));
  await assert.rejects(lstat(join(f.sourceRoot, 'bin')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.sourceRoot, 'gateway-resources')), { code: 'ENOENT' });
});

test('Gateway npm staging rejects an addon reported from another checkout', async t => {
  const f = await fixture(t);
  const stages = packageStages(f, { wrongAddonSource: true });
  await assert.rejects(stageGatewayNpmPackage({
    ...f,
    env: stages.env,
    listFiles: async () => ['package.json', 'README.md'],
    stageAddon: stages.stageAddon,
    stageChannel: stages.stageChannel,
    createManifest: async () => assert.fail('manifest must not bless another checkout artifact'),
    pack: async () => assert.fail('package must not be emitted'),
  }), /does not match the selected source target and package path/);
});

test('Gateway npm staging never copies a stale source-tree addon into its target package', async t => {
  const f = await fixture(t);
  await mkdir(join(f.sourceRoot, 'bin'), { recursive: true });
  await writeFile(join(f.sourceRoot, 'bin/kcoder-native-storage.node'), 'foreign architecture');
  let listed = false;
  await assert.rejects(stageGatewayNpmPackage({
    ...f,
    listFiles: async () => { listed = true; return ['package.json', 'bin/kcoder-native-storage.node']; },
    stageAddon: async () => assert.fail('stale source addon must be rejected before building'),
    stageChannel: async () => assert.fail('stale source addon must be rejected before resource staging'),
    createManifest: async () => assert.fail('stale source addon must be rejected before manifest creation'),
    pack: async () => assert.fail('stale source addon must never be packed'),
  }), /contains staged runtime resources/);
  assert.equal(listed, false);
});

test('Gateway npm publication refuses to replace an earlier target artifact', async t => {
  const f = await fixture(t);
  const stages = packageStages(f);
  const target = storageNativeBuildInputs(hostTarget(), {
    repositoryRoot: f.repository, env: stages.env, destinationRoot: f.stageRoot,
  }).target;
  const previous = join(f.destination, `kcoder-studio-1.0.0-${target}.tgz`);
  await mkdir(f.destination, { recursive: true });
  await writeFile(previous, 'keep earlier artifact');
  await assert.rejects(stageGatewayNpmPackage({
    ...f,
    env: stages.env,
    listFiles: async () => ['package.json', 'README.md'],
    stageAddon: stages.stageAddon,
    stageChannel: stages.stageChannel,
    createManifest: async () => {},
    pack: async (root, output) => {
      await writeFile(join(output, 'kcoder-studio-1.0.0.tgz'), 'new artifact');
      return JSON.stringify([{ filename: 'kcoder-studio-1.0.0.tgz' }]);
    },
  }), /already exists; refusing replacement/);
  assert.equal(await readFile(previous, 'utf8'), 'keep earlier artifact');
});
