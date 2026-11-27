import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const LARGE_HISTORY_BYTES = 500 * 1024 * 1024;
export const LARGE_HISTORY_RECORDS = 28;
export const LARGE_HISTORY_LIMITS = Object.freeze({
  nativeDeltaBytes: 128 * 1024 * 1024,
  gatewayDeltaBytes: 128 * 1024 * 1024,
  browserDeltaBytes: 256 * 1024 * 1024,
  cancelIntentMs: 1000,
  cancelStoppedMs: 5000,
  deadlineMs: 10 * 60 * 1000,
  intervalMs: 200,
});

/** Generate JSONL with a fixed 64 KiB payload buffer; never assemble the long record. */
export async function writeLargeHistoryFixture(sourceRoot, marker, totalBytes = LARGE_HISTORY_BYTES) {
  assert.ok(Number.isSafeInteger(totalBytes) && totalBytes >= 64 * 1024 && totalBytes <= LARGE_HISTORY_BYTES);
  const sessionId = randomUUID(), title = `500MiB-client-history-${randomUUID()}`;
  const file = resolve(sourceRoot, `projects/perf-project/${sessionId}.jsonl`);
  const program = resolve(sourceRoot, 'old-tool-must-not-run.sh');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(program, `#!/bin/sh\nprintf invoked > ${quote(marker)}\n`, { mode: 0o600, flag: 'wx' });
  const rows = [];
  for (let index = 0; index < 25; index++) rows.push({ type: 'user', uuid: `perf-${index}`,
    parentUuid: index ? `perf-${index - 1}` : null, sessionId,
    message: { role: 'user', content: index ? `Bounded historical row ${index}` : title } });
  rows.push({ type: 'assistant', uuid: 'perf-call', parentUuid: 'perf-24', sessionId,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'old-command', name: 'Bash', input: { command: `sh ${quote(program)}` } }] } });
  rows.push({ type: 'user', uuid: 'perf-result', parentUuid: 'perf-call', sessionId,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-command', content: 'Historical result received; no current execution authority.' }] } });
  const header = Buffer.from(rows.map(row => JSON.stringify(row) + '\n').join(''));
  const prefix = Buffer.from(JSON.stringify({ type: 'user', uuid: 'perf-long', parentUuid: 'perf-result', sessionId,
    message: { role: 'user', content: '' } }).replace('"content":""', '"content":"').slice(0, -2));
  const suffix = Buffer.from('"}}\n');
  const payloadBytes = totalBytes - header.length - prefix.length - suffix.length;
  assert.ok(payloadBytes > 0);
  const hash = createHash('sha256'), handle = await open(file, 'wx', 0o600);
  let bytes = 0;
  const append = async buffer => {
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.write(buffer, offset, buffer.length - offset);
      assert.ok(result.bytesWritten > 0);
      hash.update(buffer.subarray(offset, offset + result.bytesWritten));
      bytes += result.bytesWritten;
      offset += result.bytesWritten;
    }
  };
  try {
    await append(header); await append(prefix);
    const buffer = Buffer.alloc(64 * 1024, 'x');
    for (let left = payloadBytes; left > 0; left -= Math.min(left, buffer.length))
      await append(buffer.subarray(0, Math.min(left, buffer.length)));
    await append(suffix); await handle.sync();
  } finally { await handle.close(); }
  assert.equal(bytes, totalBytes);
  return { file, program, title, sessionId, bytes, payloadBytes, sha256: hash.digest('hex'), records: LARGE_HISTORY_RECORDS,
    longRecordIndex: 27, generationBufferBytes: 64 * 1024, cacheCondition: 'source generated immediately before run; warm filesystem page cache, no cold-cache claim' };
}

export async function hashHistoryFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

