import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { manifestName, verifyManifest } from '../../../../scripts/release/artifact-manifest.mjs';

async function hashRegularFile(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Installed input must be a single-link regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Verify bytes against an externally pinned manifest; ASAR content was audited by the packaging hook. */
export async function verifyInstalledDesktop(directory, expected) {
  assert.match(expected?.manifestSha256 ?? '', /^[a-f0-9]{64}$/, 'Explicit installed resource manifest SHA256 required');
  assert.match(expected?.hostSha256 ?? '', /^[a-f0-9]{64}$/, 'Explicit installed desktop executable SHA256 required');
  assert.ok(typeof directory === 'string' && isAbsolute(directory), 'Explicit installed directory required');
  const root = resolve(directory), resources = resolve(root, 'resources');
  for (const path of [root, resources]) {
    const info = await lstat(path);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Installed root must be a real directory');
  }
  const manifestPath = resolve(resources, manifestName), hostPath = resolve(root, 'kcoder-studio.exe');
  assert.equal(await hashRegularFile(manifestPath), expected.manifestSha256, 'Installed resource manifest differs from the supplied artifact');
  assert.equal(await hashRegularFile(hostPath), expected.hostSha256, 'Installed desktop executable differs from the supplied artifact');
  // The pinned manifest binds app.asar's full byte hash. No remote electron-builder dependency
  // or new archive-content audit is needed to prove it is the artifact audited at packaging.
  const manifest = await verifyManifest(resources, { expectedCommit: expected.expectedCommit, inspectAsar: async () => [] });
  assert.equal(manifest.kind, 'studio-desktop');
  assert.equal(manifest.platform, 'win32');
  assert.equal(manifest.hostRuntime?.kind, 'electron');
  assert.equal(manifest.hostRuntime?.version, '42.3.3');
  const entry = path => {
    const row = manifest.resources.find(file => file.path === path);
    assert.ok(row, `Installed manifest must contain ${path}`);
    return row;
  };
  for (const path of ['app.asar', 'gateway/dev-server.mjs', 'renderer-dist/index.html']) entry(path);
  const native = entry('bin/kcoder.exe'), supervisor = entry('bin/kcoder-process-supervisor.exe');
  return { root, hostPath, resourcesPath: resources, nativePath: resolve(resources, native.path), nativeSha256: native.sha256,
    supervisorPath: resolve(resources, supervisor.path), supervisorSha256: supervisor.sha256,
    manifestSha256: expected.manifestSha256, hostSha256: expected.hostSha256, packagingSource: manifest.packagingSource,
    hostRuntime: manifest.hostRuntime, resourceCount: manifest.resources.length,
    verification: 'complete resource inventory and bytes, plus externally supplied manifest/host SHA256; ASAR content audit belongs to packaging' };
}

export async function prepareInstalledDesktop(context, { label, directory, expected }) {
  const identity = await verifyInstalledDesktop(directory, expected);
  await context.writeArtifactJson(`${label}-installed-inputs.json`, identity);
  const cleanupPath = context.pathInArtifacts(`${label}-installed-postflight.json`);
  let verification;
  const verifyAfter = () => verification ??= (async () => {
    let after, failure;
    try { after = await verifyInstalledDesktop(directory, expected); assert.deepEqual(after, identity); }
    catch (error) { failure = error; }
    await writeFile(cleanupPath, JSON.stringify(context.redactValue({ before: identity, after, unchanged: !failure,
      ...(failure ? { error: failure.message } : {}) }), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (failure) throw failure;
  })();
  // Registered before the host: LIFO verifies installed bytes after its Job has stopped.
  context.addCleanup(`verify ${label} installed resources unchanged`, verifyAfter);
  return identity;
}

const same = (left, right) => win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
function underWindows(root, path) {
  assert.ok(typeof path === 'string' && /^[A-Za-z]:\\/.test(path));
  const suffix = win32.relative(root, path);
  assert.ok(suffix && suffix !== '..' && !suffix.startsWith('..\\') && !win32.isAbsolute(suffix), 'Native witness must stay in this run state');
}

export function validateInstalledNativeWitnessConfiguration(bytes, expected, installed, stateDir) {
  assert.ok(bytes.length < 128 * 1024 && bytes.length % 2 === 0 && bytes[0] === 0xff && bytes[1] === 0xfe, 'Native witness requires its literal UTF16 launcher configuration');
  const rows = bytes.subarray(2).toString('utf16le').trim().split(/\r?\n/);
  assert.equal(rows.shift(), '[fixture]');
  const values = Object.create(null);
  for (const row of rows) {
    const index = row.indexOf('='); assert.ok(index > 0);
    const key = row.slice(0, index), value = row.slice(index + 1);
    assert.ok(!Object.hasOwn(values, key) && !/[\0-\x1f]/.test(value)); values[key] = value;
  }
  assert.deepEqual(Object.keys(values).sort(), ['mode', 'owner', 'root', 'executable', 'executableSha256', 'receipts', 'electron', 'electronSha256'].sort());
  assert.equal(values.mode, 'native');
  assert.match(expected.owner ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(values.owner, expected.owner);
  assert.ok(same(values.root, stateDir));
  assert.ok(same(values.executable, installed.nativePath));
  assert.equal(values.executableSha256, installed.nativeSha256);
  assert.ok(same(values.electron, installed.hostPath));
  assert.equal(values.electronSha256, installed.hostSha256);
  underWindows(stateDir, values.receipts);
  return values;
}

export async function verifyInstalledNativeWitness(context, installed, witness) {
  assert.match(witness?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(witness?.configurationSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.ok(isAbsolute(witness.path));
  const path = resolve(witness.path), suffix = relative(context.stateDir, path);
  assert.ok(suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), 'Native witness launcher must belong to this run');
  let current = path;
  while (relative(context.stateDir, current) !== '') {
    assert.equal((await lstat(current)).isSymbolicLink(), false, 'Native witness must not follow a link');
    const parent = resolve(current, '..');
    assert.notEqual(parent, current, 'Native witness ancestry escaped the run'); current = parent;
  }
  assert.equal(await hashRegularFile(path), witness.sha256, 'Native witness launcher changed');
  const configurationPath = path + '.ini';
  assert.equal(await hashRegularFile(configurationPath), witness.configurationSha256, 'Native witness configuration changed');
  const configuration = validateInstalledNativeWitnessConfiguration(await readFile(configurationPath), witness, installed, context.stateDir);
  const receipt = { path, sha256: witness.sha256, configurationPath, configurationSha256: witness.configurationSha256,
    owner: witness.owner, nativePath: configuration.executable, nativeSha256: configuration.executableSha256,
    receipts: configuration.receipts };
  await context.writeArtifactJson(`${witness.owner}-installed-native-witness.json`, receipt);
  const postflight = context.pathInArtifacts(`${witness.owner}-installed-native-witness-postflight.json`);
  context.addCleanup('verify installed Native witness unchanged', async () => {
    const unchanged = await hashRegularFile(path) === witness.sha256 && await hashRegularFile(configurationPath) === witness.configurationSha256;
    await writeFile(postflight, JSON.stringify(context.redactValue({ ...receipt, unchanged }), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    assert.equal(unchanged, true, 'Installed Native witness changed during the run');
  });
  return receipt;
}
