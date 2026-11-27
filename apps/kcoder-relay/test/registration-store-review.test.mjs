import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { openRegistrationStore, REGISTRATION_STORE_ERROR_CODES as CODES } from '../src/registration-store.mjs';

const password = 'Owned regression password 2026!';
const token = () => randomBytes(32).toString('base64url');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-registration-review-'));
  const path = join(directory, 'registration.json');
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, path, async open() {
    const store = await openRegistrationStore({ path }); stores.push(store); return store;
  } };
}

test('password verification cannot publish a session after its store has closed', async t => {
  const f = await fixture(t), store = await f.open();
  await store.createAccount({ username: 'owner', password, maxGateways: 1 });
  const original = await readFile(f.path), identity = await lstat(f.path);
  const signingIn = store.signInAccount({ username: 'owner', password }, token());
  const rejected = assert.rejects(signingIn, { code: CODES.closed });
  await store.close();
  await rejected;
  assert.deepEqual(await readFile(f.path), original);
  const after = await lstat(f.path);
  assert.equal(after.ino, identity.ino);
  assert.equal(after.dev, identity.dev);
});

test('reconciling one active sign-in token preserves its first session and expiry', async t => {
  const f = await fixture(t), store = await f.open(), proof = token();
  await store.createAccount({ username: 'owner', password, maxGateways: 1 });
  const first = await store.signInAccount({ username: 'owner', password }, proof);
  const bytes = await readFile(f.path);
  const second = await store.signInAccount({ username: 'owner', password }, proof);
  assert.deepEqual(second, first);
  assert.deepEqual(await readFile(f.path), bytes, 'a receipt lookup must not extend the session or append another authority');
  await store.createAccount({ username: 'peer', password, maxGateways: 1 });
  await assert.rejects(store.signInAccount({ username: 'peer', password }, proof), { code: CODES.conflict });
  assert.equal(store.getAccountSession(proof).id, first.id);
  await store.revokeAccountSession(proof);
  assert.equal(store.getAccountSession(proof), null);
  await store.close();
  const reopened = await f.open();
  assert.equal(reopened.getAccountSession(proof), null);
});

test('logout revokes every old record for one token while preserving another session', async t => {
  const f = await fixture(t), store = await f.open(), proof = token(), peerProof = token();
  await store.createAccount({ username: 'owner', password, maxGateways: 1 });
  await store.signInAccount({ username: 'owner', password }, proof);
  const peer = await store.signInAccount({ username: 'owner', password }, peerProof);
  await store.close();
  const document = JSON.parse(await readFile(f.path, 'utf8'));
  document.activationCodes.push({ ...document.activationCodes[0], id: randomBytes(16).toString('hex'),
    codeHash: randomBytes(32).toString('hex') });
  await writeFile(f.path, JSON.stringify(document));
  const reopened = await f.open();
  assert.ok(reopened.getAccountSession(proof));
  await reopened.revokeAccountSession(proof);
  assert.equal(reopened.getAccountSession(proof), null);
  assert.deepEqual(reopened.getAccountSession(peerProof), peer);
  await reopened.close();
  const final = await f.open();
  assert.equal(final.getAccountSession(proof), null);
  assert.deepEqual(final.getAccountSession(peerProof), peer);
});

test('opening an existing directory preserves peer identity and entries', async t => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'peer.txt'), 'owned peer data');
  const before = await lstat(f.directory);
  const opened = await openRegistrationStore({ path: f.path });
  await opened.close();
  const after = await lstat(f.directory);
  assert.equal(after.ino, before.ino);
  assert.equal(await readFile(join(f.directory, 'peer.txt'), 'utf8'), 'owned peer data');
});

test('failed initialization removes only the still-held newly created lock candidate', async t => {
  const f = await fixture(t), originalOpen = fs.open;
  let injected = false;
  const mocked = t.mock.method(fs, 'open', async (path, flags, ...rest) => {
    const handle = await originalOpen(path, flags, ...rest);
    if (basename(path) !== 'metadata.json' || !basename(dirname(path)).startsWith('.registration-lock-candidate-') || !(flags & constants.O_CREAT)) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === 'writeFile') return async () => { injected = true; throw Object.assign(new Error('owned lock write failed'), { code: 'EIO' }); };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  });
  try { await assert.rejects(openRegistrationStore({ path: f.path }), { code: CODES.unsafe }); }
  finally { mocked.mock.restore(); }
  assert.equal(injected, true);
  await assert.rejects(lstat(`${f.path}.lock`), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.directory), []);
  const store = await f.open();
  assert.deepEqual(store.list(), []);
});

test('repeated close preserves an unconfirmed original lock release instead of reporting success', async t => {
  const f = await fixture(t), store = await openRegistrationStore({ path: f.path });
  const originalUnlink = fs.unlink;
  let firstFailure, attempts = 0;
  const mocked = t.mock.method(fs, 'unlink', async (path, ...rest) => {
    if (path === `${f.path}.lock`) {
      attempts++; throw Object.assign(new Error('owned lock release failed'), { code: 'EIO' });
    }
    return originalUnlink(path, ...rest);
  });
  try {
    firstFailure = await store.close().then(() => assert.fail('release must fail'), error => error);
    assert.equal(firstFailure.code, CODES.unsafe);
    await assert.rejects(store.close(), error => error === firstFailure);
    assert.equal(attempts, 1, 'waiting on the original cleanup must not replay unlink');
    await lstat(`${f.path}.lock`);
    assert.throws(() => store.list(), { code: CODES.closed });
  } finally { mocked.mock.restore(); }
});

test('failed loading preserves the original error and exposes unconfirmed owned lock cleanup', async t => {
  const f = await fixture(t), originalUnlink = fs.unlink;
  await writeFile(f.path, '{"version":');
  let attempts = 0;
  const mocked = t.mock.method(fs, 'unlink', async (path, ...rest) => {
    if (path === `${f.path}.lock`) {
      attempts++; throw Object.assign(new Error('owned cleanup EIO detail'), { code: 'EIO' });
    }
    return originalUnlink(path, ...rest);
  });
  try {
    await assert.rejects(openRegistrationStore({ path: f.path }), error => {
      assert.equal(error.code, CODES.corrupt);
      assert.equal(error.cleanupUnconfirmed, true);
      assert.equal(error.cleanupError.code, CODES.unsafe);
      assert.equal(JSON.stringify(error).includes('owned cleanup EIO detail'), false);
      return true;
    });
    await assert.rejects(openRegistrationStore({ path: f.path }), { code: CODES.locked });
    assert.equal(attempts, 1);
  } finally { mocked.mock.restore(); }
});
