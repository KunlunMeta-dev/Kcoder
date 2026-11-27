import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createPeerSshPinStore } from './remotes/peer-ssh-pin-store.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'kcoder-peer-ssh-race-')); await chmod(root, 0o700);
  const children = [], store = createPeerSshPinStore({ directory: root });
  t.after(async () => {
    for (const owner of children) await owner.close();
    await store.close(); await rm(root, { recursive: true, force: true });
  });
  await store.initialize();
  let sequence = 0;
  const worker = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./remotes/__fixtures__/peer-ssh-controller-race-worker.mjs', import.meta.url)), root],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    const pending = new Map(), events = new Map(), listeners = new Map(); let errors = '';
    child.stderr.on('data', value => { errors = (errors + value).slice(-16384); });
    const ended = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const owner = { async close() {
      if (child.exitCode === null && child.signalCode === null) {
        send({ close: true }); child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await ended; clearTimeout(timer);
      }
    } };
    children.push(owner);
    const wait = name => events.has(name) ? Promise.resolve(events.get(name)) : new Promise(resolve => listeners.set(name, resolve));
    const input = createInterface({ input: child.stdout });
    input.on('line', line => {
      const value = JSON.parse(line);
      if (value.event) { const name = value.event === 'ready' ? 'ready' : `${value.event}:${value.id}`; events.set(name, value); listeners.get(name)?.(value); }
      else { pending.get(value.id)?.(value); pending.delete(value.id); }
    });
    child.once('close', () => { for (const resolve of pending.values()) resolve({ workerError: `Owned worker exited: ${errors}` }); pending.clear(); });
    await wait('ready');
    return { request(action, body = {}, flags = {}) {
      const id = `owned-${++sequence}`;
      const response = new Promise(resolve => pending.set(id, resolve)); send({ id, action, body, ...flags });
      return { id, response };
    }, wait: (event, id) => wait(`${event}:${id}`), release: (event, id) => send({ release: `${event}:${id}` }) };
  };
  const effects = async () => { try { return (await readFile(join(root, 'native-effects.log'), 'utf8')).trim().split('\n').filter(Boolean); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { root, store, worker, effects };
}

test('two actual Gateway processes persist only one pending proposal for a scope', { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.worker(), b = await f.worker();
  const first = a.request('prepare', {}, { holdPrepare: true }), second = b.request('prepare', {}, { holdPrepare: true });
  await Promise.all([a.wait('prepare_wait', first.id), b.wait('prepare_wait', second.id)]);
  a.release('prepare_wait', first.id); b.release('prepare_wait', second.id);
  const responses = await Promise.all([first.response, second.response]);
  assert.deepEqual(responses.map(row => row.status).sort(), [200, 409]);
  assert.equal((await f.store.read()).proposals.length, 1); assert.deepEqual(await f.effects(), []);
});

test('cross-process discard prevents an in-flight original apply before its dispatch CAS', { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.worker(), b = await f.worker();
  const proposal = (await a.request('prepare').response).body;
  const reference = { proposalId: proposal.proposalId, digest: proposal.digest };
  const applying = a.request('apply', reference, { holdBody: true }); await a.wait('body_wait', applying.id);
  const discarded = await b.request('discard', reference).response; assert.equal(discarded.status, 200); assert.equal(discarded.body.phase, 'discarded');
  a.release('body_wait', applying.id);
  assert.equal((await applying.response).body.error, 'PEER_SSH_PROPOSAL_DISCARDED');
  assert.deepEqual(await f.effects(), []);
  assert.equal((await f.store.read()).proposals[0].phase, 'discarded');
});

test('cross-process dispatch wins atomically and blocks discard or a replacement proposal', { timeout: 20000 }, async t => {
  const f = await fixture(t), a = await f.worker(), b = await f.worker();
  const proposal = (await a.request('prepare').response).body;
  const reference = { proposalId: proposal.proposalId, digest: proposal.digest };
  const applying = a.request('apply', reference, { holdNative: true }); await a.wait('native_wait', applying.id);
  assert.equal((await b.request('discard', reference).response).body.externalOutcome, 'unknown');
  assert.equal((await b.request('prepare').response).body.externalOutcome, 'unknown');
  assert.equal((await b.request('status').response).body.pinStatus, 'setup_unconfirmed');
  a.release('native_wait', applying.id); assert.equal((await applying.response).status, 200);
  assert.equal((await f.effects()).length, 1);
});
