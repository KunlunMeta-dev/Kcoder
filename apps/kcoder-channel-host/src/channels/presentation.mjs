// These UTF-16 bounds must remain within the Studio inventory/preview contract.
const MAX_PREVIEW_TEXT = 1000;
const LABEL_LIMIT = 256;
const text = (value, limit) => {
  if (typeof value !== 'string') return '';
  let end = Math.min(value.length, limit);
  if (end > 0 && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff
      && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
  return value.slice(0, end);
};
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : null;

/** Project human-readable Inbox content only, never SDK envelopes, reply context or credentials. */
export function channelMessagePreview(event, limit = 160) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('CHANNEL_PREVIEW_LIMIT_INVALID');
  limit = Math.min(limit, MAX_PREVIEW_TEXT);
  if (!event) return null;
  return { text: text(event.text, limit), senderId: text(event.senderId, 512), senderName: text(event.senderName, 128),
    timestampMs: time(event.occurredAtMs) ?? time(event.receivedAtMs),
    attachments: (Array.isArray(event.attachments) ? event.attachments : []).slice(0, 8).map(attachment => ({
      kind: text(attachment?.kind, 32), filename: text(attachment?.filename, 256),
    })) };
}

export function publicChannelChat(store, chat) {
  if (!chat) throw new Error('CHANNEL_CHAT_NOT_FOUND');
  const { binding, bindingRevision } = Object.hasOwn(chat, 'binding') && Object.hasOwn(chat, 'bindingRevision')
    ? chat : store.bindingState(chat.id);
  return { id: chat.id, connectionId: chat.connectionId, range: chat.range, label: text(chat.label, LABEL_LIMIT),
    alias: chat.alias, aliasRevision: chat.aliasRevision, lastMessage: channelMessagePreview(chat.lastEvent),
    binding: binding ? { chatId: binding.chatId, revision: binding.revision, boundAtMs: binding.boundAtMs,
      target: { serverId: binding.target.serverId, workspacePath: binding.target.workspacePath, threadId: binding.target.threadId } } : null,
    bindingRevision,
    deliveries: binding ? store.deliverySummaries(chat.id, binding.revision) : [] };
}
