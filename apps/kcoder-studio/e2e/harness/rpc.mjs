import { HeaderWebSocket } from "./header-websocket.mjs";

/** Reuse the authenticated page's owned Gateway session without retaining its secrets. */
export async function openPageGatewayRpc(context, page, gateway, label, { open = openRpc } = {}) {
  const token = await page.locator('meta[name="kcoder-rpc-token"]').getAttribute('content');
  if (!token) throw new Error('Authenticated page RPC token is unavailable');
  context.registerSecret(token);
  let cookies = await page.context().cookies(gateway.baseUrl);
  if (!cookies.length && typeof page.context().newCDPSession === 'function') {
    const channel = await page.context().newCDPSession(page);
    try { cookies = (await channel.send('Network.getCookies', { urls: [gateway.baseUrl] })).cookies; }
    finally { await channel.detach(); }
  }
  const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
  if (!cookie) throw new Error('Owned authenticated page session cookie is unavailable');
  context.registerSecret(cookie);
  const rpc = await open(gatewayRpcUrl(gateway, 'local', token), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  context.addCleanup(label, () => closeRpcAndWait(rpc, label));
  return rpc;
}

export async function openRpc(url, options = {}) {
  const socket = new HeaderWebSocket(url, options.headers || {});
  await new Promise((resolveOpen, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket open timed out after ${options.timeoutMs || 10_000}ms`));
    }, options.timeoutMs || 10_000);
    const closedBeforeOpen = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket closed before the upgrade completed"));
    };
    socket.addEventListener("close", closedBeforeOpen, { once: true });
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      socket.removeEventListener("close", closedBeforeOpen);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      socket.removeEventListener("close", closedBeforeOpen);
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
  let disconnected = false;
  const disconnectedError = () => new Error('RPC connection closed; upstream outcome is unknown. Read the original receipt before retrying.');
  const settleDisconnected = () => {
    if (disconnected) return;
    disconnected = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(disconnectedError());
    }
    pending.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(disconnectedError());
    }
    waiters.clear();
  };
  socket.addEventListener('close', settleDisconnected);
  socket.addEventListener('error', settleDisconnected);
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
      if (disconnected) return Promise.reject(disconnectedError());
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
      if (disconnected) return Promise.reject(disconnectedError());
      return new Promise((resolveWait, reject) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          reject,
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

export async function initializeRpc(rpc, name, experimental) {
  return rpc.request("initialize", {
    protocolVersion: "2026-07-27",
    clientInfo: { name, version: "1" },
    ...(experimental ? { capabilities: { experimental } } : {}),
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

/** Turn IDs are local to a thread, never a connection-wide completion identity. */
export function isTurnCompletion(message, threadId, turnId) {
  return typeof threadId === 'string' && threadId.length > 0 && typeof turnId === 'string' && turnId.length > 0
    && message?.method === 'turn/completed' && message.params?.threadId === threadId && message.params?.turnId === turnId;
}
