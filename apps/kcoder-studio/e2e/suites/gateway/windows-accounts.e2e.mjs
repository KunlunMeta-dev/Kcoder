import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';

// QA: a private copy of the installed Windows app authenticates the deployed account
// entry, creates one owned fixture identity, and preserves login across renderer reload.
const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
const control = process.env.KCODER_E2E_WINDOWS_SSH_CONTROL_PATH;
const installation = process.env.KCODER_E2E_WINDOWS_STUDIO_DIRECTORY;
const accountState = process.env.KCODER_E2E_ACCOUNT_STATE_DIRECTORY;
if (!target || !control || !installation || !accountState || process.getuid?.() !== 0) throw new Error('Explicit Windows target, installation and local account store are required');
let text = '';
for await (const chunk of process.stdin) { text += chunk; if (text.length > 8192) throw new Error('Account input too large'); }
const authentication = JSON.parse(text);
text = '';
await runE2E(import.meta.url, {
  testId: 'windows-installed-kcoder-account-administration', tier: 'manual-live', modelPolicy: 'model-independent native Windows account authentication and controls',
}, async context => {
  context.registerSecret(authentication.password);
  const testUsername = 'qa_' + randomBytes(8).toString('hex');
  const execute = promisify(execFile);
  const psArgs = script => ['-S', control, target, 'powershell -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from("$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64')];
  const ps = async script => (await execute('ssh', psArgs(script), { timeout: 15000 })).stdout.trim();
  const directory = await ps(`$p=Join-Path $env:TEMP 'kcoder-accounts-${testUsername}';New-Item -ItemType Directory -Path $p -ErrorAction Stop | Out-Null;Write-Output $p`);
  assert.ok(!directory.includes("'") && directory.endsWith(testUsername));
  context.addCleanup('remove owned Windows account probe', () => ps(`[IO.Directory]::Delete('${directory}',$true);if([IO.Directory]::Exists('${directory}')){throw 'Cleanup failed'}`));
  // The switch flow signs in as this fixture identity, so its worker binding
  // (allocated on first login) must be removed together with the account.
  context.addCleanup('remove fixture account and its worker binding', async () => {
    const code = `import shutil, subprocess, sys\nfrom pathlib import Path\nsys.path.insert(0,'scripts/install/lib')\nfrom studio_accounts import AccountStore\nfrom studio_account_files import locked,write_private_json\ns=AccountStore(Path(sys.argv[1]))\nwith locked(s.lock):\n d=s._load()\n records=[r for r in d['accounts'] if r['username']==sys.argv[2]]\n for r in records:\n  assert r['role']=='user'\n  binding=d['bindings'].pop(r['id'], None)\n  if binding:\n   worker=subprocess.run(['getent','passwd',str(binding['uid'])],capture_output=True,text=True).stdout.strip()\n   name=worker.split(':')[0] if worker else None\n   shutil.rmtree(binding['home'], ignore_errors=True)\n   if name:\n    subprocess.run(['/usr/sbin/userdel', name], check=False)\n d['accounts']=[r for r in d['accounts'] if r['username']!=sys.argv[2]]\n write_private_json(s.path,d)\n`;
    await execute('/usr/bin/python3', ['-I', '-c', code, accountState, testUsername], { cwd: repoRoot, timeout: 10000 });
  });
  await execute('scp', ['-o', `ControlPath=${control}`, resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-studio-ui-probe.cjs'), `${target}:${directory.replaceAll('\\', '/')}/probe.cjs`], { timeout: 15000 });
  assert.ok(!installation.includes("'"));
  const args = psArgs(`& node '${directory}\\probe.cjs' '${installation}\\resources\\bin\\kcoder.exe' '${installation}' '${directory}' '${directory}' --installed-resources --accounts;if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`);
  const output = await new Promise((resolveOutput, reject) => {
    const child = context.spawnOwned('windows-account-probe', 'ssh', args, { stdin: 'pipe' });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill(), 240000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolveOutput(stdout) : reject(new Error(context.redactText(stdout || stderr || 'Windows account probe failed'))); });
    child.stdin.end(JSON.stringify({ ...authentication, testUsername }));
  });
  const result = JSON.parse(output.trim());
  assert.equal(result.result.passed, true);
  assert.equal(result.cleaned, true);
  await context.writeArtifactJson('windows-accounts.json', result);
});
