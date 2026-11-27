import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationStoreLease, closeApplicationHost } from '../src/applications/host-lifecycle.mjs';
import { publicError } from '../src/errors.mjs';

const initial = () => ({ leaseId: 'owned', namespaceId: 'namespace', stage: 'initializing', expiresAt: Date.now() + 30000 });
const flush = () => new Promise(setImmediate);

test('Ready commits wait for the original renewal and cannot be overwritten by an older stage', async t => {
  let finish; const calls = []; const start = initial();
  const lease = new ApplicationStoreLease(start, { connected: () => true, call: async method => {
    calls.push(method);
    if (method === 'private.store.renewLease') return new Promise(resolve => { finish = resolve; });
    return { ...start, stage: 'ready', expiresAt: Date.now() + 30000 };
  } });
  t.after(() => lease.stop());
  const renewing = lease.update('private.store.renewLease'); await flush();
  const committing = lease.update('private.store.commitReady'); await flush();
  assert.deepEqual(calls, ['private.store.renewLease']);
  finish(start); await Promise.all([renewing, committing]);
  assert.deepEqual(calls, ['private.store.renewLease', 'private.store.commitReady']);
  assert.equal(lease.permits('ready'), true); assert.equal(lease.permits('initializing'), false);
});

test('a failed renewal removes permission until a fresh valid Native proof is received', async t => {
  let fail = true; const start = { ...initial(), stage: 'ready' };
  const lease = new ApplicationStoreLease(start, { connected: () => true, call: async () => {
    if (fail) throw new Error('fixture unavailable');
    return { ...start, expiresAt: Date.now() + 30000 };
  } });
  t.after(() => lease.stop());
  assert.equal(lease.permits('ready'), true);
  await assert.rejects(lease.update('private.store.renewLease'));
  assert.equal(lease.permits('ready'), false);
  fail = false; await lease.update('private.store.renewLease');
  assert.equal(lease.permits('ready'), true);
});

test('stopping waits for its outstanding renewal and cannot publish another usable lease', async () => {
  let finish; const start = { ...initial(), stage: 'ready' };
  const lease = new ApplicationStoreLease(start, { connected: () => true,
    call: () => new Promise(resolve => { finish = resolve; }) });
  const renewing = lease.update('private.store.renewLease'); await flush();
  let stopped = false; const stopping = lease.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false); assert.equal(lease.permits('ready'), false);
  finish(start); await Promise.all([renewing, stopping]);
  assert.equal(stopped, true); assert.equal(lease.permits('ready'), false);
});

test('cleanup attempts every owned resource after faults and reports only the fixed public error', async () => {
  const calls = [];
  const fail = name => () => { calls.push(name); throw new Error('fixture private detail ' + name); };
  await assert.rejects(closeApplicationHost({ lease: { leaseId: 'owned', stop: fail('lease-stop') },
    service: { close: fail('service') }, store: { close: fail('store') },
    peer: { closed: false, call: async (method, params, timeoutMs) => {
      calls.push('release'); assert.equal(method, 'private.store.releaseLease');
      assert.deepEqual(params, { leaseId: 'owned' }); assert.equal(timeoutMs, 3000);
    }, close() { calls.push('peer'); } }, run: Promise.resolve(),
  }), error => {
    assert.equal(error.code, 'APPLICATION_HOST_CLEANUP_UNCONFIRMED');
    assert.equal(JSON.stringify(publicError(error)).includes('fixture private detail'), false);
    return true;
  });
  assert.deepEqual(calls, ['lease-stop', 'service', 'store', 'release', 'peer']);
});
