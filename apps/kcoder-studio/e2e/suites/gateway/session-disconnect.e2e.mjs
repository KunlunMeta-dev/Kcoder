import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { repoRoot, requireExecutable, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(
  import.meta.url,
  {
    testId: "gateway-session-resume-after-transport-end",
    tier: "pr-smoke",
    modelPolicy: "model-independent deterministic connection lifecycle check",
  },
  async (context) => {
    const kcoderBin = await requireExecutable(
      process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
      "KCoder app-server",
    );
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "session-disconnect",
    });
    const configDir = context.pathInState("config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await context.writeStateJson("config/settings.json", {});
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Local",
        transport: "local",
        command: kcoderBin,
        workspace,
      },
    ]);
    const gateway = await startGateway(context, {
      kcoderBin,
      workspace,
      serversFile,
      env: {
        KCODER_CONFIG_DIR: configDir,
        KCODER_STUDIO_SCENARIO: "full-turn",
      },
    });
    const token = await waitForGatewayRpcToken(context, gateway);

    const first = await openRpc(gatewayRpcUrl(gateway, "local", token));
    context.addCleanup("close first RPC", () => first.close());
    await initializeRpc(first, "kcoder-e2e-session-owner");
    const started = await first.request("thread/start", {});
    const threadId = started.thread.id;
    const turn = await first.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "deterministic persistence probe" }],
    });
    await first.waitFor(
      (message) =>
        message.method === "turn/completed" &&
        message.params?.turnId === turn.turn.id,
      20_000,
      "deterministic turn completion",
    );

    // Simulate refresh, sleep, or network switching that closes TCP before a WebSocket close frame can be sent.
    first.socket.endTransportWithoutCloseFrame();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));

    const resumed = await openRpc(gatewayRpcUrl(gateway, "local", token));
    context.addCleanup("close resumed RPC", () => resumed.close());
    await initializeRpc(resumed, "kcoder-e2e-session-resumer");
    const result = await resumed.request("thread/resume", { threadId });
    assert.equal(result.thread.id, threadId);

    // Stop the owned process tree and flush its redacted log before success cleanup removes logs.
    resumed.close();
    await context.stopOwned("gateway");
    const summaries = (await readFile(gateway.logPath, "utf8"))
      .split("\n")
      .filter(line => line.startsWith('{"event":"broker-lifecycle",'))
      .map(line => JSON.parse(line));
    assert.equal(summaries.length, 1, "one real broker must emit exactly one final summary");
    const { event, transport, ...metrics } = summaries[0];
    assert.equal(event, "broker-lifecycle");
    assert.equal(transport, "local");
    assert.ok(Object.values(metrics).every(value => value === null || (Number.isFinite(value) && value >= 0)));
    assert.ok(Number.isFinite(metrics.initializeMs));
    assert.equal(metrics.initializeFailureCount, 0);
    assert.equal(metrics.attachCount, 2);
    assert.equal(metrics.reuseCount, 1, "the second client must reuse the initialized broker");
    assert.ok(metrics.clientFreeMsSum > 0);
    assert.equal(metrics.clientFreeMsMax, metrics.clientFreeMsSum);
    assert.equal(metrics.resumeStartedCount, 1);
    assert.equal(metrics.resumeSuccessCount, 1);
    assert.ok(Number.isFinite(metrics.resumeSuccessMsSum));
    assert.equal(metrics.resumeSuccessMsMax, metrics.resumeSuccessMsSum);
    assert.equal(metrics.resumeErrorCount, 0);
    assert.equal(metrics.resumeAbandonedCount, 0);
    assert.equal(metrics.closedCount, 1);
    assert.equal(metrics.brokerCount, 0);
    assert.ok(metrics.lifetimeMs >= metrics.initializeMs);
    await context.writeArtifactJson("broker-lifecycle-metrics.json", metrics);
    return metrics;
  },
);
