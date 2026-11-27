import { createHash } from 'node:crypto';
import { AppServerStdioClient } from './app-server-stdio.mjs';

export function reconcileOriginalDesktopAction(history, identity) {
  if (history?.thread?.id !== identity.threadId) throw new Error('Original desktop thread identity changed');
  const matches = (history.messages ?? []).flatMap(message => (message.blocks ?? [])
    .filter(block => block.type === 'tool' && block.tool_use_id === identity.toolCallId)
    .map(block => ({ message, block })));
  if (matches.length !== 1) throw new Error('Exactly one original desktop action receipt required');
  const { message, block } = matches[0];
  if (block.tool_name !== identity.tool || block.status !== 'done'
    || typeof block.tool_output !== 'string' || !block.tool_output.trim()
    || !Number.isSafeInteger(block.completed_at) || block.completed_at <= 0
    || message.turnId && message.turnId !== identity.turnId)
    throw new Error('Original desktop action has no authoritative successful receipt');
  return { threadId: history.thread.id, turnId: message.turnId ?? null, toolCallId: block.tool_use_id,
    tool: block.tool_name, status: block.status, completedAt: block.completed_at,
    outputBytes: Buffer.byteLength(block.tool_output),
    outputSha256: createHash('sha256').update(block.tool_output).digest('hex') };
}

// Withhold one actual completed native action event at the caller boundary.
// The product's native broker/MCP channel and persisted result remain unmodified.
export class DesktopActionReceiptLossClient extends AppServerStdioClient {
  constructor(label, child, options = {}) {
    super(label, child, options);
    this.lostAction = null;
  }

  onLine(line) {
    let frame;
    try { frame = JSON.parse(line); } catch { return super.onLine(line); }
    const item = frame.params?.item;
    if (!this.lostAction && frame.method === 'item/completed'
      && item?.type === 'toolCall' && item.name === 'mcp__kcoder_computer_use__Click'
      && item.status === 'completed') {
      if (!frame.params.threadId || !frame.params.turnId || !item.id) throw new Error('Native action identity required');
      this.lostAction = {
        threadId: frame.params.threadId, turnId: frame.params.turnId, toolCallId: item.id,
        tool: item.name, originalFrameBytes: Buffer.byteLength(line),
        originalFrameSha256: createHash('sha256').update(line).digest('hex'),
        callerReceivedActionResult: false, automaticReplayAllowed: false,
        faultBoundary: 'actual_app_server_completed_tool_event_before_caller_delivery',
        nativeBrokerReplyLost: false,
      };
      this.child.stdin.end();
      return;
    }
    super.onLine(line);
  }
}
