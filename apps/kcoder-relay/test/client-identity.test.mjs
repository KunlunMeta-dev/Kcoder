import assert from 'node:assert/strict';
import {
  chmod,
  copyFile,
  link,
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
  prepareInstanceIdentityFile,
  readRegisteredClientId,
  readRegisteredClientIdentity,
  resolveIdentityFile,
  saveRegisteredClientIdentity,
} from '../src/client-identity.mjs';

const temporaryDirectories = new Set();
const relayUrl = 'https://relay.example.test:8451';
const otherRelayUrl = 'https://other.example.test:8451';
const gatewaySecret = 'pairing-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const otherGatewaySecret = 'different-token-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
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
  const sharedDirectory = join(runtimeRoot, 'apps', 'kcoder-studio', 'shared');
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  await mkdir(sharedDirectory, { recursive: true, mode: 0o700 });
  for (const name of ['pair.mjs', 'config.mjs', 'admin-auth.mjs', 'client-identity.mjs', 'connection-routes.mjs', 'gateway-origin.mjs']) {
    await copyFile(join(relayPackageRoot, 'src', name), join(sourceDirectory, name));
  }
  await copyFile(
    join(relayPackageRoot, '../kcoder-studio/shared/gatewayConnectionRoutes.js'),
    join(sharedDirectory, 'gatewayConnectionRoutes.js'),
  );

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
  const first = await prepareClientIdentity({ identityFile, relayUrl, gatewaySecret });
  const second = await prepareClientIdentity({ identityFile, relayUrl, gatewaySecret });

  assert.equal(first.status, 'pending');
  assert.match(first.enrollmentToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(second, first);
  const identityStat = await stat(identityFile);
  if (process.platform !== 'win32') assert.equal(identityStat.mode & 0o777, 0o600);
  assert.match(await readFile(identityFile, 'utf8'), /"enrollmentToken"/);
});

test('completed identity binds relay and pairing token, and no longer keeps its enrollment proof', async () => {
  const identityFile = await identityPath();
  const pending = await prepareClientIdentity({ identityFile, relayUrl, gatewaySecret });
  const registered = await saveRegisteredClientIdentity({
    identityFile,
    relayUrl,
    gatewaySecret,
    enrollmentToken: pending.enrollmentToken,
    id: 'gateway-allocated-1',
    secret,
  });

  assert.deepEqual(registered, { id: 'gateway-allocated-1', secret });
  assert.deepEqual(await readRegisteredClientIdentity({ identityFile, relayUrl, gatewaySecret }), registered);
  assert.equal(await readRegisteredClientId({ identityFile, relayUrl, gatewaySecret }), 'gateway-allocated-1');
  const stored = await readFile(identityFile, 'utf8');
  assert.doesNotMatch(stored, /enrollmentToken|pairing-token|registrationKey/);
  assert.equal(await readRegisteredClientId({ identityFile, relayUrl }), 'gateway-allocated-1');
  await assert.rejects(readRegisteredClientId({ identityFile, relayUrl: otherRelayUrl, gatewaySecret }), /different relay origin/);
  await assert.rejects(readRegisteredClientId({ identityFile, relayUrl, gatewaySecret: otherGatewaySecret }), /different Gateway internal secret/);
});

test('concurrent first starts converge on the one atomically created enrollment proof', async () => {
  const identityFile = await identityPath();
  const results = await Promise.all(Array.from({ length: 8 }, () => prepareClientIdentity({ identityFile, relayUrl, gatewaySecret })));
  assert.ok(results.every(result => result.status === 'pending'));
  assert.equal(new Set(results.map(result => result.enrollmentToken)).size, 1);
});

test('managed identity paths are instance-scoped and explicit paths retain precedence', async () => {
  const directory = await identityDirectory();
  const first = resolveIdentityFile({}, join(directory, 'dev'));
  const second = resolveIdentityFile({}, join(directory, 'electron'));
  assert.equal(first, join(directory, 'dev/relay/client-identity.json'));
  assert.notEqual(first, second);
  const explicit = join(directory, 'custom.json');
  assert.equal(resolveIdentityFile({ KCODER_RELAY_IDENTITY_FILE: explicit }, directory), explicit);
  assert.equal(await prepareInstanceIdentityFile({ stateDirectory: directory,
    legacyIdentityFile: join(directory, 'relay-identity.json'), relayUrl, gatewaySecret }),
  join(directory, 'relay/client-identity.json'));
  await assert.rejects(stat(join(directory, 'relay')), { code: 'ENOENT' });
});

for (const legacyPath of ['relay-identity.json', 'desktop-relay/client-identity.json']) {
  for (const registered of [false, true]) {
    test(`startup adopts ${registered ? 'registered identity' : 'pending proof'} from ${legacyPath} without changing it`, async () => {
      const stateDirectory = await identityDirectory();
      const legacyIdentityFile = join(stateDirectory, legacyPath);
      const pending = await prepareClientIdentity({ identityFile: legacyIdentityFile, relayUrl, gatewaySecret });
      if (registered) await saveRegisteredClientIdentity({ identityFile: legacyIdentityFile, relayUrl, gatewaySecret,
        enrollmentToken: pending.enrollmentToken, id: 'original-gateway', secret });
      const original = await readFile(legacyIdentityFile);
      const before = await stat(legacyIdentityFile);
      const options = { stateDirectory, legacyIdentityFile, relayUrl, gatewaySecret };
      const identityFile = await prepareInstanceIdentityFile(options);
      assert.equal(identityFile, resolveIdentityFile({}, stateDirectory));
      assert.deepEqual(await readFile(identityFile), original);
      assert.equal((await stat(identityFile)).ino, before.ino);
      assert.equal((await stat(identityFile)).nlink, 1);
      await assert.rejects(stat(legacyIdentityFile), { code: 'ENOENT' });
      assert.equal(await prepareInstanceIdentityFile(options), identityFile);
      if (registered) assert.equal(await readRegisteredClientId({ identityFile, relayUrl, gatewaySecret }), 'original-gateway');
      else assert.deepEqual(await prepareClientIdentity({ identityFile, relayUrl, gatewaySecret }), pending);
    });
  }
}

