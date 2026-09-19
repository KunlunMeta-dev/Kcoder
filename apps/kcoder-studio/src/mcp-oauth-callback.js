import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

// One receiver belongs to one Gateway client and accepts exactly one bound callback.
export async function createMcpOAuthCallbackReceiver({ lifetimeMs = 600_000, callbackOrigin, stablePath = false, waitForCompletion = false } = {}) {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 600_000) {
    throw new Error("Invalid MCP callback lifetime");
  }
  if (callbackOrigin !== undefined) {
    const origin = new URL(callbackOrigin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (!(origin.protocol === "https:" || (origin.protocol === "http:" && loopback)) ||
        origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("Browser OAuth requires a public HTTPS Gateway origin or localhost");
    }
    callbackOrigin = origin.origin;
  }
  const path = stablePath ? "/oauth/mcp/callback" : `/oauth/mcp/callback/${randomBytes(24).toString("hex")}`;
  let expectedState = null;
  let settled = false;
  let redirectUri;
  let timer;
  let server;
  let resolveResult;
  let pendingReply;
  let completionTimer;
  let resolveCompletion;
  let callbackError;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const completeAuthorization = ({ status, reason, errorCode, httpStatus, diagnostic } = {}) => {
    if (!pendingReply) return;
    clearTimeout(completionTimer);
    const reply = pendingReply;
    pendingReply = null;
    if (status === 'authorized') reply(200, '授权已保存，请返回 KCoder Studio 使用该服务。');
    else {
      const known = ['token_exchange_failed', 'token_response_invalid', 'token_type_unsupported', 'token_syntax_invalid', 'callback_issuer_mismatch',
        'authorization_denied', 'flow_unavailable', 'configuration_changed', 'authorization_timeout', 'authorization_cancelled'];
      const code = known.includes(reason) ? reason : 'authorization_failed';
      const oauthErrors = ['access_denied', 'invalid_scope', 'invalid_request', 'invalid_client',
        'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'server_error', 'temporarily_unavailable'];
      const providerCode = oauthErrors.includes(errorCode) ? errorCode
        : oauthErrors.includes(callbackError) ? callbackError : null;
      const details = [code, providerCode,
        Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? `HTTP ${httpStatus}` : null].filter(Boolean);
      if (typeof diagnostic === 'string' && diagnostic.length <= 220 &&
          /^(?:json=invalid|(?:access_token|token_type|refresh_token|expires_in|scope)=(?:missing|null|string|integer|number|boolean|array|object)(?:,(?:access_token|token_type|refresh_token|expires_in|scope)=(?:missing|null|string|integer|number|boolean|array|object))*)$/.test(diagnostic)) details.push(diagnostic);
      reply(502, `授权未保存（${details.join('; ')}）。请返回 KCoder Studio 查看连接结果。`);
    }
    resolveCompletion();
  };
  const result = new Promise(resolve => { resolveResult = resolve; });
  const finish = outcome => {
    if (settled) return;
    settled = true;
    expectedState = null;
    clearTimeout(timer);
    server?.close();
    server?.closeIdleConnections();
    resolveResult(outcome);
    if (!pendingReply) resolveCompletion();
  };
  const handle = (request, response) => {
    const reply = (status, text) => {
      response.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "connection": "close",
      });
      response.end(text);
    };
    if (settled) return reply(410, "Authorization callback is no longer active.");
    if (request.method !== "GET") return reply(405, "GET is required.");
    if (request.headers.host !== new URL(redirectUri).host) return reply(421, "Misdirected request.");
    if (!request.url || request.url.length > 24_576 || !request.url.startsWith("/")) {
      return reply(400, "Invalid authorization callback.");
    }
    let callback;
    try { callback = new URL(request.url, redirectUri); }
    catch { return reply(400, "Invalid authorization callback."); }
    if (callback.origin !== new URL(redirectUri).origin || callback.pathname !== path || callback.hash) {
      return reply(404, "Unknown callback.");
    }
    const names = new Set();
    for (const [name] of callback.searchParams) {
      if (names.has(name)) return reply(400, "Duplicate callback parameter.");
      names.add(name);
    }
    const state = callback.searchParams.get("state");
    if (!expectedState || typeof state !== "string") return reply(400, "Invalid callback state.");
    const receivedState = Buffer.from(state);
    if (receivedState.length !== expectedState.length || !timingSafeEqual(receivedState, expectedState)) {
      return reply(400, "Invalid callback state.");
    }
    const code = callback.searchParams.get("code");
    const error = callback.searchParams.get("error");
    callbackError = error;
    if (names.has("code") === names.has("error") || !(code || error)) {
      return reply(400, "Expected one authorization result.");
    }
    if (waitForCompletion) {
      pendingReply = reply;
      completionTimer = setTimeout(() => completeAuthorization({ status: 'failed', reason: 'authorization_timeout' }), 30000);
      completionTimer.unref?.();
    } else reply(200, "已收到授权回调，请返回 KCoder Studio 查看连接结果。");
    finish({ status: "received", callbackUrl: callback.href });
  };
  if (callbackOrigin) {
    redirectUri = callbackOrigin + path;
  } else {
    server = createServer({ maxHeaderSize: 32_768, requestTimeout: 5_000, headersTimeout: 5_000 }, handle);
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    redirectUri = `http://127.0.0.1:${server.address().port}${path}`;
  }
  timer = setTimeout(() => {
    finish({ status: "expired" });
    server?.closeAllConnections();
  }, lifetimeMs);
  timer.unref();
  return {
    redirectUri,
    handle,
    bindAuthorizationUrl(value) {
      if (settled || expectedState) throw new Error("MCP callback receiver is already bound or closed");
      const authorization = new URL(value);
      const states = authorization.searchParams.getAll("state");
      const redirects = authorization.searchParams.getAll("redirect_uri");
      if (states.length !== 1 || !states[0] || states[0].length > 1024 ||
          redirects.length !== 1 || redirects[0] !== redirectUri) {
        throw new Error("Authorization URL does not match this callback receiver");
      }
      expectedState = Buffer.from(states[0]);
    },
    result,
    completion,
    completeAuthorization,
    close() {
      completeAuthorization({ status: 'failed', reason: 'authorization_cancelled' });
      finish({ status: "cancelled" });
      server?.closeAllConnections();
    },
  };
}
