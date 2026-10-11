import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "thread-metadata-survives-gateway-and-app-server-restart",
  tier: "full-integration",
  modelPolicy: "model-independent persistent RPC contract check",
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "metadata-persistence",
  });
  const configDir = context.pathInState("config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("config/settings.json", {});
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Local",
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
  }]);
  const gatewayOptions = {
    workspace,
    serversFile,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_STUDIO_SCENARIO: "full-turn",
    },
  };

  const firstGateway = await startGateway(context, { ...gatewayOptions, label: "metadata-gateway-1" });
  const firstToken = await waitForGatewayRpcToken(context, firstGateway);
  const first = await openRpc(gatewayRpcUrl(firstGateway, "local", firstToken));
  await initializeRpc(first, "kcoder-e2e-metadata-writer");
  const started = await first.request("thread/start", {});
  const threadId = started.thread.id;
  const turn = await first.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "persist this deterministic thread" }],
  });
  await first.waitFor(
    message => message.method === "turn/completed" && message.params?.turnId === turn.turn.id,
    20_000,
    "metadata fixture turn",
  );
  const title = "跨进程 E2E 标题";
  const archivedAt = "2026-07-29T00:00:00.000Z";
  const updated = await first.request("thread/metadata/update", {
    threadId,
    title,
    model: "metadata-e2e-model",
    archivedAt,
  });
  assert.equal(updated.thread.title, title);
  first.close();
  await waitFor(() => first.socket.readyState === first.socket.constructor.CLOSED, 5_000, "first RPC close");
  await context.stopOwned("metadata-gateway-1");

  const secondGateway = await startGateway(context, { ...gatewayOptions, label: "metadata-gateway-2" });
  const secondToken = await waitForGatewayRpcToken(context, secondGateway);
  const second = await openRpc(gatewayRpcUrl(secondGateway, "local", secondToken));
  await initializeRpc(second, "kcoder-e2e-metadata-reader");
  const listed = await second.request("thread/list", { limit: 100 });
  const restored = listed.threads.find(thread => thread.id === threadId);
  assert.ok(restored, `thread ${threadId} was not restored by a new app-server process`);
  assert.equal(restored.title, title);
  assert.equal(restored.model, "metadata-e2e-model");
  assert.equal(restored.archivedAt, archivedAt);

  const concurrent = await openRpc(gatewayRpcUrl(secondGateway, "local", secondToken));
  await initializeRpc(concurrent, "kcoder-e2e-metadata-concurrent-writer");
  const concurrentTitle = "并发写入后的标题";
  const concurrentModel = "metadata-e2e-concurrent-model";
  await Promise.all([
    second.request("thread/metadata/update", { threadId, title: concurrentTitle }),
    concurrent.request("thread/metadata/update", { threadId, model: concurrentModel }),
  ]);
  const afterConcurrentWrites = await second.request("thread/list", { limit: 100 });
  const merged = afterConcurrentWrites.threads.find(thread => thread.id === threadId);
  assert.ok(merged, `thread ${threadId} disappeared after concurrent metadata updates`);
  assert.equal(merged.title, concurrentTitle, "a concurrent model update must not lose the title update");
  assert.equal(merged.model, concurrentModel, "a concurrent title update must not lose the model update");
  assert.equal(merged.archivedAt, archivedAt);

  const cleared = await concurrent.request("thread/metadata/update", {
    threadId,
    model: null,
    archivedAt: null,
  });
  assert.equal(cleared.thread.title, concurrentTitle);
  assert.equal(cleared.thread.model, undefined);
  assert.equal(cleared.thread.archivedAt, undefined);
  second.close();
  concurrent.close();
  await waitFor(() => second.socket.readyState === second.socket.constructor.CLOSED, 5_000, "second RPC close");
  await waitFor(() => concurrent.socket.readyState === concurrent.socket.constructor.CLOSED, 5_000, "concurrent RPC close");
  await context.stopOwned("metadata-gateway-2");

  const thirdGateway = await startGateway(context, { ...gatewayOptions, label: "metadata-gateway-3" });
  const thirdToken = await waitForGatewayRpcToken(context, thirdGateway);
  const third = await openRpc(gatewayRpcUrl(thirdGateway, "local", thirdToken));
  context.addCleanup("close final metadata reader RPC", () => third.close());
  await initializeRpc(third, "kcoder-e2e-metadata-final-reader");
  const finalList = await third.request("thread/list", { limit: 100 });
  const finalThread = finalList.threads.find(thread => thread.id === threadId);
  assert.ok(finalThread, `thread ${threadId} was not restored after clearing metadata`);
  assert.equal(finalThread.title, concurrentTitle);
  assert.equal(finalThread.model, undefined, "cleared model must remain absent after process restart");
  assert.equal(finalThread.archivedAt, undefined, "cleared archive state must remain absent after process restart");

  return {
    threadId,
    title: finalThread.title,
    model: finalThread.model,
    archivedAt: finalThread.archivedAt,
    concurrentWriters: 2,
    gatewayProcesses: 3,
  };
});
