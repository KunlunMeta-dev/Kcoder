import assert from 'node:assert/strict';
import { waitFor } from './run-context.mjs';
import { peerNotificationFacts, peerCapabilityFacts } from './peer-notification-facts.mjs';
import { validAgentMessageAddress } from '../../shared/agentMessageMethods.mjs';

/** Observe only closed public protocol facts, matching reply IDs per socket. */
export function observePeerStudioPage(page) {
  const wire = []; let sequence = 0;
  page.on('websocket', socket => {
    const pending = new Map(), connection = ++sequence;
    socket.on('framesent', event => {
      try {
        const frame = JSON.parse(String(event.payload)); if (!frame.method) return;
        const params = frame.params ?? {};
        const row = { connection, method: frame.method, threadId: params.threadId ?? params.sourceThreadId,
          sentAtMs: Date.now(),
          ...(frame.method === 'initialize' ? { requestedPeer: params.capabilities?.experimental?.peerAgentMessagesV1 === true } : {}),
          ...(params.address ? { address: params.address } : {}),
          ...(validAgentMessageAddress(params.expectedSessionAddress)
            ? { expectedSessionAddress: { targetId: params.expectedSessionAddress.targetId,
              workspaceId: params.expectedSessionAddress.workspaceId, threadId: params.expectedSessionAddress.threadId } } : {}),
          ...(params.query ? { queryClientMessageId: params.query.clientMessageId } : {}),
          ...(params.message ? { clientMessageId: params.message.clientMessageId, targetAddress: params.message.targetAddress } : {}) };
        wire.push(row); pending.set(frame.id, row);
      } catch { /* Unrelated transport frame. */ }
    });
    socket.on('framereceived', event => {
      try {
        const frame = JSON.parse(String(event.payload));
        const notice = peerNotificationFacts(frame), caps = peerCapabilityFacts(frame);
        if (!Object.hasOwn(frame, 'id') && ['turn/started', 'turn/completed'].includes(frame.method)) {
          const params = frame.params ?? {}, turn = params.turn ?? {};
          wire.push({ connection, lane: 'browser-turn-state', method: frame.method,
            threadId: params.threadId ?? turn.threadId, turnId: params.turnId ?? turn.id,
            status: turn.status ?? params.status, observedAtMs: Date.now() });
        }
        if (notice) wire.push({ connection, lane: 'browser-ws-received', ...notice });
        if (caps) wire.push({ connection, lane: 'browser-initialize', ...caps });
        const request = pending.get(frame.id); if (!request) return;
        request.replyObserved = true; request.replyAtMs = Date.now();
        if (request.method === 'runtime.models.list' && Array.isArray(frame.result?.data)) {
          request.modelCatalog = frame.result.data.slice(0, 32).map(model => ({
            id: typeof model.id === 'string' ? model.id.slice(0, 256) : null,
            model: typeof model.model === 'string' ? model.model.slice(0, 256) : null,
            providerId: typeof model.providerId === 'string' ? model.providerId.slice(0, 256) : null,
            isDefault: model.isDefault === true, available: model.available === true,
            configurationObserved: model.configuration != null,
          }));
        }
        if (request.method === 'turn/start' && frame.result?.turn?.id) {
          request.acceptedTurnId = frame.result.turn.id; request.acceptedAtMs = Date.now();
        }
        if (frame.error) request.errorCode = frame.error.code;
        const receipt = frame.result?.receipt ?? frame.result;
        if (receipt?.messageId && receipt.clientMessageId) request.receipt = {
          messageId: receipt.messageId, clientMessageId: receipt.clientMessageId, status: receipt.status,
          sourceAddress: receipt.sourceAddress, targetAddress: receipt.targetAddress };
      } catch { /* Unrelated transport frame. */ }
    });
  });
  return wire;
}

export async function seedPeerStudioPage(page, wire, { marker, ready, serverId, timeoutMs = 30_000 }) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(() => ['runtime.models.list', 'runtime.providers.list'].every(method =>
    wire.some(row => row.method === method && row.replyObserved && !row.errorCode)), 30_000, 'actual Native model/provider readiness');
  const model = page.getByTestId('model-selector-button'); await model.click();
  await page.getByTestId('model-reset-default-button').click(); await model.click();
  await page.getByTestId('chat-message-input').fill(marker);
  await page.getByTestId('send-message-button').click();
  await page.getByTestId('message-assistant').filter({ hasText: ready }).waitFor({ timeout: timeoutMs });
  const url = page.url(), taskId = new URL(url).searchParams.get('taskId');
  assert.ok(taskId?.startsWith(`kcoder:${serverId}:`));
  return { url, threadId: taskId.slice(`kcoder:${serverId}:`.length) };
}

