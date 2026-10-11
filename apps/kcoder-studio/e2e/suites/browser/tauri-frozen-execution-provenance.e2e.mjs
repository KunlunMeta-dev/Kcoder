import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startOwnedAiVerify } from "../../harness/ai-verify-client.mjs";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { startWorkflowModelFixture } from "../../harness/workflow-model.mjs";
import { startWikiModelFixture } from "../../harness/wiki-model.mjs";
import {
  appRoot,
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";

// Fixed local HTTP replies exercise real Engine/Tool/Agent and worker execution.
// Assertions concern frozen provenance and native rendering, never model quality.
const executionScope = process.env.KCODER_E2E_PROVENANCE_SCOPE || "all";
assert.ok(
  ["all", "wiki"].includes(executionScope),
  "Provenance scope must be all or wiki",
);
await runE2E(
  import.meta.url,
  {
    testId: "native-frozen-execution-provenance",
    tier: "manual-live",
    executionScope,
    modelPolicy:
      "model-independent: actual Workflow Tool/Agent and Wiki worker frozen summaries with deterministic loopback HTTP; no model-quality claim",
    prerequisites:
      "Linux owned Xvfb Tauri shell, fresh renderer, explicit frozen CLI binary and SHA-256",
    budgets: {
      workflowProviderRequests: executionScope === "wiki" ? 0 : 12,
      wikiProviderRequests: 2,
      outputTokensPerRequest: 4096,
      wallClockMs: 180000,
    },
    retainSuccessEvidence: true,
  },
  async (context) => {
    context.abortSignal = AbortSignal.any([
      context.abortSignal,
      AbortSignal.timeout(180000),
    ]);
    const build = await assertRendererBuildFresh();
    const binary = process.env.KCODER_E2E_KCODER_BIN;
    const expectedSha = process.env.KCODER_E2E_KCODER_SHA256;
    assert.ok(
      binary && /^[a-f0-9]{64}$/.test(expectedSha ?? ""),
      "Explicit frozen CLI path and SHA-256 required",
    );
    const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      sha256(await readFile(binary)),
      expectedSha,
      "CLI identity must match frozen build",
    );
    const tauriBin =
      process.env.KCODER_E2E_TAURI_BIN ||
      resolve(repoRoot, "target/split-tauri-native/debug/app");
    const rendererIndex = await readFile(
      resolve(appRoot, "renderer/dist/index.html"),
    );
    const rendererAsset = rendererIndex
      .toString()
      .match(/src="\/assets\/(index-[^"/]+\.js)"/)?.[1];
    assert.ok(rendererAsset, "Renderer entry asset identity is required");
    await context.writeArtifactJson("build-identity.json", {
      cliSha256: expectedSha,
      tauriSha256: sha256(await readFile(tauriBin)),
      rendererIndexSha256: sha256(rendererIndex),
      rendererAsset,
      rendererAssetSha256: sha256(
        await readFile(resolve(appRoot, "renderer/dist/assets", rendererAsset)),
      ),
      ...build,
      sourceRevision: process.env.KCODER_E2E_SOURCE_REVISION ?? null,
    });
    const client = await startOwnedAiVerify(context, {
      tauriBin,
      kcoderBin: binary,
      rendererRoot: resolve(appRoot, "renderer/dist"),
    });
    const profile = dirname(client.settingsPath),
      workspace = resolve(profile, "../workspaces/tauri-verification");
    const command = (action, id, args = {}) =>
      client.command(action, { selector: `[data-testid="${id}"]`, ...args });
    let wikiReleased = false;
    context.addCleanup("release provenance Wiki gate", () => {
      wikiReleased = true;
    });
    const writeSettings = (endpoint, modelId, toolProfile = "full") =>
      writeFile(
        client.settingsPath,
        JSON.stringify({
          active_provider: "provenance-fixture",
          permission_mode: "bypass",
          max_retries: 0,
          tools: { profile: toolProfile },
          knowledge: { enabled: true },
          providers: {
            "provenance-fixture": {
              api_format: "openai_chat_completions",
              authentication: { mode: "none" },
              endpoint,
              default_model: modelId,
              context_window_tokens: 128000,
              max_output_tokens: 4096,
              output_headroom_tokens: 4096,
              no_proxy: true,
            },
          },
        }),
        { mode: 0o600 },
      );
    const assertSafe = (value) => {
      const text = JSON.stringify(value);
      assert.ok(
        !/https?:\/\/|apiKey|credentials|file_path|\/workspaces\//.test(text),
        "Public summary must omit private configuration",
      );
      assert.ok(
        !Object.hasOwn(value, "endpoint"),
        "Endpoint values are private",
      );
      const authorities = new Set([
        "default",
        "user",
        "executable",
        "project",
        "local",
        "overlay",
        "cli_environment",
        "environment",
        "turn",
        "session_snapshot",
      ]);
      assert.ok(
        Object.values(value.sources).every(
          (labels) =>
            Array.isArray(labels) &&
            labels.every((label) => authorities.has(label)),
        ),
        "Source entries may contain only finite authority labels, including the endpoint source",
      );
    };
    try {
      await command("waitFor", "desktop-sidebar");
      const workflowModel =
        executionScope === "all"
          ? await startWorkflowModelFixture(context)
          : null;
      await writeSettings(
        workflowModel?.baseUrl || "http://127.0.0.1:1/v1",
        "native-provenance",
      );
      const gateway = await startGateway(context, {
        label: "provenance-gateway",
        workspace,
        kcoderBin: binary,
        env: { KCODER_CONFIG_DIR: profile },
      });
      const rpc = await openRpc(
        gatewayRpcUrl(
          gateway,
          "local",
          await waitForGatewayRpcToken(context, gateway),
        ),
      );
      context.addCleanup("close provenance RPC", () => rpc.close());
      await initializeRpc(rpc, "native-frozen-provenance");
      if (workflowModel) {
        let graph = await rpc.request("workflow/create", {
          title: "Frozen execution provenance",
        });
        for (const node of [
          {
            id: "A",
            title: "Actual explorer",
            kind: "agent",
            agentType: "explore",
            prompt: "WF_NODE_A_WORK: Return the controlled fixture result.",
            maxTurns: 1,
            dependsOn: [],
            config: {
              resultCheck: {
                source:
                  "return typeof result === 'string' && result.includes('WF_NODE_A_RESULT');",
              },
            },
          },
          {
            id: "guard",
            title: "Attempt guard",
            kind: "code",
            dependsOn: ["A"],
            config: {
              code: {
                source:
                  "if (!input.retry) throw new Error('controlled retry required'); return true;",
              },
              resultCheck: { source: "return result === true;" },
            },
          },
        ])
          graph = await rpc.request("workflow/upsertNode", {
            id: graph.id,
            expectedRevision: graph.revision,
            node,
          });
        graph = await rpc.request("workflow/save", {
          id: graph.id,
          expectedRevision: graph.revision,
        });
        const send = async (input) => {
          await command("fill", "chat-message-input", {
            value: `Run saved workflow ${JSON.stringify(input)}`,
          });
          await command("waitFor", "send-message-button", { enabled: true });
          await command("click", "send-message-button");
        };
        await client.command("navigate", { value: "/" });
        await send({
          definition_id: graph.id,
          version: 1,
          args: { retry: false },
        });
        const runId = await waitFor(
          () =>
            workflowModel.observations.find(
              (item) => item.kind === "run-reference",
            )?.runId,
          15000,
          "actual Workflow tool run reference",
        );
        await waitFor(
          async () =>
            (await rpc.request("workflow/runs/read", { runId })).status ===
            "failed",
          20000,
          "controlled first attempt guard failure",
        );
        const firstPage = await rpc.request("workflow/verification/read", {
          id: graph.id,
          version: 1,
        });
        const first = firstPage.runs.find((run) => run.runId === runId);
        assert.equal(first.executionStatus, "failed");
        assert.equal(
          first.modelSnapshot.configuration.toolSet.registryScope,
          "session_registry",
        );
        const assertAgent = (run, observation) => {
          const [agent] = run.modelSnapshot.agents;
          assert.equal(run.modelSnapshot.agents.length, 1);
          assert.equal(agent.runId, run.runId);
          assert.equal(
            agent.artifactAttempt,
            run.artifactAttempt ?? run.resumeCount,
          );
          assert.equal(agent.selectionSource, "inherited_session");
          assert.equal(agent.configuration.modelId, observation.modelId);
          assert.equal(agent.configuration.toolSet.profile, "full");
          assert.equal(
            agent.configuration.toolSet.registryScope,
            "session_role",
          );
          assert.ok(
            Number.isInteger(agent.configuration.toolSet.registeredToolCount),
          );
          assert.ok(
            agent.configuration.toolSet.registeredToolCount >=
              observation.exposedToolCount && observation.exposedToolCount > 0,
          );
          assert.equal(agent.configuration.toolSet.exposedToolCount, undefined);
          assert.ok(agent.configuration.sources["tools.profile"].length > 0);
          assertSafe(agent.configuration);
          return agent;
        };
        assertAgent(
          first,
          workflowModel.observations.find((item) => item.kind === "agent"),
        );
        assert.ok(
          first.modelSnapshot.configuration.toolSet.registeredToolCount >
            first.modelSnapshot.agents[0].configuration.toolSet
              .registeredToolCount,
          "Explorer role registry must differ from admission session registry",
        );
        await send({ resume: runId, args: { retry: true } });
        await waitFor(
          async () =>
            (await rpc.request("workflow/runs/read", { runId })).status ===
            "completed",
          20000,
          "actual resumed attempt completion",
        );
        const page = await rpc.request("workflow/verification/read", {
          id: graph.id,
          version: 1,
        });
        const old = page.runs.find(
          (run) =>
            run.runId === runId &&
            run.artifactAttempt === first.artifactAttempt,
        );
        const resumed = page.runs.find(
          (run) =>
            run.runId === runId &&
            run.artifactAttempt !== first.artifactAttempt,
        );
        assert.deepEqual(old.modelSnapshot, first.modelSnapshot);
        const agentObservations = workflowModel.observations.filter(
          (item) => item.kind === "agent",
        );
        assert.equal(agentObservations.length, 2);
        assertAgent(resumed, agentObservations[1]);
        await writeSettings(
          workflowModel.baseUrl,
          "changed-root-model",
          "nano",
        );
        assert.deepEqual(
          (
            await rpc.request("workflow/verification/read", {
              id: graph.id,
              version: 1,
            })
          ).runs,
          page.runs,
        );
        await client.command("navigate", { value: "/workflows" });
        await command("waitFor", `workflow-library-${graph.id}`);
        await command("click", `workflow-library-${graph.id}`);
        await command("waitFor", "workflow-verification");
        await client.command("waitFor", {
          selector:
            '[data-testid="workflow-verification"] > details:first-of-type > summary',
          text: runId,
        });
        await client.command("click", {
          selector:
            '[data-testid="workflow-verification"] > details:first-of-type > summary',
        });
        await client.command("waitFor", {
          selector: '[data-testid="workflow-agent-model-configuration"]',
          text: "native-provenance",
        });
        const actualText = await command(
          "getText",
          "workflow-agent-model-configuration",
        );
        assert.match(actualText, /继承会话模型/);
        assert.match(actualText, /Agent 角色注册表/);
        assert.match(actualText, /请求暴露工具数: 未知/);
        assert.match(actualText, /full/);
        await client.command("waitFor", {
          selector: '[data-testid="workflow-verification"]',
          text: "启动时会话摘要",
        });
        await command(
          "scrollIntoViewAsUser",
          "workflow-agent-model-configuration",
        );
        await client.capture("native-workflow-frozen-agent-provenance.png");
        await context.writeArtifactJson("workflow-provenance.json", {
          runId,
          admission: first.modelSnapshot.configuration,
          attempts: page.runs.map((run) => ({
            artifactAttempt: run.artifactAttempt,
            executionStatus: run.executionStatus,
            modelSnapshot: run.modelSnapshot,
          })),
          observedProviderRequests: agentObservations,
          nativeText: actualText,
        });

        // Downgrade only completed owned records' optional new fields. This is an explicit
        // old-format compatibility fixture read by normal backend RPC, not an old-binary claim.
        const compatibility = [];
        for (const run of page.runs) {
          const path = resolve(
            profile,
            "workflow-library/verification",
            `${run.runId}-${run.artifactAttempt ?? run.resumeCount}.json`,
          );
          const bytes = await readFile(path),
            record = JSON.parse(bytes);
          assert.equal(record.executionStatus, run.executionStatus);
          const unchanged = { ...record, modelSnapshot: undefined };
          delete record.modelSnapshot.configuration;
          delete record.modelSnapshot.agents;
          assert.deepEqual({ ...record, modelSnapshot: undefined }, unchanged);
          const downgraded = JSON.stringify(record);
          await writeFile(path, downgraded, { mode: 0o600 });
          compatibility.push({
            artifactAttempt: run.artifactAttempt,
            beforeSha256: sha256(bytes),
            afterSha256: sha256(downgraded),
            removedFields: [
              "modelSnapshot.configuration",
              "modelSnapshot.agents",
            ],
          });
        }
        const legacy = await rpc.request("workflow/verification/read", {
          id: graph.id,
          version: 1,
        });
        assert.ok(
          legacy.runs.every(
            (run) =>
              !run.modelSnapshot.configuration && !run.modelSnapshot.agents,
          ),
        );
        await client.command("navigate", { value: "/" });
        await client.command("navigate", { value: "/workflows" });
        await command("waitFor", `workflow-library-${graph.id}`);
        await command("click", `workflow-library-${graph.id}`);
        await client.command("waitFor", {
          selector:
            '[data-testid="workflow-verification"] > details:first-of-type > summary',
          text: runId,
        });
        await client.command("click", {
          selector:
            '[data-testid="workflow-verification"] > details:first-of-type > summary',
        });
        await command("waitFor", "workflow-verification", {
          text: "未记录模型配置摘要",
        });
        assert.equal(
          await command(
            "getElementCount",
            "workflow-agent-model-configuration",
          ),
          "0",
        );
        await client.capture("native-workflow-legacy-summary-unknown.png");
        await context.writeArtifactJson("legacy-compatibility-fixture.json", {
          scope:
            "completed owned new record downgraded to optional-field old format",
          compatibility,
        });
      }

      const wikiModel = await startWikiModelFixture(context, {
        responseReady: () => wikiReleased,
      });
      await writeSettings(wikiModel.baseUrl, "native-wiki-frozen", "full");
      await client.command("navigate", { value: "/" });
      await command("waitFor", "knowledge-button");
      await command("click", "knowledge-button");
      await command("waitFor", "knowledge-create", { enabled: true });
      await command("click", "knowledge-create");
      await command("fill", "wiki-create-input", {
        value: "Controlled frozen Wiki",
      });
      await command("click", "wiki-create-confirm");
      await command("waitFor", "knowledge-library-picker", {
        text: "Controlled frozen Wiki",
      });
      const libraryId = await command("getValue", "knowledge-library-picker");
      const wikiFileInput = 'input[type="file"][aria-label="添加资料并整理"]';
      await client.command("waitFor", { selector: wikiFileInput });
      await client.command("fill", {
        selector: wikiFileInput,
        value: JSON.stringify([
          { name: "controlled-summary.md", text: "待审核：产品支持协议 A。" },
        ]),
      });
      await waitFor(
        () => wikiModel.requests.length === 1,
        15000,
        "real Wiki worker Provider request",
      );
      const jobs = await waitFor(
        async () => {
          const value = await rpc.request("knowledge/job/list", { libraryId });
          return value.items?.length ? value.items : null;
        },
        10000,
        "actual Wiki job",
      );
      const identity = { libraryId, jobId: jobs[0].id };
      const currentJob = await waitFor(
        async () => {
          const value = await rpc.request("knowledge/job/get", identity);
          return value.progress?.modelConfiguration ? value : null;
        },
        10000,
        "actual frozen Wiki worker summary",
      );
      const frozen = currentJob.progress.modelConfiguration;
      assert.equal(frozen.modelId, "native-wiki-frozen");
      assert.equal(frozen.toolSet.profile, null);
      assert.equal(frozen.toolSet.registryScope, "wiki_worker");
      assert.equal(frozen.toolSet.registeredToolCount, 0);
      assert.equal(frozen.toolSet.exposedToolCount, 0);
      assertSafe(frozen);
      assert.equal(wikiModel.requests[0].tools?.length ?? 0, 0);
      await command("waitFor", "wiki-job-status");
      await client.command("click", {
        selector: '[data-testid="wiki-job-status"] details > summary',
      });
      await command("waitFor", "frozen-model-configuration", {
        text: "native-wiki-frozen",
      });
      await command("waitFor", "model-tool-set", {
        text: "Wiki 工作器（无工具）",
      });
      const wikiText = await command("getText", "model-tool-set");
      assert.match(wikiText, /已注册工具数: 0/);
      assert.match(wikiText, /请求暴露工具数: 0/);
      await command("scrollIntoViewAsUser", "frozen-model-configuration");
      await client.capture("native-wiki-frozen-no-tools.png");
      await writeSettings(wikiModel.baseUrl, "changed-wiki-root", "nano");
      const afterChange = await rpc.request("knowledge/job/get", identity);
      assert.deepEqual(afterChange.progress.modelConfiguration, frozen);
      await command("waitFor", "frozen-model-configuration", {
        text: "native-wiki-frozen",
      });
      assert.match(
        await command("getText", "model-tool-set"),
        /工具配置: 未知/,
      );
      wikiReleased = true;
      const finished = await waitFor(
        async () => {
          const value = await rpc.request("knowledge/job/get", identity);
          assert.notEqual(value.status, "failed", value.errorCode);
          return value.status === "awaiting_review" ? value : null;
        },
        20000,
        "controlled Wiki worker completes with review",
      );
      assert.deepEqual(finished.progress.modelConfiguration, frozen);
      assert.ok(wikiModel.requests.length <= 2);
      assert.ok(
        wikiModel.requests.every(
          (body) => body.model === "native-wiki-frozen" && !body.tools?.length,
        ),
      );
      await context.writeArtifactJson("wiki-provenance.json", {
        jobId: identity.jobId,
        frozenConfiguration: frozen,
        status: finished.status,
        providerRequests: wikiModel.requests.map((body) => ({
          modelId: body.model,
          exposedToolCount: body.tools?.length ?? 0,
        })),
        rootChangedTo: { modelId: "changed-wiki-root", profile: "nano" },
        nativeText: wikiText,
      });
      assert.ok(
        (workflowModel?.requestCount ?? 0) <= 12,
        "Finite workflow fixture request budget",
      );
      return {
        native: true,
        executionScope,
        actualWorkflowToolAgent: executionScope === "all",
        attempts: executionScope === "all" ? 2 : 0,
        legacyCompatibility: executionScope === "all",
        actualWikiWorker: true,
        frozenAfterRootChange: true,
      };
    } catch (error) {
      client.markFailed();
      await client.capture("failure.png").catch(() => {});
      throw error;
    } finally {
      wikiReleased = true;
      assert.equal((await client.stop()).cleaned, true);
    }
  },
);
