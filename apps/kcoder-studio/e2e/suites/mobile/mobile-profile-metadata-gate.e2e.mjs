import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { runE2E, repoRoot, waitFor } from '../../harness/run-context.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { startFixtureSite } from '../../harness/fixture-site.mjs';

await runE2E(import.meta.url, { testId: 'mobile-idb-metadata-authority-prototype', tier: 'full-integration', modelPolicy: 'model-independent actual browser IndexedDB primitive only; not a claim that Mobile profile/account production has been fixed' }, async context => {
  const moduleSource = await readFile(resolve(repoRoot, 'apps/kcoder-studio/mobile/src/storage/idb-metadata-gate.mjs'), 'utf8');
  const workerSource = await readFile(new URL('./mobile-profile-metadata-gate.worker.mjs', import.meta.url), 'utf8');
  const host = Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address;
  assert.ok(host, 'UNMET_PREREQUISITE: actual non-loopback HTTP interface');
  const site = await startFixtureSite(context, { host, assets: { '/metadata-gate.mjs': { contentType: 'text/javascript; charset=utf-8', body: moduleSource }, '/owner.worker.mjs': { contentType: 'text/javascript; charset=utf-8', body: workerSource } } });
  const browser = await startChromium(context, { label: 'profile-metadata-gate-browser' });
  const first = await browser.newPersistentPage(), second = await browser.newPersistentPage();
  for (const page of [first, second]) {
    await page.goto(site.url);
    await page.evaluate(async () => { if (isSecureContext || navigator.locks !== undefined) throw Error('Expected real ordinary HTTP without Web Locks'); const { createIndexedMetadataGate } = await import('/metadata-gate.mjs'); globalThis.gate = createIndexedMetadataGate({ indexedDB }); });
  }
  await first.evaluate(() => { globalThis.owner = gate.run('gateway-profile-index', async lease => { await lease.effect(() => localStorage.setItem('synthetic-profile', 'generation-one')); globalThis.entered = true; await new Promise(resolve => { globalThis.release = resolve; }); await lease.effect(() => localStorage.setItem('synthetic-intent', 'owned-before-delete')); }); });
  await waitFor(() => first.evaluate(() => globalThis.entered === true), 3000, 'first real UA owner');
  await second.evaluate(() => { globalThis.deletion = gate.run('gateway-profile-index', async lease => { globalThis.deleted = true; await lease.effect(() => { localStorage.removeItem('synthetic-profile'); localStorage.removeItem('synthetic-intent'); }); }); });
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(await second.evaluate(() => globalThis.deleted === true), false, 'another realm cannot enter while metadata owner remains live');
  await first.evaluate(() => globalThis.release()); await second.evaluate(() => globalThis.deletion);
  assert.equal(await second.evaluate(() => localStorage.getItem('synthetic-profile')), null); assert.equal(await second.evaluate(() => localStorage.getItem('synthetic-intent')), null);
  const nested = await second.evaluate(() => gate.run('gateway-profile-index', async outer => gate.run('profile-metadata:synthetic', async inner => gate.run('gateway-profile-index', async ancestor => { ancestor.assert(); inner.assert(); return await ancestor.effect(() => 'explicit-ancestor-reentry'); }, { parent: inner }), { parent: outer })));
  assert.equal(nested, 'explicit-ancestor-reentry');
  await second.evaluate(async () => { globalThis.worker = new Worker('/owner.worker.mjs', { type: 'module' }); globalThis.workerAcquired = new Promise(resolve => { worker.onmessage = event => resolve(event.data); }); });
  assert.equal((await second.evaluate(() => globalThis.workerAcquired)).acquired, true);
  const third = await browser.newPersistentPage(); await third.goto(site.url); await third.evaluate(async () => { const { createIndexedMetadataGate } = await import('/metadata-gate.mjs'); globalThis.gate = createIndexedMetadataGate({ indexedDB }); globalThis.peer = gate.run('gateway-profile-index', lease => { lease.assert(); globalThis.acquiredAfterCrash = true; }); });
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(await third.evaluate(() => globalThis.acquiredAfterCrash === true), false);
  await second.evaluate(() => globalThis.worker.terminate()); await third.evaluate(() => globalThis.peer);
  assert.equal(await third.evaluate(() => globalThis.acquiredAfterCrash), true);
  const boxed = await third.evaluate(async () => { let finish; const response = new Promise(resolve => { finish = resolve; }); const started = await gate.run('gateway-profile-index', lease => { lease.assert(); return { response }; }); let acquired = false; await gate.run('gateway-profile-index', lease => { lease.assert(); acquired = true; }); finish('response-settled-outside'); return { acquired, response: await started.response }; });
  assert.deepEqual(boxed, { acquired: true, response: 'response-settled-outside' });
  await third.evaluate(() => { globalThis.cancelledOwner = new AbortController(); globalThis.cancelled = gate.run('gateway-profile-index', async lease => { globalThis.cancelEntered = true; await new Promise(resolve => { globalThis.finishCancelledMetadata = resolve; }); await lease.effect(() => localStorage.setItem('late-old-authority', 'must-not-write')); }, { signal: cancelledOwner.signal }).catch(() => 'revoked'); });
  await waitFor(() => third.evaluate(() => globalThis.cancelEntered === true), 3000, 'cancellable metadata owner');
  await third.evaluate(() => globalThis.cancelledOwner.abort());
  await second.evaluate(() => { globalThis.afterCancel = gate.run('gateway-profile-index', lease => { lease.assert(); globalThis.cancelPeer = true; }); });
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(await second.evaluate(() => globalThis.cancelPeer === true), false, 'cancellation does not release a live metadata callback early');
  await third.evaluate(() => globalThis.finishCancelledMetadata()); assert.equal(await third.evaluate(() => globalThis.cancelled), 'revoked'); await second.evaluate(() => globalThis.afterCancel);
  assert.equal(await second.evaluate(() => localStorage.getItem('late-old-authority')), null);
  await third.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) { const transaction = original.apply(this, args); if (this.name.includes('metadata-gate-v1:')) globalThis.abortableMetadata = transaction; return transaction; };
    globalThis.abortedOwner = gate.run('gateway-profile-index', async lease => {
      globalThis.abortEntered = true; await new Promise(resolve => { globalThis.finishAbortedMetadata = resolve; });
      await lease.effect(() => localStorage.setItem('late-after-ua-abort', 'must-not-write'));
    }).catch(() => 'revoked');
  });
  await waitFor(() => third.evaluate(() => globalThis.abortEntered === true), 3000, 'abortable UA metadata authority');
  await third.evaluate(() => globalThis.abortableMetadata.abort());
  assert.equal(await third.evaluate(() => globalThis.abortedOwner), 'revoked');
  await second.evaluate(() => gate.run('gateway-profile-index', async lease => await lease.effect(() => localStorage.setItem('new-after-ua-abort', 'peer-won'))));
  await third.evaluate(() => globalThis.finishAbortedMetadata());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await second.evaluate(() => localStorage.getItem('late-after-ua-abort')), null);
  assert.equal(await second.evaluate(() => localStorage.getItem('new-after-ua-abort')), 'peer-won');
  await first.evaluate(() => { globalThis.closingOwner = gate.run('gateway-profile-index', async lease => { lease.assert(); globalThis.closeEntered = true; await new Promise(() => {}); }); });
  await waitFor(() => first.evaluate(() => globalThis.closeEntered === true), 3000, 'page-owned metadata authority');
  await second.evaluate(() => { globalThis.afterClose = gate.run('gateway-profile-index', lease => { lease.assert(); globalThis.closePeer = true; }); });
  await first.close(); await second.evaluate(() => globalThis.afterClose); assert.equal(await second.evaluate(() => globalThis.closePeer), true);
  await context.writeArtifactJson('metadata-gate-prototype.json', { passed: true, actualIndexedDB: true, ordinaryNonLoopbackHTTP: true, secureContext: false, WebLocksAbsent: true, twoRealmsSerialized: true, deleteWaitedForOwnedMetadata: true, explicitSameKeyAncestorReentry: true, differentKeyNestedWithoutStoreDeadlock: true, terminatedWorkerReleasedUAOwner: true, boxedNetworkResponseOutsideGate: true, cancellationKeptLiveCallbackHeld: true, revokedLeaseRejectedLateWrite: true, ownerPageCloseReleasedAuthority: true, unexpectedUAAbortRejectedLateEffect: true, scope: 'Primitive only. No production profile-store, refresh, authorization, deletion or LAN deployment completion claim.', sourceSha256: createHash('sha256').update(moduleSource).digest('hex'), modelRequests: 0 });
  return { primitiveCases: 8, modelRequests: 0 };
});
