import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { ROUTER_METHODS, privateRouterFrame, requireRouterOperation, requireRouterReceipt, routeProof } from '../../src/agent-message-router-private.js';

/** Fixture-only reader for one actual, already accepted operation. Captured
 * signed facts never replace current subject/target/account checks. It queries
 * the original destination queue without acquiring the Source execution lease.
 */
export function captureAcceptedPeerReceiptReader({ operation, proof, verifyCurrent, sourceIdentity, destinationIdentity, queryDestination }) {
  privateRouterFrame({ method: ROUTER_METHODS.queryOriginal, params: {} }, proof);
  requireRouterOperation(operation, proof.source, operation.sourceAddress);
  assert.equal(operation.stage, 'receipted');
  assert.ok(operation.receipt);
  const original = structuredClone(operation);
  const originalProof = structuredClone(proof);
  const verifyIdentities = async () => {
    verifyCurrent();
    const [source, destination] = await Promise.all([sourceIdentity(), destinationIdentity()]);
    verifyCurrent();
    assert.ok(isDeepStrictEqual(source, originalProof.source), 'Original Source Native identity changed');
    assert.ok(isDeepStrictEqual(destination, originalProof.destination), 'Original destination Native identity changed');
  };
  verifyCurrent();
  return async receipt => {
    requireRouterReceipt(receipt, original);
    assert.equal(receipt.messageId, original.receipt.messageId);
    await verifyIdentities();
    const purpose = routeProof(originalProof.source, originalProof.destination, originalProof.authorizationId);
    const response = await queryDestination({ attestation: original.attestation, query: { messageId: original.receipt.messageId } }, purpose);
    verifyCurrent();
    assert.ok(response && !response.error && Object.hasOwn(response, 'result'), 'Original destination receipt is unconfirmed');
    const value = response.result;
    assert.ok(value && Object.keys(value).length === 1 && Object.hasOwn(value, 'receipt'));
    if (value.receipt !== null) {
      requireRouterReceipt(value.receipt, original);
      assert.equal(value.receipt.messageId, original.receipt.messageId);
    }
    await verifyIdentities();
    return value;
  };
}
