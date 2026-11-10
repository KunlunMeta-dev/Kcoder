import assert from 'node:assert/strict';
import { createHash, createHmac, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { connectionProofMessage } from '../shared/gatewayConnectionRoutes.js';
import { peerAnswerSignatureMessage, peerOfferProofMessage } from '../shared/gatewayPeerTransport.js';
import { createMobileDeviceAuth, mobileDeviceStoreIdentity } from './mobile-device-auth.js';

const endpoint = 'https://studio.example.test';
const nonce = 'c'.repeat(48);
test('fixed and temporary mobile credentials both prove P2P ownership without using Relay credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-fixed-peer-proof-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixedPairingToken = 'fixed-mobile-peer-token-'.repeat(3);
  const auth = createMobileDeviceAuth({ directory, identity: null, fixedPairingToken });
  const identity = await auth.getConnectionIdentity();
  const temporary = await auth.getPairingCredential();
  const offerHash = 'd'.repeat(64);
  const proofFor = token => createHmac('sha256', Buffer.from(token, 'utf8'))
    .update(peerOfferProofMessage(identity.gatewayId, nonce, offerHash), 'utf8').digest('hex');
  const inspect = token => auth.getPeerPairingCredentialForProof(nonce, offerHash,
    createHash('sha256').update(token).digest('hex'), proofFor(token));
  assert.equal(await inspect(fixedPairingToken), fixedPairingToken);
  assert.equal(await inspect(temporary.token), temporary.token);
  assert.equal(await inspect('unrelated-internal-secret-'.repeat(3)), null);
  await auth.rotatePairingCredential();
  assert.equal(await inspect(temporary.token), null);
  assert.equal(await inspect(fixedPairingToken), fixedPairingToken);
});
const publicKeyFromHex = value => createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(value, 'hex')]),
  format: 'der', type: 'spki',
});

test('connection identity is stable across service restarts and distinct across private stores', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-connection-identity-'));
  const otherDirectory = await mkdtemp(join(tmpdir(), 'kcoder-connection-identity-other-'));
  t.after(async () => { await Promise.all([rm(directory, { recursive: true, force: true }), rm(otherDirectory, { recursive: true, force: true })]); });
  const options = { directory, identity: mobileDeviceStoreIdentity('gateway-token') };
  const first = await createMobileDeviceAuth(options).getConnectionIdentity();
  const afterRestart = await createMobileDeviceAuth(options).getConnectionIdentity();
  const otherStore = await createMobileDeviceAuth({ ...options, directory: otherDirectory }).getConnectionIdentity();
  assert.deepEqual(afterRestart, first);
  assert.equal(first.gatewayId, createHash('sha256').update(Buffer.from(first.publicKey, 'hex')).digest('hex'));
  assert.notEqual(otherStore.gatewayId, first.gatewayId);
  assert.notEqual(otherStore.publicKey, first.publicKey);
});

test('connection proof binds the exact nonce and allowlisted endpoint without mutating the device store', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-connection-proof-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = createMobileDeviceAuth({
    directory,
    identity: mobileDeviceStoreIdentity('gateway-token'),
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

test('peer pairing HMAC proof is read-only and answer signature binds the offer and answer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kcoder-peer-signing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = createMobileDeviceAuth({ directory, identity: mobileDeviceStoreIdentity('gateway-token') });
  const identity = await auth.getConnectionIdentity();
  const credential = await auth.getPairingCredential();
  const offerHash = createHash('sha256').update('client-offer', 'utf8').digest('hex');
  const keyId = createHash('sha256').update(credential.token, 'utf8').digest('hex');
  const proof = createHmac('sha256', Buffer.from(credential.token, 'utf8'))
    .update(peerOfferProofMessage(identity.gatewayId, nonce, offerHash), 'utf8').digest('hex');
  const storePath = join(directory, 'mobile-device-auth', 'devices.json');
  const beforeInvalidProof = await readFile(storePath, 'utf8');
  assert.equal(await auth.verifyPeerPairingProof(nonce, offerHash, keyId, proof), true);
  assert.equal(await auth.verifyPeerPairingProof(nonce, offerHash, keyId, '0'.repeat(64)), false);
  assert.equal(await readFile(storePath, 'utf8'), beforeInvalidProof);

  const answer = 'v=0\r\no=- gateway answer\r\n';
  const signature = await auth.signPeerAnswer(nonce, offerHash, answer);
  assert.equal(signature.length, 128);
  const publicKey = publicKeyFromHex(identity.publicKey);
  assert.equal(cryptoVerify(null, Buffer.from(peerAnswerSignatureMessage(identity.gatewayId, nonce, offerHash, answer)), publicKey, Buffer.from(signature, 'hex')), true);
  assert.equal(cryptoVerify(null, Buffer.from(peerAnswerSignatureMessage(identity.gatewayId, nonce, offerHash, 'changed')), publicKey, Buffer.from(signature, 'hex')), false);
  await assert.rejects(auth.signPeerAnswer('bad', offerHash, answer), { status: 400 });
});
