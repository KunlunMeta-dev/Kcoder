import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import {
  chmod, lstat, mkdir, open, readFile, readdir, realpath, rename,
  stat, writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const previewRoot = join(repo, 'target/preview/experts-channels-20261030');
const buildRoot = join(repo, 'target/preview/async-question-original-core-20261102');
const lifecycleRoot = join(repo, 'target/preview/channel-host-lifecycle-20261102');
const configRoot = '/home/hyf/.local/state/kcoder-previews/experts-channels-20261030-01a18c4d-v5/config';
const oldBinary = pathArg('--old-binary', join(repo, 'target/preview/channel-host-lifecycle-20261102/kcoder-retained-service-v7-20261102'));
const candidateBinary = pathArg('--candidate-binary', join(buildRoot, 'kcoder'));
const candidateManifest = pathArg('--candidate-manifest', join(buildRoot, 'candidate.json'));
const maintenanceEvidencePath = join(buildRoot, 'gate.json');
const maintenanceBackupPath = '/home/hyf/.local/state/kcoder-previews/experts-channels-20261030-01a18c4d-v5/async-question-original-core-caddy-20261102/route-before.json';
const maintenanceBackupSha256 = '6b78946f1644924fdc9979ecae6f7ba738f850050560324df7fbb3ecce1db71e';
const publicRoute = '/g/6c353e9562da6003614a28f918f26610{,/*}';
const unit = 'kcoder-native-user-1001-2ebf25169e229fd9179ca8cc3e895346194949fc2e071fe5dcedae7aef8940a4.service';
const expected = {
  relayPid: pidArg('--relay-pid', 2005295),
  gatewayPid: pidArg('--gateway-pid', 2005326),
  reverseClientPid: pidArg('--reverse-client-pid', 3749580),
};
const nodeProgram = '/home/hyf/.local/opt/node-v22.17.0-linux-x64/bin/node';
const gatewayScript = join(repo, 'apps/kcoder-relay/src/gateway.mjs');
const devServerScript = join(repo, 'apps/kcoder-studio/dev-server.mjs');
const reverseClientScript = join(repo, 'apps/kcoder-relay/src/client.mjs');
const bindingKey = 'KCODER_NATIVE_CONNECTIVITY_BINDING_V1';
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function fail(message) { throw new Error(message); }

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`Missing value for ${name}.`);
  return value;
}

function pathArg(name, fallback) {
  return resolve(arg(name, fallback));
}

function pidArg(name, fallback) {
  const value = arg(name, String(fallback));
  if (!/^[1-9]\d*$/.test(value)) fail(`${name} must be a positive process id.`);
  const pid = Number(value);
  if (!Number.isSafeInteger(pid)) fail(`${name} is outside the safe integer range.`);
  return pid;
}

function requireApply(phase) {
  if (!process.argv.includes('--apply')) fail(`Phase ${phase} changes the live preview; pass --apply explicitly.`);
}

function parseEnv(buffer) {
  const values = Object.create(null);
  for (const entry of buffer.toString('utf8').split('\0')) {
    if (!entry) continue;
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const key = entry.slice(0, at);
    if (Object.hasOwn(values, key)) fail('Process environment has duplicate keys; exact restart is unsafe.');
    values[key] = entry.slice(at + 1);
  }
  return values;
}

async function processInfo(pid) {
  const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
  const tail = statText.slice(statText.lastIndexOf(')') + 2).trim().split(/\s+/);
  const argv = (await readFile(`/proc/${pid}/cmdline`)).toString('utf8').split('\0').filter(Boolean);
  const cwd = await realpath(`/proc/${pid}/cwd`);
  const exe = await realpath(`/proc/${pid}/exe`);
  const uid = (await stat(`/proc/${pid}`)).uid;
  return {
    pid,
    ppid: Number(tail[1]),
    startTicks: tail[19],
    argv,
    cwd,
    exe,
    uid,
    envBytes: await readFile(`/proc/${pid}/environ`),
  };
}

function matchesScript(info, script) {
  return info.argv.length === 2 && resolve(info.cwd, info.argv[1]) === script;
}

function fingerprint(info) {
  return {
    pid: info.pid,
    ppid: info.ppid,
    startTicks: info.startTicks,
    argv0: info.argv[0],
    argv1: info.argv[1],
    cwd: info.cwd,
    exe: info.exe,
    uid: info.uid,
  };
}

async function verifyFingerprint(saved) {
  const now = await processInfo(saved.pid);
  assert.equal(now.startTicks, saved.startTicks, 'PID identity changed since the checkpoint');
  assert.equal(now.exe, saved.exe);
  assert.equal(now.cwd, saved.cwd);
  assert.equal(now.argv[0], saved.argv0);
  assert.equal(now.argv[1], saved.argv1);
  assert.equal(now.uid, process.getuid());
  return now;
}

