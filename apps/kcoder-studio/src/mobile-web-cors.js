/** Origin checks remain explicit; this factory has no authentication state. */
export function createMobileWebCors({ mobileWebOrigins, isAllowedOrigin, jsonResponse }) {
  function isAllowedMobileWebOrigin(origin) {
    if (!origin) return false;
    try {
      const parsed = new URL(origin);
      return /^https?:$/.test(parsed.protocol) && parsed.origin === origin && mobileWebOrigins.has(parsed.origin);
    } catch {
      return false;
    }
  }

  function isMobileApiPath(pathname) {
    return (
      pathname === "/api/mobile/session" ||
      pathname === "/api/mobile/session/refresh" ||
      pathname === "/api/mobile/p2p" ||
      pathname === "/api/mobile/p2p/offer" ||
      pathname === "/api/mobile/connection-proof" ||
      pathname === "/api/mobile/devices" ||
      /^\/api\/mobile\/devices\/[a-zA-Z0-9-]{16,128}$/.test(pathname) ||
      pathname === "/api/servers" ||
      pathname === "/api/servers/status" ||
      pathname === "/api/servers/test" ||
      /^\/api\/migration\/source-session\/(open|read|close|query)$/.test(pathname) ||
      /^\/api\/migration\/source-transfer\/(run|read|cancel|target-read|target-cancel|target-resume|target-finish|received|adoption-prepare|adoption-read|adoption-resume|adoption-cancel)$/.test(pathname) ||
      /^\/api\/servers\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}(?:\/cwd-observation)?$/.test(pathname)
    );
  }

  function applyMobileCors(request, response, pathname) {
    if (!isMobileApiPath(pathname) || !request.headers.origin)
      return { handled: false, allowed: true };
    let origin;
    try {
      origin = new URL(request.headers.origin).origin;
    } catch {
      return { handled: false, allowed: false };
    }
    const allowed =
      isAllowedOrigin(request.headers.origin, request.headers.host) ||
      isAllowedMobileWebOrigin(request.headers.origin);
    if (!allowed) {
      if (request.method === "OPTIONS") {
        jsonResponse(response, 403, {
          error: "Mobile Web origin is not allowed",
        });
        return { handled: true, allowed: false };
      }
      return { handled: false, allowed: false };
    }
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader(
      "access-control-allow-methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    response.setHeader(
      "access-control-allow-headers",
      "Authorization, Content-Type",
    );
    response.setHeader("access-control-max-age", "600");
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return { handled: true, allowed: true };
    }
    return { handled: false, allowed: true };
  }

  return { isAllowedMobileWebOrigin, isMobileApiPath, applyMobileCors };
}
