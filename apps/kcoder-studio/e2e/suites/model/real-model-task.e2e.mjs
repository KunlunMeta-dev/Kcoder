import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { prepareIsolatedRealModelConfig, realModelPreflight } from "../../harness/real-model.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(
  import.meta.url,
  {
    testId: "real-model-two-turn-continuity",
    tier: "pr-smoke-credentialed",
    modelPolicy: "real-model-required",
    retainSuccessLogs: true,
  },
  async (context) => {
    const model = await realModelPreflight(
      process.env.KCODER_E2E_MODEL_PROFILE || "kunlunmeta",
    );
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "real-model",
    });
    const { configDir, settingsFile } = await prepareIsolatedRealModelConfig(context, model);
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "real-model",
        label: "Real Model",
        transport: "local",
        command: model.kcoderBin,
        workspace,
        settingsFile,
        profile: model.profile,
      },
    ]);
    const credentialEnv = Object.fromEntries(
      model.credentialEnv
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]]),
    );
    const gateway = await startGateway(context, {
      workspace,
      serversFile,
      env: {
        // Mutable state stays run-owned; only the credential link targets the approved store.
        KCODER_CONFIG_DIR: configDir,
        // This runtime-only flag disables automatic background model calls and retries.
        KCODER_TRAINING_MODE: "true",
        KCODER_MAX_TOKENS: process.env.KCODER_E2E_MODEL_MAX_TOKENS || "256",
        KCODER_MAX_RETRIES: "1",
        KCODER_MAX_DURATION_SECS:
          process.env.KCODER_E2E_MODEL_TIMEOUT_SECS || "90",
        ...credentialEnv,
      },
    });
    const token = await waitForGatewayRpcToken(context, gateway);
    const rpc = await openRpc(gatewayRpcUrl(gateway, "real-model", token));
    context.addCleanup("close real-model RPC", () => rpc.close());
    const initialized = await initializeRpc(rpc, "kcoder-e2e-real-model");
    assert.equal(initialized.serverInfo.name, "kcoder-app-server");
    const thread = await rpc.request("thread/start", {});
    const threadId = thread.thread.id;
    const firstMarker = `KLREAL_${randomBytes(6).toString("hex").toUpperCase()}`;
    const first = await runTurn(
      rpc,
      threadId,
      `这是一个真实模型端到端测试。不要调用任何工具，只回复标记 ${firstMarker}。`,
      120_000,
    );
    assert.match(first.text, new RegExp(firstMarker));
    const secondMarker = `KLCONT_${randomBytes(6).toString("hex").toUpperCase()}`;
    const second = await runTurn(
      rpc,
      threadId,
      `请证明你保留了上一轮上下文：不要调用工具，只回复上一轮标记，再空格回复 ${secondMarker}。`,
      120_000,
    );
    assert.match(second.text, new RegExp(firstMarker));
    assert.match(second.text, new RegExp(secondMarker));
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    return {
      providerProfile: model.profile,
      provider: model.provider,
      model: model.model,
      threadId,
      firstTurnDurationMs: first.durationMs,
      secondTurnDurationMs: second.durationMs,
      firstBehaviorInvariant: "response contained requested unique marker",
      secondBehaviorInvariant:
        "response recalled prior marker and contained current marker",
    };
  },
);

async function runTurn(rpc, threadId, prompt, timeoutMs) {
  const startedAt = Date.now();
  const response = await rpc.request(
    "turn/start",
    {
      threadId,
      input: [{ type: "text", text: prompt }],
    },
    30_000,
  );
  const turnId = response.turn.id;
  const completed = await rpc.waitFor(
    (message) =>
      message.method === "turn/completed" && message.params?.turnId === turnId,
    timeoutMs,
    `real-model turn ${turnId}`,
  );
  const text = rpc
    .messages()
    .filter(
      (message) =>
        message.method === "item/delta" && message.params?.turnId === turnId,
    )
    .map((message) => message.params?.delta?.text || "")
    .join("");
  return {
    turnId,
    text,
    status: completed.params?.turn?.status,
    durationMs: Date.now() - startedAt,
  };
}