async function waitGone(saved, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const current = await processInfo(saved.pid);
      if (current.startTicks !== saved.startTicks) return;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return;
      throw error;
    }
    await sleep(100);
  }
  fail(`Owned process ${saved.pid} did not stop within ${timeoutMs}ms.`);
}

async function candidateFacts() {
  const manifest = JSON.parse(await readFile(candidateManifest, 'utf8'));
  assert.equal(manifest.status, 'built-relevant-inputs-verified');
  assert.equal(manifest.path, candidateBinary);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
  const info = await stat(candidateBinary);
  assert.equal(info.nlink, 1);
  assert.equal(info.mode & 0o777, 0o500);
  assert.equal(sha256(await readFile(candidateBinary)), manifest.sha256);
  return { path: candidateBinary, sha256: manifest.sha256 };
}

async function verifyMaintenanceGate() {
  const evidenceInfo = await lstat(maintenanceEvidencePath);
  assert.ok(evidenceInfo.isFile() && !evidenceInfo.isSymbolicLink());
  assert.equal(evidenceInfo.uid, process.getuid());
  assert.equal(evidenceInfo.nlink, 1);
  assert.equal(evidenceInfo.mode & 0o077, 0);
  const evidence = JSON.parse(await readFile(maintenanceEvidencePath, 'utf8'));
  assert.equal(evidence.status, 'active');
  assert.equal(evidence.routeId, '6c353e9562da6003614a28f918f26610');
  assert.equal(evidence.path, publicRoute);
  assert.equal(evidence.upstream, '127.0.0.1:33411');
  assert.equal(evidence.httpStatus, 503);
  assert.equal(evidence.backupPath, maintenanceBackupPath);
  assert.equal(evidence.backupSha256, maintenanceBackupSha256);
  assert.match(evidence.backupSha256, /^[a-f0-9]{64}$/);
  const backup = await lstat(evidence.backupPath);
  assert.ok(backup.isFile() && !backup.isSymbolicLink());
  assert.equal(backup.uid, process.getuid());
  assert.equal(backup.nlink, 1);
  assert.equal(backup.mode & 0o777, 0o600);
  assert.equal(sha256(await readFile(evidence.backupPath)), evidence.backupSha256);
  return {
    status: 'verified-active', routeId: evidence.routeId, path: evidence.path,
    upstream: evidence.upstream, httpStatus: evidence.httpStatus,
    backupSha256: evidence.backupSha256,
  };
}

async function readUnitFile(expectedBinary = oldBinary) {
  const fragment = execFileSync('systemctl', ['--user', 'show', unit, '--property=FragmentPath', '--value'], { encoding: 'utf8' }).trim();
  const path = await realpath(fragment);
  assert.ok(path.startsWith(join(configRoot, 'native-channel-carrier-')));
  const contents = await readFile(path, 'utf8');
  assert.equal(contents.split(`ExecStart="${expectedBinary}"`).length - 1, 1, 'Unit ExecStart must reference the expected binary exactly once.');
  return { path, contents };
}

function unitActiveState() {
  return execFileSync('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
}

function parseDotEnv(text) {
  const result = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

async function exactProcessFacts() {
  assert.equal(await realpath(process.cwd()), repo);
  assert.equal(process.getuid(), 1001);
  const [relay, gateway, reverse] = await Promise.all([
    processInfo(expected.relayPid), processInfo(expected.gatewayPid), processInfo(expected.reverseClientPid),
  ]);
  for (const info of [relay, gateway, reverse]) assert.equal(info.uid, process.getuid());
  assert.equal(relay.exe, nodeProgram);
  assert.equal(gateway.exe, nodeProgram);
  assert.equal(reverse.exe, nodeProgram);
  assert.equal(relay.cwd, repo);
  assert.equal(gateway.cwd, repo);
  assert.equal(reverse.cwd, repo);
  assert.ok(matchesScript(relay, gatewayScript));
  assert.ok(matchesScript(gateway, devServerScript));
  assert.ok(matchesScript(reverse, reverseClientScript));
  assert.equal(gateway.ppid, relay.pid);

  const relayEnv = parseEnv(relay.envBytes);
  const gatewayEnv = parseEnv(gateway.envBytes);
  const reverseEnv = parseEnv(reverse.envBytes);
  assert.equal(relayEnv.KCODER_RELAY_CONFIG_DIR, configRoot);
  assert.equal(relayEnv.KCODER_RELAY_KCODER_BIN, oldBinary);
  assert.equal(gatewayEnv.KCODER_CONFIG_DIR, configRoot);
  assert.equal(gatewayEnv.KCODER_STUDIO_PORT, '58613');
  assert.equal(reverseEnv.KCODER_RELAY_LOCAL_GATEWAY, 'http://127.0.0.1:58613');
  assert.equal(reverseEnv.KCODER_RELAY_IDENTITY_FILE, join(previewRoot, 'identity.json'));

  const previousComponent = JSON.parse(await readFile(join(lifecycleRoot, 'component-retained-service-v7.json'), 'utf8'));
  assert.ok(previousComponent.environment?.[bindingKey]);
  assert.equal(relayEnv[bindingKey], previousComponent.environment[bindingKey]);
  assert.equal(gatewayEnv[bindingKey], previousComponent.environment[bindingKey]);

  const previewEnvText = await readFile(join(previewRoot, 'preview.env'), 'utf8');
  const previewEnv = parseDotEnv(previewEnvText);
  assert.equal(previewEnv.KCODER_RELAY_KCODER_BIN, oldBinary);
  for (const file of ['servers.json', 'servers-store.json']) {
    const records = JSON.parse(await readFile(join(previewRoot, file), 'utf8'));
    assert.ok(Array.isArray(records));
    const selected = records.filter(record => record.id === 'expert-preview');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].command, oldBinary);
  }
  const unitFile = await readUnitFile();
  assert.equal(unitActiveState(), 'active');
  return {
    relay: fingerprint(relay), gateway: fingerprint(gateway), reverseClient: fingerprint(reverse),
    unitPath: unitFile.path,
    bindingPreserved: true,
  };
}

