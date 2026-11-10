import assert from 'node:assert/strict';
import { cp, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ensureRegisteredClientIdentity } from '../../kcoder-relay/src/client.mjs';
import { prepareInstanceIdentityFile, resolveIdentityFile } from '../../kcoder-relay/src/client-identity.mjs';
import { isolatedGatewayUrl } from '../../kcoder-relay/src/gateway-origin.mjs';
import { prepareGatewayRelay as prepareDesktopRelay, activateGatewayRelay as activateDesktopRelay } from '../src/gateway-relay-instance.js';
import { createGatewayChildEnv } from './gateway-env.mjs';

const relayUrl = 'https://relay.example:8451';
const registrationKey = 'registration-fixture-key-'.repeat(3);
const assigned = { id: 'desktop-fixture', secret: 'private-control-fixture-'.repeat(3) };

function registrationResponse(gatewaySecret) {
  return new Response(JSON.stringify({ ...assigned, gatewaySecret,
    maxConnections: 128, maxBytesPerWindow: 64 * 1024 * 1024, trafficWindowMs: 60000 }), { status: 201 });
}

async function home(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-desktop-relay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runtimeFixture() {
  const registrations = [];
  const connections = [];
  return {
    registrations, connections,
    runtime: {
      isolatedGatewayUrl,
      prepareInstanceIdentityFile,
      resolveIdentityFile,
      ensureRegisteredClientIdentity: options => ensureRegisteredClientIdentity({
        ...options,
        fetchImpl: async (url, init) => {
          registrations.push({ url: String(url), ...init, body: JSON.parse(init.body) });
          return registrationResponse(JSON.parse(init.body).gatewaySecret);
        },
      }),
      startRegisteredClient: async options => {
        const entry = { options, closed: false, close() { this.closed = true; } };
        connections.push(entry);
        return entry;
      },
    },
  };
}

test('an unconfigured desktop stays local without loading Relay or creating an identity', async t => {
  const userDataDir = await home(t);
  assert.equal(await prepareDesktopRelay({ userDataDir, env: {}, loadRuntime: () => assert.fail('unexpected Relay load') }), null);
  await assert.rejects(readFile(join(userDataDir, 'desktop-relay/gateway-secret')), { code: 'ENOENT' });
});

test('a bundled public URL alone never enrolls a desktop without an activation grant', async t => {
  const userDataDir = await home(t);
  const fixture = runtimeFixture();
  assert.equal(await prepareDesktopRelay({ userDataDir, env: {}, defaultRelayUrl: relayUrl,
    loadRuntime: async () => fixture.runtime }), null);
  assert.equal(fixture.registrations.length, 0);
  await assert.rejects(readFile(join(userDataDir, 'desktop-relay/gateway-secret')), { code: 'ENOENT' });
});

for (const enrollment of [
  { name: 'legacy activation link', link: code => `${relayUrl}/_relay/activate#code=${code}`, endpoint: '/_relay/activate-device' },
  { name: 'Relay account code', link: code => code, endpoint: '/_relay/account/register' },
]) test(`desktop enrollment with a ${enrollment.name} keeps only its independent identity`, async t => {
  const userDataDir = await home(t);
  const fixture = runtimeFixture();
  const code = 'a'.repeat(43);
  const result = await activateDesktopRelay({ userDataDir, relayUrl,
    activationLink: enrollment.link(code), loadRuntime: async () => fixture.runtime });
  assert.equal(result.restartRequired, true);
  assert.equal(fixture.registrations[0].url, relayUrl + enrollment.endpoint);
  assert.equal(fixture.registrations[0].headers.authorization, `Bearer ${code}`);
  assert.deepEqual(JSON.parse(await readFile(join(userDataDir, 'desktop-relay.json'), 'utf8')), { url: relayUrl });
  assert.equal(fixture.connections.length, 0, 'activation does not start a second Gateway or bypass the explicit restart');
  const relay = await prepareDesktopRelay({ userDataDir, env: {}, loadRuntime: async () => fixture.runtime });
  assert.equal(relay.publicBaseUrl, result.publicBaseUrl);
  assert.equal(fixture.registrations.length, 1, 'restart uses independent credentials, not another activation');
  relay.close();
  await assert.rejects(activateDesktopRelay({ userDataDir,
    activationLink: `${relayUrl}/_relay/activate#code=${'b'.repeat(43)}`, loadRuntime: async () => fixture.runtime }), /already has a Relay identity/);
});

test('desktop registration publishes its own HTTPS route and reuses private identity across child and app restarts', async t => {
  const userDataDir = await home(t);
  const fixture = runtimeFixture();
  const env = { KCODER_RELAY_PUBLIC_URL: relayUrl, KCODER_RELAY_REGISTRATION_KEY: registrationKey,
    KCODER_RELAY_STUN_PORT: '9452', KCODER_STUDIO_PUBLIC_ORIGINS: 'https://existing.example' };
  const options = { userDataDir, env, loadRuntime: async () => fixture.runtime };
  const desktop = await prepareDesktopRelay(options);
  t.after(() => desktop.close());
  assert.equal(desktop.gatewayEnvironment.KCODER_STUDIO_RELAY_IDENTITY_FILE, join(userDataDir, 'relay/client-identity.json'));
  assert.equal(fixture.registrations.length, 1);
  assert.equal(fixture.registrations[0].url, `${relayUrl}/_relay/register`);
  assert.equal(fixture.registrations[0].headers.authorization, `Bearer ${registrationKey}`);
  assert.equal(desktop.publicBaseUrl, isolatedGatewayUrl(relayUrl, assigned.id).href.replace(/\/$/, ''));
  assert.equal(desktop.gatewayEnvironment.KCODER_STUDIO_P2P_STUN_URLS, 'stun:relay.example:9452');
  assert.ok(desktop.gatewayEnvironment.KCODER_STUDIO_PUBLIC_ORIGINS.includes('https://existing.example'));
  const childEnvironment = { ...createGatewayChildEnv(env), ...desktop.gatewayEnvironment };
  assert.equal(Object.values(childEnvironment).includes(registrationKey), false);
  assert.equal(Object.values(childEnvironment).includes(assigned.secret), false);
  assert.equal(childEnvironment.KCODER_STUDIO_RELAY_SECRET, fixture.registrations[0].body.gatewaySecret);

  await desktop.connect('http://127.0.0.1:49542');
  await desktop.connect('http://127.0.0.1:49543');
  assert.equal(fixture.connections[0].closed, true);
  assert.equal(fixture.connections[1].options.gateway, 'http://127.0.0.1:49543');
  assert.equal(fixture.connections[1].options.registrationKey, undefined);
  desktop.close();
  assert.equal(fixture.connections[1].closed, true);

  const restarted = await prepareDesktopRelay({ ...options, env: { KCODER_RELAY_PUBLIC_URL: relayUrl,
    KCODER_STUDIO_P2P_STUN_URLS: 'stun:custom.example:8452' } });
  t.after(() => restarted.close());
  assert.equal(fixture.registrations.length, 1, 'app restart needs no shared registration key or re-enrollment');
  assert.equal(restarted.publicBaseUrl, desktop.publicBaseUrl);
  assert.equal(restarted.gatewayEnvironment.KCODER_STUDIO_RELAY_SECRET, childEnvironment.KCODER_STUDIO_RELAY_SECRET);
  assert.equal(restarted.gatewayEnvironment.KCODER_STUDIO_P2P_STUN_URLS, 'stun:custom.example:8452');
});

test('desktop startup adopts the legacy identity without registering again or changing its credentials', async t => {
  const userDataDir = await home(t);
  const fixture = runtimeFixture();
  const options = { userDataDir, env: { KCODER_RELAY_PUBLIC_URL: relayUrl,
    KCODER_RELAY_REGISTRATION_KEY: registrationKey }, loadRuntime: async () => fixture.runtime };
  const first = await prepareDesktopRelay(options);
  first.close();
  const identityFile = join(userDataDir, 'relay/client-identity.json');
  const legacyIdentityFile = join(userDataDir, 'desktop-relay/client-identity.json');
  const before = await readFile(identityFile);
  const gatewaySecret = await readFile(join(userDataDir, 'desktop-relay/gateway-secret'));
  await rename(identityFile, legacyIdentityFile);
  const restarted = await prepareDesktopRelay({ ...options, env: { KCODER_RELAY_PUBLIC_URL: relayUrl } });
  t.after(() => restarted.close());
  assert.equal(fixture.registrations.length, 1);
  assert.equal(restarted.publicBaseUrl, first.publicBaseUrl);
  assert.deepEqual(await readFile(identityFile), before);
  assert.deepEqual(await readFile(join(userDataDir, 'desktop-relay/gateway-secret')), gatewaySecret);
  await assert.rejects(readFile(legacyIdentityFile), { code: 'ENOENT' });
});

test('desktop restart without enrollment credentials finishes an interrupted identity move', async t => {
  const userDataDir = await home(t);
  const fixture = runtimeFixture();
  const options = { userDataDir, loadRuntime: async () => fixture.runtime };
  const first = await prepareDesktopRelay({ ...options, env: { KCODER_RELAY_PUBLIC_URL: relayUrl,
    KCODER_RELAY_REGISTRATION_KEY: registrationKey } });
  first.close();
  const identityFile = join(userDataDir, 'relay/client-identity.json');
  const legacyIdentityFile = join(userDataDir, 'desktop-relay/client-identity.json');
  await link(identityFile, legacyIdentityFile);
  const restarted = await prepareDesktopRelay({ ...options, env: { KCODER_RELAY_PUBLIC_URL: relayUrl } });
  t.after(() => restarted.close());
  assert.equal(restarted.publicBaseUrl, first.publicBaseUrl);
  assert.equal(fixture.registrations.length, 1);
  await assert.rejects(readFile(legacyIdentityFile), { code: 'ENOENT' });
});

test('desktop shutdown closes a late connection rather than leaving a background transport', async t => {
  const userDataDir = await home(t);
  const fixture = runtimeFixture();
  let finishConnect;
  fixture.runtime.startRegisteredClient = () => new Promise(resolve => { finishConnect = resolve; });
  const desktop = await prepareDesktopRelay({ userDataDir,
    env: { KCODER_RELAY_PUBLIC_URL: relayUrl, KCODER_RELAY_REGISTRATION_KEY: registrationKey },
    loadRuntime: async () => fixture.runtime });
  const connecting = desktop.connect('http://127.0.0.1:49542');
  desktop.close();
  let closed = false;
  finishConnect({ close() { closed = true; } });
  await connecting;
  assert.equal(closed, true);
});

test('private desktop configuration works without ambient credentials and rejects symlinks and conflicting public URLs', async t => {
  const userDataDir = await home(t);
  const fixture = runtimeFixture();
  const config = join(userDataDir, 'desktop-relay.json');
  await writeFile(config, JSON.stringify({ url: relayUrl, registrationKey }), { mode: 0o600 });
  const desktop = await prepareDesktopRelay({ userDataDir, env: {}, loadRuntime: async () => fixture.runtime });
  desktop.close();
  await assert.rejects(prepareDesktopRelay({ userDataDir,
    env: { KCODER_STUDIO_PUBLIC_ACCESS_URL: 'https://someone-else.example/g/other' },
    loadRuntime: async () => fixture.runtime }), /conflicts/);
  const link = join(userDataDir, 'linked-config');
  await symlink(config, link);
  await assert.rejects(prepareDesktopRelay({ userDataDir,
    env: { KCODER_STUDIO_DESKTOP_RELAY_CONFIG_FILE: link }, loadRuntime: async () => fixture.runtime }), /private owner-owned regular file/);
  await writeFile(config, '{"registrationKey":"must-never-appear-in-error"');
  await assert.rejects(prepareDesktopRelay({ userDataDir, env: {} }), error =>
    error.message === 'Invalid Gateway Relay configuration');
});

test('desktop startup cancellation never enrolls or opens a transport', async t => {
  const userDataDir = await home(t);
  await assert.rejects(prepareDesktopRelay({ userDataDir, env: {}, signal: AbortSignal.abort(),
    loadRuntime: () => assert.fail('cancelled startup loaded Relay') }), { name: 'AbortError' });
});

test('inventoried installer Relay imports and registration work outside the source tree', async t => {
  const directory = await home(t);
  const resourcesPath = join(directory, 'Installed Studio/resources');
  const studioRoot = resolve(import.meta.dirname, '..');
  const config = JSON.parse(await readFile(join(studioRoot, 'package.json'), 'utf8'));
  assert.ok(config.build.files.some(entry => entry.from === 'src' && entry.filter.includes('gateway-relay-instance.js')));
  assert.ok(config.build.files.some(entry => entry.from === 'src' && entry.filter.includes('gateway-connectivity.js')));
  for (const resource of config.build.extraResources.filter(entry => entry.to.startsWith('kcoder-relay/'))) {
    const destination = join(resourcesPath, resource.to);
    await mkdir(resolve(destination, '..'), { recursive: true });
    await cp(resolve(studioRoot, resource.from), destination, { recursive: true, dereference: true });
  }
  const client = await import(pathToFileURL(join(resourcesPath, 'kcoder-relay/src/client.mjs')).href);
  const identityFile = join(directory, 'fixture-identity.json');
  const identity = await client.ensureRegisteredClientIdentity({ url: relayUrl, registrationKey,
    gatewaySecret: 'packaged-internal-secret-'.repeat(3), identityFile,
    fetchImpl: async (_url, init) => registrationResponse(JSON.parse(init.body).gatewaySecret) });
  assert.deepEqual(identity, assigned);
  const userDataDir = join(directory, 'Installed User Data');
  const legacyDirectory = join(userDataDir, 'desktop-relay');
  await mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(legacyDirectory, 'gateway-secret'), 'packaged-internal-secret-'.repeat(3) + '\n', { mode: 0o600 });
  await rename(identityFile, join(legacyDirectory, 'client-identity.json'));
  const desktop = await prepareDesktopRelay({ resourcesPath, userDataDir,
    env: { KCODER_RELAY_PUBLIC_URL: relayUrl } });
  t.after(() => desktop.close());
  assert.equal(desktop.publicBaseUrl, isolatedGatewayUrl(relayUrl, assigned.id).href.replace(/\/$/, ''));
  assert.equal(JSON.parse(await readFile(join(userDataDir, 'relay/client-identity.json'), 'utf8')).id, assigned.id);
});
