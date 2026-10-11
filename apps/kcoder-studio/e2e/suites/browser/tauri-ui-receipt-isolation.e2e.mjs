import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startOwnedAiVerify } from "../../harness/ai-verify-client.mjs";
import { waitForGatewayRpcToken } from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import {
  appRoot,
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN)
  throw new Error("UNMET_PREREQUISITE: explicit owned Tauri binary required");
// QA: real native WebView and real persisted RPC results. Seed only isolated Wiki
// documents; no provider or model is configured. Gates hold genuine receipts.
// Deadline QA: drop one real committed workflow receipt with its socket healthy,
// wait for the 120s unknown-outcome UI, then read exact revision + one node and
// another resident thread. Drop one read receipt, verify a 30s timeout releases
// its control, and read again. Cleanup remains owned by RunContext/AiVerify.
await runE2E(
  import.meta.url,
  {
    testId: "tauri-ui-write-and-navigation-receipts",
    tier: "full-integration",
    modelPolicy:
      "model-independent real Tauri/Gateway/app-server, zero model calls",
    retainSuccessEvidence: true,
    evidenceReason: "Critical native save and citation transient states",
  },
  async (context) => {
    const kcoderSnapshot = context.pathInState("bin/kcoder");
    await mkdir(dirname(kcoderSnapshot), { recursive: true });
    await copyFile(
      process.env.KCODER_E2E_KCODER_BIN ||
        resolve(repoRoot, "target/debug/kcoder"),
      kcoderSnapshot,
    );
    await chmod(kcoderSnapshot, 0o700);
    const client = await startOwnedAiVerify(context, {
      tauriBin: process.env.KCODER_E2E_TAURI_BIN,
      kcoderBin: kcoderSnapshot,
      rendererRoot:
        process.env.KCODER_E2E_RENDERER_ROOT ||
        resolve(appRoot, "renderer/dist"),
      uiReceiptFault: true,
    });
    const artifacts = resolve(client.runRoot, "artifacts");
    const cmd = (action, id, rest = {}) =>
      client.command(action, { selector: `[data-testid="${id}"]`, ...rest });
    const arm = (mode) =>
      writeFile(
        resolve(artifacts, "ui-receipt-plan.json"),
        JSON.stringify({ mode }),
      );
    const fault = async () =>
      JSON.parse(
        await readFile(
          resolve(artifacts, "ui-receipt-fault.json"),
          "utf8",
        ).catch(() => "{}"),
      );
    const held = (mode) =>
      waitFor(
        async () => (await fault())[mode]?.held,
        5000,
        `${mode} genuine reply held`,
      );
    const release = async (mode) => {
      await writeFile(
        resolve(artifacts, `ui-receipt-release-${mode}`),
        "release",
      );
      await waitFor(
        async () => (await fault())[mode]?.released,
        5000,
        `${mode} reply released`,
      );
    };
    try {
      await cmd("waitFor", "desktop-sidebar");
      const { gatewayOrigin } = JSON.parse(
        await readFile(resolve(artifacts, "launch-policy.json"), "utf8"),
      );
      const gateway = {
        baseUrl: gatewayOrigin,
        wsUrl: gatewayOrigin.replace("http:", "ws:"),
      };
      const token = await waitForGatewayRpcToken(context, gateway);
      const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
      context.addCleanup("close owned UI fixture RPC", () => rpc.close());
      await initializeRpc(rpc, "owned-ui-fixtures");
      const independentThread = await rpc.request("thread/start", {});
      const definition = await rpc.request("workflow/create", {
        title: "Owned UI receipts",
      });
      await client.command("navigate", { value: "/workflows" });
      await cmd("waitFor", `workflow-library-${definition.id}`);
      await cmd("click", `workflow-library-${definition.id}`);
      await cmd("waitFor", "workflow-add-node", { enabled: true });
      await cmd("click", "workflow-add-node");
      await cmd("waitFor", "workflow-node-title", { enabled: true });
      await cmd("fill", "workflow-node-title", {
        value: "Owned submitted node",
      });
      await cmd("fill", "workflow-node-prompt", { value: "OWNED_SUBMITTED" });
      await arm("node-save");
      await cmd("click", "workflow-node-save");
      await held("node-save");
      assert.equal(
        await client.command("getElementCount", {
          selector:
            '[data-testid="workflow-node-editor"] input:enabled, [data-testid="workflow-node-editor"] textarea:enabled, [data-testid="workflow-node-editor"] select:enabled, [data-testid="workflow-node-editor"] button:enabled',
        }),
        "0",
      );
      await client.capture("node-pending-locked.png");
      await release("node-save");
      await cmd("waitFor", "workflow-node-prompt", { enabled: true });
      assert.equal(
        await cmd("getValue", "workflow-node-prompt"),
        "OWNED_SUBMITTED",
      );
      await cmd("fill", "workflow-node-prompt", { value: "OWNED_NEXT_DRAFT" });
      await cmd("click", "workflow-node-save");
      await cmd("waitFor", "workflow-node-prompt", { enabled: true });
      const persisted = await rpc.request("workflow/read", {
        id: definition.id,
      });
      assert.equal(persisted.nodes[0].prompt, "OWNED_NEXT_DRAFT");

      await cmd("fill", "workflow-node-prompt", { value: "OWNED_TIMEOUT" });
      await arm("node-timeout");
      const mutationStartedAt = Date.now();
      await cmd("click", "workflow-node-save");
      await waitFor(
        async () => (await fault())["node-timeout"]?.dropped,
        5000,
        "real mutation receipt dropped",
      );
      await cmd("waitFor", "workflow-error", { timeoutMs: 135_000 });
      assert.match(await cmd("getText", "workflow-error"), /回执|receipt/);
      assert.ok(Date.now() - mutationStartedAt >= 119_000);
      await cmd("waitFor", "workflow-node-prompt", { enabled: true });
      const afterTimeout = await rpc.request("workflow/read", {
        id: definition.id,
      });
      assert.equal(afterTimeout.nodes.length, 1);
      assert.equal(afterTimeout.nodes[0].prompt, "OWNED_TIMEOUT");
      assert.equal(afterTimeout.revision, persisted.revision + 1);
      assert.equal(
        (
          await rpc.request("thread/read", {
            threadId: independentThread.thread.id,
          })
        ).thread.id,
        independentThread.thread.id,
      );
      assert.equal((await fault())["node-timeout"].socketClosed, false);
      assert.ok((await fault())["node-timeout"].followingFrames > 0);
      await client.capture("mutation-timeout-unknown-native.png");

      await client.command("navigate", { value: "/knowledge" });
      await cmd("waitFor", "knowledge-enable", { enabled: true });
      await cmd("click", "knowledge-enable");
      await cmd("waitFor", "knowledge-create", { enabled: true });
      await cmd("click", "knowledge-create");
      await cmd("fill", "wiki-create-input", { value: "Owned receipts" });
      await cmd("click", "wiki-create-confirm");
      await cmd("waitFor", "knowledge-library-picker", {
        text: "Owned receipts",
      });
      const seed = context.spawnOwned(
        "seed-owned-wiki-ui",
        "/usr/bin/python3",
        [
          resolve(appRoot, "e2e/fixtures/wiki/seed-ui-pages.py"),
          dirname(client.settingsPath),
        ],
      );
      await waitFor(
        () => seed.exitCode !== null,
        5000,
        "owned Wiki fixture seeded",
      );
      assert.equal(seed.exitCode, 0);
      await client.command("navigate", { value: "/" });
      await client.command("navigate", { value: "/knowledge" });
      await cmd("waitFor", "wiki-search");
      await cmd("fill", "wiki-search", { value: "receipt" });
      const pageResult = (title) =>
        `[data-testid^="wiki-search-result-"][aria-label="${title}"]`;
      await client.command("waitFor", { selector: pageResult("Owned A") });
      await arm("page-A");
      await client.command("click", { selector: pageResult("Owned A") });
      await held("page-A");
      await client.command("click", { selector: pageResult("Owned B") });
      await cmd("waitFor", "wiki-reader", { text: "Owned B" });
      await release("page-A");
      await cmd("waitFor", "wiki-reader", { text: "Owned B", stableMs: 300 });

      await cmd("click", "wiki-citation-0");
      await cmd("waitFor", "wiki-source-preview", {
        text: "Owned receipt evidence.",
      });
      await arm("citation");
      await cmd("click", "wiki-citation-0");
      await held("citation");
      await client.command("click", {
        selector: '[data-testid^="wiki-link-"][aria-label="Owned A"]',
      });
      await cmd("waitFor", "wiki-reader", { text: "Owned A" });
      assert.equal(await cmd("getElementCount", "wiki-source-preview"), "0");
      await cmd("waitFor", "wiki-citation-0", { enabled: true });
      await release("citation");
      assert.equal(await cmd("getElementCount", "wiki-source-preview"), "0");
      await client.capture("citation-reset-on-related-page.png");

      await arm("citation-timeout");
      const readStartedAt = Date.now();
      await cmd("click", "wiki-citation-0");
      await waitFor(
        async () => (await fault())["citation-timeout"]?.dropped,
        5000,
        "real read receipt dropped",
      );
      await cmd("waitFor", "wiki-citation-0", {
        enabled: true,
        timeoutMs: 40_000,
      });
      assert.ok(Date.now() - readStartedAt >= 29_000);
      assert.equal((await fault())["citation-timeout"].socketClosed, false);
      await client.capture("read-timeout-native.png");
      await cmd("click", "wiki-citation-0");
      await cmd("waitFor", "wiki-source-preview", {
        text: "Owned receipt evidence.",
      });
      assert.ok((await fault())["citation-timeout"].followingFrames > 0);

      await cmd("click", "wiki-reader-edit");
      await cmd("fill", "wiki-edit-body", {
        value: "Owned receipt evidence.\n\nHuman saved body.",
      });
      await arm("edit-read");
      await cmd("click", "wiki-edit-save");
      await cmd("waitFor", "wiki-edit-reload", { enabled: true });
      assert.equal(
        await client.command("getElementCount", {
          selector: '[data-testid="wiki-edit-save"]:disabled',
        }),
        "1",
      );
      await client.capture("saved-read-failure.png");
      await cmd("click", "wiki-edit-reload");
      await cmd("waitFor", "wiki-reader", { text: "Human saved body." });
      await cmd("click", "wiki-reader-history");
      await cmd("waitFor", "wiki-history-version-1");
      await cmd("click", "wiki-history-version-1");
      await cmd("waitFor", "wiki-history-restore", { enabled: true });
      await arm("restore-read");
      await cmd("click", "wiki-history-restore");
      await cmd("waitFor", "wiki-history-reload", { enabled: true });
      await cmd("click", "wiki-history-reload");
      await cmd("waitFor", "wiki-reader", { text: "Receipt page A." });
      await client.capture("wiki-restored-native.png");
      const checker = context.spawnOwned(
        "check-owned-wiki-ui",
        "/usr/bin/python3",
        [
          resolve(appRoot, "e2e/fixtures/wiki/seed-ui-pages.py"),
          dirname(client.settingsPath),
          "summary",
        ],
      );
      let summaryText = "";
      checker.stdout.on("data", (chunk) => {
        summaryText += chunk.toString();
      });
      await waitFor(
        () => checker.exitCode !== null,
        5000,
        "owned Wiki persisted receipt summary",
      );
      assert.equal(checker.exitCode, 0);
      const summary = JSON.parse(summaryText);
      assert.deepEqual(summary, {
        modelCalls: 0,
        humanVersions: 2,
        restoredVersions: 1,
      });
      const evidence = await fault();
      for (const mode of ["node-save", "page-A", "citation"])
        assert.deepEqual(evidence[mode], {
          held: true,
          released: true,
          timedOut: false,
          cancelled: false,
        });
      assert.ok(
        evidence["edit-read"].readRejected &&
          evidence["restore-read"].readRejected,
      );
      await context.writeArtifactJson("native-receipts.json", {
        realTauri: true,
        realBackend: true,
        modelCalls: 0,
        nodeFieldsLocked: true,
        latestPageWins: true,
        citationsReset: true,
        committedReadsRecover: true,
        committedMutationsNotReplayed: true,
        readDeadlineMs: 30_000,
        writeDeadlineMs: 120_000,
        droppedReadRecovered: true,
        mutationTimeoutUnknown: true,
        unrelatedResidentThreadReadable: true,
        healthySocketAfterTimeout: true,
        exactMutationRevision: afterTimeout.revision,
        persisted: summary,
      });
    } catch (error) {
      client.markFailed();
      await client.capture("native-ui-failure.png").catch(() => {});
      await context
        .writeArtifactJson(
          "native-ui-failure-state.json",
          JSON.parse(await client.command("snapshot")),
        )
        .catch(() => {});
      throw error;
    }
  },
);
