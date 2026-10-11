import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Own a loopback-only, streaming Provider forwarder with a hard upstream cap.
 * The configured upstream URL is intentionally kept in this closure: callers
 * receive only the loopback endpoint and counters, never the URL or headers.
 */
export async function startProviderBudgetProxy(
  context,
  { upstreamEndpoint, maxForwardedRequests, label = "real-provider-budget-proxy" },
) {
  if (typeof upstreamEndpoint !== "string" || !upstreamEndpoint.trim()) {
    throw new Error("Provider budget proxy requires the selected upstream endpoint");
  }
  if (!Number.isSafeInteger(maxForwardedRequests) || maxForwardedRequests < 1) {
    throw new Error("Provider budget proxy requires a positive forwarding limit");
  }

  let upstreamBase;
  try {
    upstreamBase = new URL(upstreamEndpoint);
  } catch {
    throw new Error("Provider budget proxy received an invalid selected endpoint");
  }
  if (
    !["http:", "https:"].includes(upstreamBase.protocol) ||
    !upstreamBase.hostname ||
    upstreamBase.hash
  ) {
    throw new Error("Provider budget proxy endpoint must be an absolute HTTP(S) URL without a fragment");
  }

  const state = {
    forwardedRequests: 0,
    forwardedPostRequests: 0,
    locallyRejectedRequests: 0,
    blockedRedirectResponses: 0,
    inFlightRequests: 0,
  };
  const active = new Set();
  let closing = false;
  let closePromise = null;
  const transport = upstreamBase.protocol === "https:" ? https : http;

  const server = http.createServer((incoming, downstream) => {
    // This synchronous check and increment are the budget's serialization
    // point. No request body is read and no upstream socket is created first.
    if (closing) {
      rejectLocally(incoming, downstream, 503, "proxy_closing");
      return;
    }
    if (state.forwardedRequests >= maxForwardedRequests) {
      state.locallyRejectedRequests += 1;
      rejectLocally(incoming, downstream, 429, "provider_request_budget_exhausted");
      return;
    }

    const target = buildUpstreamTarget(upstreamEndpoint, upstreamBase, incoming.url);
    if (!target) {
      rejectLocally(incoming, downstream, 400, "invalid_provider_request_target");
      return;
    }

    state.forwardedRequests += 1;
    if (incoming.method === "POST") state.forwardedPostRequests += 1;
    state.inFlightRequests += 1;

    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = {
      request: null,
      response: null,
      incoming,
      downstream,
      done,
      settled: false,
      finish() {
        if (entry.settled) return;
        entry.settled = true;
        active.delete(entry);
        state.inFlightRequests -= 1;
        settle();
      },
    };
    active.add(entry);

    let upstreamRequest;
    try {
      upstreamRequest = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: incoming.method,
          path: `${target.pathname}${target.search}`,
          headers: filteredRequestHeaders(incoming.headers),
          auth: target.username || target.password
            ? `${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`
            : undefined,
          ...(target.protocol === "https:" ? { rejectUnauthorized: true } : {}),
          setHost: true,
          agent: undefined,
        },
        (upstreamResponse) => {
          entry.response = upstreamResponse;
          upstreamResponse.once("close", entry.finish);
          upstreamResponse.once("error", () => {
            entry.finish();
            if (closing || downstream.destroyed) {
              downstream.destroy();
            } else {
              safeBadGateway(downstream);
            }
          });

          const status = upstreamResponse.statusCode || 502;
          if (status >= 300 && status < 400) {
            state.blockedRedirectResponses += 1;
            upstreamResponse.resume();
            if (!downstream.destroyed) {
              downstream.writeHead(502, {
                "cache-control": "no-store",
                "content-type": "application/json; charset=utf-8",
                "content-length": Buffer.byteLength('{"error":"provider_redirect_blocked"}'),
              });
              downstream.end('{"error":"provider_redirect_blocked"}');
            }
            return;
          }

          try {
            downstream.writeHead(status, filteredResponseHeaders(upstreamResponse.headers));
          } catch {
            upstreamResponse.destroy();
            if (!downstream.destroyed) {
              downstream.writeHead(502, { "content-length": "0" });
              downstream.end();
            }
            return;
          }
          upstreamResponse.pipe(downstream);
        },
      );
      entry.request = upstreamRequest;
    } catch {
      entry.finish();
      safeBadGateway(downstream);
      return;
    }

    upstreamRequest.once("error", () => {
      entry.finish();
      if (closing || downstream.destroyed) {
        downstream.destroy();
      } else {
        safeBadGateway(downstream);
      }
    });
    incoming.once("error", () => upstreamRequest.destroy());
    incoming.once("aborted", () => upstreamRequest.destroy());
    downstream.once("error", () => {
      upstreamRequest.destroy();
      entry.response?.destroy();
      entry.finish();
    });
    downstream.once("close", () => {
      if (!downstream.writableEnded) {
        upstreamRequest.destroy();
        entry.response?.destroy();
      }
    });
    incoming.pipe(upstreamRequest);
  });

  // Keep server-side socket failures from becoming unhandled process errors;
  // the request/response paths already return safe local failures.
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    const onError = () => {
      server.off("listening", onListening);
      reject(new Error("Provider budget proxy could not bind its owned loopback listener"));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address();
  if (!address || typeof address !== "object") {
    await closeServer(server);
    throw new Error("Provider budget proxy did not receive an owned TCP port");
  }
  context.registerPort(label, address.port);

  const proxy = {
    port: address.port,
    endpoint: `http://127.0.0.1:${address.port}`,
    get isListening() {
      return server.listening;
    },
    snapshot() {
      return { ...state };
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const activeEntries = [...active];
        for (const entry of activeEntries) {
          entry.incoming.unpipe(entry.request);
          entry.request?.destroy();
          entry.response?.destroy();
          entry.downstream.destroy();
          entry.incoming.destroy();
        }
        if (server.listening) {
          const closed = new Promise((resolve, reject) => {
            server.close((error) => {
              if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
              else resolve();
            });
          });
          server.closeAllConnections?.();
          await closed;
        }
        await Promise.all(activeEntries.map((entry) => entry.done));
      })();
      return closePromise;
    },
  };
  context.addCleanup(`close ${label}`, () => proxy.close());
  return proxy;
}