async function preflight() {
  const candidate = await candidateFacts();
  const processes = await exactProcessFacts();
  const maintenance = await verifyMaintenanceGate().catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return { status: 'not-armed', applyAllowed: false };
  });
  const requiredFiles = [
    join(previewRoot, 'preview.env'), join(previewRoot, 'servers.json'),
    join(previewRoot, 'servers-store.json'), processes.unitPath,
    join(configRoot, 'settings.json'), join(configRoot, 'credentials.json'),
  ];
  console.log(JSON.stringify({
    phase: 'preflight', apply: false, candidate, oldBinary,
    expectedPids: expected, processes, maintenance,
    requiredFiles, configRoot,
    publicAdmissionFreeze: 'verified Caddy 503 maintenance is primary; captured reverse client stop is secondary',
    preservedEnvironmentBinding: bindingKey,
    next: 'Run --phase cutover --apply only after reviewing this exact identity set.',
  }, null, 2));
}

async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const info = await stat(path);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o777, 0o700);
}

async function writePrivate(path, content, flag = 'wx') {
  const handle = await open(path, flag, 0o600);
  try { await handle.writeFile(content); } finally { await handle.close(); }
  await chmod(path, 0o600);
}

async function writeJson(path, value) {
  const temp = `${path}.next-${process.pid}`;
  await writePrivate(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, path);
}

async function loadRun(runDir) {
  const root = await realpath(runDir);
  const parent = await realpath(join(configRoot, 'async-question-original-core-deploy'));
  assert.ok(root.startsWith(`${parent}/`), 'Run checkpoint must be under the private preview state directory.');
  const info = await stat(root);
  assert.equal(info.uid, process.getuid());
  assert.equal(info.mode & 0o777, 0o700);
  return { root, statePath: join(root, 'checkpoint.json'), state: JSON.parse(await readFile(join(root, 'checkpoint.json'), 'utf8')) };
}

async function updateExact(path, before, after) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.uid, process.getuid());
  assert.equal(info.nlink, 1);
  assert.equal(await readFile(path, 'utf8'), before, `File changed since preflight: ${path}`);
  const temp = `${path}.async-question-${process.pid}.next`;
  await writeFile(temp, after, { mode: info.mode & 0o777, flag: 'wx' });
  await chmod(temp, info.mode & 0o777);
  await rename(temp, path);
}

async function collectStateHashes() {
  const root = join(configRoot, 'projects');
  const found = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (path.endsWith('.jsonl') || entry.name === 'async-user-questions.json')) {
        found.push({ path: path.slice(configRoot.length + 1), sha256: sha256(await readFile(path)) });
      }
    }
  }
  await visit(root);
  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

async function backupFile(runDir, name, path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(info.uid, process.getuid());
  const bytes = await readFile(path);
  await writePrivate(join(runDir, 'backup', name), bytes);
  return { source: path, sha256: sha256(bytes), bytes: bytes.length, mode: info.mode & 0o777 };
}

