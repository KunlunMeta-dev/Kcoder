//! Explicit local upgrade; never writes profiles, user binaries or original server configuration.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fetchGatewayPairing } from './pair.mjs';
import { resolveGatewayPresentation } from './gateway-presentation.mjs';
import { readClientIdentitySnapshot } from './client-identity.mjs';
import { resolveRelayRouteMode } from '../deploy/config.mjs';
import { absolutePath, atomicWrite, binaryDigest, createDirectory, directory, regularFile, sha256, systemdQuote } from './local-update-files.mjs';

const execute = promisify(execFile);
const preservedInput = (path, options) => path===options.identityFile
  ? readClientIdentitySnapshot({identityFile:path})
  : regularFile(path);
export async function hostRunner(file, args, options = {}) {
  try { const result = await execute(file, args, { timeout: 60000, maxBuffer: 1024 * 1024, ...options }); return { code: 0, stdout: result.stdout }; }
  catch (error) { return { code: Number.isInteger(error.code) ? error.code : -1, stdout: '', diagnostic: {
    code: ['ENOENT','EACCES','ETIMEDOUT','ENOBUFS'].includes(error.code) ? error.code : null,
    signal: ['SIGTERM','SIGKILL'].includes(error.signal) ? error.signal : null,
    killed: error.killed === true, stderrBytes: Buffer.byteLength(error.stderr || ''),
  } }; }
}
function parseEnvironment(bytes) {
  const env = {};
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(match[1] in env)) env[match[1]] = value;
  }
  return env;
}
async function successful(run, file, args, options) {
  const result = await run(file, args, options);
  if (result.code !== 0) {
    const error = new Error(`Command failed: ${file === 'git' ? 'source inspection' : file === 'systemctl' ? 'user service operation' : 'configuration validation'} (${result.code})`);
    error.commandDiagnostic = result.diagnostic; throw error;
  }
  return result.stdout.trim();
}
function unitName(value) {
  assert.ok(typeof value === 'string' && /^[A-Za-z0-9_-]+\.service$/.test(value), 'Expected an explicit user .service unit name');
  return value;
}
export async function preflightLocalUpdate(options, { run = hostRunner } = {}) {
  let stage = 'inputs';
  try {
  assert.equal(process.platform, 'linux', 'Local service upgrades require Linux user systemd');
  const o = { ...options, unitsDir: options.unitsDir ?? join(homedir(), '.config/systemd/user'), node: options.node ?? process.execPath };
  for (const key of ['source', 'envFile', 'configDir', 'serversFile', 'binary', 'identityFile', 'unitsDir', 'node']) absolutePath(o[key]);
  assert.ok(!/[\s%$"\\]/.test(o.source), 'Release source path cannot contain systemd WorkingDirectory metacharacters');
  assert.match(o.binarySha256, /^[a-f0-9]{64}$/);
  assert.match(o.sourceCommit, /^[a-f0-9]{40}$/);
  unitName(o.gatewayUnit); unitName(o.clientUnit); assert.notEqual(o.gatewayUnit, o.clientUnit);
  await directory(o.source); await directory(o.configDir); await directory(o.unitsDir);
  stage = 'source';
  const git = args => successful(run, 'git', ['-C', o.source, ...args]);
  assert.equal(await git(['rev-parse', 'HEAD']), o.sourceCommit, 'Release commit mismatch');
  assert.equal(await git(['status', '--porcelain', '--untracked-files=normal']), '', 'Release source must be clean');
  const sourceTree = await git(['rev-parse', 'HEAD^{tree}']);
  for (const file of ['apps/kcoder-relay/src/gateway.mjs', 'apps/kcoder-relay/src/client.mjs', 'apps/kcoder-studio/dev-server.mjs']) await regularFile(join(o.source, file));
  const studioRequire = createRequire(join(o.source, 'apps/kcoder-studio/dev-server.mjs'));
  for (const dependency of ['jsonc-parser', 'ssh2']) studioRequire.resolve(dependency);
  createRequire(join(o.source, 'apps/kcoder-relay/src/client.mjs')).resolve('ws');
  stage = 'binary';
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22, 'Updater requires Node 22 or newer');
  assert.equal(await realpath(o.node), await realpath(process.execPath), 'Unit Node must match the validated updater runtime');
  await binaryDigest(o.node);
  assert.equal(await binaryDigest(o.binary), o.binarySha256, 'Release binary digest mismatch');
  stage = 'configuration';
  const envBytes = await regularFile(o.envFile);
  const identityBytes = await readClientIdentitySnapshot({identityFile:o.identityFile});
  const settingsBytes = await regularFile(join(o.configDir, 'settings.json'));
  const serversBytes = await regularFile(o.serversFile);
  const env = parseEnvironment(envBytes);
  assert.ok(!env.KCODER_STUDIO_SERVERS_STORE && !env.KCODER_STUDIO_SERVERS, 'Existing server overrides require explicit operator resolution');
  const endpoint = new URL(env.KCODER_RELAY_LOCAL_GATEWAY || '');
  assert.ok(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1' && endpoint.pathname === '/' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'Expected the existing loopback Gateway URL');
  assert.ok(env.KCODER_RELAY_GATEWAY_SECRET?.length >= 32, 'Existing pairing configuration required');
  assert.equal(resolveRelayRouteMode({ registryMode: true, routeMode: env.KCODER_RELAY_ROUTE_MODE }), 'path');
  const relayUrl = new URL(env.KCODER_RELAY_PUBLIC_URL);
  assert.ok(relayUrl.protocol === 'https:' && relayUrl.pathname === '/' && !relayUrl.username && !relayUrl.password && !relayUrl.search && !relayUrl.hash, 'Expected a public Relay HTTPS origin');
  const { gatewayId, publicAccessUrl } = await resolveGatewayPresentation({ ...env, KCODER_RELAY_IDENTITY_FILE: o.identityFile });
  // Health checks present the Gateway's own isolated origin, exactly as the Relay forwards it.
  const publicUrl = new URL(new URL(publicAccessUrl).origin);
  const servers = JSON.parse(serversBytes);
  assert.ok(Array.isArray(servers) && servers.length > 0, 'Expected the existing server array');
  const targets = servers.filter(server => server.id === o.localServerId);
  assert.equal(targets.length, 1, 'Select exactly one existing local target');
  const target = targets[0];
  assert.ok(target.transport === 'local' && typeof target.workspace === 'string', 'Selected target must be local with an existing workspace');
  assert.ok(!target.settingsFile && !target.profile, 'Selected target must use the explicitly validated configuration');
  await directory(target.workspace);
  const effectiveServers = servers.map(server => server === target ? { ...server, command: o.binary } : server);
  stage = 'units';
  const backups = new Map();
  for (const name of [o.gatewayUnit, o.clientUnit]) backups.set(name, await regularFile(join(o.unitsDir, name)));
  // Config validation deliberately precedes lock, receipt, server-copy and unit writes.
  stage = 'config-validation';
  const validationEnv = { PATH: process.env.PATH || '', HOME: homedir(), LANG: process.env.LANG || 'C', KCODER_CONFIG_DIR: o.configDir };
  await successful(run, o.binary, ['config', 'validate'], { cwd: target.workspace, env: validationEnv });
  const preserved = new Map([[o.envFile, envBytes], [o.identityFile, identityBytes], [o.serversFile, serversBytes], [join(o.configDir, 'settings.json'), settingsBytes]]);
  for (const [path, bytes] of preserved) assert.equal(sha256(await preservedInput(path, o)), sha256(bytes), 'Preflight input changed during validation');
  return { o, sourceTree, env, endpoint, publicUrl, gatewayId, effectiveServers, backups, preserved };
  } catch (cause) { throw Object.assign(new Error(`Local preflight rejected: ${stage}`), { stage: `preflight/${stage}`, cause }); }
}
function renderUnit(plan, script, serversFile) {
  const { o } = plan;
  const variables = { KCODER_RELAY_ENV_FILE: o.envFile, KCODER_RELAY_CONFIG_DIR: o.configDir, KCODER_RELAY_SERVERS_FILE: serversFile, KCODER_RELAY_KCODER_BIN: o.binary, KCODER_RELAY_IDENTITY_FILE: o.identityFile };
  return Buffer.from(`[Unit]\nDescription=KCoder Relay ${script}\nAfter=network-online.target${script === 'client' ? ` ${o.gatewayUnit}` : ''}\n\n[Service]\nType=simple\nWorkingDirectory=${o.source}\nExecStart=${systemdQuote(o.node)} ${systemdQuote(join(o.source, `apps/kcoder-relay/src/${script}.mjs`))}\n${Object.entries(variables).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join('\n')}\nRestart=always\nRestartSec=3\nKillMode=control-group\nTimeoutStopSec=15\n\n[Install]\nWantedBy=default.target\n`);
}
// Node fetch replaces Host; the signed Relay presentation check needs the exact
// configured authority while connecting only to the local loopback listener.
function localHttp(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: options.method, headers: options.headers, signal: options.signal }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 32 * 1024 ** 2) response.destroy(new Error('Health response exceeds bound')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode, json: async () => JSON.parse(bytes), arrayBuffer: async () => bytes }); });
    });
    request.on('error', reject); request.end(options.body);
  });
}
export async function verifyLocalUpdate(plan, { fetch: fetcher = localHttp, signal } = {}) {
  const prefix = `/g/${plan.gatewayId}`;
  const mountHeaders = { host: plan.publicUrl.host };
  const request = async (path, options = {}) => {
    const response = await fetcher(new URL(path, plan.endpoint), { ...options, headers: { ...mountHeaders, ...options.headers }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, 'Gateway health HTTP check failed'); return response;
  };
  const pairing = await fetchGatewayPairing({ localGateway: plan.env.KCODER_RELAY_LOCAL_GATEWAY || 'http://127.0.0.1:4186', gatewaySecret: plan.env.KCODER_RELAY_GATEWAY_SECRET, publicGateway: plan.publicUrl.origin + prefix });
  let session;
  try {
    session = await (await request('/api/mobile/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: pairing.token, durableDeviceAuthorization: false }) })).json();
    assert.ok(typeof session.accessToken === 'string' && session.accessToken.length > 0, 'Gateway session unavailable');
  } catch (cause) {
    const error = new Error('Owned health session creation outcome is unknown', { cause });
    error.externalOutcome = 'unknown'; error.healthStage = 'session-create'; throw error;
  }
  const headers = { authorization: `Bearer ${session.accessToken}` };
  let primaryError;
  let healthStage = 'authenticated-entry';
  try {
    healthStage = 'server-configuration';
    const result = await (await request('/api/servers', { headers })).json();
    assert.deepEqual(result.servers.map(server => server.id).sort(), plan.effectiveServers.map(server => server.id).sort(), 'Gateway server configuration differs');
    return { authenticated: true, serverCount: result.servers.length };
  } catch (error) { error.healthStage = healthStage; primaryError = error; throw error; }
  finally {
    try {
      const response = await fetcher(new URL('/api/mobile/session', plan.endpoint), { method: 'DELETE', headers: { ...mountHeaders, ...headers }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 204, 'Owned health session cleanup failed');
    } catch (cleanupError) {
      const error = primaryError || new Error('Owned health session cleanup failed', { cause: cleanupError });
      error.cleanupError = cleanupError; error.externalOutcome = 'unknown'; throw error;
    }
  }
}
export async function updateLocalGateway(options, { run = hostRunner, healthCheck = verifyLocalUpdate, checkCancelled = () => {} } = {}) {
  checkCancelled();
  const plan = await preflightLocalUpdate(options, { run });
  checkCancelled();
  const { o } = plan;
  const lock = join(o.unitsDir, '.kcoder-relay-update.lock');
  await createDirectory(lock); // EEXIST fails closed; never removes another updater's lock.
  const lockIdentity = await lstat(lock, { bigint: true });
  const id = randomUUID(); let transaction; let changed = false; let retainLock = false;
  const receipt = { version: 1, transactionId: id, status: 'preparing', sourceCommit: o.sourceCommit, sourceTree: plan.sourceTree, binarySha256: o.binarySha256, gatewayId: plan.gatewayId, units: [o.gatewayUnit, o.clientUnit], previousActive: {}, rollbackErrors: [], preservedInputs: [...plan.preserved].map(([path, bytes]) => ({ path, sha256: sha256(bytes) })) };
  const systemctl = args => successful(run, 'systemctl', ['--user', ...args]);
  const save = async () => { if (transaction) await atomicWrite(join(transaction, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); };
  try {
    // Configuration validation may take a minute: recheck release identity under
    // the update lock before any service inspection or unit mutation.
    const git = args => successful(run, 'git', ['-C', o.source, ...args]);
    assert.equal(await git(['rev-parse', 'HEAD']), o.sourceCommit, 'Release commit changed after preflight');
    assert.equal(await git(['rev-parse', 'HEAD^{tree}']), plan.sourceTree, 'Release tree changed after preflight');
    assert.equal(await git(['status', '--porcelain', '--untracked-files=normal']), '', 'Release changed after preflight');
    assert.equal(await binaryDigest(o.binary), o.binarySha256, 'Release binary changed after preflight');
    await mkdir(join(o.source, 'target'), { recursive: true });
    const parent = await realpath(join(o.source, 'target')); await directory(parent);
    transaction = join(parent, `relay-local-update-${id}`); await createDirectory(transaction);
    await atomicWrite(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, transaction }) + '\n');
    for (const [path, bytes] of plan.preserved) assert.equal(sha256(await preservedInput(path, o)), sha256(bytes), 'Input changed after preflight');
    for (const [name, bytes] of plan.backups) {
      assert.equal(sha256(await regularFile(join(o.unitsDir, name))), sha256(bytes), 'Unit changed after preflight');
      const active = await systemctl(['show', '--property=ActiveState', '--value', name]);
      assert.ok(['active', 'inactive', 'failed'].includes(active), 'Unit is transitioning; retry later');
      receipt.previousActive[name] = active === 'active';
      await atomicWrite(join(transaction, `${name}.backup`), bytes);
    }
    const serversFile = join(transaction, 'servers.json');
    const servers = Buffer.from(JSON.stringify(plan.effectiveServers, null, 2) + '\n');
    await atomicWrite(serversFile, servers); receipt.serversFile = serversFile; receipt.serversSha256 = sha256(servers);
    receipt.status = 'prepared'; await save();
    checkCancelled(); changed = true;
    for (const [name, script] of [[o.gatewayUnit, 'gateway'], [o.clientUnit, 'client']]) { checkCancelled(); await atomicWrite(join(o.unitsDir, name), renderUnit(plan, script, serversFile)); }
    receipt.status = 'units-installed'; await save();
    checkCancelled(); await systemctl(['daemon-reload']);
    for (const name of receipt.units) { checkCancelled(); await systemctl(['restart', name]); }
    let healthError;
    const healthDeadline = AbortSignal.timeout(60000);
    for (let attempt = 0; attempt < 12; attempt++) {
      checkCancelled();
      try { receipt.health = await healthCheck(plan, { signal: healthDeadline }); healthError = null; break; }
      catch (error) { healthError = error;
        if (healthDeadline.aborted || error.externalOutcome === 'unknown') break;
        if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (healthError) {
      receipt.healthFailure = { name: ['Error','AssertionError','AbortError','TimeoutError','TypeError','SyntaxError'].includes(healthError.name) ? healthError.name : 'Error',
        stage: ['session-create','authenticated-entry','server-configuration'].includes(healthError.healthStage) ? healthError.healthStage : 'pre-session-health',
        cleanupUnconfirmed: Boolean(healthError.cleanupError), externalOutcome: healthError.externalOutcome === 'unknown' ? 'unknown' : 'failed', deadlineExpired: healthDeadline.aborted };
      throw new Error('Authenticated Gateway health checks failed', { cause: healthError });
    }
    for (const [path, bytes] of plan.preserved) assert.equal(sha256(await preservedInput(path, o)), sha256(bytes), 'Preserved input changed');
    checkCancelled(); receipt.status = 'committed'; await save(); checkCancelled();
    return { status: receipt.status, receiptFile: join(transaction, 'receipt.json'), sourceCommit: o.sourceCommit };
  } catch (error) {
    receipt.cancelled = error.code === 'UPDATE_CANCELLED';
    if (changed) {
      const recover = async (stage, action) => { try { await action(); } catch { receipt.rollbackErrors.push(stage); } };
      for (const name of receipt.units) await recover(`stop:${name}`, () => systemctl(['stop', name]));
      for (const [name, bytes] of plan.backups) await recover(`restore:${name}`, () => atomicWrite(join(o.unitsDir, name), bytes));
      await recover('daemon-reload', () => systemctl(['daemon-reload']));
      for (const name of receipt.units) if (receipt.previousActive[name]) await recover(`start:${name}`, () => systemctl(['start', name]));
    }
    receipt.status = receipt.rollbackErrors.length ? 'rollback-incomplete' : 'rolled-back';
    retainLock = receipt.status === 'rollback-incomplete';
    try { await save(); }
    catch (receiptError) { retainLock = true; error.receiptError = receiptError; }
    const failure = new Error(`Local update failed; ${receipt.status}${transaction ? `; private receipt: ${join(transaction, 'receipt.json')}` : ''}`);
    failure.cause = error; failure.stage = 'transaction'; failure.status = receipt.status; failure.receiptPersistence = error.receiptError ? 'unconfirmed' : 'confirmed'; failure.receiptFile = transaction ? join(transaction, 'receipt.json') : undefined; throw failure;
  } finally {
    if (!retainLock) {
      const current = await lstat(lock, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current?.isDirectory() && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) await rm(lock, { recursive: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = ['source', 'source-commit', 'env-file', 'config-dir', 'servers-file', 'binary', 'binary-sha256', 'identity-file', 'gateway-unit', 'client-unit', 'local-server-id', 'units-dir', 'node'];
  const { values } = parseArgs({ options: Object.fromEntries([...names.map(name => [name, { type: 'string' }]), ['check-only', { type: 'boolean' }], ['apply', { type: 'boolean' }]]) });
  const options = Object.fromEntries(Object.entries(values).filter(([key]) => !['check-only', 'apply'].includes(key)).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const checkCancelled = () => { if (cancelled) { const error = new Error('Update cancelled'); error.code = 'UPDATE_CANCELLED'; throw error; } };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    assert.ok(Boolean(values['check-only']) !== Boolean(values.apply), 'Choose --check-only or --apply');
    const result = values['check-only'] ? { status: 'preflight-only', sourceCommit: (await preflightLocalUpdate(options)).o.sourceCommit } : await updateLocalGateway(options, { checkCancelled });
    if (values['check-only']) checkCancelled();
    console.log(JSON.stringify(result));
  } catch (error) { console.error(JSON.stringify({ status: error.status || 'rejected', stage: error.stage || 'inputs', receiptFile: error.receiptFile, receiptPersistence: error.receiptPersistence })); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
