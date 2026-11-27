import test from 'node:test';
import assert from 'node:assert/strict';
import { feishuEvent } from '../src/normalizers.mjs';
const scope = { accountId: 'owner', targetId: 'target', workspaceId: 'workspace', identityGeneration: '1', targetRevision: '1' };
const event = { platform: 'feishu', channelId: 'connection', tenantId: 'tenant', botId: 'app',
  channelInstanceId: 'sdk', sourceRevision: 'source-1', senderId: 'member-1', eventId: 'event-1',
  conversationId: 'chat', chatKind: 'group', kind: 'message', text: 'Private input not copied', attachments: [] };

test('Feishu retains genuine topic and source message IDs and filters application/bot loops', () => {
  const config = { channelId: 'connection', appId: 'app' };
  const packet = { header: { event_id: 'event', tenant_key: 'tenant' }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: 'member' } },
    message: { message_id: 'message', thread_id: 'topic', chat_id: 'chat', chat_type: 'group', message_type: 'text', content: '{"text":"hello"}' } } };
  const normalized = feishuEvent(config, packet);
  assert.equal(normalized.topicId, 'topic'); assert.equal(normalized.sourceMessageId, 'message');
  assert.equal(normalized.eventId, 'event');
  for (const sender_type of ['bot', 'app']) assert.equal(feishuEvent(config, { ...packet,
    event: { ...packet.event, sender: { ...packet.event.sender, sender_type } } }), null);
});
