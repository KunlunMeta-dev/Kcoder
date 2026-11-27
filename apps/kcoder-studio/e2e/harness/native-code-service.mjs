import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { access, chown, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
import { isolatedEnvironment } from './run-context.mjs';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { login } from './http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from './rpc.mjs';

const MANAGER_ENTRY = '--internal-native-code-service-manager-owned-v1';
const MANAGER_READY = '{"event":"native_code_service_manager_owner_ready","contractVersion":1,"ownerMode":"private_stdin_v1"}';
const MANAGER_START = 'native_code_service_manager_start_v1\n';
const observerSource = fileURLToPath(new URL('./native-code-service-pidfd.py', import.meta.url));

export async function nativeCodeFixture(context, sourceBinary, { scratch, account, channelOnly = false } = {}) {
  assert.ok(process.platform === 'linux' || channelOnly && process.platform === 'darwin',
    'UNMET_PREREQUISITE: Native Code requires Linux; channel fixtures also support macOS');
  if (account) {
    assert.equal(process.getuid(), 0, 'The original owned account fixture requires its root harness');
    assert.ok(Number.isSafeInteger(account.uid) && account.uid > 0 && Number.isSafeInteger(account.gid) && account.gid > 0);
    assert.match(account.user, /^[a-z_][a-z0-9_-]{0,31}$/);
    assert.ok(typeof account.home === 'string' && account.home.startsWith('/') && typeof account.runtimeDir === 'string' && account.runtimeDir === `/run/user/${account.uid}`);
    assert.equal(account.busAddress, `unix:path=${account.runtimeDir}/bus`);
    const [homeInfo, runtimeInfo] = await Promise.all([lstat(account.home), lstat(account.runtimeDir)]);
    for (const info of [homeInfo, runtimeInfo]) assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === account.uid);
  }
  const uid = account?.uid ?? (process.getuid() === 0 ? 65534 : process.getuid());
  const gid = account?.gid ?? (process.getuid() === 0 ? 65534 : process.getgid());
  const root = scratch ? context.pathInScratch(scratch, 'owned-account') : context.pathInCase('native-code-service', 'owned-account');
  const activeManagers = new Set();
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root);
  if (!scratch) context.registerTemporaryDirectory('native-code-owned-uid-fixture', root);
  context.addCleanup('remove stopped native-code owned UID fixture', async () => {
    assert.equal(activeManagers.size, 0, 'Retain Native fixture while any original manager cleanup is unconfirmed');
    await rm(root, { recursive: true, force: false });
    if (scratch?.requireCleanupConfirmation) await context.confirmOwnedScratchCleanup(scratch);
  });
  const ownedDirectory = async name => {
    const path = resolve(root, name);
    await mkdir(path);
    if (process.getuid() === 0) await chown(path, uid, gid);
    return path;
  };
  const profile = await ownedDirectory('profile');
  const workspace = await ownedDirectory('workspace');
  const home = account?.home ?? await ownedDirectory('home');
  const binary = resolve(root, 'kcoder');
  const source = await lstat(sourceBinary);
  assert.ok(source.isFile() && !source.isSymbolicLink(), 'Native executable input must be a regular file');
  await copyFile(sourceBinary, binary, constants.COPYFILE_FICLONE);
  await access(binary, constants.X_OK);
  if (process.getuid() === 0) await chown(binary, uid, gid);
  const imageSha256 = await sha256File(binary);
  const settings = resolve(profile, 'settings.json');
  await writeFile(settings, JSON.stringify({ active_provider: 'owned-code', max_retries: 0, permission_mode: 'ask',
    tools: { profile: 'none' },
    history_enabled: true, memory: { structured_enabled: false }, session_memory: { enabled: false },
    providers: { 'owned-code': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: 'http://127.0.0.1:1/v1', default_model: 'native-code-no-model', context_window_tokens: 128000,
      max_output_tokens: 4096, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } },
    integrations: { services: { enabled: true } },
  }));
  if (process.getuid() === 0) await chown(settings, uid, gid);
  const env = isolatedEnvironment({ HOME: home, USERPROFILE: home, KCODER_CONFIG_DIR: profile,
    USER: account?.user ?? 'kcoder-owned-e2e', LOGNAME: account?.user ?? 'kcoder-owned-e2e',
    ...(account ? {XDG_RUNTIME_DIR:account.runtimeDir,DBUS_SESSION_BUS_ADDRESS:account.busAddress} : {}) });
  return { root, uid, gid, profile, workspace, home, binary, settings, imageSha256, env, activeManagers };
}

