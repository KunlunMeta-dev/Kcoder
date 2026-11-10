import {requireNativeSearchGates} from './windows-native-web-search.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot } from './run-context.mjs';
import { windowsSshInvocation } from './windows-ssh-auth.mjs';

export function validatePackageProbe(options) {
  if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(options.target ?? '')) throw Error('Explicit Windows SSH target required');
  if (!/^[a-f0-9]{40}$/.test(options.commit ?? '') || !/^[a-f0-9]{64}$/.test(options.cliSha256 ?? '')) throw Error('Frozen package identity required');
  if (options.focus === 'native-web-search') requireNativeSearchGates(options.nativeConsent,options.externalConsent);
  if (options.nativeCommit !== undefined && !/^[a-f0-9]{40}$/.test(options.nativeCommit)) throw Error('Explicit Native source commit must be canonical');
  if (options.installedDirectory === undefined && !/^[a-f0-9]{64}$/.test(options.archiveSha256 ?? '')) throw Error('Actual installer payload digest required');
  if (options.installedDirectory !== undefined && (options.archive !== undefined || options.archiveSha256 !== undefined)) throw Error('Select an installed directory or an installer payload');
  if (options.taskContinuation !== undefined && (options.focus !== 'migration' || options.taskContinuation.authorized !== true || !/^http:\/\/127\.0\.0\.1:\d+\/[^\s]*$/.test(options.taskContinuation.endpoint || ''))) throw Error('Explicit owned live continuation endpoint required');
  if (options.focus !== undefined && !['all', 'studio', 'migration', 'task-board', 'workflow-draft', 'native-web-search'].includes(options.focus)) throw Error('Unsupported native probe focus');
  if (options.workflowViewSourceRef !== undefined && (options.focus !== 'workflow-draft' || !/^[a-f0-9]{40}$/.test(options.workflowViewSourceRef))) throw Error('Explicit workflow view source commit required');
  if (options.catalogLockTests !== undefined || options.catalogLockTestsSha256 !== undefined || options.catalogLockTestMode !== undefined) {
    if (options.focus !== 'migration' || typeof options.catalogLockTests !== 'string' || !/^[a-f0-9]{64}$/.test(options.catalogLockTestsSha256 ?? ''))
      throw Error('Native catalog regression requires an explicit migration test binary and digest');
    if (options.catalogLockTestMode !== undefined && options.catalogLockTestMode !== 'vfs') throw Error('Unsupported native catalog test mode');
  }
  for (const path of [options.node, options.parent, ...(options.installedDirectory === undefined ? [] : [options.installedDirectory])]) {
    if (typeof path !== 'string' || !/^[A-Za-z]:\\/.test(path) || /[\0\r\n"'<>|?*]/.test(path)) throw Error('Explicit local Windows paths required');
  }
}

export function psLiteral(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw Error('Invalid PowerShell text');
  return "'" + value.replaceAll("'", "''") + "'";
}

export function ownedCreationScript(parent, owner) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner)) throw Error('Invalid native package owner');
  return `$parent=${psLiteral(parent)};if(!(Test-Path -LiteralPath $parent -PathType Container)){throw 'Explicit parent missing'};$p=Join-Path $parent 'kcoder-package-${owner}';if(Test-Path -LiteralPath $p){throw 'Owned path collision'};$created=$false;try{New-Item -ItemType Directory -Path $p -ErrorAction Stop|Out-Null;$created=$true;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;& icacls $p /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' ('*'+$sid+':(OI)(CI)F')|Out-Null;if($LASTEXITCODE -ne 0){throw 'Could not isolate native package directory'};[IO.File]::WriteAllText((Join-Path $p '.owner.json'),'${JSON.stringify({ owner })}');ConvertTo-Json -InputObject $p -Compress}catch{if($created){[IO.Directory]::Delete($p,$true)};throw}`;
}

