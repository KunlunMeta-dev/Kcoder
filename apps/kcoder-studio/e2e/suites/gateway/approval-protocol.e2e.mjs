import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { repoRoot, runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(
  import.meta.url,
  {
    testId: "real-app-server-approval-concurrent-error-and-transport-close",
    tier: "pr-smoke",
    modelPolicy: "model-independent deterministic approval RPC lifecycle check",
    retainSuccessLogs: true,
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "approval-protocol",
    });
    const configDir = context.pathInState("config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("config/settings.json", {});
    await context.writeStateJson("config/credentials.json", {
      "approval-protocol": { type: "api", key: "deterministic-local-fixture" },
      "approval-close": { type: "api", key: "deterministic-local-fixture" },
    });

    const concurrentModel = await startApprovalModelFixture(context);
    const concurrentSettings = await providerSettings(
      context,
      "concurrent-settings.json",
      {
        id: "approval-protocol",
        endpoint: concurrentModel.baseUrl,
      },
    );
    const concurrentServers = await context.writeStateJson(
      "concurrent-servers.json",
      [
        localServer("local-a", "Local A", workspace, concurrentSettings),
        localServer("local-b", "Local B", workspace, concurrentSettings),
      ],
    );
    const concurrentGateway = await startGateway(context, {
      label: "approval-concurrent-gateway",
      workspace,
      serversFile: concurrentServers,
      env: { KCODER_CONFIG_DIR: configDir },
    });
    const concurrentRpcA = await connect(
      context,
      concurrentGateway,
      "approval-concurrent-client-a",
      "local-a",
    );
    const concurrentRpcB = await connect(
      context,
      concurrentGateway,
      "approval-concurrent-client-b",
      "local-b",
    );
    const concurrentTurns = await Promise.all([
      startTurn(concurrentRpcA, "并发Permission request A"),
      startTurn(concurrentRpcB, "并发Permission request B"),
    ]);
    await waitFor(
      () =>
        approvalRequests(concurrentRpcA).length >= 1 &&
        approvalRequests(concurrentRpcB).length >= 1,
      30_000,
      "two concurrently pending approval requests",
    );
    const pending = [
      approvalRequests(concurrentRpcA)[0],
      approvalRequests(concurrentRpcB)[0],
    ];
    // JSON-RPC request IDs need be unique only within one connection; separate app-server connections may start from the same sequence.
    assert.notEqual(pending[0].params?.threadId, pending[1].params?.threadId);
    concurrentRpcA.respond(pending[0].id, { decision: "decline" });
    concurrentRpcB.respond(pending[1].id, { decision: "decline" });
    await waitFor(
      () =>
        approvalResolved(concurrentRpcA).length >= 1 &&
        approvalResolved(concurrentRpcB).length >= 1,
      30_000,
      "two approval/resolved notifications",
    );
    await concurrentRpcA.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === concurrentTurns[0].turnId,
      30_000,
      "concurrent approval turn A completion",
    );
    await concurrentRpcB.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === concurrentTurns[1].turnId,
      30_000,
      "concurrent approval turn B completion",
    );
    const resolved = [
      approvalResolved(concurrentRpcA)[0],
      approvalResolved(concurrentRpcB)[0],
    ];
    assert.ok(
      resolved.every((message) => message.params?.decision === "decline"),
    );
    assert.ok(
      resolved.every((message) => message.params?.reason === "client_response"),
    );

    const priorRequestCount = approvalRequests(concurrentRpcA).length;
    const errorTurn = await startTurn(concurrentRpcA, "触发客户端审批错误");
    await waitFor(
      () => approvalRequests(concurrentRpcA).length >= priorRequestCount + 1,
      30_000,
      "approval requests for error mapping",
    );
    const errorRequests = approvalRequests(concurrentRpcA).slice(
      priorRequestCount,
      priorRequestCount + 1,
    );
    concurrentRpcA.respondError(
      errorRequests[0].id,
      -32_001,
      "deterministic approval client failure",
    );
    await waitFor(
      () =>
        approvalResolved(concurrentRpcA).some(
          (message) =>
            message.params?.requestId === errorRequests[0].id &&
            message.params?.reason === "response_error",
        ),
      30_000,
      "approval response_error resolution",
    );
    await concurrentRpcA.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === errorTurn.turnId,
      30_000,
      "approval error turn completion",
    );
    concurrentRpcA.close();
    concurrentRpcB.close();
    await waitFor(
      () =>
        concurrentRpcA.socket.readyState ===
        concurrentRpcA.socket.constructor.CLOSED,
      5_000,
      "concurrent RPC A close",
    );
    await waitFor(
      () =>
        concurrentRpcB.socket.readyState ===
        concurrentRpcB.socket.constructor.CLOSED,
      5_000,
      "concurrent RPC B close",
    );
    await context.stopOwned("approval-concurrent-gateway");

    const deniedMarker = context.pathInState(
      "transport-close-command-must-not-run.txt",
    );
    const closeModel = await startApprovalModelFixture(context, {
      approvalCommand: `printf 'MUST_NOT_RUN\\n' > '${deniedMarker}'`,
    });
    const closeSettings = await providerSettings(
      context,
      "close-settings.json",
      {
        id: "approval-close",
        endpoint: closeModel.baseUrl,
      },
    );
    const closeServers = await serversFile(
      context,
      "close-servers.json",
      workspace,
      closeSettings,
    );
    const closeGateway = await startGateway(context, {
      label: "approval-close-gateway",
      workspace,
      serversFile: closeServers,
      env: { KCODER_CONFIG_DIR: configDir },
    });
    const closeRpc = await connect(
      context,
      closeGateway,
      "approval-transport-close-client",
    );
    await startTurn(closeRpc, "等待审批时关闭 transport");
    const closeRequest = await closeRpc.waitFor(
      (message) => message.method === "approval/request",
      30_000,
      "approval request before transport close",
    );
    assert.equal(closeRequest.params?.action?.type, "command");
    closeRpc.socket.endTransportWithoutCloseFrame();
    await waitFor(
      () => closeRpc.socket.readyState === closeRpc.socket.constructor.CLOSED,
      5_000,
      "approval transport close",
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    await assert.rejects(
      access(deniedMarker),
      "command ran despite approval transport close",
    );

    return {
      concurrentRequestIds: pending.map((message) => message.id),
      concurrentResolved: resolved.map((message) => ({
        approvalId: message.params?.approvalId,
        decision: message.params?.decision,
        reason: message.params?.reason,
      })),
      responseErrorFailClosed: true,
      transportCloseFailClosed: true,
      deniedMarkerAbsent: true,
    };
  },
);

