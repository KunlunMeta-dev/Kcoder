import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { windowsSshInvocation } from './windows-ssh-auth.mjs';
import { psLiteral } from './windows-package-probe.mjs';

export function validateKeyringLogonOptions(options) {
  assert.equal(options.consent, '1', 'Explicit owned Windows logon test consent required');
  assert.match(options.target ?? '', /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/);
  assert.match(options.parent ?? '', /^[D-Zd-z]:\\$/);
  assert.equal(options.mode, 'preflight', 'Account creation is not enabled before adapter review');
}

export function validateLogonPreflight(value) {
  assert.equal(value.readOnly, true);
  for (const name of ['accountsCreated', 'vaultCalls', 'scheduledTasksCreated']) assert.equal(value[name], 0);
  assert.equal(value.normalLogonAttempted, false);
  assert.equal(value.borrowedConsoleIdentity, false);
  assert.equal(value.prerequisitesReady, true, 'Normal owned logon prerequisites are unavailable; this is not a keyring pass');
  assert.equal(value.effectiveAdministrator, true);
  assert.equal(value.isLocalSystem, false);
  assert.equal(value.localAccountsCommandsAvailable, true);
  assert.equal(value.secondaryLogonPresent, true);
  assert.ok(['Manual', 'Automatic'].includes(value.secondaryLogonStartType));
  assert.equal(value.fixedNtfsParent, true);
  assert.equal(value.domainController, false);
}

export async function runKeyringLogonPreflight(context, options) {
  validateKeyringLogonOptions(options);
  const source = new URL('./windows-keyring-logon-preflight.ps1', import.meta.url);
  const script = await readFile(source, 'utf8');
  await context.writeArtifactJson('keyring-logon-preflight-source.json', {
    source: 'windows-keyring-logon-preflight.ps1', sha256: createHash('sha256').update(script).digest('hex'),
    scope: 'read-only prerequisites; account/logon/credential APIs not executed',
  });
  const command = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);& {${script}} -Parent ${psLiteral(options.parent)}`;
  const raw = await runKeyringWindowsCommand(context, options.target, 'keyring-logon-readonly-preflight', 'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', options.target, 'powershell', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
  const value = JSON.parse(raw.trim());
  await context.writeArtifactJson('keyring-logon-preflight.json', value);
  validateLogonPreflight(value);
  return { ...value, keyringVerified: false, coreMigrationVerified: false, hostMigrationVerified: false };
}

// RunContext remains the sole process/tree owner; callers supply only structured argv.
export async function runKeyringWindowsCommand(context, target, label, command, args, { input, timeoutMs = 30000, cleanup = false } = {}) {
  assert.ok(['ssh', 'scp'].includes(command));
  const spec = windowsSshInvocation(context, command, args, target);
  const spawn = cleanup ? context.spawnCleanupOwned.bind(context) : context.spawnOwned.bind(context);
  const child = spawn(label, spec.command, spec.args, { ...spec.options, stdin: input === undefined ? 'ignore' : 'pipe' });
  let bytes = 0, stdout = '', stderr = '';
  const output = new Promise((accept, reject) => {
    const fail = error => { void context.stopOwned(label); reject(error); };
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 65536) fail(Error('Owned logon output limit')); else stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
    child.once('error', fail);
    if (input !== undefined) child.stdin.once('error', fail);
    child.once('close', code => code === 0 ? accept(stdout) : reject(Error(`Owned logon preflight failed (${code}): ${context.redactText(stderr)}`)));
  });
  let timer;
  try {
    // Keep authority stdin open. EOF is cancellation for an owned session controller.
    if (input !== undefined) child.stdin.write(input);
    const raw = await Promise.race([output, new Promise((_, reject) => {
      timer = setTimeout(() => { void context.stopOwned(label); reject(Error('Owned logon command deadline')); }, timeoutMs);
    })]);
    return raw;
  } finally { clearTimeout(timer); await context.stopOwned(label); }
}
