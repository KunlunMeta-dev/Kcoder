const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : null;

/** Project human-readable Inbox content only, never SDK envelopes, reply context or credentials. */
export function channelMessagePreview(event, limit = 160) {
  if (!event) return null;
  return { text: text(event.text, limit), senderId: text(event.senderId, 512), senderName: text(event.senderName, 128),
    timestampMs: time(event.occurredAtMs) ?? time(event.receivedAtMs),
    attachments: (Array.isArray(event.attachments) ? event.attachments : []).slice(0, 8).map(attachment => ({
      kind: text(attachment?.kind, 32), filename: text(attachment?.filename, 256),
    })) };
}

export function publicChannelChat(store, chat) {
  const binding = store.binding(chat.id);
  return { id: chat.id, connectionId: chat.connectionId, range: chat.range, label: chat.label,
    alias: chat.alias, aliasRevision: chat.aliasRevision, lastMessage: channelMessagePreview(chat.lastEvent),
    binding: binding ? { chatId: binding.chatId, revision: binding.revision, boundAtMs: binding.boundAtMs,
      target: { serverId: binding.target.serverId, workspacePath: binding.target.workspacePath, threadId: binding.target.threadId } } : null,
    bindingRevision: store.bindingRevision(chat.id),
    deliveries: binding ? store.deliverySummaries(chat.id, binding.revision) : [] };
}
