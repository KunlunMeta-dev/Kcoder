import assert from "node:assert/strict";

/** Bind an independent test actor to the exact UI bootstrap and owned task socket. */
export function mobileBrowserRpcCredentials({
  gateway, scopeExpectation, serverInventoryResponses, mobileBootstrap, protocol, pageSocketCredentials,
}) {
  const bootstrapResponses = serverInventoryResponses.filter(response =>
    response.source === "POST /api/mobile/session initialServers" &&
    response.responseStatus === 200 && response.bodyReadComplete &&
    response.ownedGatewayOrigin === true && response.mainFrameRequest === true);
  assert.equal(bootstrapResponses.length, 1,
    "the current Mobile page must own exactly one successful Gateway session bootstrap response");
  assert.ok(mobileBootstrap?.response, "the observed Mobile bootstrap must provide in-memory session credentials");
  assert.equal(mobileBootstrap.response, bootstrapResponses[0],
    "Node observer credentials must come from the exact successful bootstrap response recorded by this Mobile page");
  assert.ok(Array.isArray(bootstrapResponses[0].descriptors) &&
    bootstrapResponses[0].descriptors.some(descriptor => descriptor.id === scopeExpectation.routeServerId),
  "the exact bootstrap response must authorize the server in the current task route");

  const taskStart = protocol.requests.find(request => request.method === "turn/start" &&
    request.threadId === scopeExpectation.threadId && request.socketOrdinal === protocol.activeTaskSocketOrdinal);
  assert.ok(taskStart, "the active Mobile RPC owner must be the socket that started the exact UI task");
  const ownerRoute = protocol.routeDiagnostics.find(route => route.socketOrdinal === protocol.activeTaskSocketOrdinal);
  assert.ok(ownerRoute, "the UI task owner must have an observed Gateway RPC route");
  const ownerPageSocket = protocol.pageWebSockets.find(socket =>
    socket.rpcOrdinal === protocol.activeTaskSocketOrdinal && socket.closedAtMs === null);
  assert.ok(ownerPageSocket, "the UI task owner must map to one live page Gateway RPC socket");
  const socketCredentials = pageSocketCredentials.get(ownerPageSocket);
  assert.ok(socketCredentials, "the live UI task socket must have an in-memory query credential observation");
  const gatewayBaseUrl = new URL(gateway.baseUrl);
  assert.equal(socketCredentials.host, gatewayBaseUrl.host,
    "the UI task socket must connect to this RunContext's Gateway authority");
  assert.equal(socketCredentials.path, `${gatewayBaseUrl.pathname.replace(/\/+$/, "")}/rpc`,
    "the UI task socket must use this Gateway's RPC path");
  assert.equal(socketCredentials.serverId, scopeExpectation.routeServerId,
    "the UI task socket server must match the exact task route");
  assert.equal(socketCredentials.workspace, scopeExpectation.routeCwd,
    "the UI task socket workspace must match the exact task route cwd");
  assert.equal(socketCredentials.rpcToken, mobileBootstrap.rpcToken,
    "the current UI task RPC token must match the same-page Mobile bootstrap response");
  pageSocketCredentials.delete(ownerPageSocket);
  const accessToken = mobileBootstrap.accessToken;
  return {
    rpcToken: mobileBootstrap.rpcToken,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Origin: gatewayBaseUrl.origin,
      "Sec-WebSocket-Protocol": `kcoder-studio, kcoder-session.${accessToken}`,
    },
  };
}
