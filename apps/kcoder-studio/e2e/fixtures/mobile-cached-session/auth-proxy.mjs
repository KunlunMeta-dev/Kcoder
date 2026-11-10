import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

function sameSecret(left, right) {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

/** Authenticates only this development fixture, never the normal Mobile/Gateway routes. */
export function createFixtureProxy({ prefix, publicOrigin, upstreamPort, token }) {
  if (!/^\/fixtures\/[a-z0-9-]+$/.test(prefix) || token.length < 32) throw new Error("Invalid fixture scope");
  const cookieName = `kcoder_cache_fixture_${createHash("sha256").update(prefix).digest("hex").slice(0, 12)}`;
  const session = randomBytes(32).toString("base64url");
  const sockets = new Set();
  const authorized = (request) => (request.headers.cookie || "").split(";").some(part => {
    const [name, ...value] = part.trim().split("=");
    return name === cookieName && sameSecret(value.join("="), session);
  });
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    if (url.pathname === `${prefix}/login` && request.method === "GET") {
      if (!sameSecret(url.searchParams.get("token") || "", token)) { response.writeHead(401, headers).end(); return; }
      const allowed = new URLSearchParams();
      for (const key of ["theme", "language", "state", "draft", "history"]) {
        if (url.searchParams.has(key)) allowed.set(key, url.searchParams.get(key));
      }
      const secure = publicOrigin.startsWith("https:") && request.headers["x-forwarded-proto"] !== "http";
      response.writeHead(303, { ...headers,
        "Set-Cookie": `${cookieName}=${session}; Path=${prefix}/; HttpOnly; SameSite=Strict; Max-Age=604800${secure ? "; Secure" : ""}`,
        Location: `${prefix}/${allowed.size ? `?${allowed}` : ""}`,
      }).end();
      return;
    }
    if (!url.pathname.startsWith(`${prefix}/`)) { response.writeHead(404, headers).end(); return; }
    if (!authorized(request)) { response.writeHead(401, headers).end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, headers).end(); return; }
    const path = url.pathname.slice(prefix.length);
    if (path !== "/" && !/^\/(?:index\.tsx\.bundle|assets\/|node_modules\/|\.expo\/|favicon\.ico)/.test(path)) {
      response.writeHead(404, headers).end(); return;
    }
    const upstream = http.request({ host: "127.0.0.1", port: upstreamPort, path: path + url.search,
      method: request.method, headers: { host: `127.0.0.1:${upstreamPort}`, "accept-encoding": "identity" } }, result => {
      const type = result.headers["content-type"] || "";
      if (type.includes("javascript") || type.includes("text/html")) {
        const chunks = [];
        result.on("data", chunk => chunks.push(chunk));
        result.on("end", async () => {
          const body = Buffer.concat(chunks).toString("utf8")
            .replaceAll("window.location.host}/hot", `window.location.host}${prefix}/hot`)
            .replaceAll("window.location.host}/message", `window.location.host}${prefix}/message`)
            .replaceAll('"/mobile/node_modules/', `"${prefix}/node_modules/`)
            .replaceAll("/../../../mobile/node_modules/", `${prefix}/node_modules/`)
            .replaceAll('"/assets/?', `"${prefix}/assets/?`)
            .replaceAll('src="/index.tsx.bundle', `src="${prefix}/index.tsx.bundle`);
          if (/\bgzip\b/.test(request.headers["accept-encoding"] || "")) {
            try {
              const compressed = await gzipAsync(body);
              response.writeHead(result.statusCode, { ...headers, "Content-Type": type, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
              response.end(compressed);
            } catch { if (!response.headersSent) response.writeHead(502, headers); response.end(); }
          } else {
            response.writeHead(result.statusCode, { ...headers, "Content-Type": type, Vary: "Accept-Encoding" });
            response.end(body);
          }
        });
      } else {
        response.writeHead(result.statusCode, { ...headers, "Content-Type": type || "application/octet-stream" });
        result.pipe(response);
      }
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502, headers); response.end(); });
    request.on("aborted", () => upstream.destroy());
    upstream.end();
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const origin = request.headers.origin;
    if (!authorized(request) || ![`${prefix}/hot`, `${prefix}/message`].includes(url.pathname) ||
        (origin !== publicOrigin && origin !== `http://${request.headers.host}`)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return;
    }
    const upstream = http.request({ host: "127.0.0.1", port: upstreamPort, path: url.pathname.slice(prefix.length) + url.search,
      headers: { host: `127.0.0.1:${upstreamPort}`, connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-key": request.headers["sec-websocket-key"], "sec-websocket-version": "13", origin: `http://127.0.0.1:${upstreamPort}` } });
    upstream.on("upgrade", (result, peer, peerHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(result.headers).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`);
      if (head.length) peer.write(head);
      if (peerHead.length) socket.write(peerHead);
      peer.pipe(socket); socket.pipe(peer);
      socket.on("close", () => peer.destroy()); peer.on("error", () => socket.destroy());
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.end();
  });
  return { server, close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); } };
}
