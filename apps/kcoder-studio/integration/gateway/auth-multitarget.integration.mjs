import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startGateway, waitForGatewayRpcToken } from "../../e2e/harness/gateway.mjs";
import { fetchJson, login } from "../../e2e/harness/http.mjs";
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from "../../e2e/harness/rpc.mjs";
import { repoRoot, runIntegration } from "../../e2e/harness/run-context.mjs";
import { materializeWorkspace } from "../../e2e/harness/workspace-fixture.mjs";

await runIntegration(import.meta.url, {
  testId: "auth-multitarget-mainline",
  tier: "pr-smoke",
  modelPolicy: "model-independent deterministic transport check",
}, async context => {
  const { path: workspaceA } = await materializeWorkspace(context, "minimal", { instanceId: "local-a" });
  const { path: workspaceB } = await materializeWorkspace(context, "minimal", { instanceId: "local-b" });
  await writeFile(resolve(workspaceA, "TARGET.txt"), "local-a\n");
  await writeFile(resolve(workspaceB, "TARGET.txt"), "local-b\n");
  const kcoderBin = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder");
  const settingsFile = await context.writeStateJson("scenario-settings.json", {
    active_provider: "fixture", credential_store: "file", max_retries: 0,
    providers: { fixture: {
      api_format: "openai_chat_completions", endpoint: "http://127.0.0.1:9/v1",
      authentication: { mode: "none" }, default_model: "fixture", context_window_tokens: 128000,
      max_output_tokens: 8192, output_headroom_tokens: 8192,
      capabilities: { text: true, tools: true, reasoning: false }, no_proxy: true, discover_models: false,
    } },
  });
  const serversFile = await context.writeStateJson("servers.json", [
    { id: "local-a", label: "Local A", transport: "local", command: kcoderBin, workspace: workspaceA, settingsFile },
    { id: "local-b", label: "Local B", transport: "local", command: kcoderBin, workspace: workspaceB, settingsFile },
  ]);
  const gateway = await startGateway(context, {
    host: "127.0.0.1",
    auth: true,
    workspace: workspaceA,
    serversFile,
    env: { KCODER_STUDIO_SCENARIO: "full-turn" },
  });

  const unauthenticated = await fetchJson(`${gateway.baseUrl}/api/servers`);
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.body.error, "Authentication required");
  const navigation = await fetch(gateway.baseUrl, { redirect: "manual", headers: { accept: "text/html" } });
  assert.equal(navigation.status, 303);
  assert.equal(navigation.headers.get("location"), "/login");
  const badLogin = await fetch(`${gateway.baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "definitely-wrong" }),
  });
  assert.equal(badLogin.status, 401);

  const cookie = await login(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  const authenticated = await fetchJson(`${gateway.baseUrl}/api/servers`, { headers: { cookie } });
  assert.equal(authenticated.response.status, 200);
  assert.deepEqual(authenticated.body.servers.map(server => server.id), ["local-a", "local-b"]);
  const health = await fetchJson(`${gateway.baseUrl}/api/servers/status`, { headers: { cookie } });
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body.statuses.map(item => item.id), ["local-a", "local-b"]);
  assert.ok(health.body.statuses.every(item => item.status === "online"), JSON.stringify(health.body));
  assert.ok(health.body.statuses.every(item => Number.isInteger(item.latencyMs) && item.latencyMs >= 0));
  const rpcToken = await waitForGatewayRpcToken(context, gateway, {
    headers: { cookie },
    expectedToken: "cookie-auth",
  });
  assert.equal(rpcToken, "cookie-auth");
  const routedTurns = [];
  const routes = [];
  for (const serverId of ["local-a", "local-b"]) {
    const rpc = await openRpc(gatewayRpcUrl(gateway, serverId, "cookie-auth"), {
      headers: { Cookie: cookie, Origin: gateway.baseUrl },
    });
    context.addCleanup(`close RPC for ${serverId}`, () => closeRpcAndWait(rpc, serverId));
    await initializeRpc(rpc, `kcoder-e2e-auth-${serverId}`);
    const thread = await rpc.request("thread/start", {});
    const expectedWorkspace = serverId === "local-a" ? workspaceA : workspaceB;
    assert.equal(thread.thread.cwd, expectedWorkspace, `${serverId} must create its thread in the selected target workspace`);
    routes.push({ serverId, rpc, thread });
  }
  for (const { serverId, rpc, thread } of routes) {
    const turn = await rpc.request("turn/start", {
      threadId: thread.thread.id,
      input: [{ type: "text", text: `model-independent route probe ${serverId}` }],
    });
    const completed = await rpc.waitFor(
      message => message.method === "turn/completed" && message.params?.turnId === turn.turn.id,
      20_000,
      `${serverId} deterministic turn`,
    );
    assert.equal(completed.params.turn.status, "completed");
    assert.match(JSON.stringify(rpc.messages()), /tui-lab-final-sentinel/);
    routedTurns.push({ serverId, status: completed.params.turn.status });
  }

  return {
    unauthenticatedStatus: unauthenticated.response.status,
    invalidLoginStatus: badLogin.status,
    serverIds: authenticated.body.servers.map(server => server.id),
    health: health.body.statuses.map(({ id, status, latencyMs }) => ({ id, status, latencyMs })),
    routedTurns,
  };
});
