import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod, lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  openRegistrationStore,
  REGISTRATION_STORE_ERROR_CODES as CODES,
} from '../src/registration-store.mjs';

const MAX_STORE_BYTES = 256 * 1024;
const MODULE_URL = pathToFileURL(new URL('../src/registration-store.mjs', import.meta.url).pathname).href;

function token() {
  return randomBytes(32).toString('base64url');
}

function pairingToken() {
  return randomBytes(32).toString('hex');
}

async function makeStorePath(t, name = 'registration.json') {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-registration-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, name);
}

async function assertCode(promise, code) {
  await assert.rejects(promise, error => error?.code === code);
}

function gatewayKeys(gateway) {
  return Object.keys(gateway).sort();
}

test('register saves isolated credentials, exposes no proof hash, and retries idempotently across restart', async t => {
  const path = await makeStorePath(t);
  const enrollmentToken = token();
  const gatewayPairingToken = pairingToken();
  const expectedKeys = ['id', 'secret', 'pairingToken', 'maxConnections', 'maxBytesPerWindow', 'trafficWindowMs'].sort();

  const store = await openRegistrationStore({ path });
  const first = await store.register({ enrollmentToken, pairingToken: gatewayPairingToken });
  assert.deepEqual(gatewayKeys(first), expectedKeys);
  assert.match(first.id, /^[a-f0-9]{32}$/);
  assert.match(first.secret, /^[a-f0-9]{64}$/);
  assert.notEqual(first.id, first.secret);
  assert.notEqual(first.secret, gatewayPairingToken);
  assert.deepEqual(first, {
    id: first.id,
    secret: first.secret,
    pairingToken: gatewayPairingToken,
    maxConnections: 128,
    maxBytesPerWindow: 67_108_864,
    trafficWindowMs: 60_000,
  });

  const returnedCopy = await store.register({ enrollmentToken, pairingToken: gatewayPairingToken });
  assert.deepEqual(returnedCopy, first);
  returnedCopy.secret = 'caller mutation';
  const listed = store.list();
  assert.deepEqual(listed, [first]);
  listed[0].secret = 'list mutation';
  assert.deepEqual(store.list(), [first]);

  const storedBytes = await readFile(path);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(path, '..'))).mode & 0o777, 0o700);
  const storedText = storedBytes.toString('utf8');
  const document = JSON.parse(storedText);
  assert.equal(storedText.includes(enrollmentToken), false);
  assert.equal(document.gateways[0].enrollmentTokenHash, createHash('sha256').update(enrollmentToken).digest('hex'));
  assert.deepEqual(Object.keys(document.gateways[0]).sort(), ['id', 'secret', 'pairingToken', 'enrollmentTokenHash'].sort());

  await assertCode(store.register({ enrollmentToken, pairingToken: pairingToken() }), CODES.unauthorized);
  await assertCode(store.register({ enrollmentToken: token(), pairingToken: gatewayPairingToken }), CODES.conflict);
  await store.close();

  const reopened = await openRegistrationStore({ path });
  assert.deepEqual(reopened.list(), [first]);
  assert.deepEqual(await reopened.register({ enrollmentToken, pairingToken: gatewayPairingToken }), first);
  await reopened.close();
});

test('rejects malformed proof, caller-selected identity fields, and proof collisions with Gateway credentials', async t => {
  const path = await makeStorePath(t);
  const store = await openRegistrationStore({ path });
  await assertCode(store.register({ enrollmentToken: 'human-readable-password-which-is-long', pairingToken: pairingToken() }), CODES.unauthorized);
  await assertCode(store.register({ enrollmentToken: token(), pairingToken: pairingToken(), id: 'chosen' }), CODES.unauthorized);

  const proof = token();
  await assertCode(store.register({ enrollmentToken: proof, pairingToken: proof }), CODES.unauthorized);
  const firstPairingToken = pairingToken();
  const first = await store.register({ enrollmentToken: proof, pairingToken: firstPairingToken });
  await assertCode(store.register({ enrollmentToken: firstPairingToken, pairingToken: pairingToken() }), CODES.unauthorized);
  await assertCode(store.register({ enrollmentToken: token(), pairingToken: first.secret }), CODES.conflict);
  await assertCode(store.register({ enrollmentToken: token(), pairingToken: first.id }), CODES.conflict);
  assert.equal(store.list().length, 1);
  await store.close();
});

