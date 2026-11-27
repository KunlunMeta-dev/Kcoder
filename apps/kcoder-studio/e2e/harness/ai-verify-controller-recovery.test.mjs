import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { assertOwnedControllerRequest, stopOwnedAiVerifyController } from './ai-verify-client.mjs';
import { processTreeAlive } from './owned-process.mjs';
import { RunContext, waitFor } from './run-context.mjs';

// The independent test owner retains its original RunContext; the client never inherits it.
const controllerFixture = `
const { createServer } = require('node:http');
const { writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');
const sessionPath = process.argv[1];
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/shutdown') {
    response.writeHead(404); response.end(); return;
  }
  void writeFile(join(dirname(sessionPath), 'shutdown-request.json'), JSON.stringify({ count: 1 }), { flag: 'wx', mode: 0o600 })
    .then(() => response.destroy(), () => { response.writeHead(409); response.end(); });
});
server.listen(0, '127.0.0.1', async () => {
  await writeFile(sessionPath, JSON.stringify({ version: 1, directory: dirname(sessionPath), gateway: true,
    status: 'running', controlUrl: 'http://127.0.0.1:' + server.address().port }), { mode: 0o600 });
});
`;

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

async function heldProcess(context, label) {
  const child = context.spawnOwned(label, process.execPath, ['-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 1000)"]);
  let output = '';
  child.stdout.on('data', bytes => { output += bytes.toString(); });
  await waitFor(() => output.includes('READY\n'), 5_000, `owned ${label} readiness`);
  return context.processes.get(label);
}

async function fixture(t) {
  const contexts = [];
  const create = async testId => {
    const context = await RunContext.create(import.meta.url, { testId });
    contexts.push(context);
    return context;
  };
  t.after(async () => {
    const results = await Promise.allSettled(contexts.reverse().map(context => context.finish('passed', { modelIndependent: true })));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  });
  const outer = await create('controller-transport-owner');
  const nested = await create('original-nested-resource-owner');
  const peer = await create('independent-peer-owner');
  const nestedProcess = await heldProcess(nested, 'nested-resource');
  const peerProcess = await heldProcess(peer, 'peer-resource');
  const sessionPath = join(nested.runRoot, 'session.json');
  await writeFile(sessionPath, JSON.stringify({ status: 'starting' }), { mode: 0o600 });
  const child = outer.spawnOwned('published-controller', process.execPath, ['-e', controllerFixture, sessionPath]);
  const session = await waitFor(async () => {
    const current = await readJson(sessionPath).catch(() => null);
    return current?.controlUrl ? current : null;
  }, 5_000, 'owned controller publication');
  outer.registerPort('controller-transport', Number(new URL(session.controlUrl).port));
  const stopController = () => outer.stopOwned('published-controller');
  const assertPeerAlive = async () => {
    assert.equal(await processTreeAlive(peerProcess.child, peerProcess.identity), true);
    await access(peer.stateDir);
  };
  return { outer, nested, nestedProcess, peerProcess, sessionPath, session, child, stopController, assertPeerAlive };
}

test('published controller death preserves unknown nested authority and an independently owned peer', {
  skip: process.platform !== 'linux' ? 'Actual isolated POSIX process-group fixture requires Linux' : false,
}, async t => {
  const { outer, nested, nestedProcess, sessionPath, child, stopController, assertPeerAlive } = await fixture(t);
  const manifestBefore = await readFile(join(nested.runRoot, 'manifest.json'), 'utf8');
  const sessionBefore = await readFile(sessionPath, 'utf8');
  const closed = new Promise(accept => child.once('close', accept));
  child.kill('SIGKILL');
  await closed;
  let shutdownAttempts = 0;
  const stop = () => stopOwnedAiVerifyController({
    run: nested, sessionPath, child, stopController,
    requestShutdown: async () => {
      shutdownAttempts++;
      assertOwnedControllerRequest(child, true, '/shutdown');
    },
    finalizeUnpublished: async () => assert.fail('A published run cannot use empty-context finalization'),
  });
  await assert.rejects(stop(), error => error instanceof AggregateError && error.errors.some(item => /preserve the original run/.test(item.message)));
  assert.equal(shutdownAttempts, 1);
  assert.equal(await readFile(sessionPath, 'utf8'), sessionBefore);
  assert.equal(await readFile(join(nested.runRoot, 'manifest.json'), 'utf8'), manifestBefore);
  assert.equal(await processTreeAlive(nestedProcess.child, nestedProcess.identity), true);
  await access(nested.stateDir);
  await assert.rejects(access(join(nested.artifactsDir, 'result.json')), { code: 'ENOENT' });
  await assertPeerAlive();

  // This cleanup uses the retained original owner, independently of the failed client.
  await nested.finish('passed', { scope: 'original authority cleanup only' });
  assert.equal(await processTreeAlive(nestedProcess.child, nestedProcess.identity), false);
  await assert.rejects(access(nested.stateDir), { code: 'ENOENT' });
  await assertPeerAlive();
  // Even absent state and a real independent result cannot invent the lost session receipt.
  await assert.rejects(stop(), error => error instanceof AggregateError && error.errors.some(item => /remains unknown/.test(item.message)));
  assert.equal(await readFile(sessionPath, 'utf8'), sessionBefore);
  await outer.writeArtifactJson('controller-death-proof.json', {
    nestedRunRoot: nested.runRoot, peerPreserved: true, sessionReceiptPreserved: true,
    clientCleanup: 'unknown', independentOriginalOwnerCleanup: 'confirmed',
  });
});

test('a lost shutdown reply reconciles original cleanup without replay or peer cleanup', {
  skip: process.platform !== 'linux' ? 'Actual isolated POSIX process-group fixture requires Linux' : false,
}, async t => {
  const { outer, nested, nestedProcess, sessionPath, session, child, stopController, assertPeerAlive } = await fixture(t);
  let shutdownAttempts = 0;
  const result = await stopOwnedAiVerifyController({
    run: nested, sessionPath, child, stopController,
    requestShutdown: async () => {
      shutdownAttempts++;
      let transportFailure;
      try { await fetch(`${session.controlUrl}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(3_000) }); }
      catch (error) { transportFailure = error; }
      assert.ok(transportFailure, 'The actual controller must drop its shutdown response');
      assert.deepEqual(await readJson(join(nested.runRoot, 'shutdown-request.json')), { count: 1 });
      await nested.finish('passed', { scope: 'original authority cleanup after accepted shutdown' });
      await writeFile(sessionPath, JSON.stringify({ version: 1, directory: nested.runRoot, gateway: true, status: 'stopped' }), { mode: 0o600 });
      throw transportFailure;
    },
    finalizeUnpublished: async () => assert.fail('A lost shutdown reply cannot authorize empty-context finalization'),
  });
  assert.equal(result.cleaned, true);
  assert.equal(result.shutdownRequestUnconfirmed, true);
  assert.equal(shutdownAttempts, 1);
  assert.equal(await processTreeAlive(nestedProcess.child, nestedProcess.identity), false);
  await assert.rejects(access(nested.stateDir), { code: 'ENOENT' });
  assert.equal(child.signalCode, 'SIGTERM');
  await assertPeerAlive();
  await outer.writeArtifactJson('lost-shutdown-reply-proof.json', {
    nestedRunRoot: nested.runRoot, shutdownAttempts, peerPreserved: true,
    originalCleanupResult: await readJson(join(nested.artifactsDir, 'result.json')),
  });
});
