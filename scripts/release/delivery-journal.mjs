import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manifestName, verifyManifest } from './artifact-manifest.mjs';

// Coordinates existing release/build/snapshot commands; never builds, tags,
// publishes, installs, or kills user applications without an explicit adapter.
const phases = { repository: ['push', 'upload', 'cleanup'], host: ['deliver', 'install', 'running'] };
const commit = /^[a-f0-9]{40}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const setup = /^KCoder-Studio-Setup-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-win-x64\.exe$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text); } catch { throw Error('Invalid delivery JSON (contents suppressed)'); }
};
export async function fileIdentity(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Artifact must be a regular file');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  const after = await lstat(path);
  if (bytes !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) throw Error('Artifact changed while hashing');
  return { name: basename(path), bytes: info.size, sha256: hash.digest('hex') };
}
async function atomic(path, value) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  }
  finally { await rm(temporary, { force: true }); }
}
async function locked(path, action) {
  const lock = path + '.lock', nonce = randomUUID();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw Error('Delivery journal is locked; inspect owner and use recover-lock only after its process exits'); throw error; }
  try { await atomic(resolve(lock, 'owner.json'), { pid: process.pid, host: hostname(), nonce }); return await action(); }
  finally { await rm(lock, { recursive: true }); }
}
export async function recoverLock(path) {
  const lock = resolve(path) + '.lock';
  const owner = await json(resolve(lock, 'owner.json'));
  if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) throw Error('Cannot prove the lock owner is local');
  try { process.kill(owner.pid, 0); throw Error('Delivery owner is still alive'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  // Reused PIDs remain locked. Never infer a dead owner from a timeout.
  if ((await json(resolve(lock, 'owner.json'))).nonce !== owner.nonce) throw Error('Lock ownership changed');
  await rm(lock, { recursive: true });
}
function validatePlan(plan) {
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.targets) || !plan.targets.length) throw Error('Invalid delivery plan');
  if (!Array.isArray(plan.runtimeVerify) || !plan.runtimeVerify.length || plan.runtimeVerify.some(value => typeof value !== 'string' || value.includes('\0'))) throw Error('An existing packaged-runtime verification adapter is required');
  const ids = new Set();
  for (const target of plan.targets) {
    if (!id.test(target.id) || ids.has(target.id) || !Object.hasOwn(phases, target.kind)) throw Error('Invalid or duplicate delivery target');
    ids.add(target.id);
    if (target.kind === 'repository' && !commit.test(target.publishedCommit ?? '')) throw Error('Explicit public snapshot commit is required');
    for (const [phase, adapter] of Object.entries(target.adapters ?? {})) {
      if (!phases[target.kind].includes(phase) || !adapter.verify || !adapter.execute) throw Error('Invalid phase adapter');
      for (const command of [adapter.execute, adapter.verify]) {
        if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || value.includes('\0'))) throw Error('Adapters use argv arrays, never shell interpolation');
      }
    }
  }
}
export async function createDelivery(planPath, journalPath) {
  planPath = resolve(planPath); journalPath = resolve(journalPath);
  const plan = await json(planPath); validatePlan(plan);
  return locked(journalPath, async () => {
    try { await lstat(journalPath); throw Error('Journal already exists; resume it instead'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const artifactPath = resolve(dirname(planPath), plan.artifact);
    const resourceRoot = resolve(dirname(planPath), plan.resourceRoot);
    const manifest = await verifyManifest(resourceRoot, { expectedCommit: plan.sourceCommit });
    if (!commit.test(plan.sourceCommit ?? '') || manifest.packagingSource.dirty) throw Error('A frozen clean packaging source is required');
    const artifact = await fileIdentity(artifactPath);
    if (!setup.test(artifact.name) || artifact.name !== `KCoder-Studio-Setup-${manifest.versions.studio}-win-x64.exe`) throw Error('Public releases contain only the matching Windows installer');
    const cli = manifest.resources.find(item => item.path === 'bin/kcoder.exe');
    const runtime = (await command(plan.runtimeVerify, dirname(planPath), { ...process.env,
      KCODER_DELIVERY_ARTIFACT: artifactPath, KCODER_DELIVERY_SHA256: artifact.sha256,
      KCODER_DELIVERY_SOURCE: plan.sourceCommit, KCODER_DELIVERY_RESOURCES: resourceRoot }, 600000)).receipt;
    if (!cli || runtime?.status !== 'verified' || runtime.sha256 !== artifact.sha256
        || runtime.cliSha256 !== cli.sha256 || runtime.buildCommit !== plan.sourceCommit
        || runtime.buildDirty !== false || runtime.cliVersion !== manifest.versions.cli
        || runtime.studioVersion !== manifest.versions.studio || runtime.protocolVersion !== manifest.protocol?.version
        || !Array.isArray(runtime.capabilities) || runtime.capabilities.some(value => typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,100}$/.test(value))) throw Error('Packaged runtime identity/capability verification is missing or does not match');
    const journal = { schemaVersion: 1, revision: 0, createdAt: new Date().toISOString(),
      sourceCommit: plan.sourceCommit, artifactPath, resourceRoot, artifact,
      resourceManifestSha256: digest(await readFile(resolve(resourceRoot, manifestName))),
      identity: { versions: manifest.versions, protocol: manifest.protocol, resources: manifest.resources },
      source: { status: 'verified', commit: plan.sourceCommit },
      build: { status: 'verified', artifact },
      checks: { status: 'verified', resourceManifestSha256: digest(await readFile(resolve(resourceRoot, manifestName))),
        runtime: { cliSha256: cli.sha256, buildCommit: runtime.buildCommit, buildDirty: false, cliVersion: runtime.cliVersion, protocolVersion: runtime.protocolVersion,
          negotiatedCapabilities: runtime.capabilities } },
      targets: Object.fromEntries(plan.targets.map(target => [target.id, { kind: target.kind,
        ...(target.kind === 'repository' ? { publishedCommit: target.publishedCommit } : {}),
        stages: Object.fromEntries(phases[target.kind].map(phase => [phase, { status: 'pending', attempts: 0 }])) }])) };
    await atomic(journalPath, journal); return journal;
  });
}
async function assertFrozen(journal) {
  if (JSON.stringify(await fileIdentity(journal.artifactPath)) !== JSON.stringify(journal.artifact)) throw Error('Frozen installer changed; create a new delivery');
  if (digest(await readFile(resolve(journal.resourceRoot, manifestName))) !== journal.resourceManifestSha256) throw Error('Resource manifest changed');
  await verifyManifest(journal.resourceRoot, { expectedCommit: journal.sourceCommit });
}
export function verifiedFacts(phase, response, journal, target) {
  if (response?.status !== 'verified') return null;
  const artifact = journal.artifact;
  switch (phase) {
    case 'push': return response.remoteCommit === target.publishedCommit ? { remoteCommit: response.remoteCommit } : null;
    case 'upload': case 'deliver':
      return response.sha256 === artifact.sha256 && response.bytes === artifact.bytes && response.name === artifact.name
        ? { name: artifact.name, sha256: artifact.sha256, bytes: artifact.bytes } : null;
    case 'cleanup':
      return response.keptSha256 === artifact.sha256 && response.keptName === artifact.name
        && Array.isArray(response.removedNames) && response.removedNames.every(name => setup.test(name) && name !== artifact.name)
        ? { keptName: artifact.name, keptSha256: artifact.sha256, removedNames: response.removedNames } : null;
    case 'install': case 'running': {
      // Inspect actual installed/loaded CLI bytes, not merely installer copy or
      // a source version string. Runtime confirmation additionally needs PID.
      const cli = journal.identity.resources.find(item => item.path === 'bin/kcoder.exe');
      if (!cli || response.cliSha256 !== cli.sha256 || response.buildCommit !== journal.sourceCommit || response.buildDirty !== false || response.cliVersion !== journal.identity.versions.cli || response.studioVersion !== journal.identity.versions.studio) return null;
      if (phase === 'running' && (!Number.isInteger(response.pid) || response.pid < 1)) return null;
      return { cliSha256: response.cliSha256, buildCommit: response.buildCommit, buildDirty: false, cliVersion: response.cliVersion, studioVersion: response.studioVersion,
        ...(phase === 'running' ? { pid: response.pid } : {}) };
    }
    default: return null;
  }
}
function blockCode(response) {
  return ['permission_denied', 'authentication_required', 'target_unavailable'].includes(response?.code)
    ? response.code : 'target_unavailable';
}
async function command(argv, cwd, env, timeoutMs) {
  return new Promise(resolveRun => {
    let stdout = [], bytes = 0, killed = false, timer;
    const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
    const stop = () => { killed = true;
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 65536) stop(); else stdout.push(data); });
    timer = setTimeout(stop, timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolveRun({ code: null }); });
    child.once('close', code => { clearTimeout(timer); let receipt;
      if (!killed && code === 0) try { receipt = JSON.parse(Buffer.concat(stdout).toString('utf8')); } catch {}
      resolveRun({ code, receipt });
    });
  });
}
export async function resumeDelivery(planPath, journalPath, { targetId, phase, execute = false } = {}) {
  planPath = resolve(planPath); journalPath = resolve(journalPath);
  const plan = await json(planPath); validatePlan(plan);
  if (targetId && !plan.targets.some(target => target.id === targetId)) throw Error('Unknown delivery target');
  if (phase && !Object.values(phases).flat().includes(phase)) throw Error('Unknown delivery phase');
  return locked(journalPath, async () => {
    const journal = await json(journalPath);
    if (journal.schemaVersion !== 1 || journal.sourceCommit !== plan.sourceCommit) throw Error('Journal/source identity mismatch');
    if (resolve(dirname(planPath), plan.artifact) !== journal.artifactPath || resolve(dirname(planPath), plan.resourceRoot) !== journal.resourceRoot) throw Error('Delivery artifact/resource selection changed');
    await assertFrozen(journal);
    for (const target of plan.targets) {
      if (targetId && target.id !== targetId) continue;
      const record = journal.targets[target.id];
      if (!record || record.kind !== target.kind || record.publishedCommit !== target.publishedCommit) throw Error('Target identity changed; create a new delivery');
      for (const name of phases[target.kind]) {
        if (phase && phase !== name) continue;
        const stage = record.stages[name], adapter = target.adapters?.[name];
        if (!adapter) continue;
        const prior = phases[target.kind].slice(0, phases[target.kind].indexOf(name));
        if (prior.some(key => record.stages[key].status !== 'verified')) continue;
        const env = { ...process.env, KCODER_DELIVERY_ARTIFACT: journal.artifactPath,
          KCODER_DELIVERY_SHA256: journal.artifact.sha256, KCODER_DELIVERY_SOURCE: journal.sourceCommit,
          KCODER_DELIVERY_TARGET: target.id, KCODER_DELIVERY_PHASE: name,
          KCODER_DELIVERY_PUBLIC_COMMIT: target.publishedCommit ?? '', KCODER_DELIVERY_RESOURCES: journal.resourceRoot };
        const timeout = Math.min(600000, Math.max(1000, adapter.timeoutMs ?? 60000));
        const probe = async () => (await command(adapter.verify, dirname(planPath), env, timeout)).receipt;
        const save = async () => { journal.revision++; await atomic(journalPath, journal); };
        let observed = await probe();
        let facts = verifiedFacts(name, observed, journal, record);
        if (facts) { delete stage.code; Object.assign(stage, { status: 'verified', facts, verifiedAt: new Date().toISOString() }); await save(); continue; }
        // The verifier must prove absence before mutating. A crashed/in-flight
        // or unverified result never authorizes blind replay on resume.
        if (!execute || observed?.status !== 'absent' || stage.status === 'verified') {
          Object.assign(stage, { status: observed?.status === 'blocked' ? 'blocked' : 'unknown', code: observed?.status === 'blocked' ? blockCode(observed) : 'verification_required' }); await save(); continue;
        }
        if (target.kind === 'host' && ['install', 'running'].includes(name) && target.allowInstall !== true) continue;
        if (target.kind === 'host' && name === 'install' && (observed.activeTasks !== 0 || observed.desktopInUse !== false)) continue;
        // Recheck the current remote upload immediately before deleting old
        // installers. A historic success is insufficient authorization to prune.
        if (name === 'cleanup') {
          const upload = target.adapters?.upload;
          if (!upload || !verifiedFacts('upload', (await command(upload.verify, dirname(planPath), { ...env, KCODER_DELIVERY_PHASE: 'upload' }, timeout)).receipt, journal, record)) continue;
        }
        Object.assign(stage, { status: 'in_flight', attempts: stage.attempts + 1, startedAt: new Date().toISOString() }); await save();
        await command(adapter.execute, dirname(planPath), env, timeout);
        observed = await probe(); facts = verifiedFacts(name, observed, journal, record);
        if (facts) delete stage.code;
        Object.assign(stage, facts ? { status: 'verified', facts, verifiedAt: new Date().toISOString() } : {
          status: observed?.status === 'blocked' ? 'blocked' : observed?.status === 'absent' ? 'failed' : 'unknown',
          code: observed?.status === 'blocked' ? blockCode(observed) : observed?.status === 'absent' ? 'action_failed' : 'verification_required' });
        await save();
      }
    }
    return journal;
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, plan, journal, target, phase] = process.argv.slice(2);
  try {
    let result;
    if (mode === 'init') result = await createDelivery(plan, journal);
    else if (mode === 'resume' || mode === 'probe') result = await resumeDelivery(plan, journal, { targetId: target, phase, execute: mode === 'resume' });
    else if (mode === 'recover-lock') { await recoverLock(plan); result = { recovered: true }; }
    else throw Error('Usage: delivery-journal.mjs init|probe|resume PLAN JOURNAL [TARGET [PHASE]] | recover-lock JOURNAL');
    console.log(JSON.stringify({ revision: result.revision, artifact: result.artifact, targets: result.targets, recovered: result.recovered }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