async function providerSettings(context, filename, { id, endpoint }) {
  return context.writeStateJson(filename, {
    active_provider: id,
    permission_mode: "ask",
    providers: {
      [id]: {
        api_format: "openai_chat_completions",
        endpoint,
        default_model: `${id}-model`,
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 8_192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
}

async function serversFile(context, filename, workspace, settingsFile) {
  return context.writeStateJson(filename, [
    {
      id: "local",
      label: "Local",
      transport: "local",
      command: resolve(repoRoot, "target/debug/kcoder"),
      workspace,
      settingsFile,
    },
  ]);
}

async function connect(context, gateway, clientName, serverId = "local") {
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, serverId, token));
  await initializeRpc(rpc, clientName);
  return rpc;
}

function localServer(id, label, workspace, settingsFile) {
  return {
    id,
    label,
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
    settingsFile,
  };
}

async function startTurn(rpc, prompt) {
  const started = await rpc.request("thread/start", {});
  const turn = await rpc.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: prompt }],
  });
  return { threadId: started.thread.id, turnId: turn.turn.id };
}

function approvalRequests(rpc) {
  return rpc
    .messages()
    .filter(
      (message) =>
        message.method === "approval/request" && message.id !== undefined,
    );
}

function approvalResolved(rpc) {
  return rpc
    .messages()
    .filter((message) => message.method === "approval/resolved");
}