export async function startNativeCodeUi(context, fixture, label) {
  const child = context.spawnOwned(label, fixture.binary, [
    '--internal-stdio-owner-v1', String(process.pid), fixture.binary,
    '--cwd', fixture.workspace, '--settings-file', fixture.settings, '--tool-profile', 'none', 'app-server',
  ], { uid: fixture.uid, gid: fixture.gid, cwd: fixture.workspace, env: fixture.env, stdin: 'pipe' });
  const client = new AppServerStdioClient(label, child, { defaultTimeoutMs: 60_000 });
  const rpc = async (method, params = {}) => {
    const response = await client.request(method, params);
    assert.equal(response.error, undefined, `${method}: ${response.error?.message}`);
    return response.result;
  };
  const initialized = await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'native-code-service-owned-lifetime', version: '1' },
    capabilities: { experimental: { integrationScopeV1: true, integrationTaskStateV1: true, integrationOperationReceiptsV1: true,
      nativeCodeServicesV1: true, workflowCanvasV1: true, workflowRunsV1: true, workflowGraphV2: true } } });
  assert.equal(initialized.capabilities?.experimental?.nativeCodeServicesV1, true, 'Native service capability must be explicitly negotiated under the actual nonprivileged UID');
  const scope = await rpc('integrations/scope/read');
  return { child, client, rpc, scope, close: async () => {
    child.stdin.end();
    await waitForStdioChildClose(child, 15_000, label);
    client.closeReader();
    await context.stopOwned(label);
  } };
}

/** Atomically change only this run's owned target setting, preserving its UID. */
export async function setNativeCodeFeature(fixture, enabled) {
  const settings = JSON.parse(await readFile(fixture.settings, 'utf8'));
  settings.integrations.services.enabled = enabled;
  const pending = resolve(fixture.profile, `settings-feature-${randomUUID()}.tmp`);
  await writeFile(pending, JSON.stringify(settings), { flag: 'wx' });
  if (process.getuid() === 0) await chown(pending, fixture.uid, fixture.gid);
  await rename(pending, fixture.settings);
}

/** Change only execution settings in this run's private profile, then restore exactly. */
export async function changeNativeCodeExecutionSettings(fixture) {
  const before = await readFile(fixture.settings, 'utf8');
  const settings = JSON.parse(before);
  settings.model = 'owned-code::native-code-no-model';
  settings.integrations.knowledge = { ...settings.integrations.knowledge,
    business_automation_enabled: !settings.integrations.knowledge?.business_automation_enabled };
  const replace = async value => {
    const pending = resolve(fixture.profile, `settings-execution-${randomUUID()}.tmp`);
    await writeFile(pending, value, { flag: 'wx' });
    if (process.getuid() === 0) await chown(pending, fixture.uid, fixture.gid);
    await rename(pending, fixture.settings);
  };
  await replace(JSON.stringify(settings));
  return () => replace(before);
}

