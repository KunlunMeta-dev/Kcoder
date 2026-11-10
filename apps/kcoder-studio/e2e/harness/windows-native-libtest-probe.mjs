import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawnWindowsSupervised } from './owned-process.mjs';

assert.equal(process.platform, 'win32');
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.ok(input.pathFixture === undefined || input.probeKind === 'libtest');
const root = resolve(input.root);
assert.equal(JSON.parse(await readFile(join(root, '.owner.json'), 'utf8')).owner, input.owner);
const temporary = join(root, 'temporary'), profile = input.zeroBusinessStartup===true||input.probeKind==='web-exa-handshake'?join(root,'diagnostic-profile-owner','state'):join(root, 'isolated-profile');
for (const path of [temporary, profile, join(root, 'workspace')]) await mkdir(path, { recursive: true });
if (input.gitLineEndings !== undefined) {
  assert.equal(input.probeKind, 'libtest');
  assert.equal(input.gitLineEndings, 'preserve');
  // The regression controls its own Git policy rather than inheriting machine-wide autocrlf.
  await writeFile(join(profile, '.gitconfig'), '[core]\n\tautocrlf = false\n', { flag: 'wx' });
}
const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
Object.assign(environment, { TEMP: temporary, TMP: temporary, HOME: profile, USERPROFILE: profile,
  APPDATA: profile, LOCALAPPDATA: profile, KCODER_CONFIG_DIR: profile, RUST_BACKTRACE: '0' });
