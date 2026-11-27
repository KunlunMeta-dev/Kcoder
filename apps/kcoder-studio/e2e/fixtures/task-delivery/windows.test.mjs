import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { encodeLauncherConfiguration, installedDeliveryInputs, nativeWitnessDescriptor, validateWindowsNativeProof } from './windows.mjs';
import { MARKERS, quotePowerShell, taskDeliveryResponses } from './provider.mjs';
import { RunContext } from '../../harness/run-context.mjs';
import { validateInstalledNativeWitnessConfiguration } from '../../harness/installed-desktop-identity.mjs';

const owner = '123e4567-e89b-42d3-a456-426614174000';
const hash = 'a'.repeat(64);
const expected = { owner, runRoot: 'D:\\owned\\state', native: { path: 'D:\\pins\\kcoder.exe', sha256: hash } };
const identity = (pid, parentPid, birth, imagePath) => ({ pid, parentPid, creationTicks: String(birth), imagePath, inJob: true });
const electron = identity(100, 90, 1000, 'D:\\pins\\electron.exe');
function launchProof() {
  return { version: 1, mode: 'native', owner, child: identity(400, 300, 4000, '\\\\?\\D:\\pins\\kcoder.exe'),
    sha256: hash, cwd: '\\\\?\\D:\\owned\\state\\workspaces\\b', ancestors: [
      identity(300, 200, 3000, 'D:\\owned\\state\\fixture-bin\\native-launcher.exe'),
      identity(200, 100, 2000, 'D:\\pins\\electron.exe'), electron,
    ] };
}
test('installed delivery derives Native/host from the actual artifact and admits only the frozen owner-witness contract', () => {
  const inputs = installedDeliveryInputs('D:\\KCoder Studio', { KCODER_E2E_PACKAGED_MANIFEST_SHA256: 'a'.repeat(64),
    KCODER_E2E_PACKAGED_HOST_SHA256: 'b'.repeat(64), KCODER_RELEASE_EXPECTED_COMMIT: 'c'.repeat(40),
    KCODER_E2E_KCODER_BIN: 'D:\\source\\target\\kcoder.exe', KCODER_E2E_ELECTRON_BIN: 'D:\\source\\electron.exe',
    KCODER_E2E_RENDERER_ROOT: 'D:\\source\\renderer-dist' });
  assert.equal(inputs.nativeBin, 'D:\\KCoder Studio\\resources\\bin\\kcoder.exe');
  assert.equal(inputs.electronBin, 'D:\\KCoder Studio\\kcoder-studio.exe');
  assert.deepEqual(Object.keys(inputs.desktop).sort(), ['installedDirectory', 'installedIdentity']);
  assert.equal(inputs.desktop.installedIdentity.expectedCommit, 'c'.repeat(40));
  const installed = { nativePath: inputs.nativeBin, nativeSha256: 'd'.repeat(64), hostPath: inputs.electronBin, hostSha256: 'b'.repeat(64) };
  const configuration = { mode: 'native', owner, root: 'D:\\owned\\state', executable: installed.nativePath,
    executableSha256: installed.nativeSha256, receipts: 'D:\\owned\\state\\proofs', electron: installed.hostPath, electronSha256: installed.hostSha256 };
  const validate = value => validateInstalledNativeWitnessConfiguration(encodeLauncherConfiguration(value), { owner }, installed, configuration.root);
  assert.equal(validate(configuration).executable, installed.nativePath);
  assert.throws(() => validate({ ...configuration, executable: 'D:\\source\\kcoder.exe' }));
  assert.throws(() => validate({ ...configuration, executableSha256: 'e'.repeat(64) }));
  assert.throws(() => validate({ ...configuration, electron: 'D:\\source\\electron.exe' }));
  assert.throws(() => installedDeliveryInputs('D:\\KCoder Studio', {}), /manifest SHA256/);
  assert.throws(() => installedDeliveryInputs('relative\\installation', {}), /absolute local/);
});
test('installed Native witness descriptor binds real launcher and INI bytes without providing Native results', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'installed-native-witness-descriptor', tier: 'model-independent',
    modelPolicy: 'hash inert owned file data only; no Windows or Native platform claim' });
  let failure;
  try {
    await mkdir(context.pathInState('bin'));
    const path = context.pathInState('bin', 'witness.exe');
    const executable = 'INERT_BINARY_DATA_ONLY'; const configuration = 'INERT_CONFIGURATION_DATA_ONLY';
    await writeFile(path, executable); await writeFile(path + '.ini', configuration);
    const descriptor = await nativeWitnessDescriptor(path, owner);
    assert.deepEqual(descriptor, { path, owner, sha256: createHash('sha256').update(executable).digest('hex'),
      configurationSha256: createHash('sha256').update(configuration).digest('hex') });
    assert.equal(Object.hasOwn(descriptor, 'nativeSha256'), false);
    await writeFile(path + '.ini', configuration + 'changed');
    assert.notEqual((await nativeWitnessDescriptor(path, owner)).configurationSha256, descriptor.configurationSha256);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', null, failure); }
});
test('Windows Native proof binds child birth/image/cwd and a continuous private Electron ancestry', () => {
  const proof = launchProof();
  assert.equal(validateWindowsNativeProof(proof, expected, electron), proof);
  const observation = { ...proof, ancestors: [proof.child, ...proof.ancestors] };
  assert.equal(validateWindowsNativeProof(observation, expected, electron, true), observation);
  for (const mutation of [
    value => { value.owner = 'another-owner'; },
    value => { value.sha256 = 'b'.repeat(64); },
    value => { value.child.imagePath = 'D:\\pins\\peer.exe'; },
    value => { value.child.inJob = false; },
    value => { value.child.parentPid = 999; },
    value => { value.ancestors[0].creationTicks = '5000'; },
    value => { value.ancestors[1].parentPid = 999; },
    value => { value.ancestors.at(-1).creationTicks = '1001'; },
    value => { value.ancestors.at(-1).pid = 101; value.ancestors[1].parentPid = 101; },
    value => { value.cwd = 'D:\\personal\\workspace'; },
    value => { value.cwd = 'D:\\owned\\state-lookalike\\b'; },
    value => { value.cwd = 'D:\\owned\\state\\..\\personal'; },
  ]) { const invalid = structuredClone(proof); mutation(invalid); assert.throws(() => validateWindowsNativeProof(invalid, expected, electron)); }
  assert.throws(() => validateWindowsNativeProof(observation, expected, { ...electron, creationTicks: '1001' }, true), /reused/);
});
test('Windows launcher configuration is bounded literal UTF16 data and rejects interpolation or relative executables', () => {
  const values = { mode: 'gh', owner, root: 'D:\\owned\\state', executable: "D:\\Node's tools\\node.exe", executableSha256: hash };
  const config = encodeLauncherConfiguration(values).toString('utf16le');
  assert.ok(config.startsWith('\ufeff[fixture]\r\n'));
  assert.ok(config.includes("executable=D:\\Node's tools\\node.exe\r\n"));
  assert.throws(() => encodeLauncherConfiguration({ ...values, executable: 'node.exe' }));
  assert.throws(() => encodeLauncherConfiguration({ ...values, root: 'D:\\owned\r\nmode=native' }));
  assert.throws(() => encodeLauncherConfiguration({ ...values, owner: 'wrong-owner' }));
  assert.throws(() => encodeLauncherConfiguration({ ...values, executableSha256: 'wrong' }));
});
test('Windows provider uses the formal PowerShell tool and preserves all fourteen fixed requests and five turns', () => {
  const response = taskDeliveryResponses({ platform: 'win32', deadline: Date.now() + 10000,
    nodePath: "D:\\Node's tools\\node.exe", actionsPath: 'D:\\source\\actions.mjs', gitProof: { path: 'D:\\Git\\git.exe', sha256: hash } });
  const intent = { requestId: owner, workspace: 'D:\\owned\\state\\b', recipient: { threadId: 'b' }, source: { headCommit: 'c'.repeat(40) } };
  const turns = [[MARKERS.owner, 2], [MARKERS.b, 3], [MARKERS.c, 3],
    [`Publish the following explicitly requested delivery\n${JSON.stringify(intent)}`, 2], ['Investigate this selected failed CI check', 4]];
  let requestNumber = 0; let shells = 0;
  for (const [prompt, count] of turns) for (let results = 0; results < count; ++results) {
    const step = response({ requestNumber: ++requestNumber, body: { messages: [{ role: 'user', content: prompt },
      ...Array.from({ length: results }, () => ({ role: 'tool', content: 'actual execution belongs to the full suite' }))] } });
    const tool = step[0].delta.tool_calls?.[0];
    if (tool && !['read', 'write'].includes(tool.function.name)) {
      ++shells; assert.equal(tool.function.name, 'PowerShell');
      const command = JSON.parse(tool.function.arguments);
      assert.ok(command.command.startsWith("& 'D:\\Node''s tools\\node.exe' 'D:\\source\\actions.mjs'"));
      assert.ok(command.command.endsWith('; exit $LASTEXITCODE'));
      assert.equal(command.timeout, 10000);
      assert.equal(command.command.includes('printf'), false);
    }
  }
  assert.equal(requestNumber, 14); assert.equal(shells, 4);
  assert.equal(quotePowerShell("a'b $value `text`"), "'a''b $value `text`'");
});
