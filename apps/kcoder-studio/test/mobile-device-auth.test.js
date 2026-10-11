import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, chmod, unlink, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMobileDeviceAuth } from '../src/mobile-device-auth.js';
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'kcoder-mobile-device-unit-')); t.after(() => rm(root, { recursive: true, force: true }));
 let time = 1000; const options = { directory: root, identity: 'synthetic-gateway-identity', accessTtlMs: 1000, idleTtlMs: 10000, absoluteTtlMs: 20000, socketGraceMs: 500, now: () => time };
 return { root, options, auth: createMobileDeviceAuth(options), advance: value => { time += value; } };
}
test('device refresh is hash-only, stable across restart, same rotation id is idempotent', async t => {
 const { root, options, auth, advance } = await fixture(t);
 const paired = await auth.pair('Synthetic device'); advance(200);
 const refreshed = await auth.refresh(paired.refreshToken, 'synthetic-rotation-01');
 assert.equal(refreshed.deviceId, paired.deviceId); assert.equal(refreshed.authorizationGeneration, paired.authorizationGeneration); assert.equal(refreshed.stableLoginOwner, paired.stableLoginOwner);
 assert.notEqual(refreshed.accessToken, paired.accessToken); assert.notEqual(refreshed.refreshToken, paired.refreshToken);
 assert.deepEqual(await createMobileDeviceAuth(options).refresh(paired.refreshToken, 'synthetic-rotation-01'), refreshed);
 const raw = await readFile(join(root, 'mobile-device-auth/devices.json'), 'utf8');
 for (const secret of [paired.refreshToken, refreshed.refreshToken, paired.accessToken, refreshed.accessToken]) assert.equal(raw.includes(secret), false);
 assert.ok(refreshed.wsLeaseExpiresAt > refreshed.expiresAt); assert.ok(refreshed.wsLeaseExpiresAt <= refreshed.refreshExpiresAt);
});
test('mobile pairing credential is stable for one week, expires at the boundary, and rotates on demand', async t => {
 const root = await mkdtemp(join(tmpdir(), 'kcoder-mobile-pairing-unit-')); t.after(() => rm(root, { recursive: true, force: true }));
 const week = 7 * 24 * 60 * 60_000; let time = week - 1000;
 const options = { directory: root, identity: 'synthetic-gateway-identity', now: () => time };
 const auth = createMobileDeviceAuth(options);
 const first = await auth.getPairingCredential();
 assert.equal(first.expiresAt, week);
 assert.deepEqual(await createMobileDeviceAuth(options).getPairingCredential(), first);
 assert.equal(await auth.matchesPairingCredential(first.token), true);
 const forced = await auth.rotatePairingCredential();
 assert.notEqual(forced.token, first.token);
 assert.equal(await auth.matchesPairingCredential(first.token), false);
 assert.equal(await auth.matchesPairingCredential(forced.token), true);
 time = week;
 const nextWindow = await auth.getPairingCredential();
 assert.equal(nextWindow.expiresAt, 2 * week);
 assert.notEqual(nextWindow.token, forced.token);
 assert.equal(await auth.matchesPairingCredential(forced.token), false);
});
test('default device authorization survives years and restart, but revocation still rejects it', async t => {
 const { root, advance, options } = await fixture(t);
 const perpetual = { ...options }; delete perpetual.idleTtlMs; delete perpetual.absoluteTtlMs;
 const auth = createMobileDeviceAuth(perpetual);
 const paired = await auth.pair('Persistent device');
 assert.equal(paired.refreshExpiresAt, Number.MAX_SAFE_INTEGER);
 assert.equal(paired.expiresAt, 2000);
 advance(20 * 365 * 86400_000);
 const restarted = createMobileDeviceAuth(perpetual);
 const renewed = await restarted.refresh(paired.refreshToken, 'persistent-rotation-01');
 assert.equal(renewed.refreshExpiresAt, Number.MAX_SAFE_INTEGER);
 assert.equal(renewed.deviceId, paired.deviceId);
 assert.equal((await restarted.list()).length, 1);
 const raw = await readFile(join(root, 'mobile-device-auth/devices.json'), 'utf8');
 assert.equal(raw.includes(paired.refreshToken), false);
 await restarted.revoke(paired.deviceId);
 await assert.rejects(restarted.refresh(renewed.refreshToken, 'persistent-rotation-02'), error => error.status === 401);
});
test('unlimited policy upgrades a live grant but does not resurrect an expired grant', async t => {
 const { options, auth, advance } = await fixture(t);
 const live = await auth.pair(); const expired = await auth.pair();
 const unlimited = { ...options, idleTtlMs: 0, absoluteTtlMs: 0 };
 const renewed = await createMobileDeviceAuth(unlimited).refresh(live.refreshToken, 'upgrade-rotation-01');
 assert.equal(renewed.refreshExpiresAt, Number.MAX_SAFE_INTEGER);
 advance(10001);
 await assert.rejects(createMobileDeviceAuth(unlimited).refresh(expired.refreshToken, 'upgrade-rotation-02'), error => error.status === 401);
 assert.equal((await createMobileDeviceAuth(unlimited).list()).length, 1);
});
test('parallel same rotation coalesces its durable result and conflicting previous token cannot rotate', async t => {
 const { auth, options } = await fixture(t); const paired = await auth.pair();
 const [a, b] = await Promise.all([auth.refresh(paired.refreshToken, 'synthetic-rotation-01'), createMobileDeviceAuth(options).refresh(paired.refreshToken, 'synthetic-rotation-01')]);
 assert.deepEqual(a, b);
 await assert.rejects(auth.refresh(paired.refreshToken, 'synthetic-rotation-02'), error => error.status === 409);
 assert.equal((await auth.list()).length, 1);
});
test('revocation and expiry reject refresh while device listing contains no secret', async t => {
 const { auth, advance } = await fixture(t); const paired = await auth.pair();
 assert.deepEqual(Object.keys((await auth.list())[0]).sort(), ['createdAt', 'expiresAt', 'id', 'label', 'lastUsedAt']);
 await auth.revoke(paired.deviceId); await assert.rejects(auth.refresh(paired.refreshToken, 'synthetic-rotation-01'), error => error.status === 401);
 const other = await auth.pair(); advance(10001); await assert.rejects(auth.refresh(other.refreshToken, 'synthetic-rotation-02'), error => error.status === 401);
});
test('missing key, unsafe file and changed Gateway identity fail closed for old credentials', async t => {
 const { root, options, auth } = await fixture(t); const paired = await auth.pair();
 await assert.rejects(createMobileDeviceAuth({ ...options, identity: 'other-identity' }).refresh(paired.refreshToken, 'synthetic-rotation-01'), error => error.status === 401);
 await chmod(join(root, 'mobile-device-auth/devices.json'), 0o644); await assert.rejects(auth.list(), /Unsafe/);
 await chmod(join(root, 'mobile-device-auth/devices.json'), 0o600); await unlink(join(root, 'mobile-device-auth/.key'));
 await assert.rejects(auth.refresh(paired.refreshToken, 'synthetic-rotation-01'), /key unavailable/);
});