export async function startNativeCodeGateway(context, fixture, label, { experimental = {}, rpcOpenTimeoutMs } = {}) {
  const serversFile = resolve(fixture.profile, 'service-observer-servers.json');
  await writeFile(serversFile, JSON.stringify([{ id: 'local', label: 'Owned native service observer',
    runtime: 'kcoder', transport: 'local', command: fixture.binary, workspace: fixture.workspace }]));
  if (process.getuid() === 0) await chown(serversFile, fixture.uid, fixture.gid);
  const gateway = await startGateway(context, { label, workspace: fixture.workspace, serversFile,
    kcoderBin: fixture.binary,
    ...(fixture.uid === process.getuid() && fixture.gid === process.getgid() ? {} : { uid: fixture.uid, gid: fixture.gid }),
    env: fixture.env, auth: true, startTimeoutMs: 60_000, redactedStderrDiagnostics: true,
    ...(fixture.gatewayRoot ? {gatewayRoot:fixture.gatewayRoot} : {}) });
  const cookie = await login(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
  const rpcUrl = new URL(gatewayRpcUrl(gateway, 'local', token));
  if (experimental.taskSourcesV1 === false && experimental.threadRuntimeHandoffV1 === false) rpcUrl.searchParams.set('nativeManagement', '1');
  const openingAt = performance.now();
  const client = await openRpc(rpcUrl.href, {
    headers: { Cookie: cookie, Origin: gateway.baseUrl }, timeoutMs: rpcOpenTimeoutMs,
  });
  context.addCleanup(`close original native service Gateway observer ${label}`, () => closeRpcAndWait(client));
  if (rpcOpenTimeoutMs !== undefined) {
    await context.writeArtifactJson(`${label}-socket-open.json`, {
      elapsedMs: Math.round(performance.now() - openingAt), timeoutMs: rpcOpenTimeoutMs,
    });
  }
  let rpcFailures = 0;
  const rpc = async (method, params = {}) => {
    try {
      return await client.request(method, params, 60_000);
    } catch (error) {
      // Preserve only the bounded native failure metadata, never request bodies.
      const frame = client.messages().findLast(message => message.error);
      await context.writeArtifactJson(`${label}-native-code-gateway-failure-${++rpcFailures}.json`, { method,
        code: frame?.error?.code, message: frame?.error?.message,
        diagnostic: frame?.error?.data ?? null });
      throw error;
    }
  };
  const initialized = await rpc('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'native-code-service-real-gateway-consumer', version: '1' },
    capabilities: { experimental: { integrationScopeV1: true, integrationTaskStateV1: true, nativeCodeServicesV1: true,
      workflowCanvasV1: true, workflowRunsV1: true, workflowGraphV2: true, ...experimental } } });
  assert.equal(initialized.capabilities?.experimental?.nativeCodeServicesV1, experimental.nativeCodeServicesV1 ?? true);
  const scope = await rpc('integrations/scope/read');
  return { gateway, client, rpc, scope, initialized, close: async () => {
    await closeRpcAndWait(client);
    await context.stopOwned(label);
  } };
}

export function serviceRequest(scope, payload, { operationId, expectedRevision } = {}) {
  return { contractVersion: 'parallel-v1', requestId: randomUUID(), scope, timeoutMs: 60_000, payload,
    ...(operationId ? { operationId } : {}), ...(expectedRevision === undefined ? {} : { expectedRevision: String(expectedRevision) }) };
}

export async function saveNativeCodeWorkflow(ui, marker, delayMs) {
  let definition = await ui.rpc('workflow/create', { title: marker, description: 'Owned model-independent Native background lifetime verification.' });
  definition = await ui.rpc('workflow/upsertNode', { id: definition.id, expectedRevision: definition.revision,
    node: { id: 'wait', title: 'Original owned wait', kind: 'wait', config: { wait: { delayMs } } } });
  definition = await ui.rpc('workflow/upsertNode', { id: definition.id, expectedRevision: definition.revision,
    node: { id: 'code', title: 'Original fixed Code result', kind: 'code', dependsOn: ['wait'], config: { code: {
      source: `if(input.value !== 7) throw new Error('original input changed'); return { marker: ${JSON.stringify(marker)}, value: input.value * 2 };`, timeoutMs: 1000,
    } } } });
  const saved = await ui.rpc('workflow/save', { id: definition.id, expectedRevision: definition.revision });
  assert.equal(saved.savedVersion, 1);
  return { definitionId: saved.id, version: saved.savedVersion, args: { value: 7 } };
}

