// One upstream process negotiates rich summaries; each downstream keeps its own
// capability contract. Legacy clients continue seeing the old running/idle view.
export function projectThreadRunSummary(message, negotiated) {
  if (negotiated || !message || typeof message !== 'object') return message;
  const project = thread => {
    if (!thread || typeof thread !== 'object' || !thread.runSummary) return thread;
    const { runSummary, ...legacy } = thread;
    legacy.status = runSummary.mainTurn === 'running' ? 'running'
      : runSummary.mainTurn === 'idle' ? 'idle'
      : ['idle', 'running', 'failed'].includes(thread.status) ? thread.status : 'idle';
    return legacy;
  };
  const envelope = value => {
    if (!value || typeof value !== 'object') return value;
    return { ...value, ...(value.thread ? { thread: project(value.thread) } : {}),
      ...(Array.isArray(value.threads) ? { threads: value.threads.map(project) } : {}) };
  };
  return { ...message, ...(message.result ? { result: envelope(message.result) } : {}),
    ...(message.params ? { params: envelope(message.params) } : {}) };
}
