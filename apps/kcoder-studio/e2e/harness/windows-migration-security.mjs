import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsSshInvocation } from './windows-ssh-auth.mjs';
import { ownedCreationScript, ownedStopScript, ownedCleanupScript, psLiteral } from './windows-package-probe.mjs';

export function validateSecurityOptions(options) {
  assert.equal(options.consent, '1', 'explicit native synthetic-credential consent required');
  assert.match(options.target ?? '', /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/);
  assert.match(options.parent ?? '', /^[D-Zd-z]:\\[^\0\r\n"'<>|?*]*$/);
  assert.match(options.helperSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(options.baselineSource ?? '', /^[a-f0-9]{40}$/);
  assert.ok(typeof options.helper === 'string' && options.helper.length > 0);
}

export async function runWindowsMigrationSecurity(context, options) {
  validateSecurityOptions(options);
  const meta = await lstat(options.helper);
  assert.ok(meta.isFile() && !meta.isSymbolicLink() && meta.size < 64 * 1024 * 1024);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(options.helper)) hash.update(chunk);
  assert.equal(hash.digest('hex'), options.helperSha256);
  let sequence = 0;
  const execute = (command, args, { input, timeoutMs = 60000 } = {}) => new Promise((accept, reject) => {
    const spec = windowsSshInvocation(context, command, args, options.target);
    const label = `windows-security-${++sequence}`;
    const child = context.spawnOwned(label, spec.command, spec.args, { ...spec.options, stdin: input === undefined ? 'ignore' : 'pipe' });
    let output = '', diagnostic = '', bytes = 0, ended = false;
    const fail = error => { if (ended) return; ended = true; clearTimeout(timer); void context.stopOwned(label); reject(error); };
    const timer = setTimeout(() => fail(Error('Owned Windows security command timed out')), timeoutMs);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 128 * 1024) fail(Error('Owned security output exceeded limit')); else output += data; });
    child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-4096); });
    child.once('error', fail);
    child.once('close', code => { if (ended) return; ended = true; clearTimeout(timer);
      code === 0 ? accept(output) : reject(Error(`Owned security command failed (${code}): ${context.redactText(diagnostic).slice(-2048)}`)); });
    if (input !== undefined) child.stdin.write(input);
  });
  const args = script => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', options.target,
    'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')];
  const ps = (script, settings) => execute('ssh', args(script), settings);
  const owner = randomUUID();
  const root = JSON.parse((await ps(ownedCreationScript(options.parent, owner))).trim());
  assert.equal(root, options.parent.replace(/\\$/, '') + '\\kcoder-package-' + owner);
  let helperVerified = false;
  const credentialCleanupPath = context.pathInArtifacts('windows-security-credential-cleanup.json');
  const cleanupPath = context.pathInArtifacts('windows-security-cleanup.json');
  context.addCleanup('reconcile owned synthetic credential then remove Windows fixture', async () => {
    const invoke = async script => {
      const spec = windowsSshInvocation(context, 'ssh', args(script), options.target);
      return (await promisify(execFile)(spec.command, spec.args, { ...spec.options, timeout: 60000, maxBuffer: 131072 })).stdout;
    };
    await invoke(ownedStopScript(root, owner, 'security-helper.exe'));
    let credential = { safeToRemoveRoot: true, disposition: 'helper_never_started', systemEntryAbsenceVerified: false };
    if (helperVerified) {
      credential = JSON.parse((await invoke(`& ${psLiteral(root + '\\security-helper.exe')} --cleanup ${psLiteral(root)} ${psLiteral(owner)};if($LASTEXITCODE -ne 0){throw 'Credential cleanup helper failed'}`)).trim());
      await writeFile(credentialCleanupPath, JSON.stringify(context.redactValue(credential), null, 2) + '\n', { mode: 0o600 });
      assert.equal(credential.safeToRemoveRoot, true, 'unconfirmed/changed credentials retain the owned intent and directory');
    }
    const cleaned = JSON.parse((await invoke(ownedCleanupScript(root, owner, 'security-helper.exe'))).trim());
    await writeFile(cleanupPath, JSON.stringify(context.redactValue({ ...cleaned, storeCleanup: credential }), null, 2) + '\n', { mode: 0o600 });
    assert.equal(cleaned.cleaned, true);
  });
  await context.writeArtifactJson('windows-security-input.json', { root, owner, baselineSource: options.baselineSource,
    helperSha256: options.helperSha256, credentialScope: 'one exact UUID synthetic account; no enumeration, personal credentials, settings, login, installation or GUI' });
  await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', options.helper, `${options.target}:${root.replaceAll('\\', '/')}/security-helper.exe`]);
  await ps(`if((Get-FileHash -LiteralPath ${psLiteral(root + '\\security-helper.exe')} -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${options.helperSha256}'){throw 'Native helper transfer mismatch'}`);
  helperVerified = true;
  await ps(`$root=${psLiteral(root)};$safe=Join-Path $root '资料 空格';$peer=Join-Path $root 'peer';foreach($p in @($safe,$peer,(Join-Path $peer 'nested'),(Join-Path $root 'temp'),(Join-Path $root 'isolated-profile'))){[IO.Directory]::CreateDirectory($p)|Out-Null};[IO.File]::WriteAllText((Join-Path $peer 'sentinel.txt'),'owned peer sentinel');[IO.File]::WriteAllText((Join-Path $peer 'settings.json'),'{}');New-Item -ItemType Junction -Path (Join-Path $safe 'linked') -Target $peer|Out-Null;New-Item -ItemType HardLink -Path (Join-Path $safe 'hardlink.txt') -Target (Join-Path $peer 'sentinel.txt')|Out-Null`);
  const secret = 'SYNTHETIC_WINDOWS_CREDENTIAL_' + randomBytes(32).toString('hex');
  context.registerSecret(secret);
  const raw = await ps(`& ${psLiteral(root + '\\security-helper.exe')} --host ${psLiteral(root)} ${psLiteral(owner)};if($LASTEXITCODE -ne 0){throw 'Native security helper failed'}`, { input: JSON.stringify({ owner, secret }) + '\n', timeoutMs: 90000 });
  const result = JSON.parse(raw.trim());
  await context.writeArtifactJson('windows-security-result.json', result);
  assert.equal(result.baselineSource, options.baselineSource);
  assert.equal(result.paths?.status, 'passed');
  assert.equal(result.osVault?.status, 'passed', `Credential Manager ${result.osVault?.status}: ${result.osVault?.reason} (${result.osVault?.platformCode})`);
  assert.equal(result.osVault.fileBackendUsed, false);
  assert.equal(result.osVault.cleanup?.systemEntryAbsenceVerified, true);
  return result;
}
