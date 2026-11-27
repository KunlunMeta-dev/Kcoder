import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveStorageRuntimeResources, storageChannelHostModuleUrl } from './storage-runtime-resources.mjs';

const channelPackage = '@kunlunmeta/kcoder-channel-host';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-storage-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function channelComponent(root, sourceText = 'export const layout = "fixture";\n') {
  await mkdir(join(root, 'src/applications'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: channelPackage, version: '0.1.0' }));
  await writeFile(join(root, 'channel-resource-manifest.json'), JSON.stringify({
    schemaVersion: 1, name: channelPackage, entry: 'src/applications/stdio.mjs',
  }));
  await writeFile(join(root, 'src/applications/store-bootstrap.mjs'), sourceText);
}

test('source checkout resolves channel code and native source from its own repository root', async t => {
  const root = await fixture(t);
  const repositoryRoot = join(root, 'checkout');
  const applicationRoot = join(repositoryRoot, 'apps/kcoder-studio');
  await mkdir(join(applicationRoot, 'src'), { recursive: true });
  await mkdir(join(repositoryRoot, 'crates/kcoder_native_storage'), { recursive: true });
  await writeFile(join(repositoryRoot, 'Cargo.toml'), '[workspace]\n');
  await writeFile(join(repositoryRoot, 'crates/kcoder_native_storage/Cargo.toml'), '[package]\n');
  await channelComponent(join(repositoryRoot, 'apps/kcoder-channel-host'));

  const resources = await resolveStorageRuntimeResources({
    moduleUrl: pathToFileURL(join(applicationRoot, 'src/storage-lease.mjs')).href,
    applicationRoot,
  });
  assert.equal(resources.layout, 'source');
  assert.equal(resources.repositoryRoot, repositoryRoot);
  assert.equal(resources.channelHostRoot, join(repositoryRoot, 'apps/kcoder-channel-host/src'));
  assert.equal(resources.nativeAddonPath, undefined);
});

test('Electron child resolves fixed sibling resources without relying on Electron globals', async t => {
  const root = await fixture(t);
  const resourcesRoot = join(root, 'Resources');
  const applicationRoot = join(resourcesRoot, 'gateway');
  await mkdir(join(applicationRoot, 'src/migrations'), { recursive: true });
  await mkdir(join(resourcesRoot, 'bin'), { recursive: true });
  await channelComponent(join(resourcesRoot, 'kcoder-channel-host'));

  const resources = await resolveStorageRuntimeResources({
    moduleUrl: pathToFileURL(join(applicationRoot, 'src/migrations/gateway-storage-domains.mjs')).href,
    applicationRoot,
  });
  assert.equal(resources.layout, 'electron');
  assert.equal(resources.resourcesRoot, resourcesRoot);
  assert.equal(resources.channelHostRoot, join(resourcesRoot, 'kcoder-channel-host/src'));
  assert.equal(resources.nativeAddonPath, join(resourcesRoot, 'bin/kcoder-native-storage.node'));
});

test('Electron main resolves resources outside the app ASAR from process.resourcesPath', async t => {
  const root = await fixture(t);
  const resourcesRoot = join(root, 'Resources');
  const applicationRoot = join(resourcesRoot, 'app.asar');
  await mkdir(join(applicationRoot, 'src'), { recursive: true });
  await mkdir(join(resourcesRoot, 'bin'), { recursive: true });
  await channelComponent(join(resourcesRoot, 'kcoder-channel-host'));

  const resources = await resolveStorageRuntimeResources({
    moduleUrl: pathToFileURL(join(applicationRoot, 'src/storage-lease.mjs')).href,
    applicationRoot,
    resourcesPath: resourcesRoot,
  });
  assert.equal(resources.layout, 'electron');
  assert.equal(resources.resourcesRoot, resourcesRoot);
  assert.equal(resources.nativeAddonPath, join(resourcesRoot, 'bin/kcoder-native-storage.node'));
});

test('npm package resolves only resources staged inside that Studio package', async t => {
  const root = await fixture(t);
  const applicationRoot = join(root, 'node_modules/@kcoder/studio');
  await mkdir(join(applicationRoot, 'src/migrations'), { recursive: true });
  await mkdir(join(applicationRoot, 'bin'), { recursive: true });
  await writeFile(join(applicationRoot, 'package.json'), JSON.stringify({ name: '@kcoder/studio' }));
  const channelRoot = join(applicationRoot, 'gateway-resources/kcoder-channel-host');
  await channelComponent(channelRoot, 'export const layout = "npm-package";\n');

  const resources = await resolveStorageRuntimeResources({
    moduleUrl: pathToFileURL(join(applicationRoot, 'src/migrations/gateway-storage-domains.mjs')).href,
    applicationRoot,
  });
  assert.equal(resources.layout, 'npm');
  assert.equal(resources.channelHostRoot, join(channelRoot, 'src'));
  assert.equal(resources.nativeAddonPath, join(applicationRoot, 'bin/kcoder-native-storage.node'));
  const imported = await import(storageChannelHostModuleUrl(resources.channelHostRoot, 'applications/store-bootstrap.mjs'));
  assert.equal(imported.layout, 'npm-package');
});

test('npm resolution fails closed when only another node_modules package has channel code', async t => {
  const root = await fixture(t);
  const applicationRoot = join(root, 'node_modules/@kcoder/studio');
  await mkdir(join(applicationRoot, 'src'), { recursive: true });
  await writeFile(join(applicationRoot, 'package.json'), JSON.stringify({ name: '@kcoder/studio' }));
  await channelComponent(join(root, 'node_modules/@kunlunmeta/kcoder-channel-host'));

  await assert.rejects(resolveStorageRuntimeResources({
    moduleUrl: pathToFileURL(join(applicationRoot, 'src/storage-lease.mjs')).href,
    applicationRoot,
  }), error => error.code === 'STORAGE_CHANNEL_HOST_RESOURCE_UNAVAILABLE');
});

test('channel module mapping rejects paths outside the selected component', async () => {
  const root = resolve('/runtime/kcoder-channel-host/src');
  assert.equal(new URL(storageChannelHostModuleUrl(root, 'channels/store-relocation.mjs')).pathname,
    '/runtime/kcoder-channel-host/src/channels/store-relocation.mjs');
  assert.throws(() => storageChannelHostModuleUrl(root, '../../../outside.mjs'),
    error => error.code === 'STORAGE_CHANNEL_HOST_RESOURCE_UNAVAILABLE');
});
