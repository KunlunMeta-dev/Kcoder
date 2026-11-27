import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { resolveLegacyWindowsTarget } from './windows-legacy-target.mjs';

const binary = String.raw`C:\Users\kunlunmeta\AppData\Local\Programs\kcoder-studio\resources\bin\kcoder.exe`;
const env = { KCODER_STUDIO_DESKTOP_HOST: '1', KCODER_STUDIO_PACKAGED_WINDOWS_BIN: binary,
  ProgramFiles: String.raw`C:\Program Files`, ProgramData: String.raw`C:\ProgramData` };
const legacy = { id: 'kunlun', label: 'Kunlun', runtime: 'kcoder', transport: 'local',
  command: win32.join(env.ProgramFiles, 'KCoder Studio', 'resources', 'bin', 'kcoder.exe'),
  settingsFile: win32.join(env.ProgramData, 'KCoder', 'settings.toml'), profile: 'kc',
  cwd: String.raw`C:\Users\29505\dev` };

test('missing previous installer launcher uses the bundled CLI and ordinary account settings', async () => {
  const effective = await resolveLegacyWindowsTarget(legacy, env, binary, 'win32',
    { isMissing: async () => true, isLegacyToml: () => assert.fail('No old config read needed') });
  assert.deepEqual(effective, { ...legacy, command: binary, profile: undefined, settingsFile: undefined });
  assert.equal(legacy.profile, 'kc');
});

test('only the confirmed broken legacy pair on the packaged Windows host is recovered', async () => {
  const ok = { isMissing: async () => false, isLegacyToml: async () => false };
  assert.equal(await resolveLegacyWindowsTarget(legacy, env, binary, 'win32', ok), legacy);
  const broken = { ...ok, isLegacyToml: async () => true };
  assert.equal((await resolveLegacyWindowsTarget(legacy, env, binary, 'win32', broken)).command, binary);
  for (const different of [{ ...legacy, profile: 'custom' }, { ...legacy, command: 'kcoder' },
    { ...legacy, transport: 'ssh' }, { ...legacy, settingsFile: String.raw`D:\config\settings.toml` }]) {
    assert.equal(await resolveLegacyWindowsTarget(different, env, binary, 'win32', broken), different);
  }
  assert.equal(await resolveLegacyWindowsTarget(legacy, env, '/other/cli', 'win32', broken), legacy);
});

test('source desktop without a packaged CLI pin leaves targets unchanged', async () => {
  const source = { ...env };
  delete source.KCODER_STUDIO_PACKAGED_WINDOWS_BIN;
  const probes = { isMissing: () => assert.fail('Source host must not inspect legacy setup'),
    isLegacyToml: () => assert.fail('Source host must not inspect legacy settings') };
  assert.equal(await resolveLegacyWindowsTarget(legacy, source, binary, 'win32', probes), legacy);
});

// Use real Windows paths when this suite is run by the installer acceptance host.
test('real legacy TOML and working JSON under a .toml filename are distinguished', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-legacy-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import('node:fs/promises');
  const local = { ...env, ProgramData: root, ProgramFiles: root };
  const file = join(root, 'KCoder', 'settings.toml'), command = join(root, 'KCoder Studio', 'resources', 'bin', 'kcoder.exe');
  await mkdir(win32.dirname(file), { recursive: true }); await mkdir(win32.dirname(command), { recursive: true });
  await writeFile(command, 'fixture'); const target = { ...legacy, command, settingsFile: file };
  await writeFile(file, '# previous setup\nmodel_provider = "kc"\n');
  assert.equal((await resolveLegacyWindowsTarget(target, local, binary)).command, binary);
  await writeFile(file, '{"providers":{}}');
  assert.equal(await resolveLegacyWindowsTarget(target, local, binary), target);
});
