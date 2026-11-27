import assert from 'node:assert/strict';
import { waitFor } from './run-context.mjs';

/** Observe the actual UI socket, including replies sent by the normal ASK card. */
export function observeNativeUiFrames(page, { now = () => Math.round(performance.now()) } = {}) {
  const frames = [];
  page.on('websocket', socket => {
    for (const [event, direction] of [['framesent', 'sent'], ['framereceived', 'received']]) {
      socket.on(event, ({ payload }) => {
        let frame;
        try { frame = JSON.parse(String(payload)); } catch { return; }
        frames.push({ atMs: now(), direction, frame });
      });
    }
  });
  return frames;
}

function sameBinding(value, request) {
  return value?.approvalId === request.params.approvalId
    && value?.threadId === request.params.threadId
    && value?.turnId === request.params.turnId;
}

export function pendingNativeToolApproval(frames, toolName, command) {
  return frames.find(({ direction, frame }) => direction === 'received'
    && frame.method === 'approval/request'
    && (command !== undefined
      ? frame.params?.action?.type === 'command' && frame.params.action.command === command
      : frame.params?.action?.type === 'tool' && frame.params.action.name === toolName)
    && !frames.some(row => row.direction === 'received'
      && row.frame.method === 'approval/resolved'
      && row.frame.params?.requestId === frame.id
      && sameBinding(row.frame.params, frame)))?.frame;
}

export function nativeApprovalAccepted(frames, request) {
  const sent = frames.some(row => row.direction === 'sent'
    && row.frame.id === request.id && row.frame.result?.decision === 'accept'
    && sameBinding(row.frame.result, request));
  const resolved = frames.some(row => row.direction === 'received'
    && row.frame.method === 'approval/resolved'
    && row.frame.params?.requestId === request.id
    && row.frame.params?.decision === 'accept'
    && sameBinding(row.frame.params, request));
  return sent && resolved;
}

/** A vanished card alone does not prove that the native broker accepted a reply. */
export async function acceptNativeToolApproval(page, frames, toolName, {
  signal, timeoutMs = 140000, command,
} = {}) {
  const request = await waitFor(() => pendingNativeToolApproval(frames, toolName, command),
    timeoutMs, `native ${toolName} approval request`, 40, signal);
  assert.ok(Number.isInteger(request.id));
  for (const field of ['approvalId', 'threadId', 'turnId']) assert.ok(request.params[field]);
  const card = page.getByTestId('request-user-input-card');
  await card.waitFor({ state: 'visible', timeout: 10000 });
  assert.ok((await card.getByTestId('permission-approval-content').innerText()).includes(command ?? toolName));
  await card.getByTestId(`request-user-input-option-${request.params.approvalId}-0`).click();
  await waitFor(() => nativeApprovalAccepted(frames, request), 10000,
    `native ${toolName} accept response and broker acknowledgement`, 40, signal);
  return request;
}
