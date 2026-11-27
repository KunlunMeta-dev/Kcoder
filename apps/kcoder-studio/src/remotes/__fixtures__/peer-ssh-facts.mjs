import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { nativePeerSshSigningBytes } from '../peer-ssh-facts.mjs';

const key = byte => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, byte)]), format: 'der', type: 'pkcs8' });
const publicBytes = privateKey => [...createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)];
export function peerSshFactsFixture() {
  const nativeKey = key(7), gatewayKey = key(8);
  const enrollment = { version: 1, purpose: 'kcoder.peer-message.ssh-enrollment.v1', enrollmentId: 'owned-pin', generation: 1,
    gateway: { gatewayId: 'owned-gateway', publicKey: publicBytes(gatewayKey), keyGeneration: 1 },
    target: { targetId: 'owned-target', targetRevision: 'a'.repeat(64), accountGeneration: 'account-1', sshHostKey: 'ssh-ed25519 SHA256:fixture', sshUser: 'owned-peer' },
    native: { accountUid: 1001, profileIdentity: 'owned-profile', targetId: 'native-target', workspaceId: 'native-workspace', identityEpoch: 'epoch-1', publicKey: publicBytes(nativeKey) } };
  const claims = { version: 1, purpose: 'kcoder.peer-message.ssh-challenge.v1', enrollment,
    nativeNonce: '1'.repeat(64), gatewayNonce: '2'.repeat(64), processInstance: '3'.repeat(64) };
  const native = { claims, signature: [...sign(null, nativePeerSshSigningBytes(claims), nativeKey)] };
  return { nativeKey, gatewayKey, enrollment, claims, native };
}
