import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

test('installed launcher retains its frozen request and CMD pin before resolving a relocated copy', async () => {
  const runner = await readFile(new URL('../run-installed-windows.ps1', import.meta.url), 'utf8');
  const command = await readFile(new URL('../run-installed-windows.cmd.in', import.meta.url), 'utf8');
  assert.match(runner, /Get-FileHash -LiteralPath \$Request -Algorithm SHA256/);
  assert.match(runner, /-cne \$RequestSha256/);
  assert.ok(runner.indexOf('-cne $RequestSha256') < runner.indexOf('Resolve-KCoderInstalledDirectory'));
  assert.match(runner, /Resolve-KCoderInstalledDirectory -Configuration \$configuration/);
  assert.match(runner, /KCODER_E2E_PACKAGED_DIR=\$install/);
  assert.match(command, /-RequestSha256 @@KCODER_REQUEST_SHA256@@/);
  assert.match(command, /run-installed-windows\.ps1/);
});

test('relocation has one fixed current-user registration and preserves downstream full artifact verification', async () => {
  const resolver = await readFile(new URL('./installed-directory.ps1', import.meta.url), 'utf8');
  const verifier = await readFile(new URL('./installed-desktop-identity.mjs', import.meta.url), 'utf8');
  assert.match(resolver, /HKCU:\\Software\\dde41fb5-2370-5338-807d-3f5c37c73fa3/);
  assert.doesNotMatch(resolver, /HKLM:|Get-ChildItem|Set-ItemProperty|New-ItemProperty|Remove-Item|WriteAllText/);
  assert.match(resolver, /if\(\$explicit\)\{return \$explicit\}/);
  assert.ok(resolver.indexOf('if($explicit){return $explicit}') < resolver.indexOf('$candidate='));
  for (const field of ['manifestSha256', 'hostSha256', 'expectedCommit']) assert.ok(resolver.includes(`$Configuration.${field}`));
  assert.match(verifier, /info\.nlink === 1/);
  assert.match(verifier, /verifyManifest\(resources, \{ expectedCommit: expected\.expectedCommit/);
});

test('actual Windows fixture resolves only matching package bytes and rejects directory aliases without registry changes', {
  skip: process.platform !== 'win32' ? 'Requires actual Windows PowerShell and NTFS junction semantics' : false,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-installed-location-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./installed-directory.verify.ps1', import.meta.url)), '-HelperPath',
    fileURLToPath(new URL('./installed-directory.ps1', import.meta.url)), '-Root', root],
  { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 });
  assert.match(stdout, /PASS: actual Windows installed-directory fixture; checks=\d+; registry writes=0; executables started=0/);
});
