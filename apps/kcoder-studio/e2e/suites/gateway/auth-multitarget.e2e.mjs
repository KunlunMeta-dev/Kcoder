import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { fetchJson, login } from "../../harness/http.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "auth-multitarget-mainline",
  tier: "pr-smoke",
  modelPolicy: "model-independent deterministic transport check",
}, async context => {
  const { path: workspaceA } = await materializeWorkspace(context, "minimal", { instanceId: "local-a" });
  const { path: workspaceB } = await materializeWorkspace(context, "minimal", { instanceId: "local-b" });
  await writeFile(resolve(workspaceA, "TARGET.txt"), "local-a\n");
  await writeFile(resolve(workspaceB, "TARGET.txt"), "local-b\n");
  const kcoderBin = resolve(repoRoot, "target/debug/kcoder");
  const serversFile = await context.writeStateJson("servers.json", [
    { id: "local-a", label: "Local A", transport: "local", command: kcoderBin, workspace: workspaceA },
    { id: "local-b", label: "Local B", transport: "local", command: kcoderBin, workspace: workspaceB },
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
  for (const serverId of ["local-a", "local-b"]) {
    const rpc = await openRpc(gatewayRpcUrl(gateway, serverId, "cookie-auth"), {
      headers: { Cookie: cookie, Origin: gateway.baseUrl },
    });
    await initializeRpc(rpc, `kcoder-e2e-auth-${serverId}`);
    const thread = await rpc.request("thread/start", {});
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
    rpc.close();
  }

  return {
    unauthenticatedStatus: unauthenticated.response.status,
    invalidLoginStatus: badLogin.status,
    serverIds: authenticated.body.servers.map(server => server.id),
    health: health.body.statuses.map(({ id, status, latencyMs }) => ({ id, status, latencyMs })),
    routedTurns,
  };
});
