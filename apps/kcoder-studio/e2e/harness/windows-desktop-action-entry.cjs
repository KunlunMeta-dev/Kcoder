// A scheduled interactive task starts this entry. The existing native supervisor
// owns the actor and its native children; no personal process is adopted.
async function awaitOwnedDesktopActor(child, identity, { exitTimeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(exitTimeoutMs) || exitTimeoutMs < 1 || exitTimeoutMs > 30000) throw Error('Invalid owned desktop exit deadline');
  let closed = identity.closed === true;
  let closeListener;
  const ended = identity.closedPromise
    ? identity.closedPromise.then(result => { closed = true; return result?.code ?? child.exitCode; })
    : child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve(child.exitCode).then(code => { closed = true; return code; })
      : new Promise(resolve => {
        closeListener = code => { closed = true; resolve(code); };
        child.once('close', closeListener);
      });
  let errorListener;
  const failed = new Promise((_, reject) => {
    errorListener = error => reject(error);
    child.on('error', errorListener);
  });
  void failed.catch(() => {});
  const boundedExit = async () => {
    let timer;
    try { await Promise.race([ended, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Owned desktop supervisor exit unconfirmed')), exitTimeoutMs);
    })]); } finally { clearTimeout(timer); }
  };
  let primaryFailure, code;
  const cleanupFailures = [];
  try {
    await Promise.race([identity.readyPromise, failed, ended.then(() => { throw Error('Owned desktop actor exited before READY'); })]);
    code = await Promise.race([ended, failed]);
  } catch (error) { primaryFailure = error; }
  try {
    try { child.stdin.destroy(); }
    catch (error) { cleanupFailures.push(error); }
    try { await boundedExit(); }
    catch {
      // A ChildProcess error is not proof of exit. Keep waiting for its close.
      try { child.kill(); }
      catch (error) { cleanupFailures.push(error); }
      try { await boundedExit(); }
      catch (error) { cleanupFailures.push(error); }
    }
  } finally {
    const detach = () => {
      child.removeListener('error', errorListener);
      if (closeListener) child.removeListener('close', closeListener);
    };
    if (closed) detach();
    else child.once('close', detach);
  }
  if (cleanupFailures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures],
    closed ? 'Owned desktop cleanup failed' : 'Owned desktop cleanup unconfirmed');
  if (primaryFailure) throw primaryFailure;
  return code;
}
exports.awaitOwnedDesktopActor = awaitOwnedDesktopActor;

async function main() {
  const { join } = require('node:path');
  const { readFile, writeFile, mkdir } = require('node:fs/promises');
  const { execFileSync } = require('node:child_process');
  const root = process.argv[5];
  if (process.argv.includes('--desktop-action-worker')) {
    const { runWindowsDesktopActionUnknown } = await import('./windows-desktop-action-unknown.mjs');
    console.log(JSON.stringify(await runWindowsDesktopActionUnknown(root))); return;
  }
  const input = JSON.parse(await readFile(join(root, 'desktop-input.json'), 'utf8'));
  const ticks = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`], { encoding: 'utf8', timeout: 10000 }).trim();
  await writeFile(join(root, 'probe-owner.json'), JSON.stringify({ owner: input.owner, pid: process.pid,
    creationTicks: ticks, creationKind: 'process-start-time' }));
  process.env.KCODER_E2E_PROCESS_SUPERVISOR_BIN = join(root, 'app/resources/bin/kcoder-process-supervisor.exe');
  const { spawnWindowsSupervised } = await import('./owned-process.mjs');
  await mkdir(join(root, 'process-status'), { recursive: true });
  const { child, identity } = spawnWindowsSupervised(process.execPath,
    [...process.argv.slice(1), '--desktop-action-worker'], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }, join(root, 'process-status'));
  let output = '', error = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { error = (error + value).slice(-4096); });
  const code = await awaitOwnedDesktopActor(child, identity);
  if (code !== 0) throw new Error(`Owned desktop actor failed (${code}): ${error}`);
  console.log(output.trim());
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
