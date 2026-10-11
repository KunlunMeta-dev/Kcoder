/**
 * Test-side protocol fixtures for mounted P1-C readiness checks.
 * These frames are injected at the Playwright WebSocket route, not emitted by
 * the Rust app-server or by a real Engine turn.
 */
export function createP1CBufferedNotificationFrames({
  serverId,
  threadId,
  turnId = "p1c-buffered-turn",
  attemptId = "p1c-buffered-attempt",
  itemId = "p1c-buffered-assistant-item",
  text = "P1C_BUFFERED_VISIBLE_ASSISTANT_TEXT",
}) {
  for (const [label, value] of Object.entries({ serverId, threadId, turnId, attemptId, itemId, text })) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  }
  const context = sequence => ({ serverId, threadId, turnId, sequence });
  return [
    {
      method: "turn/started",
      params: {
        ...context(1),
        attemptId,
        turn: { id: turnId, attemptId, threadId, status: "running" },
      },
    },
    {
      method: "item/started",
      params: { ...context(2), item: { id: itemId, type: "agentMessage" } },
    },
    {
      method: "item/delta",
      params: { ...context(3), itemId, delta: { text } },
    },
    {
      method: "item/completed",
      params: { ...context(4), item: { id: itemId, type: "agentMessage" } },
    },
    {
      method: "turn/completed",
      params: {
        ...context(5),
        turn: { id: turnId, attemptId, threadId, status: "completed" },
      },
    },
  ];
}

export function createP1CStartedTurnFrame({
  serverId,
  threadId,
  turnId = "p1c-reconnect-known-turn",
  attemptId = "p1c-reconnect-known-attempt",
}) {
  for (const [label, value] of Object.entries({ serverId, threadId, turnId, attemptId })) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  }
  return {
    method: "turn/started",
    params: {
      serverId,
      threadId,
      turnId,
      sequence: 1,
      attemptId,
      turn: { id: turnId, attemptId, threadId, status: "running" },
    },
  };
}

export function createP1CActiveRunSummary() {
  return {
    mainTurn: "running",
    pendingApprovals: 0,
    pendingQuestions: 0,
    activeJobs: 0,
    tasksPending: 0,
    tasksRunning: 0,
    pendingFollowups: 0,
    pendingGoals: 0,
  };
}

export function createP1CTurnStartErrorFixtureFrame(requestFrame, {
  code = -32091,
  message = "P1C isolated fixture rejected this turn/start",
} = {}) {
  if (!requestFrame || requestFrame.method !== "turn/start" || requestFrame.id === undefined || requestFrame.id === null) {
    throw new TypeError("requestFrame must be an identified turn/start JSON-RPC request");
  }
  if (!requestFrame.params || typeof requestFrame.params.threadId !== "string" || !requestFrame.params.threadId.trim()) {
    throw new TypeError("turn/start request must include a non-empty threadId");
  }
  if (typeof requestFrame.params.clientMessageId !== "string" || !requestFrame.params.clientMessageId.trim()) {
    throw new TypeError("turn/start request must include a non-empty clientMessageId");
  }
  if (!Number.isInteger(code) || typeof message !== "string" || !message.trim()) {
    throw new TypeError("fixture error code and message are invalid");
  }
  return {
    jsonrpc: requestFrame.jsonrpc === "2.0" ? requestFrame.jsonrpc : "2.0",
    id: requestFrame.id,
    error: { code, message },
  };
}
