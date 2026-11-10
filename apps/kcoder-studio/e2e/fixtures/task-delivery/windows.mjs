import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { delimiter, join, relative, isAbsolute, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashExecutableFile } from '../../harness/owned-executable-provenance.mjs';
import { requireExecutable, waitFor } from '../../harness/run-context.mjs';

const sha = /^[a-f0-9]{64}$/;
const ticks = /^[1-9][0-9]{1,20}$/;
const source = fileURLToPath(new URL('./windows-launcher.c', import.meta.url));
const ghScript = fileURLToPath(new URL('./gh.mjs', import.meta.url));
/** These are artifact inputs; the installed-host gate must verify their bytes before launch. */
export function installedDeliveryInputs(directory, env = process.env) {
  assert.ok(typeof directory === 'string' && /^[A-Za-z]:\\/.test(directory) && !/[\0\r\n]/.test(directory), 'absolute local installed directory required');
  assert.match(env.KCODER_E2E_PACKAGED_MANIFEST_SHA256 ?? '', sha, 'external installed manifest SHA256 required');
  assert.match(env.KCODER_E2E_PACKAGED_HOST_SHA256 ?? '', sha, 'external installed host SHA256 required');
  const root = win32.resolve(directory);
  return { nativeBin: win32.join(root, 'resources/bin/kcoder.exe'), electronBin: win32.join(root, 'kcoder-studio.exe'),
    desktop: { installedDirectory: root, installedIdentity: { manifestSha256: env.KCODER_E2E_PACKAGED_MANIFEST_SHA256,
      hostSha256: env.KCODER_E2E_PACKAGED_HOST_SHA256, expectedCommit: env.KCODER_RELEASE_EXPECTED_COMMIT } } };
}
export async function nativeWitnessDescriptor(path, owner) {
  assert.match(owner, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const [executable, configuration] = await Promise.all([hashExecutableFile(path), hashExecutableFile(path + '.ini')]);
  return { path: executable.path, sha256: executable.sha256, configurationSha256: configuration.sha256, owner };
}
export async function resolveFixtureGit() {
  const candidates = process.env.KCODER_E2E_GIT_BIN ? [process.env.KCODER_E2E_GIT_BIN]
    : (process.env.PATH ?? '').split(delimiter).filter(path => path && isAbsolute(path)).map(path => join(path, process.platform === 'win32' ? 'git.exe' : 'git'));
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try { return await realpath(await requireExecutable(path, 'owned fixture Git')); }
    catch (error) { if (process.env.KCODER_E2E_GIT_BIN) throw error; }
  }
  throw new Error('UNMET_PREREQUISITE: a fixed absolute Git executable is required');
}
export function encodeLauncherConfiguration(values) {
  assert.ok(['gh', 'native'].includes(values.mode));
  assert.match(values.owner, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  const lines = ['[fixture]'];
  for (const [key, value] of Object.entries(values)) {
    assert.match(key, /^[a-zA-Z]+[a-zA-Z0-9]*$/);
    assert.ok(typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value), 'launcher configuration must be literal single-line data');
    if (!['mode', 'owner'].includes(key) && !key.endsWith('Sha256'))
      assert.ok(/^[a-zA-Z]:\\/.test(value) && win32.isAbsolute(value), 'launcher inputs require absolute local Windows paths');
    if (key.endsWith('Sha256')) assert.match(value, sha);
    lines.push(`${key}=${value}`);
  }
  return Buffer.from(`\ufeff${lines.join('\r\n')}\r\n`, 'utf16le');
}
export async function installWindowsLauncher(destination, values, launcherBin = process.env.KCODER_E2E_TASK_DELIVERY_LAUNCHER_BIN) {
  assert.ok(launcherBin && isAbsolute(launcherBin), 'UNMET_PREREQUISITE: absolute compiled task-delivery Windows launcher required');
  const pin = await hashExecutableFile(await requireExecutable(launcherBin, 'task-delivery launcher'));
  await copyFile(pin.path, destination);
  await writeFile(`${destination}.ini`, encodeLauncherConfiguration(values), { flag: 'wx' });
  assert.equal((await hashExecutableFile(destination)).sha256, pin.sha256);
  return pin;
}
function sameWindowsPath(left, right) {
  const normalized = value => win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase();
  assert.ok(typeof left === 'string' && typeof right === 'string');
  return normalized(left) === normalized(right);
}
function validateIdentity(row) {
  assert.ok(Number.isSafeInteger(row?.pid) && row.pid > 0);
  assert.ok(Number.isSafeInteger(row.parentPid) && row.parentPid > 0);
  assert.match(row.creationTicks, ticks);
  assert.equal(row.inJob, true, 'Native and ancestors must stay in their enclosing RunContext Job');
  assert.ok(typeof row.imagePath === 'string' && win32.isAbsolute(row.imagePath));
}
/** Validate only launcher-origin facts; caller-supplied task paths never become process facts. */
export function validateWindowsNativeProof(proof, expected, electron, observation = false) {
  assert.equal(proof.version, 1); assert.equal(proof.owner, expected.owner);
  if (!observation) assert.equal(proof.mode, 'native');
  validateIdentity(proof.child);
  assert.ok(sameWindowsPath(proof.child.imagePath, expected.native.path), 'Native image identity changed');
  assert.equal(proof.sha256, expected.native.sha256);
  assert.ok(Array.isArray(proof.ancestors) && proof.ancestors.length > 0 && proof.ancestors.length <= 20);
  let descendant = proof.child;
  const seen = new Set(observation ? [] : [proof.child.pid]);
  for (let i = 0; i < proof.ancestors.length; ++i) {
    const ancestor = proof.ancestors[i]; validateIdentity(ancestor);
    // Observation starts at the Native itself; a launch receipt starts at its actual launcher parent.
    if (!(observation && i === 0)) assert.equal(descendant.parentPid, ancestor.pid, 'Native ancestry is discontinuous');
    else assert.deepEqual(ancestor, proof.child);
    assert.equal(seen.has(ancestor.pid), false, 'Native ancestry contains a cycle'); seen.add(ancestor.pid);
    assert.ok(BigInt(ancestor.creationTicks) <= BigInt(descendant.creationTicks), 'ancestor PID was reused');
    descendant = ancestor;
  }
  assert.equal(descendant.pid, electron.pid, 'Native process belongs to another Electron owner');
  assert.equal(descendant.creationTicks, electron.creationTicks, 'Electron PID was reused');
  assert.ok(sameWindowsPath(descendant.imagePath, electron.imagePath));
  if (!observation) {
    assert.ok(typeof proof.cwd === 'string' && win32.isAbsolute(proof.cwd));
    const path = win32.relative(expected.runRoot, proof.cwd.replace(/^\\\\\?\\/, ''));
    assert.ok(path && path !== '..' && !path.startsWith('..\\') && !win32.isAbsolute(path), 'Native launch cwd escaped its run');
  }
  return proof;
}
export async function prepareWindowsDelivery(context, { nativeBin, gitBin, electronBin, launcherBin = process.env.KCODER_E2E_TASK_DELIVERY_LAUNCHER_BIN }) {
  assert.equal(process.platform, 'win32');
  const binaries = { native: nativeBin, git: gitBin, node: process.execPath, electron: electronBin, launcher: launcherBin };
  const pins = {};
  for (const [name, path] of Object.entries(binaries)) {
    assert.ok(path && isAbsolute(path), `UNMET_PREREQUISITE: absolute Windows ${name} executable required`);
    pins[name] = await hashExecutableFile(await requireExecutable(path, `task-delivery ${name}`));
  }
  const script = await hashExecutableFile(ghScript);
  const sourcePin = await hashExecutableFile(source);
  const owner = randomUUID(); const bin = context.pathInState('fixture-bin');
  const receipts = context.pathInState('native-launch-proofs');
  await mkdir(bin, { recursive: true }); await mkdir(receipts, { recursive: false });
  const common = { owner, root: context.stateDir };
  const nativeLauncher = join(bin, 'native-launcher.exe'); const gh = join(bin, 'gh.exe');
  for (const [destination, data] of [[nativeLauncher, { mode: 'native', ...common, executable: pins.native.path,
    executableSha256: pins.native.sha256, receipts, electron: pins.electron.path, electronSha256: pins.electron.sha256 }],
  [gh, { mode: 'gh', ...common, executable: pins.node.path, executableSha256: pins.node.sha256,
    script: script.path, scriptSha256: script.sha256, git: pins.git.path, gitSha256: pins.git.sha256 }]]) {
    await installWindowsLauncher(destination, data, pins.launcher.path);
  }
  const expected = { owner, native: pins.native, runRoot: context.stateDir };
  const nativeWitness = await nativeWitnessDescriptor(nativeLauncher, owner);
  await context.writeArtifactJson('windows-task-delivery-inputs.json', { owner, pins, source: sourcePin, script, nativeWitness });
  return { bin, nativeLauncher, nativeWitness, gitProof: { path: pins.git.path, sha256: pins.git.sha256 },
    async processes(hostReceipt) {
      assert.equal(hostReceipt?.phase, 'ready', 'verified private Electron host receipt required');
      assert.equal(hostReceipt.electron.inJob, true);
      const names = await readdir(receipts); assert.ok(names.length > 0 && names.length <= 16);
      const result = [];
      for (const name of names) {
        assert.match(name, /^[1-9][0-9]*-[1-9][0-9]*\.json$/);
        const path = join(receipts, name); const info = await lstat(path);
        assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size < 64 * 1024);
        const proof = validateWindowsNativeProof(JSON.parse(await readFile(path, 'utf8')), expected, hostReceipt.electron);
        assert.equal(name, `${proof.child.pid}-${proof.child.creationTicks}.json`);
        const child = context.spawnOwned(`verify-native-${proof.child.pid}`, nativeLauncher,
          ['--fixture-observe', String(proof.child.pid), proof.child.creationTicks, String(hostReceipt.electron.pid), hostReceipt.electron.creationTicks],
          { cwd: context.stateDir, env: context.isolatedEnvironment() });
        let output = ''; let overflow = false;
        child.stdout.on('data', bytes => { output += bytes; overflow ||= output.length >= 64 * 1024; output = output.slice(0, 64 * 1024); });
        await waitFor(() => child.exitCode != null, 15000, 'owned Windows Native identity observation', 25, context.abortSignal);
        assert.equal(child.exitCode, 0, 'real Native process birth/image/Job/ancestry must remain verifiable');
        assert.equal(overflow, false, 'Native observation exceeded its evidence budget');
        const observed = validateWindowsNativeProof(JSON.parse(output), expected, hostReceipt.electron, true);
        assert.deepEqual(observed.child, proof.child);
        const workspace = await realpath(proof.cwd);
        const boundary = relative(await realpath(context.stateDir), workspace);
        assert.ok(boundary && boundary !== '..' && !boundary.startsWith(`..${sep}`) && !isAbsolute(boundary));
        result.push({ pid: proof.child.pid, creationTicks: proof.child.creationTicks, executablePath: proof.child.imagePath,
          sha256: proof.sha256, workspace, proof, observed });
      }
      await context.writeArtifactJson('windows-native-process-proofs.json', result);
      return result;
    },
    async verifyPins() {
      for (const [name, pin] of Object.entries(pins)) assert.deepEqual(await hashExecutableFile(pin.path), pin, `${name} fixture image changed during the run`);
      assert.deepEqual(await hashExecutableFile(source), sourcePin); assert.deepEqual(await hashExecutableFile(ghScript), script);
    },
  };
}
