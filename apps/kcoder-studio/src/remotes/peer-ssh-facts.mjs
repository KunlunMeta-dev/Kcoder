import { createPublicKey, sign, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isPeerSshChallengeClaimsV1, isPeerSshEnrollmentV1, isPeerSshNativeProofV1 } from '../../shared/generated/contractGuards.peer-ssh.mjs';
import { requireRouter } from '../agent-message-router-private.js';

export const PEER_SSH_AUTH = Object.freeze({ offer: 'peerSsh/auth/offerV1', nativeProof: 'peerSsh/auth/nativeProofV1', complete: 'peerSsh/auth/completeV1' });
export const PEER_SSH_ENROLLMENT_PURPOSE = 'kcoder.peer-message.ssh-enrollment.v1';
export const PEER_SSH_CHALLENGE_PURPOSE = 'kcoder.peer-message.ssh-challenge.v1';
export const PEER_SSH_PIN_PURPOSE = 'kcoder.peer-message.ssh-pin-change.v1';
const nativeDomain = Buffer.from('kcoder.peer-message.ssh-native-fact.v1\0');
const gatewayDomain = Buffer.from('kcoder.peer-message.ssh-gateway-fact.v1\0');
const reject = 'AGENT_MESSAGES_SSH_PIN_FACTS_INVALID';

// Reconstruct Rust's typed field order before signing, independently of the
// property insertion order in a received JSON object. Facts grant no authority.
export function orderedPeerSshEnrollment(value) {
  requireRouter(isPeerSshEnrollmentV1(value), reject);
  return { version: value.version, purpose: value.purpose, enrollmentId: value.enrollmentId, generation: value.generation,
    gateway: { gatewayId: value.gateway.gatewayId, publicKey: [...value.gateway.publicKey], keyGeneration: value.gateway.keyGeneration },
    target: { targetId: value.target.targetId, targetRevision: value.target.targetRevision, accountGeneration: value.target.accountGeneration,
      sshHostKey: value.target.sshHostKey, sshUser: value.target.sshUser },
    native: { accountUid: value.native.accountUid, profileIdentity: value.native.profileIdentity, targetId: value.native.targetId,
      workspaceId: value.native.workspaceId, identityEpoch: value.native.identityEpoch, publicKey: [...value.native.publicKey] } };
}
export function orderedPeerSshClaims(value) {
  requireRouter(isPeerSshChallengeClaimsV1(value) && value.nativeNonce !== value.gatewayNonce, reject);
  return { version: value.version, purpose: value.purpose, enrollment: orderedPeerSshEnrollment(value.enrollment),
    nativeNonce: value.nativeNonce, gatewayNonce: value.gatewayNonce, processInstance: value.processInstance };
}
export function nativePeerSshSigningBytes(claims) {
  return Buffer.concat([nativeDomain, Buffer.from(JSON.stringify(orderedPeerSshClaims(claims)))]);
}
export function orderedNativePeerSshProof(value) {
  requireRouter(isPeerSshNativeProofV1(value), reject);
  return { claims: orderedPeerSshClaims(value.claims), signature: [...value.signature] };
}
export function gatewayPeerSshSigningBytes(proof) {
  return Buffer.concat([gatewayDomain, Buffer.from(JSON.stringify(orderedNativePeerSshProof(proof)))]);
}
export function verifyNativePeerSshProof(proof, expectedClaims) {
  const ordered = orderedNativePeerSshProof(proof);
  requireRouter(isDeepStrictEqual(ordered.claims, orderedPeerSshClaims(expectedClaims)), 'AGENT_MESSAGES_SSH_CHALLENGE_CHANGED');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(expectedClaims.enrollment.native.publicKey)]), format: 'der', type: 'spki' });
  requireRouter(verify(null, nativePeerSshSigningBytes(ordered.claims), key, Buffer.from(ordered.signature)),
    'AGENT_MESSAGES_SSH_NATIVE_SIGNATURE_INVALID');
  return ordered;
}
export function signGatewayPeerSshProof(native, privateKey) {
  const proof = orderedNativePeerSshProof(native);
  return { native: proof, signature: [...sign(null, gatewayPeerSshSigningBytes(proof), privateKey)] };
}
