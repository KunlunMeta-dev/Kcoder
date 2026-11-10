import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parseLinuxProcessStat } from './migration-large-history.mjs';
import { observeSmallAssetFinish, observeSmallAssetRead, smallAssetProcessRole, startSmallAssetDiagnostics } from './migration-small-assets-observation.mjs';

const run = { jobId: 'original', requestId: 'original-resume', planId: 'original-plan', mode: 'resume' };
const timeout = () => Object.assign(new Error('visible deadline'), { name: 'TimeoutError' });
function fixture(rows) {
  let time = 1000, visible = 0;
  const methods = [], trace = [];
  return { trace, methods, get visibleCalls() { return visible; },
    options: { jobId: run.jobId, run: () => run, initialSequence: 10, terminalStatus: 'completed', activeStatus: 'applying',
      deadline: 600000, trace, clock: () => time, sleep: async ms => { time += ms; },
      visible: async () => { if (++visible === 1) throw timeout(); },
      rpc: { async request(method, params) {
        methods.push(method); assert.deepEqual(params, { jobId: run.jobId });
        if (method.endsWith('control/read')) return { jobId: run.jobId, phase: 'tracked', generation: { planId: run.planId, runRequestId: run.requestId, mode: run.mode } };
        return rows.shift() ?? { workerRunning: true, workerError: null, state: { job: { jobId: run.jobId, sequence: 11, status: 'applying', committedItems: 1 } } };
      } },
    } };
}
const active = { workerRunning: true, workerError: null, state: { job: { jobId: run.jobId, sequence: 11, status: 'applying', committedItems: 1, hasUnconfirmedOutcomes: true } } };
const terminal = { workerRunning: false, workerError: null, state: { job: { jobId: run.jobId, sequence: 12, status: 'completed', committedItems: 1024, hasUnconfirmedOutcomes: false } } };

test('only the same read may be reobserved after the exact finite busy constant, with no cancel replay', async () => {
  let time = 0, calls = 0; const trace = [], params = { jobId: run.jobId };
  const rpc = { async request(method, sent) {
    assert.equal(method, 'migration/batch/read'); assert.equal(sent, params);
    if (++calls < 3) throw new Error('migration_busy'); return terminal;
  } };
  const options = { trace, deadline: 100, clock: () => time, sleep: async ms => { time += ms; } };
  assert.equal(await observeSmallAssetRead(rpc, 'migration/batch/read', params, options), terminal);
  assert.equal(calls, 3); assert.equal(trace.length, 2);
  await assert.rejects(observeSmallAssetRead(rpc, 'migration/batch/control/cancel', params, options)); assert.equal(calls, 3);
  await assert.rejects(observeSmallAssetRead({ request: async () => { throw new Error('migration_batch_control_unknown'); } }, 'migration/batch/read', params, options), /control_unknown/);
  await assert.rejects(observeSmallAssetRead({ request: async () => { throw new Error('migration_busy'); } }, 'migration/batch/read', params, options), /bounded observation deadline/);
  assert.equal(time, 100);
});

test('a timeout only extends pure reads of the progressed original execution and still requires the visible terminal UI', async () => {
  const f = fixture([active, terminal]); await observeSmallAssetFinish(f.options);
  assert.deepEqual(f.methods, ['migration/batch/read', 'migration/batch/control/read', 'migration/batch/read']);
  assert.equal(f.visibleCalls, 2); assert.equal(f.trace[0].event, 'initial_ui_observation_timeout');
});
test('publishing the expected terminal checkpoint does not imply the original worker lease has stopped', async () => {
  for (const initiallyVisible of [false, true]) {
    const f = fixture([{ ...terminal, workerRunning: true }, terminal]);
    if (initiallyVisible) f.options.visible = async () => {};
    await observeSmallAssetFinish(f.options);
    assert.deepEqual(f.methods, ['migration/batch/read', 'migration/batch/control/read', 'migration/batch/read']);
    assert.equal(f.trace[1].workerRunning, true); assert.equal(f.trace[2].workerRunning, false);
  }
  const f = fixture([{ ...terminal, workerRunning: true, state: { job: { ...terminal.state.job, hasUnconfirmedOutcomes: true } } }]);
  await assert.rejects(observeSmallAssetFinish(f.options));
});
test('terminal failures, unknown owners, stale generations and no progress never poll until green', async () => {
  for (const row of [
    { ...terminal, state: { job: { ...terminal.state.job, status: 'failed' } } },
    { ...active, workerRunning: null }, { ...active, workerError: 'unknown' },
    { ...active, state: { job: { ...active.state.job, sequence: 10 } } },
    { ...active, state: { job: { ...active.state.job, status: 'commit_unknown' } } },
  ]) {
    const f = fixture([row, terminal]); await assert.rejects(observeSmallAssetFinish(f.options)); assert.equal(f.methods.length, 1);
  }
  const f = fixture([active]); f.options.run = () => ({ ...run, requestId: 'another-execution' });
  await assert.rejects(observeSmallAssetFinish(f.options)); assert.equal(f.methods.length, 2);
});
test('even a steadily owned worker receives no more than90s additional observation and no writes', async () => {
  const f = fixture([]); await assert.rejects(observeSmallAssetFinish(f.options), /bounded observation deadline/);
  assert.equal(f.trace.at(-1).at - f.trace[0].at, 89500);
  assert.equal(f.methods.length, 360); assert.ok(f.methods.every(method => method.endsWith('/read')));
});
test('the1024 Undo allowance is separately bounded by its original phase and total owner deadline', async () => {
  const f = fixture([]); f.options.extensionMs = 420000; f.options.phaseDeadline = 3000;
  await assert.rejects(observeSmallAssetFinish(f.options), /bounded observation deadline/);
  assert.equal(f.trace.at(-1).at, 2500); assert.equal(f.methods.length, 8);
  const invalid = fixture([]); invalid.options.extensionMs = 1200000;
  await assert.rejects(observeSmallAssetFinish(invalid.options), /declared functional/); assert.equal(invalid.methods.length, 0);
});
test('process facts retain a finite Chrome role and cannot emit command arguments or private paths', () => {
  assert.equal(smallAssetProcessRole(['chrome', '--user-data-dir=/owned/private', '--type=renderer', '--token=secret']), 'renderer');
  assert.equal(smallAssetProcessRole(['chrome', '--type=/private/value']), 'other-child');
  assert.equal(smallAssetProcessRole(['chrome', '--token=secret']), 'browser');
});
test('Linux read-only diagnostics cache their final artifact and stop their original timer', { skip: process.platform !== 'linux' }, async () => {
  const self = parseLinuxProcessStat(await readFile('/proc/self/stat', 'utf8')), artifacts = [], cleanups = [];
  const owner = await startSmallAssetDiagnostics({ addCleanup: (_label, action) => cleanups.push(action),
    writeArtifactJsonInternal: async (name, value) => artifacts.push({ name, value }) },
  { roots: { browser: self, gateway: self, native: self }, page: { evaluate: async () => ({ available: false }) } });
  owner.mark('resume'); const value = await owner.stop(); await cleanups[0]();
  assert.equal(artifacts.length, 1); assert.equal(value.fault, null); assert.equal(value.samples.length, 1);
  assert.ok(value.samples[0].browserRssBytes > 0); assert.equal(value.samples[0].phase, 'resume');
  assert.ok(value.processes.every(row => !Object.hasOwn(row, 'argv')));
});
