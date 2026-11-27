import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authReadStats, observeAuthReads, summarizeAuthFileTrace, holdAuthStoreMutex } from './auth-read-cost.mjs';

test('authorization observations count checks without retaining payloads or accepting malformed diagnostics', () => {
  const line = facts => `KCODER_AUTH_OBSERVE ${JSON.stringify({ component: 'gateway_session', ...facts })}`;
  assert.deepEqual(authReadStats(['unrelated log', line({ stage: 'read_queued' }), line({ stage: 'read_started' }),
    line({ stage: 'read_completed', failed: true }), line({ stage: 'renew_completed' })].join('\n')),
  { queued: 1, coalesced: 0, started: 1, completed: 1, failed: 1, queueSamples: 0, queueTotalMs: 0, readSamples: 0, readTotalMs: 0 });
  assert.throws(() => authReadStats('KCODER_AUTH_OBSERVE invalid'), SyntaxError);
});

test('coalescing events measure reuse separately from actual inspections without inventing old-log samples', () => {
  const line = stage => `KCODER_AUTH_OBSERVE ${JSON.stringify({ component: 'gateway_session', stage })}`;
  const stats = authReadStats(['read_queued', 'read_coalesced', 'read_coalesced', 'read_started', 'read_completed']
    .map(line).join('\n'));
  assert.equal(stats.queued, 1);
  assert.equal(stats.coalesced, 2);
  assert.equal(stats.started, 1);
});

test('authorization timing totals distinguish measured zero from absent samples without retaining other facts', () => {
  const line = facts => `KCODER_AUTH_OBSERVE ${JSON.stringify({ component: 'gateway_session', ...facts })}`;
  const stats = authReadStats([
    line({ stage: 'read_queued' }),
    line({ stage: 'read_started', queueMs: 3, remainingMs: 12345 }),
    line({ stage: 'read_started', queueMs: 0 }),
    line({ stage: 'read_started' }),
    line({ stage: 'read_completed', elapsedMs: 7, valid: true }),
    line({ stage: 'read_completed', elapsedMs: 2, failed: true }),
    line({ stage: 'read_completed' }),
    line({ stage: 'renew_completed', elapsedMs: 100 }),
  ].join('\n'));
  assert.deepEqual(stats, { queued: 1, coalesced: 0, started: 3, completed: 3, failed: 1,
    queueSamples: 2, queueTotalMs: 3, readSamples: 2, readTotalMs: 9 });
  assert.equal(JSON.stringify(stats).includes('12345'), false);
});

test('malformed timing samples cannot become plausible zero or inflated measurements', () => {
  for (const value of [null, -1, 0.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    for (const [stage, field] of [['read_started', 'queueMs'], ['read_completed', 'elapsedMs']]) {
      const line = 'KCODER_AUTH_OBSERVE ' + JSON.stringify({ component: 'gateway_session', stage, [field]: value });
      assert.throws(() => authReadStats(line), /timing/);
    }
  }
});

test('live observation waits for complete stdout records, redacts, bounds buffers and detaches', () => {
  const source = new PassThrough(), cleanups = [], redacted = [];
  const context = { redactText: value => { redacted.push(value); return value; }, addCleanup: (_, close) => cleanups.push(close) };
  const counts = observeAuthReads(context, source);
  const prefix = 'KCODER_AUTH_OBSERVE ';
  source.write(`${prefix}{"component":"gateway_session",`);
  assert.equal(counts().queued, 0);
  source.write('"stage":"read_queued"}\n');
  assert.equal(counts().queued, 1);
  assert.equal(redacted.length, 1);
  const before = counts();
  source.write(`${prefix}{"component":"gateway_session","stage":"read_started","queueMs":0}\n`);
  source.write(`${prefix}{"component":"gateway_session","stage":"read_completed","elapsedMs":8}\n`);
  const after = counts();
  const delta = Object.fromEntries(Object.keys(before).map(field => [field, after[field] - before[field]]));
  assert.deepEqual(delta, { queued: 0, coalesced: 0, started: 1, completed: 1, failed: 0,
    queueSamples: 1, queueTotalMs: 0, readSamples: 1, readTotalMs: 8 });
  assert.equal(before.readSamples, 0, 'later observations cannot mutate a previous phase snapshot');
  source.write(`${prefix}bad\n`);
  assert.throws(counts, SyntaxError);
  cleanups.pop()(); assert.equal(source.listenerCount('data'), 0);
  const bounded = new PassThrough(), snapshot = observeAuthReads(context, bounded);
  bounded.write('x'.repeat(65537)); assert.throws(snapshot, /bound/); cleanups.pop()();
});

test('filesystem measurements isolate the Gateway PID, phase and ledger and expose only counts', () => {
  const ledger = '/owned/private/devices.json', key = '/owned/private/.key';
  const event = (name, ts, args = {}, more = {}) => ({ name, ts, args, pid: 7, ph: 'b', cat: 'node,node.fs.async', ...more });
  const trace = { traceEvents: [event('open', 1, { path: ledger }), event('open', 10, { path: ledger }),
    event('open', 11, { path: key }), event('open', 12, { path: ledger }, { ph: 'e' }),
    event('open', 13, { path: ledger }, { pid: 8 }), event('open', 14, { path: `${ledger}.owned.tmp` }),
    event('fsync', 15), event('rename', 16, { old_path: `${ledger}.owned.tmp`, new_path: ledger }), event('open', 30, { path: key })] };
  const [summary] = summarizeAuthFileTrace(trace, { pid: 7, ledger, key, phases: [{ name: 'warm', startUs: 10, endUs: 20 }] });
  assert.deepEqual(summary, { name: 'warm', ledgerOpens: 1, keyOpens: 1, ledgerOpenOffsetsMs: [0], ledgerTemporaryOpens: 1, ledgerRenames: 1, fsyncCalls: 1,
    operations: { fsync: 1, open: 3, rename: 1 } });
  assert.equal(JSON.stringify(summary).includes('/owned'), false);
  assert.throws(() => summarizeAuthFileTrace({ traceEvents: [] }, { pid: 7, ledger, key, phases: [] }), /did not observe/);
  assert.throws(() => summarizeAuthFileTrace(trace, { pid: 7, ledger, key, phases: [{ startUs: 20, endUs: 10 }] }), /interval/);
});


for (const failRegistration of [false, true]) test(`auth mutex fault releases its owned port after ${failRegistration ? 'registration failure' : 'use'}`, async t => {
  if (process.platform !== 'linux') return t.skip('Linux fault-injection harness');
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-auth-lock-fault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cleanups = []; let port;
  const context = {
    addCleanup(_label, callback) { cleanups.push(callback); },
    registerPort(_label, value) { port = value; if (failRegistration) throw new Error('registration refused'); },
  };
  try {
    if (failRegistration) await assert.rejects(holdAuthStoreMutex(context, directory), /registration refused/);
    else {
      const release = await holdAuthStoreMutex(context, directory);
      const probe = createServer();
      await assert.rejects(new Promise((done, reject) => {
        probe.once('error', reject); probe.listen({ host: '127.0.0.1', port, exclusive: true }, done);
      }), { code: 'EADDRINUSE' });
      await release();
    }
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  const available = createServer();
  try {
    await new Promise((done, reject) => {
      available.once('error', reject); available.listen({ host: '127.0.0.1', port, exclusive: true }, done);
    });
  } finally { if (available.listening) await new Promise(done => available.close(done)); }
});
