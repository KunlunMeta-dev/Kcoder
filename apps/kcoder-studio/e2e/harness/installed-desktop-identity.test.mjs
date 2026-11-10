import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { writeManifest } from '../../../../scripts/release/artifact-manifest.mjs';
import { prepareInstalledDesktop, validateInstalledNativeWitnessConfiguration, verifyInstalledDesktop, verifyInstalledNativeWitness } from './installed-desktop-identity.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const commit = '1234567890abcdef1234567890abcdef12345678';
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'installed-desktop-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'installation'), resources = join(root, 'resources');
  for (const [path, contents] of Object.entries({ 'kcoder-studio.exe': 'inert host bytes',
    'resources/app.asar': 'inert archive bytes', 'resources/gateway/dev-server.mjs': 'inert gateway bytes',
    'resources/renderer-dist/index.html': 'inert renderer bytes', 'resources/bin/kcoder.exe': 'inert native bytes',
    'resources/bin/kcoder-process-supervisor.exe': 'inert supervisor bytes' })) {
    const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, contents);
  }
  await writeManifest(resources, { kind: 'studio-desktop', platform: 'win32',
    identity: { packagingSource: { commit, dirty: false }, versions: {} },
    inspectAsar: async () => [], hostRuntime: { kind: 'electron', version: '42.3.3' } });
  const expected = { expectedCommit: commit,
    manifestSha256: digest(await readFile(join(resources, 'kcoder-release-manifest.json'))),
    hostSha256: digest(await readFile(join(root, 'kcoder-studio.exe'))) };
  return { root, resources, expected, parent };
}

test('installed identity verifies the frozen host and complete resource bytes without source overrides', async t => {
  const value = await fixture(t);
  const identity = await verifyInstalledDesktop(value.root, value.expected);
  assert.equal(identity.nativePath, join(value.resources, 'bin/kcoder.exe'));
  assert.equal(identity.nativeSha256, digest('inert native bytes'));
  assert.equal(identity.supervisorPath, join(value.resources, 'bin/kcoder-process-supervisor.exe'));
  assert.equal(identity.packagingSource.commit, commit);
  assert.equal(identity.resourceCount, 5);
  assert.match(identity.verification, /ASAR content audit belongs to packaging/);
});

test('installed host, manifest, Native, renderer and ASAR changes reject the artifact', async t => {
  for (const path of ['kcoder-studio.exe', 'resources/kcoder-release-manifest.json', 'resources/bin/kcoder.exe', 'resources/renderer-dist/index.html', 'resources/app.asar']) {
    const value = await fixture(t);
    await writeFile(join(value.root, path), 'changed fixture bytes');
    await assert.rejects(verifyInstalledDesktop(value.root, value.expected));
  }
  const value = await fixture(t);
  await writeFile(join(value.resources, 'unexpected.txt'), 'unlisted');
  await assert.rejects(verifyInstalledDesktop(value.root, value.expected), /do not match/);
  await assert.rejects(verifyInstalledDesktop(value.root, {}), /manifest SHA256 required/);
  await assert.rejects(verifyInstalledDesktop(value.root, { ...value.expected, expectedCommit: '0'.repeat(40) }), /different source commit/);
});

test('installed postflight runs after owner cleanup and retains a real byte mismatch', async t => {
  const value = await fixture(t); const cleanups = [];
  const artifacts = join(value.parent, 'artifacts'); await mkdir(artifacts);
  const context = { pathInArtifacts: name => join(artifacts, name),
    writeArtifactJson: async (name, data) => writeFile(join(artifacts, name), JSON.stringify(data)),
    redactValue: data => data, addCleanup: (name, action) => cleanups.push([name, action]) };
  await prepareInstalledDesktop(context, { label: 'installed', directory: value.root, expected: value.expected });
  assert.equal(cleanups.length, 1);
  await writeFile(join(value.resources, 'bin/kcoder.exe'), 'changed after the run');
  await assert.rejects(cleanups[0][1](), /do not match/);
  const result = JSON.parse(await readFile(join(artifacts, 'installed-installed-postflight.json'), 'utf8'));
  assert.equal(result.unchanged, false);
  assert.equal(result.before.nativeSha256, digest('inert native bytes'));
});

test('Native witness permits only a fixed owner launcher forwarding to the same installed Native', () => {
  const installed = { nativePath: 'D:\\installed\\resources\\bin\\kcoder.exe', nativeSha256: 'a'.repeat(64),
    hostPath: 'D:\\installed\\kcoder-studio.exe', hostSha256: 'b'.repeat(64) };
  const witness = { owner: '12345678-1234-1234-1234-123456789abc' };
  const config = { mode: 'native', owner: witness.owner, root: 'D:\\owned\\state',
    executable: installed.nativePath, executableSha256: installed.nativeSha256,
    receipts: 'D:\\owned\\state\\proofs', electron: installed.hostPath, electronSha256: installed.hostSha256 };
  const encode = value => Buffer.from('\ufeff[fixture]\r\n' + Object.entries(value).map(([key, text]) => `${key}=${text}`).join('\r\n') + '\r\n', 'utf16le');
  const validate = value => validateInstalledNativeWitnessConfiguration(encode(value), witness, installed, config.root);
  assert.equal(validate(config).executable, installed.nativePath);
  for (const patch of [{ mode: 'gh' }, { owner: 'other' }, { root: 'C:\\personal' },
    { executable: 'D:\\source\\kcoder.exe' }, { executableSha256: 'c'.repeat(64) },
    { electron: 'D:\\source\\electron.exe' }, { electronSha256: 'c'.repeat(64) },
    { receipts: 'D:\\owned\\state\\..\\personal' }, { unknown: 'value' }]) assert.throws(() => validate({ ...config, ...patch }));
  const bytes = encode(config);
  assert.throws(() => validateInstalledNativeWitnessConfiguration(bytes.subarray(2), witness, installed, config.root));
});

test('Native witness rejects changed launcher or INI bytes before admitting a process override', async t => {
  const value = await fixture(t); const stateDir = join(value.parent, 'state');
  await mkdir(stateDir);
  const path = join(stateDir, 'native-witness.exe'); await writeFile(path, 'inert fixed launcher');
  await writeFile(path + '.ini', 'inert fixed configuration');
  const context = { stateDir };
  const witness = { path, sha256: '0'.repeat(64), configurationSha256: '0'.repeat(64) };
  await assert.rejects(verifyInstalledNativeWitness(context, {}, witness), /launcher changed/);
  witness.sha256 = digest('inert fixed launcher');
  await assert.rejects(verifyInstalledNativeWitness(context, {}, witness), /configuration changed/);
});