export function ownedStopScript(directory, owner, executableLeaf = 'probe.mjs') {
  if (!/^[A-Za-z0-9_.-]+$/.test(executableLeaf)) throw Error('Invalid owned executable leaf');
  const root = psLiteral(directory), identity = psLiteral(owner);
  return `$root=${root};$m=Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json;if($m.owner -ne ${identity}){throw 'Ownership mismatch'};
$pidFile=Join-Path $root 'probe-owner.json';if(Test-Path -LiteralPath $pidFile){$o=Get-Content -LiteralPath $pidFile -Raw|ConvertFrom-Json;if($o.owner -ne ${identity}){throw 'Probe owner mismatch'};$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$o.pid) -ErrorAction SilentlyContinue;if($p){$expected=Join-Path $root '${executableLeaf}';$ticks=if($o.creationKind -eq 'process-start-time'){(Get-Process -Id $o.pid -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()}else{$p.CreationDate.ToUniversalTime().Ticks.ToString()};if(!$p.CommandLine.Contains($expected) -or $ticks -ne $o.creationTicks){throw 'Process identity changed'};& taskkill /PID $p.ProcessId /F|Out-Null;if($LASTEXITCODE -ne 0){throw 'Owned probe termination failed'}}};
$deadline=[DateTime]::UtcNow.AddSeconds(15);do{$live=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith(($root+'\\'),[StringComparison]::OrdinalIgnoreCase)});if($live.Count -eq 0){break};Start-Sleep -Milliseconds 100}while([DateTime]::UtcNow -lt $deadline);if($live.Count){throw 'Owned package processes still running'};
`;
}

export function ownedCleanupScript(directory, owner, executableLeaf = 'probe.mjs') {
  return ownedStopScript(directory, owner, executableLeaf) + `[IO.Directory]::Delete($root,$true);if(Test-Path -LiteralPath $root){throw 'Owned directory survived'};@{cleaned=$true;directoryAbsent=$true;ownedPackageProcessesAbsent=$true}|ConvertTo-Json -Compress`;
}

export async function rendererTerminalEmulator() {
  const root = resolve(repoRoot, 'apps/kcoder-studio/renderer/node_modules/@xterm/xterm');
  const script = resolve(root, 'lib/xterm.js'), packageJson = resolve(root, 'package.json');
  const [code, metadata] = await Promise.all([readFile(script), readFile(packageJson, 'utf8')]);
  const parsed = JSON.parse(metadata);
  assert.equal(parsed.name, '@xterm/xterm');
  assert.match(parsed.version, /^\d+\.\d+\.\d+/);
  return { script, packageJson, name: parsed.name, version: parsed.version,
    sha256: createHash('sha256').update(code).digest('hex') };
}