async function getActivityAndThreads() {
  const { connect } = await import('/tmp/kcoder-feishu-text-native-client.mjs');
  const client = await connect({ readScope: false });
  try {
    const activityResult = await client.rpc.request('server/resources/read', {});
    const activity = activityResult.activity;
    for (const field of [
      'runningTurns', 'terminalSessions', 'browserSessions', 'pendingServiceRequests',
      'pendingTasks', 'runningTasks', 'pendingApprovals', 'pendingQuestions',
      'queuedFollowups', 'pendingGoalContinuations', 'pendingAutomationRequests',
    ]) assert.equal(activity[field], 0, `Preview has active resource: ${field}`);
    const all = [];
    let cursor;
    do {
      const page = await client.rpc.request('thread/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      all.push(...(page.threads ?? []));
      cursor = page.nextCursor ?? undefined;
      if (all.length > 10_000) fail('Thread list exceeded the bounded idle verification limit.');
    } while (cursor);
    assert.ok(all.every(thread => thread.status === 'idle'), 'Every preview thread must be idle before service stop.');
    return { threadCount: all.length, idle: true };
  } finally {
    await client.close();
  }
}

async function waitForNewRelay(relayPid, candidatePath, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const relay = await processInfo(relayPid);
      if (matchesScript(relay, gatewayScript)) {
        const child = await findGatewayChild(relayPid);
        if (child) {
          const childEnv = parseEnv(child.envBytes);
          if (childEnv.KCODER_STUDIO_KCODER_BIN === candidatePath && childEnv.KCODER_STUDIO_PORT === '58613') {
            return { relay, child };
          }
        }
      }
    } catch { /* The parent can be between spawn and exec; keep the bounded startup probe. */ }
    await sleep(250);
  }
  fail('New Relay Gateway did not produce the expected local Gateway child.');
}

async function findGatewayChild(parentPid) {
  const entries = await readdir('/proc');
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const info = await processInfo(Number(entry));
      if (info.ppid === parentPid && matchesScript(info, devServerScript)) return info;
    } catch { /* Process exited while scanning. */ }
  }
  return undefined;
}

async function assertReadOnlyGateway(expectedChild, candidatePath, timeoutMs = 60_000) {
  const { connect } = await import('/tmp/kcoder-feishu-text-native-client.mjs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let child;
    try {
      child = await processInfo(expectedChild.pid);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
      continue;
    }
    if (child.startTicks !== expectedChild.startTicks
      || child.exe !== nodeProgram
      || child.cwd !== repo
      || child.uid !== process.getuid()
      || !matchesScript(child, devServerScript)) {
      fail('The candidate Gateway child identity changed during its readiness check.');
    }
    const childEnv = parseEnv(child.envBytes);
    if (childEnv.KCODER_STUDIO_KCODER_BIN !== candidatePath || childEnv.KCODER_STUDIO_PORT !== '58613') {
      fail('The candidate Gateway child does not carry the expected binary and port.');
    }

    let client;
    let connectTimedOut = false;
    let connectTimer;
    let ready;
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const connectPromise = connect({ readScope: false });
      connectPromise.then(lateClient => {
        if (connectTimedOut) lateClient.rpc?.close();
      }, () => undefined);
      client = await Promise.race([
        connectPromise,
        new Promise((_, reject) => {
          connectTimer = setTimeout(() => {
            connectTimedOut = true;
            reject(new Error('readiness connect timeout'));
          }, Math.min(10_000, remaining));
        }),
      ]);
      clearTimeout(connectTimer);
      const requestTimeout = () => Math.max(1, Math.min(5_000, deadline - Date.now()));
      const resources = await client.rpc.request('server/resources/read', {}, requestTimeout());
      assert.ok(resources && typeof resources.activity === 'object');
      const page = await client.rpc.request('thread/list', { limit: 100 }, requestTimeout());
      assert.ok(Array.isArray(page.threads));

      const stillCandidate = await processInfo(expectedChild.pid);
      assert.equal(stillCandidate.startTicks, expectedChild.startTicks);
      assert.equal(parseEnv(stillCandidate.envBytes).KCODER_STUDIO_KCODER_BIN, candidatePath);
      ready = { reachable: true, threadCount: page.threads.length, candidateGatewayPid: expectedChild.pid };
    } catch {
      clearTimeout(connectTimer);
    } finally {
      if (client) await client.close().catch(() => undefined);
    }
    if (ready) return ready;
    await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  fail(`Candidate Gateway did not answer read-only RPCs within ${timeoutMs}ms.`);
}

