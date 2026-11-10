import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { linuxDescendantIdentities, parseLinuxProcessStat, parseLinuxResidentBytes } from './migration-large-history.mjs';

/** A known read lease contention is unavailable evidence, never permission to replay a write. */
export async function observeSmallAssetRead(rpc, method, params, { trace, deadline, signal,
  clock = () => performance.now(), sleep = ms => pause(ms, undefined, { signal }) }) {
  assert.ok(['migration/batch/read', 'migration/batch/control/read', 'migration/items'].includes(method));
  for (let attempt = 0; attempt < 251 && clock() < deadline; attempt++) {
    signal?.throwIfAborted();
    try { return await rpc.request(method, params); }
    catch (error) {
      if (error?.message !== 'migration_busy') throw error;
      assert.ok(trace.length < 4000, 'small-asset read observation budget');
      trace.push({ at: clock(), method, jobId: params.jobId, observation: 'migration_busy' });
    }
    await sleep(Math.min(20, Math.max(0, deadline - clock())));
  }
  throw new Error('The original small-asset read remained unavailable at its bounded observation deadline');
}

/** A UI observation deadline is not a new execution authority. */
export async function observeSmallAssetFinish({ visible, rpc, jobId, run, initialSequence, terminalStatus, activeStatus,
  deadline, phaseDeadline = deadline, extensionMs = 90000, trace, signal,
  clock = () => performance.now(), sleep = ms => pause(ms, undefined, { signal }) }) {
  assert.ok([90000, 420000].includes(extensionMs), 'only the declared functional observation budgets are valid');
  let visibleTerminal = false;
  try { await visible(Math.max(1, Math.min(300000, deadline - clock(), phaseDeadline - clock()))); visibleTerminal = true; }
  catch (error) { if (error?.name !== 'TimeoutError') throw error; }
  const allowance = visibleTerminal ? 5000 : extensionMs;
  const limit = Math.min(deadline, phaseDeadline, clock() + allowance), original = run();
  assert.ok(original && original.jobId === jobId && original.requestId && original.planId, 'the original explicit execution must be observed');
  let sequence = initialSequence;
  trace.push({ event: visibleTerminal ? 'terminal_ui_visible_waiting_owner_stop' : 'initial_ui_observation_timeout', at: clock(), limit });
  for (let index = 0; index < Math.ceil(allowance / 500) + 1 && clock() < limit; index++) {
    signal?.throwIfAborted();
    const value = await rpc.request('migration/batch/read', { jobId });
    const job = value.state.job;
    assert.equal(job.jobId, jobId); assert.equal(value.workerError, null);
    assert.ok(Number.isSafeInteger(job.sequence) && job.sequence >= sequence, 'the same job sequence must not move backwards');
    trace.push({ at: clock(), sequence: job.sequence, status: job.status, committedItems: job.committedItems, workerRunning: value.workerRunning });
    if (value.workerRunning === false) {
      assert.equal(job.status, terminalStatus); assert.equal(job.hasUnconfirmedOutcomes, false);
      if (!visibleTerminal) await visible(Math.max(1, Math.min(5000, limit - clock())));
      return;
    }
    assert.equal(value.workerRunning, true);
    assert.ok(job.status === activeStatus || job.status === terminalStatus, 'unexpected terminal or unknown worker state');
    if (job.status === terminalStatus) assert.equal(job.hasUnconfirmedOutcomes, false);
    assert.ok(job.sequence > initialSequence, 'a silent execution cannot extend its observation deadline');
    const control = await rpc.request('migration/batch/control/read', { jobId });
    assert.equal(control.jobId, jobId); assert.equal(control.phase, 'tracked');
    assert.equal(control.generation.planId, original.planId); assert.equal(control.generation.runRequestId, original.requestId);
    assert.equal(control.generation.mode, original.mode);
    sequence = job.sequence;
    await sleep(Math.min(500, Math.max(0, limit - clock())));
  }
  throw new Error('The original small-asset worker remained active at the bounded observation deadline');
}

