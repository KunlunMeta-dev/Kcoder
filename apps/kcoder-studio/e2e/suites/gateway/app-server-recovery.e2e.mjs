import assert from "node:assert/strict";
import { resolve } from "node:path";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { login } from "../../harness/http.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { repoRoot, requireExecutable, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "gateway-app-server-recovery-authorization-and-browser-retry",
  tier: "pr-smoke",
  modelPolicy: "model-independent real app-server restart and browser failure protocol; no model requests",
}, async context => {
  const kcoderBin = await requireExecutable(resolve(repoRoot, "target/debug/kcoder"), "KCoder app-server");
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "recovery-main" });
  const { path: otherWorkspace } = await materializeWorkspace(context, "minimal", { instanceId: "recovery-other" });
  await context.writeStateJson("config/settings.json", {});
  const missingChromium = context.pathInState("missing-chromium-executable");
  const serversFile = await context.writeStateJson("servers.json", [
    { id: "main", label: "Recovery main", transport: "local", command: kcoderBin, workspace, chromiumBin: missingChromium },
    { id: "other", label: "Recovery other", transport: "local", command: kcoderBin, workspace: otherWorkspace, chromiumBin: missingChromium },
  ]);
  const gateway = await startGateway(context, {
    auth: true,
    workspace,
    serversFile,
    serversStore: context.pathInState("servers-store.json"),
    env: {
      KCODER_CONFIG_DIR: context.pathInState("config"),
      KCODER_STUDIO_SCENARIO: "full-turn",
      KCODER_CHROMIUM_BIN: missingChromium,
      KCODER_CHROMIUM_NO_SANDBOX: "0",
    },
  });
  const cookie = await login(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, {
    headers: { cookie }, expectedToken: "cookie-auth",
  });
  const connect = async (label, serverId = "main", channel = "runtime") => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, serverId, token, channel), {
      headers: { Cookie: cookie, Origin: gateway.baseUrl },
    });
    context.addCleanup(`close ${label} RPC`, () => rpc.close());
    return rpc;
  };
  let sequence = 0;
  const requestFrame = async (rpc, method, params) => {
    const id = `recovery-${++sequence}`;
    rpc.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return rpc.waitFor(message => message.id === id, 10_000, `${method} response`);
  };
  const restartError = async (rpc, params, code) => {
    const response = await requestFrame(rpc, "gateway/app-server/restart", params);
    assert.equal(response.error?.code, code, JSON.stringify(response));
  };
  const detachError = async (rpc, params, code) => {
    const response = await requestFrame(rpc, "gateway/client/detach", params);
    assert.equal(response.error?.code, code, JSON.stringify(response));
  };

  const first = await connect("main first");
  await restartError(first, { confirm: true }, -32002);
  const initialized = await initializeRpc(first, "kcoder-e2e-recovery-first");
  assert.equal(initialized.capabilities.experimental.browserSessions, false);
  const thread = await first.request("thread/start", {});
  const threadId = thread.thread.id;
  const invalidParams = [null, [], 42, "garbage", {}, { confirm: false }, { confirm: "true" }, { confirm: true, force: "yes" }, { confirm: true, extra: true }];
  for (const params of invalidParams) {
    await restartError(first, params, -32602);
    assert.equal((await first.request("server/info", {})).id, threadId);
  }
  first.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "gateway/app-server/restart", params: { confirm: true } }));
  const noId = await first.waitFor(message => message.id === null && message.error?.code === -32600, 10_000, "restart notification rejection");
  assert.equal(noId.error.code, -32600);
  assert.equal((await first.request("server/info", {})).id, threadId);

  const peer = await connect("main peer");
  await detachError(peer, { confirm: true, force: false }, -32002);
  await initializeRpc(peer, "kcoder-e2e-recovery-peer");
  const invalidDetachParams = [
    null, [], 42, "garbage", {}, { confirm: false, force: false },
    { confirm: true }, { confirm: true, force: "false" },
    { confirm: true, force: false, clientId: "another-client" },
    { confirm: true, force: false, ownerId: "another-owner" },
    { confirm: true, force: false, threadId },
  ];
  for (const params of invalidDetachParams) {
    await detachError(peer, params, -32602);
    assert.equal((await peer.request("server/info", {})).id, threadId);
    assert.equal((await first.request("server/info", {})).id, threadId);
  }
  peer.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "gateway/client/detach", params: { confirm: true, force: false } }));
  const noDetachId = await peer.waitFor(message => message.id === null && message.error?.code === -32600, 10_000, "detach notification rejection");
  assert.equal(noDetachId.error.code, -32600);
  assert.equal((await peer.request("server/info", {})).id, threadId);
  assert.equal((await first.request("server/info", {})).id, threadId);
  const other = await connect("other workspace", "other");
  await initializeRpc(other, "kcoder-e2e-recovery-other");
  const otherThreadId = (await other.request("thread/start", {})).thread.id;
  for (const force of [false, true]) {
    await restartError(first, { confirm: true, force }, -32043);
    assert.equal((await peer.request("server/info", {})).id, threadId);
    assert.equal((await other.request("server/info", {})).id, otherThreadId);
  }

  const browser = await connect("browser retry", "main", "browser");
  const browserInitialized = await initializeRpc(browser, "kcoder-e2e-browser-retry");
  assert.equal(browserInitialized.capabilities.experimental.browserSessions, false);
  const browserErrorCodes = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestFrame(browser, "browser/start", { url: gateway.baseUrl, width: 800, height: 600 });
    assert.equal(response.error?.code, -32602, JSON.stringify(response));
    assert.match(response.error.message, /Chromium/i);
    browserErrorCodes.push(response.error.code);
  }
  browser.close();
  const detached = await peer.request("gateway/client/detach", { confirm: true, force: false });
  assert.deepEqual(detached, { detached: true });
  await waitFor(() => browser.socket.readyState === browser.socket.constructor.CLOSED &&
    peer.socket.readyState === peer.socket.constructor.CLOSED, 5_000, "peer and browser sockets closed");
  assert.equal((await first.request("server/info", {})).id, threadId);
  assert.equal((await other.request("server/info", {})).id, otherThreadId);

  const stopped = await first.request("gateway/app-server/restart", { confirm: true, force: false });
  assert.deepEqual(stopped, { restarted: false, stopped: true, reconnectRequired: true });
  await waitFor(() => first.socket.readyState === first.socket.constructor.CLOSED, 5_000, "restart closes old RPC");
  assert.equal((await other.request("server/info", {})).id, otherThreadId);
  const reconnected = await connect("main reconnected");
  const fresh = await initializeRpc(reconnected, "kcoder-e2e-recovery-reconnected");
  assert.equal(fresh.serverInfo.name, "kcoder-app-server");
  assert.equal(fresh.capabilities.experimental.browserSessions, false);

  return {
    invalidRestartRequestsRejected: invalidParams.length,
    invalidDetachRequestsRejected: invalidDetachParams.length,
    uninitializedAndNotificationDetachRejected: true,
    detachOnlyClosesRequester: true,
    detached,
    uninitializedAndNotificationRestartRejected: true,
    sharedWorkspaceForceRestartRejected: true,
    otherWorkspaceUnaffected: true,
    restart: stopped,
    reconnected: true,
    browserErrorCodes,
    browserRetryReachedBackend: true,
    modelRequests: 0,
  };
});
