import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isContract } from '../../shared/generated/validator.mjs';
import { requireRouter, routerIdentity } from '../agent-message-router-private.js';
import { PEER_SSH_AUTH, PEER_SSH_CHALLENGE_PURPOSE,
  verifyNativePeerSshProof, orderedNativePeerSshProof } from './peer-ssh-facts.mjs';
import { requirePeerSshPinAuthority } from './peer-ssh-pin-store.mjs';

const readyFacts = new WeakSet();
const nonce = () => randomBytes(32).toString('hex');
export function peerSshEnrollmentSelector(selection) {
  const captured = requirePeerSshPinAuthority(selection);
  captured.assertCurrent();
  return captured.expected.enrollmentId;
}
export function assertPeerSshEnrollmentCurrent(selection) {
  const captured = requirePeerSshPinAuthority(selection);
  captured.assertCurrent();
}
export async function revalidatePeerSshEnrollment(selection) {
  const captured = requirePeerSshPinAuthority(selection);
  captured.assertCurrent();
  await captured.revalidate();
  captured.assertCurrent();
}

function request(broker, method, params) {
  requireRouter(!broker.closed && !broker.initializeResponse && broker.initializePending == null &&
    Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER, method, params })) <= 16 * 1024,
  'AGENT_MESSAGES_SSH_AUTH_PHASE_INVALID');
  return new Promise((resolve, reject) => broker.sendInternalRequest(method, params, { onResponse: response => {
    if (response?.error || !Object.hasOwn(response ?? {}, 'result')) reject(new Error('AGENT_MESSAGES_SSH_AUTH_REJECTED'));
    else resolve(response.result);
  } }));
}

/** Exchanges facts on the original tracked SSH stdio before initialize. The
 * caller still needs Native's actual private capability and identity afterward.
 */
export async function authenticateEnrolledPeerSsh({ selection, broker, authentication, assertTransport }) {
  const captured = requirePeerSshPinAuthority(selection);
  requireRouter(typeof assertTransport === 'function', 'AGENT_MESSAGES_SSH_PIN_AUTHORITY_REQUIRED');
  const check = async () => { assertTransport(); await revalidatePeerSshEnrollment(selection); assertTransport(); };
  await check();
  const ssh = await authentication.ready;
  await check();
  const expected = captured.expected;
  requireRouter(ssh.key === expected.target.sshHostKey && ssh.username === expected.target.sshUser,
    'AGENT_MESSAGES_SSH_PIN_TRANSPORT_CHANGED');
  const offer = await request(broker, PEER_SSH_AUTH.offer, { enrollmentId: expected.enrollmentId });
  await check();
  requireRouter(isContract('PeerSshChallengeOfferV1', offer) && offer.version === 1 &&
    offer.enrollmentId === expected.enrollmentId && offer.enrollmentGeneration === expected.generation &&
    offer.purpose === PEER_SSH_CHALLENGE_PURPOSE, 'AGENT_MESSAGES_SSH_PIN_OFFER_CHANGED');
  const claims = { version: 1, purpose: PEER_SSH_CHALLENGE_PURPOSE, enrollment: expected,
    nativeNonce: offer.nativeNonce, gatewayNonce: nonce(), processInstance: offer.processInstance };
  const native = verifyNativePeerSshProof(await request(broker, PEER_SSH_AUTH.nativeProof, { claims }), claims);
  await check();
  const proof = await captured.signNativeProof(orderedNativePeerSshProof(native));
  await check();
  requireRouter(isContract('PeerSshGatewayProofV1', proof) && isDeepStrictEqual(proof.native, native),
    'AGENT_MESSAGES_SSH_GATEWAY_PROOF_CHANGED');
  const completed = await request(broker, PEER_SSH_AUTH.complete, { proof });
  await check();
  requireRouter(isContract('PeerSshAuthCompleteResultV1', completed) && completed.version === 1 &&
    completed.enrollmentId === expected.enrollmentId && completed.generation === expected.generation &&
    completed.processInstance === offer.processInstance, 'AGENT_MESSAGES_SSH_AUTH_COMPLETION_CHANGED');
  const facts = Object.freeze({ selection, enrollment: expected, processInstance: offer.processInstance });
  readyFacts.add(facts);
  return facts;
}
export function verifyEnrolledPeerSshIdentity(facts, identity) {
  requireRouter(readyFacts.has(facts), 'AGENT_MESSAGES_SSH_PIN_AUTHORITY_REQUIRED');
  assertPeerSshEnrollmentCurrent(facts.selection);
  const actual = routerIdentity(identity), expected = facts.enrollment.native;
  requireRouter(actual.targetId === expected.targetId && actual.workspaceId === expected.workspaceId &&
    actual.identityEpoch === expected.identityEpoch && isDeepStrictEqual(actual.publicKey, expected.publicKey) &&
    actual.principal.kind === 'localOs', 'AGENT_MESSAGES_SSH_ENDPOINT_CHANGED');
  return actual;
}
