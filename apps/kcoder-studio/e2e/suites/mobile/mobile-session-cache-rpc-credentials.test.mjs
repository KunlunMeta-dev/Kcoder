import assert from "node:assert/strict";
import test from "node:test";
import { mobileBrowserRpcCredentials } from "./mobile-session-cache-rpc-credentials.mjs";

function fixture() {
  const gateway = { baseUrl: "http://127.0.0.1:42673" };
  const scopeExpectation = { threadId: "target", routeServerId: "local", routeCwd: "/owned/workspace" };
  const response = { source: "POST /api/mobile/session initialServers", responseStatus: 200,
    bodyReadComplete: true, ownedGatewayOrigin: true, mainFrameRequest: true,
    descriptors: [{ id: "local" }] };
  const mobileBootstrap = { response, accessToken: "private-access", rpcToken: "private-rpc" };
  const pageSocket = { rpcOrdinal: 3, closedAtMs: null };
  const pageSocketCredentials = new WeakMap([[pageSocket, { host: "127.0.0.1:42673", path: "/rpc",
    serverId: "local", workspace: "/owned/workspace", rpcToken: "private-rpc" }]]);
  const protocol = { activeTaskSocketOrdinal: 3,
    requests: [{ method: "turn/start", threadId: "target", socketOrdinal: 3 }],
    routeDiagnostics: [{ socketOrdinal: 3 }], pageWebSockets: [pageSocket] };
  return { gateway, scopeExpectation, serverInventoryResponses: [response], mobileBootstrap,
    protocol, pageSocketCredentials, pageSocket };
}

test("actor credentials require the exact live UI bootstrap and task socket", () => {
  const valid = fixture();
  const credentials = mobileBrowserRpcCredentials(valid);
  assert.equal(credentials.rpcToken, "private-rpc");
  assert.equal(credentials.headers.Authorization, "Bearer private-access");
  assert.equal(valid.pageSocketCredentials.has(valid.pageSocket), false);
  for (const change of [
    item => { item.pageSocketCredentials.set(item.pageSocket, { host: "127.0.0.1:42673", path: "/rpc",
      serverId: "local", workspace: "/peer/workspace", rpcToken: "private-rpc" }); },
    item => { item.mobileBootstrap.response = { ...item.serverInventoryResponses[0] }; },
    item => { item.protocol.activeTaskSocketOrdinal = 4; },
    item => { item.pageSocket.closedAtMs = 1; },
  ]) {
    const item = fixture();
    change(item);
    assert.throws(() => mobileBrowserRpcCredentials(item));
  }
});