test('lost refresh response recovers after access expiry without extending family lease', async t => {
 const { auth, options, advance } = await fixture(t); const paired = await auth.pair();
 const refreshed = await auth.refresh(paired.refreshToken, 'synthetic-rotation-01'); advance(1500);
 assert.deepEqual(await createMobileDeviceAuth(options).refresh(paired.refreshToken, 'synthetic-rotation-01'), refreshed);
 const renewed = await auth.refresh(refreshed.refreshToken, 'synthetic-rotation-02'); assert.ok(renewed.expiresAt > refreshed.expiresAt);
});
test('kernel mutex does not leave a stale ownership file after restart', async t => {
 const { auth, options, root } = await fixture(t); await auth.pair();
 await assert.rejects(readFile(join(root, 'mobile-device-auth/.lock')), error => error.code === 'ENOENT');
 assert.equal((await createMobileDeviceAuth(options).list()).length, 1);
});

test('kernel mutex is released after a holder process is killed', async t => {
 const { auth, root } = await fixture(t); await auth.pair();
 const info = await stat(join(root, 'mobile-device-auth')); const identity = `local-file:${info.dev}:${info.ino}`;
 const port = 49152 + (parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 8), 16) % 16384);
 const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'node:net';createServer().listen({host:'127.0.0.1',port:${port},exclusive:true},()=>process.stdout.write('locked'));`], { stdio: ['ignore', 'pipe', 'pipe'] });
 t.after(() => child.kill()); await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
 const listing = auth.list(); await new Promise(resolve => setTimeout(resolve, 30)); child.kill('SIGKILL');
 assert.equal((await listing).length, 1);
});
