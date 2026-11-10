import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { win32 } from 'node:path';
import test from 'node:test';
import { prepareWindowsHome, writeWindowsProfileSettings } from './windows-user-profile.mjs';
import { runE2E } from './run-context.mjs';
import { hashExecutableFile } from './owned-executable-provenance.mjs';
import { waitForStdioChildClose } from './app-server-stdio.mjs';

function fixture(code = 0) {
  const directories = [], writes = [], children = [];
  const context = {
    stateDir: 'D:\\owned\\run\\state',
    pathInState: (...parts) => win32.join('D:\\owned\\run\\state', ...parts),
    writeStateJson: async (name, value) => { writes.push({ name, value }); return context.pathInState(name); },
    spawnOwned: (...args) => {
      children.push(args);
      return Object.assign(new EventEmitter(), { exitCode: code, signalCode: null });
    },
  };
  const env = { HOME: context.pathInState('home'), USERPROFILE: context.pathInState('home'),
    KCODER_CONFIG_DIR: context.pathInState('config') };
  return { context, env, directories, writes, children,
    makeDirectory: async path => directories.push(path) };
}

test('Windows Home prepares Known Folders and reconciles AppData inside the same owned Home', async () => {
  const f = fixture();
  const initial = { ...f.env, HOME: 'C:\\personal', USERPROFILE: 'C:\\personal', APPDATA: 'C:\\personal',
    LOCALAPPDATA: 'C:\\personal', TEMP: 'C:\\personal', TMP: 'C:\\personal', TMPDIR: 'C:\\personal' };
  const original = { ...initial };
  const temporaryDirectory = f.context.pathInState('short-temp');
  const env = await prepareWindowsHome(f.context, initial, { ...f, temporaryDirectory });
  assert.deepEqual(initial, original, 'caller environment is not mutated');
  assert.equal(env.HOME, env.USERPROFILE);
  assert.equal(env.APPDATA, win32.join(env.HOME, 'AppData/Roaming'));
  assert.equal(env.LOCALAPPDATA, win32.join(env.HOME, 'AppData/Local'));
  assert.equal(env.TEMP, temporaryDirectory, 'short owned temp paths remain supported');
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR'])
    assert.ok(env[name].startsWith(f.context.stateDir), 'ambient personal profile paths are replaced');
  assert.equal(env.TMP, env.TEMP);
  for (const name of ['Downloads', 'Desktop', 'Documents', 'AppData/Local', 'AppData/Roaming'])
    assert.ok(f.directories.includes(win32.join(env.HOME, name)));
  assert.equal(f.children.length, 0, 'Home preparation starts no process');
});

test('explicit outside and traversal Home/temp paths fail before directory creation', async () => {
  for (const override of [
    { home: 'C:\\personal' }, { home: 'relative' },
    { temporaryDirectory: 'D:\\owned\\run\\state\\..\\outside' }, { temporaryDirectory: 'C:\\personal' },
    { home: 'D:\\owned\\run\\state-peer\\home' },
  ]) {
    const f = fixture();
    await assert.rejects(prepareWindowsHome(f.context, f.env, { ...f, ...override }));
    assert.equal(f.directories.length, 0);
  }
});

test('RunContext ancestor checks remain authoritative for Windows Home paths', async () => {
  const f = fixture(), original = f.context.pathInState;
  f.context.pathInState = (...parts) => {
    if (parts.join('\\').includes('AppData')) throw Error('owned state follows a reparse point');
    return original(...parts);
  };
  await assert.rejects(prepareWindowsHome(f.context, f.env, f), /reparse point/);
  assert.ok(f.directories.every(path => !path.includes('AppData')));
});

test('private settings preserve policy and use one owned Native import without values in argv', async () => {
  const f = fixture();
  const settings = { providers: {}, permission_mode: 'accept_edits' };
  const path = await writeWindowsProfileSettings(f.context, {
    cli: 'C:\\package\\kcoder.exe', workspace: f.context.pathInState('workspace'), env: f.env, settings,
  });
  assert.equal(path, win32.join(f.env.KCODER_CONFIG_DIR, 'settings.json'));
  assert.deepEqual(f.writes.map(row => row.value), [settings]);
  assert.equal(f.children.length, 1);
  const [, , args, options] = f.children[0];
  assert.ok(args.includes('import') && args.includes('user'));
  assert.ok(!args.join(' ').includes('accept_edits'), 'configuration travels in the owned file');
  assert.equal(options.env, f.env);
});

test('private settings reject outside profiles/workspaces and propagate Native import failure', async () => {
  for (const field of ['workspace', 'profile']) {
    const f = fixture();
    await assert.rejects(writeWindowsProfileSettings(f.context, {
      cli: 'C:\\package\\kcoder.exe', settings: {},
      workspace: field === 'workspace' ? 'C:\\personal' : f.context.pathInState('workspace'),
      env: { ...f.env, ...(field === 'profile' ? { KCODER_CONFIG_DIR: 'C:\\personal' } : {}) },
    }), /this run state/);
    assert.equal(f.writes.length + f.children.length, 0);
  }
  const f = fixture(1);
  await assert.rejects(writeWindowsProfileSettings(f.context, {
    cli: 'C:\\package\\kcoder.exe', workspace: f.context.pathInState('workspace'), env: f.env, settings: {},
  }), /Native settings import/);
});

test('actual packaged Native import creates a protected current-user-only Windows settings file', {
  skip: process.platform !== 'win32' || !process.env.KCODER_E2E_STATE_NATIVE_BIN,
}, async () => {
  await runE2E(import.meta.url, {
    testId: 'windows-user-profile-private-import', tier: 'full-integration',
    modelPolicy: 'actual packaged CLI config import and Windows ACL; no model or desktop input',
  }, async context => {
    const binary = await hashExecutableFile(process.env.KCODER_E2E_STATE_NATIVE_BIN);
    assert.equal(binary.sha256, process.env.KCODER_E2E_STATE_NATIVE_SHA256);
    const workspace = context.pathInState('workspace'); await mkdir(workspace);
    const env = await prepareWindowsHome(context,
      context.isolatedEnvironment({ KCODER_CONFIG_DIR: context.pathInState('config') }));
    const settings = { providers: {}, hooks: {}, permission_mode: 'accept_edits' };
    const path = await writeWindowsProfileSettings(context, { cli: binary.path, workspace, env, settings });
    const command = `$a=Get-Acl -LiteralPath '${path.replaceAll("'", "''")}';@{protected=$a.AreAccessRulesProtected;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;rules=@($a.Access).Count;inherited=@($a.Access|Where-Object IsInherited).Count}|ConvertTo-Json -Compress`;
    const child = context.spawnOwned('settings-acl', win32.join(process.env.SystemRoot,
      'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { env });
    let output = ''; child.stdout.on('data', data => { output += data; });
    assert.equal((await waitForStdioChildClose(child, 30000, 'settings ACL')).code, 0);
    const acl = JSON.parse(output);
    assert.equal(acl.protected, true); assert.equal(acl.owner, acl.current);
    assert.equal(acl.rules, 1); assert.equal(acl.inherited, 0);
    await context.writeArtifactJson('settings-acl.json', acl);
    return { protectedPrivateFile: true, noModelRequest: true };
  });
});
