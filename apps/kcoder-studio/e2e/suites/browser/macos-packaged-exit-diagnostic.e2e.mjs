import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runE2E, requireExecutable, waitFor } from '../../harness/run-context.mjs';
import { waitForStdioChildClose } from '../../harness/app-server-stdio.mjs';
import { processTreeAlive } from '../../harness/owned-process.mjs';

await runE2E(import.meta.url, {
  testId: 'macos-packaged-exit-mock-keychain-diagnostic', tier: 'manual-live',
  modelPolicy: 'Native packaged lifecycle diagnostic with an empty private profile; no model request. Mock Keychain is not normal-use or distribution acceptance.',
}, async context => {
  assert.equal(process.platform, 'darwin', 'UNMET_PREREQUISITE: native macOS required');
  assert.equal(process.env.KCODER_E2E_MAC_EXIT_DIAGNOSTIC, '1', 'Explicit diagnostic opt-in required');
  const dmg = resolve(process.env.KCODER_E2E_MAC_DMG || '');
  const expected = process.env.KCODER_E2E_MAC_DMG_SHA256;
  assert.ok(process.env.KCODER_E2E_MAC_DMG && /^[a-f0-9]{64}$/.test(expected || ''), 'Select a DMG and its exact SHA256');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(dmg)) {
    context.abortSignal.throwIfAborted();
    hash.update(chunk);
  }
  assert.equal(hash.digest('hex'), expected, 'DMG identity mismatch');

  const env = context.isolatedEnvironment();
  async function command(label, binary, args, timeoutMs = 10000) {
    const child = context.spawnOwned(label, binary, args, { env });
    let output = '';
    child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-4096); });
    const exit = await waitForStdioChildClose(child, timeoutMs, label);
    assert.equal(exit.code, 0, `${label} failed; inspect its owned log`);
    return output.trim();
  }

  const mount = context.pathInState('mount');
  await mkdir(mount, { mode: 0o700 });
  // Register before attach: an interrupted mount must still have an owner.
  context.addCleanup('detach owned diagnostic DMG', async () => {
    // A disk number can be reused; only act on this run's private mount path.
    const child = context.spawnCleanupOwned('detach-dmg', '/usr/bin/hdiutil', ['detach', mount], { env });
    const exit = await waitForStdioChildClose(child, 30000, 'detach owned DMG');
    assert.equal(exit.code, 0, 'Owned DMG detach was not confirmed');
  }, { timeoutMs: 45000 });
  const attachment = await command('attach-dmg', '/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg], 30000);
  assert.ok(attachment.includes(mount), 'Attachment did not use this run\'s private mount point');
  const observedDevice = attachment.match(/^\/dev\/disk\d+(?=\s)/m)?.[0] || null;

  const apps = (await readdir(mount, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
  assert.equal(apps.length, 1, 'Select a DMG containing exactly one application bundle');
  const app = join(mount, apps[0].name);
  const executable = await command('bundle-executable', '/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]);
  assert.match(executable, /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/, 'Invalid bundle executable name');
  const binary = await requireExecutable(join(app, 'Contents/MacOS', executable), 'packaged Electron');
  const cli = await requireExecutable(join(app, 'Contents/Resources/bin/kcoder'), 'packaged CLI');
  const home = context.pathInState('home');
  const workspace = context.pathInState('workspace');
  const temporary = context.pathInState('tmp');
  for (const path of [home, workspace, temporary]) await mkdir(path, { recursive: true, mode: 0o700 });
  await context.writeStateJson('home/settings.json', { providers: {}, credential_store: 'file' });
  const servers = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Owned package diagnostic', transport: 'local', command: cli, workspace },
  ]);
  const started = performance.now();
  const child = context.spawnOwned('desktop', binary, ['--use-mock-keychain'], {
    cwd: workspace,
    env: context.isolatedEnvironment({
      HOME: home, USERPROFILE: home, TMPDIR: temporary,
      KCODER_HOME: home, KCODER_CONFIG_DIR: home,
      KCODER_STUDIO_SERVERS_FILE: servers, KCODER_STUDIO_WORKSPACE: workspace,
      KCODER_STUDIO_DESKTOP_USER_DATA_DIR: context.pathInState('desktop-profile'),
      KCODER_STUDIO_DESKTOP_SMOKE_MS: '1500',
    }),
  });
  let readyMs = null;
  let exited = null;
  let closed = null;
  let spawnError = null;
  let tail = '';
  const observe = bytes => {
    tail = (tail + bytes.toString()).slice(-4096);
    if (readyMs === null && tail.includes('KCoder Studio desktop ready:')) readyMs = performance.now() - started;
  };
  child.stdout.on('data', observe);
  child.stderr.on('data', observe);
  child.once('error', error => { spawnError = error; });
  child.once('exit', (code, signal) => { exited = { code, signal, elapsedMs: performance.now() - started }; });
  child.once('close', (code, signal) => { closed = { code, signal, elapsedMs: performance.now() - started }; });
  let failure = null;
  let sampleStatus = 'not-needed';
  try {
    await waitFor(() => {
      if (spawnError) throw spawnError;
      if (closed && readyMs === null) throw new Error('Desktop closed before ready');
      return readyMs !== null;
    }, 45000, 'owned desktop ready', 50, context.abortSignal);
    await waitFor(() => closed, 15000, 'owned desktop natural close', 50, context.abortSignal);
    assert.equal(closed.code, 0, 'Desktop diagnostic did not exit successfully');
    assert.equal(closed.signal, null, 'A signal is not a natural successful exit');
  } catch (error) {
    failure = error;
    context.abortSignal.throwIfAborted();
    const record = context.processes.get('desktop');
    const mainAlive = () => exited === null && child.exitCode === null && child.signalCode === null;
    if (mainAlive() && await processTreeAlive(child, record.identity) && mainAlive()) {
      // PGID liveness alone does not identify a still-running Electron parent.
      const identity = await command('desktop-identity', '/bin/ps', ['-p', String(child.pid), '-o', 'pid=,ppid=,pgid=,lstart=,stat=,comm=']);
      const [pid, ppid, pgid] = identity.split(/\s+/);
      if (mainAlive() && pid === String(child.pid) && ppid === String(process.pid) && pgid === String(child.pid)) {
        sampleStatus = await command('desktop-sample', '/usr/bin/sample', [String(child.pid), '1', '1']).then(() => 'captured', () => 'failed');
      } else sampleStatus = 'skipped-identity-changed';
    } else {
      sampleStatus = 'skipped-main-exited';
    }
  }
  const result = {
    diagnosticOnly: true, mockKeychain: true, normalKeychainAcceptance: false,
    dmgSha256: expected, bundle: apps[0].name, executable, observedDevice,
    pid: child.pid, readyMs, exited, closed, sampleStatus,
    mainProcessNaturalCloseSucceeded: failure === null,
    processGroupAliveAtObservation: await processTreeAlive(child, context.processes.get('desktop').identity),
    modelRequestsRequested: 0,
    scope: 'Electron main process with mock Keychain; subsequent group cleanup is separate. Does not establish ordinary Keychain access, a current-source build, GUI interactivity or Gatekeeper trust.',
  };
  await context.writeArtifactJson('desktop-exit-observation.json', result);
  if (failure) throw failure;
  return result;
});
