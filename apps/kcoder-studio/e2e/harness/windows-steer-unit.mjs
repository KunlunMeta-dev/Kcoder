// Manual, model-independent Windows regression of the current renderer source.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runE2E, repoRoot } from './run-context.mjs';
import { assertRendererBuildFresh } from './renderer-build.mjs';

const target = process.env.KCODER_E2E_WINDOWS_SSH_TARGET;
const control = process.env.KCODER_E2E_WINDOWS_SSH_CONTROL_PATH;
assert.match(target ?? '', /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/);
assert.ok(control);
const appProbe = process.argv.includes('--app');
if (appProbe) await assertRendererBuildFresh();
await runE2E(import.meta.url, { testId: appProbe ? 'windows-steer-app-chain' : 'windows-steer-startup-unit', tier: 'manual-live', modelPolicy: appProbe ? 'deterministic protocol/UI; no model quality claim' : 'no model; unit-only, not installed UI validation' }, async context => {
  let sequence = 0;
  const execute = (command, args, timeout = 120000) => new Promise((accept, reject) => {
    const label = `windows-unit-${++sequence}`;
    const child = context.spawnOwned(label, command, args);
    let output = '';
    const timer = setTimeout(() => { void context.stopOwned(label); reject(Error(`${label} timeout`)); }, timeout);
    child.stdout.on('data', data => { output += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? accept(output) : reject(Error(`${label} exited ${code}: ${output}`)); });
  });
  const psArgs = script => ['-o', 'BatchMode=yes', '-S', control, target, 'powershell', '-NoProfile', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64')];
  const ps = script => execute('ssh', psArgs(script));
  const name = appProbe ? `ku-${randomUUID().slice(0, 8)}` : `kcoder-steer-unit-${randomUUID()}`;
  const directory = (await ps(`$p=Join-Path ([IO.Path]::GetTempPath()) '${name}';[IO.Directory]::CreateDirectory($p)|Out-Null;Write-Output $p`)).trim();
  assert.ok(directory.endsWith(name) && !directory.includes("'"));
  context.addCleanup('remove isolated Windows unit directory', async () => {
    await promisify(execFile)('ssh', psArgs(`[IO.Directory]::Delete('${directory}',$true);if(Test-Path -LiteralPath '${directory}'){throw 'cleanup failed'}`), { timeout: 20000 });
  });
  if (appProbe) {
    const binary = process.env.KCODER_E2E_WINDOWS_BINARY;
    const installation = process.env.KCODER_E2E_WINDOWS_STUDIO_DIRECTORY;
    assert.ok(binary && installation && !installation.includes("'"));
    const remote = directory.replaceAll('\\', '/');
    const copy = (local, name) => execute('scp', ['-o', 'BatchMode=yes', '-o', `ControlPath=${control}`, local, `${target}:${remote}/${name}`]);
    const stripped = context.pathInState('kcoder.exe');
    await execute('x86_64-w64-mingw32-strip', ['-o', stripped, resolve(binary)]);
    await copy(stripped, 'kcoder.exe');
    const sha256 = createHash('sha256').update(await readFile(stripped)).digest('hex');
    assert.equal((await ps(`(Get-FileHash -Algorithm SHA256 -LiteralPath '${directory}/kcoder.exe').Hash`)).trim().toLowerCase(), sha256);
    const archive = context.pathInState('overlay.tar.gz');
    await execute('tar', ['-czf', archive, '-C', resolve(repoRoot, 'apps/kcoder-studio'), 'renderer/dist', 'dev-server.mjs', 'src']);
    await copy(archive, 'overlay.tar.gz');
    await copy(resolve(repoRoot, 'apps/kcoder-studio/e2e/harness/windows-studio-ui-probe.cjs'), 'probe.cjs');
    await ps(`[IO.Directory]::CreateDirectory('${directory}/overlay')|Out-Null;& tar -xf '${directory}/overlay.tar.gz' -C '${directory}/overlay';if($LASTEXITCODE -ne 0){throw 'extract failed'}`);
    const raw = await execute('ssh', psArgs(`& node '${directory}/probe.cjs' '${directory}/kcoder.exe' '${installation}' '${directory}/overlay' '${directory}' --steer;exit 0`), 210000);
    const result = JSON.parse(raw.trim());
    await context.writeArtifactJson('windows-app-steer.json', { ...result, sha256 });
    for (const name of ['windows-steer-queued.png', 'windows-steer-applied.png', 'windows-failure.png', 'windows-history-dom.json']) {
      if ((await ps(`Test-Path -LiteralPath '${directory}/${name}'`)).trim() === 'True')
        await execute('scp', ['-o', 'BatchMode=yes', '-o', `ControlPath=${control}`, `${target}:${remote}/${name}`, context.pathInArtifacts(name)]);
    }
    assert.equal(result.cleaned, true);
    assert.equal(result.result?.passed, true, JSON.stringify(result.result));
    return result.result;
  }
  const files = [
    'src/components/layout/subagentSteerState.ts',
    'src/components/layout/subagentSteerState.test.ts',
    'src/e2e/studio-app-fixture.test.ts',
    'e2e/fixtures/studio-app.ts',
  ];
  const checksums = {};
  for (const file of files) {
    const local = resolve(repoRoot, 'apps/kcoder-studio/renderer', file);
    const remote = `${directory.replaceAll('\\', '/')}/${file}`;
    await ps(`[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName('${remote}'))|Out-Null`);
    await execute('scp', ['-o', 'BatchMode=yes', '-o', `ControlPath=${control}`, local, `${target}:${remote}`]);
    checksums[file] = createHash('sha256').update(await readFile(local)).digest('hex');
    assert.equal((await ps(`(Get-FileHash -Algorithm SHA256 -LiteralPath '${remote}').Hash`)).trim().toLowerCase(), checksums[file]);
  }
  // Bound each remote process and kill only its own process tree on timeout.
  const bounded = (args, seconds) => ps(`$p=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList '${args}' -WorkingDirectory '${directory}' -PassThru -NoNewWindow;$null=$p.Handle;if(-not $p.WaitForExit(${seconds * 1000})){& taskkill /PID $p.Id /T /F|Out-Null;throw 'owned node process timeout'};$p.WaitForExit();if($p.ExitCode -ne 0){throw ('node exited '+$p.ExitCode)}`);
  const npmPath = (await ps(`Join-Path (Split-Path (Get-Command node.exe).Source) 'node_modules/npm/bin/npm-cli.js'`)).trim();
  assert.ok(!npmPath.includes("'"));
  await bounded(`"${npmPath}" install --prefix "${directory}" --no-save --package-lock=false --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=30000 vitest@4.1.10`, 75);
  const output = await bounded('node_modules/vitest/vitest.mjs run src/components/layout/subagentSteerState.test.ts src/e2e/studio-app-fixture.test.ts --reporter=json --outputFile=result.json', 30);
  const result = JSON.parse(await ps(`Get-Content -Raw -LiteralPath '${directory}/result.json'`));
  await context.writeArtifactJson('windows-unit-result.json', { result, checksums, output, platform: 'win32', scope: '8 source-level tests; no installed UI or Rust gate validation' });
  assert.equal(result.success, true);
  assert.equal(result.numPassedTests, 8);
  return { passed: 8, scope: 'Windows native renderer unit regression only' };
});