if (input.chromiumArchiveSha256 !== undefined) {
  assert.match(input.chromiumArchiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(input.runIgnored, true);
  environment.KCODER_CHROMIUM_BIN = join(root, 'chromium', 'chrome-win64', 'chrome.exe');
  environment.KCODER_PROCESS_SUPERVISOR_BIN = join(root, 'supervisor.exe');
}
if (input.probeKind === 'cross-host-source') {
  for (const name of ['ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
}
if (input.probeKind === 'terminal' && input.rustMinStack !== undefined) {
  assert.ok(Number.isSafeInteger(input.rustMinStack) && input.rustMinStack >= 2097152 && input.rustMinStack <= 67108864);
  environment.RUST_MIN_STACK = String(input.rustMinStack);
}
if (input.externalWebRead === true) {environment.KCODER_TEST_LIVE_WEB_READ = '1';environment.KCODER_TEST_LIVE_WEB_CASE=input.externalWebCase||'example';}
process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(root, 'supervisor.exe');
environment.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(root, 'supervisor.exe');
const sha = data => createHash('sha256').update(data).digest('hex');
if (input.probeKind !== 'web-diagnostic' || input.testSha256 !== undefined)
  assert.equal(sha(await readFile(join(root, 'tests.exe'))), input.testSha256);
assert.equal(sha(await readFile(join(root, 'supervisor.exe'))), input.supervisorSha256);

if (input.probeKind === 'private-credentials') {
  assert.equal(sha(await readFile(process.execPath)), input.nodeSha256);
  assert.match(input.runtimeReviewSha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(input.runtimeSources) && input.runtimeSources.length >= 5);
  for (const source of input.runtimeSources) {
    assert.match(source.leaf, /^[a-z0-9.-]+\.mjs$/);
    assert.equal(sha(await readFile(join(root, source.leaf))), source.sha256);
  }
}
if (process.argv[3] === '--private-credentials-worker') {
  const { runWindowsPrivateCredentialRpcCase } = await import('./windows-private-credential-rpc.mjs');
  console.log(JSON.stringify(await runWindowsPrivateCredentialRpcCase({ root, binary: join(root, 'tests.exe'), environment, owner: input.owner })));
  process.exit(0);
}

if (process.argv[3] === '--cross-host-source-worker') {
  const { runCrossHostSourceCase } = await import('./windows-cross-host-source-case.mjs');
  console.log(JSON.stringify(await runCrossHostSourceCase({ root, binary: join(root, 'tests.exe'), environment, connection: input.crossHost })));
  process.exit(0);
}

if (['--terminal-worker', '--local-attachment-worker'].includes(process.argv[3])) {
  const { runWindowsMigrationProbe } = await import('./windows-migration-probe.mjs');
  const local = process.argv[3] === '--local-attachment-worker';
  console.log(JSON.stringify(await runWindowsMigrationProbe({ binary: join(root, 'tests.exe'),
    root: join(root, local ? 'local-attachment-case' : 'terminal-case'), environment,
    terminalOnly: !local, localAttachmentOnly: local, ownerRoot: root })));
  process.exit(0);
}
const identity = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `(Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}').CreationDate.ToUniversalTime().Ticks.ToString()`],
{ windowsHide: true, timeout: 10000, encoding: 'utf8' }).trim();
assert.match(identity, /^\d+$/);
await writeFile(join(root, 'probe-owner.json'), JSON.stringify({ owner: input.owner, pid: process.pid, creationTicks: identity }));

let active, finished = false, readPaths = null, readPathCleanup = null, readPathModule = null, pacFixture = null;
const authority = createInterface({ input: process.stdin });
authority.on('close', () => { if (!finished) { active?.stdin.destroy(); process.exit(2); } });
const first = await new Promise((accept, reject) => {
  authority.once('line', line => { try { accept(JSON.parse(line)); } catch { reject(Error('Invalid native test owner')); } });
  authority.once('close', () => { if (!finished) reject(Error('Native test owner disconnected')); });
});
assert.equal(first.owner, input.owner);

async function run(args, executable = join(root, 'tests.exe'), timeoutMs = 90000) {
  const { child, identity } = spawnWindowsSupervised(executable, args,
    { cwd: join(root, 'workspace'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] }, join(root, 'process-status'));
  active = child;
  let stdout = '', stderr = '', bytes = 0;
  const completion = new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.stdin.destroy(); reject(Error('Native libtest deadline')); }, timeoutMs);
    const collect = field => data => {
      bytes += data.length;
      if (bytes > 512 * 1024) { child.stdin.destroy(); reject(Error('Native libtest output budget')); }
      else if (field === 'stdout') stdout += data; else stderr += data;
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); active = undefined; accept({ code, stdout, stderr }); });
  });
  await identity.readyPromise;
  return completion;
}
try {
  if(input.zeroBusinessStartup===true){
    assert.equal(input.probeKind,'libtest');assert.equal(input.runIgnored,true);
    assert.equal(input.exactTest,'searxng_runtime::startup_probe::owned_startup_only_reports_ready_and_cleanup');
    assert.deepEqual(input.expectedTests,[input.exactTest]);
    assert.equal(sha(await readFile(join(root,'runtime.tar.gz'))),input.runtimeArchiveSha256);
    const runtime=join(root,'runtime');await mkdir(runtime);const extracted=await run(['-xf',join(root,'runtime.tar.gz'),'-C',runtime],join(process.env.SystemRoot,'System32','tar.exe'));assert.equal(extracted.code,0);
    environment.KCODER_SEARXNG_RUNTIME=runtime;environment.KCODER_E2E_WEB_EXTERNAL_NETWORK='1';environment.KCODER_E2E_WINDOWS_NATIVE_LIBTEST='1';
  }
  if(input.probeKind==='web-winhttp-inprocess'){
    assert.equal(input.helperSha256,'e52d8e078bb50517671586b5e37f50fc1d02e333b92dafa014be581c7634ed3c');assert.equal(sha(await readFile(join(root,'winhttp-inprocess.ps1'))),input.helperSha256);
    environment.KCODER_E2E_WEB_EXTERNAL_NETWORK='1';environment.KCODER_E2E_WINDOWS_NATIVE_LIBTEST='1';
    let executed=null,timedOut=false,failureClass=null;try{executed=await run(['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'winhttp-inprocess.ps1'),...(input.inProcessCompileOnly===true?['-CompileOnly']:[])],join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),25000)}catch(error){timedOut=error.message==='Native libtest deadline';failureClass=timedOut?'deadline':'native_wrapper_failure';if(active)await new Promise(resolve=>{const timer=setTimeout(resolve,4000);active.once('close',()=>{clearTimeout(timer);resolve()})})}
    let receipt={mode:'winhttp-inprocess',wrapperSucceeded:false,phase:'child_output_absent',nativeCode:null,logicalQueries:0,modelCalls:0,destinationHttpSent:false,timedOut,failureClass};if(executed?.stdout.trim()){try{receipt=JSON.parse(executed.stdout.trim())}catch{}}
    console.log(JSON.stringify({platform:process.platform,binarySha256:input.testSha256,sourceTreeSha256:input.sourceTreeSha256,mode:'winhttp-inprocess',zeroBusinessObservation:true,receipt,exampleExitCode:executed?.code??null,stderrBytes:Buffer.byteLength(executed?.stderr??''),rawStderrPersisted:false,logicalQueries:0,modelCalls:0,passed:true}));
  } else if(input.probeKind==='web-wpad-discovery'){
    let executed=null,timedOut=false;try{executed=await run(['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'wpad-discovery.ps1'),...(input.wpadCompileOnly===true?['-CompileOnly']:[])],join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),25000)}catch{timedOut=true;if(active)await new Promise(resolve=>{const timer=setTimeout(resolve,4000);active.once('close',()=>{clearTimeout(timer);resolve()})})}
    let receipt={mode:'wpad-discovery-only',discoverySucceeded:null,discovered:null,nativeCode:null,pacDownloaded:false,logicalQueries:0,modelCalls:0,timedOut};if(executed?.stdout.trim()){try{receipt=JSON.parse(executed.stdout.trim())}catch{}}
    console.log(JSON.stringify({platform:process.platform,binarySha256:input.testSha256,sourceTreeSha256:input.sourceTreeSha256,mode:'wpad-discovery-only',zeroBusinessObservation:true,receipt,exampleExitCode:executed?.code??null,stderrBytes:Buffer.byteLength(executed?.stderr??''),rawStderrPersisted:false,logicalQueries:0,modelCalls:0,passed:true}));
  } else if(input.probeKind==='web-exa-handshake'){
    environment.KCODER_E2E_WEB_EXTERNAL_NETWORK='1';environment.KCODER_E2E_WINDOWS_NATIVE_LIBTEST='1';
    const executed=await run([],join(root,'tests.exe'),50000);let receipt=null;try{receipt=JSON.parse(executed.stdout.trim())}catch{}
    const progress=[];for(const line of executed.stderr.split(/\r?\n/)){if(!line.trim())continue;try{progress.push(JSON.parse(line))}catch{}}
    console.log(JSON.stringify({platform:process.platform,binarySha256:input.testSha256,sourceTreeSha256:input.sourceTreeSha256,mode:'exa-handshake-only',zeroBusinessObservation:true,receipt,progress,exampleExitCode:executed.code,stderrBytes:Buffer.byteLength(executed.stderr),rawStderrPersisted:false,logicalQueries:0,modelCalls:0,passed:receipt!==null}));
  } else if (input.pacFixture === true) {
    assert.equal(input.runIgnored, true);
    assert.equal(input.probeKind, 'libtest');
    const pac = await import('./windows-pac-fixture.mjs');
    assert.equal(input.testFilter, pac.WINDOWS_PAC_TEST_FILTER);
    assert.deepEqual([...input.expectedTests].sort(), [...pac.WINDOWS_PAC_TESTS].sort());
    pacFixture = await pac.startWindowsPacFixture();
    const path = join(root, 'pac-fixture.json');
    await writeFile(path, JSON.stringify(pacFixture.fixture), { flag: 'wx', mode: 0o600 });
    environment.KCODER_TEST_WINDOWS_PAC_FIXTURE = path;
  }
  if(['web-exa-handshake','web-wpad-discovery','web-winhttp-inprocess'].includes(input.probeKind)) {
    // The fixed native handshake above already produced the only observation.
  } else if (input.probeKind === 'web-diagnostic') {
    const executed = await run(['-NoProfile','-NonInteractive','-File',join(root,'web-diagnostic.ps1'),'-Case',input.externalWebCase||'example',...(input.diagnosticDirect===true?['-Direct']:[]),...(input.diagnosticHostname===true?['-HostnameConnect']:[])], join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'), 60000);
    const details = executed.code === 0 ? JSON.parse(executed.stdout.trim()) : null;
    console.log(JSON.stringify({platform:process.platform,binarySha256:input.testSha256??null,sourceTreeSha256:input.sourceTreeSha256,
      framework:input.diagnosticHostname===true?'one ordinary hostname CONNECT system-curl control; diagnostic observation, not a successful pinned product read':'bounded same-URL pinned CONNECT/TLS controls; diagnostic observations, not successful product reads',diagnosticOnly:true,nativeLibtestBinaryExecuted:false,details,
      summary:{passed:details?1:0,failed:details?0:1,ignored:0},passed:details?.readOnly===true&&details?.registryWrites===0&&(input.diagnosticHostname===true?(details?.dnsPinned===false&&details?.route==='static-system-proxy/hostname-CONNECT'&&details?.curlReadAttempts===1&&details?.credentialsSent===false&&details?.controls?.length===1):details?.dnsPinned===true)&&details?.tlsBypass===false}));
  } else if (input.probeKind === 'web-verify-only') {
    assert.equal(sha(await readFile(join(root,'runtime.tar.gz'))),input.runtimeArchiveSha256);
    const runtime=join(root,'runtime');await mkdir(runtime);
    const unpacked=await run(['-xf',join(root,'runtime.tar.gz'),'-C',runtime],join(process.env.SystemRoot,'System32','tar.exe'));assert.equal(unpacked.code,0);
    environment.KCODER_SEARXNG_RUNTIME=runtime;
    const executed=await run(['--verify-only'],join(root,'tests.exe'),120000);
    let observed=null;if(executed.stdout.trim())observed=JSON.parse(executed.stdout.trim());
    const passed=executed.code===0&&observed?.passed===true&&observed.mode==='verify-only'&&observed.phase==='sealed_verify'&&Number.isSafeInteger(observed.elapsedMs)&&observed.pythonStarts===0&&observed.dnsRequests===0&&observed.httpRequests===0&&observed.logicalRequests===0;
    const authority=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$i=[Security.Principal.WindowsIdentity]::GetCurrent();$h=[Security.Cryptography.SHA256]::Create();$s=[BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($i.User.Value))).Replace('-','').ToLowerInvariant();@{sidSha256=$s;isAdmin=([Security.Principal.WindowsPrincipal]::new($i)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);fileSystem=(Get-CimInstance Win32_LogicalDisk|Where-Object DeviceID -eq '"+root.slice(0,2)+"').FileSystem}|ConvertTo-Json -Compress"],{encoding:'utf8',windowsHide:true});
    console.log(JSON.stringify({platform:process.platform,binarySha256:input.testSha256,sourceTreeSha256:input.sourceTreeSha256,framework:'same Rust full sealed runtime verifier on actual Windows; volume type observed separately; zero Python/DNS/HTTP/query',observed,authority:JSON.parse(authority.trim()),runtimeInventorySha256:sha(await readFile(join(runtime,'files.sha256.json'))),nativeLibtestBinaryExecuted:false,executed,names:input.expectedTests,summary:{passed:passed?1:0,failed:passed?0:1,ignored:0},passed}));
  } else if (input.probeKind === 'web-runtime') {
    assert.equal(sha(await readFile(join(root, 'runtime.tar.gz'))), input.runtimeArchiveSha256);
    const runtime = join(root, 'runtime');
    await mkdir(runtime);
    const unpacked = await run(['-xf', join(root, 'runtime.tar.gz'), '-C', runtime], join(process.env.SystemRoot, 'System32', 'tar.exe'));
    assert.equal(unpacked.code, 0);
    const manifest = JSON.parse(await readFile(join(runtime, 'runtime-manifest.json'), 'utf8'));
    assert.equal(manifest.platform, 'win-x64');
    assert.equal(manifest.python, 'python/python.exe');
    for (const [leaf, expected] of [['launch.py', manifest.launcherSha256], ['egress.py', manifest.egressSha256]])
      assert.equal(sha(await readFile(join(runtime, leaf))), expected);
    const python = join(runtime, 'python', 'python.exe');
    const imports = await run(['-I', '-B', join(runtime, 'launch.py'), '--check'], python);
    assert.equal(imports.code, 0);
    const importReceipt = JSON.parse(imports.stdout.trim());
    assert.equal(importReceipt.status, 'imports_ready');
    assert.equal(importReceipt.python, manifest.pythonVersion);
    const executed = await run(['-I', '-B', join(root, 'test-runtime.py'), '--runtime', runtime, '-v'], python);
    const summary = /Ran (\d+) tests?/.exec(executed.stderr);
    const cases = input.expectedTests.filter(name => executed.stderr.includes(name + ' '));
    console.log(JSON.stringify({platform: process.platform, binarySha256: input.testSha256,
      sourceTreeSha256: input.sourceTreeSha256, framework: 'actual bundled Windows Python/curl/SearXNG and owner EOF; no installed app, model or public upstream acceptance',
      imports: importReceipt, pythonSha256: sha(await readFile(python)), nativeLibtestBinaryExecuted: false, runtimeInventorySha256: sha(await readFile(join(runtime, 'files.sha256.json'))),
      names: cases, executed, summary: {passed: summary ? Number(summary[1]) : 0, failed: executed.code === 0 ? 0 : 1, ignored: 0},
      passed: executed.code === 0 && summary?.[1] === String(input.expectedTests.length) && cases.length === input.expectedTests.length && /\nOK\s*$/.test(executed.stderr)}));
  } else if (['terminal', 'local-attachment', 'cross-host-source', 'private-credentials'].includes(input.probeKind)) {
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ credential_store: 'file', mcp_servers: [], hooks: {},
      active_provider: 'fixture', providers: { fixture: { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
        endpoint: 'http://127.0.0.1:9/v1', default_model: 'fixture', discover_models: false,
        context_window_tokens: 128000, max_output_tokens: 2048, output_headroom_tokens: 4096 } } }));
    const doctor = await run(['doctor']);
    const commit = /^build commit: (.+)$/m.exec(doctor.stdout)?.[1]?.trim();
    const dirty = /^build dirty: (.+)$/m.exec(doctor.stdout)?.[1]?.trim();
    const executableSha256 = /^executable sha256: (.+)$/m.exec(doctor.stdout)?.[1]?.trim();
    assert.equal(doctor.code, 0); assert.equal(commit, input.expectedCommit);
    assert.equal(dirty, String(input.expectedDirty)); assert.equal(executableSha256, input.testSha256);
    const executed = await run([process.argv[1], process.argv[2], input.probeKind === 'private-credentials' ? '--private-credentials-worker' : input.probeKind === 'terminal'
      ? '--terminal-worker' : input.probeKind === 'cross-host-source' ? '--cross-host-source-worker' : '--local-attachment-worker'], process.execPath,
      input.probeKind === 'cross-host-source' ? 420000 : 90000);
    let details = null;
    if (executed.code === 0) details = JSON.parse(executed.stdout);
    console.log(JSON.stringify({ platform: process.platform, sourceTreeSha256: input.sourceTreeSha256,
      binarySha256: input.testSha256, framework: input.probeKind === 'private-credentials' ? 'actual Windows Native private RPC file-backend bundle/status/group publication and Undo; not OS keyring, Gateway, GUI or installer' : input.probeKind === 'terminal'
        ? 'actual CLI JSON-RPC/native ConPTY plus official xterm; not Rust libtest or GUI'
        : input.probeKind === 'cross-host-source' ? 'actual Windows/Linux configuration/skill/history/memory/passive definitions/scoped instruction graph/plugin/HPKE private file values; ordinary publication/reopen/Undo; not OS keyring, dedicated UID, GUI or installer'
        : 'actual CLI JSON-RPC/local attachment bytes and idle continuation; not Rust libtest, installer or GUI',
      build: { commit, dirty: input.expectedDirty, rustMinStack: input.rustMinStack ?? null }, executed, details, passed: executed.code === 0 && details?.passed === true }));
  } else {
  if (input.pathFixture !== undefined) {
    readPathModule = await import('./windows-read-consumers.mjs');
    const expected = readPathModule.windowsReadConsumerSelections(input.pathFixture.scope);
    assert.ok(expected.some(row => row.exactTest === input.exactTest));
    readPaths = await readPathModule.prepareWindowsReadConsumerPaths({ root, owner: input.owner, mode: input.pathFixture.mode });
  }
  if (readPaths && !readPaths.ready) {
    console.log(JSON.stringify({ platform: process.platform, sourceTreeSha256: input.sourceTreeSha256, binarySha256: input.testSha256,
      names: [], listMatched: false, executed: null, summary: null, prerequisite: readPaths, passed: false }));
  } else {
  if (readPaths) { environment.TEMP = readPaths.temporary; environment.TMP = readPaths.temporary; }
  const filter = [...(input.runIgnored === true ? ['--ignored'] : []), ...(input.exactTest !== undefined ? ['--exact', input.exactTest] : input.testFilter !== undefined ? [input.testFilter] : [])];
  const listed = await run([...filter, '--list', '--format', 'terse']);
  const names = [...listed.stdout.matchAll(/^(.+): test\r?$/gm)].map(match => match[1]).sort();
  const expected = [...input.expectedTests].sort();
  const listMatched = listed.code === 0 && JSON.stringify(names) === JSON.stringify(expected);
  const executed = listMatched ? await run([...filter, '--test-threads=1', '--nocapture']) : null;
  const summary = executed ? /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/.exec(executed.stdout) : null;
  const pacObserved = pacFixture?.stats();
  const pacCleanup = pacFixture ? await pacFixture.stop() : null;
  if (readPaths) readPathCleanup = await readPathModule.cleanupWindowsReadConsumerPaths(readPaths, active === undefined);
  console.log(JSON.stringify({ platform: process.platform, sourceTreeSha256: input.sourceTreeSha256,
    ...(readPaths ? { pathFixture: readPaths, pathCleanup: readPathCleanup } : {}),
    ...(pacCleanup ? { pacFixture: { schemaVersion: 1, personalProxyConfigurationModified: false, explicitTestConfiguration: true, observed: pacObserved, cleanup: pacCleanup,
      sharedWinHttpServiceTerminated: false, publicTraffic: false } } : {}),
    binarySha256: input.testSha256, listed, names, listMatched, executed,
    summary: summary ? { passed: Number(summary[2]), failed: Number(summary[3]), ignored: Number(summary[4]), measured: Number(summary[5]), filtered: Number(summary[6]) } : null,
    selection: { exactTest: input.exactTest ?? null, testFilter: input.testFilter ?? null, gitLineEndings: input.gitLineEndings ?? null, unselectedTestsAreNotPasses: true },
    passed: listMatched && executed?.code === 0 && summary?.[1] === 'ok' && Number(summary[2]) === expected.length && summary[3] === '0' && summary[4] === '0'
      && (input.exactTest !== undefined || input.testFilter !== undefined ? Number(summary[6]) >= 0 : summary[6] === '0') }));
  }
}
} finally {
  if (readPaths?.ready && !readPathCleanup && active === undefined) await readPathModule.cleanupWindowsReadConsumerPaths(readPaths, true);
  finished = true; authority.close(); active?.stdin.destroy();
  await pacFixture?.stop();
}
