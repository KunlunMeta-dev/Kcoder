import { HeaderWebSocket } from "./header-websocket-ws-diagnostic.mjs";

export async function openRpc(url, options = {}) {
  const socket = new HeaderWebSocket(url, options.headers || {}, { onDiagnostic: options.onDiagnostic });
  await new Promise((resolveOpen, reject) => {
    const timeoutMs = options.timeoutMs || 10_000;
    let settled = false;
    let timer;
    const removeWaitListeners = () => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const settle = (callback, value) => {
      if (settled) return false;
      settled = true;
      removeWaitListeners();
      callback(value);
      return true;
    };
    const onOpen = () => settle(resolveOpen);
    const onError = () => {
      if (settle(reject, new Error("WebSocket transport failed before open"))) socket.close();
    };
    const onClose = () => {
      if (!socket.handshakeComplete && settle(reject, new Error("WebSocket transport closed before open"))) socket.close();
    };
    timer = setTimeout(() => {
      socket.recordDiagnostic("open_timeout");
      if (settle(reject, new Error(`WebSocket open timed out after ${timeoutMs}ms`))) socket.close();
    }, timeoutMs);
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
  return rpcClient(socket);
}

export function rpcClient(socket) {
  let nextId = 1;
  const pending = new Map();
  const messages = [];
  const waiters = new Set();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    messages.push(message);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    socket,
    request(method, params = {}, timeoutMs = 30_000) {
      const id = nextId++;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    respond(id, result) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    },
    respondError(id, code, message) {
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
    },
    waitFor(predicate, timeoutMs, label) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveWait, reject) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${label}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    messages() {
      return [...messages];
    },
    close() {
      socket.close();
    },
  };
}

/** Close a Node RPC client and wait for the WebSocket close handshake to finish. */
export async function closeRpcAndWait(rpc, label = "RPC socket", timeoutMs = 5_000) {
  if (!rpc?.socket) return;
  const closed = rpc.socket.constructor.CLOSED ?? 3;
  if (rpc.socket.readyState === closed) return;
  await new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      rpc.socket.removeEventListener?.("close", onClose);
      rejectClose(new Error(`${label} did not close within ${timeoutMs}ms`));
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolveClose();
    };
    rpc.socket.addEventListener("close", onClose, { once: true });
    rpc.close();
    if (rpc.socket.readyState === closed) onClose();
  });
}

export async function initializeRpc(rpc, name) {
  return rpc.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name, version: "1" },
  });
}

export function gatewayRpcUrl(gateway, serverId, token, channel = "runtime") {
  const query = new URLSearchParams({ token, server: serverId });
  if (channel !== "runtime") query.set("channel", channel);
  return `${gateway.wsUrl}/rpc?${query}`;
}

/** Turn IDs are local to a thread, never a connection-wide completion identity. */
export function isTurnCompletion(message, threadId, turnId) {
  return typeof threadId === 'string' && threadId.length > 0 && typeof turnId === 'string' && turnId.length > 0
    && message?.method === 'turn/completed' && message.params?.threadId === threadId && message.params?.turnId === turnId;
}
