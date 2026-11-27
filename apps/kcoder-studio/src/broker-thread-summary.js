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
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return { ...value, ...(value.thread ? { thread: project(value.thread) } : {}),
      ...(Array.isArray(value.threads) ? { threads: value.threads.map(project) } : {}) };
  };
  return { ...message, ...(message.result ? { result: envelope(message.result) } : {}),
    ...(message.params ? { params: envelope(message.params) } : {}) };
}


// Snapshot negotiation applies only to these response locations, not events or
// unrelated metadata. Keep the shared backend object immutable for peer clients.
export function projectThreadTranscriptSnapshot(message, method, negotiated) {
  if (negotiated || !message?.result || typeof message.result !== 'object') return message;
  const strip = value => {
    if (!value || !Object.hasOwn(value, 'transcriptSnapshotV1')) return value;
    const { transcriptSnapshotV1, ...legacy } = value;
    return legacy;
  };
  if (method === 'thread/read' || method === 'thread/read/indexed') {
    const result = strip(message.result);
    return result === message.result ? message : { ...message, result };
  }
  if (method === 'thread/resume' && message.result.history?.status === 'ready') {
    const page = strip(message.result.history.page);
    if (page !== message.result.history.page) return { ...message, result: {
      ...message.result, history: { ...message.result.history, page },
    } };
  }
  return message;
}

// The shared backend may return observed cursors even for a legacy downstream.
// Its numeric reader accepts the exact range boundary; committed tp1 cursors
// stay in their original domain. Never infer a boundary from malformed input.
export function projectThreadTranscriptObservation(message, method, negotiated) {
  if (negotiated || !message?.result || typeof message.result !== 'object') return message;
  let invalid = false;
  const project = value => {
    if (!value || typeof value !== 'object') return value;
    const observed = typeof value.beforeCursor === 'string' && value.beforeCursor.startsWith('tp1:ob1-');
    if (!observed && !Object.hasOwn(value, 'transcriptObservationV1')) return value;
    const { transcriptObservationV1, ...legacy } = value;
    if (observed) {
      const cursor = /^tp1:ob1-[a-f0-9]{64}:([1-9][0-9]*)$/.exec(value.beforeCursor);
      if (!cursor || !Number.isSafeInteger(value.rangeStart) || value.rangeStart <= 0 ||
          value.hasMoreBefore !== true || cursor[1] !== String(value.rangeStart)) invalid = true;
      else legacy.beforeCursor = String(value.rangeStart);
    }
    return legacy;
  };
  let result = message.result;
  if (method === 'thread/read' || method === 'thread/read/indexed') result = project(result);
  else if (method === 'thread/resume' && result.history?.status === 'ready') {
    const page = project(result.history.page);
    if (page !== result.history.page) result = { ...result, history: { ...result.history, page } };
  }
  if (invalid) {
    const { result: _result, ...envelope } = message;
    return { ...envelope, error: { code: -32603, message: 'Invalid observed transcript cursor boundary' } };
  }
  return result === message.result ? message : { ...message, result };
}
