import {transferWindowsArtifact} from './windows-artifact-transfer.mjs';
import { WINDOWS_READ_PATH_MODES, windowsReadConsumerSelections } from './windows-read-consumers.mjs';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot } from './run-context.mjs';
import { runKeyringWindowsCommand } from './windows-keyring-logon.mjs';
import { privateCredentialRuntimeFiles, privateDiagnostic, windowsPrivateCredentialReview } from './windows-private-credential-review.mjs';
import { windowsSshInvocation } from './windows-ssh-auth.mjs';
import { ownedCreationScript, ownedCleanupScript, psLiteral, rendererTerminalEmulator } from './windows-package-probe.mjs';
import { WINDOWS_PAC_TEST_FILTER, WINDOWS_PAC_TESTS } from './windows-pac-fixture.mjs';

export async function cleanupWindowsNativeFixture(context, options, root, owner, cleanupPath) {
  const script = `if(!(Test-Path -LiteralPath ${psLiteral(root)})){@{cleaned=$true;directoryAbsent=$true;ownedPackageProcessesAbsent=$true;alreadyAbsent=$true}|ConvertTo-Json -Compress}else{${ownedCleanupScript(root, owner)}}`;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', options.target, 'powershell', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64')];
  const raw = await runKeyringWindowsCommand(context, options.target, `windows-native-cleanup-${owner}`, 'ssh', args,
    { cleanup: true, timeoutMs: 60000 });
  const result = JSON.parse(raw.trim());
  await writeFile(cleanupPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  assert.equal(result.cleaned, true); assert.equal(result.directoryAbsent, true); assert.equal(result.ownedPackageProcessesAbsent, true);
}

