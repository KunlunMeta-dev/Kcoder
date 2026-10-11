import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';
import { relayServerConfig } from '../src/config.mjs';

const registrationKey = 'registration-key-for-config-tests-0123456789';
const legacySecret = 'legacy-relay-control-secret-0123456789';

function gateway(id = 'static-gateway') {
  return {
    id,
    secret: 'static-control-secret-for-config-test-0123456789',
    pairingToken: 'static-pairing-token-for-config-test-0123456789',
    maxConnections: 128,
    maxBytesPerWindow: 67_108_864,
    trafficWindowMs: 60_000,
  };
}

async function withTempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-registration-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeRegistry(t, document) {
  const directory = await withTempDir(t);
  const path = join(directory, 'registry.json');
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  return path;
}

test('registration key without an explicit store selects an empty multi-Gateway config and private target path', () => {
  const result = relayServerConfig({ KCODER_RELAY_REGISTRATION_KEY: registrationKey });

  assert.deepEqual(result.gateways, []);
  assert.deepEqual(result.sharedHosts, ['hyf2333.top:8451']);
  assert.equal(result.registrationKey, registrationKey);
  assert.equal(isAbsolute(result.registrationStoreFile), true);
  assert.equal(result.registrationStoreFile, resolve(new URL('../src/../../../target/kcoder-relay/registered-gateways.json', import.meta.url).pathname));
  assert.equal(Object.hasOwn(result, 'legacy'), false);
});

test('explicit store without a key loads in multi-Gateway mode and leaves registration disabled', () => {
  const storeFile = join(tmpdir(), 'relay-registered-gateways.json');
  const result = relayServerConfig({
    KCODER_RELAY_REGISTRATION_STORE_FILE: storeFile,
    KCODER_RELAY_SECRET: legacySecret,
  });

  assert.deepEqual(result.gateways, []);
  assert.deepEqual(result.sharedHosts, ['hyf2333.top:8451']);
  assert.equal(result.registrationStoreFile, resolve(storeFile));
  assert.equal(Object.hasOwn(result, 'registrationKey'), false);
  assert.equal(Object.hasOwn(result, 'legacy'), false);
});

test('static registry can be combined with a registration key and explicit store', async t => {
  const registryFile = await writeRegistry(t, {
    gateways: [gateway()],
    sharedHosts: ['relay.example:8451'],
  });
  const storeFile = join(tmpdir(), 'relay-static-registered-gateways.json');
  const result = relayServerConfig({
    KCODER_RELAY_REGISTRY_FILE: registryFile,
    KCODER_RELAY_REGISTRATION_KEY: registrationKey,
    KCODER_RELAY_REGISTRATION_STORE_FILE: storeFile,
  });

  assert.deepEqual(result.gateways, [gateway()]);
  assert.deepEqual(result.sharedHosts, ['relay.example:8451']);
  assert.equal(result.registrationKey, registrationKey);
  assert.equal(result.registrationStoreFile, resolve(storeFile));
  assert.equal(Object.hasOwn(result, 'legacy'), false);
});

test('empty registration variables preserve the legacy config shape', () => {
  const result = relayServerConfig({
    KCODER_RELAY_REGISTRATION_KEY: '',
    KCODER_RELAY_REGISTRATION_STORE_FILE: '',
    KCODER_RELAY_SECRET: legacySecret,
    KCODER_RELAY_DEVICE_ID: 'legacy-device',
  });

  assert.equal(result.legacy, true);
  assert.equal(result.gateways.length, 1);
  assert.equal(result.gateways[0].id, 'legacy-device');
  assert.equal(Object.hasOwn(result, 'registrationKey'), false);
  assert.equal(Object.hasOwn(result, 'registrationStoreFile'), false);
});

test('malformed registration keys fail closed', () => {
  for (const key of ['short', 'has spaces and is longer than 32 characters', 'x'.repeat(513)]) {
    assert.throws(() => relayServerConfig({ KCODER_RELAY_REGISTRATION_KEY: key }), /KCODER_RELAY_REGISTRATION_KEY/);
  }
});

test('dynamic registration uses one exact public host and rejects host aliases', () => {
  const result = relayServerConfig({
    KCODER_RELAY_REGISTRATION_STORE_FILE: join(tmpdir(), 'relay-one-host.json'),
    KCODER_RELAY_PUBLIC_URL: 'https://relay.example:8451/path',
  });
  assert.deepEqual(result.sharedHosts, ['relay.example:8451']);

  assert.throws(() => relayServerConfig({
    KCODER_RELAY_REGISTRATION_STORE_FILE: join(tmpdir(), 'relay-multiple-hosts.json'),
    KCODER_RELAY_SHARED_HOSTS: 'hyf2333.top:8451,www.hyf2333.top:8451',
  }), /exactly one shared host/);
});
