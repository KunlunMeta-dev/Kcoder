import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { open, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { runE2E, repoRoot } from '../harness/run-context.mjs';
import { openRpc, initializeRpc, closeRpcAndWait, isTurnCompletion } from '../harness/rpc.mjs';

const HOST_KEY_ALIAS = 'relay-target-4792';
const REMOTE_USER = 'kunlun@127.0.0.1';
const MAX_TOOL_CALLS = 10;
const TOOL_PREFIX = 'mcp__kcoder_computer_use__';
const ALLOWED_TOOLS = new Set(['Screenshot', 'Type', 'Click'].map(name => `${TOOL_PREFIX}${name}`));
const EXPECTED_DESKTOP_HOST_TOOLS = [
  'Snapshot', 'Screenshot', 'DisplayInventory', 'App', 'Click', 'Type', 'Scroll', 'Move', 'Shortcut', 'WaitFor',
].map(name => `${TOOL_PREFIX}${name}`);

if (process.env.KCODER_E2E_REAL_MODEL !== '1' || process.env.KCODER_E2E_REMOTE_WINDOWS !== '1') {
  throw new Error('Explicit remote Windows and real-model consent is required');
}
const exec = promisify(execFile);

async function readProtectedInput(path, label, maxBytes, { privateFile = true } = {}) {
  if (!isAbsolute(path) || typeof process.getuid !== 'function' || fsConstants.O_NOFOLLOW === undefined) {
    throw new Error(`${label} input cannot be validated safely on this platform`);
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.size > maxBytes) {
      throw new Error(`${label} input must be a bounded, user-owned regular file`);
    }
    if (privateFile ? (info.mode & 0o177) !== 0 : (info.mode & 0o022) !== 0) {
      throw new Error(`${label} input permissions are too broad`);
    }
    const contents = await handle.readFile();
    if (contents.length > maxBytes) throw new Error(`${label} input exceeds its size limit`);
    return contents;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} input`)) throw error;
    throw new Error(`${label} input could not be opened safely`);
  } finally {
    await handle?.close();
  }
}

async function writeRunOwnedFile(directory, name, contents) {
  const path = join(directory, name);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  const check = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await check.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o177) !== 0) {
      throw new Error('Run-owned SSH input permissions could not be confirmed');
    }
  } finally {
    await check.close();
  }
  return path;
}

function matchingKnownHostRecords(output) {
  const records = output.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const exact = [];
  for (const record of records) {
    const [hostField, keyType, keyData] = record.split(/\s+/);
    const exactPlainAlias = hostField === HOST_KEY_ALIAS;
    const hashedExactMatch = /^\|[12]\|[^|\s]+\|[^|\s]+$/.test(hostField ?? '');
    const validKeyType = /^(?:ssh-|ecdsa-|sk-ssh-|rsa-sha2-)/.test(keyType ?? '');
    const validKeyData = typeof keyData === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(keyData)
      && Buffer.from(keyData, 'base64').length > 0;
    if ((!exactPlainAlias && !hashedExactMatch) || !validKeyType || !validKeyData) {
      throw new Error('Known-hosts lookup returned a non-exact or invalid host key record');
    }
    exact.push(record);
  }
  if (exact.length === 0) throw new Error(`No strict host key is registered for ${HOST_KEY_ALIAS}`);
  return `${[...new Set(exact)].join('\n')}\n`;
}

function psQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

await runE2E(import.meta.url, {
  testId: 'remote-windows-4792-owned-computer-use', tier: 'manual-live',
  cleanupTimeoutMs: 40_000,
  modelPolicy: `User-authorized installed target 4792; one owned thread and one approved turn, at most ${MAX_TOOL_CALLS} tool calls, 1024 output tokens/request, zero provider retries, 120 seconds/turn, 150 second hard timeout/turn, plus one expected-to-reject unapproved turn-start probe. A temporary session template disables and permission-denies every ordinary workspace catalog tool and exact-denies every Computer Use host tool except Screenshot, Type and Click. Dynamic host definitions may still be visible to the model. The Engine checks denied_tools before execution; configured PreToolUse hook allows have separate precedence and are not overridden by this template. Do not alter target provider defaults or peer threads`,
}, async run => {
  const authPath = process.env.KCODER_4792_AUTH_FILE || '/tmp/kcoder-4792-auth-private';
  const sshKeySource = process.env.KCODER_4792_SSH_KEY || '/home/hyf/.ssh/id_ed25519';
  const knownHostsSource = process.env.KCODER_4792_KNOWN_HOSTS || '/home/hyf/.ssh/known_hosts';
  let authData;
  try {
    authData = JSON.parse((await readProtectedInput(authPath, 'Gateway authentication', 64 * 1024)).toString('utf8'));
  } catch (error) {
    throw new Error(error instanceof Error && error.message.startsWith('Gateway authentication input')
      ? error.message : 'Gateway authentication input is invalid');
  }
  const cookie = authData?.cookie;
  assert.equal(typeof cookie, 'string', 'Private Gateway auth input must contain its Cookie value');
  assert.ok(cookie.length >= 8 && cookie.length <= 4096 && !/[\r\n]/.test(cookie), 'Private Gateway Cookie must be a bounded header value');
  run.registerSecret(cookie);

  const sshKeyContents = await readProtectedInput(sshKeySource, 'SSH identity', 1024 * 1024);
  const sshKeyText = sshKeyContents.toString('utf8');
  assert.match(sshKeyText, /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/, 'SSH identity input must be a private-key file');
  run.registerSecret(sshKeyText);

  const knownHostsContents = await readProtectedInput(knownHostsSource, 'SSH known-hosts', 2 * 1024 * 1024, { privateFile: false });
  const knownHostsDigest = createHash('sha256').update(knownHostsContents).digest('hex');
  let knownHostsLookup;
  try {
    knownHostsLookup = await exec('ssh-keygen', ['-F', HOST_KEY_ALIAS, '-f', knownHostsSource], { timeout: 5_000, maxBuffer: 256 * 1024 });
  } catch {
    throw new Error(`No strict host key is registered for ${HOST_KEY_ALIAS}`);
  }
  const knownHostsAfterLookup = await readProtectedInput(knownHostsSource, 'SSH known-hosts', 2 * 1024 * 1024, { privateFile: false });
  assert.equal(createHash('sha256').update(knownHostsAfterLookup).digest('hex'), knownHostsDigest,
    'SSH known-hosts input changed while its exact alias was being selected');
  const knownHostsText = matchingKnownHostRecords(knownHostsLookup.stdout);

  const sshDirectory = join(run.stateDir, 'ssh');
  await mkdir(sshDirectory, { mode: 0o700 });
  run.addCleanup('remove run-owned SSH identity and known-hosts copy', () => rm(sshDirectory, { recursive: true, force: true }));
  const sshDirectoryHandle = await open(sshDirectory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const sshDirectoryInfo = await sshDirectoryHandle.stat();
    if (!sshDirectoryInfo.isDirectory() || sshDirectoryInfo.uid !== process.getuid() || (sshDirectoryInfo.mode & 0o077) !== 0) {
      throw new Error('Run-owned SSH directory permissions could not be confirmed');
    }
  } finally {
    await sshDirectoryHandle.close();
  }
  const sshKey = await writeRunOwnedFile(sshDirectory, 'identity', sshKeyContents);
  const knownHosts = await writeRunOwnedFile(sshDirectory, 'known_hosts', knownHostsText);
  const sshOptions = [
    '-F', '/dev/null',
    '-o', `HostKeyAlias=${HOST_KEY_ALIAS}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'CheckHostIP=no',
    '-o', 'UpdateHostKeys=no',
    '-o', 'CanonicalizeHostname=no',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ProxyCommand=none',
    '-o', 'ProxyJump=none',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-i', sshKey,
  ];
  const remote = async script => {
    const encoded = Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" + script, 'utf16le').toString('base64');
    const result = await exec('ssh', ['-p', '24792', ...sshOptions, REMOTE_USER,
      `powershell.exe -NoProfile -EncodedCommand ${encoded}`], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    return result.stdout.trim();
  };

  const suffix = randomBytes(5).toString('hex');
  const folder = `C:\\Users\\kunlun\\AppData\\Local\\Temp\\kcoder-4792-${suffix}`;
  const folderLiteral = psQuote(folder);
  let workspaceReleased = false;
  let fixtureCleanupConfirmed = true;
  run.addCleanup('remove only this run remote fixture directory after confirmed release', async () => {
    assert.equal(workspaceReleased, true, 'Keep the remote fixture directory if workspace release was not confirmed');
    assert.equal(fixtureCleanupConfirmed, true, 'Keep the remote fixture directory if its process cleanup was not confirmed');
    await remote(`if(Test-Path -LiteralPath ${folderLiteral}) { Remove-Item -LiteralPath ${folderLiteral} -Recurse -Force }`);
  });
  run.addCleanup('release only this run workspace through the authenticated root channel', async () => {
    const anchor = await openRpc('ws://127.0.0.1:46876/rpc?server=local&token=cookie-auth', {
      headers: { Cookie: cookie, Origin: 'http://127.0.0.1:46876' }, timeoutMs: 5_000,
    });
    let release;
    try {
      release = await anchor.request('gateway/workspace/release', { workspacePath: folder }, 25_000);
    } finally {
      await closeRpcAndWait(anchor);
    }
    assert.equal(release?.released, true, 'Gateway must confirm release of the exact run-owned workspace');
    workspaceReleased = true;
  });
  await remote(`New-Item -ItemType Directory -Path ${folderLiteral} | Out-Null`);

  const fixtureLocalPath = `${repoRoot}/scripts/computer-use/live/fixture.ps1`;
  let transferFixture = fixtureLocalPath;
  const unicodeCase = process.env.KCODER_4792_UNICODE === '1';
  if (unicodeCase) {
    const original = await readFile(fixtureLocalPath, 'utf8');
    const initializationAnchor = '$inputBox.Multiline = $true';
    const clickResultAnchor = "[IO.File]::WriteAllText((Join-Path $OutputDirectory 'input-result.json'), $result, $utf8)";
    assert.equal(original.split(initializationAnchor).length, 2, 'Fixture initialization must match exactly once');
    assert.equal(original.split(clickResultAnchor).length, 2, 'Fixture click-result write must match exactly once');
    transferFixture = join(run.stateDir, 'unicode-fixture.ps1');
    const withReplacementSentinel = original.replace(initializationAnchor,
      `${initializationAnchor}\n$inputBox.Text = 'Previous draft must be replaced'`);
    const withVisibleAcknowledgement = withReplacementSentinel.replace(clickResultAnchor,
      `${clickResultAnchor}\n    $label.Text = 'Verification saved. Click count: ' + $script:clickCount`);
    await writeFile(transferFixture, '\ufeff' + withVisibleAcknowledgement, { mode: 0o600 });
  }
  const fixtureRemotePath = `${folder.replaceAll('\\', '/')}/fixture.ps1`;
  await exec('scp', ['-F', '/dev/null', '-P', '24792', ...sshOptions.slice(2), transferFixture,
    `${REMOTE_USER}:${fixtureRemotePath}`], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });

  const rpc = await openRpc(`ws://127.0.0.1:46876/rpc?server=local&workspace=${encodeURIComponent(folder)}&token=cookie-auth`,
    { headers: { Cookie: cookie, Origin: 'http://127.0.0.1:46876' } });
  run.addCleanup('close owned diagnostic RPC before releasing workspace', () => closeRpcAndWait(rpc));
  const init = await initializeRpc(rpc, `owned-target4792-${suffix}`, {
    computerUseStatusV1: true, computerUseTurnV1: true, computerUseRecoveryV1: true,
    computerUseSessionAuthorizationV1: true, settingsTemplatesV1: true, hookConfigurationV1: true,
  });
  assert.equal(init.capabilities.experimental.computerUseTurnV1, true);
  assert.equal(init.capabilities.experimental.hookConfigurationV1, true,
    'Hook configuration read capability is required to verify execution-deny precedence');
  const preflight = await rpc.request('computerUse/status');
  await run.writeArtifactJson('preflight.json', preflight);
  assert.equal(preflight.canControl, true);
  console.log('desktop preflight', preflight.availability, preflight.windowsSessionId);
  const userHookConfiguration = await rpc.request('hooks/config/read');
  const userHooks = userHookConfiguration.hooks;
  assert.ok(userHooks && typeof userHooks === 'object' && !Array.isArray(userHooks),
    'User Hook configuration must return an event map');
  const userHookEvents = Object.keys(userHooks).sort();
  const userPreToolUseMatcherCount = Object.entries(userHooks).reduce((count, [event, matchers]) => {
    const normalizedEvent = event.replace(/[_\s-]/g, '').toLowerCase();
    if (normalizedEvent !== 'pretooluse') return count;
    return count + (Array.isArray(matchers) ? matchers.length : 1);
  }, 0);
  await run.writeArtifactJson('hook-policy-preflight.json', {
    userHookEvents,
    userPreToolUseMatcherCount,
  });
  assert.equal(userPreToolUseMatcherCount, 0,
    'Refuse to run if user settings contain any PreToolUse matcher that could override denied_tools');
  const launcherSource = await readFile(`${repoRoot}/scripts/computer-use/launch.py`, 'utf8');
  const desktopToolArgument = launcherSource.match(/"--tools",\s*"([^"]+)"/);
  assert.ok(desktopToolArgument, 'Pinned Computer Use launcher must declare its worker tool set');
  const desktopHostTools = desktopToolArgument[1].split(',').map(name => `${TOOL_PREFIX}${name}`);
  assert.deepEqual(desktopHostTools, EXPECTED_DESKTOP_HOST_TOOLS,
    'Pinned Computer Use worker tool set changed; refuse to run with an incomplete denial list');
  const workspaceCatalog = await rpc.request('tools/catalog');
  assert.equal(workspaceCatalog.scope, 'workspace', 'Tool policy must be based on the complete workspace catalog');
  assert.equal(workspaceCatalog.truncated, false, 'Workspace tool catalog must be complete before policy construction');
  assert.equal(workspaceCatalog.total, workspaceCatalog.tools.length, 'Workspace tool catalog total must match its entries');
  const workspaceToolNames = workspaceCatalog.tools.map(tool => tool.name);
  assert.ok(workspaceToolNames.every(name => typeof name === 'string' && name.length > 0),
    'Every workspace catalog entry must have a tool name');
  assert.equal(new Set(workspaceToolNames).size, workspaceToolNames.length, 'Workspace catalog tool names must be unique');
  const forbiddenWorkspaceTools = workspaceToolNames.filter(name => !ALLOWED_TOOLS.has(name));
  const forbiddenDesktopTools = desktopHostTools.filter(name => !ALLOWED_TOOLS.has(name));
  const disabledTools = [...new Set([...forbiddenWorkspaceTools, ...forbiddenDesktopTools])].sort();
  const deniedTools = [...disabledTools];
  await run.writeArtifactJson('tool-policy.json', {
    workspaceScope: workspaceCatalog.scope,
    workspaceToolNames: [...workspaceToolNames].sort(),
    disabledOrdinaryTools: [...forbiddenWorkspaceTools].sort(),
    exactDeniedTools: deniedTools,
    exactAllowedTools: [...ALLOWED_TOOLS].sort(),
    dynamicDesktopToolsMayBeVisible: true,
    executionPolicy: 'PermissionEngine checks exact denied_tools before tool execution; disabled hides ordinary workspace registry tools. An explicit PreToolUse Hook allow has separate precedence and is not overridden by this template.',
  });
  const template = await rpc.request('settings/templates/save', { name: `Owned desktop verification ${suffix}`,
    description: 'Temporary bounded diagnostics; removed by its owner',
    content: JSON.stringify({ max_tokens: 1024, max_retries: 0, max_duration_secs: 120, request_timeout_secs: 45,
      tools: { disabled: disabledTools }, denied_tools: deniedTools }) });
  run.addCleanup('delete only owned settings template', () => rpc.request('settings/templates/delete', { id: template.template.id }));
  const { thread } = await rpc.request('thread/start', { cwd: folder, settingsTemplate: template.template.id,
    metadata: { title: `Owned desktop verification ${suffix}` } });
  await run.writeArtifactJson('owned-identities.json', { threadId: thread.id, folder, templateId: template.template.id,
    workspaceToolNames: [...workspaceToolNames].sort(), disabledTools, deniedTools });
  run.addCleanup('delete only owned diagnostic thread', () => rpc.request('thread/delete', { threadId: thread.id }));
  const preTurnCatalog = await rpc.request('tools/catalog', { threadId: thread.id });
  const preTurnToolNames = preTurnCatalog.tools.map(tool => tool.name);
  await run.writeArtifactJson('pre-turn-tool-catalog.json', { catalog: preTurnCatalog, names: preTurnToolNames });
  assert.equal(preTurnCatalog.truncated, false, 'Thread tool catalog must be complete before the model turn');
  assert.equal(preTurnCatalog.total, preTurnCatalog.tools.length, 'Thread tool catalog total must match its entries');
  assert.ok(preTurnToolNames.every(name => ALLOWED_TOOLS.has(name)),
    'Before lease attachment, only the three exact smoke-test tools may be exposed');
  const terminal = await rpc.request('terminal/start', { cwd: folder, rows: 30, cols: 120 });
  assert.ok(terminal.session_id);
  run.addCleanup('close only owned fixture terminal', () => rpc.request('terminal/close', { session_id: terminal.session_id }));
  const respondToCursorQuery = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'terminal/output' && message.params?.session_id === terminal.session_id && message.params.data?.includes('\x1b[6n')) {
      void rpc.request('terminal/write', { session_id: terminal.session_id, data: '\x1b[1;1R' }).catch(() => {});
    }
  };
  rpc.socket.addEventListener('message', respondToCursorQuery);
  run.addCleanup('remove owned terminal protocol listener', async () => rpc.socket.removeEventListener('message', respondToCursorQuery));
  const captureStartupTerminal = async (stage, error = null) => {
    let snapshot = null;
    let attachError = null;
    try {
      snapshot = await rpc.request('terminal/attach', { session_id: terminal.session_id });
    } catch (captureError) {
      attachError = captureError instanceof Error ? captureError.message : String(captureError);
    }
    await run.writeArtifactJson('fixture-startup-terminal.json', {
      stage,
      error: error instanceof Error ? error.message : error,
      attachError,
      sessionId: terminal.session_id,
      transcriptTail: snapshot?.transcript?.slice(-5000) ?? null,
    });
  };
  let attached;
  try {
    attached = await rpc.request('terminal/attach', { session_id: terminal.session_id });
    if (attached.transcript.includes('\x1b[6n')) {
      await rpc.request('terminal/write', { session_id: terminal.session_id, data: '\x1b[1;1R' });
    }
  } catch (error) {
    await captureStartupTerminal('initial-terminal-attach-failed', error);
    throw error;
  }
  try {
    if (!attached.transcript.includes('> ')) {
      await rpc.waitFor(m => m.method === 'terminal/output' && m.params?.session_id === terminal.session_id
        && m.params.data?.includes('> '), 20_000, 'owned PowerShell prompt');
    }
  } catch (error) {
    await captureStartupTerminal('powershell-prompt-timeout', error);
    throw error;
  }

  const fixturePath = `${folder}\\fixture.ps1`;
  const fixturePathLiteral = psQuote(fixturePath);
  let ready;
  fixtureCleanupConfirmed = false;
  run.addCleanup('request fixture closure and verify this fixture PID exited', async () => {
    const cleanupScript = `
$fixturePath = ${fixturePathLiteral}
$folder = ${folderLiteral}
if (-not (Test-Path -LiteralPath $folder)) {
  [ordered]@{ expectedFixturePid = 0; pidWasFixture = $false; pidExited = $true; matchingProcessesRemaining = 0 } | ConvertTo-Json -Compress
  return
}
$closePath = Join-Path $folder 'close.fixture'
$readyPath = Join-Path $folder 'fixture-ready.json'
[IO.File]::WriteAllText($closePath, 'close')
$expectedFixturePid = 0
if (Test-Path -LiteralPath $readyPath) {
  try {
    $readyData = Get-Content -Raw -LiteralPath $readyPath | ConvertFrom-Json
    if ([string]$readyData.pid -match '^\\d+$') { $expectedFixturePid = [int]$readyData.pid }
  } catch { }
}
$findFixtureProcesses = {
  @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq 'powershell.exe' -and $_.CommandLine -and
    $_.CommandLine.IndexOf($fixturePath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
}
$before = & $findFixtureProcesses
$pidWasFixture = @($before | Where-Object { [int]$_.ProcessId -eq $expectedFixturePid }).Count -gt 0
if ($pidWasFixture) { Wait-Process -Id $expectedFixturePid -Timeout 8 -ErrorAction SilentlyContinue }
foreach ($process in $before) {
  if ([int]$process.ProcessId -ne $expectedFixturePid) {
    Wait-Process -Id ([int]$process.ProcessId) -Timeout 8 -ErrorAction SilentlyContinue
  }
}
$after = & $findFixtureProcesses
$pidStillFixture = $expectedFixturePid -gt 0 -and @($after | Where-Object { [int]$_.ProcessId -eq $expectedFixturePid }).Count -gt 0
if ($pidStillFixture -or @($after).Count -gt 0) { throw 'Owned fixture process did not exit after close request' }
[ordered]@{ expectedFixturePid = $expectedFixturePid; pidWasFixture = $pidWasFixture; pidExited = -not $pidStillFixture; matchingProcessesRemaining = @($after).Count } | ConvertTo-Json -Compress
`;
    const cleanupReceipt = JSON.parse(await remote(cleanupScript));
    assert.equal(cleanupReceipt.matchingProcessesRemaining, 0, 'No process may remain for the run-owned fixture path');
    if (ready) {
      assert.equal(cleanupReceipt.expectedFixturePid, ready.pid, 'Cleanup must reconcile the same fixture PID reported by ready metadata');
      assert.equal(cleanupReceipt.pidExited, true, 'The fixture PID from ready metadata must be exited');
    }
    fixtureCleanupConfirmed = true;
  });

  const command = `  powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "${fixturePath}" -OutputDirectory "${folder}" -FullViewIsolation -VisualChallenge -LifetimeSeconds 450\r`;
  await rpc.request('terminal/write', { session_id: terminal.session_id, data: command });
  try {
    for (let attempt = 0; attempt < 18; attempt++) {
      const raw = await remote(`if(Test-Path -LiteralPath (Join-Path ${folderLiteral} 'fixture-ready.json')){Get-Content -Raw -LiteralPath (Join-Path ${folderLiteral} 'fixture-ready.json')}`);
      if (raw) {
        ready = JSON.parse(raw);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    await captureStartupTerminal('fixture-ready-read-failed', error);
    throw error;
  }
  if (!ready) await captureStartupTerminal('fixture-ready-timeout', new Error('Fixture did not write ready metadata'));
  try {
    assert.ok(ready, 'Owned fixture must start and write ready metadata');
    assert.equal(ready.fullViewIsolated, true, 'Full-desktop fixture must cover private background windows');
    assert.ok(Number.isSafeInteger(ready.pid) && ready.pid > 0, 'Fixture must report its own process ID');
    assert.match(ready.challenge, /^\d{4}$/, 'Fixture must provide its independently generated visual challenge');
    const pidProbe = JSON.parse(await remote(`$fixturePath=${fixturePathLiteral};$process=Get-CimInstance Win32_Process -Filter 'ProcessId = ${ready.pid}';[ordered]@{matches=[bool]($process -and $process.Name -ieq 'powershell.exe' -and $process.CommandLine -and $process.CommandLine.IndexOf($fixturePath,[StringComparison]::OrdinalIgnoreCase) -ge 0)}|ConvertTo-Json -Compress`));
    assert.equal(pidProbe.matches, true, 'Ready PID must identify the actual owned PowerShell fixture process');
  } catch (error) {
    if (ready) await captureStartupTerminal('fixture-ready-validation-failed', error);
    throw error;
  }
  await run.writeArtifactJson('fixture-identity.json', { pid: ready.pid, fullViewIsolated: ready.fullViewIsolated });

  async function turn(text, label) {
    const offset = rpc.messages().length;
    const { turn: activeTurn } = await rpc.request('turn/start', { threadId: thread.id,
      input: [{ type: 'text', text }],
      computerUse: { approved: true, target: 'local_windows_desktop' } });
    assert.ok(typeof activeTurn?.id === 'string' && activeTurn.id.length > 0, 'Turn start must return an owned turn identity');
    const calls = [];
    let violation;
    let resolveViolation;
    const violationSignal = new Promise(resolve => { resolveViolation = resolve; });
    const requestInterrupt = () => {
      void rpc.request('turn/interrupt', { threadId: thread.id, turnId: activeTurn.id }).catch(() => {});
    };
    const inspect = message => {
      if (message?.method !== 'item/started' || message.params?.threadId !== thread.id || message.params?.turnId !== activeTurn.id
        || message.params?.item?.type !== 'toolCall') return;
      const item = message.params.item;
      calls.push(item);
      if (!ALLOWED_TOOLS.has(item.name)) violation ??= new Error(`Forbidden tool call in desktop smoke test: ${String(item.name)}`);
      if (calls.length > MAX_TOOL_CALLS) violation ??= new Error('Diagnostic tool budget exceeded');
      if (item.name === `${TOOL_PREFIX}Screenshot`
        && (item.inputTruncated === true || !item.input || typeof item.input !== 'object'
          || (calls.length === 1 && item.input.region != null))) {
        violation ??= new Error('Screenshot must be a complete full-view observation with no region');
      }
      if (violation) {
        resolveViolation(violation);
        requestInterrupt();
      }
    };
    const onMessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      inspect(message);
    };
    for (const message of rpc.messages().slice(offset)) inspect(message);
    rpc.socket.addEventListener('message', onMessage);
    try {
      const completion = rpc.waitFor(m => isTurnCompletion(m, thread.id, activeTurn.id), 150_000, label);
      const completed = await Promise.race([completion, violationSignal.then(error => { throw error; })]);
      const events = rpc.messages().slice(offset).filter(m => m.params?.threadId === thread.id && m.params?.turnId === activeTurn.id);
      await run.writeArtifactJson(`${label}-events.json`, { completed, events });
      console.log(label, 'status', completed.params?.turn?.status ?? completed.params?.status);
      console.log(label, 'items', JSON.stringify(events.filter(m => m.method === 'item/completed').map(m => ({
        type: m.params.item?.type, name: m.params.item?.name, status: m.params.item?.status,
      }))));
      return { completed, events, calls };
    } catch (error) {
      requestInterrupt();
      await rpc.waitFor(m => isTurnCompletion(m, thread.id, activeTurn.id), 20_000, 'interrupted diagnostic turn cleanup').catch(() => {});
      const events = rpc.messages().slice(offset).filter(m => m.params?.threadId === thread.id && m.params?.turnId === activeTurn.id);
      await run.writeArtifactJson(`${label}-failed-events.json`, { error: String(error), events, calls });
      throw error;
    } finally {
      rpc.socket.removeEventListener('message', onMessage);
    }
  }

  const marker = unicodeCase ? `桌面验证_${suffix}_✓` : `KCODER_GUI_${suffix}`;
  const expectedInput = `${marker} ${ready.challenge}`;
  const result = await turn(`This is an authorized, bounded Computer Use smoke test on Windows. Only interact with the temporary window titled "KCoder isolated input fixture". Never use shell, file tools, Snapshot, alternate automation, browser, or other applications. First take a full-view Screenshot without region. Read the four-digit visual challenge painted in the window. Locate the large textbox and Verify test input button visually from the screenshot; use their observed loc coordinates for Type and Click. The fixture is a fullscreen borderless test window; do not query or interact with background windows. Using only the actual Computer Use Type and Click tools, replace the input with ${marker}, a space, and the visual challenge you saw; set clear=true and click "Verify test input" once. Then observe the visible confirmation label "Verification saved. Click count: 1" and return one short sentence. Do not retry any input after an unknown outcome or worker failure. Do not close the window. Maximum ${MAX_TOOL_CALLS} tool calls.`, 'desktop-input');

  const calls = result.calls;
  const events = result.events;
  const status = result.completed.params?.turn?.status ?? result.completed.params?.status;
  const completionById = new Map(events.filter(m => m.method === 'item/completed' && m.params?.item?.type === 'toolCall')
    .map(m => [m.params.item.id, m.params.item]));
  const states = events.filter(m => m.method === 'computerUse/stateChanged').map(m => m.params);
  await run.writeArtifactJson('desktop-lifecycle.json', { turnStatus: status, states });
  await run.writeArtifactJson('desktop-call-observation.json', {
    turnStatus: status,
    turnError: result.completed.params?.error?.message ?? null,
    calls: calls.map(item => {
      const receipt = completionById.get(item.id);
      return {
        id: item.id,
        name: item.name,
        input: item.input,
        inputTruncated: item.inputTruncated,
        receipt: receipt ? {
          status: receipt.status,
          output: typeof receipt.output === 'string' ? receipt.output.slice(0, 1024) : null,
          outputImagesCount: Array.isArray(receipt.outputImages) ? receipt.outputImages.length : 0,
        } : null,
      };
    }),
  });

  let raw = null;
  let inputCaptureError = null;
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      raw = await remote(`if(Test-Path -LiteralPath (Join-Path ${folderLiteral} 'input-result.json')){[Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path ${folderLiteral} 'input-result.json')))}`);
      if (raw) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } catch (error) {
    inputCaptureError = error instanceof Error ? error.message : String(error);
  }
  await run.writeArtifactJson('actual-input-result-raw.json', { rawBase64: raw, captured: Boolean(raw), expected: expectedInput,
    captureError: inputCaptureError });
  let observed = null;
  let inputParseError = null;
  if (raw) {
    try {
      observed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch (error) {
      inputParseError = error instanceof Error ? error.message : String(error);
    }
  }
  await run.writeArtifactJson('actual-input-result.json', { observed, expected: expectedInput,
    parseError: inputParseError, captureError: inputCaptureError, rawArtifact: 'actual-input-result-raw.json' });

  let terminalAfterTurn = null;
  let terminalCaptureError = null;
  try {
    terminalAfterTurn = await rpc.request('terminal/attach', { session_id: terminal.session_id });
  } catch (error) {
    terminalCaptureError = error instanceof Error ? error.message : String(error);
  }
  await run.writeArtifactJson('fixture-terminal-after-turn.json', {
    sessionId: terminal.session_id,
    transcriptTail: terminalAfterTurn?.transcript?.slice(-5000) ?? null,
    captureError: terminalCaptureError,
  });

  let catalog = null;
  let catalogCaptureError = null;
  try {
    catalog = await rpc.request('tools/catalog', { threadId: thread.id });
  } catch (error) {
    catalogCaptureError = error instanceof Error ? error.message : String(error);
  }
  const noDesktopToolsOutsideTurn = Boolean(catalog && !catalog.tools.some(tool => tool.name.startsWith(TOOL_PREFIX)));
  await run.writeArtifactJson('post-turn-tool-catalog.json', { catalog, noDesktopToolsOutsideTurn,
    captureError: catalogCaptureError });

  let authorizationNegative = { rejected: false, error: null, acceptedTurnId: null };
  try {
    const response = await rpc.request('turn/start', { threadId: thread.id,
      input: [{ type: 'text', text: 'Must be rejected before model execution.' }],
      computerUse: { approved: false, target: 'local_windows_desktop' } });
    authorizationNegative.acceptedTurnId = response?.turn?.id ?? null;
    if (authorizationNegative.acceptedTurnId) {
      await rpc.request('turn/interrupt', { threadId: thread.id, turnId: authorizationNegative.acceptedTurnId }).catch(() => {});
      try {
        await rpc.waitFor(message => isTurnCompletion(message, thread.id, authorizationNegative.acceptedTurnId),
          10_000, 'unexpectedly accepted unapproved turn cleanup');
        authorizationNegative.completionObserved = true;
      } catch (error) {
        authorizationNegative.completionError = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    authorizationNegative.rejected = true;
    authorizationNegative.error = error instanceof Error ? error.message : String(error);
  }
  await run.writeArtifactJson('authorization-negative.json', { noDesktopToolsOutsideTurn,
    ...authorizationNegative });

  const typeCalls = calls.filter(item => item.name === `${TOOL_PREFIX}Type` && completionById.get(item.id)?.status === 'completed');
  const clickCalls = calls.filter(item => item.name === `${TOOL_PREFIX}Click`);
  const screenshotCalls = calls.filter(item => item.name === `${TOOL_PREFIX}Screenshot`);
  assert.equal(status, 'completed', result.completed.params?.error?.message ?? 'Native desktop turn must complete');
  assert.ok(calls.length >= 3 && calls.length <= MAX_TOOL_CALLS, 'Only a bounded set of real Computer Use calls may run');
  assert.equal(calls[0]?.name, `${TOOL_PREFIX}Screenshot`, 'First actual tool call must be full-view Screenshot');
  assert.equal(typeCalls.length, 1, 'Exactly one actual Type call is allowed');
  assert.equal(clickCalls.length, 1, 'Exactly one actual Click call is allowed');
  assert.ok(calls.indexOf(clickCalls[0]) > calls.indexOf(typeCalls[0]), 'The one real Click must follow Type');
  assert.ok(screenshotCalls.length >= 1 && screenshotCalls[0].input?.region == null,
    'The initial Screenshot must establish the full view');
  assert.equal(typeCalls[0].inputTruncated, false, 'Type arguments must remain fully observable');
  assert.equal(typeCalls[0].input?.text, expectedInput, 'Actual Type call must carry the exact challenge and marker');
  assert.equal(typeCalls[0].input?.clear, true, 'Actual Type call must replace existing field contents');

  for (const call of calls) {
    const receipt = completionById.get(call.id);
    assert.ok(receipt, `Tool ${call.name} must have an actual completion receipt`);
    if (receipt.status !== 'completed') {
      assert.equal(call.name, `${TOOL_PREFIX}Type`, 'Only Type argument corrections are accepted by this test');
      assert.match(receipt.output ?? '', /input validation failed[\s\S]*The tool was not executed/, 'Only explicit pre-execution validation errors permit a corrected call');
    }
  }
  const clickReceipt = completionById.get(clickCalls[0].id);
  assert.ok(clickReceipt && typeof clickReceipt.output === 'string', 'The actual Click result receipt must be captured');
  assert.equal(clickReceipt.status, 'completed');

  assert.equal(observed?.text, expectedInput, 'Native fixture must receive exact marker and independently generated visual challenge');
  assert.equal(observed?.clicked, true, 'Native fixture button handler must record the click');
  assert.equal(observed?.clickCount, 1, 'Exactly one real button click is required');
  assert.equal(inputCaptureError, null, 'Fixture input result must be readable from the owned remote folder');
  assert.equal(inputParseError, null, 'Fixture input result must parse as JSON');
  const finalState = states.at(-1);
  assert.equal(finalState?.state, 'stopped', 'Desktop worker must stop before the turn is reported complete');
  assert.equal(finalState?.target, 'local_windows_desktop');
  assert.equal(finalState?.diagnostic?.cleanup, 'confirmed', 'The host must report its actual cleanup receipt');
  assert.equal(finalState?.diagnostic?.authorization, 'revoked', 'Per-turn desktop authorization must expire at turn completion');
  assert.equal(catalogCaptureError, null, 'Post-turn tool catalog must be sampled');
  assert.ok(noDesktopToolsOutsideTurn, 'Desktop tools must not remain exposed after their turn lease ends');
  assert.equal(authorizationNegative.rejected, true, 'Unapproved desktop turn must be rejected before model execution');
  assert.match(authorizationNegative.error ?? '', /explicit desktop approval/);
  return { nativeScreenshotAndInput: true, exactToolCalls: calls.length, markerAndVisualChallengeVerified: true,
    exactButtonClickCount: observed.clickCount, target: '4792', windowsSession: preflight.windowsSessionId,
    unicodeAndReplacement: unicodeCase, noDesktopToolsOutsideTurn: true, unapprovedTurnRejected: true, clickReceipt: 'completed' };
});