async function cutover() {
  requireApply('cutover');
  const candidate = await candidateFacts();
  const maintenance = await verifyMaintenanceGate();
  const processes = await exactProcessFacts();
  const runRoot = join(configRoot, 'async-question-original-core-deploy');
  await ensurePrivateDir(runRoot);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
  const runDir = join(runRoot, runId);
  await ensurePrivateDir(runDir);
  await ensurePrivateDir(join(runDir, 'backup'));
  await ensurePrivateDir(join(runDir, 'private-env'));

  const relayNow = await verifyFingerprint(processes.relay);
  const reverseNow = await verifyFingerprint(processes.reverseClient);
  await writePrivate(join(runDir, 'private-env', 'relay.nul'), relayNow.envBytes);
  await writePrivate(join(runDir, 'private-env', 'reverse-client.nul'), reverseNow.envBytes);
  const state = {
    version: 1, runId, createdAt: new Date().toISOString(), phase: 'prepared',
    candidate, oldBinary, configRoot, previewRoot, unit, unitPath: processes.unitPath,
    identities: processes, maintenance,
    checkpoints: [],
  };
  const statePath = join(runDir, 'checkpoint.json');
  await writeJson(statePath, state);
  console.log(JSON.stringify({ phase: 'cutover', runDir, oldBinary, candidateSha256: candidate.sha256, expectedPids: expected, checkpoint: 'prepared' }));

  await verifyFingerprint(state.identities.reverseClient);
  process.kill(state.identities.reverseClient.pid, 'SIGTERM');
  await waitGone(state.identities.reverseClient);
  state.checkpoints.push({ phase: 'reverse-client-stopped', at: new Date().toISOString() });
  state.phase = 'reverse-client-stopped';
  await writeJson(statePath, state);

  state.maintenance = await verifyMaintenanceGate();
  const idle = await getActivityAndThreads();
  state.idleBeforeStop = idle;
  state.phase = 'idle-confirmed';
  state.checkpoints.push({ phase: 'idle-confirmed', at: new Date().toISOString(), threadCount: idle.threadCount });
  await writeJson(statePath, state);

  await verifyFingerprint(state.identities.relay);
  const gatewayBefore = await verifyFingerprint(state.identities.gateway);
  state.maintenance = await verifyMaintenanceGate();
  const relayBefore = await processInfo(state.identities.relay.pid);
  process.kill(relayBefore.pid, 'SIGTERM');
  await Promise.all([waitGone(state.identities.relay), waitGone(state.identities.gateway)]);
  state.checkpoints.push({ phase: 'relay-gateway-stopped', at: new Date().toISOString(), gatewayStartTicks: gatewayBefore.startTicks });
  state.phase = 'relay-gateway-stopped';
  await writeJson(statePath, state);

  execFileSync('systemctl', ['--user', 'stop', unit], { timeout: 40_000, stdio: 'ignore' });
  assert.equal(unitActiveState(), 'inactive');
  state.checkpoints.push({ phase: 'native-unit-stopped', at: new Date().toISOString() });
  state.phase = 'native-unit-stopped';
  await writeJson(statePath, state);

  const unitFile = await readFile(state.identities.unitPath, 'utf8');
  const files = [
    ['preview.env', join(previewRoot, 'preview.env')],
    ['servers.json', join(previewRoot, 'servers.json')],
    ['servers-store.json', join(previewRoot, 'servers-store.json')],
    ['native-manager.service', state.identities.unitPath],
    ['settings.json', join(configRoot, 'settings.json')],
    ['credentials.json', join(configRoot, 'credentials.json')],
    ['relay.pid', join(previewRoot, 'relay.pid')],
  ];
  const backups = {};
  for (const [name, path] of files) backups[name] = await backupFile(runDir, name, path);
  state.backups = backups;
  state.historyAndLedgerBefore = await collectStateHashes();
  await writeJson(join(runDir, 'history-ledger-before.json'), state.historyAndLedgerBefore);
  state.phase = 'backups-complete';
  await writeJson(statePath, state);

  const previewPath = join(previewRoot, 'preview.env');
  const previewBefore = await readFile(previewPath, 'utf8');
  const previewLines = previewBefore.split(/\r?\n/);
  const binLines = previewLines.filter(line => line.startsWith('KCODER_RELAY_KCODER_BIN='));
  assert.equal(binLines.length, 1);
  const currentValue = binLines[0].slice('KCODER_RELAY_KCODER_BIN='.length).replace(/^(['"])(.*)\1$/, '$2');
  assert.equal(currentValue, oldBinary);
  const quote = binLines[0].slice('KCODER_RELAY_KCODER_BIN='.length).startsWith('"') ? '"' : '';
  const previewAfter = previewBefore.replace(binLines[0], `KCODER_RELAY_KCODER_BIN=${quote}${candidate.path}${quote}`);
  await updateExact(previewPath, previewBefore, previewAfter);

  for (const name of ['servers.json', 'servers-store.json']) {
    const path = join(previewRoot, name);
    const before = await readFile(path, 'utf8');
    const records = JSON.parse(before);
    const recordsForTarget = records.filter(record => record.id === 'expert-preview');
    assert.equal(recordsForTarget.length, 1);
    assert.equal(recordsForTarget[0].command, oldBinary);
    recordsForTarget[0].command = candidate.path;
    await updateExact(path, before, `${JSON.stringify(records, null, 2)}\n`);
  }

  const unitAfter = unitFile.replace(`ExecStart="${oldBinary}"`, `ExecStart="${candidate.path}"`);
  await updateExact(state.identities.unitPath, unitFile, unitAfter);
  const relayPidPath = join(previewRoot, 'relay.pid');
  const relayPidBefore = await readFile(relayPidPath, 'utf8');
  assert.equal(Number(relayPidBefore.trim()), state.identities.relay.pid);

  execFileSync('systemctl', ['--user', 'daemon-reload'], { timeout: 30_000, stdio: 'ignore' });
  execFileSync('systemctl', ['--user', 'start', unit], { timeout: 45_000, stdio: 'ignore' });
  assert.equal(unitActiveState(), 'active');
  const mainPid = Number(execFileSync('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'], { encoding: 'utf8' }).trim());
  assert.ok(mainPid > 1);
  assert.equal(await realpath(`/proc/${mainPid}/exe`), candidate.path);

  const relayEnv = parseEnv(await readFile(join(runDir, 'private-env', 'relay.nul')));
  assert.equal(relayEnv.KCODER_RELAY_KCODER_BIN, oldBinary);
  relayEnv.KCODER_RELAY_KCODER_BIN = candidate.path;
  const logPath = join(runDir, 'gateway.log');
  const logHandle = await open(logPath, 'wx', 0o600);
  const parent = spawn(state.identities.relay.exe, [state.identities.relay.argv1], {
    cwd: state.identities.relay.cwd,
    argv0: state.identities.relay.argv0,
    detached: true,
    env: relayEnv,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  parent.unref();
  await logHandle.close();
  state.newRelayPid = parent.pid;
  state.phase = 'gateway-starting';
  state.checkpoints.push({ phase: 'gateway-start-requested', at: new Date().toISOString(), pid: parent.pid });
  await writeJson(statePath, state);
  const pair = await waitForNewRelay(parent.pid, candidate.path);
  assert.equal(parseEnv(pair.child.envBytes).KCODER_STUDIO_CONFIG_DIR ?? parseEnv(pair.child.envBytes).KCODER_CONFIG_DIR, configRoot);
  const unitAfterFacts = await readUnitFile(candidate.path);
  assert.equal(unitAfterFacts.contents.split(`ExecStart="${candidate.path}"`).length - 1, 1);
  await updateExact(relayPidPath, relayPidBefore, `${parent.pid}\n`);
  const gatewayRead = await assertReadOnlyGateway(pair.child, candidate.path);
  state.phase = 'gateway-running';
  state.cutoverVerified = true;
  state.newGatewayPid = pair.child.pid;
  state.gatewayRead = gatewayRead;
  state.historyAndLedgerAfter = await collectStateHashes();
  assert.deepEqual(state.historyAndLedgerAfter, state.historyAndLedgerBefore, 'History or async-question ledger changed during binary cutover.');
  await writeJson(join(runDir, 'history-ledger-after-cutover.json'), state.historyAndLedgerAfter);
  state.checkpoints.push({ phase: 'gateway-running-readonly', at: new Date().toISOString(), pid: pair.child.pid });
  await writeJson(statePath, state);
  console.log(JSON.stringify({ phase: 'cutover', runDir, gatewayPid: pair.child.pid, nativeUnitPid: mainPid, historyAndLedgerUnchanged: true, reverseClient: 'still stopped', next: 'Run --phase adopt --apply --run-dir <printed path>.' }));
}

async function loadClient() {
  return import('/tmp/kcoder-feishu-text-native-client.mjs');
}

async function rpcSideEffect(client, runDir, state, key, method, payload, mutation) {
  const intentPath = join(runDir, `${key}.intent.json`);
  const receiptPath = join(runDir, `${key}.receipt.json`);
  try {
    return JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    const priorIntent = JSON.parse(await readFile(intentPath, 'utf8'));
    await reconcileUnknownSideEffect(client, runDir, key, priorIntent);
    fail(`Unconfirmed ${key} operation was read back. This script will not replay it.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writePrivate(intentPath, `${JSON.stringify({ at: new Date().toISOString(), method, operationId: mutation.operationId, expectedRevision: mutation.expectedRevision, payload }, null, 2)}\n`);
  state.phase = `${key}-sent-unknown-until-receipt`;
  await writeJson(join(runDir, 'checkpoint.json'), state);
  try {
    const result = await client.call(method, payload, mutation);
    await writePrivate(receiptPath, `${JSON.stringify(result, null, 2)}\n`);
    state.phase = `${key}-receipt-saved`;
    await writeJson(join(runDir, 'checkpoint.json'), state);
    return result;
  } catch {
    state.phase = `${key}-unknown`;
    await writeJson(join(runDir, 'checkpoint.json'), state);
    const intent = JSON.parse(await readFile(intentPath, 'utf8'));
    await reconcileUnknownSideEffect(client, runDir, key, intent).catch(() => undefined);
    fail(`${key} result is unknown. The operation id is preserved in the private run directory; do not replay.`);
  }
}

async function reconcileUnknownSideEffect(client, runDir, key, intent) {
  const operation = await client.rpc.request('integrations/operation/read', {
    contractVersion: 'parallel-v1',
    requestId: `async-question-reconcile-${randomBytes(8).toString('hex')}`,
    scope: client.scope,
    timeoutMs: 30_000,
    payload: { operationId: intent.operationId },
  });
  let readback;
  if (intent.method === 'connectivity/prepareConnectionAction') {
    readback = await client.call('connectivity/readConnection', { connectionId: intent.payload.connectionId });
  } else if (intent.method === 'services/channel/prepare') {
    readback = await client.call('services/channel/current', { connectionRef: intent.payload.connectionRef });
  } else if (intent.payload?.leaseId) {
    readback = await client.call('services/channel/read', { leaseId: intent.payload.leaseId });
  }
  await writePrivate(join(runDir, `${key}.reconciliation-${Date.now()}-${randomBytes(4).toString('hex')}.json`), `${JSON.stringify({ at: new Date().toISOString(), operation, readback: readback ?? null }, null, 2)}\n`);
}

async function restoreReverseClient(runDir, state) {
  await verifyMaintenanceGate();
  const envPath = join(runDir, 'private-env', 'reverse-client.nul');
  const envBytes = await readFile(envPath);
  const env = parseEnv(envBytes);
  assert.equal(env.KCODER_RELAY_LOCAL_GATEWAY, 'http://127.0.0.1:58613');
  assert.equal(env.KCODER_RELAY_IDENTITY_FILE, join(previewRoot, 'identity.json'));
  const nodeInfo = await processInfo(expected.reverseClientPid).catch(() => undefined);
  if (nodeInfo && matchesScript(nodeInfo, reverseClientScript)) fail('A reverse Relay client is already running; inspect its exact owner before restoring.');
  const logHandle = await open(join(runDir, 'reverse-client.log'), 'wx', 0o600);
  const child = spawn(nodeProgram, [reverseClientScript], {
    cwd: repo, argv0: 'node', detached: true, env,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();
  const deadline = Date.now() + 15_000;
  let started;
  while (Date.now() < deadline) {
    try {
      const info = await processInfo(child.pid);
      if (matchesScript(info, reverseClientScript)) { started = info; break; }
    } catch { /* Spawn startup in progress. */ }
    await sleep(100);
  }
  assert.ok(started, 'The owned reverse client did not start.');
  state.reverseClientPid = child.pid;
  state.phase = 'reverse-client-restored';
  await writeJson(join(runDir, 'checkpoint.json'), state);
}

async function adopt() {
  requireApply('adopt');
  const runDirArg = arg('--run-dir');
  if (!runDirArg) fail('Adoption requires --run-dir from the cutover phase.');
  const { root: runDir, state } = await loadRun(runDirArg);
  assert.equal(state.cutoverVerified, true, 'Cutover must be verified before adoption.');
  state.maintenance = await verifyMaintenanceGate();
  const { connect } = await loadClient();
  const client = await connect();
  try {
    const previous = JSON.parse(await readFile(join(repo, 'target/preview/expert-skill-resources-20261102/background-restore-intent.json'), 'utf8'));
    const connectionId = previous.payload.connectionRef.id;
    const connection = await client.call('connectivity/readConnection', { connectionId });
    const grants = await client.call('connectivity/readResourceGrant', { connectionId });
    assert.equal(connection.status, 'completed');
    assert.equal(grants.status, 'completed');
    const expectedBindingId = previous.payload.identityBindingRef.id;
    const binding = grants.result.bindings.find(entry => entry.id === expectedBindingId);
    assert.ok(binding);
    assert.equal(binding.state, 'active');
    assert.deepEqual([...binding.actions].sort(), [...previous.payload.actions].sort());
    assert.equal(binding.expiresAtMs ?? null, previous.payload.expiresAtMs ?? null);

    const foreground = await rpcSideEffect(
      client, runDir, state, 'foreground-start', 'connectivity/prepareConnectionAction',
      { action: 'start', connectionId },
      {
        operationId: `async-question-original-core-${state.runId}-foreground-start`,
        expectedRevision: String(connection.result.revision),
      },
    );
    assert.equal(foreground.status, 'completed');
    const foregroundReadback = await client.call('connectivity/readConnection', { connectionId });
    assert.equal(foregroundReadback.status, 'completed');
    state.foregroundOperationId = `async-question-original-core-${state.runId}-foreground-start`;
    state.foregroundStartVerified = true;
    await writeJson(join(runDir, 'checkpoint.json'), state);

    const updatedConnection = await client.call('connectivity/readConnection', { connectionId });
    const updatedGrants = await client.call('connectivity/readResourceGrant', { connectionId });
    assert.equal(updatedConnection.status, 'completed');
    assert.equal(updatedGrants.status, 'completed');
    const updatedBinding = updatedGrants.result.bindings.find(entry => entry.id === expectedBindingId);
    assert.ok(updatedBinding);
    assert.equal(updatedBinding.state, 'active');
    assert.deepEqual([...updatedBinding.actions].sort(), [...previous.payload.actions].sort());
    assert.equal(updatedBinding.expiresAtMs ?? null, previous.payload.expiresAtMs ?? null);
    const payload = {
      ...previous.payload,
      connectionRef: { id: connectionId, revision: updatedConnection.result.revision },
      identityBindingRef: { id: updatedBinding.id, revision: updatedBinding.revision },
    };

    const prepareOperationId = `async-question-original-core-${state.runId}-prepare`;
    const prepared = await rpcSideEffect(client, runDir, state, 'service-prepare', 'services/channel/prepare', payload, {
      operationId: prepareOperationId, expectedRevision: '0',
    });
    assert.ok(prepared.intent?.leaseId);
    state.newLeaseId = prepared.intent.leaseId;
    state.phase = 'service-prepared';
    await writeJson(join(runDir, 'checkpoint.json'), state);

    const started = await rpcSideEffect(client, runDir, state, 'service-start', 'services/channel/start', { leaseId: state.newLeaseId }, {
      operationId: `async-question-original-core-${state.runId}-start`, expectedRevision: String(prepared.revision),
    });
    assert.equal(started.currentOsState, 'running');
    assert.equal(started.ownerObservation, 'verified_native_owner');
    const nextLease = await client.call('services/channel/read', { leaseId: state.newLeaseId });
    assert.equal(nextLease.currentOsState, 'running');
    assert.equal(nextLease.ownerObservation, 'verified_native_owner');
    state.phase = 'new-owner-verified';
    await writeJson(join(runDir, 'checkpoint.json'), state);

    const oldStarted = JSON.parse(await readFile(join(lifecycleRoot, 'retained-service-v7-background-started.json'), 'utf8'));
    const oldLeaseId = oldStarted.record.intent.leaseId;
    const oldLease = await client.call('services/channel/read', { leaseId: oldLeaseId });
    assert.equal(oldLease.record.intent.sourceBindingRef.id, nextLease.record.intent.sourceBindingRef.id);
    const revoked = await rpcSideEffect(client, runDir, state, 'old-service-revoke', 'services/channel/revoke', { leaseId: oldLeaseId }, {
      operationId: `async-question-original-core-${state.runId}-retire-old`, expectedRevision: String(oldLease.record.revision),
    });
    assert.equal(revoked.record?.state, 'revoked');
    const oldAfter = await client.call('services/channel/read', { leaseId: oldLeaseId });
    const newAfter = await client.call('services/channel/read', { leaseId: state.newLeaseId });
    assert.equal(oldAfter.record.state, 'revoked');
    assert.equal(newAfter.currentOsState, 'running');
    assert.equal(newAfter.ownerObservation, 'verified_native_owner');
    state.phase = 'old-owner-revoked-new-owner-running';
    state.oldLeaseId = oldLeaseId;
    state.bindingId = expectedBindingId;
    await writeJson(join(runDir, 'checkpoint.json'), state);
  } finally {
    await client.close();
  }
  state.historyAndLedgerAfterAdoption = await collectStateHashes();
  assert.deepEqual(state.historyAndLedgerAfterAdoption, state.historyAndLedgerBefore, 'Task history or async-question ledger changed during owner adoption.');
  await writeJson(join(runDir, 'history-ledger-after-adoption.json'), state.historyAndLedgerAfterAdoption);
  await restoreReverseClient(runDir, state);
  state.phase = 'adopted-and-public-client-restored';
  await writeJson(join(runDir, 'checkpoint.json'), state);
  console.log(JSON.stringify({ phase: 'adopt', newLeaseId: state.newLeaseId, oldLeaseRevoked: true, owner: 'verified_native_owner', reverseClientRestored: true, publicBrowserAcceptance: 'not run; root must perform read-only acceptance' }));
}

const phase = arg('--phase', process.argv[2] ?? 'preflight');
try {
  if (phase === 'preflight') await preflight();
  else if (phase === 'cutover') await cutover();
  else if (phase === 'adopt') await adopt();
  else fail('Usage: node async-question-original-core-deploy.once.mjs [--phase preflight|cutover|adopt] [--old-binary PATH] [--candidate-binary PATH] [--candidate-manifest PATH] [--relay-pid PID] [--gateway-pid PID] [--reverse-client-pid PID] [--apply] [--run-dir PRIVATE_RUN_DIR]');
} catch (error) {
  console.error(JSON.stringify({ phase, error: error.message }));
  process.exitCode = 1;
}
