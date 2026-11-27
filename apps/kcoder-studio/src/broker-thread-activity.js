const TURN_EVENTS = new Map([
  ['turn/started', ['running']],
  ['turn/completed', ['completed', 'failed', 'interrupted']],
  ['turn/failed', ['failed']],
  ['turn/interrupted', ['interrupted']],
]);

/** Called after broker envelope/producer/replay fences; never invalidate on text deltas. */
export function isThreadActivityNotification(message, threadId, turnId) {
  if (!threadId || !turnId || !TURN_EVENTS.has(message.method)) return false;
  const { turn } = message.params ?? {};
  return turn?.status === undefined || TURN_EVENTS.get(message.method).includes(turn.status);
}

/** Successful read/resume responses must not invalidate the lists they just read. */
export function isThreadActivityResponse(method, result, threadId) {
  if (!threadId || !result || typeof result !== 'object') return false;
  if (method === 'thread/start' || method === 'thread/fork')
    return result.ephemeral !== true && result.thread?.id === threadId;
  if (method === 'thread/metadata/update') return result.thread?.id === threadId;
  return method === 'thread/delete' && result.deleted === true;
}
