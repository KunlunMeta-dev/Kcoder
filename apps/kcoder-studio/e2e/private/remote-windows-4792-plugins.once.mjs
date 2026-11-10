import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { open, mkdir, rm, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, win32 } from 'node:path';
import { gzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { runE2E } from '../harness/run-context.mjs';
import { AppServerStdioClient, waitForStdioChildClose } from '../harness/app-server-stdio.mjs';

const HOST_KEY_ALIAS = 'relay-target-4792';
const REMOTE_USER = 'kunlun@127.0.0.1';
const PLUGIN_ID = 'ppt-implement@workbuddy-teams';
const PLUGIN_ROOT = 'C:\\Users\\kunlun\\.config\\kcoder\\plugin_store\\cache\\workbuddy-teams\\ppt-implement\\install-2bf12d7deb7243af9c2afcdd16befd3e';
const exec = promisify(execFile);
const phase = process.env.KCODER_4792_PLUGIN_TEST_PHASE;
const binary = process.env.KCODER_4792_PLUGIN_TEST_BIN;
if (process.env.KCODER_E2E_REAL_MODEL !== '1' || process.env.KCODER_E2E_REMOTE_WINDOWS !== '1') {
  throw new Error('Explicit remote Windows and real-model consent is required');
}
if (!['baseline', 'patch', 'export'].includes(phase)) throw new Error('Set KCODER_4792_PLUGIN_TEST_PHASE to baseline, patch or export');
if (typeof binary !== 'string' || !win32.isAbsolute(binary) || win32.extname(binary).toLowerCase() !== '.exe'
  || /[%&|<>^"\r\n]/.test(binary)) {
  throw new Error('KCODER_4792_PLUGIN_TEST_BIN must be an absolute Windows .exe path');
}

const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
const PS_ENCODED_PREFIX = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ';
const PS_LOADER_PREFIX = 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command ';
const MAX_PS_COMMAND_CHARS = 7000;
const encodePsUtf16 = source => Buffer.from(source, 'utf16le').toString('base64');
const psCommand = script => {
  const source = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';\n" + script;
  let command = PS_ENCODED_PREFIX + encodePsUtf16(source);
  if (command.length > MAX_PS_COMMAND_CHARS) {
    const payload = gzipSync(Buffer.from(source, 'utf8')).toString('base64');
    const unpack = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$b=[Convert]::FromBase64String('"
      + payload
      + "');$m=[IO.MemoryStream]::new($b);$g=[IO.Compression.GzipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);Invoke-Expression ($r.ReadToEnd())";
    assert.ok(!/["%`\r\n]/.test(unpack), 'PowerShell loader must remain safe inside the Windows command-line quotes');
    command = PS_LOADER_PREFIX + '"' + unpack + '"';
  }
  assert.ok(command.length <= MAX_PS_COMMAND_CHARS,
    'Complete remote PowerShell command exceeds the 7000-character safety limit');
  return command;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function protectedInput(path, label, maxBytes, privateFile = true) {
  if (!isAbsolute(path) || typeof process.getuid !== 'function' || fsConstants.O_NOFOLLOW === undefined) {
    throw new Error(label + ' input cannot be validated safely');
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.size > maxBytes
      || (privateFile ? (info.mode & 0o177) !== 0 : (info.mode & 0o022) !== 0)) {
      throw new Error(label + ' input ownership or mode is unsafe');
    }
    return await handle.readFile();
  } catch {
    throw new Error(label + ' input could not be opened safely');
  } finally {
    await handle?.close();
  }
}

function exactKnownHosts(text) {
  const entries = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!entries.length || entries.some(line => {
    const [host, type, key] = line.split(/\s+/);
    return !(host === HOST_KEY_ALIAS || /^\|[12]\|[^|\s]+\|[^|\s]+$/.test(host || ''))
      || !/^(ssh-|ecdsa-|sk-ssh-|rsa-sha2-)/.test(type || '')
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(key || '');
  })) throw new Error('Known-hosts selection is not exact and valid');
  return [...new Set(entries)].join('\n') + '\n';
}

function fixtureProbe(nonce, binary) {
  return [
    '$nonce=' + psQuote(nonce) + ';$binary=[IO.Path]::GetFullPath(' + psQuote(binary) + ');$gitRoot=Join-Path $env:LOCALAPPDATA "Programs\\Git";$env:PATH=$env:PATH+";"+(Join-Path $gitRoot "bin")+";"+(Join-Path $gitRoot "cmd")+";"+(Join-Path $gitRoot "usr\\bin");',
    '$nodePath=(Get-Command "node.exe" -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source;$npmPath=(Get-Command "npm.cmd" -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source;$yarnPath=(Get-Command "yarn.cmd" -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source;$gitPath=(Get-Command "git.exe" -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source;$bashPath=(Get-Command "bash.exe" -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source;',
    '$gitBin=Join-Path $gitRoot "bin";$gitCmd=Join-Path $gitRoot "cmd";$gitUsrBin=Join-Path $gitRoot "usr\\bin";$gitExpected=@((Join-Path $gitBin "git.exe"),(Join-Path $gitCmd "git.exe"),(Join-Path $gitUsrBin "git.exe"));$bashExpected=@((Join-Path $gitBin "bash.exe"),(Join-Path $gitUsrBin "bash.exe"));if(!($gitExpected -contains $gitPath) -or !($bashExpected -contains $bashPath)){throw "git_path_unexpected"};',
    'foreach($p in @($binary,$nodePath,$npmPath,$yarnPath,$gitPath,$bashPath)){if(!(Test-Path -LiteralPath $p -PathType Leaf)){throw "required_command_missing"}};foreach($p in @($gitBin,$gitCmd,$gitUsrBin)){if(!(Test-Path -LiteralPath $p -PathType Container)){throw "git_directory_missing"}};',
    '$nodeDir=Split-Path -Parent $nodePath;$npmDir=Split-Path -Parent $npmPath;$yarnPrefix=Split-Path -Parent $yarnPath;$system32=Join-Path $env:SystemRoot "System32";$windowsPowerShell=Join-Path $system32 "WindowsPowerShell\\v1.0";$apps=Join-Path $env:LOCALAPPDATA "Microsoft\\WindowsApps";',
    'foreach($p in @($system32,$windowsPowerShell)){if(!(Test-Path -LiteralPath $p -PathType Container)){throw "system_directory_missing"}};$pathEntries=@($nodeDir,$npmDir,$yarnPrefix,$gitBin,$gitCmd,$gitUsrBin,$system32,$windowsPowerShell)|Where-Object{$_}|ForEach-Object{[IO.Path]::GetFullPath($_)}|Select-Object -Unique;if(@($pathEntries|Where-Object{$_ -ieq [IO.Path]::GetFullPath($apps)}).Count){throw "windowsapps_path_forbidden"};',
    '$folder=Join-Path $env:TEMP ("kcoder-4792-plugin-"+$nonce);if(Test-Path -LiteralPath $folder){throw "fixture_exists"};[void][IO.Directory]::CreateDirectory($folder);$ownerPath=Join-Path $folder ".kcoder-4792-owner.json";$owner=[ordered]@{nonce=$nonce;processPid=0;binary=$binary};[IO.File]::WriteAllText($ownerPath,(ConvertTo-Json -Compress -InputObject $owner),(New-Object Text.UTF8Encoding($false)));',
    '$result=[ordered]@{nonce=$nonce;folder=$folder;binary=$binary;processPid=0;commands=[ordered]@{node=$nodePath;npm=$npmPath;yarn=$yarnPath;git=$gitPath;bash=$bashPath};requiredPathEntries=@($gitBin,$gitCmd,$gitUsrBin,$system32,$windowsPowerShell);pathEntries=@($pathEntries);windowsApps=$apps};$json=ConvertTo-Json -Compress -InputObject $result;[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))',
  ].join('\n');
}

function processReceiptProbe(folder, nonce, binary) {
  return [
    '$root=' + psQuote(folder) + ';$nonce=' + psQuote(nonce) + ';$bin=' + psQuote(binary) + ';$ownerPath=Join-Path $root ".kcoder-4792-owner.json";',
    'for($attempt=0;$attempt -lt 60;$attempt++){$found=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath -ieq $bin -and $_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase)-ge 0});if($found.Count -gt 1){[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{updated=$false;ambiguous=$true;pids=@($found|ForEach-Object{[int]$_.ProcessId})})));exit 0};if($found.Count -eq 1){$owner=Get-Content -Raw -LiteralPath $ownerPath|ConvertFrom-Json;if($owner.nonce -ne $nonce -or $owner.binary -ine $bin -or [int]$owner.processPid -ne 0){throw "owner_receipt_mismatch"};$pidValue=[int]$found[0].ProcessId;$updated=[ordered]@{nonce=$nonce;processPid=$pidValue;binary=$bin};$temp=$ownerPath+".tmp-"+[Guid]::NewGuid().ToString("N");[IO.File]::WriteAllText($temp,(ConvertTo-Json -Compress -InputObject $updated),(New-Object Text.UTF8Encoding($false)));$backupPath=$ownerPath+".previous";if(Test-Path -LiteralPath $backupPath){throw "receipt_backup_exists"};[IO.File]::Replace($temp,$ownerPath,$backupPath);[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{updated=$true;pid=$pidValue;ambiguous=$false})));exit 0};Start-Sleep -Milliseconds 500};',
    '[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{updated=$false;ambiguous=$false;pids=@()})))',
  ].join('\n');
}

const CMD_PATH_UNSAFE = /[%&|<>^"\r\n]/;
const CMD_PATH_ENTRY_UNSAFE = /[%&|<>^;"\r\n]/;
function validateRemotePath(value, label, pathEntry = false) {
  assert.equal(typeof value, 'string', label + ' must be a path string');
  assert.ok(win32.isAbsolute(value), label + ' must be absolute');
  assert.ok(!(pathEntry ? CMD_PATH_ENTRY_UNSAFE : CMD_PATH_UNSAFE).test(value), label + ' contains a Windows cmd metacharacter');
  return win32.normalize(value);
}

function makeAppServerCommand(binary, folder, pathEntries) {
  const safeBinary = validateRemotePath(binary, 'remote KCoder binary');
  const safeFolder = validateRemotePath(folder, 'remote owned folder');
  const safeEntries = pathEntries.map((entry, index) => validateRemotePath(entry, 'remote PATH entry ' + index, true));
  assert.ok(safeEntries.length >= 5, 'Remote PATH must contain the Git and Windows system directories');
  const command = 'set "PATH=' + safeEntries.join(';') + '" && "' + safeBinary + '" --cwd "' + safeFolder + '" app-server';
  assert.ok(command.length <= 7000, 'Native SSH app-server command exceeds the Windows command-line limit');
  return command;
}

function projectProbe(folder, nonce, pid) {
  return [
    '$root=' + psQuote(folder) + ';$nonce=' + psQuote(nonce) + ';$ownerPath=Join-Path $root ".kcoder-4792-owner.json";$owner=Get-Content -Raw -LiteralPath $ownerPath|ConvertFrom-Json;',
    'function Fact($path,$json){$exists=Test-Path -LiteralPath $path -PathType Leaf;$r=[ordered]@{exists=$exists;bytes=0;sha256=$null;validJson=$false;projectType=$null;subProjectType=$null};if(!$exists){return $r};$f=Get-Item -LiteralPath $path;$r.bytes=[int64]$f.Length;if(($f.Attributes -band [IO.FileAttributes]::ReparsePoint)-ne 0){$r.exists=$false;return $r};if($f.Length -le 1048576){$r.sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();if($json){try{$j=Get-Content -Raw -LiteralPath $path|ConvertFrom-Json;$r.validJson=$true;$r.projectType=$j.project_type;$r.subProjectType=$j.sub_project_type}catch{}}};return $r}',
    '$pj=Fact (Join-Path $root "docs\\project.json") $true;$fp=Fact (Join-Path $root "frontend\\package.json") $false;',
    '$pptx=Fact (Join-Path $root "artifacts\\presentation.pptx") $false;$cover=Fact (Join-Path $root "docs\\posters\\app\\app-poster.png") $false;',
    '[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ownerMatches=($owner.nonce -eq $nonce -and [int]$owner.processPid -eq ' + pid + ');projectJson=$pj;frontendPackage=$fp;pptx=$pptx;cover=$cover})))',
  ].join('\n');
}

function exitProbe(folder, binary, pid) {
  return [
    '$root=' + psQuote(folder) + ';$bin=' + psQuote(binary) + ';$pidValue=' + pid + ';$p=Get-CimInstance Win32_Process -Filter ("ProcessId = "+$pidValue);',
    '$alive=[bool]($p -and $p.ExecutablePath -and ([IO.Path]::GetFullPath($p.ExecutablePath)-ieq [IO.Path]::GetFullPath($bin)) -and $p.CommandLine -and $p.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase)-ge 0);',
    '[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{pid=$pidValue;ownedProcessAlive=$alive;pidReused=[bool]($p -and !$alive)})))',
  ].join('\n');
}

function cleanupProbe(folder, nonce, binary, pid) {
  return [
    '$root=' + psQuote(folder) + ';$nonce=' + psQuote(nonce) + ';$bin=' + psQuote(binary) + ';$pidValue=' + pid + ';',
    'if(!(Test-Path -LiteralPath $root)){[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{removed=$true;alreadyAbsent=$true;remainingProcesses=@()})));exit 0}',
    '$owner=Get-Content -Raw -LiteralPath (Join-Path $root ".kcoder-4792-owner.json")|ConvertFrom-Json;if($owner.nonce -ne $nonce -or [int]$owner.processPid -ne $pidValue -or $owner.binary -ine $bin){throw "owner_receipt_mismatch"}',
    '$p=$null;$owned=$false;if($pidValue -gt 0){$p=Get-CimInstance Win32_Process -Filter ("ProcessId = "+$pidValue);$owned=[bool]($p -and $p.ExecutablePath -and ([IO.Path]::GetFullPath($p.ExecutablePath)-ieq [IO.Path]::GetFullPath($bin)) -and $p.CommandLine -and $p.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase)-ge 0);if($p -and !$owned){throw "pid_identity_mismatch"};if($owned){Stop-Process -Id $pidValue -Force;Start-Sleep -Milliseconds 500}}',
    '$left=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase)-ge 0}|ForEach-Object{[ordered]@{pid=[int]$_.ProcessId;name=$_.Name}});',
    'if($left.Count){[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{removed=$false;remainingProcesses=$left})));exit 0};Remove-Item -LiteralPath $root -Recurse -Force;if(Test-Path -LiteralPath $root){throw "fixture_removal_unconfirmed"};[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{removed=$true;remainingProcesses=@()})))',
  ].join('\n');
}

const summarizeActivation = value => ({
  shapeValid: Boolean(value && typeof value === 'object' && Array.isArray(value.components)),
  threadId: value?.threadId ?? null,
  phase: value?.phase ?? null,
  components: (value?.components || []).map(item => ({
    kind: item.kind, name: item.name, phase: item.phase, errorCode: item.errorCode ?? null,
  })),
});

await runE2E(import.meta.url, {
  testId: 'remote-windows-4792-plugin-skill-prehook-' + phase,
  tier: 'manual-live',
  cleanupTimeoutMs: 45_000,
  modelPolicy: phase === 'export'
    ? 'Model-independent single-page export dependency diagnosis; no app-server, hooks, thread, model, desktop input or browser installation'
    : 'One owned remote app-server, one thread, one real-model turn, at most five tool calls; only skill(ppt-implement); 1024 tokens, zero retries, 180s turn budget and 210s hard timeout',
}, async run => {
  await Promise.all([run.runRoot, run.stateDir, run.logsDir, run.artifactsDir].map(path => chmod(path, 0o700)));
  const keySource = process.env.KCODER_4792_SSH_KEY || '/home/hyf/.ssh/id_ed25519';
  const hostsSource = process.env.KCODER_4792_KNOWN_HOSTS || '/home/hyf/.ssh/known_hosts';
  const key = await protectedInput(keySource, 'SSH identity', 1024 * 1024);
  const keyText = key.toString('utf8');
  assert.match(keyText, /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/);
  run.registerSecret(keyText);
  const hosts = await protectedInput(hostsSource, 'SSH known-hosts', 2 * 1024 * 1024, false);
  const digest = (await import('node:crypto')).createHash('sha256').update(hosts).digest('hex');
  let lookup;
  try { lookup = await exec('ssh-keygen', ['-F', HOST_KEY_ALIAS, '-f', hostsSource], { timeout: 5000, maxBuffer: 262144 }); }
  catch { throw new Error('No strict host key is registered for ' + HOST_KEY_ALIAS); }
  const hostsAfter = await protectedInput(hostsSource, 'SSH known-hosts', 2 * 1024 * 1024, false);
  assert.equal((await import('node:crypto')).createHash('sha256').update(hostsAfter).digest('hex'), digest);
  const sshDir = join(run.stateDir, 'ssh');
  await mkdir(sshDir, { mode: 0o700 });
  run.addCleanup('remove run-owned SSH identity and known-hosts copy', () => rm(sshDir, { recursive: true, force: true }));
  const keyPath = join(sshDir, 'identity');
  await (await open(keyPath, 'wx', 0o600)).close();
  await import('node:fs/promises').then(fs => fs.writeFile(keyPath, key, { mode: 0o600 }));
  const hostsPath = join(sshDir, 'known_hosts');
  await import('node:fs/promises').then(fs => fs.writeFile(hostsPath, exactKnownHosts(lookup.stdout), { mode: 0o600 }));
  const sshOptions = [
    '-F', '/dev/null', '-o', 'HostKeyAlias=' + HOST_KEY_ALIAS, '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile=' + hostsPath, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'CheckHostIP=no', '-o', 'UpdateHostKeys=no', '-o', 'CanonicalizeHostname=no',
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
    '-o', 'PermitLocalCommand=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-i', keyPath,
  ];
  const remote = async script => {
    try {
      const result = await exec('ssh', ['-p', '24792', ...sshOptions, REMOTE_USER,
        psCommand(script)],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      return result.stdout.trim();
    } catch (error) { if (!run.finishing) await run.writeArtifactJson('remote-probe-error.json', { code: error.code, stderr: String(error.stderr ?? '').slice(-6000) }); throw new Error('Bounded Windows PowerShell probe failed over strict SSH'); }
  };
  const nonce = randomBytes(8).toString('hex');
  let folder = null;
  let pid = 0;
  let fixtureCreated = false;
  let fixtureRemoved = false;
  let client = null;
  let child = null;
  let bridgeClosed = false;
  const cleanupRemote = async () => {
    if (!fixtureCreated || fixtureRemoved || !folder) return;
    const result = JSON.parse(await remote(cleanupProbe(folder, nonce, binary, pid)));
    if (!result.removed) throw new Error('Owned remote fixture retained because a process still references it');
    fixtureRemoved = true;
  };
  run.addCleanup('remove only nonce-owned remote fixture after process verification', cleanupRemote);
  const preflight = JSON.parse(Buffer.from(await remote(fixtureProbe(nonce, binary)), 'base64').toString('utf8'));
  assert.equal(preflight.nonce, nonce);
  folder = validateRemotePath(preflight.folder, 'owned remote folder');
  assert.equal(win32.basename(folder), 'kcoder-4792-plugin-' + nonce);
  fixtureCreated = true;
  assert.equal(validateRemotePath(preflight.binary, 'remote KCoder binary').toLowerCase(), validateRemotePath(binary, 'configured KCoder binary').toLowerCase());
  const windowsApps = validateRemotePath(preflight.windowsApps, 'WindowsApps alias directory');
  const pathEntries = [...new Set((preflight.pathEntries || []).map((value, index) => validateRemotePath(value, 'remote PATH entry ' + index, true)))];
  assert.ok(pathEntries.length >= 5);
  const requiredPathEntries = (preflight.requiredPathEntries || []).map((value, index) => validateRemotePath(value, 'required PATH entry ' + index, true));
  assert.equal(requiredPathEntries.length, 5);
  for (const required of requiredPathEntries) {
    assert.ok(pathEntries.some(value => win32.normalize(value).toLowerCase() === win32.normalize(required).toLowerCase()),
      'Git and Windows system directories must be present in the owned PATH');
  }
  assert.equal(pathEntries.some(value => win32.normalize(value).toLowerCase() === win32.normalize(windowsApps).toLowerCase()), false,
    'Owned PATH must exclude the WindowsApps Store alias');
  const commandPaths = preflight.commands || {};
  for (const [name, expectedFile] of Object.entries({ node: 'node.exe', npm: 'npm.cmd', yarn: 'yarn.cmd', git: 'git.exe', bash: 'bash.exe' })) {
    const commandPath = validateRemotePath(commandPaths[name], name + ' executable');
    assert.equal(win32.basename(commandPath).toLowerCase(), expectedFile);
    assert.ok(pathEntries.some(value => win32.normalize(value).toLowerCase() === win32.dirname(commandPath).toLowerCase()),
      name + ' executable directory must be present in the owned PATH');
  }
  await run.writeArtifactJson('appserver-path-preflight.json', {
    phase, pathEntryCount: pathEntries.length, windowsAppsExcluded: true,
    commandsValidated: ['node.exe', 'npm.cmd', 'yarn.cmd', 'git.exe', 'bash.exe'],
  });

  if (phase === 'export') {
    const marker = 'KCODER_OWNED_EXPORT_' + nonce;
    const html = '<!doctype html><html><head><style>body{margin:0}.slide-page{width:960px;height:540px;background:white}h1{font:32px Arial;color:black}</style></head><body><div class="slide-page"><h1>' + marker + '</h1></div></body></html>';
    const probe = [
      '$root=' + psQuote(folder) + ';$node=' + psQuote(commandPaths.node) + ';$plugin=' + psQuote(PLUGIN_ROOT) + ';',
      '$owner=Get-Content -Raw -LiteralPath (Join-Path $root ".kcoder-4792-owner.json")|ConvertFrom-Json;if($owner.nonce -ne ' + psQuote(nonce) + ' -or [int]$owner.processPid -ne 0){throw "export_owner_mismatch"}',
      // This narrow probe reproduces the currently missing browser without launching a desktop/browser worker.
      'if($env:PLAYWRIGHT_BROWSERS_PATH){throw "unexpected_browser_cache_override"};$cache=Join-Path $env:LOCALAPPDATA "ms-playwright";if(Test-Path -LiteralPath $cache){if(@(Get-ChildItem -LiteralPath $cache -Recurse -File -Filter "*.exe").Count){throw "browser_now_installed_review_probe_ownership_before_launch"}}',
      '$html=Join-Path $root "single.html";$pptx=Join-Path $root "single.pptx";$out=Join-Path $root "export.stdout";$err=Join-Path $root "export.stderr";$tmp=Join-Path $root "tmp";[void][IO.Directory]::CreateDirectory($tmp);',
      '[IO.File]::WriteAllBytes($html,[Convert]::FromBase64String(' + psQuote(Buffer.from(html).toString('base64')) + '));$env:TEMP=$tmp;$env:TMP=$tmp;$env:TMPDIR=$tmp;$env:PATH=' + psQuote(pathEntries.join(';')) + ';',
      '$sdk=Join-Path $plugin "skills\\ppt-implement\\scripts\\export\\html2pptx.js";$exportArgs=@($sdk,$html,$pptx,"--debug")|ForEach-Object{\'"\'+$_+\'"\'};',
      '$p=Start-Process -FilePath $node -ArgumentList $exportArgs -WorkingDirectory $root -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden;$null=$p.Handle;$childId=[int]$p.Id;$identity=Get-CimInstance Win32_Process -Filter ("ProcessId="+$childId);',
      '$childReceipt=[ordered]@{pid=$childId;binary=$node;folder=$root;created=if($identity){$identity.CreationDate.ToUniversalTime().ToString("o")}else{$null}};[IO.File]::WriteAllText((Join-Path $root "export-child.json"),($childReceipt|ConvertTo-Json));',
      '$timedOut=!$p.WaitForExit(20000);if($timedOut){$live=Get-CimInstance Win32_Process -Filter ("ProcessId="+$childId);if(!$identity -or !$live -or $live.ExecutablePath -ine $node -or $live.CreationDate -ne $identity.CreationDate -or $live.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase)-lt 0){throw "export_timeout_identity_unknown"};if(!$p.HasExited){$p.Kill()};if(!$p.WaitForExit(3000)){throw "owned_export_process_did_not_exit"}};$p.Refresh();',
      '$stdout=if(Test-Path -LiteralPath $out){[IO.File]::ReadAllText($out)}else{""};$stderr=if(Test-Path -LiteralPath $err){[IO.File]::ReadAllText($err)}else{""};$slides=0;$markerFound=$false;$exists=Test-Path -LiteralPath $pptx;',
      'if($exists){Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead($pptx);try{foreach($e in $zip.Entries){if($e.FullName -match "^ppt/slides/slide[0-9]+\\.xml$"){$slides++;$reader=[IO.StreamReader]::new($e.Open());try{if($reader.ReadToEnd().Contains(' + psQuote(marker) + ')){$markerFound=$true}}finally{$reader.Dispose()}}}}finally{$zip.Dispose()}}',
      '$result=[ordered]@{pid=$childId;exitCode=$p.ExitCode;timedOut=$timedOut;headlessDependencyProbe=$true;fullPluginAcceptance=$false;outputExists=$exists;slideXmlCount=$slides;markerFound=$markerFound;stdout=$stdout.Substring(0,[Math]::Min(5000,$stdout.Length));stderr=$stderr.Substring(0,[Math]::Min(5000,$stderr.Length));remainingProcesses=@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase)-ge 0}|ForEach-Object{[int]$_.ProcessId})};$result|ConvertTo-Json -Depth 5 -Compress',
    ].join('\n');
    const result = JSON.parse(await remote(probe));
    await run.writeArtifactJson('single-page-export.json', result);
    assert.equal(result.timedOut, false, 'Export child must settle within its bounded deadline');
    assert.deepEqual(result.remainingProcesses, [], 'No export process may remain for the nonce fixture');
    assert.equal(result.exitCode, 0, 'The real export CLI failed; inspect the retained diagnostic output');
    assert.equal(result.slideXmlCount, 1, 'A file or zero exit code does not prove successful slide export');
    assert.equal(result.markerFound, true, 'The exported slide must contain this run unique input');
    return;
  }

  const appServerCommand = makeAppServerCommand(binary, folder, pathEntries);
  child = run.spawnOwned('target-4792-plugin-appserver', 'ssh', [
    '-p', '24792', ...sshOptions, REMOTE_USER, appServerCommand,
  ], { windowsHide: true, stdin: 'pipe' });
  client = new AppServerStdioClient('remote-windows-4792-plugin', child, { notificationHistoryLimit: 20_000 });
  run.addCleanup('close remote app-server via stdin EOF', async () => {
    if (!child || bridgeClosed) return;
    if (!child.stdin.destroyed) child.stdin.end();
    await waitForStdioChildClose(child, 25_000, 'remote app-server SSH bridge');
    client?.closeReader();
    bridgeClosed = true;
  });
  const processReceipt = JSON.parse(await remote(processReceiptProbe(folder, nonce, binary)));
  assert.equal(processReceipt.updated, true, 'CIM must find exactly one owned KCoder process and atomically update its receipt');
  assert.equal(processReceipt.ambiguous, false);
  pid = processReceipt.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await run.writeArtifactJson('appserver-process.json', {
    phase, pid, nativeSshStdio: true, pathEntryCount: pathEntries.length,
    windowsAppsExcluded: true, commandsValidated: ['node.exe', 'npm.cmd', 'yarn.cmd', 'git.exe', 'bash.exe'],
  });
  const rpc = async (method, params = {}, timeoutMs = 30_000) => {
    const frame = await client.request(method, params, timeoutMs);
    if (frame.error) throw new Error('App-server RPC failed: ' + method + ' ' + String(frame.error.message || 'unknown'));
    return frame.result;
  };

  let stage = 'initialize';
  let threadId;
  let templateId;
  let turnId;
  try {
    await rpc('initialize', {
      protocolVersion: '2026-07-27',
      clientInfo: { name: 'remote-windows-4792-plugin-acceptance', version: '1' },
      capabilities: { experimental: { settingsTemplatesV1: true, pluginActivationV1: true } },
    });
    stage = 'plugin-preflight';
    const list = await rpc('plugin/list', { all: true });
    const plugin = (list.plugins || []).find(item => item.id === PLUGIN_ID);
    assert.ok(plugin, 'Installed ppt-implement plugin must exist');
    assert.equal(plugin.version, '1.0.13');
    assert.equal(plugin.enabled, true);
    assert.equal(typeof plugin.root, 'string');
    assert.equal(win32.normalize(plugin.root).toLowerCase(), win32.normalize(PLUGIN_ROOT).toLowerCase());
    await run.writeArtifactJson('plugin-preflight.json', {
      id: plugin.id, version: plugin.version, enabled: plugin.enabled, root: plugin.root,
      hookMatcherCount: plugin.hookMatcherCount, components: plugin.components,
    });

    stage = 'tool-policy';
    const catalog = await rpc('tools/catalog', {});
    assert.equal(catalog.scope, 'workspace');
    assert.equal(catalog.truncated, false);
    const names = [...new Set((catalog.tools || []).map(item => item.name))].sort();
    assert.ok(names.includes('skill'));
    assert.ok(names.every(name => !/[*?\r\n]/.test(name)));
    const denied = names.filter(name => name !== 'skill');
    const saved = await rpc('settings/templates/save', {
      name: 'Owned Windows plugin ' + phase + ' ' + nonce,
      description: 'Temporary per-thread skill-only diagnostic',
      content: JSON.stringify({ max_tokens: 1024, max_retries: 0, max_duration_secs: 180, request_timeout_secs: 45,
        allowed_tools: ['skill'], denied_tools: denied }),
    });
    templateId = saved?.template?.id;
    assert.ok(templateId);
    let templateDeleted = false;
    run.addCleanup('delete only owned settings template', async () => {
      if (!templateDeleted) { await rpc('settings/templates/delete', { id: templateId }); templateDeleted = true; }
    });
    await run.writeArtifactJson('tool-policy.json', {
      catalogTotal: catalog.total, allowedTools: ['skill'], deniedTools: denied,
      limits: { maxTokens: 1024, maxRetries: 0, maxDurationSecs: 180, requestTimeoutSecs: 45 },
    });

    stage = 'thread-start';
    const started = await rpc('thread/start', { cwd: folder, settingsTemplate: templateId });
    threadId = started?.thread?.id;
    assert.ok(threadId);
    let threadDeleted = false;
    run.addCleanup('delete only owned plugin test thread', async () => {
      if (!threadDeleted) { await rpc('thread/delete', { threadId }); threadDeleted = true; }
    });
    const threadCatalog = await rpc('tools/catalog', { threadId });
    assert.equal(threadCatalog.scope, 'thread');
    assert.equal(threadCatalog.truncated, false);
    const threadNames = [...new Set((threadCatalog.tools || []).map(item => item.name))];
    assert.ok(threadNames.includes('skill'));
    assert.deepEqual(threadNames.filter(name => name !== 'skill' && !denied.includes(name)), [],
      'Every actual thread tool other than skill must have an exact deny entry');
    const before = await rpc('plugin/activation/read', { pluginId: PLUGIN_ID, threadId });
    const beforeSummary = summarizeActivation(before);
    assert.equal(beforeSummary.shapeValid, true, 'Plugin activation snapshot must expose a components array');
    await run.writeArtifactJson('plugin-runtime-before-turn.json', beforeSummary);
    await run.writeArtifactJson('thread-tool-catalog.json', { toolNames: threadNames, allowedTools: ['skill'], deniedTools: denied });

    stage = 'real-skill-turn';
    const prompt = 'In this isolated diagnostic, invoke exactly once the native skill tool with JSON input {"skill":"ppt-implement"} to load the installed skill and run its PreToolUse Hook. Load the skill only; do not follow its project workflow. Do not search, browse, delegate, create or edit files, run shell commands, use any other tool, access another project, or use desktop or screenshot tools. After the skill returns, answer with one short sentence. Do not retry a failed or unknown call.';
    const turnStart = await rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
    turnId = turnStart?.turn?.id;
    assert.ok(turnId);
    let badCall = false;
    const monitor = setInterval(() => {
      const calls = client.notificationHistory.filter(frame => frame.method === 'item/started'
        && frame.params?.threadId === threadId && frame.params?.turnId === turnId && frame.params?.item?.type === 'toolCall');
      if (calls.some(frame => frame.params.item.name !== 'skill' || frame.params.item.input?.skill !== 'ppt-implement')
        || calls.length > 5) {
        badCall = true;
        void rpc('turn/interrupt', { threadId, turnId }, 8_000).catch(() => {});
      }
    }, 20);
    monitor.unref();
    let completed;
    try {
      completed = await client.waitForNotification(frame => frame.method === 'turn/completed'
        && frame.params?.threadId === threadId && frame.params?.turnId === turnId, 210_000, 'bounded plugin turn');
    } catch (error) {
      void rpc('turn/interrupt', { threadId, turnId }, 8_000).catch(() => {});
      await client.waitForNotification(frame => frame.method === 'turn/completed'
        && frame.params?.threadId === threadId && frame.params?.turnId === turnId, 20_000, 'original interrupted turn receipt').catch(() => null);
      throw error;
    } finally { clearInterval(monitor); }
    const events = client.notificationHistory.filter(frame => frame.params?.threadId === threadId && frame.params?.turnId === turnId);
    const startedCalls = events.filter(frame => frame.method === 'item/started' && frame.params?.item?.type === 'toolCall').map(frame => frame.params.item);
    const completedCalls = new Map(events.filter(frame => frame.method === 'item/completed' && frame.params?.item?.type === 'toolCall')
      .map(frame => [frame.params.item.id, frame.params.item]));
    const receipt = startedCalls.length === 1 ? completedCalls.get(startedCalls[0].id) : null;
    await run.writeArtifactJson('turn-tool-evidence.json', {
      phase, turnId, terminalStatus: completed.params?.turn?.status ?? completed.params?.status ?? null,
      tools: events.filter(frame => ['item/started', 'item/completed'].includes(frame.method)
        && frame.params?.item?.type === 'toolCall').map(frame => ({
        method: frame.method, id: frame.params.item.id, name: frame.params.item.name,
        input: frame.params.item.input ?? null, status: frame.params.item.status ?? null,
        outputPrefix: typeof frame.params.item.output === 'string' ? frame.params.item.output.slice(0, 12000) : null,
      })),
    });
    stage = 'pretool-files-and-runtime';
    const files = JSON.parse(await remote(projectProbe(folder, nonce, pid)));
    await run.writeArtifactJson('remote-plugin-files.json', files);
    const after = summarizeActivation(await rpc('plugin/activation/read', { pluginId: PLUGIN_ID, threadId }));
    assert.equal(after.shapeValid, true, 'Plugin activation snapshot must expose a components array');
    await run.writeArtifactJson('plugin-runtime-after-turn.json', after);
    const hooks = Object.fromEntries(after.components.filter(item => item.kind === 'hook').map(item => [item.name, item]));
    await run.writeArtifactJson('plugin-hook-phases.json', {
      sessionStart: hooks.SessionStart ?? null, preToolUse: hooks.PreToolUse ?? null, stop: hooks.Stop ?? null,
      exportAcceptance: false, pptx: files.pptx, cover: files.cover,
    });

    stage = 'skill-and-prehook-assertions';
    assert.equal(badCall, false, 'Only the exact skill tool may start');
    assert.equal(startedCalls.length, 1);
    assert.equal(startedCalls[0].name, 'skill');
    const skillInput = startedCalls[0].input || {};
    assert.deepEqual(Object.keys(skillInput).filter(key => key !== 'args').sort(), ['skill']);
    assert.equal(Object.keys(skillInput).some(key => !['skill', 'args'].includes(key)), false);
    assert.equal(skillInput.skill, 'ppt-implement');
    assert.ok(skillInput.args === undefined || skillInput.args === null || skillInput.args === '', 'Skill arguments must remain empty');
    assert.equal(receipt?.status, 'completed');
    assert.match(receipt?.output || '', /(?:Activated skill:|Skill already active:)\s*ppt-implement\b/i);

    assert.equal(files.ownerMatches, true);
    assert.equal(files.projectJson.exists, true, 'PreToolUse must create docs/project.json');
    assert.equal(files.projectJson.validJson, true);
    assert.equal(files.projectJson.projectType, 'ppt');
    assert.equal(files.projectJson.subProjectType, 'ppt');
    assert.equal(files.frontendPackage.exists, true);
    assert.equal(hooks.PreToolUse?.phase, 'usable');

    stage = 'cleanup';
    await rpc('thread/delete', { threadId });
    threadDeleted = true;
    await rpc('settings/templates/delete', { id: templateId });
    templateDeleted = true;
    if (!child.stdin.destroyed) child.stdin.end();
    const exit = await waitForStdioChildClose(child, 25_000, 'remote app-server SSH bridge');
    client.closeReader();
    bridgeClosed = true;
    const pidReceipt = JSON.parse(await remote(exitProbe(folder, binary, pid)));
    await run.writeArtifactJson('appserver-exit.json', { sshExitCode: exit.code, sshSignal: exit.signal, pid, ...pidReceipt });
    assert.equal(pidReceipt.ownedProcessAlive, false, 'Exact app-server PID must exit after stdin EOF');
    const cleanup = JSON.parse(await remote(cleanupProbe(folder, nonce, binary, pid)));
    await run.writeArtifactJson('remote-fixture-cleanup.json', cleanup);
    assert.equal(cleanup.removed, true, 'Only a process-free nonce-owned fixture may be removed');
    fixtureRemoved = true;
    return {
      phase, exactSkillCallCompleted: true, preToolUseHookUsable: true, pptTemplateCreated: true,
      stopHookPhase: hooks.Stop?.phase ?? 'unobserved',
      pptxExists: files.pptx.exists, coverExists: files.cover.exists, fullExportAcceptance: false,
      remoteFixtureRemoved: true,
    };
  } catch (error) {
    await run.writeArtifactJson('failure-evidence.json', {
      phase, stage, threadId: threadId ?? null, turnId: turnId ?? null,
      error: error instanceof Error ? error.message : String(error),
      notifications: client?.notificationHistory.filter(frame => frame.params?.threadId === threadId && frame.params?.turnId === turnId
        && ['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(frame.method)).map(frame => ({
        method: frame.method, item: frame.params?.item ? {
          id: frame.params.item.id, name: frame.params.item.name, input: frame.params.item.input ?? null,
          status: frame.params.item.status ?? null,
        } : null, status: frame.params?.turn?.status ?? frame.params?.status ?? null,
      })) ?? [],
    }).catch(() => {});
    throw error;
  }
});
