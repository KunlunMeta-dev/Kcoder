import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteTargetPlatform, validateRemoteWorkspace, validateRemoteExecutable, remoteSshCommand } from './ssh-launch.mjs';

test('legacy Linux transport keeps its argv and POSIX workspace behavior', () => {
  assert.equal(remoteTargetPlatform(undefined), 'linux');
  assert.equal(validateRemoteWorkspace('/tmp/owned-receiver'), '/tmp/owned-receiver');
  assert.deepEqual(remoteSshCommand('/usr/local/bin/kcoder', ['--cwd', '/tmp/owned-receiver', 'app-server']),
    ['/usr/local/bin/kcoder', '--cwd', '/tmp/owned-receiver', 'app-server']);
  for (const path of ['D:/owned-receiver', '../other', '/tmp/owned;exit']) assert.throws(() => validateRemoteWorkspace(path));
});

test('Windows requires an explicit platform and a local absolute native image', () => {
  assert.equal(validateRemoteWorkspace('D:\\独立 测试\\workspace', 'windows'), 'D:\\独立 测试\\workspace');
  assert.equal(validateRemoteExecutable('D:\\独立 测试\\kcoder.exe', 'windows'), 'D:\\独立 测试\\kcoder.exe');
  for (const path of ['D:relative', '\\\\server\\share', '\\\\?\\C:\\private', '/tmp/owned', 'C:\\name\nother'])
    assert.throws(() => validateRemoteWorkspace(path, 'windows'));
  assert.throws(() => validateRemoteExecutable('D:\\owned\\wrapper.cmd', 'windows'));
  assert.throws(() => remoteTargetPlatform('automatic'));
});

test('Windows argv stays literal and is never appended as a raw SSH command', () => {
  const image = "D:\\Own 'Root\\kcoder.exe";
  const workspace = "D:\\Own 'Root\\workspace $(not-a-command) & literal";
  const result = remoteSshCommand(image, ['--cwd', workspace, 'app-server'], 'windows');
  assert.deepEqual(result.slice(0, 4), ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(result[4], 'base64').toString('utf16le');
  assert.ok(script.includes("& 'D:\\Own ''Root\\kcoder.exe'"));
  assert.ok(script.includes("'D:\\Own ''Root\\workspace $(not-a-command) & literal'"));
  assert.equal(result.some(value => value === workspace), false);
  for (const args of [[''], ['value\ncommand'], Array(65).fill('x')]) assert.throws(() => remoteSshCommand(image, args, 'windows'));
});


test('PowerShell smart single quotes cannot terminate literal remote arguments', () => {
  for (const quote of ["'", '\u2018', '\u2019', '\u201a', '\u201b']) {
    const workspace = `D:\\root${quote}; Write-Output injected; #`;
    const command = remoteSshCommand('D:\\kcoder.exe', ['--cwd', workspace], 'windows');
    const script = Buffer.from(command[4], 'base64').toString('utf16le');
    assert.ok(script.includes(workspace.replace(quote, quote + quote)));
  }
});
