import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runApplicationHost, PrivateParentPeer } from '../src/applications/stdio.mjs';
import { removeFixtureStore } from './store-fixture.mjs';

const flush = () => new Promise(setImmediate);
async function fixture(t, { ttlMs = 60000, holdRenewal = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'application-host-'));
  const input = new PassThrough(), output = new PassThrough();
  const parent = new PrivateParentPeer(output, input);
  const savedConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(key => [key, console[key]]));
  let ready, renewals = 0, active = 0, maximum = 0, stage = 'initializing';
  const releases = [], started = new Promise(resolve => { ready = resolve; });
  const lease = () => ({ leaseId: 'owned-lease', namespaceId: 'owned-namespace', initializationId: 'owned-initialization',
    storeMode: 'create', stage, expiresAt: Date.now() + ttlMs });
  parent.handler = async method => {
    if (method === 'private.host.configuration') return { enabled: true };
    if (method === 'private.store.acquireLease') return lease();
    if (method === 'private.store.commitReady') { stage = 'ready'; return lease(); }
    if (method === 'private.host.ready') { ready(); return {}; }
    if (method === 'private.store.renewLease') {
      renewals++; active++; maximum = Math.max(maximum, active);
      try { if (holdRenewal) await new Promise(resolve => releases.push(resolve)); return lease(); }
      finally { active--; }
    }
    if (method === 'private.store.releaseLease') return { released: true };
    throw new Error('Unexpected fixture method');
  };
  const parentRun = parent.run();
  const hostRun = runApplicationHost({ root, storeMode: 'create', initializationId: 'owned-initialization', input, output });
  t.after(async () => {
    for (const release of releases) release();
    input.end(); output.end(); await Promise.allSettled([hostRun, parentRun]);
    for (const [key, value] of Object.entries(savedConsole)) console[key] = value;
    removeFixtureStore(root);
  });
  await started; await flush();
  return { renewals: () => renewals, maximum: () => maximum, call: (...args) => parent.call(...args) };
}

test('the application host renews a short native lease before its actual expiry', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const host = await fixture(t, { ttlMs: 900 });
  t.mock.timers.tick(300); await flush();
  assert.equal(host.renewals(), 1);
});

test('slow native lease renewal cannot overlap later timer ticks', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  const host = await fixture(t, { holdRenewal: true });
  for (let index = 0; index < 3; index++) { t.mock.timers.tick(10000); await flush(); }
  assert.equal(host.renewals(), 1); assert.equal(host.maximum(), 1);
});

test('private metadata control methods reject malformed parameter envelopes with a typed error', async t => {
  const host = await fixture(t);
  for (const method of ['connectivity.resolveApplicationResources', 'connectivity.resolveApplicationConfiguration'])
    for (const params of [null, 4, []])
      await assert.rejects(host.call(method, params, 1000), { code: 'INVALID_REQUEST' });
});