export async function startNativeCodeManager(context, fixture, label, { startupTimeoutMs = 15_000 } = {}) {
  assert.equal(fixture.activeManagers.has(label), false, 'An original manager label cannot be reused');
  assert.equal(context.processes?.has(label) ?? false, false, 'An owned process label cannot be reused');
  assert.ok(Number.isSafeInteger(startupTimeoutMs) && startupTimeoutMs > 0 && startupTimeoutMs <= 60_000);
  let startupPhase = 'spawn_submitted';
  let child, observer, client, request, reader, managerReceipt;
  let startMayHaveBeenDelivered = false;
  let directManagerCrash = false;
  let stopMayHaveBeenDelivered = false;
  let closing;
  const recordUnknownCrash = async exit => {
    let attachedObservation = null;
    if (request && observer.exitCode === null && observer.signalCode === null) {
      try { attachedObservation = await request('observe'); } catch {}
    }
    const observation = { state: 'unknown_after_manager_crash', label, managerExit: exit,
      managerPid: child.pid, expectedUid: fixture.uid, expectedImageSha256: fixture.imageSha256,
      startMayHaveBeenDelivered, completeWorkerAuthority: 'not_confirmed',
      workerObservationScope: 'explicitly_attached_leases_only', attachedObservation,
      retainFixtureAndProfile: true, retryRequiresOriginalReconciliation: true,
      recovery: 'A forced manager exit has no complete worker inventory receipt. Retain the fixture until an original complete kernel-scope authority proves quiescence.' };
    const writer = context.writeArtifactJsonInternal?.bind(context) ?? context.writeArtifactJson?.bind(context);
    try { if (writer) await writer(`native-manager-${label}-crash-unknown.json`, observation); } catch {}
    return observation;
  };
  const stop = signal => {
    if (closing) return closing;
    const operation = (async () => {
      assert.ok(child, 'Retain the original manager fence when process submission is unconfirmed');
      // EOF cancels the private startup gate without releasing automatic restore.
      // Once GO may have been written, only the original complete drain can settle it.
      if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      if (!stopMayHaveBeenDelivered && (startMayHaveBeenDelivered || signal === 'SIGKILL') && child.exitCode === null && child.signalCode === null) {
        stopMayHaveBeenDelivered = true;
        child.kill(signal);
      }
      const exit = await waitForStdioChildClose(child, 45_000, label);
      let observed;
      if (signal === 'SIGKILL') {
        assert.equal(exit.signal, 'SIGKILL');
        const observation = await recordUnknownCrash(exit);
        throw Object.assign(new Error('Original manager complete kernel-scope quiescence was not proved after SIGKILL'),
          { nativeManagerCleanup: observation });
      } else {
        assert.equal(exit.code, 0, 'Native manager must confirm cleanup, rather than disappear after a forced termination');
        assert.ok(managerReceipt?.event === 'native_code_service_manager_stopped'
          && managerReceipt.contractVersion === 1 && managerReceipt.ownerMode === 'private_stdin_v1'
          && managerReceipt.ownedWorkersExited === true
          && typeof managerReceipt.startupReleased === 'boolean',
        'Original owned manager complete worker drain receipt was not confirmed');
        assert.ok(startMayHaveBeenDelivered || managerReceipt.startupReleased === false,
          'Original owned manager receipt is incompatible with its startup phase: GO was never submitted');
        // This receipt comes from the same original child after its complete wait,
        // including restored workers that were never attached to the pidfd observer.
        observed = { managerAlive: false, workers: [], managerReceipt,
          workerObservationScope: 'explicitly_attached_leases_only' };
        if (request && observer.exitCode === null && observer.signalCode === null) {
          try { observed = { ...observed, ...await request('observe') }; } catch {}
        }
      }
      if (observer) {
        if (!observer.stdin.destroyed && !observer.stdin.writableEnded) observer.stdin.end();
        await waitForStdioChildClose(observer, 5000, `${label}-pidfd`);
        client?.closeReader();
        await context.stopOwned(`${label}-pidfd`);
      }
      reader?.close();
      await context.stopOwned(label);
      fixture.activeManagers.delete(label);
      return { ...observed, managerExit: exit,
        workerExitProvedBy: 'original_manager_complete_child_wait_receipt',
        managerGracefulCleanup: true };
    })();
    closing = operation;
    // A later cleanup may re-observe the same original receipt after a timeout;
    // its EOF/stop request is never replayed.
    void operation.catch(() => { if (closing === operation) closing = undefined; });
    return operation;
  };
  const close = () => stop(directManagerCrash ? 'SIGKILL' : 'SIGTERM');
  try {
    child = context.spawnOwned(label, fixture.binary, [MANAGER_ENTRY, fixture.profile, fixture.workspace],
      { uid: fixture.uid, gid: fixture.gid, cwd: fixture.workspace, env: fixture.env, stdin: 'pipe' });
    fixture.activeManagers.add(label);
    // A closed control pipe also emits an error event; the write callback and
    // original shutdown receipt below determine its outcome.
    child.stdin.on('error', () => {});
    // Register before the first awaited readiness/observer operation. The receipt
    // fence remains active when any recovery observation is missing.
    context.addCleanup(`confirm actual native-code manager and worker cleanup ${label}`, close, { timeoutMs: 90_000 });
    reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value?.event === 'native_code_service_manager_stopped') managerReceipt = value;
      } catch {}
    });
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => finish(new Error('Actual owned Native manager startup gate was not confirmed; the binary must support the owned entry')), startupTimeoutMs);
      const ended = () => finish(new Error('Actual Native service manager exited before its owned startup gate was confirmed'));
      const failed = error => finish(error);
      const lineRead = line => { if (line === MANAGER_READY) finish(); };
      const finish = error => {
        clearTimeout(timer); reader.removeListener('line', lineRead); reader.removeListener('close', ended);
        child.removeListener('close', ended); child.removeListener('error', failed);
        if (error) rejectReady(error); else resolveReady();
      };
      child.once('close', ended);
      child.once('error', failed);
      reader.once('close', ended);
      reader.on('line', lineRead);
      if (child.exitCode !== null || child.signalCode !== null) ended();
    });
    startupPhase = 'owner_gate_observed';
    // Opening the real manager pidfd plus its complete loaded image proves this
    // observer is tied to this RunContext child, rather than a historical PID.
    observer = context.spawnOwned(`${label}-pidfd`, '/usr/bin/python3', ['-u', observerSource,
      String(child.pid), String(fixture.uid), fixture.imageSha256], { stdin: 'pipe' });
    // This LIFO registration runs before the observer's generic process stop.
    context.addCleanup(`confirm observed native-code manager and worker cleanup ${label}`, close, { timeoutMs: 90_000 });
    startupPhase = 'observer_submitted';
    client = new AppServerStdioClient(`${label}-pidfd`, observer, { defaultTimeoutMs: 5000 });
    request = async (method, params = {}) => {
      const response = await client.request(method, params);
      assert.equal(response.error, undefined, `${method}: ${response.error?.message}`);
      return response.result;
    };
    await pollNative(async () => (await request('observe')).managerAlive, 'actual Native service manager pidfd');
    startupPhase = 'kernel_manager_observed';
    startMayHaveBeenDelivered = true;
    startupPhase = 'owner_start_may_have_been_delivered';
    await new Promise((accept, reject) => child.stdin.write(MANAGER_START, error => error ? reject(error) : accept()));
    startupPhase = 'owner_start_written';
    return { child, request, attach: leaseId => pollNative(async () => {
      const response = await client.request('attach', { leaseId });
      return response.error ? null : response.result;
    }, 'actual owned Native service worker'),
    close, crashManagerOnly: async () => {
      assert.equal(closing, undefined, 'The original manager lifecycle must still be owned by this fixture');
      directManagerCrash = true;
      stopMayHaveBeenDelivered = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      const exit = await waitForStdioChildClose(child, 15_000, label);
      assert.equal(exit.signal, 'SIGKILL');
      // No current caller supplies an original complete kernel scope authority.
      return recordUnknownCrash(exit);
    }, crash: async () => {
      directManagerCrash = true;
      const completion = stop('SIGKILL');
      void completion.catch(() => {}); // The same original promise is awaited by the caller and registered cleanup.
      await waitForStdioChildClose(child, 15_000, label);
      return { completion };
    } };
  } catch (error) {
    if (!child) throw error;
    let recovery, recoveryFailure;
    try { recovery = await close(); } catch (failure) { recoveryFailure = failure; }
    const identity = context.processes?.get(label)?.identity;
    const observation = {
      state: recovery ? 'startup_failed_cleanup_confirmed' : 'unknown_startup', label, startupPhase,
      managerPid: Number.isSafeInteger(identity?.pid) ? identity.pid : null,
      managerStartTicks: typeof identity?.startTicks === 'string' && /^\d+$/.test(identity.startTicks) ? identity.startTicks : null,
      expectedUid: fixture.uid, expectedImageSha256: fixture.imageSha256,
      cleanupOwner: 'original_native_service_manager',
      completeWorkerAuthority: recovery ? 'original_manager_complete_child_wait_receipt' : 'not_confirmed',
      startMayHaveBeenDelivered,
      retainFixtureAndProfile: !recovery, retryRequiresOriginalReconciliation: !recovery,
      ...(recovery ? { cleanup: recovery } : {}),
      recovery: recovery ? 'Original owned manager complete drain receipt and actual zero exit confirmed cleanup.'
        : 'Use the retained original manager/lease authority and kernel observations. A new manager, empty observer list or generic process stop does not prove original workers ended.',
      ...(recoveryFailure ? { cleanupUnconfirmed: true } : {}),
    };
    const writer = context.writeArtifactJsonInternal?.bind(context) ?? context.writeArtifactJson?.bind(context);
    try { if (writer) await writer(`native-manager-${label}-startup-unknown.json`, observation); } catch {}
    try { if (error && typeof error === 'object') error.nativeManagerStartup = observation; } catch {}
    throw error;
  }
}

export async function pollNative(read, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out observing ${description}; original operation was not replayed`);
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
