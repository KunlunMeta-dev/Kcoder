import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createServer } from 'node:net';

/** Additive content-free counts and timing samples from existing Gateway observations. */
export function authReadStats(log) {
  const stats = { queued: 0, coalesced: 0, started: 0, completed: 0, failed: 0,
    queueSamples: 0, queueTotalMs: 0, readSamples: 0, readTotalMs: 0 };
  const addTiming = (kind, value) => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid authorization timing sample');
    stats[`${kind}Samples`]++;
    stats[`${kind}TotalMs`] += value;
  };
  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith('KCODER_AUTH_OBSERVE ')) continue;
    const value = JSON.parse(line.slice('KCODER_AUTH_OBSERVE '.length));
    if (value.component !== 'gateway_session') throw new Error('Unexpected authorization observation');
    if (value.stage === 'read_queued') stats.queued++;
    if (value.stage === 'read_coalesced') stats.coalesced++;
    if (value.stage === 'read_started') { stats.started++; addTiming('queue', value.queueMs); }
    if (value.stage === 'read_completed') {
      stats.completed++;
      if (value.failed) stats.failed++;
      addTiming('read', value.elapsedMs);
    }
  }
  return stats;
}

/** Aggregate complete redacted stdout records; merged stdout/stderr logs can interleave. */
export function observeAuthReads(context, source) {
  let pending = '', failure;
  const stats = authReadStats('');
  function data(chunk) {
    if (failure) return;
    try {
      pending += chunk.toString('utf8');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = context.redactText(pending.slice(0, end)); pending = pending.slice(end + 1);
        const added = authReadStats(line);
        for (const field of Object.keys(stats)) stats[field] += added[field];
      }
      if (pending.length > 64 * 1024) throw new Error('Authorization observation line exceeds the measurement bound');
    } catch (error) { failure = error; }
  }
  function end() {
    if (pending.startsWith('KCODER_AUTH_OBSERVE ')) failure ??= new Error('Incomplete authorization observation');
  }
  source.on('data', data); source.on('end', end);
  context.addCleanup('detach authorization observation', () => { source.off('data', data); source.off('end', end); });
  return () => { if (failure) throw failure; return { ...stats }; };
}

export function summarizeAuthFileTrace(trace, { pid, ledger, key, phases }) {
  if (!Array.isArray(trace.traceEvents) || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Invalid filesystem trace');
  const events = trace.traceEvents.filter(event => event.pid === pid && event.ph === 'b' &&
    typeof event.cat === 'string' && event.cat.split(',').includes('node.fs.async'));
  if (!events.some(event => event.name === 'open' && event.args?.path === ledger))
    throw new Error('Filesystem trace did not observe the real private ledger');
  return phases.map(phase => {
    if (!Number.isSafeInteger(phase.startUs) || !Number.isSafeInteger(phase.endUs) || phase.endUs < phase.startUs)
      throw new Error('Invalid filesystem measurement interval');
    const selected = events.filter(event => event.ts >= phase.startUs && event.ts < phase.endUs);
    return { name: phase.name, ledgerOpens: selected.filter(event => event.name === 'open' && event.args?.path === ledger).length,
      keyOpens: selected.filter(event => event.name === 'open' && event.args?.path === key).length,
      ledgerOpenOffsetsMs: selected.filter(event => event.name === 'open' && event.args?.path === ledger)
        .map(event => (event.ts - phase.startUs) / 1000),
      ledgerTemporaryOpens: selected.filter(event => event.name === 'open' && typeof event.args?.path === 'string' &&
        event.args.path.startsWith(`${ledger}.`) && event.args.path.endsWith('.tmp')).length,
      ledgerRenames: selected.filter(event => event.name === 'rename' && event.args?.new_path === ledger).length,
      fsyncCalls: selected.filter(event => ['fsync', 'fdatasync'].includes(event.name)).length,
      operations: Object.fromEntries([...new Set(selected.map(event => event.name))].sort()
        .map(name => [name, selected.filter(event => event.name === name).length])) };
  });
}


/** Occupy the owned POSIX ledger's legacy mutex without touching its credentials. */
export async function holdAuthStoreMutex(context, directory) {
  const info = await lstat(directory);
  if (process.platform !== 'linux' || !info.isDirectory() || info.isSymbolicLink())
    throw new Error('Auth mutex fault requires an owned Linux directory');
  const identity = `local-file:${info.dev}:${info.ino}`;
  const port = 49152 + (parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 8), 16) % 16384);
  const server = createServer(socket => socket.destroy());
  const release = async () => {
    if (server.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  };
  context.addCleanup('release auth ledger mutex fault', release);
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, done);
  });
  context.registerPort('auth-ledger-mutex-fault', port);
  return release;
}
