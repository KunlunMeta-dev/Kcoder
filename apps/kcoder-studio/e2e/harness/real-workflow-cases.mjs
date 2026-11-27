import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startGateway, waitForGatewayRpcToken } from "./gateway.mjs";
import {
  prepareIsolatedRealModelConfig,
  realModelPreflight,
  selectWorkflowModel,
} from "./real-model.mjs";
import { startLiveModelObserver } from "./live-model-observer.mjs";
import {
  gatewayRpcUrl,
  initializeRpc,
  openRpc,
  isTurnCompletion,
} from "./rpc.mjs";
import { runE2E, waitFor } from "./run-context.mjs";
import { materializeWorkspace } from "./workspace-fixture.mjs";

export async function runRealWorkflowCases(sourceUrl, spec) {
  return runE2E(
    sourceUrl,
    {
      testId: `real-generated-${spec.name}-eight-tasks`,
      tier: spec.tier,
      modelPolicy:
        `${spec.modelPolicy}; model-authored graph; 8 executions, 320 provider requests maximum, 240s/run, 8192 output tokens/request`,
    },
    async (context) => {
      const selection = await selectWorkflowModel(
        context,
        await realModelPreflight(
          process.env.KCODER_E2E_MODEL_PROFILE || "kunlunmeta",
        ),
      );
      const { model, credentialEnv } = selection;
      console.log(
        `live model: ${model.model} (${model.providerConfig.api_format})`,
      );
      const { path: workspace } = await materializeWorkspace(
        context,
        "minimal",
        { instanceId: spec.name },
      );
      const observer = await startLiveModelObserver(
        context,
        model.providerConfig.endpoint,
        320,
      );
      const isolated = await prepareIsolatedRealModelConfig(context, model, {
        env: { ...process.env, ...credentialEnv },
      });
      const base = JSON.parse(await readFile(isolated.settingsFile, "utf8"));
      const settingsFile = await context.writeStateJson(
        "task-settings.json",
        {
          ...base,
          tools: { profile: "full", disabled: [] },
          permission_mode: "bypass",
          max_retries: 1,
          max_duration_secs: 300,
          providers: {
            [model.provider]: {
              ...model.providerConfig,
              endpoint: observer.endpoint,
              no_proxy: true,
              max_output_tokens: 8192,
              reasoning_effort: null,
              models: {
                [model.model]: {
                  ...model.providerConfig.models?.[model.model],
                  context_window_tokens:
                    model.providerConfig.context_window_tokens,
                  output_headroom_tokens: 8192,
                  max_output_tokens: 8192,
                  reasoning_effort: null,
                },
              },
            },
          },
        },
        0o400,
      );
      const serversFile = await context.writeStateJson("servers.json", [
        {
          id: "live",
          label: "Live",
          transport: "local",
          command: model.kcoderBin,
          workspace,
          settingsFile,
          profile: model.profile,
        },
      ]);
      const gateway = await startGateway(context, {
        workspace,
        serversFile,
        env: {
          KCODER_CONFIG_DIR: isolated.configDir,
          KCODER_TRAINING_MODE: "true",
          KCODER_MAX_TOKENS: "8192",
          KCODER_MAX_RETRIES: "1",
          KCODER_MAX_DURATION_SECS: "300",
          ...credentialEnv,
        },
      });
      const token = await waitForGatewayRpcToken(context, gateway);
      const rpc = await openRpc(gatewayRpcUrl(gateway, "live", token));
      context.addCleanup("close real task RPC", () => rpc.close());
      await initializeRpc(rpc, "real-workflow-tasks");
      const evidence = (threadId) =>
        rpc
          .messages()
          .filter(
            (message) =>
              message.params?.threadId === threadId &&
              ["item/started", "item/completed", "item/event"].includes(
                message.method,
              ),
          );
      const start = async (threadId, text) =>
        (
          await rpc.request("turn/start", {
            threadId,
            input: [{ type: "text", text }],
          })
        ).turn.id;
      const finish = async (threadId, turnId, timeout = 310000) => {
        const done = await rpc.waitFor(
          (message) => isTurnCompletion(message, threadId, turnId),
          timeout,
          "real task turn",
        );
        if (done.params?.turn?.status !== "completed")
          await context.writeArtifactJson(`failed-${threadId}.json`, {
            events: evidence(threadId),
          });
        assert.equal(done.params?.turn?.status, "completed");
      };
      try {
        const cases = await spec.prepare(context, workspace);
        const source = process.env.KCODER_E2E_WORKFLOW_SOURCE;
        const draft = source
          ? await rpc.request("workflow/import", {
              definition: JSON.parse(await readFile(source, "utf8")),
            })
          : await rpc.request("workflow/create", {
              title: `Generated ${spec.name} acceptance`,
            });
        const design = await rpc.request("thread/start", {
          sessionMode: "workflow_draft",
          workflowDefinitionId: draft.id,
        });
        console.log(`phase: generate ${spec.name}`);
        if (source && process.env.KCODER_E2E_WORKFLOW_REUSE_GENERATED === "1") {
          const provenance = JSON.parse(
            await readFile(resolve(source, "../../manifest.json"), "utf8"),
          );
          assert.equal(
            provenance.testId,
            `real-generated-${spec.name}-eight-tasks`,
          );
          assert.match(provenance.modelPolicy, /real-model-required/);
          await rpc.request("workflow/save", {
            id: draft.id,
            expectedRevision: draft.revision,
          });
        } else {
          await finish(
            design.thread.id,
            await start(
              design.thread.id,
              `${source ? "仅修订当前导入的工作流，使用 patch_nodes 局部更新字段，保留未修改的 runIf、dependsOn、config 等，禁止用 upsert_node 重建既有节点。" : "创建当前绑定工作流，逐个 upsert_node 生成。"}最后 read 自查并 save，不执行，不新建副本。使用稳定 ID；${spec.deterministic ? "纯计算和文件 I/O 使用确定性节点，不配置 Agent 的 validationRetries。" : "Agent maxTurns=12、outputSchema 必须精确且 validationRetries=1。"}Merge 输出按依赖 ID 嵌套，Loop outputSchema 只校验每次迭代。输入 mode 为任意 string，不能加 enum，否则默认分支无法测试。所有路径相对本会话工作目录，由 args 提供；Agent 不得启动其他子代理、网络请求或修改测试文件。计算请用只读 Python 命令核实。${source ? spec.repair : ""} 上一轮若有低预算失败，所有 Agent maxTurns 必须设置为12（不是6），后续约束中的6以这里12为准。实际上下文是 {input:用户参数对象,nodes:直接依赖结果}，不存在 input.args 包装。输入参数示例为 ${JSON.stringify(cases[0].args)}，inputSchema 顶层 required 必须包含这些字段，不应出现 args 字段。按 /input/mode 路由。${spec.prompt}`,
            ),
          );
        }
        const definition = await rpc.request("workflow/read", { id: draft.id });
        await context.writeArtifactJson(
          "generated-definition.json",
          definition,
        );
        assert.equal(definition.status, "saved");
        for (const id of spec.nodeIds)
          assert.ok(
            definition.nodes.some((node) => node.id === id),
            `missing node ${id}`,
          );
        if (spec.validateDefinition) await spec.validateDefinition(definition);
        const immutable = await rpc.request("workflow/export", {
          id: draft.id,
          version: definition.savedVersion,
        });
        const receipts = [];
        const losslessArgs = process.env.KCODER_E2E_WORKFLOW_LOSSLESS_ARGS === "1";
        for (const sample of cases) {
          console.log(`phase: ${spec.name}/${sample.name}`);
          const thread = await rpc.request("thread/start", {});
          const parameters = {
            definition_id: draft.id,
            version: definition.savedVersion,
            ...(losslessArgs ? { args_json: JSON.stringify(sample.args) } : { args: sample.args }),
            max_concurrency: 2,
            max_agent_turns: 12,
            timeout_seconds: 240,
          };
          const turnId = await start(
            thread.thread.id,
            `只启动一次已保存工作流的运行。若调用在创建 runId 前被参数校验拒绝，可以修正参数重试；收到 runId 后禁止另开运行。使用 Workflow，参数是：${JSON.stringify(parameters)}。${losslessArgs ? "args_json 是包含完整输入对象的 JSON 文本，保持为字符串，不要添加 args 或把业务字段移到顶层。" : "args 是原生 JSON 对象，不要编码成字符串。"}不要修改流程，不要自行执行其中任务、不要另写结果文件。等真实运行结果，失败就报告，不自动重跑。完成后只用一句话报告状态，不必额外分析或调用工具。`,
          );
          let run;
          try {
            run = await waitFor(
              async () => {
                const list = await rpc.request("workflow/runs/list", {
                  definitionId: draft.id,
                  limit: 32,
                });
                const found = list.items.find(
                  (item) => item.threadId === thread.thread.id,
                );
                if (
                  !found &&
                  rpc
                    .messages()
                    .some((message) =>
                      isTurnCompletion(message, thread.thread.id, turnId),
                    )
                )
                  throw Error("Turn ended without workflow run");
                return found;
              },
              90000,
              "task run receipt",
              500,
            );
            run = await waitFor(
              async () => {
                const item = await rpc.request("workflow/runs/read", {
                  runId: run.runId,
                });
                return ["completed", "failed", "cancelled"].includes(
                  item.status,
                )
                  ? item
                  : null;
              },
              250000,
              "task run completion",
              1000,
            );
            await context.writeArtifactJson(`run-${sample.name}.json`, run);
            assert.equal(run.status, "completed", run.error || sample.name);
            await spec.verify(context, workspace, sample, run);
            await finish(thread.thread.id, turnId, 210000);
            assert.deepEqual(
              await rpc.request("workflow/export", {
                id: draft.id,
                version: definition.savedVersion,
              }),
              immutable,
            );
            assert.equal(
              (await rpc.request("workflow/read", { id: draft.id })).revision,
              definition.revision,
            );
            receipts.push({
              case: sample.name,
              runId: run.runId,
              durationMs: run.updatedAtMs - run.startedAtMs,
              verified: true,
            });
            console.log(`passed: ${spec.name}/${sample.name}`);
          } catch (error) {
            await context.writeArtifactJson(`failure-${sample.name}.json`, {
              error: String(error),
              events: evidence(thread.thread.id),
            });
            receipts.push({
              case: sample.name,
              runId: run?.runId ?? null,
              verified: false,
              status: run?.status ?? "not_started",
              error: String(error),
            });
            console.log(`failed: ${spec.name}/${sample.name}`);
            await rpc
              .request("turn/interrupt", { threadId: thread.thread.id, turnId })
              .catch(() => {});
            await rpc
              .waitFor(
                (message) =>
                  isTurnCompletion(message, thread.thread.id, turnId),
                20000,
                "interrupted failed case",
              )
              .catch(() => {});
          }
        }
        await context.writeArtifactJson("acceptance.json", {
          provider: model.provider,
          model: model.model,
          definitionId: draft.id,
          version: definition.savedVersion,
          argumentEncoding: losslessArgs ? "args_json" : "args",
          receipts,
        });
        assert.equal(
          receipts.filter((receipt) => !receipt.verified).length,
          0,
          "Some actual workflow task cases failed; see acceptance.json",
        );
        return { family: spec.name, cases: receipts.length, receipts };
      } finally {
        await context.writeArtifactJson(
          "transport.json",
          observer.observations,
        );
      }
    },
  );
}
