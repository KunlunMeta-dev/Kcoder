import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptNativeToolApproval, nativeApprovalAccepted, pendingNativeToolApproval } from './native-tool-approval.mjs';

function request(id, name) {
  return { direction: 'received', frame: { id, method: 'approval/request', params: {
    threadId: 'owned-thread', turnId: 'turn-1', approvalId: `approval-${id}`,
    action: { type: 'tool', name },
  } } };
}

function accept(row, overrides = {}) {
  const { id, params } = row.frame;
  const binding = { approvalId: params.approvalId, threadId: params.threadId, turnId: params.turnId, decision: 'accept', ...overrides };
  return [{ direction: 'sent', frame: { id, result: binding } },
    { direction: 'received', frame: { method: 'approval/resolved', params: { requestId: id, ...binding } } }];
}

test('two sequential ASK requests select the current tool and exact approval option, retaining old history', async () => {
  const search = request(1000000, 'WebSearch');
  const fetch = request(1000001, 'WebFetch');
  const frames = [search, ...accept(search), fetch];
  assert.equal(pendingNativeToolApproval(frames, 'WebSearch'), undefined);
  assert.equal(pendingNativeToolApproval(frames, 'WebFetch'), fetch.frame);
  const clicks = [];
  const page = { getByTestId(id) {
    assert.equal(id, 'request-user-input-card');
    return {
      waitFor: async () => {},
      getByTestId(child) {
        if (child === 'permission-approval-content') return { innerText: async () => 'WebFetch' };
        return { async click() { clicks.push(child); frames.push(...accept(fetch)); } };
      },
    };
  } };
  const selected = await acceptNativeToolApproval(page, frames, 'WebFetch', { timeoutMs: 500 });
  assert.equal(selected, fetch.frame);
  assert.deepEqual(clicks, ['request-user-input-option-approval-1000001-0']);
  assert.equal(nativeApprovalAccepted(frames, fetch.frame), true);
});

test('old, wrong-owner, wrong-turn, absent and merely sent replies cannot acknowledge a new request', () => {
  const search = request(1000000, 'WebSearch'), fetch = request(1000001, 'WebFetch');
  for (const rows of [accept(search), accept(fetch, { threadId: 'peer' }),
    accept(fetch, { turnId: 'turn-2' }), accept(fetch, { approvalId: 'late-old' }),
    accept(fetch).slice(0, 1), accept(fetch).slice(1), []]) {
    assert.equal(nativeApprovalAccepted([search, fetch, ...rows], fetch.frame), false);
  }
});

test('local command regression binds its exact command instead of treating every command as the requested tool', () => {
  const row = request(1, 'bash');
  row.frame.params.action = { type: 'command', command: "printf 'OWNED_NATIVE_APPROVAL_0\\n'" };
  assert.equal(pendingNativeToolApproval([row], 'bash'), undefined);
  assert.equal(pendingNativeToolApproval([row], 'bash', 'peer command'), undefined);
  assert.equal(pendingNativeToolApproval([row], 'bash', row.frame.params.action.command), row.frame);
});
