import { captureGatewayRemoteTransportObservations, createRemoteTransportObservationRoute } from './remotes/transport-observations.mjs';
// Server catalog routes preserve the authenticated request scope supplied by Gateway.
export function createServerInventoryRoutes({
  getServers, sshConnections, jsonResponse, requireSameOriginMutation, requestBody,
  requestLoginOwner, publicServerInventory, serverHealthScopeKey, mock,
  probeServerHealthBounded, respondWithServerStatusSnapshot, loginContexts, gatewayRuntimeVersion, remoteTransportMetadata,
}) {
  const observeStartupTransport = captureGatewayRemoteTransportObservations({ gatewaySecret: remoteTransportMetadata?.gatewaySecret });
  const transportMetadataRoute = createRemoteTransportObservationRoute({
    observe: remoteTransportMetadata?.getEnvironment ? () => {
      const env = { ...remoteTransportMetadata.getEnvironment() };
      return captureGatewayRemoteTransportObservations({ env, gatewaySecret: env.KCODER_STUDIO_RELAY_SECRET })();
    } : observeStartupTransport,
    canRead: remoteTransportMetadata?.canRead ?? (() => false), jsonResponse,
  });
  return async function handleServerInventory(request, response, pathname, authSession) {
    if (await transportMetadataRoute(request, response, new URL(request.url || pathname, 'http://localhost'), authSession)) return true;
    const servers = getServers();
    if (pathname === "/api/ssh-connections" || pathname.startsWith("/api/ssh-connections/")) {
      if (!servers.every(item => authSession.allowedServerIds.has(item.id))) {
        jsonResponse(response, 403, { error: "Full Gateway access required" });
        return true;
      }
      try {
        if (pathname === "/api/ssh-connections" && request.method === "GET") {
          jsonResponse(response, 200, { connections: await sshConnections.list() });
          return true;
        }
        if (!requireSameOriginMutation(request)) {
          jsonResponse(response, 403, { error: "Same-origin JSON request required" });
          return true;
        }
        const id = pathname.slice("/api/ssh-connections/".length);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) throw new Error("Invalid SSH connection ID");
        if (request.method === "PUT") {
          const profile = JSON.parse(await requestBody(request, 32 * 1024));
          if (profile.id !== id) throw new Error("SSH connection ID does not match");
          jsonResponse(response, 200, { connection: await sshConnections.upsert(profile) });
        } else if (request.method === "DELETE") {
          await sshConnections.delete(id);
          jsonResponse(response, 200, { ok: true });
        } else jsonResponse(response, 405, { error: "Method not allowed" });
      } catch {
        jsonResponse(response, 400, { error: "Unable to read or update SSH connections; check fields and Gateway storage permissions" });
      }
      return true;
    }
    if (pathname === "/api/servers" && request.method === "GET") {
      const loginOwner = requestLoginOwner(request, authSession);
      const body = JSON.stringify(publicServerInventory(authSession, loginOwner));
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      return true;
    }
    if (pathname === "/api/servers/status" && request.method === "GET") {
      const loginOwner = requestLoginOwner(request, authSession);
      const targets = servers.filter((item) =>
        authSession.allowedServerIds.has(item.id),
      );
      const statusScopes = new Map(targets.map(target => [
        target.id,
        target.security ? serverHealthScopeKey(target, loginOwner) : null,
      ]));
      // In mock mode the WebSocket is the built-in app-server. Do not probe a live
      // command on disk, which would make test/demo UI report the available mock runtime as offline and disable input.
      const statuses = mock
        ? targets.map((item) => ({
            id: item.id,
            status: "online",
            latencyMs: 0,
            checkedAt: Date.now(),
          }))
        : await probeServerHealthBounded(targets, loginOwner);
      await respondWithServerStatusSnapshot({
        response,
        sendJson: jsonResponse,
        targets,
        statuses,
        statusScopes,
        currentScopeFor: target => serverHealthScopeKey(target, loginOwner),
        accountIdentityFor: id => loginOwner && loginContexts.identity(loginOwner, id),
        gatewayRuntimeVersion,
      });
      return true;
    }
    return false;
  };
}
