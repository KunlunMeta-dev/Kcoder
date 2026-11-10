import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { secureWindowsRunState } from './windows-state-directory.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runE2E } from './run-context.mjs';
import { hashExecutableFile } from './owned-executable-provenance.mjs';
import { waitForStdioChildClose } from './app-server-stdio.mjs';
import { prepareWindowsHome, writeWindowsProfileSettings } from './windows-user-profile.mjs';

const receipt = path => ({ path, ownerSid: 'S-1-5-21-123-1001', currentSid: 'S-1-5-21-123-1001', protected: true, aceCount: 1, inheritableFullControl: true });

test('private Windows state setup is scoped and verifies the native ACL receipt', async () => {
  let calls = 0;
  const value = await secureWindowsRunState('D:\\owned\\run\\state', 'D:\\owned\\run', {
    systemRoot: 'C:\\Windows', execute: async (_command, args, options) => {
      calls++;
      assert.ok(args.includes('-StateDirectory') && args.includes('D:\\owned\\run\\state'));
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 30000);
      return { stdout: JSON.stringify(receipt('D:\\owned\\run\\state')) };
    },
  });
  assert.equal(calls, 1); assert.equal(value.protected, true);
});

test('private Windows state refuses an outside path before launching PowerShell', async () => {
  let calls = 0;
  await assert.rejects(secureWindowsRunState('D:\\personal', 'D:\\owned\\run', {
    systemRoot: 'C:\\Windows', execute: async () => { calls++; },
  }), /owned state/);
  assert.equal(calls, 0);
});

test('a successful command without exclusive inheritable ownership is not accepted', async () => {
  const invalid = { ...receipt('D:\\owned\\run\\state'), protected: false };
  await assert.rejects(secureWindowsRunState(invalid.path, 'D:\\owned\\run', {
    systemRoot: 'C:\\Windows', execute: async () => ({ stdout: JSON.stringify(invalid) }),
  }));
});

test('actual Windows state directory has a verified current-user-only inheritable ACL', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'kcoder-state-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state'); await mkdir(state);
  const value = await secureWindowsRunState(state, root);
  assert.equal(value.ownerSid, value.currentSid);
  await mkdir(join(state, 'review-config'));
});

test('actual Windows private state setup does not require audit privilege', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'kcoder-state-no-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state'), temporary = join(root, 'compiler-temp');
  await mkdir(state); await mkdir(temporary);
  const { stdout } = await promisify(execFile)(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('windows-state-directory.verify.ps1', import.meta.url)),
    '-SourcePath', fileURLToPath(new URL('windows-state-directory.ps1', import.meta.url)),
    '-StateDirectory', state, '-RunRoot', root,
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, TEMP: temporary, TMP: temporary } });
  assert.match(stdout, /PASS: private state setup without SeSecurityPrivilege/);
});

test('the pinned packaged Windows CLI can normalize and read the isolated private config', {
  skip: process.platform !== 'win32' || !process.env.KCODER_E2E_STATE_NATIVE_BIN,
}, async () => {
  await runE2E(import.meta.url, {
    testId: 'windows-private-state-packaged-cli', tier: 'full-integration',
    modelPolicy: 'real pinned packaged Native config read, isolated state only; no turn or Provider request',
  }, async context => {
    const binary = await hashExecutableFile(process.env.KCODER_E2E_STATE_NATIVE_BIN);
    assert.match(process.env.KCODER_E2E_STATE_NATIVE_SHA256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(binary.sha256, process.env.KCODER_E2E_STATE_NATIVE_SHA256);
    const config = context.pathInState('review-config'), workspace = context.pathInState('workspace');
    await mkdir(config); await mkdir(workspace);
    const env = await prepareWindowsHome(context,
      context.isolatedEnvironment({ KCODER_CONFIG_DIR: config, XDG_CONFIG_HOME: config }));
    const settings = await writeWindowsProfileSettings(context, {
      cli: binary.path, workspace, env, settings: { providers: {}, hooks: {}, permission_mode: 'accept_edits' },
    });
    const child = context.spawnOwned('packaged-native-config', binary.path,
      ['--settings-file', settings, '--cwd', workspace, 'config', 'get', 'permission_mode'], {
        cwd: workspace, env,
      });
    let output = '';
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-4096); });
    const closed = await waitForStdioChildClose(child, 30000, 'packaged Native config read');
    assert.equal(closed.code, 0);
    assert.equal(output.trim(), 'accept_edits');
    await context.writeArtifactJson('packaged-config-read.json', { binary: { path: binary.path, sha256: binary.sha256 }, value: output.trim(), exitCode: closed.code });
    return { privateConfigReadable: true, noModelRequest: true };
  });
});
