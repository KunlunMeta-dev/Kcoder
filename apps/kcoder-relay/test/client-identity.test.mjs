import assert from 'node:assert/strict';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  prepareClientIdentity,
  readRegisteredClientId,
  readRegisteredClientIdentity,
  saveRegisteredClientIdentity,
} from '../src/client-identity.mjs';

const temporaryDirectories = new Set();
const relayUrl = 'https://relay.example.test:8451';
const otherRelayUrl = 'https://other.example.test:8451';
const pairingToken = 'pairing-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const otherPairingToken = 'different-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const secret = 'server-assigned-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const relayPackageRoot = fileURLToPath(new URL('../', import.meta.url));

async function identityDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-relay-identity-'));
  temporaryDirectories.add(directory);
  return directory;
}

async function identityPath() {
  return join(await identityDirectory(), 'private', 'identity.json');
}

async function isolatedPairingModule(directory) {
  const runtimeRoot = join(directory, 'pairing-runtime');
  const sourceDirectory = join(runtimeRoot, 'apps', 'kcoder-relay', 'src');
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  for (const name of ['pair.mjs', 'config.mjs', 'client-identity.mjs']) {
    await copyFile(join(relayPackageRoot, 'src', name), join(sourceDirectory, name));
  }

  let nodeModulesDirectory = dirname(fileURLToPath(import.meta.resolve('qrcode')));
  while (basename(nodeModulesDirectory) !== 'node_modules' && dirname(nodeModulesDirectory) !== nodeModulesDirectory) {
    nodeModulesDirectory = dirname(nodeModulesDirectory);
  }
  if (basename(nodeModulesDirectory) !== 'node_modules') {
    throw new Error('Unable to locate the Relay test node_modules directory');
  }
  await symlink(
    nodeModulesDirectory,
    join(runtimeRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const clientIdentity = await import(pathToFileURL(join(sourceDirectory, 'client-identity.mjs')).href);
  const isolatedIdentityFile = join(runtimeRoot, 'target', 'kcoder-relay', 'client-identity.json');
  assert.equal(clientIdentity.DEFAULT_IDENTITY_FILE, isolatedIdentityFile);
  await assert.rejects(stat(isolatedIdentityFile), { code: 'ENOENT' });
  return import(pathToFileURL(join(sourceDirectory, 'pair.mjs')).href);
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(path => rm(path, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

test('client identity saves a private durable proof before registration and reuses it', async () => {
  const identityFile = await identityPath();
  const first = await prepareClientIdentity({ identityFile, relayUrl, pairingToken });
  const second = await prepareClientIdentity({ identityFile, relayUrl, pairingToken });

  assert.equal(first.status, 'pending');
  assert.match(first.enrollmentToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(second, first);
  const identityStat = await stat(identityFile);
  if (process.platform !== 'win32') assert.equal(identityStat.mode & 0o777, 0o600);
  assert.match(await readFile(identityFile, 'utf8'), /"enrollmentToken"/);
});

test('completed identity binds relay and pairing token, and no longer keeps its enrollment proof', async () => {
  const identityFile = await identityPath();
  const pending = await prepareClientIdentity({ identityFile, relayUrl, pairingToken });
  const registered = await saveRegisteredClientIdentity({
    identityFile,
    relayUrl,
    pairingToken,
    enrollmentToken: pending.enrollmentToken,
    id: 'gateway-allocated-1',
    secret,
  });

  assert.deepEqual(registered, { id: 'gateway-allocated-1', secret });
  assert.deepEqual(await readRegisteredClientIdentity({ identityFile, relayUrl, pairingToken }), registered);
  assert.equal(await readRegisteredClientId({ identityFile, relayUrl, pairingToken }), 'gateway-allocated-1');
  const stored = await readFile(identityFile, 'utf8');
  assert.doesNotMatch(stored, /enrollmentToken|pairing-token|registrationKey/);
  assert.equal(await readRegisteredClientId({ identityFile, relayUrl }), 'gateway-allocated-1');
  await assert.rejects(readRegisteredClientId({ identityFile, relayUrl: otherRelayUrl, pairingToken }), /different relay origin/);
  await assert.rejects(readRegisteredClientId({ identityFile, relayUrl, pairingToken: otherPairingToken }), /different Gateway pairing token/);
});

test('concurrent first starts converge on the one atomically created enrollment proof', async () => {
  const identityFile = await identityPath();
  const results = await Promise.all(Array.from({ length: 8 }, () => prepareClientIdentity({ identityFile, relayUrl, pairingToken })));
  assert.ok(results.every(result => result.status === 'pending'));
  assert.equal(new Set(results.map(result => result.enrollmentToken)).size, 1);
});

test('damaged and oversized identity files fail closed without replacement', async () => {
  const identityFile = await identityPath();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(identityFile), { recursive: true, mode: 0o700 });
  await prepareClientIdentity({ identityFile, relayUrl, pairingToken });
  await chmod(identityFile, 0o644);
  await assert.rejects(prepareClientIdentity({ identityFile, relayUrl, pairingToken }), /must be private/);

  await chmod(identityFile, 0o600);
  const corrupt = Buffer.from('{"version":1,"unknown":true}\n');
  await writeFile(identityFile, corrupt, { mode: 0o600 });
  await assert.rejects(prepareClientIdentity({ identityFile, relayUrl, pairingToken }), /unknown fields|schema|invalid state/);
  assert.deepEqual(await readFile(identityFile), corrupt);

  await writeFile(identityFile, Buffer.alloc(4097, 0x61), { mode: 0o600 });
  await chmod(identityFile, 0o600);
  await assert.rejects(prepareClientIdentity({ identityFile, relayUrl, pairingToken }), /exceeds 4096 bytes/);
});

test('registration cannot complete after the pending proof has disappeared', async () => {
  const identityFile = await identityPath();
  const pending = await prepareClientIdentity({ identityFile, relayUrl, pairingToken });
  await rm(identityFile);
  await assert.rejects(saveRegisteredClientIdentity({
    identityFile,
    relayUrl,
    pairingToken,
    enrollmentToken: pending.enrollmentToken,
    id: 'gateway-allocated-1',
    secret,
  }), /disappeared/);
});

test('an empty optional registration key preserves the legacy single-Gateway pairing path', async () => {
  const directory = await identityDirectory();
  const identityFile = join(directory, 'private', 'identity.json');
  const output = join(dirname(identityFile), 'legacy-pairing.png');
  const { writePairingQr: writePairingQrInIsolatedRuntime } = await isolatedPairingModule(directory);
  const result = await writePairingQrInIsolatedRuntime({
    env: {
      KCODER_RELAY_REGISTRATION_KEY: '',
      KCODER_RELAY_SECRET: secret,
      KCODER_RELAY_GATEWAY_TOKEN: pairingToken,
      KCODER_RELAY_GATEWAY_ID: 'legacy-gateway',
      KCODER_RELAY_PUBLIC_URL: relayUrl,
    },
    output,
  });
  assert.equal(result, output);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
});