test('serializes concurrent calls, gives one identity to concurrent retries, and enforces capacity', async t => {
  const path = await makeStorePath(t);
  const store = await openRegistrationStore({ path, maxGateways: 3 });
  const sameRequest = { enrollmentToken: token(), pairingToken: pairingToken() };
  const concurrentRetries = await Promise.all(Array.from({ length: 12 }, () => store.register(sameRequest)));
  assert.ok(concurrentRetries.every(gateway => gateway.id === concurrentRetries[0].id && gateway.secret === concurrentRetries[0].secret));

  const otherRequests = [
    { enrollmentToken: token(), pairingToken: pairingToken() },
    { enrollmentToken: token(), pairingToken: pairingToken() },
    { enrollmentToken: token(), pairingToken: pairingToken() },
  ];
  const results = await Promise.allSettled(otherRequests.map(request => store.register(request)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === CODES.capacity).length, 1);
  assert.equal(store.list().length, 3);
  await store.close();
});

test('rejects a second process while this process owns the store lock', async t => {
  const path = await makeStorePath(t);
  const store = await openRegistrationStore({ path });
  const childSource = [
    `import { openRegistrationStore } from ${JSON.stringify(MODULE_URL)};`,
    `try { const store = await openRegistrationStore({ path: ${JSON.stringify(path)} }); await store.close(); process.stdout.write('OPENED'); }`,
    `catch (error) { process.stdout.write(error.code || 'UNKNOWN'); }`,
  ].join('\n');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, CODES.locked);
  await store.close();
});

