import assert from 'node:assert/strict';
import { createHash, createHmac, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connectionProofMessage } from '../shared/gatewayConnectionRoutes.js';
import { createGatewayDeviceAuth, gatewayDeviceStoreIdentity } from './gateway-device-auth.js';

const endpoint = 'https://studio.example.test';
const nonce = 'c'.repeat(48);
const publicKeyFromHex = value => createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(value, 'hex')]),
  format: 'der', type: 'spki',
});

test('connection identity is stable across service restarts and distinct across private stores', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-connection-identity-'));
  const otherDirectory = await mkdtemp(join(tmpdir(), 'kcoder-connection-identity-other-'));
  t.after(async () => { await Promise.all([rm(directory, { recursive: true, force: true }), rm(otherDirectory, { recursive: true, force: true })]); });
  const options = { directory, identity: gatewayDeviceStoreIdentity('gateway-token') };
  const first = await createGatewayDeviceAuth(options).getConnectionIdentity();
  const afterRestart = await createGatewayDeviceAuth(options).getConnectionIdentity();
  const otherStore = await createGatewayDeviceAuth({ ...options, directory: otherDirectory }).getConnectionIdentity();
  assert.deepEqual(afterRestart, first);
  assert.equal(first.gatewayId, createHash('sha256').update(Buffer.from(first.publicKey, 'hex')).digest('hex'));
  assert.notEqual(otherStore.gatewayId, first.gatewayId);
  assert.notEqual(otherStore.publicKey, first.publicKey);
});

test('connection proof binds the exact nonce and allowlisted endpoint without mutating the device store', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-connection-proof-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = createGatewayDeviceAuth({
    directory,
    identity: gatewayDeviceStoreIdentity('gateway-token'),
    isConnectionEndpointAllowed: value => value === endpoint,
  });
  const identity = await auth.getConnectionIdentity();
  const storePath = join(directory, 'mobile-device-auth', 'devices.json');
  const storeBefore = await readFile(storePath, 'utf8');
  const proof = await auth.signConnectionProof(nonce, endpoint);
  assert.deepEqual(Object.keys(proof).sort(), ['endpoint', 'gatewayId', 'nonce', 'signature', 'version']);
  assert.equal(proof.version, 1);
  assert.equal(proof.gatewayId, identity.gatewayId);
  assert.equal(proof.signature.length, 128);
  const publicKey = publicKeyFromHex(identity.publicKey);
  const signed = Buffer.from(connectionProofMessage(identity.gatewayId, nonce, endpoint));
  assert.equal(cryptoVerify(null, signed, publicKey, Buffer.from(proof.signature, 'hex')), true);
  assert.equal(cryptoVerify(null, Buffer.from(connectionProofMessage(identity.gatewayId, `${nonce.slice(0, -1)}d`, endpoint)), publicKey, Buffer.from(proof.signature, 'hex')), false);
  assert.equal(cryptoVerify(null, Buffer.from(connectionProofMessage(identity.gatewayId, nonce, 'https://other.example.test')), publicKey, Buffer.from(proof.signature, 'hex')), false);
  assert.equal(await readFile(storePath, 'utf8'), storeBefore);
  await assert.rejects(auth.signConnectionProof('bad-nonce', endpoint), { status: 400 });
  await assert.rejects(auth.signConnectionProof(nonce, 'https://other.example.test'), { status: 404 });
});
