import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRoot, repoRoot, requireExecutable, runIntegration, waitFor } from '../e2e/harness/run-context.mjs';
import { hashHistoryFile } from '../e2e/harness/migration-large-history.mjs';
import { pauseStorageVerifier, startStorageCliProbe } from '../e2e/harness/desktop-storage-operation.mjs';
import { loadStorageNative, acquireStorageInstance } from '../src/storage-lease.mjs';
import { loadStorageContext } from '../src/storage-paths.mjs';

const ENTRY = '--internal-storage-operation-v1';
const PARENT_ACTOR = resolve(appRoot, 'integration/storage-handoff-parent-actor.mjs');
const SUITE_SOURCE = fileURLToPath(import.meta.url);
const crossVolume = process.env.KCODER_E2E_STORAGE_CROSS_VOLUME === '1';
process.umask(0o077);
await runIntegration(import.meta.url, {
  testId: 'storage-handoff-native-stop-verifier-boundaries', tier: 'manual-live',
  variantId: crossVolume ? 'linux-cross-filesystem' : 'default',
  modelPolicy: 'model-independent actual Linux storage CLI and Native kernel fences; no Electron, provider or model turns',
  retainSuccessLogs: true,
}, async context => {
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: actual Linux /proc and owned process signals required');
  const cli = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'frozen Root Native CLI');
  assert.ok(process.env.KCODER_E2E_KCODER_BIN_SHA256, 'UNMET_PREREQUISITE: explicit frozen CLI SHA required');
  const cliSha256 = await hashHistoryFile(cli);
  assert.equal(cliSha256, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const addon = resolve(repoRoot, process.env.KCODER_TARGET_DIR || process.env.CARGO_TARGET_DIR || 'target', 'debug/libkcoder_native_storage.so');
  const addonSha256 = await hashHistoryFile(addon);
  if (process.env.KCODER_E2E_STORAGE_ADDON_SHA256) assert.equal(addonSha256, process.env.KCODER_E2E_STORAGE_ADDON_SHA256);
  const sourcePins = await Promise.all([SUITE_SOURCE, PARENT_ACTOR,
    resolve(appRoot, 'e2e/harness/desktop-storage-operation.mjs'),
    resolve(appRoot, 'src/storage-lease.mjs'), resolve(appRoot, 'src/storage-paths.mjs'),
    resolve(appRoot, 'src/storage-runtime-resources.mjs'), resolve(appRoot, 'src/storage-operation-client.mjs'),
    resolve(repoRoot, 'crates/kcoder_cli/src/startup/storage_operation.rs'),
    resolve(repoRoot, 'crates/kcoder_cli/src/startup/storage_handoff_parent.rs')]
    .map(async path => ({ path: path.replace(`${repoRoot}/`, ''), sha256: await hashHistoryFile(path) })));
  const sourcePinMap = Object.fromEntries(sourcePins.map(pin => [pin.path, pin.sha256]));
  await context.writeArtifactJson('native-runtime-identities.json', { cli, cliSha256, addon, addonSha256, sourcePins });
  const scratch = crossVolume ? await context.createOwnedScratchDirectory('storage-native-cross-filesystem', {
    baseDirectory: '/dev/shm', expectedFilesystemType: 0x1021994n,
    requiredBytes: 32n * 1024n * 1024n, reserveBytes: 8n * 1024n * 1024n,
  }) : null;
  const filesystems = [];
  const native = await loadStorageNative(), results = [];
  const relaunchProbe = resolve(repoRoot, 'crates/kcoder_cli/tests/fixtures/storage-relaunch-probe.mjs');
  let sequence = 0, current;
  const start = (f, mode, { input, args = [], env = f.env, keepInput = false } = {}) => startStorageCliProbe(context, {
    label: `${f.label}-${++sequence}-${mode}`, cli, args: mode === 'app-server' ? [mode] : [ENTRY, mode, ...args],
    home: f.home, env, input, keepInput,
  });
  const readReceipt = async f => {
    try {
      const controls = join(f.home, '.config/kcoder-storage-migrations');
      assert.equal(JSON.parse(await readFile(join(controls, 'current.json'), 'utf8')), f.id);
      const value = JSON.parse(await readFile(join(controls, f.id, 'receipt.json'), 'utf8'));
      assert.equal(value.plan.operationId, f.id); return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const setup = async (label, launchIntent) => {
    const home = context.pathInState(`${label}/home`), source = context.pathInState(`${label}/source`);
    const destination = scratch ? context.pathInScratch(scratch, label) : context.pathInState(label);
    const target = join(destination, 'target'), oldCache = context.pathInState(`${label}/old-cache`);
    const cache = join(destination, 'new-cache'), id = `owned-${label}`;
    for (const path of [home, source, oldCache, cache]) await mkdir(path, { recursive: true, mode: 0o700 });
    if (scratch) {
      const sourceInfo = await stat(source, { bigint: true }), targetInfo = await stat(destination, { bigint: true });
      assert.notEqual(sourceInfo.dev, targetInfo.dev, 'UNMET_PREREQUISITE: source and target must be on different filesystems');
      filesystems.push({ label, source, target, sourceDevice: String(sourceInfo.dev), targetDevice: String(targetInfo.dev) });
    }
    await context.writeStateJson(`${label}/source/settings.json`, { providers: {}, credential_store: 'file',
      integrations: { office: { enabled: false }, connectivity: { enabled: false }, services: { enabled: false } } });
    await context.writeStateJson(`${label}/source/business-marker.json`, { originalId: id, accepted: 'preserve-original-bytes' });
    await context.writeStateJson(`${label}/home/.config/kcoder-storage.json`, { version: 1, revision: 1, dataRoot: source, cacheRoot: oldCache });
    const env = context.isolatedEnvironment({ HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'), APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
      KCODER_STORAGE_OWNER_RUNTIME_V1: JSON.stringify({ program: process.execPath, applicationRoot: appRoot, runAsNode: true }),
      KCODER_TARGET_DIR: resolve(repoRoot, process.env.KCODER_TARGET_DIR || process.env.CARGO_TARGET_DIR || 'target') });
    const proof = join(home, 'relaunch-proof.json');
    const relaunch = JSON.stringify({ program: process.execPath, args: [relaunchProbe, cli, home, id, proof, cache], cwd: home });
    const f = { label, id, home, source, target, oldCache, cache, env, proof, relaunch,
      location: join(home, '.config/kcoder-storage.json'), settings: await readFile(join(source, 'settings.json')),
      marker: await readFile(join(source, 'business-marker.json')) };
    f.originalLocation = await readFile(f.location);
    current = { fixture: f, phase: 'plan' };
    const planned = await start(f, 'plan', { input: { operationId: id, dataRoot: target, cacheRoot: cache, launchIntent } }).finish();
    assert.equal(planned.exitCode, 0, planned.stderr);
    f.plan = JSON.parse(planned.stdout); assert.equal(f.plan.operationId, id);
    assert.equal(await readReceipt(f), null);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    return f;
  };
  const inspectOwnedProcess = identity => {
    try {
      const text = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
      const observed = { pid: identity.pid, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]),
        session: Number(fields[3]), started: fields[19], uid: statSync(`/proc/${identity.pid}`).uid };
      if (observed.started !== identity.started || observed.group !== identity.group || observed.session !== identity.session ||
          observed.uid !== process.getuid() || observed.state === 'Z') return null;
      return observed;
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
  };
  const startHandoff = async (f, { mode = 'handoff', input = f.plan, env = f.env } = {}) => {
    assert.ok(mode === 'handoff' || mode === 'retry-handoff');
    const label = `${f.label}-${++sequence}-handoff-parent`;
    const directory = `${f.label}/handoff-${sequence}`;
    const configPath = context.pathInState(`${directory}/actor.json`);
    const stdoutPath = context.pathInState(`${directory}/cli.stdout`);
    const stderrPath = context.pathInState(`${directory}/cli.stderr`);
    await context.writeStateJson(`${directory}/actor.json`, {
      home: f.home, mode,
      inputText: input === null || input === undefined ? null : JSON.stringify(input), operationId: f.id,
    });
    const actor = context.spawnOwned(label, process.execPath,
      [PARENT_ACTOR, cli, configPath, stdoutPath, stderrPath], { cwd: f.home, env, stdin: 'pipe' });
    const events = [];
    let eventText = '', actorDiagnostic = '', closeResult = null;
    actor.stdout.setEncoding('utf8');
    actor.stdout.on('data', chunk => {
      eventText += chunk;
      for (;;) {
        const newline = eventText.indexOf('\n');
        if (newline < 0) break;
        const line = eventText.slice(0, newline); eventText = eventText.slice(newline + 1);
        if (line) events.push(JSON.parse(line));
      }
    });
    actor.stderr.setEncoding('utf8'); actor.stderr.on('data', chunk => { actorDiagnostic = (actorDiagnostic + chunk).slice(0, 8192); });
    actor.stdin.on('error', () => {});
    actor.once('close', (exitCode, signal) => { closeResult = { exitCode, signal }; });
    const spawned = await waitFor(() => events.find(event => event.kind === 'spawned') ??
      (closeResult ? { kind: 'actor-closed-before-spawn', ...closeResult } : null),
    10000, 'owned Native lease parent starts the actual handoff CLI', 5, context.abortSignal);
    assert.equal(spawned.kind, 'spawned', actorDiagnostic || 'handoff parent actor exited before spawning CLI');
    assert.equal(spawned.mode, mode); assert.deepEqual(spawned.cliArgs, [cli, ENTRY, mode]);
    assert.equal(spawned.actor.parent, process.pid); assert.equal(spawned.actor.group, spawned.actor.pid);
    assert.equal(spawned.actor.session, spawned.actor.pid);
    assert.equal(spawned.cli.parent, spawned.actor.pid, 'handoff CLI must have the owned Node actor as its direct OS parent');
    assert.equal(spawned.cli.group, spawned.actor.group); assert.equal(spawned.cli.session, spawned.actor.session);
    assert.equal(spawned.actor.uid, process.getuid()); assert.equal(spawned.cli.uid, process.getuid());
    const cliStatus = { exitCode: null, signalCode: null, sentSignal: null };
    const cliChild = {
      pid: spawned.cli.pid,
      isRunning: () => inspectOwnedProcess(spawned.cli) !== null,
      get exitCode() {
        const reported = events.find(event => event.kind === 'cli-closed');
        if (reported) { cliStatus.exitCode = reported.exitCode; cliStatus.signalCode = reported.signal; }
        return cliStatus.signalCode ? null : cliStatus.exitCode;
      },
      get signalCode() {
        const reported = events.find(event => event.kind === 'cli-closed');
        if (reported) { cliStatus.exitCode = reported.exitCode; cliStatus.signalCode = reported.signal; }
        return cliStatus.signalCode ?? (cliStatus.sentSignal && !inspectOwnedProcess(spawned.cli) ? cliStatus.sentSignal : null);
      },
      kill(signal) {
        assert.equal(signal, 'SIGKILL', 'this owned probe only needs the existing parent-crash SIGKILL case');
        const observed = inspectOwnedProcess(spawned.cli);
        assert.ok(observed, 'the exact original handoff CLI must still be alive before signaling');
        assert.equal(observed.started, spawned.cli.started); assert.equal(observed.group, spawned.actor.group);
        process.kill(spawned.cli.pid, signal); cliStatus.sentSignal = signal;
      },
    };
    const waitEvent = (kind, timeoutMs = 10000) => waitFor(() => events.find(event => event.kind === kind) ??
      (closeResult ? { kind: 'actor-closed', ...closeResult } : null), timeoutMs, `handoff parent actor ${kind}`, 5, context.abortSignal);
    const sendCommand = async command => {
      assert.equal(closeResult, null, 'cannot command an exited direct parent');
      actor.stdin.write(`${JSON.stringify({ command })}\n`);
    };
    return {
      child: cliChild,
      first: () => events.find(event => event.kind === 'ready')?.frame ?? null,
      waitEvent,
      actorIdentity: spawned.actor,
      isParentAlive: () => inspectOwnedProcess(spawned.actor) !== null && closeResult === null,
      async closeParentLease() { await sendCommand('closeLease'); await waitEvent('lease-closed'); },
      async exitParent() {
        await sendCommand('exit'); await waitFor(() => closeResult, 10000, 'direct OS parent exits after acknowledging shutdown', 5, context.abortSignal);
        assert.equal(closeResult.exitCode, 0, actorDiagnostic || 'owned handoff parent did not exit cleanly');
        assert.equal(inspectOwnedProcess(spawned.actor), null, 'the actual CLI parent process has exited');
      },
      async finish(timeoutMs = 15000) {
        await waitFor(() => !cliChild.isRunning(), timeoutMs, `storage CLI ${label} exits`, 10, context.abortSignal);
        assert.ok(statSync(stdoutPath).size + statSync(stderrPath).size <= 1024 * 1024,
          'storage CLI handoff exceeded its bounded protocol output');
        const stdout = await readFile(stdoutPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        const stderr = await readFile(stderrPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
        const exitCode = cliChild.exitCode;
        const signal = cliChild.signalCode;
        return { exitCode, signal, stdout, stderr, actorDiagnostic };
      },
    };
  };
  const assertNoCopy = async f => {
    await assert.rejects(stat(f.target), { code: 'ENOENT' });
    assert.deepEqual((await readdir(resolve(f.target, '..'))).filter(name => name.startsWith(`.kcoder-storage-${f.id}-`)), []);
    assert.deepEqual(await readFile(f.location), f.originalLocation);
    assert.deepEqual(await readFile(join(f.source, 'business-marker.json')), f.marker);
  };
  const assertParentLeaseReleased = f => {
    const held = [];
    try {
      for (const [root, name] of [[join(f.home, '.config'), 'kcoder-storage-instances.lock'],
        [f.source, 'kcoder-storage-writers.lock']]) {
        const lease = native.tryExclusive(root, name, false);
        assert.ok(lease !== null && lease !== undefined, `the direct parent's ${name} lock should exist and be exclusively acquirable`);
        held.push(lease);
      }
    } finally { while (held.length) native.close(held.pop()); }
  };
  const assertSourcePreserved = async f => {
    assert.deepEqual(await readFile(join(f.source, 'settings.json')), f.settings, 'migration and later writes preserve source settings bytes');
    assert.deepEqual(await readFile(join(f.source, 'business-marker.json')), f.marker, 'migration preserves source business-marker bytes');
  };
  const recordPublishedFilesystem = async f => {
    if (!crossVolume) return;
    const [sourceInfo, targetInfo] = await Promise.all([
      stat(f.source, { bigint: true }), stat(f.target, { bigint: true }),
    ]);
    const record = filesystems.find(item => item.label === f.label);
    assert.ok(record, `missing filesystem preflight for ${f.label}`);
    assert.equal(String(sourceInfo.dev), record.sourceDevice);
    assert.equal(String(targetInfo.dev), record.targetDevice, 'published target is on the preflighted destination filesystem');
    assert.notEqual(sourceInfo.dev, targetInfo.dev, 'published target must remain on a different filesystem');
    Object.assign(record, { publishedTargetDevice: String(targetInfo.dev), sourceDeviceAfter: String(sourceInfo.dev), targetInode: String(targetInfo.ino) });
    await assertSourcePreserved(f);
  };
  const assertInitialTargetSettings = async f => {
    assert.deepEqual(await readFile(join(f.target, 'settings.json')), f.settings, 'verified target starts with the exact source settings bytes');
  };
  const writeTargetSetting = async f => {
    const args = ['config', 'set', 'max_retries', '2', '--scope', 'user'];
    const written = await startStorageCliProbe(context, {
      label: `${f.label}-${++sequence}-post-migration-config-write`, cli, args, home: f.home, env: f.env,
    }).finish();
    assert.equal(written.exitCode, 0, written.stderr);
    const targetSettings = JSON.parse(await readFile(join(f.target, 'settings.json'), 'utf8'));
    assert.equal(targetSettings.max_retries, 2, 'ordinary config write lands in the migrated target');
    await assertSourcePreserved(f);
    await context.writeArtifactJson('post-migration-target-write.json', {
      operationId: f.id, args, exitCode: written.exitCode, targetSettingsPath: join(f.target, 'settings.json'),
      max_retries: targetSettings.max_retries, sourceSettingsBytesPreserved: true, sourceMarkerBytesPreserved: true,
    });
  };
  const holdWriter = f => {
    const writer = native.tryShared(f.source, 'kcoder-storage-writers.lock', false);
    assert.ok(writer); context.addCleanup(`release only ${f.id} original writer`, () => native.close(writer));
    return () => native.close(writer);
  };
  const deniedBusiness = async f => {
    const selected = await loadStorageContext({ home: f.home, consumer: 'gateway', env: {} });
    await assert.rejects(acquireStorageInstance(selected, { native }), error =>
      ['STORAGE_MIGRATION_BUSY', 'STORAGE_MIGRATION_PENDING'].includes(error.code));
  };
  const payloadIdentities = async f => Promise.all(['settings.json', 'business-marker.json'].map(async name => {
    const path = join(f.target, name), info = await stat(path, { bigint: true });
    return { name, sha256: await hashHistoryFile(path), inode: String(info.ino), modified: String(info.mtimeNs) };
  }));
  const unknownRefusesOriginal = async f => {
    const before = await readReceipt(f);
    const invalid = await start(f, 'resume', { args: [`${f.id}-unknown`] }).finish();
    assert.notEqual(invalid.exitCode, 0); assert.match(invalid.stderr, /STORAGE_OPERATION_CONFLICT/);
    assert.deepEqual(await readReceipt(f), before, 'an unknown operation must not replace or settle the original');
  };
  const initialize = f => {
    const probe = start(f, 'app-server', { keepInput: true });
    probe.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2026-07-27', clientInfo: { name: 'owned-storage-admission', version: '1' },
    } }) + '\n');
    return probe;
  };
  const finishBusiness = async (probe, label = 'ordinary business admitted after original unlock') => {
    const reply = await waitFor(() => probe.first(), 20000, label, 25, context.abortSignal);
    assert.equal(reply.id, 1); assert.equal(reply.error, undefined); assert.ok(reply.result);
    probe.child.stdin.end(); const stopped = await probe.finish(); assert.equal(stopped.exitCode, 0, stopped.stderr);
  };
  try {
    const notReady = await setup('executor-unready', 'desktop');
    current.phase = 'missing-input';
    const eof = await start(notReady, 'handoff').finish();
    assert.notEqual(eof.exitCode, 0); assert.match(eof.stderr, /STORAGE_OPERATION_INPUT_INVALID/);
    assert.equal(await readReceipt(notReady), null); await assertNoCopy(notReady);
    current.phase = 'missing-relaunch';
    const unavailable = await start(notReady, 'handoff', { input: notReady.plan }).finish();
    assert.notEqual(unavailable.exitCode, 0); assert.match(unavailable.stderr, /STORAGE_DESKTOP_RELAUNCH_REQUIRED/);
    assert.equal(await readReceipt(notReady), null); await assertNoCopy(notReady);
    results.push({ case: notReady.label, operationId: notReady.id, actualCli: true, readinessNotAnnounced: true, copyCount: 0, locatorUnchanged: true });

    const parentLease = await setup('parent-lease-closed-alive', 'desktop');
    current.phase = 'parent-lease-closed-but-process-alive';
    const parentLive = await startHandoff(parentLease, { env: { ...parentLease.env,
      KCODER_STORAGE_DESKTOP_RELAUNCH_V1: parentLease.relaunch } });
    assert.deepEqual(await waitFor(() => parentLive.first(), 10000, 'handoff ready while the owned OS parent is alive'),
      { operationId: parentLease.id, state: 'ready' });
    assert.ok(parentLive.isParentAlive());
    await parentLive.closeParentLease();
    assertParentLeaseReleased(parentLease);
    const waitingReceipt = await readReceipt(parentLease);
    assert.equal(waitingReceipt.phase, 'stopping'); assert.equal(waitingReceipt.disposition, 'active');
    await assertNoCopy(parentLease);
    assert.ok(parentLive.isParentAlive(), 'closing every parent lease must not satisfy the OS-parent-exit fence');
    await parentLive.exitParent();
    const parentLiveResult = await parentLive.finish(30000);
    assert.equal(parentLiveResult.exitCode, null, 'the runner is not the direct CLI parent and does not invent an exit status');
    assert.equal(parentLiveResult.signal, null);
    assert.doesNotMatch(parentLiveResult.stderr, /(?:STORAGE_[A-Z0-9_]+|panic|error:)/i);
    const parentComplete = await readReceipt(parentLease);
    assert.equal(parentComplete.phase, 'verified'); assert.equal(parentComplete.disposition, 'complete');
    await assertInitialTargetSettings(parentLease);
    await recordPublishedFilesystem(parentLease);
    results.push({ case: parentLease.label, operationId: parentLease.id, parentLeaseClosedWhileAlive: true,
      exclusiveInstanceAndWriterLocksAcquired: true, copyCountBeforeParentExit: 0, parentOsExitObservedBeforeCopy: true,
      originalIdCompleted: parentComplete.plan.operationId === parentLease.id });

    const waiting = await setup('stop-timeout', 'verifyOnly'), releaseWriter = holdWriter(waiting);
    current.phase = 'actual-stop-deadline';
    const blocked = await startHandoff(waiting, { env: { ...waiting.env, KCODER_STORAGE_DESKTOP_RELAUNCH_V1: waiting.relaunch } });
    assert.deepEqual(await waitFor(() => blocked.first(), 10000, 'original handoff ready with a live writer'), { operationId: waiting.id, state: 'ready' });
    await blocked.exitParent();
    let stopSamples = 0;
    await waitFor(async () => {
      const receipt = await readReceipt(waiting);
      assert.equal(receipt.phase, 'stopping');
      if (receipt.disposition === 'active') assert.equal(receipt.errorCode, undefined);
      else {
        assert.equal(receipt.disposition, 'deferred');
        assert.equal(receipt.errorCode, 'STORAGE_STOP_TIMEOUT');
      }
      await assertNoCopy(waiting); stopSamples++;
      return !blocked.child.isRunning();
    }, 65000, 'actual 60-second stop timeout without copy', 250, context.abortSignal);
    const timeout = await blocked.finish(); assert.equal(timeout.exitCode, null); assert.equal(timeout.signal, null);
    assert.match(timeout.stderr, /STORAGE_STOP_TIMEOUT/);
    await unknownRefusesOriginal(waiting); await assertNoCopy(waiting);
    const deferred = await readReceipt(waiting);
    assert.equal(deferred.plan.operationId, waiting.id);
    assert.equal(deferred.phase, 'stopping'); assert.equal(deferred.disposition, 'deferred');
    assert.equal(deferred.errorCode, 'STORAGE_STOP_TIMEOUT');
    assert.deepEqual(deferred.plan, waiting.plan, 'timeout retains the original deferred plan');
    assert.deepEqual(deferred.plan.original, JSON.parse(waiting.originalLocation), 'timeout preserves the original selection');
    assert.deepEqual(await readFile(waiting.location), waiting.originalLocation);
    await assertSourcePreserved(waiting);
    await finishBusiness(initialize(waiting), 'ordinary business remains available from the original roots after Deferred timeout');
    await assertNoCopy(waiting); await assertSourcePreserved(waiting);
    await context.writeArtifactJson('stop-timeout-original-receipt.json', deferred);
    releaseWriter(); current.phase = 'same-id-after-stop-timeout';
    const retried = await startHandoff(waiting, { mode: 'retry-handoff', input: waiting.plan,
      env: { ...waiting.env, KCODER_STORAGE_DESKTOP_RELAUNCH_V1: waiting.relaunch } });
    assert.deepEqual(await waitFor(() => retried.first(), 10000, 'same-plan retry handoff ready while its parent is alive'),
      { operationId: waiting.id, state: 'ready' });
    assert.ok(retried.isParentAlive());
    const retryReady = await readReceipt(waiting);
    assert.deepEqual(retryReady.plan, deferred.plan, 'retry-handoff retains the exact deferred plan and operation ID');
    assert.equal(retryReady.phase, 'stopping'); assert.equal(retryReady.disposition, 'active');
    assert.equal(retryReady.errorCode, undefined);
    await assertNoCopy(waiting);
    await assertSourcePreserved(waiting);
    const retryInstance = native.tryExclusive(join(waiting.home, '.config'), 'kcoder-storage-instances.lock', false);
    const retryWriter = native.tryExclusive(waiting.source, 'kcoder-storage-writers.lock', false);
    assert.equal(retryInstance, null, 'the still-live retry actor retains the instance lease');
    assert.equal(retryWriter, null, 'the still-live retry actor retains the original source writer lease');
    await retried.exitParent();
    const retriedResult = await retried.finish(30000);
    assert.equal(retriedResult.exitCode, null); assert.equal(retriedResult.signal, null);
    assert.doesNotMatch(retriedResult.stderr, /(?:STORAGE_[A-Z0-9_]+|panic|error:)/i);
    const complete = await readReceipt(waiting); assert.equal(complete.phase, 'verified'); assert.equal(complete.disposition, 'complete');
    assert.equal(complete.plan.operationId, waiting.id, 'retry completion uses the original operation ID');
    assert.deepEqual(await readFile(join(waiting.target, 'business-marker.json')), waiting.marker);
    await assertInitialTargetSettings(waiting);
    await recordPublishedFilesystem(waiting);
    await assert.rejects(stat(waiting.proof), { code: 'ENOENT' });
    await finishBusiness(initialize(waiting));
    await writeTargetSetting(waiting);
    results.push({ case: waiting.label, operationId: waiting.id, actualStopTimeout: true, copyCountBeforeStopped: 0,
      stopSamples, unknownIdRejected: true, deferredOriginalBusinessAdmitted: true, independentWriterReleasedBeforeRetry: true,
      originalIdRetryHandoffReady: true, retryReadyCopyCount: 0,
      retryParentExitedBeforeCopy: true, originalIdCompleted: true, installerVerifyOnlyDoesNotRelaunch: true,
      ordinaryBusinessAfterComplete: true, postMigrationTargetWrite: true, sourceBytesPreserved: true });

    for (const crash of [false, true]) {
      const f = await setup(crash ? 'verifier-parent-crash' : 'verifier-before-business', 'desktop');
      const release = holdWriter(f);
      current.phase = 'held-verifier';
      const operation = await startHandoff(f, { env: { ...f.env, KCODER_STORAGE_DESKTOP_RELAUNCH_V1: f.relaunch } });
      assert.deepEqual(await waitFor(() => operation.first(), 10000, 'original verifier case handoff ready'), { operationId: f.id, state: 'ready' });
      const pausedPromise = pauseStorageVerifier(context, { parent: operation.child, cli, home: f.home, operationId: f.id });
      pausedPromise.catch(() => {});
      await operation.exitParent(); release();
      const verifier = await pausedPromise;
      let receipt = await readReceipt(f); assert.equal(receipt.phase, 'committed'); assert.equal(receipt.disposition, 'active');
      const markerPath = join(f.target, 'business-marker.json'), copiedMarker = await stat(markerPath, { bigint: true });
      await deniedBusiness(f);
      const beforeReadonly = await payloadIdentities(f);
      const readonly = await start(f, 'verify', { args: [f.id] }).finish();
      assert.equal(readonly.exitCode, 0, readonly.stderr); assert.equal(JSON.parse(readonly.stdout).dataRoot, f.target);
      assert.deepEqual(await payloadIdentities(f), beforeReadonly, 'readonly exception cannot rewrite fixture business payloads');
      assert.equal((await readReceipt(f)).phase, 'committed', 'readonly target verification cannot complete the operation itself');
      await assert.rejects(stat(f.proof), { code: 'ENOENT' });
      await context.writeArtifactJson(`${f.label}-held-verifier.json`, { verifier: verifier.identity, receipt: await readReceipt(f),
        ordinaryGatewayAdmissionRefused: true, dedicatedReadonlyVerificationEntered: true, restartNotStarted: true });
      current.phase = crash ? 'parent-only-crash' : 'complete-unlock-business';
      if (crash) {
        operation.child.kill('SIGKILL');
        await waitFor(() => operation.child.signalCode === 'SIGKILL', 5000, 'original coordinator parent exits');
        assert.ok(await verifier.current(), 'the held readonly verifier remains the originally observed child');
        receipt = await readReceipt(f); assert.equal(receipt.phase, 'committed'); assert.equal(receipt.disposition, 'active');
        await deniedBusiness(f); await unknownRefusesOriginal(f);
      } else {
        const blockedBusiness = initialize(f);
        const rejected = await blockedBusiness.finish(5000);
        assert.notEqual(rejected.exitCode, 0); assert.match(rejected.stderr, /STORAGE_MIGRATION_(BUSY|PENDING)/);
        assert.equal(blockedBusiness.first(), null, 'ordinary startup cannot acknowledge business initialization before original verification');
      }
      await verifier.resume();
      await waitFor(async () => !(await verifier.current()), 10000, 'original readonly verifier exits', 5, context.abortSignal);
      if (crash) {
        const interrupted = await operation.finish(); assert.equal(interrupted.signal, 'SIGKILL');
        receipt = await readReceipt(f); assert.equal(receipt.phase, 'committed'); assert.equal(receipt.disposition, 'active');
        const recovery = await start(f, 'resume', { args: [f.id] }).finish(30000); assert.equal(recovery.exitCode, 0, recovery.stderr);
        await assert.rejects(stat(f.proof), { code: 'ENOENT' });
      }
      await waitFor(async () => {
        const original = await readReceipt(f);
        if (original.phase === 'verified') { assert.equal(await verifier.current(), null); return original.disposition === 'complete'; }
        return false;
      }, 15000, 'original verifier exit precedes Complete', 5, context.abortSignal);
      await assertInitialTargetSettings(f);
      await recordPublishedFilesystem(f);
      await finishBusiness(initialize(f));
      const ended = await operation.finish(15000);
      if (!crash) {
        assert.equal(ended.exitCode, null, 'the direct parent has exited, so the runner cannot observe the natural CLI exit status');
        assert.equal(ended.signal, null);
        assert.doesNotMatch(ended.stderr, /(?:STORAGE_[A-Z0-9_]+|panic|error:)/i);
        const proof = await waitFor(async () => {
          try { return JSON.parse(await readFile(f.proof, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        }, 15000, 'real relaunch observes Complete after coordinator unlock');
        assert.equal(proof.operationId, f.id); assert.equal(proof.phase, 'verified');
      }
      const finalMarker = await stat(markerPath, { bigint: true });
      assert.equal(finalMarker.ino, copiedMarker.ino); assert.equal(finalMarker.mtimeNs, copiedMarker.mtimeNs);
      assert.deepEqual(await readFile(markerPath), f.marker);
      await assertSourcePreserved(f);
      results.push({ case: f.label, operationId: f.id, verifierPid: verifier.identity.pid, readonlyExceptionEntered: true,
        activeNormalAdmissionClosed: true, verifierExitedBeforeComplete: true, ordinaryBusinessAfterUnlock: true,
        parentOnlyCrash: crash, sameIdRecovery: crash, originalCopiedMarkerNotRewritten: true, relaunchAfterCompleteAndUnlock: !crash });
    }
    const afterSha256 = await hashHistoryFile(cli); assert.equal(afterSha256, cliSha256);
    const afterAddonSha256 = await hashHistoryFile(addon); assert.equal(afterAddonSha256, addonSha256);
    const afterSourcePins = await Promise.all(sourcePins.map(async pin => ({ ...pin, afterSha256: await hashHistoryFile(resolve(repoRoot, pin.path)) })));
    for (const pin of afterSourcePins) assert.equal(pin.afterSha256, sourcePinMap[pin.path], `frozen source changed during run: ${pin.path}`);
    await context.writeArtifactJson('native-handoff-boundaries.json', { cliSha256, afterSha256, addonSha256, afterAddonSha256,
      sourcePins: afterSourcePins, cases: results, externalModelCalls: 0,
      installedElectronAcceptance: false, crossPlatformAcceptance: false, crossFilesystem: crossVolume, filesystems });
    if (crossVolume) await context.writeArtifactJson('native-filesystems.json', { scratch, cases: filesystems });
    return { cases: results, externalModelCalls: 0, cliSha256, sourcePins: afterSourcePins, crossFilesystem: crossVolume, filesystems };
  } catch (error) {
    await context.writeArtifactJson('failure-stage.json', { case: current?.fixture.label, phase: current?.phase, message: error.message,
      operationId: current?.fixture.id, receipt: current ? await readReceipt(current.fixture) : null, completedCases: results, filesystems });
    throw error;
  }
});
