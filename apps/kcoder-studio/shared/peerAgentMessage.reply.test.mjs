import test from 'node:test';
import assert from 'node:assert/strict';
import { peerAgentMetadata } from './peerAgentMessage.ts';
const metadata = { version: 1, messageId: 'reply-mid', sourceThreadId: 'source', targetThreadId: 'target',
  createdAtMs: 1, bodySha256: 'a'.repeat(64), replyToMessageId: 'received-original',
  sourceAddress: { targetId: 'native-a', workspaceId: 'workspace-a', threadId: 'source' },
  targetAddress: { targetId: 'native-b', workspaceId: 'workspace-b', threadId: 'target' } };
test('received peer metadata retains a validated reply association without deriving it from body text', () => {
  assert.equal(peerAgentMetadata({ role: 'peer_agent', agentMessage: metadata }, 'target').replyToMessageId, 'received-original');
  assert.equal(peerAgentMetadata({ role: 'peer_agent', agentMessage: { ...metadata, replyToMessageId: 'foreign/address' } }, 'target'), null);
  const { replyToMessageId: _reply, ...old } = metadata;
  assert.equal(peerAgentMetadata({ role: 'peer_agent', agentMessage: old, content: 'replyToMessageId=untrusted-body' }, 'target').replyToMessageId, undefined);
});
