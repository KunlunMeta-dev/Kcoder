// Cross-tab authorization review against an immutable mobile source freeze.
// Chromium pages share real origin-scoped localStorage and Web Locks. Gateway
// refresh/revoke responses are scripted and contain only synthetic credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from '../mobile/node_modules/esbuild/lib/main.js';
import { chromium } from '../renderer/node_modules/@playwright/test/index.mjs';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const freezeRoot = process.env.PHONE_AUTH_CANDIDATE_ROOT;
const expectedDigest = process.env.PHONE_AUTH_CANDIDATE_DIGEST;
const expectedCount = Number(process.env.PHONE_AUTH_CANDIDATE_COUNT ?? 0);
const reviewEvidence = {
  candidateDigest: expectedDigest,
  candidateRoot: freezeRoot,
  expectedFiles: expectedCount,
  platform: process.platform,
  scenarios: [],
  pageErrors: [],
};

function check(condition, message) { if (!condition) throw new Error(message); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function fixtureProfile(overrides = {}) {
  const id = overrides.id ?? 'profile-shared';
  const deviceId = overrides.deviceId ?? 'device-review-shared';
  const generation = overrides.authorizationGeneration ?? 'generation-review-1';
  return {
    id, label: id, baseUrl: overrides.baseUrl ?? 'https://gateway.review/g/primary',
    accessToken: overrides.accessToken ?? 'synthetic-access-old', rpcToken: 'synthetic-rpc',
    expiresAt: overrides.expiresAt ?? Date.now() - 1_000, accessTtlMs: 3_000,
    authMode: 'device', deviceId, authorizationGeneration: generation,
    refreshToken: overrides.refreshToken ?? 'a'.repeat(64), refreshExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

async function verifyFreeze() {
  check(freezeRoot && expectedDigest && expectedCount > 0, 'set PHONE_AUTH_CANDIDATE_ROOT, PHONE_AUTH_CANDIDATE_DIGEST, and PHONE_AUTH_CANDIDATE_COUNT to a frozen source');
  const metadata = JSON.parse(await readFile(join(freezeRoot, 'metadata.json'), 'utf8'));
  check(metadata.sourceDigest === expectedDigest && metadata.files === expectedCount, 'frozen source metadata does not match the expected candidate');
  const manifest = JSON.parse(await readFile(join(freezeRoot, 'sha256.json'), 'utf8'));
  const entries = Object.entries(manifest);
  check(entries.length === expectedCount, 'frozen source manifest count mismatch');
  for (const [relative, expected] of entries) {
    const actual = createHash('sha256').update(await readFile(join(freezeRoot, relative))).digest('hex');
    check(actual === expected, `frozen source hash mismatch: ${relative}`);
  }
}

async function buildHarness(tempRoot) {
  const mobileRoot = join(freezeRoot, 'apps/kcoder-studio/mobile');
  const entry = join(tempRoot, 'review-entry.ts');
  const source = `
import { ProfileCoordinator } from ${JSON.stringify(join(mobileRoot, 'src/state/profile-coordinator.ts'))};
import { DeviceAuthorizationManager } from ${JSON.stringify(join(mobileRoot, 'src/state/device-authorization.ts'))};
import { removeGatewayProfile } from ${JSON.stringify(join(mobileRoot, 'src/state/remove-gateway-profile.ts'))};
import { loadProfiles, persistProfiles, PROFILE_INDEX_KEY } from ${JSON.stringify(join(mobileRoot, 'src/storage/profile-store.ts'))};
import { canCoordinateDeviceAuthorization, withLocalIdentityLock } from ${JSON.stringify(join(mobileRoot, 'src/storage/context-lock.ts'))};

const coordinators = new Map();
const managers = new Map();
let refreshSequence = 0;
function coordinatorFor(name) {
  if (coordinators.has(name)) return coordinators.get(name);
  const coordinator = new ProfileCoordinator({
    reload: loadProfiles,
    serialize: operation => withLocalIdentityLock('gateway-profile-index', async () => {
      if (!canCoordinateDeviceAuthorization() && (await loadProfiles()).profiles.some(profile => profile.authMode === 'device')) {
        throw new Error('WebLocks unavailable for a stored device profile');
      }
      return operation();
    }, false),
  });
  coordinators.set(name, coordinator);
  return coordinator;
}
async function managerFor(name) {
  if (managers.has(name)) return managers.get(name);
  const stored = await loadProfiles();
  const coordinator = coordinatorFor(name);
  coordinator.hydrate(stored);
  const manager = new DeviceAuthorizationManager(
    id => coordinator.getSnapshot().profiles.find(profile => profile.id === id),
    (expected, next) => coordinator.updateCredentials(expected, next, persistProfiles),
    () => { globalThis.__authReviewChanges = (globalThis.__authReviewChanges ?? 0) + 1; },
    async (expected, rotationId) => {
      const response = await fetch('/review/refresh', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: expected.deviceId, authorizationGeneration: expected.authorizationGeneration, refreshToken: expected.refreshToken, rotationId }),
      });
      if (response.status === 401 || response.status === 409) throw new GatewaySessionExpiredError();
      if (!response.ok) throw new Error('scripted refresh failed');
      return { ...expected, ...(await response.json()), pendingRotationId: undefined };
    },
    () => 'review-rotation-' + (++refreshSequence),
    async () => { await coordinator.synchronize(); },
  );
  const value = { coordinator, manager, profile: stored.profiles[0] };
  managers.set(name, value);
  globalThis.__authReviewEnsure = (profile, force) => manager.authorize(profile, force);
  return value;
}
async function seed(profiles, activeId = profiles[0]?.id ?? null) { await persistProfiles(profiles, activeId); }
async function authorize(name, force = true) {
  const value = await managerFor(name);
  const profile = value.coordinator.getSnapshot().profiles.find(item => item.id === value.profile?.id) ?? value.profile;
  await value.manager.authorize(profile, force);
  return { profile: { ...profile }, changes: globalThis.__authReviewChanges ?? 0 };
}
async function commit(name, profile) {
  const coordinator = coordinatorFor(name);
  coordinator.hydrate(await loadProfiles());
  const intent = coordinator.beginConnection();
  return coordinator.commitConnection(intent, profile, persistProfiles);
}
async function remove(name) {
  const value = await managerFor(name);
  return removeGatewayProfile(value.profile.id, {
    coordinator: value.coordinator,
    persist: persistProfiles,
    cleanupProfileState: async () => {},
    revokeSession: async profile => {
      const response = await fetch('/review/revoke', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: profile.deviceId, accessToken: profile.accessToken }),
      });
      if (!response.ok) throw new Error('scripted revoke was not confirmed');
    },
    effects: {
      setProfiles() {}, setActiveId() {}, removeProfileRuntimes() {}, clearRuntime() {}, markProfileStateRemoval() { return 1; },
    },
  });
}
async function snapshot() { return loadProfiles(); }
async function rawIndex() { return localStorage.getItem(PROFILE_INDEX_KEY); }
globalThis.__authReview = { seed, managerFor, authorize, commit, remove, snapshot, rawIndex, canCoordinateDeviceAuthorization };
`;
  await writeFile(entry, source, { mode: 0o600 });
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'browser', format: 'iife', target: ['es2022'],
    tsconfigRaw: { compilerOptions: {} },
    plugins: [{
      name: 'review-only-mobile-aliases',
      setup(build) {
        build.onResolve({ filter: /^@\/gateway\/http$/ }, () => ({ path: 'gateway-http-stub', namespace: 'review-stub' }));
        build.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native-stub', namespace: 'review-stub' }));
        build.onResolve({ filter: /^@\// }, args => {
          const base = resolve(mobileRoot, 'src', args.path.slice(2));
          const path = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`].find(existsSync);
          return path ? { path } : { errors: [{ text: `frozen mobile alias not found: ${args.path}` }] };
        });
        build.onLoad({ filter: /.*/, namespace: 'review-stub' }, args => ({
          loader: 'ts',
          contents: args.path === 'react-native-stub'
            ? 'export const Platform = { OS: "web" };'
            : 'export class GatewaySessionExpiredError extends Error { constructor(){ super("session expired"); this.name = "GatewaySessionExpiredError"; } } export async function refreshMobileSession(){ throw new Error("test refresh must be injected"); } export async function ensureGatewayAuthorization(profile, force){ return globalThis.__authReviewEnsure?.(profile, force); }',
        }));
      },
    }],
  });
  return result.outputFiles[0].text;
}

async function startFixtureServer(bundle) {
  const families = new Map();
  const requests = [];
  const cachedRotations = new Map();
  const holdNext = new Set();
  const requestWaiters = [];
  let barrierArrivals = 0;
  let barrierRelease;
  const barrier = new Promise(resolve => { barrierRelease = resolve; });

  function sendJson(response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    const body = JSON.stringify(value);
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  }
  async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = createServer(async (request, response) => {
    if (request.url === '/') {
      const html = '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>auth review</title><script src="/review.js"></script>';
      response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(html) }); response.end(html); return;
    }
    if (request.url === '/review.js') {
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(bundle) }); response.end(bundle); return;
    }
    if (request.url === '/review/barrier') {
      barrierArrivals += 1;
      if (barrierArrivals >= 2) barrierRelease();
      await barrier;
      sendJson(response, 200, { ready: true }); return;
    }
    if (request.url === '/review/refresh' && request.method === 'POST') {
      let body;
      try { body = await readBody(request); } catch { sendJson(response, 400, {}); return; }
      const family = families.get(body.deviceId);
      const key = `${body.deviceId}:${body.rotationId}`;
      let result = cachedRotations.get(key);
      if (!result) {
        if (!family || family.revoked || family.refreshToken !== body.refreshToken || family.generation !== body.authorizationGeneration) {
          requests.push({ ...body, status: 401, createdRotation: false });
          sendJson(response, 401, {}); return;
        }
        family.rotationCount += 1;
        result = {
          deviceId: body.deviceId, authorizationGeneration: family.generation,
          accessToken: `synthetic-access-${family.rotationCount}`,
          rpcToken: 'synthetic-rpc-next', refreshToken: `synthetic-refresh-${family.rotationCount}`,
          expiresAt: Date.now() + 90_000, refreshExpiresAt: Date.now() + 3_600_000, accessTtlMs: 90_000,
        };
        family.accessToken = result.accessToken;
        family.refreshToken = result.refreshToken;
        cachedRotations.set(key, result);
      }
      const record = { ...body, status: 200, createdRotation: family.rotationCount === 1 && !requests.some(item => item.deviceId === body.deviceId && item.rotationId === body.rotationId) };
      requests.push(record);
      for (let index = requestWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = requestWaiters[index];
        if (waiter.deviceId === body.deviceId && requests.filter(item => item.deviceId === body.deviceId).length > waiter.afterCount) {
          requestWaiters.splice(index, 1); waiter.resolve(record);
        }
      }
      const shouldHold = holdNext.delete(body.deviceId);
      const release = () => sendJson(response, 200, result);
      if (shouldHold) record.release = release; else release();
      return;
    }
    if (request.url === '/review/revoke' && request.method === 'POST') {
      let body;
      try { body = await readBody(request); } catch { sendJson(response, 400, {}); return; }
      const family = families.get(body.deviceId);
      if (!family || family.accessToken !== body.accessToken) { sendJson(response, 401, {}); return; }
      family.revoked = true;
      response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return;
    }
    sendJson(response, 404, {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server, origin, families, requests,
    register(profile) { families.set(profile.deviceId, { generation: profile.authorizationGeneration, refreshToken: profile.refreshToken, accessToken: profile.accessToken, rotationCount: 0, revoked: false }); },
    holdNext(deviceId) { holdNext.add(deviceId); },
    nextRequest(deviceId, afterCount = 0) {
      const current = requests.filter(item => item.deviceId === deviceId);
      if (current.length > afterCount) return Promise.resolve(current[afterCount]);
      return new Promise(resolve => requestWaiters.push({ deviceId, afterCount, resolve }));
    },
    async close() { await new Promise(resolve => server.close(resolve)); },
  };
}

async function newPage(context, origin) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); reviewEvidence.pageErrors.push(error.message); });
  await page.goto(origin, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__authReview));
  return { page, errors };
}

test('frozen mobile auth serializes two real localStorage tabs, recovers page-close rotation, and rejects stale identity writes', { timeout: 60_000 }, async t => {
  await verifyFreeze();
  const tempRoot = await mkdtemp(join(tmpdir(), 'kcoder-mobile-auth-web-tabs-'));
  const bundle = await buildHarness(tempRoot);
  const fixture = await startFixtureServer(bundle);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.KCODER_STUDIO_CHROMIUM || '/usr/bin/chromium' });
  const failures = [];
  try {
    await t.test('same-origin tabs share the profile index and one forced refresh winner', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      try {
        const a = await newPage(context, fixture.origin);
        const b = await newPage(context, fixture.origin);
        assert.equal(await a.page.evaluate(() => window.isSecureContext && typeof navigator.locks?.request === 'function'), true, 'Chromium exposes origin-scoped Web Locks on localhost');
        await a.page.evaluate(() => localStorage.setItem('two-tab-proof', 'shared'));
        assert.equal(await b.page.evaluate(() => localStorage.getItem('two-tab-proof')), 'shared', 'two actual pages use one origin localStorage');

        const alpha = fixtureProfile({ id: 'tab-alpha', baseUrl: 'https://gateway-alpha.review/g/a', deviceId: 'device-alpha-review', refreshToken: '1'.repeat(64) });
        const beta = fixtureProfile({ id: 'tab-beta', baseUrl: 'https://gateway-beta.review/g/b', deviceId: 'device-beta-review', refreshToken: '2'.repeat(64) });
        await Promise.all([a.page.evaluate(() => fetch('/review/barrier').then(response => response.json())), b.page.evaluate(() => fetch('/review/barrier').then(response => response.json()))]);
        fixture.register(alpha); fixture.register(beta);
        const commits = await Promise.all([
          a.page.evaluate(profile => window.__authReview.commit('first-tab', profile), alpha),
          b.page.evaluate(profile => window.__authReview.commit('second-tab', profile), beta),
        ]);
        assert.ok(commits.every(result => result.committed));
        const shared = await a.page.evaluate(() => window.__authReview.snapshot());
        assert.deepEqual(new Set(shared.profiles.map(profile => profile.id)), new Set(['tab-alpha', 'tab-beta']), 'the lock-and-reload winner preserved both concurrent profile commits');

        // Keep one device family in the shared index and force both stale tabs
        // to renew together. The second must reload the first tab's winner.
        const family = fixtureProfile({ id: 'shared-family', baseUrl: 'https://gateway-shared.review/g/c', deviceId: 'device-shared-review', refreshToken: '3'.repeat(64) });
        await a.page.evaluate(profile => window.__authReview.seed([profile], profile.id), family);
        fixture.register(family);
        await Promise.all([a.page.evaluate(() => window.__authReview.managerFor('refresh-a')), b.page.evaluate(() => window.__authReview.managerFor('refresh-b'))]);
        fixture.holdNext(family.deviceId);
        const first = a.page.evaluate(() => window.__authReview.authorize('refresh-a', true));
        const second = b.page.evaluate(() => window.__authReview.authorize('refresh-b', true));
        const held = await fixture.nextRequest(family.deviceId);
        await sleep(150);
        assert.equal(fixture.requests.filter(request => request.deviceId === family.deviceId).length, 1, 'the waiting tab does not submit a second rotation');
        held.release();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.equal(firstResult.profile.refreshToken, 'synthetic-refresh-1');
        assert.equal(secondResult.profile.refreshToken, 'synthetic-refresh-1', 'the waiting tab receives the committed winner');
        assert.equal(fixture.families.get(family.deviceId).rotationCount, 1);
        const persisted = await b.page.evaluate(() => window.__authReview.snapshot());
        assert.equal(persisted.profiles.find(profile => profile.id === family.id).refreshToken, 'synthetic-refresh-1');
        reviewEvidence.scenarios.push({
          name: 'two-page-shared-index-and-refresh-winner', result: 'PASS',
          browserPages: 2, sharedLocalStorage: true, webLocks: true,
          concurrentProfileIds: [...new Set(shared.profiles.map(profile => profile.id))].sort(),
          deviceRotationRequests: fixture.requests.filter(request => request.deviceId === family.deviceId).map(request => ({ deviceId: request.deviceId, rotationId: request.rotationId, status: request.status })),
          finalProfiles: persisted.profiles.map(profile => ({ id: profile.id, generation: profile.authorizationGeneration, pendingRotation: Boolean(profile.pendingRotationId), accessFresh: profile.expiresAt > Date.now() })),
        });
      } finally { await context.close(); }
    });

    await t.test('closing a page after durable pending intent releases the lock and replays the same rotation ID', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      try {
        const a = await newPage(context, fixture.origin);
        const family = fixtureProfile({ id: 'crash-family', deviceId: 'device-crash-review', refreshToken: '4'.repeat(64) });
        await a.page.evaluate(profile => window.__authReview.seed([profile], profile.id), family);
        fixture.register(family); fixture.holdNext(family.deviceId);
        await a.page.evaluate(() => window.__authReview.managerFor('crash-tab'));
        const ignoredCloseError = a.page.evaluate(() => window.__authReview.authorize('crash-tab', true)).catch(() => null);
        const firstRequest = await fixture.nextRequest(family.deviceId);
        const pending = await a.page.evaluate(() => window.__authReview.snapshot());
        const pendingId = pending.profiles[0].pendingRotationId;
        assert.equal(pendingId, firstRequest.rotationId, 'pending rotation is durable before the refresh request');
        await a.page.close(); await ignoredCloseError;

        const b = await newPage(context, fixture.origin);
        await b.page.evaluate(() => window.__authReview.managerFor('reopened-tab'));
        const recovered = await b.page.evaluate(() => window.__authReview.authorize('reopened-tab', true));
        const replay = fixture.requests.filter(request => request.deviceId === family.deviceId);
        assert.equal(replay.length, 2, 'reopened tab retries the idempotent refresh after page shutdown');
        assert.equal(replay[1].rotationId, pendingId, 'recovery reuses the exact durable rotation ID');
        assert.equal(fixture.families.get(family.deviceId).rotationCount, 1, 'the server family rotated only once');
        assert.equal(recovered.profile.refreshToken, 'synthetic-refresh-1');
        assert.equal(recovered.profile.pendingRotationId, undefined);
        reviewEvidence.scenarios.push({
          name: 'page-close-pending-rotation-recovery', result: 'PASS',
          firstPageClosed: true, rotationIds: replay.map(request => request.rotationId),
          serverFamilyRotationCount: fixture.families.get(family.deviceId).rotationCount,
          finalProfiles: (await b.page.evaluate(() => window.__authReview.snapshot())).profiles.map(profile => ({ id: profile.id, generation: profile.authorizationGeneration, pendingRotation: Boolean(profile.pendingRotationId), accessFresh: profile.expiresAt > Date.now() })),
        });
      } finally { await context.close(); }
    });

    await t.test('remove waits for an in-flight refresh, revokes the winner, and route replacement drops a late response', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      try {
        const a = await newPage(context, fixture.origin);
        const b = await newPage(context, fixture.origin);
        const family = fixtureProfile({ id: 'remove-family', deviceId: 'device-remove-review', refreshToken: '5'.repeat(64) });
        await a.page.evaluate(profile => window.__authReview.seed([profile], profile.id), family);
        fixture.register(family); fixture.holdNext(family.deviceId);
        await Promise.all([a.page.evaluate(() => window.__authReview.managerFor('remove-refresh')), b.page.evaluate(() => window.__authReview.managerFor('remove-tab'))]);
        const refresh = a.page.evaluate(() => window.__authReview.authorize('remove-refresh', true));
        const held = await fixture.nextRequest(family.deviceId);
        const removal = b.page.evaluate(() => window.__authReview.remove('remove-tab'));
        await sleep(150);
        assert.equal((await b.page.evaluate(() => window.__authReview.snapshot())).profiles.length, 1, 'remove is still waiting behind the family lock');
        held.release();
        await refresh;
        const removed = await removal;
        assert.equal(removed.removed, true);
        assert.equal(removed.remoteRevocation, 'confirmed');
        assert.equal(fixture.families.get(family.deviceId).revoked, true, 'revocation used the current access winner after rotation');
        assert.equal((await a.page.evaluate(() => window.__authReview.snapshot())).profiles.length, 0, 'shared index no longer contains the removed family');

        // A route/account replacement can complete while an old network
        // response is held. Its old generation must not win the credential CAS.
        const old = fixtureProfile({ id: 'route-family', deviceId: 'device-route-old', refreshToken: '6'.repeat(64) });
        await a.page.evaluate(profile => window.__authReview.seed([profile], profile.id), old);
        fixture.register(old); fixture.holdNext(old.deviceId);
        await Promise.all([a.page.evaluate(() => window.__authReview.managerFor('route-old')), b.page.evaluate(() => window.__authReview.managerFor('route-new'))]);
        const staleResponse = a.page.evaluate(() => window.__authReview.authorize('route-old', true)).then(value => ({ ok: true, value }), error => ({ ok: false, name: error.name, message: error.message }));
        const stale = await fixture.nextRequest(old.deviceId);
        const replacement = fixtureProfile({ id: 'route-family', label: 'new-principal', deviceId: 'device-route-new', authorizationGeneration: 'generation-review-2', accessToken: 'synthetic-access-new-principal', refreshToken: '7'.repeat(64), baseUrl: old.baseUrl, expiresAt: Date.now() + 90_000 });
        fixture.register(replacement);
        const committed = await b.page.evaluate(profile => window.__authReview.commit('route-new', profile), replacement);
        assert.equal(committed.committed, true);
        stale.release();
        const staleResult = await staleResponse;
        assert.equal(staleResult.ok, false, 'late refresh response cannot complete successfully after identity-generation replacement');
        assert.match(staleResult.message, /^page\.evaluate: GatewaySessionExpiredError: session expired\n/, 'late response fails through the specific expired-session branch, not an arbitrary exception');
        const after = await b.page.evaluate(() => window.__authReview.snapshot());
        assert.equal(after.profiles.length, 1);
        assert.equal(after.profiles[0].authorizationGeneration, 'generation-review-2');
        assert.equal(after.profiles[0].accessToken, 'synthetic-access-new-principal');
        assert.equal(after.profiles[0].refreshToken, '7'.repeat(64));
        reviewEvidence.scenarios.push({
          name: 'remove-waits-for-refresh-and-stale-generation-is-dropped', result: 'PASS',
          remove: { removed: removed.removed, remoteRevocation: removed.remoteRevocation, familyRevoked: fixture.families.get(family.deviceId).revoked },
          staleRefreshRejected: !staleResult.ok, staleResponseError: { name: staleResult.name, message: staleResult.message }, activeStoredGeneration: after.profiles[0].authorizationGeneration,
          activeStoredAccessIsReplacement: after.profiles[0].accessToken === replacement.accessToken,
          syntheticRequests: fixture.requests.filter(request => [family.deviceId, old.deviceId].includes(request.deviceId)).map(request => ({ deviceId: request.deviceId, rotationId: request.rotationId, status: request.status })),
          finalProfiles: after.profiles.map(profile => ({ id: profile.id, generation: profile.authorizationGeneration, pendingRotation: Boolean(profile.pendingRotationId), accessFresh: profile.expiresAt > Date.now() })),
        });
      } finally { await context.close(); }
    });

    await t.test('missing Web Locks fails closed for durable authorization and profile writes', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await context.addInitScript(() => {
        try { Object.defineProperty(window.navigator, 'locks', { configurable: true, value: undefined }); }
        catch { Object.defineProperty(Object.getPrototypeOf(window.navigator), 'locks', { configurable: true, get: () => undefined }); }
      });
      try {
        const page = await newPage(context, fixture.origin);
        const family = fixtureProfile({ id: 'no-lock-family', deviceId: 'device-no-lock-review', refreshToken: '8'.repeat(64) });
        await page.page.evaluate(profile => window.__authReview.seed([profile], profile.id), family);
        fixture.register(family);
        assert.equal(await page.page.evaluate(() => window.__authReview.canCoordinateDeviceAuthorization()), false);
        await page.page.evaluate(() => window.__authReview.managerFor('no-lock-tab'));
        const result = await page.page.evaluate(() => window.__authReview.authorize('no-lock-tab', true).then(() => 'fulfilled', error => error.message));
        assert.match(result, /无法安全协调/);
        assert.equal(fixture.requests.filter(request => request.deviceId === family.deviceId).length, 0, 'no refresh request escapes the unsupported lock fallback');
        const before = await page.page.evaluate(() => window.__authReview.rawIndex());
        const blocked = fixtureProfile({ id: 'no-lock-new', deviceId: 'device-no-lock-new', refreshToken: '9'.repeat(64), baseUrl: 'https://gateway-new.review/g/new' });
        const commit = await page.page.evaluate(profile => window.__authReview.commit('no-lock-tab', profile).then(() => 'fulfilled', error => error.message), blocked);
        assert.match(commit, /WebLocks unavailable/);
        assert.equal(await page.page.evaluate(() => window.__authReview.rawIndex()), before, 'unsupported fallback does not overwrite a stored durable profile');
        reviewEvidence.scenarios.push({
          name: 'web-locks-unavailable-fails-closed', result: 'PASS',
          deviceAuthorizationAvailable: false, refreshRequests: fixture.requests.filter(request => request.deviceId === family.deviceId).length,
          profileIndexUnchanged: true, finalProfiles: (await page.page.evaluate(() => window.__authReview.snapshot())).profiles.map(profile => ({ id: profile.id, generation: profile.authorizationGeneration, pendingRotation: Boolean(profile.pendingRotation) })),
        });
      } finally { await context.close(); }
    });
    assert.equal(reviewEvidence.scenarios.length, 4, 'all four browser scenarios reached their assertions');
    assert.deepEqual(reviewEvidence.pageErrors, [], 'review pages emitted no uncaught browser errors');
    reviewEvidence.chromium = await browser.version();
    reviewEvidence.result = 'PASS';
    reviewEvidence.requestRecords = fixture.requests.map(({ deviceId, rotationId, status }) => ({ deviceId, rotationId, status }));
    const evidencePath = join(repoRoot, 'target/private-phone-ux-implementation/web-multitab-review-evidence.json');
    await writeFile(evidencePath, JSON.stringify(reviewEvidence, null, 2) + '\n', { mode: 0o600 });
    t.diagnostic(`sanitized two-tab browser evidence written to ${evidencePath}`);
  } finally {
    await browser.close();
    await fixture.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
