import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunContext, repoRoot } from './run-context.mjs';

const archiveName = 'powershell-7.4.6-linux-x64.tar.gz';
const releaseUrl = 'https://github.com/PowerShell/PowerShell/releases/tag/v7.4.6';
const assetRoot = 'https://github.com/PowerShell/PowerShell/releases/download/v7.4.6';
const archiveSha256 = '6f6015203c47806c5cc444c19d8ed019695e610fbd948154264bf9ca8e157561';
const hashesSha256 = 'a0589775f0911f061946b00e7c0a6c386f4d1f30aabb1aad2d3cda49d21f9d95';
const sourceRelative = 'apps/kcoder-studio/e2e/harness/windows-project-terminal-probe.ps1';
const sourcePath = join(repoRoot, sourceRelative);
const outputPath = join(repoRoot, 'target/high-risk-review-20261112-01a1cd6d/powershell_verification-results.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The archive is checksum-verified before extraction. Reject links and special
// members, cap expanded bytes, and create only fresh regular files/directories.
const extractor = String.raw`
import json, os, pathlib, sys, tarfile
archive, target = sys.argv[1:]
root = pathlib.Path(target)
assert root.is_dir() and not root.is_symlink() and not list(root.iterdir())
entries = []; seen = set(); total = 0
with tarfile.open(archive, 'r:gz') as tar:
    for member in tar:
        assert len(entries) < 10000, 'archive entry count limit'
        name = member.name
        while name.startswith('./'): name = name[2:]
        if name in ('', '.'):
            assert member.isdir(), 'invalid archive root'
            continue
        parts = name.rstrip('/').split('/')
        assert not name.startswith('/') and '\\' not in name and all(p not in ('', '.', '..') for p in parts), 'unsafe archive path'
        normalized = '/'.join(parts)
        assert normalized not in seen, 'duplicate archive path'
        seen.add(normalized)
        assert member.isdir() or member.isfile(), 'links and special archive entries are forbidden'
        assert member.size >= 0 and member.size <= 150 * 1024 * 1024, 'archive member size limit'
        total += member.size
        assert total <= 500 * 1024 * 1024, 'expanded archive size limit'
        entries.append((member, parts))
    for member, parts in entries:
        destination = root.joinpath(*parts)
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        assert all(not p.is_symlink() for p in [destination.parent, *destination.parents] if p != root.parent), 'symlink extraction parent'
        if member.isdir():
            destination.mkdir(mode=0o700, exist_ok=True)
            continue
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        with os.fdopen(os.open(destination, flags, 0o600), 'wb') as output, tar.extractfile(member) as source:
            remaining = member.size
            while remaining:
                block = source.read(min(1024 * 1024, remaining))
                assert block, 'truncated archive member'
                output.write(block); remaining -= len(block)
            assert not source.read(1), 'archive member exceeded declared size'
        os.chmod(destination, 0o700 if parts == ['pwsh'] else 0o600)
print(json.dumps({'entries': len(entries), 'expandedBytes': total, 'linksAllowed': False, 'specialFilesAllowed': False}))
`;

async function run(context, label, command, args, { timeoutMs = 30_000, env } = {}) {
  const child = context.spawnOwned(label, command, args, { cwd: context.stateDir, env });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      void context.stopOwned(label).then(() => settle(new Error(`Owned ${label} deadline`)), settle);
    }, timeoutMs);
    child.stdout.on('data', bytes => {
      stdout += bytes;
      if (stdout.length > 1024 * 1024) void context.stopOwned(label).then(() => settle(new Error(`Owned ${label} output limit`)), settle);
    });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
    child.once('error', error => settle(error));
    child.once('close', (code, signal) => settle(code === 0 ? null : new Error(`Owned ${label} failed: ${code ?? signal}; ${context.redactText(stderr)}`), { stdout, code }));
  });
}

async function download(context, label, name, limit) {
  const destination = context.pathInState(name);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const overrides = {};
  if (proxy) {
    const parsed = new URL(proxy);
    assert.ok(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password,
      'Only an ambient proxy without credentials may be used for the public download');
    overrides.HTTPS_PROXY = proxy;
  }
  const result = await run(context, label, 'curl', ['-q', '--proto', '=https', '--proto-redir', '=https',
    '--tlsv1.2', '--location', '--max-redirs', '5', '--connect-timeout', '10', '--max-time', '120',
    '--max-filesize', String(limit), '--fail', '--silent', '--show-error', '--output', destination,
    '--write-out', '%{http_code} %{size_download}', `${assetRoot}/${name}`], {
    timeoutMs: 125_000, env: context.isolatedEnvironment(overrides),
  });
  const bytes = await readFile(destination);
  assert.ok(bytes.length <= limit, 'Downloaded asset exceeded its limit');
  assert.match(result.stdout.trim(), /^200 \d+$/);
  return { destination, bytes, sha256: sha256(bytes) };
}

