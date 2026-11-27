import { createMcpOAuthCallbackReceiver } from "./mcp-oauth-callback.js";

// The authenticated WebSocket chooses the origin; unauthenticated redirects can only redeem
// an already bound, unguessable path and state. Callback requests never choose a target.
export class McpOAuthCallbackRegistry {
  constructor() {
    this.receivers = new Map();
    this.states = new Map();
    this.creating = 0;
    this.closed = false;
  }

  async create(origin, { stablePath = false, waitForCompletion = false } = {}) {
    if (this.closed) throw new Error("Gateway OAuth callback registry is closed");
    if (typeof origin !== "string") throw new Error("Gateway callback origin is required");
    if (this.receivers.size + this.creating >= 256) throw new Error("Gateway OAuth callback capacity reached");
    this.creating += 1;
    let receiver;
    try { receiver = await createMcpOAuthCallbackReceiver({ callbackOrigin: origin, stablePath, waitForCompletion }); }
    finally { this.creating -= 1; }
    if (this.closed) {
      receiver.close();
      throw new Error("Gateway OAuth callback registry is closed");
    }
    const path = new URL(receiver.redirectUri).pathname;
    const key = stablePath ? Symbol("stable-callback") : path;
    let state;
    if (stablePath) {
      const bind = receiver.bindAuthorizationUrl;
      receiver.bindAuthorizationUrl = value => {
        const candidate = new URL(value).searchParams.get("state");
        if (this.states.has(candidate)) throw new Error("OAuth callback state is already registered");
        bind(value);
        state = candidate;
        this.states.set(state, receiver);
      };
    }
    this.receivers.set(key, receiver);
    void receiver.completion.then(() => {
      this.receivers.delete(key);
      if (this.states.get(state) === receiver) this.states.delete(state);
    });
    return receiver;
  }

  handle(request, response) {
    let path;
    try { path = new URL(request.url, "http://localhost").pathname; }
    catch { return false; }
    if (path !== "/oauth/mcp/callback" && !path.startsWith("/oauth/mcp/callback/")) return false;
    let receiver;
    if (path === "/oauth/mcp/callback") {
      const states = new URL(request.url, "http://localhost").searchParams.getAll("state");
      if (states.length === 1 && states[0].length <= 1024) receiver = this.states.get(states[0]);
    } else {
      receiver = this.receivers.get(path);
    }
    if (receiver) receiver.handle(request, response);
    else {
      response.writeHead(410, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      response.end("Authorization callback is no longer active.");
    }
    return true;
  }

  close() {
    this.closed = true;
    for (const receiver of this.receivers.values()) receiver.close();
    this.receivers.clear();
    this.states.clear();
  }
}
