import { HeaderWebSocket } from "./header-websocket.mjs";

export async function openRpc(url, options = {}) {
  const socket = new HeaderWebSocket(url, options.headers || {});
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket open timed out after ${options.timeoutMs || 10_000}ms`));
    }, options.timeoutMs || 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection failed: ${redactUrl(url)}`));
    }, { once: true });
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

function redactUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.has("token")) parsed.searchParams.set("token", "[REDACTED]");
    return parsed.toString();
  } catch {
    return "[invalid websocket url]";
  }
}
