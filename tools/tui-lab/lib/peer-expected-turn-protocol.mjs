import assert from 'node:assert/strict';
export const EXPECTED_TARGET = 'OWNED_EXPECTED_TARGET_ACTIVE';
export const EXPECTED_TARGET_CANCEL = 'OWNED_EXPECTED_TARGET_CANCEL';
export const EXPECTED_END_DONE = 'OWNED_EXPECTED_ENDED_TURN_REJECTED';
export const EXPECTED_CANCEL_DONE = 'OWNED_EXPECTED_CANCELLED_TURN_REJECTED';

/** Fixed Provider frames choose selectors only from actual ListSessions/tool replies. */
export function createExpectedTurnProtocol({ sourceIdle, peer, sent, acknowledged }) {
  let destination, sourceAddress, receipt, duplicate, ended, cancelled, currentTurn, cancelledTurn;
  let selectorReady = false, releaseCancellation;
  const cancellation = new Promise(resolve => { releaseCancellation = resolve; });
  const send = (call, id, clientMessageId, expectedTurnId) => ({ delta: call(id, 'SendSessionMessage', {
    targetThreadId: destination.threadId, targetAddress: destination, clientMessageId,
    mode: 'enqueue_only', expectedTurnId, text: peer,
  }), finish: 'tool_calls' });
  return {
    get selectorReady() { return selectorReady; },
    releaseCancellation,
    snapshot: () => ({ destination, sourceAddress, receipt, duplicate, ended, cancelled, currentTurn, cancelledTurn }),
    async respond({ isSource, number, context, response, call, output }) {
      if (!isSource) {
        if (number === 1) {
          assert.ok(context.includes(EXPECTED_TARGET));
          await sourceIdle;
          return { delta: { role: 'assistant', content: 'OWNED_EXPECTED_FIRST_BOUNDARY' }, finish: 'stop' };
        }
        if (number === 2) {
          assert.ok(context.includes(peer) && context.includes('untrusted_peer_agent_reference'));
          return { delta: { role: 'assistant', content: acknowledged }, finish: 'stop' };
        }
        assert.equal(number, 3); assert.ok(context.includes(EXPECTED_TARGET_CANCEL));
        await new Promise(resolve => response.once('close', resolve));
        return null;
      }
      if (number === 1) return { delta: call('expected-discover-current', 'ListSessions', {}), finish: 'tool_calls' };
      if (number === 2) {
        const listing = output('expected-discover-current');
        const target = listing.targets.find(row => row.status === 'running' && row.activeTurnId);
        assert.ok(target?.address, 'the actual held target must expose its registered canonical turn');
        destination = target.address; currentTurn = target.activeTurnId;
        assert.equal(target.threadId, destination.threadId);
        return send(call, 'expected-send-current', 'owned-expected-current', currentTurn);
      }
      if (number === 3) {
        receipt = output('expected-send-current'); sourceAddress = receipt.sourceAddress;
        assert.equal(receipt.status, 'queued', 'the first admission is observed while the real target response is held');
        assert.deepEqual(receipt.targetAddress, destination);
        return { delta: { role: 'assistant', content: sent }, finish: 'stop' };
      }
      if (number === 4) return send(call, 'expected-reconcile-original', receipt.clientMessageId, currentTurn);
      if (number === 5) {
        duplicate = output('expected-reconcile-original');
        assert.equal(duplicate.messageId, receipt.messageId);
        assert.equal(duplicate.clientMessageId, receipt.clientMessageId);
        assert.equal(duplicate.status, 'applied');
        return send(call, 'expected-send-ended', 'owned-expected-after-end', currentTurn);
      }
      if (number === 6) {
        ended = output('expected-send-ended');
        assert.equal(ended.status, 'rejected'); assert.equal(ended.reasonCode, 'target_turn_changed');
        return { delta: { role: 'assistant', content: EXPECTED_END_DONE }, finish: 'stop' };
      }
      if (number === 7) return { delta: call('expected-discover-cancellation', 'ListSessions', {}), finish: 'tool_calls' };
      if (number === 8) {
        const target = output('expected-discover-cancellation').targets.find(row => row.threadId === destination.threadId);
        assert.equal(target?.status, 'running'); assert.ok(target.activeTurnId);
        cancelledTurn = target.activeTurnId; assert.notEqual(cancelledTurn, currentTurn);
        assert.equal(target.lastTurn ?? null, null, 'a newer Accepted turn cannot borrow an older completed result');
        selectorReady = true; await cancellation;
        return send(call, 'expected-send-cancelled', 'owned-expected-after-cancel', cancelledTurn);
      }
      if (number === 9) {
        cancelled = output('expected-send-cancelled');
        assert.equal(cancelled.status, 'rejected'); assert.equal(cancelled.reasonCode, 'target_turn_changed');
        return { delta: call('expected-observe-cancelled-terminal', 'ListSessions', {}), finish: 'tool_calls' };
      }
      assert.equal(number, 10);
      const target = output('expected-observe-cancelled-terminal').targets.find(row => row.threadId === destination.threadId);
      assert.equal(target?.activeTurnId ?? null, null); assert.equal(target?.lastTurn?.turnId, cancelledTurn);
      assert.equal(target?.lastTurn?.status, 'interrupted');
      return { delta: { role: 'assistant', content: EXPECTED_CANCEL_DONE }, finish: 'stop' };
    },
  };
}
