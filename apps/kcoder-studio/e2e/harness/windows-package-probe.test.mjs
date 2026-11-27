import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePackageProbe, psLiteral, ownedCleanupScript, ownedCreationScript, rendererTerminalEmulator } from './windows-package-probe.mjs';

test('native terminal fixtures resolve and hash the actual official renderer terminal inputs', async () => {
  const emulator = await rendererTerminalEmulator();
  assert.equal(emulator.name, '@xterm/xterm');
  assert.match(emulator.version, /^\d+\.\d+\.\d+/);
  assert.match(emulator.sha256, /^[a-f0-9]{64}$/);
  assert.ok(emulator.script.endsWith('/lib/xterm.js'));
});

const options = { target: 'win-owned-host', node: 'D:\\Node tools\\node.exe', parent: 'D:\\', commit: 'a'.repeat(40), cliSha256: 'b'.repeat(64), archiveSha256: 'c'.repeat(64) };
test('native package probe requires explicit target, source and payload identities', () => {
  assert.doesNotThrow(() => validatePackageProbe(options));
  for (const field of ['target', 'commit', 'cliSha256', 'archiveSha256', 'node', 'parent']) {
    assert.throws(() => validatePackageProbe({ ...options, [field]: undefined }));
  }
  for (const target of ['-Fconfig', 'a b', 'host;command', 'a@b@c']) assert.throws(() => validatePackageProbe({ ...options, target }));
  for (const parent of ['relative', '\\\\server\\share', 'D:\\bad\npath', "D:\\quote'path"]) assert.throws(() => validatePackageProbe({ ...options, parent }));
});
test('migration package acceptance remains explicitly selected and source-bound', () => {
  assert.doesNotThrow(() => validatePackageProbe({ ...options, focus: 'migration' }));
  assert.throws(() => validatePackageProbe({ ...options, focus: 'migration', commit: undefined }));
  assert.throws(() => validatePackageProbe({ ...options, focus: 'migration', cliSha256: undefined }));
  assert.throws(() => validatePackageProbe({ ...options, focus: 'arbitrary-code' }));
  const native = { ...options, focus: 'migration', catalogLockTests: '/owned/lock-tests.exe', catalogLockTestsSha256: 'd'.repeat(64) };
  assert.doesNotThrow(() => validatePackageProbe(native));
  assert.doesNotThrow(() => validatePackageProbe({ ...native, catalogLockTestMode: 'vfs' }));
  assert.throws(() => validatePackageProbe({ ...native, catalogLockTestMode: 'arbitrary-filter' }));
  assert.throws(() => validatePackageProbe({ ...native, catalogLockTestsSha256: undefined }));
  assert.throws(() => validatePackageProbe({ ...native, focus: 'studio' }));
});
test('PowerShell paths are literal values and reject frame injection', () => {
  assert.equal(psLiteral("D:\\O'Brien $(ignored)"), "'D:\\O''Brien $(ignored)'");
  for (const text of ['a\nb', 'a\rb', 'a\0b']) assert.throws(() => psLiteral(text));
});
test('installed binary probes remain source-bound and never select an installer too', () => {
  const installed = { ...options, installedDirectory: 'C:\\Programs\\KCoder Studio', archiveSha256: undefined };
  assert.doesNotThrow(() => validatePackageProbe(installed));
  for (const field of ['commit', 'cliSha256']) assert.throws(() => validatePackageProbe({ ...installed, [field]: undefined }));
  for (const installedDirectory of ['', 'relative', '\\\\server\\share', 'D:\\bad\npath']) assert.throws(() => validatePackageProbe({ ...installed, installedDirectory }));
  assert.throws(() => validatePackageProbe({ ...installed, archive: '/local/app.7z' }));
  assert.throws(() => validatePackageProbe({ ...installed, archiveSha256: 'c'.repeat(64) }));
  assert.doesNotMatch(ownedCleanupScript('D:\\owned-root', 'owner'), /installedDirectory|Programs/);
});
test('cleanup checks the owner and exact process creation identity before deleting its root', () => {
  const script = ownedCleanupScript('D:\\owned-root', 'unique-owner');
  assert.ok(script.indexOf('Ownership mismatch') < script.indexOf('taskkill'));
  assert.ok(script.indexOf('Process identity changed') < script.indexOf('taskkill'));
  assert.ok(script.indexOf('Owned package processes still running') < script.indexOf('[IO.Directory]::Delete'));
  assert.match(script, /CreationDate\.ToUniversalTime\(\)\.Ticks/);
  assert.doesNotMatch(script, /taskkill\s+\/IM|Stop-Process\s+-Name/);
});
test('native fixtures isolate inherited shared-drive ACLs before creating their ownership receipt', () => {
  const script = ownedCreationScript('D:\\', '12345678-1234-1234-1234-123456789abc');
  assert.ok(script.indexOf('Owned path collision') < script.indexOf('New-Item'));
  assert.ok(script.indexOf('icacls $p /inheritance:r') < script.indexOf('[IO.File]::WriteAllText'));
  assert.match(script, /\$LASTEXITCODE -ne 0/);
  assert.match(script, /if\(\$created\)\{\[IO.Directory\]::Delete/);
  assert.throws(() => ownedCreationScript('D:\\', 'foreign-owner'));
});

test('task board Native acceptance keeps explicit package and host identity requirements', () => {
  assert.doesNotThrow(() => validatePackageProbe({ ...options, focus: 'task-board' }));
  assert.throws(() => validatePackageProbe({ ...options, focus: 'task-board', cliSha256: undefined }));
  assert.throws(() => validatePackageProbe({ ...options, focus: 'task-board', target: undefined }));
});

test('workflow authoring protocol probe requires the selected Windows image and target', () => {
  assert.doesNotThrow(() => validatePackageProbe({ ...options, focus: 'workflow-draft' }));
  assert.throws(() => validatePackageProbe({ ...options, focus: 'workflow-draft', target: undefined }));
  assert.throws(() => validatePackageProbe({ ...options, focus: 'workflow-draft', cliSha256: undefined }));
});