test('interrupted identity relocation resumes and concurrent startup cleanup is idempotent', async () => {
  const stateDirectory = await identityDirectory();
  const legacyIdentityFile = join(stateDirectory, 'relay-identity.json');
  const pending = await prepareClientIdentity({ identityFile: legacyIdentityFile, relayUrl, gatewaySecret });
  const identityFile = resolveIdentityFile({}, stateDirectory);
  await mkdir(dirname(identityFile), { mode: 0o700 });
  await link(legacyIdentityFile, identityFile);
  const results = await Promise.all(Array.from({ length: 4 }, () => prepareInstanceIdentityFile({
    stateDirectory, legacyIdentityFile, relayUrl, gatewaySecret })));
  assert.ok(results.every(value => value === identityFile));
  assert.equal((await stat(identityFile)).nlink, 1);
  assert.deepEqual(await prepareClientIdentity({ identityFile, relayUrl, gatewaySecret }), pending);
  await assert.rejects(stat(legacyIdentityFile), { code: 'ENOENT' });
});

test('conflicting identities or mismatched credentials are never overwritten or re-enrolled', async () => {
  const stateDirectory = await identityDirectory();
  const legacyIdentityFile = join(stateDirectory, 'relay-identity.json');
  const identityFile = resolveIdentityFile({}, stateDirectory);
  await prepareClientIdentity({ identityFile: legacyIdentityFile, relayUrl, gatewaySecret });
  const before = await readFile(legacyIdentityFile);
  await assert.rejects(prepareInstanceIdentityFile({ stateDirectory, legacyIdentityFile, relayUrl,
    gatewaySecret: otherGatewaySecret }), /different Gateway internal secret/);
  await assert.rejects(stat(identityFile), { code: 'ENOENT' });
  await prepareClientIdentity({ identityFile, relayUrl, gatewaySecret });
  const competing = await readFile(identityFile);
  await assert.rejects(prepareInstanceIdentityFile({ stateDirectory, legacyIdentityFile, relayUrl, gatewaySecret }), /Conflicting/);
  assert.deepEqual(await readFile(legacyIdentityFile), before);
  assert.deepEqual(await readFile(identityFile), competing);
});

test('identity relocation rejects a linked destination directory and preserves the original', async () => {
  const stateDirectory = await identityDirectory();
  const legacyIdentityFile = join(stateDirectory, 'relay-identity.json');
  await prepareClientIdentity({ identityFile: legacyIdentityFile, relayUrl, gatewaySecret });
  const before = await readFile(legacyIdentityFile);
  const outside = await identityDirectory();
  await symlink(outside, join(stateDirectory, 'relay'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareInstanceIdentityFile({ stateDirectory, legacyIdentityFile, relayUrl, gatewaySecret }), /private and owner-owned/);
  assert.deepEqual(await readFile(legacyIdentityFile), before);
  await assert.rejects(stat(join(outside, 'client-identity.json')), { code: 'ENOENT' });
});

test('damaged and oversized identity files fail closed without replacement', async () => {
  const identityFile = await identityPath();
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dirname(identityFile), { recursive: true, mode: 0o700 });
  await prepareClientIdentity({ identityFile, relayUrl, gatewaySecret });
  await chmod(identityFile, 0o644);
  await assert.rejects(prepareClientIdentity({ identityFile, relayUrl, gatewaySecret }), /must be private/);

  await chmod(identityFile, 0o600);
  const corrupt = Buffer.from('{"version":1,"unknown":true}\n');
  await writeFile(identityFile, corrupt, { mode: 0o600 });
  await assert.rejects(prepareClientIdentity({ identityFile, relayUrl, gatewaySecret }), /unknown fields|schema|invalid state/);
  assert.deepEqual(await readFile(identityFile), corrupt);

  await writeFile(identityFile, Buffer.alloc(4097, 0x61), { mode: 0o600 });
  await chmod(identityFile, 0o600);
  await assert.rejects(prepareClientIdentity({ identityFile, relayUrl, gatewaySecret }), /exceeds 4096 bytes/);
});

test('registration cannot complete after the pending proof has disappeared', async () => {
  const identityFile = await identityPath();
  const pending = await prepareClientIdentity({ identityFile, relayUrl, gatewaySecret });
  await rm(identityFile);
  await assert.rejects(saveRegisteredClientIdentity({
    identityFile,
    relayUrl,
    gatewaySecret,
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
    fetchImpl: async () => Response.json({ kind: 'temporary', token: 'f'.repeat(64), expiresAt: Date.now() + 60_000, publicBaseUrl: relayUrl, connectionRoutes: { version: 1, gatewayId: 'a'.repeat(64), publicKey: 'b'.repeat(64), endpoints: [{ kind: 'public', url: relayUrl }] } }),
    env: {
      KCODER_RELAY_REGISTRATION_KEY: '',
      KCODER_RELAY_SECRET: secret,
      KCODER_RELAY_GATEWAY_SECRET: gatewaySecret,
      KCODER_RELAY_GATEWAY_ID: 'legacy-gateway',
      KCODER_RELAY_PUBLIC_URL: relayUrl,
    },
    output,
  });
  assert.equal(result, output);
  if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
});