export async function runWindowsPackageProbe(context, options) {
  validatePackageProbe(options);
  if (options.installedDirectory === undefined) {
    const info = await lstat(options.archive);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(options.archive)) hash.update(chunk);
    assert.equal(hash.digest('hex'), options.archiveSha256, 'must use the payload extracted from the frozen installer');
  }
  let sequence = 0;
  const execute = (command, args, { input, timeoutMs = 120000 } = {}) => new Promise((accept, reject) => {
    const spec = windowsSshInvocation(context, command, args, options.target);
    const label = `windows-package-${++sequence}`;
    const child = context.spawnOwned(label, spec.command, spec.args, { ...spec.options, stdin: input === undefined ? 'ignore' : 'pipe' });
    let output = '', error = '', bytes = 0;
    const stop = reason => { void context.stopOwned(label); reject(reason); };
    const timer = setTimeout(() => stop(Error('Owned Windows package command timed out')), timeoutMs);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 2 * 1024 * 1024) stop(Error('Owned Windows output exceeded limit')); else output += data; });
    child.stderr.on('data', data => { error = (error + data).slice(-8192); });
    child.once('error', failure => { clearTimeout(timer); reject(failure); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? accept(output) : reject(Error(`Owned Windows command failed (${code}): ${context.redactText(error || output).slice(-2500)}`)); });
    if (input !== undefined) child.stdin.write(input);
  });
  const psArgs = script => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', options.target,
    'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')];
  const ps = (script, opts) => execute('ssh', psArgs(script), opts);
  const owner = randomUUID(), name = `kcoder-package-${owner}`;
  const directory = JSON.parse((await ps(ownedCreationScript(options.parent, owner))).trim());
  assert.equal(directory, options.parent.replace(/\\$/, '') + '\\' + name);
  const cleanupEvidence = context.pathInArtifacts('windows-package-cleanup.json');
  context.addCleanup('remove owned native Windows package and processes', async () => {
    const spec = windowsSshInvocation(context, 'ssh', psArgs(ownedCleanupScript(directory, owner)), options.target);
    const result = await promisify(execFile)(spec.command, spec.args, { ...spec.options, timeout: 30000, maxBuffer: 65536 });
    const receipt = JSON.parse(result.stdout.trim());
    await writeFile(cleanupEvidence, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    assert.equal(receipt.cleaned, true);
  });
  const destination = directory.replaceAll('\\', '/');
  const upload = (file, leaf) => execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', file, `${options.target}:${destination}/${leaf}`], { timeoutMs: 240000 });
  await context.writeArtifactJson('windows-package-input.json', { directory, archiveSha256: options.archiveSha256, installedDirectory: options.installedDirectory, expectedCommit: options.commit, expectedNativeCommit: options.nativeCommit ?? options.commit, expectedCliSha256: options.cliSha256,
    scope: options.installedDirectory === undefined ? 'extracted actual NSIS payload; no personal installation or GUI acceptance' : 'read-only installed binaries; isolated owned profile and workspace; no personal configuration, history or GUI acceptance' });
  if (options.installedDirectory === undefined) {
    await upload(options.archive, 'app.7z');
    await ps(`$p=${psLiteral(directory)};if((Get-FileHash -LiteralPath (Join-Path $p 'app.7z') -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${options.archiveSha256}'){throw 'Transferred archive mismatch'};[IO.Directory]::CreateDirectory((Join-Path $p 'app'))|Out-Null;& tar -xf (Join-Path $p 'app.7z') -C (Join-Path $p 'app');if($LASTEXITCODE -ne 0){throw 'Native payload extraction failed'}`, { timeoutMs: 180000 });
  }
  await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-package-searxng-probe.mjs'), 'probe.mjs');
  await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/owned-process.mjs'), 'owned-process.mjs');
  if (options.focus === 'migration') {
    const emulator = await rendererTerminalEmulator();
    await context.writeArtifactJson('terminal-emulator-source.json', {
      name: emulator.name, version: emulator.version, sha256: emulator.sha256,
      source: 'same installed official package used by Studio renderer; no DOM/pixel rendering claim',
    });
    await upload(emulator.script, 'xterm.cjs');
    await upload(emulator.packageJson, 'xterm-package.json');
    await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-migration-probe.mjs'), 'windows-migration-probe.mjs');
    if(options.taskContinuation)await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-migration-task-continuation.mjs'), 'windows-migration-task-continuation.mjs');
    await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/app-server-stdio.mjs'), 'app-server-stdio.mjs');
    if (options.catalogLockTests) {
      const stat = await lstat(options.catalogLockTests);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 * 1024);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(options.catalogLockTests)) hash.update(chunk);
      assert.equal(hash.digest('hex'), options.catalogLockTestsSha256);
      await upload(options.catalogLockTests, 'catalog-lock-tests.exe');
    }
  }
  if (options.focus === 'task-board') {
    await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-task-board-status-probe.mjs'), 'windows-task-board-status-probe.mjs');
    await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/app-server-stdio.mjs'), 'app-server-stdio.mjs');
  }
  if (options.focus === 'workflow-draft') {
    for (const leaf of ['windows-workflow-draft-probe.mjs', 'windows-task-view-handoff.mjs', 'app-server-stdio.mjs'])
      await upload(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness', leaf), leaf);
    const sourcePath = 'apps/kcoder-studio/renderer/src/kcoder/gateway/runtime/sessionLifetime.ts';
    const entry = resolve(repoRoot, sourcePath);
    const source = options.workflowViewSourceRef
      ? await execute('git', ['show', `${options.workflowViewSourceRef}:${sourcePath}`])
      : await readFile(entry, 'utf8');
    const rendererRequire = createRequire(resolve(repoRoot, 'apps/kcoder-studio/renderer/package.json'));
    const viteRequire = createRequire(rendererRequire.resolve('vite'));
    const { rolldown } = await import(pathToFileURL(viteRequire.resolve('rolldown')).href);
    const bundle = await rolldown({ input: entry, treeshake: { moduleSideEffects: false }, plugins: [{
      name: 'actual-task-view-protocol-module',
      load: id => id === entry ? source : undefined,
      resolveId: (id, importer) => {
        if (id === '@/lib/random-id') return resolve(repoRoot, 'apps/kcoder-studio/renderer/src/lib/random-id.ts');
        // This contract module's unrelated error helpers are unused by taskView.
        // Leave their dependency external so they must be removed by tree shaking.
        if (importer === resolve(dirname(entry), 'contracts.ts') && id === '../../gatewayRpc')
          return { id, external: true, moduleSideEffects: false };
      },
    }] });
    let output;
    try { output = (await bundle.generate({ format: 'esm' })).output; } finally { await bundle.close(); }
    assert.equal(output.length, 1);
    assert.doesNotMatch(output[0].code, /^(?:import\s|export\s.+\sfrom\s)/m,
      'Task view fixture must contain its actual runtime dependencies');
    const compiled = context.pathInState('task-view-runtime.mjs');
    await writeFile(compiled, output[0].code, { mode: 0o600 });
    await context.writeArtifactJson('task-view-source.json', { sourcePath, sourceRef: options.workflowViewSourceRef ?? 'working-tree',
      sourceSha256: createHash('sha256').update(source).digest('hex'), bundleSha256: createHash('sha256').update(output[0].code).digest('hex') });
    await upload(compiled, 'task-view-runtime.mjs');
  }
  if(options.focus==='native-web-search') for(const leaf of ['windows-native-web-search.mjs','windows-native-web-model.mjs','windows-managed-pac-fixture.mjs','app-server-stdio.mjs']) await upload(resolve(repoRoot,'apps/kcoder-studio/e2e/harness',leaf),leaf);
  await upload(resolve(repoRoot, 'scripts/searxng/test_runtime.py'), 'test-searxng.py');
  const config = await context.writeStateJson('windows-package-config.json', { directory, owner, installedDirectory: options.installedDirectory, commit: options.commit, nativeCommit: options.nativeCommit ?? options.commit, cliSha256: options.cliSha256, focus: options.focus ?? 'all', taskContinuation: options.taskContinuation, liveQuery: options.liveQuery, nativeConsent:options.nativeConsent, externalConsent:options.externalConsent, catalogLockTestsSha256: options.catalogLockTestsSha256, catalogLockTestMode: options.catalogLockTestMode });
  await upload(config, 'config.json');
  let result;
  try {
    const raw = await ps(`& ${psLiteral(options.node)} ${psLiteral(directory + '\\probe.mjs')} ${psLiteral(directory + '\\config.json')};exit $LASTEXITCODE`, { input: JSON.stringify({ owner }) + '\n', timeoutMs: 240000 });
    result = JSON.parse(raw.trim());
    await context.writeArtifactJson('windows-package-result.json', result);
  } finally {
    for (const leaf of ['probe-result.json', 'app-server-search.json', 'terminal-case/terminal-diagnostic.json']) {
      if ((await ps(`Test-Path -LiteralPath ${psLiteral(directory + '\\' + leaf)}`)).trim() === 'True')
        await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', `${options.target}:${destination}/${leaf}`, context.pathInArtifacts(leaf.replaceAll('/', '-'))]);
    }
  }
  assert.equal(result.passed, true);
  return result;
}
