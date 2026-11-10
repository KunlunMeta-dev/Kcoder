/** Official passive-reply limits are platform constraints, independent of KCoder task permissions. */
export function qqReplySequenceLimit({ chatKind, platformRoute }) {
  return chatKind === 'private' && !platformRoute ? 4 : 5;
}

export function qqReplyDeadline({ event, acceptedAtMs }) {
  return Math.min(event.occurredAtMs ?? acceptedAtMs, acceptedAtMs)
    + (event.chatKind === 'private' && !event.platformRoute ? 60 : 5) * 60_000;
}

/** Freeze passive/proactive mode before the Outbox commits, never at send/retry. */
export function prepareQqDestination(destination, { event, replySequence, now }) {
  const replyExpiresAt = qqReplyDeadline({ event, acceptedAtMs: event.receivedAtMs ?? event.occurredAtMs ?? 0 });
  return { ...destination, replyExpiresAt, replySequence,
    sendMode: destination.replyMessageId && replyExpiresAt > now
      && replySequence <= qqReplySequenceLimit(destination) ? 'reply' : 'proactive' };
}
