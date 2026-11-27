import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCurrentInstallationRecovery } from './current-installation-recovery.mjs';
import { createServerMutationQueue } from './server-mutation.mjs';
import { normalizeServer, storedServer } from './server-config.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'owned-current-installation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const defaults = { appServerBin: '/owned/current/kcoder', workspace: root, repoRoot: root };
  const original = normalizeServer({ id: 'original', label: 'Original explicit', transport: 'local', command: '/owned/previous/kcoder',
    settingsFile: '/owned/original/settings.toml', profile: 'original-profile' }, defaults);
  let servers = [original], authorized = 'original-actor', current = true, writes = 0, publicationFailure;
  const handle = createCurrentInstallationRecovery({ storePath: join(root, 'servers.json'), getServers: () => servers,
    currentProgram: () => current ? { command: defaults.appServerBin } : null,
    normalize: value => normalizeServer(value, defaults), project: storedServer, signature: value => JSON.stringify(storedServer(value)),
    serialize: createServerMutationQueue(), publish: async values => { writes++; servers = values; if (publicationFailure) throw publicationFailure; return {}; },
    authorize: async () => authorized, sameOrigin: request => request.origin !== 'other', readBody: async request => request.body,
    respond: (response, status, body) => Object.assign(response, { status, body }), makeId: () => 'owned-operation' });
  const request = async (method, body, source = 'original') => {
    const response = {};
    await handle({ method, body: JSON.stringify(body) }, response, '/api/startup/current-installation', new URL(`http://127.0.0.1/api/startup/current-installation?source=${source}`));
    return response;
  };
  return { root, original, request, handle, get servers() { return servers; }, get writes() { return writes; },
    unauthorized: () => { authorized = null; }, replace: () => { servers = [{ ...original, command: '/owned/changed/kcoder' }]; },
    revokeImage: () => { current = false; }, failPublication: () => { publicationFailure = Object.assign(new Error('owned unknown'), { code: 'CONFIG_FILE_PUBLISH_UNCONFIRMED' }); } };
}

test('one explicit import retains the original authority entry for switching back and reconciles the same operation without another write', async t => {
  const f = await fixture(t), before = structuredClone(storedServer(f.original));
  const preview = await f.request('GET'); assert.equal(preview.body.available, true);
  assert.equal(f.writes, 0);
  const token = preview.body.preview.token;
  const result = await f.request('POST', { token, label: 'Current verified installation' });
  assert.equal(result.status, 200); assert.equal(f.writes, 1); assert.equal(f.servers.length, 2);
  assert.deepEqual(storedServer(f.servers[0]), before);
  const current = f.servers[1]; assert.equal(current.command, '/owned/current/kcoder');
  assert.equal(current.settingsFile, undefined); assert.equal(current.profile, undefined);
  assert.equal(result.body.originalServerId, f.original.id);
  assert.equal(result.body.sourcePreserved, true);
  assert.deepEqual(await f.request('POST', { token, label: 'Current verified installation' }), result);
  assert.equal((await f.request('POST', { token, label: 'Changed later label' })).status, 400);
  assert.equal(f.writes, 1);
});

test('a revoked actual image or changed explicit source blocks publication before any catalog write', async t => {
  for (const revoke of ['revokeImage', 'replace']) {
    const f = await fixture(t), preview = await f.request('GET'); f[revoke]();
    const result = await f.request('POST', { token: preview.body.preview.token, label: 'Current' });
    assert.equal(result.status, 400); assert.equal(f.writes, 0);
  }
});

test('request JSON cannot choose another executable or bypass authorization and same-origin checks', async t => {
  const f = await fixture(t), preview = await f.request('GET');
  const forged = await f.request('POST', { token: preview.body.preview.token, label: 'Current', command: '/attacker/program' });
  assert.equal(forged.status, 400); assert.equal(f.writes, 0);
  const response = {};
  await f.handle({ method: 'POST', origin: 'other', body: '{}' }, response, '/api/startup/current-installation', new URL('http://owned/'));
  assert.equal(response.status, 403); assert.equal(f.writes, 0);
  f.unauthorized(); assert.equal((await f.request('GET')).status, 403);
});

test('an uncertain publication stays unknown and never blindly repeats the original mutation', async t => {
  const f = await fixture(t), preview = await f.request('GET'); f.failPublication();
  const input = { token: preview.body.preview.token, label: 'Current' };
  const first = await f.request('POST', input); assert.equal(first.status, 409); assert.equal(f.writes, 1);
  const repeated = await f.request('POST', input); assert.equal(repeated.status, 409); assert.equal(f.writes, 1);
  assert.equal((await f.request('GET')).body.preview.token, input.token);
});
