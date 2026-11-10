import assert from 'node:assert/strict';
import { constants, createReadStream } from 'node:fs';
import { chmod, chown, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerStdioClient, waitForStdioChildClose } from './app-server-stdio.mjs';
import { isolatedEnvironment } from './run-context.mjs';
import { startGateway, waitForGatewayRpcToken } from './gateway.mjs';
import { login } from './http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, openRpc } from './rpc.mjs';

const MANAGER_ENTRY = '--internal-native-code-service-manager-v1';
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
    for (const info of [homeInfo, runtimeInfo]) assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === account.uid && (info.mode & 0o777) === 0o700);
  }
  const uid = account?.uid ?? (process.getuid() === 0 ? 65534 : process.getuid());
  const gid = account?.gid ?? (process.getuid() === 0 ? 65534 : process.getgid());
  const root = scratch ? context.pathInScratch(scratch, 'owned-account') : context.pathInCase('native-code-service', 'owned-account');
  const activeManagers = new Set();
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root, { mode: 0o711 });
  if (!scratch) context.registerTemporaryDirectory('native-code-owned-uid-fixture', root);
  context.addCleanup('remove stopped native-code owned UID fixture', async () => {
    assert.equal(activeManagers.size, 0, 'Retain Native fixture while any original manager cleanup is unconfirmed');
    await rm(root, { recursive: true, force: false });
    if (scratch?.requireCleanupConfirmation) await context.confirmOwnedScratchCleanup(scratch);
  });
  const ownedDirectory = async name => {
    const path = resolve(root, name);
    await mkdir(path, { mode: 0o700 });
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
  await chmod(binary, 0o500);
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
  }), { mode: 0o600 });
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
  await writeFile(pending, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
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
    await writeFile(pending, value, { mode: 0o600, flag: 'wx' });
    if (process.getuid() === 0) await chown(pending, fixture.uid, fixture.gid);
    await rename(pending, fixture.settings);
  };
  await replace(JSON.stringify(settings));
  return () => replace(before);
}

export async function startNativeCodeGateway(context, fixture, label, { experimental = {}, rpcOpenTimeoutMs } = {}) {
  const serversFile = resolve(fixture.profile, 'service-observer-servers.json');
  await writeFile(serversFile, JSON.stringify([{ id: 'local', label: 'Owned native service observer',
    runtime: 'kcoder', transport: 'local', command: fixture.binary, workspace: fixture.workspace }]), { mode: 0o600 });
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

export async function startNativeCodeManager(context, fixture, label) {
  fixture.activeManagers.add(label);
  const child = context.spawnOwned(label, fixture.binary, [MANAGER_ENTRY, fixture.profile, fixture.workspace],
    { uid: fixture.uid, gid: fixture.gid, cwd: fixture.workspace, env: fixture.env });
  await new Promise((resolveReady, rejectReady) => {
    const reader = createInterface({ input: child.stdout });
    const timer = setTimeout(() => finish(new Error('Actual Native service manager listener was not confirmed')), 15_000);
    const ended = () => finish(new Error('Actual Native service manager exited before its listener was confirmed'));
    const finish = error => {
      clearTimeout(timer); reader.close(); child.removeListener('close', ended);
      if (error) rejectReady(error); else resolveReady();
    };
    child.once('close', ended);
    reader.on('line', line => {
      if (line === '{"event":"native_code_service_manager_ready"}') finish();
    });
  });
  // Opening the real manager pidfd plus its complete loaded image proves this
  // observer is tied to this RunContext child, rather than a historical PID.
  const observer = context.spawnOwned(`${label}-pidfd`, '/usr/bin/python3', ['-u', observerSource,
    String(child.pid), String(fixture.uid), fixture.imageSha256], { stdin: 'pipe' });
  const client = new AppServerStdioClient(`${label}-pidfd`, observer, { defaultTimeoutMs: 5000 });
  const request = async (method, params = {}) => {
    const response = await client.request(method, params);
    assert.equal(response.error, undefined, `${method}: ${response.error?.message}`);
    return response.result;
  };
  await pollNative(async () => (await request('observe')).managerAlive, 'actual Native service manager pidfd');
  let closing;
  let directManagerCrash = false;
  const stop = signal => closing ??= (async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const exit = await waitForStdioChildClose(child, 15_000, label);
    if (signal === 'SIGKILL') assert.equal(exit.signal, 'SIGKILL');
    else assert.equal(exit.code, 0, 'Native manager must confirm cleanup, rather than disappear after a forced termination');
    const observed = await pollNative(async () => {
      const value = await request('observe');
      return value.workers.every(worker => !worker.alive) ? value : null;
    }, 'original service workers to terminate after their actual manager owner ends', 15_000);
    assert.equal(observed.managerAlive, false);
    observer.stdin.end();
    await waitForStdioChildClose(observer, 5000, `${label}-pidfd`);
    client.closeReader();
    await context.stopOwned(label);
    await context.stopOwned(`${label}-pidfd`);
    fixture.activeManagers.delete(label);
    return { ...observed, managerExit: exit, workerExitProvedBy: 'original_held_kernel_pidfds',
      managerGracefulCleanup: signal !== 'SIGKILL' };
  })();
  const close = () => stop(directManagerCrash ? 'SIGKILL' : 'SIGTERM');
  context.addCleanup(`confirm actual native-code manager and worker cleanup ${label}`, close);
  return { child, request, attach: leaseId => pollNative(async () => {
    const response = await client.request('attach', { leaseId });
    return response.error ? null : response.result;
  }, 'actual owned Native service worker'),
  close, crashManagerOnly: async () => {
    assert.equal(closing, undefined, 'The original manager lifecycle must still be owned by this fixture');
    directManagerCrash = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    const exit = await waitForStdioChildClose(child, 15_000, label);
    assert.equal(exit.signal, 'SIGKILL');
    // A separate retained scope pidfd/fence observer owns this negative's
    // original descendants. Its registered cleanup runs before this close.
    return { managerExit: exit, ownedTreeCleanupDeferred: true };
  }, crash: async () => {
    const completion = stop('SIGKILL');
    void completion.catch(() => {}); // The same original promise is awaited by the caller and registered cleanup.
    await waitForStdioChildClose(child, 15_000, label);
    return { completion };
  } };
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
