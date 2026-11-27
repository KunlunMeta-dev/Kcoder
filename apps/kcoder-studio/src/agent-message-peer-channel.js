import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createWebSocketFrameCodec } from './websocket-frame-codec.js';
import { BoundedReceiveBuffer } from './bounded-receive-buffer.js';
import { WebSocketLivenessLease } from './websocket-liveness-lease.js';
import { requireCapturedNativeRemoteSourceClient } from './remotes/source-client-owner.mjs';
import { AgentMessageRouterError, requireRouter } from './agent-message-router-private.js';
import { agentMessageDiscoveryErrorData, agentMessageReceiptErrorData } from '../shared/agentMessageMethods.mjs';

const channels = new WeakSet();
const validId = id => typeof id === 'string' && id.length <= 256 || Number.isSafeInteger(id);
const MAX_PENDING = 32;
/** One already-authenticated device WebSocket, not a Native broker substitute. */
export function captureAuthenticatedPeerChannel({ socket, initialData = Buffer.alloc(0), nativeRemoteSourceOwner,
  onRequest, maxMessageBytes = 2 * 1024 * 1024 }) {
  const owner = requireCapturedNativeRemoteSourceClient(nativeRemoteSourceOwner);
  requireRouter(socket instanceof Socket && !socket.destroyed && typeof onRequest === 'function', 'AGENT_MESSAGES_DEVICE_AUTHORIZATION_REQUIRED');
  const { frame, decodeFrames } = createWebSocketFrameCodec({ maxMessageBytes });
  const pending = new Map(), fragments = [];
  const buffer = new BoundedReceiveBuffer(maxMessageBytes + 14);
  buffer.append(initialData);
  let leaseId = null, active = true, inFlight = 0;
  const verify = () => { owner.verify(); requireRouter(active && !socket.destroyed, 'AGENT_MESSAGES_DEVICE_CHANNEL_CLOSED'); };
  const write = value => { verify(); const encoded = JSON.stringify(value); requireRouter(Buffer.byteLength(encoded) <= maxMessageBytes, 'AGENT_MESSAGES_FRAME_LIMIT'); socket.write(frame(encoded)); };
  const stop = () => {
    if (!active) return;
    active = false; leaseId = null; liveness.stop();
    buffer.clear(); fragments.length = 0;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('AGENT_MESSAGES_DEVICE_CHANNEL_CLOSED')); }
    pending.clear(); socket.off('data', receive);
  };
  const close = () => { stop(); if (!socket.destroyed) socket.destroy(); };
  const liveness = new WebSocketLivenessLease({ sendPing: value => { verify(); socket.write(frame(value, 9)); }, onExpired: close });
  const dispatch = async value => {
    if (value && Object.hasOwn(value, 'id') && !Object.hasOwn(value, 'method')) {
      requireRouter(value.jsonrpc === '2.0' && validId(value.id) && Object.hasOwn(value, 'result') !== Object.hasOwn(value, 'error'), 'AGENT_MESSAGES_INVALID_RESPONSE');
      const entry = pending.get(value.id); if (!entry) return;
      pending.delete(value.id); clearTimeout(entry.timer);
      if (entry.method === 'agentPeer/sourcePresence' && value.result?.presence?.claims?.leaseId)
        leaseId = value.result.presence.claims.leaseId;
      entry.resolve(value); return;
    }
    if (value?.method === 'agentPeer/sourceRevoked' && value.id === undefined) {
      if (value.params?.leaseId === leaseId) leaseId = null;
      return;
    }
    requireRouter(value?.jsonrpc === '2.0' && validId(value.id) && typeof value.method === 'string', 'AGENT_MESSAGES_INVALID_REQUEST');
    requireRouter(inFlight < 8, 'AGENT_MESSAGES_REQUEST_CAPACITY');
    inFlight += 1;
    try {
      verify();
      const result = await onRequest(value);
      verify(); write({ jsonrpc: '2.0', id: value.id, result });
    } catch (cause) {
      if (!active || socket.destroyed) return;
      const data = value.method === 'agentPeer/targets' && cause instanceof AgentMessageRouterError
        ? agentMessageDiscoveryErrorData({ message: cause.message }) : value.method === 'agentPeer/listReceipts' && cause instanceof AgentMessageRouterError
          ? agentMessageReceiptErrorData(cause) : undefined;
      const replyUnsupported = value.method === 'agentPeer/send' && cause instanceof AgentMessageRouterError &&
        cause.code === -32601 && cause.message === 'AGENT_MESSAGES_REPLIES_UNSUPPORTED';
      const error = replyUnsupported ? { code: -32601, message: 'AGENT_MESSAGES_REPLIES_UNSUPPORTED' } : data
        ? { code: [-32601, -32602, -32034].includes(cause.code) ? cause.code : -32034,
          message: { cursor_invalid: 'AGENT_MESSAGES_CURSOR_INVALID', cursor_filter_mismatch: 'AGENT_MESSAGES_CURSOR_FILTER_MISMATCH',
            search_unsupported: 'AGENT_MESSAGES_DISCOVERY_SEARCH_UNSUPPORTED', receipts_unsupported: 'AGENT_MESSAGES_RECEIPTS_UNSUPPORTED' }[data.reason], data }
        : { code: -32034, message: 'AGENT_MESSAGES_DEVICE_REQUEST_UNCONFIRMED' };
      write({ jsonrpc: '2.0', id: value.id, error });
    }
    finally { inFlight -= 1; }
  };
  function receive(chunk) {
    try {
      verify(); buffer.append(chunk);
      const decoded = decodeFrames(buffer.bytes, fragments); buffer.retain(decoded.rest);
      for (const control of decoded.controls) {
        if (control.opcode === 8) { close(); return; }
        if (control.opcode === 9) socket.write(frame(control.payload, 10));
        if (control.opcode === 10) liveness.pong(control.payload);
      }
      for (const text of decoded.messages) { const value = JSON.parse(text); void dispatch(value).catch(close); }
    } catch { close(); }
  }
  const channel = Object.freeze({
    socket, verify, currentLease: () => { verify(); return leaseId; }, close,
    hasManagementOwner: value => value === owner,
    request(method, params, timeoutMs = 10_000) {
      verify(); requireRouter(pending.size < MAX_PENDING && typeof method === 'string', 'AGENT_MESSAGES_REQUEST_CAPACITY');
      requireRouter(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'AGENT_MESSAGES_INVALID_DEADLINE');
      const id = 'peer-native-' + randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('AGENT_MESSAGES_NATIVE_RESULT_UNCONFIRMED')); }, timeoutMs); timer.unref?.();
        pending.set(id, { resolve, reject, timer, method });
        try { write({ jsonrpc: '2.0', id, method, params }); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
  });
  channels.add(channel);
  socket.on('data', receive); socket.once('close', stop); socket.once('end', stop); socket.once('error', stop);
  liveness.start();
  if (buffer.length) queueMicrotask(() => receive(Buffer.alloc(0)));
  return channel;
}
export function requireAuthenticatedPeerChannel(value) {
  requireRouter(channels.has(value), 'AGENT_MESSAGES_AUTHENTICATED_SOURCE_REQUIRED');
  value.verify(); return value;
}