test('recovers a dead lock only when PID start identity proves the owner changed', async t => {
  const path = await makeStorePath(t);
  const lockPath = `${path}.lock`;
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    processStart: 'not-the-current-process-start',
    startedAt: Date.now() - 60_000,
    owner: randomBytes(24).toString('hex'),
  })}\n`, { mode: 0o600 });
  await chmod(lockPath, 0o600);
  const store = await openRegistrationStore({ path });
  assert.equal(store.list().length, 0);
  await store.close();
});

test('callback checks static conflicts before commit and cannot mutate store-owned credentials', async t => {
  const path = await makeStorePath(t);
  const store = await openRegistrationStore({ path });
  const request = { enrollmentToken: token(), pairingToken: pairingToken() };
  let observed;
  await assertCode(store.register(request, {
    validateGateway(candidate) {
      observed = candidate;
      assert.equal(Object.isFrozen(candidate), true);
      throw Object.assign(new Error('static collision'), { code: CODES.conflict });
    },
  }), CODES.conflict);
  assert.equal(store.list().length, 0);
  assert.equal(observed.pairingToken, request.pairingToken);

  const created = await store.register(request, {
    validateGateway(candidate) {
      assert.equal(Object.isFrozen(candidate), true);
      return 'ignored';
    },
  });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].secret, created.secret);
  await store.close();
});

test('maxGateways zero opens an empty store and rejects new registrations', async t => {
  const path = await makeStorePath(t);
  const store = await openRegistrationStore({ path, maxGateways: 0 });
  assert.deepEqual(store.list(), []);
  await assertCode(store.register({ enrollmentToken: token(), pairingToken: pairingToken() }), CODES.capacity);
  await store.close();
});

test('does not update memory when a registration cannot fit the bounded persisted image', async t => {
  const path = await makeStorePath(t);
  const gateways = [];
  for (let index = 0; index < 256; index += 1) {
    const suffix = String(index).padStart(12, '0');
    const candidate = {
      id: index.toString(16).padStart(32, '0'),
      secret: (index + 1).toString(16).padStart(64, '0'),
      pairingToken: `${'\\'.repeat(500)}${suffix}`,
      enrollmentTokenHash: createHash('sha256').update(`fixture-${index}`).digest('hex'),
    };
    const next = { version: 1, gateways: [...gateways, candidate] };
    if (Buffer.byteLength(`${JSON.stringify(next)}\n`) > MAX_STORE_BYTES) break;
    gateways.push(candidate);
  }
  assert.ok(gateways.length > 0 && gateways.length < 256);
  const seed = Buffer.from(`${JSON.stringify({ version: 1, gateways })}\n`);
  assert.ok(seed.length <= MAX_STORE_BYTES);
  await writeFile(path, seed, { mode: 0o600 });
  await chmod(path, 0o600);

  const store = await openRegistrationStore({ path, maxGateways: 256 });
  const originalCount = store.list().length;
  const originalFile = await readFile(path);
  await assertCode(store.register({
    enrollmentToken: token(),
    pairingToken: `${'\\'.repeat(500)}999999999999`,
  }), CODES.tooLarge);
  assert.equal(store.list().length, originalCount);
  assert.deepEqual(await readFile(path), originalFile);
  await store.close();

  const reopened = await openRegistrationStore({ path, maxGateways: 256 });
  assert.equal(reopened.list().length, originalCount);
  await reopened.close();
});

test('refuses store files with broad permissions, symbolic links, invalid UTF-8, duplicate keys, or unknown schema fields', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-registration-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const broadPath = join(directory, 'broad.json');
  await writeFile(broadPath, '{"version":1,"gateways":[]}\n', { mode: 0o644 });
  await chmod(broadPath, 0o644);
  await assertCode(openRegistrationStore({ path: broadPath }), CODES.unsafe);

  const targetPath = join(directory, 'target.json');
  await writeFile(targetPath, '{"version":1,"gateways":[]}\n', { mode: 0o600 });
  await chmod(targetPath, 0o600);
  const linkPath = join(directory, 'link.json');
  await symlink(targetPath, linkPath);
  await assertCode(openRegistrationStore({ path: linkPath }), CODES.unsafe);

  const ancestorTarget = join(directory, 'ancestor-target');
  await mkdir(ancestorTarget, { mode: 0o700 });
  const ancestorLink = join(directory, 'ancestor-link');
  await symlink(ancestorTarget, ancestorLink, 'dir');
  const traversedPath = join(ancestorLink, 'nested', 'registration.json');
  await assertCode(openRegistrationStore({ path: traversedPath }), CODES.unsafe);
  await assert.rejects(lstat(join(ancestorTarget, 'nested')), error => error.code === 'ENOENT');

  const invalidUtf8Path = join(directory, 'invalid-utf8.json');
  await writeFile(invalidUtf8Path, Buffer.from([0xff, 0xfe]), { mode: 0o600 });
  await chmod(invalidUtf8Path, 0o600);
  await assertCode(openRegistrationStore({ path: invalidUtf8Path }), CODES.corrupt);

  const duplicateKeyPath = join(directory, 'duplicate-key.json');
  await writeFile(duplicateKeyPath, '{"version":1,"version":1,"gateways":[]}\n', { mode: 0o600 });
  await chmod(duplicateKeyPath, 0o600);
  await assertCode(openRegistrationStore({ path: duplicateKeyPath }), CODES.corrupt);

  const unknownFieldPath = join(directory, 'unknown-field.json');
  await writeFile(unknownFieldPath, '{"version":1,"gateways":[],"other":true}\n', { mode: 0o600 });
  await chmod(unknownFieldPath, 0o600);
  await assertCode(openRegistrationStore({ path: unknownFieldPath }), CODES.corrupt);
});

test('refuses a changed store target without changing the in-memory registry', async t => {
  const path = await makeStorePath(t);
  const store = await openRegistrationStore({ path });
  await mkdir(path);
  await assertCode(store.register({ enrollmentToken: token(), pairingToken: pairingToken() }), CODES.unsafe);
  assert.deepEqual(store.list(), []);
  await rm(path, { recursive: true, force: true });
  const created = await store.register({ enrollmentToken: token(), pairingToken: pairingToken() });
  assert.equal(store.list()[0].id, created.id);
  await store.close();
});

test('filesystem write failure leaves memory unchanged and permits an idempotent retry', async t => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // Exercise the real denial under an unprivileged identity, even in root CI.
    // Isolation=none keeps the exact child owned by spawnSync's timeout.
    const result = spawnSync(process.execPath, [
      '--experimental-test-isolation=none', '--test', '--test-name-pattern',
      '^filesystem write failure leaves memory unchanged and permits an idempotent retry$',
      fileURLToPath(import.meta.url),
    ], {
      uid: 65534, gid: 65534, encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: '/tmp', TMPDIR: '/tmp' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# pass 1\b/);
    return;
  }
  const path = await makeStorePath(t);
  const store = await openRegistrationStore({ path });
  const request = { enrollmentToken: token(), pairingToken: pairingToken() };
  const parentPath = join(path, '..');
  await chmod(parentPath, 0o500);
  await assertCode(store.register(request), CODES.persistence);
  assert.deepEqual(store.list(), []);
  await chmod(parentPath, 0o700);

  const created = await store.register(request);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, created.id);
  await store.close();
});

test('returns stable operational error codes and rejects incompatible existing capacity', async t => {
  const emptyPath = await makeStorePath(t);
  await assertCode(openRegistrationStore({ path: emptyPath, maxGateways: -1 }), CODES.invalidOptions);
  await assertCode(openRegistrationStore({ path: emptyPath, unknown: true }), CODES.invalidOptions);

  const populatedPath = await makeStorePath(t);
  const store = await openRegistrationStore({ path: populatedPath });
  await store.register({ enrollmentToken: token(), pairingToken: pairingToken() });
  await store.close();
  await assertCode(openRegistrationStore({ path: populatedPath, maxGateways: 0 }), CODES.storeCapacity);
});