async function main() {
  assert.equal(process.env.KCODER_E2E_PWSH_VERIFY, '1', 'Explicit official-runtime download opt-in required');
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  const context = await RunContext.create(import.meta.url, {
    testId: 'high-risk-b-owned-powershell-7-parser-staging', tier: 'harness-unit', retainSuccessLogs: true,
    modelPolicy: 'Official checksum-pinned Linux PS7 parser and owned filesystem/managed mock only; no Windows, user32, SSH, systemd, accounts or personal profiles.',
  });
  const result = {
    schemaVersion: 1, runId: context.runRoot, reviewedHead: context.gitCommit, startedUtc: new Date().toISOString(),
    status: 'unmet', results: [], validation: {}, cleanup: {},
    tool: { version: '7.4.6', releaseUrl, archiveUrl: `${assetRoot}/${archiveName}`, expectedArchiveSha256: archiveSha256,
      checksumsUrl: `${assetRoot}/hashes.sha256`, expectedChecksumsSha256: hashesSha256, systemInstallation: false, sharedPathModified: false },
  };
  let failure;
  try {
    const sourceSha256 = sha256(await readFile(sourcePath));
    result.results.push({ id: '62caef1e814e6bd9', path: sourceRelative, sourceSha256, decision: 'partially_fixed',
      fixStatus: 'verification_unmet', actualWindowsAcceptance: false, windowsPowerShell51: 'not executed' });
    result.validation.checkerIdentities = Object.fromEntries(await Promise.all([
      import.meta.url, new URL('./high-risk-b-powershell-staging.verify.ps1', import.meta.url),
    ].map(async url => [fileURLToPath(url), sha256(await readFile(fileURLToPath(url)))])));
    const checksums = await download(context, 'official-powershell-checksums', 'hashes.sha256', 64 * 1024);
    assert.equal(checksums.sha256, hashesSha256, 'Official checksums file disagrees with the release page');
    const rows = checksums.bytes.toString('utf8').split(/\r?\n/).filter(line => line.includes(archiveName));
    assert.equal(rows.length, 1, 'Official archive checksum must be unique');
    assert.equal(rows[0].match(/[a-fA-F0-9]{64}/)?.[0].toLowerCase(), archiveSha256);
    const archive = await download(context, 'official-powershell-archive', archiveName, 100 * 1024 * 1024);
    assert.equal(archive.sha256, archiveSha256, 'Official archive checksum mismatch');
    Object.assign(result.tool, { archiveSha256: archive.sha256, archiveBytes: archive.bytes.length,
      checksumsSha256: checksums.sha256, officialChecksumRow: rows[0] });
    const runtime = context.pathInState('powershell-runtime');
    await mkdir(runtime, { mode: 0o700 });
    const extraction = await run(context, 'extract-checksum-pinned-powershell', 'python3', ['-c', extractor, archive.destination, runtime]);
    result.tool.extraction = JSON.parse(extraction.stdout);
    const home = context.pathInState('home');
    const temporary = context.pathInState('temp');
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(temporary, { mode: 0o700 })]);
    const env = context.isolatedEnvironment({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: temporary, TEMP: temporary, TMP: temporary,
      PSModulePath: join(runtime, 'Modules'), POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off',
      DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_CLI_HOME: home });
    const pwsh = join(runtime, 'pwsh');
    await chmod(pwsh, 0o700);
    result.tool.versionOutput = (await run(context, 'owned-powershell-version', pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { env })).stdout.trim();
    assert.equal(result.tool.versionOutput, '7.4.6');
    const checker = fileURLToPath(new URL('./high-risk-b-powershell-staging.verify.ps1', import.meta.url));
    const staging = await run(context, 'project-terminal-parser-staging', pwsh,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', checker, '-SourcePath', sourcePath, '-ExpectedSha256', sourceSha256,
        '-OwnedRoot', context.pathInState('staging-fixtures')], { env });
    const verification = JSON.parse(staging.stdout.trim());
    assert.equal(verification.sourceSha256, sourceSha256);
    assert.deepEqual(verification.parserErrors, []);
    assert.equal(verification.sourceStagingCases.length, 7);
    assert.ok(verification.sourceStagingCases.every(row => row.passed));
    assert.equal(verification.embeddedNodeProbeExecuted, false);
    const existing = await run(context, 'existing-powershell-pure-fixtures', process.execPath,
      ['--test', fileURLToPath(new URL('./windows-owned-input.test.mjs', import.meta.url)),
        fileURLToPath(new URL('./windows-input-recovery-cleanup.test.mjs', import.meta.url))],
      { env: { ...env, KCODER_E2E_PWSH_BIN: pwsh }, timeoutMs: 120_000 });
    assert.match(existing.stdout, /# fail 0\b/);
    assert.match(existing.stdout, /# skipped 0\b/);
    result.validation.existingPureTests = { command: 'node --test windows-owned-input.test.mjs windows-input-recovery-cleanup.test.mjs',
      summary: existing.stdout.split('\n').filter(line => /^# (tests|pass|fail|skipped) /.test(line)),
      runRoots: existing.stdout.split('\n').filter(line => line.startsWith(`# ${repoRoot}/target/e2e/`)).map(line => line.slice(2)),
      boundary: 'Managed recovery ports with zero user32 calls; owned filesystem cleanup only. No native Windows acceptance.' };
    assert.equal(sha256(await readFile(sourcePath)), sourceSha256, 'Reviewed source changed during verification');
    Object.assign(result.results[0], {
      fixStatus: 'implemented_linux_ps7_parser_and_owned_staging_passed_actual_windows_required',
      rationale: '当前源通过 Linux PowerShell 7.4.6 ParseFile 与7个真实源AST文件系统staging正负夹具；完整Windows packaged terminal、WinPS5.1及DPAPI/ConPTY尚未验证，不能据此标平台通过。',
      parserAndMock: verification, toolVersion: result.tool.versionOutput, archiveSha256: archive.sha256,
      actualWindowsAcceptance: false, windowsPowerShell51: 'not executed' });
    await context.writeArtifactJson('powershell-source-verification.json', result);
    result.status = 'passed_with_actual_windows_limit';
  } catch (error) {
    failure = error;
    result.status = 'unmet';
    result.failure = context.redactText(error.message);
  }
  try { await context.finish(failure ? 'failed' : 'passed', result, failure); }
  catch (error) {
    if (error !== failure) {
      result.status = 'cleanup_unconfirmed';
      result.cleanup.failure = context.redactText(error.message);
    }
    failure ??= error;
  }
  result.cleanup.stateDirectoryRemoved = !existsSync(context.stateDir);
  const manifest = JSON.parse(await readFile(join(context.runRoot, 'manifest.json'), 'utf8'));
  result.cleanup.manifestStatus = manifest.status;
  result.cleanup.steps = manifest.cleanupSteps;
  result.cleanup.processes = manifest.processes;
  const finalization = JSON.parse(await readFile(join(context.artifactsDir, 'result.json'), 'utf8'));
  result.cleanup.errors = finalization.cleanupErrors;
  result.cleanup.nestedRuns = await Promise.all((result.validation.existingPureTests?.runRoots ?? []).map(async root => {
    const nestedManifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    return { runRoot: root, stateDirectoryRemoved: !existsSync(join(root, 'state')), manifestStatus: nestedManifest.status,
      steps: nestedManifest.cleanupSteps, processes: nestedManifest.processes };
  }));
  result.endedUtc = new Date().toISOString();
  if (!result.cleanup.stateDirectoryRemoved || result.cleanup.errors.length ||
      result.cleanup.processes.some(row => !row.stopped) ||
      result.cleanup.nestedRuns.some(row => !row.stateDirectoryRemoved || row.manifestStatus !== 'passed' || row.processes.some(process => !process.stopped))) {
    result.status = 'cleanup_unconfirmed';
    failure ??= new Error('Owned runtime or fixture cleanup did not complete');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryReport = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryReport, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporaryReport, outputPath);
  console.log(JSON.stringify({ status: result.status, report: outputPath, runRoot: context.runRoot, sourceSha256: result.results[0]?.sourceSha256,
    cleaned: result.cleanup.stateDirectoryRemoved }));
  if (failure) throw failure;
}

await main();
