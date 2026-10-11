import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startGateway, waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { prepareIsolatedRealModelConfig, realModelPreflight } from "../../harness/real-model.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "real-model-compaction-retains-early-facts",
  tier: "credentialed-integration",
  modelPolicy: "real-model-required",
}, async (context) => {
  const model = await realModelPreflight(process.env.KCODER_E2E_MODEL_PROFILE || "kunlunmeta");
  const { path: workspace } = await materializeWorkspace(context, "minimal", {
    instanceId: "real-model-compaction",
  });
  const { configDir, settingsFile } = await prepareIsolatedRealModelConfig(context, model, {
    summaryMaxTokens: 4096,
  });
  const serversFile = await context.writeStateJson("servers.json", [{
    id: "compaction", label: "Compaction", transport: "local",
    command: model.kcoderBin, workspace, settingsFile, profile: model.profile,
  }]);
  const credentialEnv = Object.fromEntries(model.credentialEnv
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const gateway = await startGateway(context, {
    workspace, serversFile,
    env: {
      KCODER_CONFIG_DIR: configDir, KCODER_TRAINING_MODE: "true",
      KCODER_MAX_TOKENS: "4096", KCODER_MAX_RETRIES: "0",
      KCODER_MAX_DURATION_SECS: "90", ...credentialEnv,
    },
  });
  const token = await waitForGatewayRpcToken(context, gateway);
  const rpc = await openRpc(gatewayRpcUrl(gateway, "compaction", token));
  context.addCleanup("close compaction RPC", () => rpc.close());
  await initializeRpc(rpc, "kcoder-e2e-compaction");
  const { thread } = await rpc.request("thread/start", {});
  // All model-stage waits share one deadline; cleanup is owned by RunContext.
  const startedAt = Date.now();
  const deadline = startedAt + 600_000;
  const remaining = () => {
    const ms = deadline - Date.now();
    assert.ok(ms > 0, "compaction model-stage wall budget exhausted");
    return Math.min(ms, 120_000);
  };
  const suffix = randomBytes(6).toString("hex").toUpperCase();
  const project = `PROJECT_${suffix}`;
  const artifact = `report_${suffix}.md`;
  const protectedFile = `keep_${suffix}.db`;
  const prompts = [
    `这是隔离的上下文压缩测试，不要使用工具。请长期记住三个事实：项目代号 ${project}；交付文件 ${artifact}；禁止删除 ${protectedFile}。稍后会问你这些事实。以下是无须保留的重复填充：\n${"无关填充，忽略具体内容。".repeat(1800)}\n只简短确认记住，不要复述事实。`,
    "不要调用工具。继续保留最初的重要事实，只简短确认，不要复述任何事实。",
    "不要调用工具。这轮只回复一个简短确认，不要复述之前的信息。",
    "不要调用工具。这轮也只简短确认，不要复述之前的信息。",
  ];
  const durations = [];
  async function turn(prompt) {
    const start = Date.now();
    const response = await rpc.request("turn/start", {
      threadId: thread.id, input: [{ type: "text", text: prompt }],
    }, remaining());
    const turnId = response.turn.id;
    const completed = await rpc.waitFor(message => message.method === "turn/completed"
      && message.params?.turnId === turnId, remaining(), "compaction test turn");
    assert.equal(completed.params?.turn?.status, "completed");
    durations.push(Date.now() - start);
    return rpc.messages().filter(message => message.method === "item/delta"
      && message.params?.turnId === turnId).map(message => message.params?.delta?.text || "").join("");
  }
  for (const prompt of prompts) {
    const text = await turn(prompt);
    // Retained recent turns must not contain the answers to the recall test.
    assert.ok(!text.includes(suffix), "seed answer echoed facts into the retained tail");
  }
  const compact = await rpc.request("thread/compact", { threadId: thread.id }, remaining());
  assert.equal(compact.compacted, true, "manual compaction must actually replace the old prefix");
  assert.ok(compact.postTokens < compact.preTokens, "compaction must reduce context tokens");
  const records = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && entry.name === `${thread.id}.jsonl`) {
        records.push(...(await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line)));
      }
    }
  }
  // Only inspect this run's synthetic history, never the linked credential store.
  await collect(join(configDir, "projects"));
  const boundary = records.findLast(record => record.subtype === "compact_boundary");
  const segment = boundary?.compactMetadata?.preservedSegment;
  assert.ok(segment, "persisted compaction must identify the actual preserved segment");
  const head = records.findIndex(record => record.uuid === segment.headUuid);
  const tail = records.findIndex(record => record.uuid === segment.tailUuid);
  assert.ok(head >= 0 && tail >= head, "preserved segment must resolve to history records");
  assert.ok(!JSON.stringify(records.slice(head, tail + 1)).includes(suffix),
    "early facts must not survive through verbatim tail retention");
  const recalled = await turn("不要调用工具。请回忆最初的项目代号、交付文件名，以及禁止删除的文件名。准确列出这三个值，并说明最后一个文件是否允许删除。");
  for (const fact of [project, artifact, protectedFile]) {
    assert.ok(recalled.includes(fact), "an early fact was not retained after compaction");
  }
  assert.match(recalled, /禁止删除|不允许删除|不可删除|不能删除|不得删除/);
  return {
    providerProfile: model.profile, model: model.model,
    foregroundTurns: 5, manualCompactionOperations: 1, configuredOutputTokenLimit: 4096,
    preTokens: compact.preTokens, postTokens: compact.postTokens,
    durationMs: Date.now() - startedAt, turnDurationMs: durations,
    invariant: "three early unique facts and the no-delete constraint survived actual compaction",
    scope: "synthetic manual-compaction retention; not a general quality or prefire-cost verdict",
  };
});