export async function sendPeerStudioUi(page, wire, { targetTitle, text, expectedAddress, wake = false }) {
  let discoveryBegan = wire.length;
  await page.getByTestId('session-messages-open').click();
  const dialog = page.getByTestId('session-messages-dialog'); await dialog.waitFor();
  const target = dialog.getByTestId('session-message-target').filter({ hasText: targetTitle });
  const more = dialog.getByRole('button', { name: /^(Next page|下一页)$/ });
  for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
    await waitFor(() => wire.slice(discoveryBegan).some(row => row.method === 'thread/agentMessage/targets' &&
      row.replyObserved && !row.errorCode), 30_000, 'actual UI peer discovery page');
    const next = await waitFor(async () => {
      if (await target.isVisible()) return 'target';
      if (await more.isVisible() && await more.isEnabled()) return 'more';
      return null;
    }, 30_000, 'actual UI peer target or next page');
    if (next === 'target') break;
    assert.ok(pageNumber < 31, 'Actual UI peer discovery exceeded the bounded page budget');
    discoveryBegan = wire.length;
    await more.click();
  }
  await target.click();
  if (wake) await dialog.getByTestId('session-message-wake').check();
  await dialog.getByTestId('session-message-input').fill(text);
  const began = wire.length;
  await dialog.getByTestId('session-message-send').click();
  const send = await waitFor(() => wire.slice(began).find(row => row.method === 'thread/agentMessage/send' && row.receipt),
    30_000, 'actual UI original peer send receipt');
  if (expectedAddress) assert.deepEqual(send.targetAddress, expectedAddress);
  // Receipts are displayed newest first; reconcile the message just sent.
  const lookup = dialog.getByRole('button', { name: /Check receipt|核对回执/ }).first();
  const settled = await waitFor(async () => {
    const row = wire.slice(began).find(row => row.method === 'thread/agentMessage/get' && row.receipt?.status === 'applied' &&
      row.queryClientMessageId === send.clientMessageId && row.receipt.messageId === send.receipt.messageId);
    if (row) return row;
    if (await lookup.isEnabled()) await lookup.click();
    return null;
  }, 30_000, 'original UI peer receipt Applied', 500);
  assert.equal(settled.receipt.clientMessageId, send.clientMessageId);
  await dialog.getByRole('button', { name: /^(Close|关闭)$/ }).click();
  return { send, settled };
}

export async function assertPeerStudioSourceNavigation(page, wire, bubble, { sourceAddress, sourceMarker, serverId }) {
  const began = wire.length;
  await bubble.getByRole('button').click();
  await page.waitForURL(url => url.searchParams.get('taskId') === `kcoder:${serverId}:${sourceAddress.threadId}`, { timeout: 30_000 });
  assert.deepEqual(JSON.parse(new URL(page.url()).searchParams.get('expectedSessionAddress')), sourceAddress,
    'The ordinary source URL must retain the original full canonical address');
  await page.getByTestId('message-user').filter({ hasText: sourceMarker }).waitFor({ timeout: 30_000 });
  const navigation = wire.slice(began);
  assert.ok(navigation.some(row => row.method === 'thread/agentMessage/resolve' &&
    row.address?.targetId === sourceAddress.targetId && row.address.workspaceId === sourceAddress.workspaceId &&
    row.address.threadId === sourceAddress.threadId), 'The actual full address must be resolved');
  assert.equal(navigation.some(row => ['thread/start', 'turn/start'].includes(row.method)), false);
  assert.ok(navigation.some(row => ['thread/read', 'thread/read/indexed'].includes(row.method) && row.replyObserved &&
    !row.errorCode && row.expectedSessionAddress?.targetId === sourceAddress.targetId &&
    row.expectedSessionAddress.workspaceId === sourceAddress.workspaceId &&
    row.expectedSessionAddress.threadId === sourceAddress.threadId),
  'The actual source history read must carry the original canonical constraint');
}
