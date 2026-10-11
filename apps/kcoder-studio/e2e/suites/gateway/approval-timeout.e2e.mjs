import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "real-app-server-approval-timeout-fail-closed",
  tier: "pr-smoke",
  modelPolicy: "model-independent deterministic approval timeout check",
  retainSuccessLogs: true,
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "approval-timeout" });
  const configDir = context.pathInState("config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await context.writeStateJson("config/settings.json", {});
  await context.writeStateJson("config/credentials.json", {
    "approval-timeout": { type: "api", key: "deterministic-local-fixture" },
  });
  const deniedMarker = context.pathInState("timeout-command-must-not-run.txt");
  const model = await startApprovalModelFixture(context, {
    approvalCommand: `printf 'MUST_NOT_RUN\\n' > '${deniedMarker}'`,
  });
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "approval-timeout",
    permission_mode: "ask",
    providers: {
      "approval-timeout": {
        api_format: "openai_chat_completions",
        endpoint: model.baseUrl,
        default_model: "approval-timeout-model",
        context_window_tokens: 128_000,
        output_headroom_tokens: 8_192,
        max_output_tokens: 8_192,
        request_timeout_secs: 30,
        no_proxy: true,
        extra_body: {},
      },
    },
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "local",
    label: "Local",
    transport: "local",
    command: resolve(repoRoot, "target/debug/kcoder"),
    workspace,
    settingsFile,
  }]);
  const gateway = await startGateway(context, {
    label: "approval-timeout-gateway",
    workspace,
    serversFile,
    env: {
      KCODER_CONFIG_DIR: configDir,
      KCODER_E2E_APPROVAL_TIMEOUT_MS: "250",
    },
  });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
  await initializeRpc(rpc, "approval-timeout-client");
  const started = await rpc.request("thread/start", {});
  const turn = await rpc.request("turn/start", {
    threadId: started.thread.id,
    input: [{ type: "text", text: "不响应审批，验证超时拒绝" }],
  });
  const request = await rpc.waitFor(message => message.method === "approval/request", 30_000, "approval request");
  const resolved = await rpc.waitFor(message =>
    message.method === "approval/resolved" && message.params?.requestId === request.id,
  10_000, "approval timeout resolution");
  assert.equal(resolved.params?.decision, "decline");
  assert.equal(resolved.params?.reason, "timeout");
  await rpc.waitFor(message =>
    message.method === "turn/completed" && message.params?.turnId === turn.turn.id,
  30_000, "turn completion after timeout");
  await assert.rejects(access(deniedMarker), "command ran despite approval timeout");
  rpc.close();
  return { requestId: request.id, decision: resolved.params.decision, reason: resolved.params.reason, deniedMarkerAbsent: true };
});