/** Keep only a fixed process role; command arguments may contain private paths or tokens. */
export function smallAssetProcessRole(argv) {
  const type = argv.find(value => value.startsWith('--type='))?.slice(7);
  return type === undefined ? 'browser' : ['renderer', 'gpu-process', 'utility', 'zygote', 'broker'].includes(type) ? type : 'other-child';
}

/** Coarse, bounded diagnostic facts complement the unchanged200ms acceptance sampler. */
export async function startSmallAssetDiagnostics(context, { roots, page }) {
  let phase = 'ready', stopped = false, timer, pending = Promise.resolve(), result, fault = null;
  const samples = [], roles = new Map(), started = performance.now();
  const proc = async value => {
    const stat = parseLinuxProcessStat(await readFile(`/proc/${value.pid}/stat`, 'utf8'));
    assert.equal(stat.startTicks, value.startTicks);
    const status = parseLinuxResidentBytes(await readFile(`/proc/${value.pid}/status`, 'utf8'));
    const role = smallAssetProcessRole((await readFile(`/proc/${value.pid}/cmdline`, 'utf8')).split('\0'));
    assert.equal(parseLinuxProcessStat(await readFile(`/proc/${value.pid}/stat`, 'utf8')).startTicks, value.startTicks);
    return { pid: value.pid, startTicks: value.startTicks, role, rssBytes: status.rss };
  };
  const sample = async () => {
    assert.ok(samples.length < 200 && roles.size < 256, 'diagnostic observation budget');
    let browserRssBytes = 0, processCount = 0;
    for (const identity of await linuxDescendantIdentities(roots.browser)) {
      let value;
      try { value = await proc(identity); } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
      browserRssBytes += value.rssBytes; processCount++;
      const key = `${value.pid}:${value.startTicks}`, previous = roles.get(key);
      roles.set(key, { ...value, peakRssBytes: Math.max(value.rssBytes, previous?.peakRssBytes ?? 0) });
    }
    const [gateway, native] = await Promise.all([proc(roots.gateway), proc(roots.native)]);
    let heapTimer;
    const heap = await Promise.race([
      page.evaluate(() => {
        const memory = performance.memory;
        return { available: !!memory, usedJsHeapBytes: memory?.usedJSHeapSize ?? null,
          totalJsHeapBytes: memory?.totalJSHeapSize ?? null, jsHeapLimitBytes: memory?.jsHeapSizeLimit ?? null,
          domElements: document.getElementsByTagName('*').length };
      }).catch(() => ({ available: false })),
      new Promise(resolve => { heapTimer = setTimeout(() => resolve({ available: false }), 2000); }),
    ]).finally(() => clearTimeout(heapTimer));
    samples.push({ atMs: performance.now() - started, phase, browserRssBytes, processCount,
      gatewayRssBytes: gateway.rssBytes, nativeRssBytes: native.rssBytes, pageHeap: heap });
  };
  const step = () => { pending = sample().catch(() => { fault ??= 'diagnostic_observation_unavailable'; }).finally(() => {
    if (!stopped && samples.length < 200) timer = setTimeout(step, 5000);
  }); };
  const stop = async () => {
    if (result) return result;
    stopped = true; clearTimeout(timer); await pending;
    const peak = samples.reduce((best, value) => !best || value.browserRssBytes > best.browserRssBytes ? value : best, null);
    result = { intervalMs: 5000, samples, processes: [...roles.values()], coarseObservedBrowserPeak: peak, fault,
      scope: 'Read-only numeric page heap and owned PID roles/RSS; no forced GC, source text or command arguments. Coarse peak time is not the200ms acceptance peak time.' };
    await context.writeArtifactJsonInternal('migration-small-assets-diagnostics.json', result); return result;
  };
  context.addCleanup('stop owned small-asset read-only diagnostics', stop);
  step();
  return { mark(value) {
    assert.ok(['ready', 'discovery', 'planning', 'apply', 'cancel', 'resume', 'reopen', 'undo', 'complete', 'failure'].includes(value)); phase = value;
  }, stop };
}