/** Pin accepted generated assets before starting the workload; later builds cannot mix it. */
export async function freezeLargeHistoryRenderer(context, sourceRoot, destination) {
  const source = await realpath(sourceRoot), target = resolve(destination);
  const owns = base => target.startsWith(resolve(base) + '/');
  assert.ok(owns(context.stateDir) || context.scratchDirectories.some(value => owns(value.path)), 'renderer snapshot must belong to this run');
  const inspect = async () => {
    const entries = []; let bytes = 0;
    const walk = async (relative = '', depth = 0) => {
      assert.ok(depth <= 16);
      for (const name of (await readdir(resolve(source, relative))).sort()) {
        const child = relative ? `${relative}/${name}` : name;
        const info = await lstat(resolve(source, child));
        assert.ok(!info.isSymbolicLink(), 'generated renderer snapshot rejects links');
        if (info.isDirectory()) { await walk(child, depth + 1); continue; }
        assert.ok(info.isFile() && info.size <= 64 * 1024 * 1024, 'unexpected renderer entry');
        bytes += info.size;
        assert.ok(entries.length < 20_000 && bytes <= 256 * 1024 * 1024, 'renderer snapshot budget exceeded');
        entries.push({ path: child, bytes: info.size, sha256: await hashHistoryFile(resolve(source, child)) });
      }
    };
    await walk(); return { entries, bytes };
  };
  const before = await inspect();
  assert.ok(before.entries.some(value => value.path === 'index.html'));
  await mkdir(target, { mode: 0o700 });
  for (const entry of before.entries) {
    const output = resolve(target, entry.path);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await copyFile(resolve(source, entry.path), output, constants.COPYFILE_EXCL);
    assert.equal(await hashHistoryFile(output), entry.sha256, 'renderer changed while being copied');
  }
  assert.deepEqual(await inspect(), before, 'renderer build changed during snapshot');
  const manifestSha256 = createHash('sha256').update(JSON.stringify(before.entries)).digest('hex');
  await context.writeArtifactJson('migration-large-history-renderer.json', { source, files: before.entries,
    bytes: before.bytes, manifestSha256, immutableForThisRun: true });
  return { root: target, files: before.entries.length, bytes: before.bytes, manifestSha256 };
}

export function parseLinuxProcessStat(text) {
  const match = /^(\d+) \((.*)\) (.+)$/s.exec(text.trim());
  assert.ok(match, 'invalid process stat');
  const fields = match[3].split(/\s+/);
  const value = { pid: Number(match[1]), ppid: Number(fields[1]), startTicks: fields[19] };
  assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.ppid) && /^\d+$/.test(value.startTicks));
  return value;
}
export function parseLinuxResidentBytes(text) {
  const rss = /^VmRSS:\s+(\d+) kB$/m.exec(text), peak = /^VmHWM:\s+(\d+) kB$/m.exec(text);
  assert.ok(rss && peak, 'process has no resident memory metadata');
  return { rss: Number(rss[1]) * 1024, hwm: Number(peak[1]) * 1024 };
}
export async function linuxReadCharacters(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const match = /^rchar:\s+(\d+)$/m.exec(await readFile(`/proc/${pid}/io`, 'utf8'));
  assert.ok(match); return Number(match[1]);
}
export async function linuxAvailableMemory() {
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(await readFile('/proc/meminfo', 'utf8'));
  assert.ok(match, 'Linux MemAvailable is required'); return BigInt(match[1]) * 1024n;
}