export function validateNativeLibtestOptions(options) {
  assert.equal(options.consent, '1');
  if(options.compressTransfer!==undefined)assert.equal(options.compressTransfer,true);
  if(options.legacyScp!==undefined)assert.equal(options.legacyScp,true);
  if(options.chunkedTransfer!==undefined)assert.equal(options.chunkedTransfer,true);
  assert.match(options.target ?? '', /^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/);
  assert.match(options.parent ?? '', /^[D-Zd-z]:\\[^\0\r\n"'<>|?*]*$/);
  assert.match(options.node ?? '', /^[A-Za-z]:\\[^\0\r\n"'<>|?*]+\.exe$/);
  for (const field of ['supervisorSha256', 'sourceTreeSha256']) assert.match(options[field] ?? '', /^[a-f0-9]{64}$/);
  assert.ok(typeof options.supervisor === 'string' && options.supervisor);
  if (options.probeKind !== 'web-diagnostic' || options.testBinary !== undefined || options.testSha256 !== undefined) {
    assert.match(options.testSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.ok(typeof options.testBinary === 'string' && options.testBinary);
  }
  if(options.testBinaryArchive!==undefined){assert.ok(options.testBinary&&options.testBinaryArchive.endsWith('.gz'));assert.match(options.testBinaryArchiveSha256??'',/^[a-f0-9]{64}$/);assert.ok([undefined,'libtest'].includes(options.probeKind));}
  assert.ok([undefined, 'libtest', 'terminal', 'local-attachment', 'cross-host-source', 'private-credentials', 'web-runtime', 'web-verify-only', 'web-diagnostic'].includes(options.probeKind));
  if (options.probeKind === 'web-verify-only') {
    assert.deepEqual(options.expectedTests, ['native_sealed_runtime_verify_only']);
    assert.equal(options.exactTest, undefined);assert.equal(options.testFilter, undefined);
    assert.equal(options.externalWebRead, undefined);assert.equal(options.externalWebCase, undefined);
  }
  if (options.diagnosticHostname !== undefined) {assert.equal(options.diagnosticHostname,true);assert.equal(options.probeKind,'web-diagnostic');assert.equal(options.externalWebCase,'python-asyncio');assert.equal(options.diagnosticDirect,undefined);}
  if (options.diagnosticDirect !== undefined) {assert.equal(options.diagnosticDirect,true);assert.equal(options.probeKind,'web-diagnostic');}
  if (options.externalWebCase !== undefined) {
    assert.ok(['example','python-asyncio'].includes(options.externalWebCase));
    assert.ok(options.externalWebRead===true||options.probeKind==='web-diagnostic');
  }
  if (options.externalWebRead !== undefined) {
    assert.equal(options.externalWebRead, true);
    assert.equal(options.runIgnored, true);
    assert.equal(options.exactTest, 'web_network::system_proxy::native_observation::native_inherited_proxy_reads_one_fixed_public_source_with_verified_tls');
    assert.ok([undefined, 'libtest'].includes(options.probeKind));
  }
  if (['web-runtime','web-verify-only'].includes(options.probeKind)) {
    assert.ok(typeof options.runtimeArchive === 'string' && options.runtimeArchive.endsWith('.tar.gz'));
    assert.match(options.runtimeArchiveSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(options.runIgnored, undefined);
  }
  if (options.runIgnored !== undefined) {
    assert.equal(options.runIgnored, true);
    assert.ok([undefined, 'libtest'].includes(options.probeKind));
    assert.ok(options.exactTest || options.pacFixture === true, 'Ignored native execution must select one exact test or the fixed PAC roster');
  }
  if (options.chromiumArchive !== undefined) {
    assert.ok([undefined, 'libtest'].includes(options.probeKind));
    assert.equal(options.runIgnored, true);
    assert.ok(options.chromiumArchive.endsWith('.zip'));
    assert.match(options.chromiumArchiveSha256 ?? '', /^[a-f0-9]{64}$/);
  }
  if (options.gitLineEndings !== undefined) {
    assert.equal(options.gitLineEndings, 'preserve');
    assert.ok([undefined, 'libtest'].includes(options.probeKind));
  }
  if (options.pacFixture !== undefined) {
    assert.equal(options.pacFixture, true);
    assert.ok([undefined, 'libtest'].includes(options.probeKind));
    assert.equal(options.runIgnored, true);
    assert.equal(options.exactTest, undefined);
    assert.equal(options.testFilter, WINDOWS_PAC_TEST_FILTER);
    assert.deepEqual([...options.expectedTests].sort(), [...WINDOWS_PAC_TESTS].sort());
  }
  if (options.pathFixture !== undefined) {
    assert.ok([undefined, 'libtest'].includes(options.probeKind));
    assert.deepEqual(Object.keys(options.pathFixture).sort(), ['mode', 'scope']);
    assert.ok(WINDOWS_READ_PATH_MODES.includes(options.pathFixture.mode));
    const selected = windowsReadConsumerSelections(options.pathFixture.scope);
    assert.ok(selected.some(row => row.exactTest === options.exactTest));
    assert.equal(options.testFilter, undefined); assert.equal(options.rustMinStack, undefined);
  }
  if (['terminal', 'local-attachment', 'cross-host-source', 'private-credentials'].includes(options.probeKind)) {
    assert.match(options.expectedCommit ?? '', /^[a-f0-9]{40}$/);
    assert.equal(typeof options.expectedDirty, 'boolean');
    if (options.rustMinStack !== undefined) assert.ok(Number.isSafeInteger(options.rustMinStack) && options.rustMinStack >= 2 * 1024 * 1024 && options.rustMinStack <= 64 * 1024 * 1024);
    if (options.probeKind === 'private-credentials') {
      assert.equal(options.rustMinStack, undefined); assert.equal(options.expectedDirty, false);
      for (const name of ['reviewedSourceSha256', 'nodeSha256']) assert.match(options[name] ?? '', /^[a-f0-9]{64}$/);
    }
    if (options.probeKind === 'local-attachment') {
      assert.equal(options.rustMinStack, undefined);
      assert.equal(options.expectedDirty, false);
    }
    if (options.probeKind === 'cross-host-source') {
      assert.equal(options.rustMinStack, undefined);
      for (const name of ['gatewayBundle', 'sshWrapper', 'clientKey', 'knownHosts']) assert.ok(typeof options[name] === 'string' && options[name]);
      for (const name of ['gatewayBundleSha256', 'sshWrapperSha256']) assert.match(options[name] ?? '', /^[a-f0-9]{64}$/);
      assert.ok(options.crossHost && options.crossHost.host && options.crossHost.command && options.crossHost.workspace);
      assert.equal(options.crossHost.contentVersion, 'cross-host-contents/v1');
    }
    assert.equal(options.expectedTests, undefined);
    assert.equal(options.exactTest, undefined);
    assert.equal(options.testFilter, undefined);
  } else {
    assert.ok(Array.isArray(options.expectedTests) && options.expectedTests.length > 0 && options.expectedTests.length <= 100);
    assert.equal(new Set(options.expectedTests).size, options.expectedTests.length);
    for (const name of options.expectedTests) assert.match(name, /^[A-Za-z0-9_:]+$/);
    if (options.exactTest !== undefined) {
      assert.equal(options.testFilter, undefined);
      assert.match(options.exactTest, /^[A-Za-z0-9_:]+$/);
      assert.deepEqual(options.expectedTests, [options.exactTest]);
    }
    if (options.testFilter !== undefined) {
      assert.equal(options.exactTest, undefined);
      if (options.pacFixture === true) assert.equal(options.testFilter, WINDOWS_PAC_TEST_FILTER);
      else assert.match(options.testFilter, /^[A-Za-z0-9_]+(?:::[A-Za-z0-9_]+)*::$/);
      assert.ok(options.testFilter.length <= 256);
      assert.ok(options.expectedTests.every(name => name.startsWith(options.testFilter) && name.length > options.testFilter.length));
    }
  }
}

export function nativeLibtestInputSizeLimit(options, leaf) {
  // Default-dev read-consumer PE files carry debug symbols; other inputs retain the original bound.
  return (options.pathFixture !== undefined && [undefined, 'libtest'].includes(options.probeKind) && leaf === 'tests.exe'
    ? 512 : 256) * 1024 * 1024;
}

export async function runWindowsNativeLibtest(context, options) {
  validateNativeLibtestOptions(options);
  const files = [...(options.testBinaryArchive ? [[options.testBinaryArchive,'tests.exe.gz',options.testBinaryArchiveSha256]] : options.testBinary ? [[options.testBinary, 'tests.exe', options.testSha256]] : []), [options.supervisor, 'supervisor.exe', options.supervisorSha256],
    [resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-native-libtest-probe.mjs'), 'probe.mjs'],
    [resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/owned-process.mjs'), 'owned-process.mjs']];
  if (options.probeKind === 'web-diagnostic') files.push([resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-web-proxy-diagnostic.ps1'), 'web-diagnostic.ps1']);
  if (options.probeKind === 'web-verify-only') files.push([options.runtimeArchive,'runtime.tar.gz',options.runtimeArchiveSha256]);
  if (options.probeKind === 'web-runtime') files.push(
    [options.runtimeArchive, 'runtime.tar.gz', options.runtimeArchiveSha256],
    [resolve(repoRoot, 'scripts/searxng/test_runtime.py'), 'test-runtime.py']);
  if (options.chromiumArchive !== undefined) files.push([options.chromiumArchive, 'chromium.zip', options.chromiumArchiveSha256]);
  if (options.pathFixture !== undefined) files.push([resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-read-consumers.mjs'), 'windows-read-consumers.mjs']);
  if (options.pacFixture === true) files.push([resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-pac-fixture.mjs'), 'windows-pac-fixture.mjs']);
  if (['terminal', 'local-attachment'].includes(options.probeKind)) {
    for (const leaf of ['windows-migration-probe.mjs', 'app-server-stdio.mjs'])
      files.push([resolve(repoRoot, 'apps/kcoder-studio/e2e/harness', leaf), leaf]);
    if (options.probeKind === 'terminal') {
      const emulator = await rendererTerminalEmulator();
      files.push([emulator.script, 'xterm.cjs'], [emulator.packageJson, 'xterm-package.json']);
      await context.writeArtifactJson('terminal-emulator-source.json', { name: emulator.name, version: emulator.version, sha256: emulator.sha256 });
    } else files.push([resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-local-attachment-case.mjs'), 'windows-local-attachment-case.mjs']);
  }
  if (options.probeKind === 'cross-host-source') {
    files.push([resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-cross-host-source-case.mjs'), 'windows-cross-host-source-case.mjs'],
      [resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-cross-host-adoption.mjs'), 'windows-cross-host-adoption.mjs'],
      [resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/rpc.mjs'), 'rpc.mjs'],
      [resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/header-websocket.mjs'), 'header-websocket.mjs'],
      [resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-cross-host-child-events.mjs'), 'windows-cross-host-child-events.mjs'],
      [resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-cross-host-rpc-observation.mjs'), 'windows-cross-host-rpc-observation.mjs'],
      [resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/migration-no-inference.mjs'), 'migration-no-inference.mjs'],
      [options.gatewayBundle, 'gateway.tar', options.gatewayBundleSha256],
      [options.sshWrapper, 'ssh.exe', options.sshWrapperSha256], [options.clientKey, 'client-key'], [options.knownHosts, 'known_hosts']);
    for (const leaf of ['contract', 'fixture', 'assets', 'packages', 'private']) {
      const name = `windows-cross-host-content-${leaf}.mjs`;
      files.push([resolve(repoRoot, 'apps/kcoder-studio/e2e/harness', name), name]);
    }
  }
  if (options.probeKind === 'private-credentials') {
    const review = await windowsPrivateCredentialReview(repoRoot);
    assert.equal(options.reviewedSourceSha256, review.sha256, 'The exact Windows private RPC runtime must be reviewed');
    await context.writeArtifactJson('windows-private-runtime-review.json', review);
    for (const leaf of privateCredentialRuntimeFiles) files.push([resolve(repoRoot, 'apps/kcoder-studio/e2e/harness', leaf), leaf]);
  }
  const identities = [];
  for (const [file, leaf, expected] of files) {
    const stat = await lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size < nativeLibtestInputSizeLimit(options, leaf));
    const sha256 = createHash('sha256').update(await readFile(file)).digest('hex');
    if (expected) assert.equal(sha256, expected);
    identities.push({ path: file, leaf, sha256, bytes: stat.size });
  }
  if (options.probeKind === 'local-attachment') {
    const sources = identities.filter(value => value.leaf.endsWith('.mjs'))
      .map(value => ({ name: value.leaf, sha256: value.sha256 }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    assert.equal(createHash('sha256').update(JSON.stringify(sources)).digest('hex'), options.sourceTreeSha256,
      'native RPC worker sources must match the separately frozen harness manifest');
  }
  await context.writeArtifactJson('windows-native-source-inputs.json', { inputs: identities,
    binarySourceCommit: options.expectedCommit ?? null, sourceTreeSha256: options.sourceTreeSha256,
    probeKind: options.probeKind ?? 'libtest', installerAcceptance: false });
  let sequence = 0;
  const execute = (command, args, input, timeoutMs = 120000, closeInput = false) => new Promise((accept, reject) => {
    const spec = windowsSshInvocation(context, command, args, options.target), label = `windows-libtest-${++sequence}`;
    const child = context.spawnOwned(label, spec.command, spec.args, { ...spec.options, stdin: input === undefined ? 'ignore' : 'pipe' });
    let stdout = '', stderr = '', bytes = 0, settled = false;
    const fail = error => { if (settled) return; settled = true; clearTimeout(timer); void context.stopOwned(label); reject(error); };
    const timer = setTimeout(() => fail(Error('Owned Windows libtest transport deadline')), timeoutMs);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 1024 * 1024) fail(Error('Owned libtest result budget')); else stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    child.once('error', fail); child.once('close', code => { if (settled) return; settled = true; clearTimeout(timer);
      code === 0 ? accept(stdout) : reject(Error(`Owned Windows libtest transport failed (${code}): ${context.redactText(stderr)}`)); });
    if (input !== undefined) {if(closeInput)child.stdin.end(input);else child.stdin.write(input);}
  });
  const args = script => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-S', 'none', options.target,
    'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script, 'utf16le').toString('base64')];
  if (options.probeKind === 'private-credentials') {
    const node = JSON.parse((await execute('ssh', args(`@{sha256=(Get-FileHash -LiteralPath ${psLiteral(options.node)} -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress`))).trim());
    assert.equal(node.sha256, options.nodeSha256, 'The existing Node executable changed');
  }
  const owner = randomUUID(), root = options.parent.replace(/\\$/, '') + '\\kcoder-package-' + owner;
  const absent = JSON.parse((await execute('ssh', args(`@{absent=(!(Test-Path -LiteralPath ${psLiteral(root)}))}|ConvertTo-Json -Compress`))).trim());
  assert.equal(absent.absent, true, 'An existing fixture may never be adopted');
  await context.writeArtifactJson('windows-native-owner-intent.json', { owner, root, initiallyAbsent: true });
  const cleanupPath = context.pathInArtifacts('windows-libtest-cleanup.json');
  context.addCleanup('stop owned native test processes then remove Windows fixture', async () => {
    await cleanupWindowsNativeFixture(context, options, root, owner, cleanupPath);
  });
  assert.equal(JSON.parse((await execute('ssh', args(ownedCreationScript(options.parent, owner)))).trim()), root);
  let nodeExecutable = options.node;
  if (options.probeKind === 'private-credentials') {
    nodeExecutable = root + '\\node.exe';
    const copied = JSON.parse((await execute('ssh', args(`$source=${psLiteral(options.node)};$destination=${psLiteral(nodeExecutable)};if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${options.nodeSha256}'){throw 'Pinned Node changed'};[IO.File]::Copy($source,$destination,$false);@{sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress`))).trim());
    assert.equal(copied.sha256, options.nodeSha256);
  }
  const input = { root, owner, testSha256: options.testSha256, supervisorSha256: options.supervisorSha256,
    sourceTreeSha256: options.sourceTreeSha256, expectedTests: options.expectedTests, probeKind: options.probeKind ?? 'libtest',
    expectedCommit: options.expectedCommit, expectedDirty: options.expectedDirty, rustMinStack: options.rustMinStack,
    exactTest: options.exactTest, testFilter: options.testFilter };
  if (options.probeKind === 'web-diagnostic') {input.externalWebCase=options.externalWebCase||'example';if(options.diagnosticDirect===true)input.diagnosticDirect=true;if(options.diagnosticHostname===true)input.diagnosticHostname=true;}
  if (options.externalWebRead === true) {input.externalWebRead = true;input.externalWebCase=options.externalWebCase||'example';}
  if (['web-runtime','web-verify-only'].includes(options.probeKind)) input.runtimeArchiveSha256 = options.runtimeArchiveSha256;
  if (options.runIgnored === true) input.runIgnored = true;
  if (options.chromiumArchive !== undefined) input.chromiumArchiveSha256 = options.chromiumArchiveSha256;
  if (options.pathFixture !== undefined) input.pathFixture = options.pathFixture;
  if (options.gitLineEndings !== undefined) input.gitLineEndings = options.gitLineEndings;
  if (options.pacFixture === true) input.pacFixture = true;
  if (options.probeKind === 'cross-host-source') input.crossHost = {
    ...options.crossHost, gatewayBundleSha256: options.gatewayBundleSha256, sshWrapperSha256: options.sshWrapperSha256,
  };
  if (options.probeKind === 'private-credentials') {
    input.nodeSha256 = options.nodeSha256;
    input.runtimeReviewSha256 = options.reviewedSourceSha256;
    input.runtimeSources = identities.filter(value => value.leaf.endsWith('.mjs')).map(value => ({ leaf: value.leaf, sha256: value.sha256 }));
    const fixture = { owner, values: Array.from({ length: 4 }, () => randomBytes(32).toString('hex')) };
    for (const value of fixture.values) context.registerSecret(value);
    const saved = JSON.parse((await execute('ssh', args(`$v=[Console]::In.ReadLine()|ConvertFrom-Json;if($v.owner -ne ${psLiteral(owner)}){throw 'Owned private fixture identity changed'};$stream=[IO.File]::Open(${psLiteral(root + '\\private-fixture.json')},[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($v|ConvertTo-Json -Depth 4 -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()};@{saved=$true}|ConvertTo-Json -Compress`), JSON.stringify(fixture) + '\n')).trim());
    assert.equal(saved.saved, true);
  }
  const descriptor = await context.writeStateJson('native-libtest.json', input);
  files.push([descriptor, 'native-libtest.json']);
  for (const [local, leaf,expectedSha] of files) {
    if(options.chunkedTransfer) await transferWindowsArtifact({context,ps:(script,input,timeout)=>execute('ssh',args(script),input,timeout,true),uploadPart:(part,relative)=>execute('scp',['-o','BatchMode=yes','-o','ControlPath=none',part,`${options.target}:${root.replaceAll('\\','/')}/${relative}`]),local,owner,root,leaf,sha256:expectedSha});
    else await execute('scp', [...(options.legacyScp?['-O']:[]),...(options.compressTransfer?['-C']:[]),'-o', 'BatchMode=yes', '-o', 'ControlPath=none', local, `${options.target}:${root.replaceAll('\\', '/')}/${leaf}`]);
  }
  if(options.testBinaryArchive!==undefined) {
    await execute('ssh',args(`$r=${psLiteral(root)};$a=Join-Path $r 'tests.exe.gz';if((Get-FileHash -LiteralPath $a -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${options.testBinaryArchiveSha256}'){throw 'Native transfer archive changed'};$f=[IO.File]::OpenRead($a);$z=[IO.Compression.GZipStream]::new($f,[IO.Compression.CompressionMode]::Decompress);$o=[IO.File]::Open((Join-Path $r 'tests.exe'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$buffer=New-Object byte[] 65536;$total=[long]0;while(($n=$z.Read($buffer,0,$buffer.Length)) -gt 0){$total+=$n;if($total -gt 256MB){throw 'Native executable budget exceeded'};$o.Write($buffer,0,$n)};$o.Flush($true)}finally{$o.Dispose();$z.Dispose();$f.Dispose()};if((Get-FileHash -LiteralPath (Join-Path $r 'tests.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne '${options.testSha256}'){throw 'Native decompressed executable changed'}`));
  }
  if (options.chromiumArchive !== undefined) {
    await execute('ssh', args(`$root=${psLiteral(root)};if((Get-Content -LiteralPath (Join-Path $root '.owner.json') -Raw|ConvertFrom-Json).owner -ne '${owner}'){throw 'Chrome owner changed'};$zip=Join-Path $root 'chromium.zip';if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${options.chromiumArchiveSha256}'){throw 'Chrome archive changed'};Add-Type -AssemblyName System.IO.Compression.FileSystem;$archive=[IO.Compression.ZipFile]::OpenRead($zip);try{$names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);$total=[long]0;foreach($entry in $archive.Entries){$name=$entry.FullName;if($name -match '(^[/\\\\]|:|(^|/)\\.\\.(/|$)|\\\\)' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960 -or !$names.Add($name)){throw 'Unsafe Chrome archive entry'};$total+=$entry.Length;if($total -gt 1GB -or $names.Count -gt 20000){throw 'Chrome archive budget exceeded'}}}finally{$archive.Dispose()};[IO.Compression.ZipFile]::ExtractToDirectory($zip,(Join-Path $root 'chromium'))`));
  }
  await context.writeArtifactJson('windows-libtest-input.json', input);
  const raw = await execute('ssh', args(`& ${psLiteral(nodeExecutable)} ${psLiteral(root + '\\probe.mjs')} ${psLiteral(root + '\\native-libtest.json')};if($LASTEXITCODE -ne 0){throw 'Native libtest probe failed'}`), JSON.stringify({ owner }) + '\n', options.probeKind === 'cross-host-source' ? 480000 : options.probeKind === 'web-verify-only' ? 180000 : 120000);
  const result = JSON.parse(raw.trim());
  await context.writeArtifactJson(options.probeKind === 'terminal' ? 'windows-terminal-result.json'
    : options.probeKind === 'local-attachment' ? 'windows-local-attachment-result.json' : 'windows-libtest-result.json', result);
  if (options.probeKind === 'private-credentials' && (await execute('ssh', args(`Test-Path -LiteralPath ${psLiteral(root + '\\private-diagnostic.json')}`))).trim() === 'True') {
    const file = context.pathInState('private-diagnostic.json');
    await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', `${options.target}:${root.replaceAll('\\', '/')}/private-diagnostic.json`, file]);
    const stat = await lstat(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096);
    const value = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(value).sort(), ['errorCode', 'nativeRpcCode', 'phase']);
    assert.deepEqual(value, privateDiagnostic(value.phase, { code: value.errorCode, nativeRpcCode: value.nativeRpcCode }));
    await context.writeArtifactJson('windows-private-diagnostic.json', value);
  }
  if (options.probeKind === 'terminal' && (await execute('ssh', args(`Test-Path -LiteralPath ${psLiteral(root + '\\terminal-case\\terminal-diagnostic.json')}`))).trim() === 'True')
    await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', `${options.target}:${root.replaceAll('\\', '/')}/terminal-case/terminal-diagnostic.json`, context.pathInArtifacts('terminal-diagnostic.json')]);
  if (options.probeKind === 'cross-host-source' && (await execute('ssh', args(`Test-Path -LiteralPath ${psLiteral(root + '\\cross-host-diagnostic.txt')}`))).trim() === 'True')
    await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', `${options.target}:${root.replaceAll('\\', '/')}/cross-host-diagnostic.txt`, context.pathInArtifacts('cross-host-diagnostic.txt')]);
  if (options.probeKind === 'cross-host-source' && (await execute('ssh', args(`Test-Path -LiteralPath ${psLiteral(root + '\\cross-host-child-events.jsonl')}`))).trim() === 'True')
    await execute('scp', ['-o', 'BatchMode=yes', '-o', 'ControlPath=none', `${options.target}:${root.replaceAll('\\', '/')}/cross-host-child-events.jsonl`, context.pathInArtifacts('cross-host-child-events.jsonl')]);
  assert.equal(result.platform, 'win32'); assert.equal(result.binarySha256, options.probeKind === 'web-diagnostic' ? options.testSha256 ?? null : options.testSha256);
  assert.equal(result.sourceTreeSha256, options.sourceTreeSha256);
  assert.equal(result.passed, true, 'native libtest failure; see recorded output and exact executed counts');
  return result;
}
