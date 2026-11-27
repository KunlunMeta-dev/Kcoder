import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { nativePeerSshSigningBytes, gatewayPeerSshSigningBytes, orderedPeerSshEnrollment,
  verifyNativePeerSshProof, signGatewayPeerSshProof } from './remotes/peer-ssh-facts.mjs';

import { peerSshFactsFixture } from './remotes/__fixtures__/peer-ssh-facts.mjs';
test('SSH facts use typed Rust field order and separate signature domains', () => {
  const f = peerSshFactsFixture();
  const shuffled = JSON.parse(JSON.stringify(f.claims));
  shuffled.enrollment = Object.fromEntries(Object.entries(shuffled.enrollment).reverse());
  shuffled.enrollment.target = Object.fromEntries(Object.entries(shuffled.enrollment.target).reverse());
  assert.deepEqual(nativePeerSshSigningBytes(shuffled), nativePeerSshSigningBytes(f.claims));
  assert.notDeepEqual(nativePeerSshSigningBytes(f.claims), gatewayPeerSshSigningBytes(f.native));
  assert.deepEqual(verifyNativePeerSshProof(f.native, f.claims), f.native);
  const proof = signGatewayPeerSshProof(f.native, f.gatewayKey);
  assert.equal(verify(null, gatewayPeerSshSigningBytes(f.native), createPublicKey(f.gatewayKey), Buffer.from(proof.signature)), true);
  assert.equal(verify(null, nativePeerSshSigningBytes(f.claims), createPublicKey(f.gatewayKey), Buffer.from(proof.signature)), false);
});
test('SSH signatures reject foreign pin, scope, epoch, nonce and malformed schema', () => {
  const f = peerSshFactsFixture();
  for (const change of [value => { value.enrollment.native.identityEpoch = 'other'; },
    value => { value.enrollment.target.sshUser = 'other'; }, value => { value.enrollment.gateway.keyGeneration++; },
    value => { value.gatewayNonce = '4'.repeat(64); }, value => { value.processInstance = '5'.repeat(64); }]) {
    const changed = structuredClone(f.claims); change(changed);
    assert.throws(() => verifyNativePeerSshProof(f.native, changed));
  }
  const damaged = structuredClone(f.native); damaged.signature[0] ^= 1;
  assert.throws(() => verifyNativePeerSshProof(damaged, f.claims), /SIGNATURE_INVALID/);
  assert.throws(() => orderedPeerSshEnrollment({ ...f.enrollment, allow: true }));
  assert.throws(() => nativePeerSshSigningBytes({ ...f.claims, gatewayNonce: f.claims.nativeNonce }));
});
test('SSH canonical bytes have a stable digest for cross-language verification', () => {
  const { claims, native } = peerSshFactsFixture();
  const digest = value => createHash('sha256').update(value).digest('hex');
  assert.equal(digest(nativePeerSshSigningBytes(claims)), '8eda2b2c92de35e9284b0b75a64b6f3b96099c98d06b4c38b089ebb856b2a4ef');
  assert.equal(digest(gatewayPeerSshSigningBytes(native)), 'd300bb2b623342aeef815d65fc20d5799d79cc0365410ce9c31bfb122485ab6d');
});
