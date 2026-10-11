export class RpcError extends Error {
  constructor(message, code = -1, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export function defaultRpcUrl(
  locationLike = globalThis.location,
  documentLike = globalThis.document,
) {
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  const token = documentLike?.querySelector?.(
    'meta[name="kcoder-rpc-token"]',
  )?.content;
  return `${protocol}//${locationLike.host}/rpc${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export function rpcUrlForServer(baseUrl, serverId) {
  const url = new URL(baseUrl);
  url.searchParams.set("server", serverId);
  return url.toString();
}

export class RpcClient extends EventTarget {
  #socket = null;
  #pending = new Map();
  #nextId = 1;

  constructor(url = defaultRpcUrl(), WebSocketImpl = globalThis.WebSocket) {
    super();
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
  }

  get connected() {
    return this.#socket?.readyState === 1;
  }

  connect() {
    if (this.#socket && this.#socket.readyState < 2) return;
    // An old connection may close after a new one opens; finish requests owned by the old connection before replacement.
    this.#rejectPending();
    this.dispatchEvent(new Event("connecting"));
    const socket = new this.WebSocketImpl(this.url);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket === socket) this.dispatchEvent(new Event("open"));
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket === socket) this.#receive(event.data);
    });
    socket.addEventListener("error", () => {
      if (this.#socket === socket) this.dispatchEvent(new Event("error"));
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#rejectPending();
      this.dispatchEvent(new Event("close"));
    });
  }

  close() {
    this.#socket?.close();
  }

  #rejectPending() {
    for (const { reject } of this.#pending.values())
      reject(new RpcError("连接已断开"));
    this.#pending.clear();
  }

  request(method, params = {}) {
    if (!this.connected) return Promise.reject(new RpcError("服务器尚未连接"));
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) =>
      this.#pending.set(String(id), { resolve, reject }),
    );
  }

  notify(method, params = {}) {
    if (!this.connected) throw new RpcError("服务器尚未连接");
    this.#socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  #receive(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      this.dispatchEvent(
        new CustomEvent("protocolerror", {
          detail: new RpcError("收到无效 JSON"),
        }),
      );
      return;
    }
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message)
    ) {
      this.dispatchEvent(
        new CustomEvent("protocolerror", {
          detail: new RpcError("收到无效 JSON-RPC 消息"),
        }),
      );
      return;
    }
    if (
      message.id !== undefined &&
      (message.result !== undefined || message.error)
    ) {
      const pending = this.#pending.get(String(message.id));
      if (!pending) return;
      this.#pending.delete(String(message.id));
      if (message.error)
        pending.reject(
          new RpcError(
            message.error.message,
            message.error.code,
            message.error.data,
          ),
        );
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      this.dispatchEvent(new CustomEvent("notification", { detail: message }));
    }
  }
}