function buildUpstreamTarget(upstreamEndpoint, upstreamBase, requestTarget) {
  if (
    typeof requestTarget !== "string" ||
    !requestTarget.startsWith("/") ||
    requestTarget.startsWith("//") ||
    requestTarget.includes("\\") ||
    requestTarget.includes("#") ||
    requestTarget.includes("\r") ||
    requestTarget.includes("\n")
  ) {
    return null;
  }
  try {
    // Match KCoder's configured Anthropic URL construction: trim trailing
    // slashes from the full selected base string, then append the request path.
    const exactTarget = `${upstreamEndpoint.replace(/\/+$/, "")}${requestTarget}`;
    const target = new URL(exactTarget);
    if (
      target.protocol !== upstreamBase.protocol ||
      target.origin !== upstreamBase.origin ||
      target.hash
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

function filteredRequestHeaders(headers) {
  const blocked = hopByHopHeaderNames(headers);
  blocked.add("host");
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function filteredResponseHeaders(headers) {
  const blocked = hopByHopHeaderNames(headers);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function hopByHopHeaderNames(headers) {
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  const connection = headers.connection;
  for (const value of Array.isArray(connection) ? connection : [connection]) {
    for (const token of String(value || "").split(",")) {
      const name = token.trim().toLowerCase();
      if (/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) blocked.add(name);
    }
  }
  return blocked;
}

function rejectLocally(incoming, downstream, status, code) {
  // Drain but never buffer a request which is rejected before its upstream
  // forwarding point. No body or secret-bearing headers are reflected.
  incoming.resume();
  if (downstream.destroyed) return;
  const body = JSON.stringify({ error: code });
  downstream.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    connection: "close",
  });
  downstream.end(body);
}

function safeBadGateway(downstream) {
  if (downstream.destroyed || downstream.writableEnded) return;
  if (!downstream.headersSent) {
    const body = '{"error":"provider_upstream_unavailable"}';
    downstream.writeHead(502, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      connection: "close",
    });
    downstream.end(body);
  } else {
    downstream.destroy();
  }
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}
