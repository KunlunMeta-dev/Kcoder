import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { loginRemoteGateway, resolveRemoteClientOptions } from './remote-config.mjs';
import { registerDownloads } from './download-controller.mjs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macBuildIdentity } from './build-macos.mjs';
import { cargoPackageVersion } from '../../../scripts/release/artifact-manifest.mjs';
import { stageNativeWindowsComponentImage } from './native-component-image.mjs';

test('frozen macOS provenance must match the selected checkout and independent CLI version', async t => {
  const root = await mkdtemp(join(tmpdir(), 'frozen-mac-identity-b-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const cli = cargoPackageVersion(await readFile(new URL('../../../crates/kcoder_cli/Cargo.toml', import.meta.url), 'utf8'), await readFile(new URL('../../../Cargo.toml', import.meta.url), 'utf8'));
  const file = join(root, 'identity.json'), commit = 'a'.repeat(40);
  const identity = { packagingSource: { commit, dirty: false }, versions: { cli: studio, cliNative: cli, studio, mobile: studio } };
  await writeFile(file, JSON.stringify(identity));
  const options = { KCODER_RELEASE_IDENTITY_FILE: file };
  assert.deepEqual(await macBuildIdentity(options, () => ({ commit, dirty: false })), identity);
  await assert.rejects(macBuildIdentity(options, () => ({ commit: 'b'.repeat(40), dirty: false })), /source checkout/);
  await assert.rejects(macBuildIdentity(options, () => ({ commit, dirty: true })), /source checkout|clean|dirty/i);
  await writeFile(file, JSON.stringify({ ...identity, packagingSource: { commit, dirty: true } }));
  await assert.rejects(macBuildIdentity(options, () => ({ commit, dirty: true })), /frozen|clean|dirty/i);
  assert.equal(await macBuildIdentity({}, () => { throw new Error('ordinary development must not enter frozen admission'); }), undefined);
  await writeFile(file, JSON.stringify({ ...identity, versions: { ...identity.versions, cli: '0.0.0' } }));
  await assert.rejects(macBuildIdentity(options, () => ({ commit, dirty: false })), /source version/);
});

test('failed native component validation or signing preserves the previous publish slot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'native-component-transaction-b-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  const pe = library => { const bytes = Buffer.alloc(4096); bytes.write('MZ'); bytes.writeUInt32LE(128, 60); bytes.write('PE\0\0', 128); bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(library ? 0x2000 : 0, 150); return bytes; };
  const library = join(root, 'library.dll'), target = join(bin, 'kcoder-native-image.node');
  await writeFile(join(bin, 'kcoder.exe'), pe(false));
  const previous = Buffer.from('previous signed slot'); await writeFile(target, previous);
  await writeFile(library, 'invalid');
  await assert.rejects(stageNativeWindowsComponentImage({ library, destination: bin }));
  assert.deepEqual(await readFile(target), previous);
  await writeFile(library, pe(true));
  await assert.rejects(stageNativeWindowsComponentImage({ library, destination: bin, signFile: async () => { throw new Error('owned signer failed'); } }), /owned signer failed/);
  assert.deepEqual(await readFile(target), previous);
  assert.equal((await readdir(bin)).some(name => name.startsWith('.native-component-')), false);
});

test('remote login retains the Relay mount of the selected application route', async t => {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    request.resume();
    response.writeHead(303, { 'set-cookie': 'kcoder_studio_session=synthetic; HttpOnly; Path=/' });
    response.end();
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/g/owned-gateway', '/g/owned-gateway/workbench?tab=one', '/workbench']) {
    const options = resolveRemoteClientOptions({ KCODER_STUDIO_REMOTE_URL: origin + path, KCODER_STUDIO_REMOTE_TOKEN: 'synthetic' }, []);
    assert.equal(await loginRemoteGateway(options), 'synthetic');
  }
  assert.deepEqual(paths, ['/g/owned-gateway/login', '/g/owned-gateway/login', '/login']);
  await assert.rejects(loginRemoteGateway({ origin, initialUrl: 'https://outside.invalid/g/owned', token: 'synthetic' }), /origin/);
});

test('a claimed download outlives its startup deadline and still settles on completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = new EventEmitter();
  const contents = { session, mainFrame: { url: 'http://127.0.0.1:12345/' }, isDestroyed: () => false, downloadURL() {} };
  const window = { isDestroyed: () => false };
  const handlers = new Map();
  const dispose = registerDownloads({ session, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getWindow: owner => owner === contents ? window : null, getGatewayOrigin: () => 'http://127.0.0.1:12345', downloadsDirectory: '/owned/downloads' });
  t.after(dispose);
  const url = 'blob:http://127.0.0.1:12345/owned-download';
  const pending = handlers.get('kcoder:download')({ sender: contents, senderFrame: contents.mainFrame }, { url, filename: 'large.bin' });
  let cancelled = 0;
  const item = Object.assign(new EventEmitter(), { getURL: () => url, getURLChain: () => [url], setSaveDialogOptions() {}, cancel() { cancelled++; } });
  session.emit('will-download', { preventDefault() { assert.fail('owned download was rejected'); } }, item, contents);
  t.mock.timers.tick(10 * 60_000 + 1);
  assert.equal(cancelled, 0);
  item.emit('done', {}, 'completed');
  assert.deepEqual(await pending, { status: 'completed', filename: 'large.bin' });
});
