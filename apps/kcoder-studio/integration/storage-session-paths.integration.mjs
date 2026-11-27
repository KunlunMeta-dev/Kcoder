import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { join, dirname, win32 } from 'node:path';
import { repoRoot, appRoot, runIntegration, requireExecutable } from '../e2e/harness/run-context.mjs';
import { hashHistoryFile } from '../e2e/harness/migration-large-history.mjs';
import { waitForStdioChildClose } from '../e2e/harness/app-server-stdio.mjs';
import { readWindowsCurrentIdentity } from '../src/windows-current-identity.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--owned-electron') {
  const [electron, input] = process.argv.slice(3);
  const child = spawn(electron, ['--disable-gpu', join(appRoot, 'desktop/fixtures/storage-session-paths.mjs'), input], {
    cwd: appRoot, env: process.env, windowsHide: false, stdio: ['ignore', 'inherit', 'inherit'],
  });
  process.exitCode = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => accept(code ?? 1)); });
} else await runIntegration(import.meta.url, {
  testId: 'windows-electron-session-path-qualification', tier: 'manual-live',
  modelPolicy: 'Actual isolated Electron storage APIs at short, long and namespace paths; no product UI, Native or model.',
  retainSuccessEvidence: true, retainSuccessLogs: true,
}, async context => {
  assert.equal(process.platform, 'win32', 'UNMET_PREREQUISITE: actual Windows required');
  const fixture = dirname(repoRoot), owner = JSON.parse((await readFile(join(fixture, '.owner.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const account = await readWindowsCurrentIdentity(); assert.equal(owner.sid, account.sid);
  assert.equal(fixture.toLowerCase(), `c:\\kcoder-widget-${owner.owner}`.toLowerCase());
  const electron = await requireExecutable(process.env.KCODER_E2E_ELECTRON_BIN, 'pinned Electron');
  assert.equal(await hashHistoryFile(electron), process.env.KCODER_E2E_ELECTRON_BIN_SHA256);
  const root = await mkdtemp(join(fixture, 'session-')), identity = await lstat(root, { bigint: true });
  const cleanup = context.pathInArtifacts('session-path-cleanup.json');
  await writeFile(join(root, '.owner.json'), JSON.stringify({ owner: context.seed, sid: account.sid }), { flag: 'wx' });
  context.addCleanup('remove only this owned session probe', async () => {
    const current = await lstat(root, { bigint: true }); assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
    assert.equal(JSON.parse(await readFile(join(root, '.owner.json'), 'utf8')).owner, context.seed);
    await rm(root, { recursive: true });
    await writeFile(cleanup, JSON.stringify({ root, removed: true, originalIdentityConfirmed: true }), { flag: 'wx', mode: 0o600 });
  });
  await context.writeArtifactJson('session-path-owner.json', { root, owner: context.seed, sid: account.sid,
    dev: String(identity.dev), ino: String(identity.ino) });
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Owned storage qualification</title>'); });
  context.addCleanup('close only this probe origin', () => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept())));
  await new Promise(accept => server.listen(0, '127.0.0.1', accept)); context.registerPort('session-probe', server.address().port);
  const url = `http://127.0.0.1:${server.address().port}/`, results = [];
  for (const [id, size, namespace, quit] of [['short-exit', 0, false, 'exit'], ['budget-exit', 180, false, 'exit'], ['long-exit', 192, false, 'exit'],
    ['long-quit', 192, false, 'quit'], ['long-namespace-exit', 192, true, 'exit']]) {
    const prefix = join(root, id), profile = size ? join(prefix, 'x'.repeat(size - prefix.length - 1)) : prefix;
    await mkdir(profile, { recursive: true });
    const marker = `session-probe-${context.seed}-${id}`; context.registerSecret(marker);
    const phases = [];
    for (const phase of ['write', 'read']) {
      const result = context.pathInState(`${id}-${phase}-result.json`);
      const input = await context.writeStateJson(`${id}-${phase}-input.json`, { profile: namespace ? win32.toNamespacedPath(profile) : profile,
        url, marker, quit, phase, result });
      const child = context.spawnOwned(`${id}-${phase}`, process.execPath, [fileURLToPath(import.meta.url), '--owned-electron', electron, input], {
        cwd: appRoot, env: context.isolatedEnvironment({ HOME: account.userProfile, USERPROFILE: account.userProfile,
          APPDATA: account.appData, LOCALAPPDATA: account.localAppData, TEMP: root, TMP: root }),
      });
      assert.deepEqual(await waitForStdioChildClose(child, 30_000, `owned session ${id}/${phase}`), { code: 0, signal: null });
      phases.push(JSON.parse(await readFile(result, 'utf8')));
    }
    results.push({ id, profileLength: profile.length, phases });
  }
  await context.writeArtifactJson('session-path-results.json', results);
  for (const id of ['short-exit', 'budget-exit']) assert.ok(results.find(row => row.id === id).phases.every(row => row.localStorage && row.partitionCookieMatched),
    'Short and supported-budget paths must persist');
  return { actualWindows: true, diagnosticQualificationOnly: true, results, modelCalls: 0, productMigrationAccepted: false };
});