async function identity(pid, procRoot = '/proc') {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  return parseLinuxProcessStat(await readFile(resolve(procRoot, String(pid), 'stat'), 'utf8'));
}
async function memory(pid) {
  return parseLinuxResidentBytes(await readFile(`/proc/${pid}/status`, 'utf8'));
}
export async function linuxDescendantIdentities(root, procRoot = '/proc') {
  const result = [], queue = [root], seen = new Set();
  while (queue.length) {
    assert.ok(result.length < 128, 'owned process tree exceeds measurement budget');
    const parent = queue.shift();
    if (seen.has(parent.pid)) continue;
    seen.add(parent.pid); result.push(parent);
    const tasks = await readdir(resolve(procRoot, String(parent.pid), 'task')).catch(error => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    assert.ok(tasks.length <= 1024, 'owned thread list exceeds measurement budget');
    const children = new Set();
    for (const task of tasks) {
      assert.match(task, /^\d+$/);
      const raw = await readFile(resolve(procRoot, String(parent.pid), 'task', task, 'children'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return ''; throw error;
      });
      for (const leaf of raw.trim().split(/\s+/).filter(Boolean)) children.add(leaf);
    }
    for (const leaf of children) {
      assert.match(leaf, /^\d+$/);
      const child = await identity(Number(leaf), procRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (child?.ppid === parent.pid) queue.push(child);
    }
  }
  return result;
}

/** Attribute RSS to explicitly owned roots. Gateway excludes its Native descendants. */
export async function startLargeHistoryRssSampler(context, { browserPid, gatewayPid, nativePid, nativeBinary }) {
  assert.equal(process.platform, 'linux', 'actual /proc process identity is required');
  const roots = { browser: await identity(browserPid), gateway: await identity(gatewayPid), native: await identity(nativePid) };
  const nativeExecutable = await realpath(nativeBinary);
  assert.equal(await readlink(`/proc/${nativePid}/exe`), nativeExecutable);
  assert.ok((await linuxDescendantIdentities(roots.gateway)).some(value => value.pid === nativePid && value.startTicks === roots.native.startTicks),
    'reported Native PID must belong to this owned Gateway tree');
  const samples = [], lifetime = new Map();
  let baseline, timer, stopped = false, sampling = Promise.resolve(), fault, finalResult;
  const take = async () => {
    for (const root of Object.values(roots)) assert.equal((await identity(root.pid)).startTicks, root.startTicks, 'owned root identity changed');
    const nativeChildren = [];
    for (const value of await linuxDescendantIdentities(roots.gateway)) {
      const executable = await readlink(`/proc/${value.pid}/exe`).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (executable === nativeExecutable) nativeChildren.push(value.pid);
    }
    assert.deepEqual(nativeChildren, [nativePid], 'more than one Native process makes single-PID workload attribution ambiguous');
    const processes = await linuxDescendantIdentities(roots.browser);
    let browser = 0;
    for (const value of processes) {
      const current = await identity(value.pid).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!current || current.startTicks !== value.startTicks) continue;
      const status = await readFile(`/proc/${value.pid}/status`, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const measured = status && !/^State:\s+[XZ]/m.test(status) ? parseLinuxResidentBytes(status) : null;
      if (!measured) continue;
      browser += measured.rss;
      lifetime.set(`${value.pid}:${value.startTicks}`, { pid: value.pid, startTicks: value.startTicks,
        peakBytes: Math.max(measured.hwm, lifetime.get(`${value.pid}:${value.startTicks}`)?.peakBytes ?? 0) });
    }
    const gateway = await memory(gatewayPid), native = await memory(nativePid);
    const sample = { elapsedMs: samples.length ? performance.now() - baseline.at : 0, browser, gateway: gateway.rss, native: native.rss,
      nativeHwm: native.hwm, gatewayHwm: gateway.hwm, browserProcesses: processes.length };
    if (!baseline) baseline = { ...sample, at: performance.now() };
    assert.ok(samples.length < 4000, 'RSS sample budget exceeded'); samples.push(sample);
  };
  const step = () => {
    sampling = take().catch(error => { fault ??= error; }).finally(() => {
      if (!stopped) timer = setTimeout(step, LARGE_HISTORY_LIMITS.intervalMs);
    });
  };
  const stop = async () => {
    if (finalResult) return finalResult;
    stopped = true; clearTimeout(timer); await sampling;
    const peaks = samples.length ? Object.fromEntries(['browser', 'gateway', 'native'].map(key => [key, Math.max(...samples.map(value => value[key]))])) : null;
    const delta = peaks ? Object.fromEntries(Object.keys(peaks).map(key => [key, peaks[key] - baseline[key]])) : null;
    const result = { roots, baseline, sampleIntervalMs: LARGE_HISTORY_LIMITS.intervalMs, samples: samples.length,
      samplePeakRssBytes: peaks, peakDeltaBytes: delta, nativeLifetimeHwmBytes: Math.max(...samples.map(value => value.nativeHwm)),
      gatewayLifetimeHwmBytes: Math.max(...samples.map(value => value.gatewayHwm)), browserObservedProcesses: [...lifetime.values()],
      fault: fault?.message ?? null,
      scope: 'Browser is sampled aggregate RSS of current owned descendants; Gateway is its single PID, Native is its verified PID. RSS includes shared pages and is not PSS; aggregate transient peaks between samples may be missed.' };
    await context.writeArtifactJsonInternal('migration-large-history-rss.json', result);
    finalResult = result;
    return result;
  };
  context.addCleanup('flush owned large-history RSS measurement', stop);
  try { await take(); } catch (error) { fault = error; throw error; }
  step();
  return { stop, assertHealthy: () => { if (fault) throw fault; }, roots };
}
