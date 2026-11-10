import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runE2E } from './run-context.mjs';
import { windowsSshInvocation } from './windows-ssh-auth.mjs';
import { ownedCreationScript, ownedCleanupScript, psLiteral } from './windows-package-probe.mjs';

test('actual Windows parser accepts versioned Office source in owned temporary files', {
  skip: process.env.KCODER_E2E_WINDOWS_OFFICE_SYNTAX !== '1',
}, async () => {
  const scope = process.env.KCODER_E2E_WINDOWS_PS_SYNTAX_SCOPE ?? 'office';
  assert.ok(['office', 'browser'].includes(scope));
  const names = scope === 'browser' ? ['windows-browser-profile-probe.ps1',
    'windows-installer-session.ps1', 'windows-installer-user.ps1'] : ['windows-office-save-dialog.ps1', 'windows-office-startup-observation.ps1',
    'windows-office-process-probe.ps1', 'windows-office-docx-reader.ps1',
    'windows-installer-session.ps1', 'windows-installer-user.ps1'];
  await runE2E(import.meta.url, {
    testId: 'readonly-windows-office-powershell-syntax', tier: 'manual-live',
    modelPolicy: 'Copy versioned source into an owned temporary directory, then ParseFile without executing supplied source. No App, account, profile, installer, model or personal changes.',
  }, async context => {
    const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
    assert.match(target ?? '', /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/);
    let sequence = 0;
    const args = code => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=4',
      '-o', 'ServerAliveCountMax=1', '-S', 'none', target, 'powershell', '-NoProfile', '-NonInteractive',
      '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + code, 'utf16le').toString('base64')];
    const execute = (command, values) => new Promise((resolve, reject) => {
      const spec = windowsSshInvocation(context, command, values, target), label = `office-parser-${++sequence}`;
      const child = context.spawnOwned(label, spec.command, spec.args, spec.options);
      let output = '', error = '';
      const timer = setTimeout(() => { void context.stopOwned(label); reject(Error('Owned parser transport deadline')); }, 30000);
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { error = (error + data).slice(-2000); });
      child.once('error', failure => { clearTimeout(timer); reject(failure); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(Error('Owned parser transport failed ' + context.redactText(error))); });
    });
    const owner = randomUUID();
    const root = JSON.parse((await execute('ssh', args(ownedCreationScript('D:\\', owner)))).trim());
    const cleanupPath = context.pathInArtifacts('windows-office-parser-cleanup.json');
    context.addCleanup('remove owned parser source copies', async () => {
      const spec = windowsSshInvocation(context, 'ssh', args(ownedCleanupScript(root, owner)), target);
      const result = await promisify(execFile)(spec.command, spec.args, { ...spec.options, timeout: 30000 });
      const receipt = JSON.parse(result.stdout.trim());
      await writeFile(cleanupPath, JSON.stringify(receipt));
      assert.equal(receipt.cleaned, true);
    });
    for (const name of names) await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlPath=none',
      fileURLToPath(new URL(name, import.meta.url)), `${target}:${root.replaceAll('\\', '/')}/${name}`]);
    const code = `$root=${psLiteral(root)};$m=Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json;if($m.owner -ne '${owner}'){throw 'Parser owner changed'};$reports=@();foreach($name in @(${names.map(psLiteral).join(',')})){$tokens=$null;$errors=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $name),[ref]$tokens,[ref]$errors);$reports+=@{name=$name;errors=@($errors|ForEach-Object{@{id=$_.ErrorId;line=$_.Extent.StartLineNumber}})}};$reports|ConvertTo-Json -Depth 5 -Compress`;
    const reports = JSON.parse((await execute('ssh', args(code))).trim());
    await context.writeArtifactJson('windows-office-source-syntax.json', reports);
    assert.deepEqual(reports.map(item => item.name), names);
    for (const report of reports) assert.deepEqual(report.errors, []);
  });
});
