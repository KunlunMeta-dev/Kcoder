import { startLiveModelObserver } from "../../harness/live-model-observer.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import {
  prepareIsolatedRealModelConfig,
  realModelPreflight,
  selectWorkflowModel,
} from "../../harness/real-model.mjs";
import {
  gatewayRpcUrl,
  initializeRpc,
  openRpc,
  isTurnCompletion,
} from "../../harness/rpc.mjs";
import { runE2E, waitFor } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

// A real model authors the graph and every Agent node executes against that model.
// Assertions inspect arithmetic, files, routing and persisted run receipts, not prose claims.
await runE2E(
  import.meta.url,
  {
    testId: "real-generated-workflow-stability-and-artifact-acceptance",
    tier: "credentialed-integration",
    modelPolicy:
      "real-model-required; 1 design turn or an unchanged real-generated artifact + 8 execution cases; max 12 turns per agent, 240s/run, 8192 output tokens/request",
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
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "workflow-stability",
    });
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
      "workflow-settings.json",
      {
        ...base,
        tools: { profile: "full", disabled: [] },
        permission_mode: "bypass",
        max_retries: 1,
        max_duration_secs: 240,
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
        label: "Live model",
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
        KCODER_MAX_DURATION_SECS: "240",
        ...credentialEnv,
      },
    });
    const token = await waitForGatewayRpcToken(context, gateway);
    const rpc = await openRpc(gatewayRpcUrl(gateway, "live", token));
    context.addCleanup("close workflow stability RPC", () => rpc.close());
    await initializeRpc(rpc, "workflow-stability");
    const startTurn = async (threadId, text) =>
      (
        await rpc.request("turn/start", {
          threadId,
          input: [{ type: "text", text }],
        })
      ).turn.id;
    const finishTurn = async (threadId, turnId, timeout = 250000) => {
      const completed = await rpc.waitFor(
        (message) => isTurnCompletion(message, threadId, turnId),
        timeout,
        "live workflow turn",
      );
      if (completed.params?.turn?.status !== "completed")
        await context.writeArtifactJson(
          `failed-turn-${threadId}-${turnId}.json`,
          {
            turn: completed.params?.turn,
            transport: observer.observations,
            events: rpc
              .messages()
              .filter(
                (message) =>
                  message.params?.threadId === threadId &&
                  message.params?.turnId === turnId &&
                  ["item/started", "item/completed", "item/event"].includes(
                    message.method,
                  ),
              ),
          },
        );
      assert.equal(completed.params?.turn?.status, "completed");
    };
    const repairSource = process.env.KCODER_E2E_WORKFLOW_REPAIR_SOURCE;
    const created = repairSource
      ? await rpc.request("workflow/import", {
          definition: JSON.parse(await readFile(repairSource, "utf8")),
        })
      : await rpc.request("workflow/create", {
          title: "Generated order acceptance workflow",
        });
    const design = await rpc.request("thread/start", {
      sessionMode: "workflow_draft",
      workflowDefinitionId: created.id,
    });
    const prompt = `设计并保存当前绑定的工作流，不执行。下面是验收约束，请自行生成完整节点配置和提示词，使用 WorkflowDraft，最后 save。节点 ID 必须遵守下列约定，以便独立验证路由。不要创造工作流副本。所有 Agent/Loop maxTurns=12，config.outputSchema 声明精确 JSON 输出并 validationRetries=1。计算和校验节点可以使用只读计算命令验证数值，禁止写文件和调用额外子代理；不要依赖未经验证的口算。
输入 args: lines 是 {qty,price} 数组，mode 是 priority/standard/其他字符串，review 是布尔，checks 是两个字符串，output_file 是本工作目录内的相对 JSON 文件名。
1. pricing Agent 无依赖，计算 sum(qty*price)，仅返回 {subtotal:number}；units Agent 无依赖，计算 sum(qty)，仅返回 {units:number}。二者独立并行。
2. base_join 是 merge all，依赖 pricing,units。
3. router 是 switch，依赖 base_join，按 /input/mode 匹配 priority、standard，default=manual。
4. review_gate 是 condition，依赖 router，runIf router 的 priority；判断 /input/review equals true。
5. reviewed Agent 依赖 review_gate，guard=true，返回 {route:"priority_reviewed"}；simple Agent 依赖 review_gate，guard=false，返回 {route:"priority_simple"}。
6. standard Agent 依赖 router、guard="standard"，返回 {route:"standard"}；manual Agent 依赖 router、guard="manual"，返回 {route:"manual"}。
7. branch_join merge any，依赖 reviewed,simple,standard,manual。
8. checks 是 loop，依赖 base_join,branch_join，mode=for_each，collectionPointer=/input/checks，maxIterations=2。循环 Agent 读取当前 iteration.index 和 item。index=0 从原始 lines 独立重算金额并与 /nodes/base_join/pricing/subtotal 比较；index=1 独立重算数量和 /nodes/base_join/units/units 比较。仅返回 {index:整数,ok:布尔}，不一致必须 false，不能无条件 true；可用只读计算命令，禁止写文件。outputSchema 是单次迭代对象 schema，不是整个循环数组。
9. publish Agent 依赖 pricing,units,branch_join,checks；它从依赖真实输出汇总 subtotal、units、route，tax=subtotal*0.1，total=subtotal+tax，checks 必须取循环输出 count，且与 iterations 数组长度一致。用 write 工具把恰好 {subtotal,units,tax,total,route,checks} 六个字段的 JSON 写入 args.output_file，随后只返回同一 JSON。不得重新执行工作流或创建子代理。允许写本目录的结果文件。outputSchema 声明上述六字段。
10. output 是 output 节点，依赖 publish，pointer=/nodes/publish。
共 13 个节点。为每个节点给出合理位置。确保 switch 命名路由、布尔条件、跳过传递和汇合配置正确；创建阶段必须逐个 upsert，每次只提交一个节点，禁止一次 patch 全图，最终读取检查并 save。`;
    console.log("phase: authoring real workflow");
    const repair = repairSource
      ? "这是之前真实模型生成但执行失败的草稿，请保留节点 ID 并修订后保存。失败证据：数量节点把 sum(qty) 算成了行数；checks 把每次迭代 schema 错写成数组，导致 schema 校验失败；publish 把 Merge 当成扁平 route，把 Loop 当成数组。请修正：pricing/units 必须用一个只读计算命令验证算术，输出 schema 仍是对象；Loop 每次 schema 为 {index:integer,ok:boolean} 且 validationRetries=1；Loop 聚合实际是 {iterations,count,exitReason}；Merge 按源节点 ID 嵌套，如 branch_join.reviewed.route。publish 根据实际依赖结构取值，若检查失败不得写成功报告。彻底重写 pricing、units、checks 的 prompt，删除全部命令示例，不保留任何原来的 shell 代码块。只描述算法与数据来源，允许执行者选择合适的只读计算命令。不要把脚本和 JSON 数据都放到 stdin；禁止建议 python3 - heredoc 同时 json.load(sys.stdin)，这是错误的。所有 Agent/Loop maxTurns=12，避免上次4轮不足。只修改草稿，不执行。以下为完整验收要求：\n"
      : "";
    if (
      repairSource &&
      process.env.KCODER_E2E_WORKFLOW_REUSE_GENERATED === "1"
    ) {
      const provenance = JSON.parse(
        await readFile(resolve(repairSource, "../../manifest.json"), "utf8"),
      );
      assert.equal(
        provenance.testId,
        "real-generated-workflow-stability-and-artifact-acceptance",
      );
      assert.match(provenance.modelPolicy, /real-model-required/);
      await rpc.request("workflow/save", {
        id: created.id,
        expectedRevision: created.revision,
      });
    } else
      await finishTurn(
        design.thread.id,
        await startTurn(design.thread.id, repair + prompt),
      );
    const definition = await rpc.request("workflow/read", { id: created.id });
    await context.writeArtifactJson("generated-definition.json", definition);
    assert.equal(definition.status, "saved");
    assert.equal(definition.nodes.length, 13);
    for (const id of [
      "pricing",
      "units",
      "base_join",
      "router",
      "review_gate",
      "reviewed",
      "simple",
      "standard",
      "manual",
      "branch_join",
      "checks",
      "publish",
      "output",
    ])
      assert.ok(
        definition.nodes.some((node) => node.id === id),
        id,
      );
    assert.equal(
      definition.nodes.find((n) => n.id === "router")?.kind,
      "switch",
    );
    const published = await rpc.request("workflow/export", {
      id: created.id,
      version: definition.savedVersion,
    });
    const matrix = [
      {
        name: "priority-reviewed",
        mode: "priority",
        review: true,
        route: "priority_reviewed",
        active: "reviewed",
      },
      {
        name: "priority-simple",
        mode: "priority",
        review: false,
        route: "priority_simple",
        active: "simple",
      },
      {
        name: "standard",
        mode: "standard",
        review: true,
        route: "standard",
        active: "standard",
      },
      {
        name: "fallback",
        mode: "unlisted",
        review: false,
        route: "manual",
        active: "manual",
      },
    ];
    matrix.push(
      ...matrix.map((sample) => ({ ...sample, name: sample.name + "-repeat" })),
    );
    const receipts = [];
    for (const sample of matrix) {
      console.log(`phase: execute ${sample.name}`);
      const lines = sample.name.startsWith("standard")
        ? [
            { qty: 4, price: 25 },
            { qty: 2, price: 50 },
          ]
        : sample.name.startsWith("fallback")
          ? [
              { qty: 1, price: 80 },
              { qty: 2, price: 10 },
            ]
          : [
              { qty: 2, price: 100 },
              { qty: 3, price: 20 },
            ];
      const args = {
        lines,
        mode: sample.mode,
        review: sample.review,
        checks: ["arithmetic", "format"],
        output_file: `result-${sample.name}.json`,
      };
      const thread = await rpc.request("thread/start", {});
      const input = {
        definition_id: definition.id,
        version: definition.savedVersion,
        args,
        max_concurrency: 2,
        max_agent_turns: 12,
        timeout_seconds: 240,
      };
      const turnId = await startTurn(
        thread.thread.id,
        `调用一次 Workflow 工具执行以下已保存工作流，传入args 必须是原生JSON对象，完整保留所有字段尤其 output_file，参数完全如下：${JSON.stringify(input)}。不要重新创建或修改流程，不要自行计算或写最终文件，不创建额外子代理。等待后台运行结果；失败则报告，不要自动重试整个流程。完成后只用一句话报告状态，不必额外分析或调用工具。`,
      );
      let run;
      try {
        run = await waitFor(
          async () => {
            const list = await rpc.request("workflow/runs/list", {
              definitionId: definition.id,
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
              throw Error(
                "Execution request ended without creating a workflow run",
              );
            return found;
          },
          60000,
          `run receipt ${sample.name}`,
          500,
        );
        run = await waitFor(
          async () => {
            const current = await rpc.request("workflow/runs/read", {
              runId: run.runId,
            });
            return ["completed", "failed", "cancelled"].includes(current.status)
              ? current
              : null;
          },
          250000,
          `terminal workflow ${sample.name}`,
          1000,
        );
        await context.writeArtifactJson(`run-${sample.name}.json`, run);
        assert.equal(run.status, "completed", run.error ?? sample.name);
        const states = new Map(
          run.nodeStates.map((node) => [node.nodeId, node]),
        );
        for (const id of ["reviewed", "simple", "standard", "manual"])
          assert.equal(
            states.get(id)?.status,
            id === sample.active ? "completed" : "skipped",
            `${sample.name}/${id}`,
          );
        assert.equal(states.get("checks")?.status, "completed");
        assert.equal(states.get("output")?.status, "completed");
        const subtotal = lines.reduce(
            (sum, line) => sum + line.qty * line.price,
            0,
          ),
          units = lines.reduce((sum, line) => sum + line.qty, 0);
        const expected = {
          subtotal,
          units,
          tax: subtotal / 10,
          total: subtotal + subtotal / 10,
          route: sample.route,
          checks: 2,
        };
        const loopPage = await rpc.request("workflow/runs/output", {
          runId: run.runId,
          nodeId: "checks",
          offset: 0,
          limit: 16384,
        });
        const loopOutput = JSON.parse(loopPage.text);
        assert.equal(loopOutput.count, 2);
        assert.deepEqual(loopOutput.iterations, [
          { index: 0, ok: true },
          { index: 1, ok: true },
        ]);
        const pricing = states.get("pricing"),
          quantities = states.get("units");
        assert.ok(
          pricing.startedAtMs < quantities.finishedAtMs &&
            quantities.startedAtMs < pricing.finishedAtMs,
          "parallel nodes must overlap",
        );
        for (const id of ["reviewed", "simple", "standard", "manual"].filter(
          (id) => id !== sample.active,
        ))
          assert.equal(states.get(id).startedAtMs, null);
        const artifact = JSON.parse(
          await readFile(resolve(workspace, args.output_file), "utf8"),
        );
        assert.deepEqual(artifact, expected);
        await context.writeArtifactJson(
          `artifact-${sample.name}.json`,
          artifact,
        );
        await finishTurn(thread.thread.id, turnId, 210000);
        const immutable = await rpc.request("workflow/export", {
          id: definition.id,
          version: definition.savedVersion,
        });
        assert.deepEqual(immutable, published);
        receipts.push({
          case: sample.name,
          runId: run.runId,
          durationMs: run.updatedAtMs - run.startedAtMs,
          artifact: true,
          branch: true,
        });
        console.log(`passed: ${sample.name}`);
      } catch (error) {
        const list = await rpc
          .request("workflow/runs/list", {
            definitionId: definition.id,
            limit: 32,
          })
          .catch(() => null);
        await context.writeArtifactJson(`failure-${sample.name}.json`, {
          runs: list,
          error: String(error),
          transport: observer.observations,
          events: rpc
            .messages()
            .filter(
              (message) =>
                message.params?.threadId === thread.thread.id &&
                ["item/started", "item/completed", "item/event"].includes(
                  message.method,
                ),
            ),
        });
        receipts.push({
          case: sample.name,
          runId: run?.runId ?? null,
          artifact: false,
          error: String(error),
        });
        console.log(`failed: ${sample.name}`);
        await rpc
          .request("turn/interrupt", { threadId: thread.thread.id, turnId })
          .catch(() => {});
        await rpc
          .waitFor(
            (message) => isTurnCompletion(message, thread.thread.id, turnId),
            20000,
            "interrupted order case",
          )
          .catch(() => {});
      }
    }
    await context.writeArtifactJson("acceptance.json", {
      provider: model.provider,
      model: model.model,
      version: definition.savedVersion,
      receipts,
    });
    await context.writeArtifactJson("transport.json", observer.observations);
    assert.equal(
      receipts.filter((receipt) => !receipt.artifact).length,
      0,
      "Some actual order cases failed; see acceptance.json",
    );
    return {
      generatedByRealModel: true,
      executedByRealModel: true,
      cases: receipts.length,
      receipts,
    };
  },
);
