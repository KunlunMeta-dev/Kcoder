import { spawn } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

function cleanGitEnvironment(env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
}

async function git(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd, env, stdio: ['ignore', 'pipe', 'ignore'], shell: false,
    });
    const chunks = []; let size = 0, overflow = false;
    child.stdout.on('data', chunk => { size += chunk.length; if (size <= 32 * 1024 * 1024) chunks.push(chunk); else overflow = true; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0 || signal || overflow) reject(new Error('Cannot materialize the frozen macOS source commit'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Await a build-owned process group before allowing its snapshot to be removed. */
export async function runFrozenOwned(command, args, { cwd, env, handshake } = {}) {
  const child = spawn(command, args, { cwd, env, detached: true, shell: false,
    stdio: handshake ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit' });
  let processError, interrupted, killTimer, deadlineTimer, finishDeadline;
  const deadline = new Promise(resolve => { finishDeadline = resolve; });
  const sendToOwnedGroup = signal => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') processError = error; }
  };
  const interrupt = signal => {
    if (interrupted) return;
    interrupted = signal;
    sendToOwnedGroup(signal);
    killTimer = setTimeout(() => {
      sendToOwnedGroup('SIGKILL');
      deadlineTimer = setTimeout(() => finishDeadline({ unconfirmed: true }), 3000);
    }, 5000);
  };
  const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
  child.on('error', error => { processError = error; });
  if (handshake) child.once('spawn', () => child.send(handshake, error => { if (error) processError = error; }));
  let outcome;
  try {
    outcome = await Promise.race([new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))), deadline]);
  } finally {
    clearTimeout(killTimer); clearTimeout(deadlineTimer);
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
  }
  let groupAlive = Boolean(outcome.unconfirmed);
  if (child.pid && !groupAlive) {
    try { process.kill(-child.pid, 0); groupAlive = true; }
    catch (error) { if (error.code !== 'ESRCH') groupAlive = true; }
  }
  if (groupAlive) {
    child.unref(); child.channel?.unref();
    const error = new Error('Frozen macOS build process group has not terminated');
    error.retainOwnedSnapshot = true;
    error.ownedProcessGroup = child.pid;
    throw error;
  }
  if (interrupted) { const error = new Error(`Frozen macOS build interrupted (${interrupted})`); error.interruptedSignal = interrupted; throw error; }
  if (processError) throw processError;
  if (outcome.code !== 0 || outcome.signal) throw new Error(`${command} failed (${outcome.signal ?? outcome.code})`);
}

/** Materialize a private checkout without referencing the live worktree during the build. */
export async function withFrozenMacSnapshot({ sourceRoot, commit, env = process.env }, callback) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Invalid frozen macOS source commit');
  const source = await realpath(sourceRoot);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kcoder-macos-frozen-')));
  const owned = await lstat(root);
  const checkout = join(root, 'source');
  const sourceRelativeRoot = relative(source, await realpath(root));
  const safeEnv = cleanGitEnvironment(env);
  let result, primary;
  try {
    if (!sourceRelativeRoot || (!isAbsolute(sourceRelativeRoot) && sourceRelativeRoot !== '..' && !sourceRelativeRoot.startsWith(`..${sep}`))) {
      throw new Error('Frozen macOS snapshot must be outside the source repository');
    }
    await git(root, ['init', '--quiet', checkout], safeEnv);
    await git(checkout, ['fetch', '--quiet', '--no-tags', '--depth=1', '--', source, commit], safeEnv);
    await git(checkout, ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], safeEnv);
    if ((await git(checkout, ['rev-parse', 'HEAD'], safeEnv)).trim() !== commit) throw new Error('Frozen macOS source commit changed');
    const entries = (await git(checkout, ['ls-files', '--stage', '-z'], safeEnv)).split('\0').filter(Boolean);
    if (!entries.length || entries.some(entry => !/^100(?:644|755) [a-f0-9]{40} 0\t/.test(entry))) {
      throw new Error('Frozen macOS source contains unsupported links, submodules or index entries');
    }
    if ((await git(checkout, ['status', '--porcelain', '--untracked-files=all'], safeEnv)).trim()) throw new Error('Frozen macOS source checkout is not clean');
    result = await callback({ root, checkout });
  } catch (error) { primary = error; }
  if (primary?.retainOwnedSnapshot) { primary.ownedSnapshot = root; throw primary; }
  const current = await lstat(root).catch(() => null);
  if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) {
    const error = new Error('Frozen macOS snapshot ownership changed; cleanup was not attempted');
    if (primary) throw new AggregateError([primary, error], 'Frozen macOS build and owned snapshot cleanup failed');
    throw error;
  }
  try { await rm(root, { recursive: true, force: true }); }
  catch (error) {
    if (primary) throw new AggregateError([primary, error], 'Frozen macOS build and owned snapshot cleanup failed');
    throw error;
  }
  if (primary) throw primary;
  return result;
}
