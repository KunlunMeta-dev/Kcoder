import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  startGateway,
  waitForGatewayRpcToken,
} from "../../harness/gateway.mjs";
import { gatewayRpcUrl, initializeRpc, openRpc } from "../../harness/rpc.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";
import { runE2E } from "../../harness/run-context.mjs";
const markets = {
  trae: "https://api.trae.com.cn/extensions/api/-/plugin/list",
  xai: "https://github.com/xai-org/plugin-marketplace",
  "workbuddy-teams":
    "https://download.codebuddy.cn/plugin-marketplace/cb_teams_marketplace.zip",
  "anthropic-skills": "https://github.com/anthropics/skills",
  superpowers: "https://github.com/obra/superpowers-marketplace",
  qoder: "https://qoder.com/marketplace",
  workbuddy:
    "https://download.codebuddy.cn/plugin-marketplace/codebuddy-plugins-official.zip",
  codebuddy: "https://cnb.cool/codebuddy/marketplace",
  claude: "https://github.com/anthropics/claude-plugins-official",
  openai: "https://github.com/openai/plugins",
};
const marketKey = process.env.KCODER_E2E_MATRIX_MARKET;
const source = markets[marketKey];
const count = Number(process.env.KCODER_E2E_MATRIX_COUNT || 32);
if (
  !source ||
  process.env.KCODER_E2E_PUBLIC_MARKETPLACE !== "1" ||
  !Number.isInteger(count) ||
  count < 1 ||
  count > 250
)
  throw new Error("Explicit market/access/count required");
// QA: public real catalogs and packages in isolated profiles; select popular plus
// evenly distributed entries, install/read/uninstall sequentially per library.
// No model, plugin hooks, MCP subprocess, account login, or user profile changes.
await runE2E(
  import.meta.url,
  {
    testId: `plugin-install-matrix-${marketKey}`,
    tier: "manual-live",
    modelPolicy: "model-independent public package installation matrix",
  },
  async (context) => {
    const { path: workspace } = await materializeWorkspace(context, "minimal");
    await context.writeStateJson("config/settings.json", {
      providers: {},
      plugins: {
        installation: {
          proxy_url: process.env.KCODER_E2E_PLUGIN_PROXY || null,
          timeout_ms: 75000,
        },
      },
    });
    const gateway = await startGateway(context, {
      workspace,
      env: {
        KCODER_CONFIG_DIR: context.pathInState("config"),
        ...(process.env.KCODER_E2E_MATRIX_NO_PROXY
          ? {
              NO_PROXY: process.env.KCODER_E2E_MATRIX_NO_PROXY,
              no_proxy: process.env.KCODER_E2E_MATRIX_NO_PROXY,
            }
          : {}),
      },
    });
    const token = await waitForGatewayRpcToken(context, gateway);
    const rpc = await openRpc(gatewayRpcUrl(gateway, "local", token));
    context.addCleanup("close matrix RPC", () => rpc.close());
    await initializeRpc(rpc, "plugin-install-matrix");
    const added = await rpc.request("marketplace/add", { source }, 150000);
    const listed = await rpc.request("marketplace/list", {}, 120000);
    const market = listed.marketplaces.find(
      (item) => item.id === added.marketplaceName,
    );
    assert.ok(market);
    if (process.env.KCODER_E2E_MATRIX_EXPECT_UNAVAILABLE) {
      const blocked =
        process.env.KCODER_E2E_MATRIX_EXPECT_UNAVAILABLE.split(",");
      for (const name of blocked) {
        const entry = market.plugins.find(
          (item) => item.pluginId === `${name}@${market.id}`,
        );
        assert.ok(entry, `Missing blocked entry ${name}`);
        assert.equal(
          String(entry.installPolicy).toLowerCase(),
          "not_available",
          name,
        );
        assert.ok(
          entry.manifestFallback?.compatibility?.issues?.length,
          `Missing reason for ${name}`,
        );
        await assert.rejects(
          rpc.request(
            "plugin/install",
            { marketplaceName: market.id, pluginName: name },
            15000,
          ),
          /not available for installation/,
        );
      }
      const inventory = await rpc.request("plugin/list", { all: true }, 15000);
      assert.equal(
        inventory.plugins.length,
        0,
        "blocked requests did not create installed records",
      );
      await context.writeArtifactJson("preinstall-blocks.json", {
        market: market.id,
        blocked,
        backendRejected: true,
        noInstalledRecords: true,
      });
      return;
    }

    const available = market.plugins.filter(
      (item) => String(item.installPolicy).toLowerCase() !== "not_available",
    );
    const requested =
      process.env.KCODER_E2E_MATRIX_NAMES?.split(",").filter(Boolean);
    const indexes = new Set();
    if (!requested) {
      for (let i = 0; i < Math.min(10, count, available.length); i++)
        indexes.add(i);
      const rest = count - indexes.size;
      for (let i = 0; i < rest; i++)
        indexes.add(
          Math.min(
            available.length - 1,
            10 + Math.floor((i * (available.length - 10)) / Math.max(1, rest)),
          ),
        );
      for (let i = 0; indexes.size < Math.min(count, available.length); i++)
        indexes.add(i);
    }
    const selected =
      process.env.KCODER_E2E_MATRIX_ALL === "1"
        ? available
        : requested
          ? requested.map((name) => {
              const item = available.find(
                (item) => item.pluginId === `${name}@${market.id}`,
              );
              assert.ok(item, name);
              return item;
            })
          : [...indexes].map((i) => available[i]);
    const report = {
      market: marketKey,
      catalog: market.id,
      total: market.plugins.length,
      unavailable: market.plugins
        .filter(
          (item) =>
            String(item.installPolicy).toLowerCase() === "not_available",
        )
        .map((item) => item.pluginId),
      results: [],
    };
    for (const [index, item] of selected.entries()) {
      const name = item.pluginId.slice(0, item.pluginId.lastIndexOf("@"));
      const started = Date.now();
      const row = { id: item.pluginId, status: "pending" };
      let installed = false;
      try {
        const result = await rpc.request(
          "plugin/install",
          {
            marketplaceName: market.id,
            pluginName: name,
            installAttemptId: `matrix-${marketKey}-${index}`,
          },
          95000,
        );
        installed = true;
        assert.equal(result.plugin.id, item.pluginId);
        const read = await rpc.request(
          "plugin/read",
          { pluginId: item.pluginId },
          15000,
        );
        assert.equal(read.plugin.id, item.pluginId);
        row.components = read.plugin.components.map((component) => ({
          name: component.name,
          kind: component.kind,
        }));
        row.compatibility = read.plugin.compatibility;
        if (process.env.KCODER_E2E_MATRIX_INSPECT === "1") {
          const manifests = {};
          for (const file of [
            "plugin.json",
            ".claude-plugin/plugin.json",
            ".codebuddy-plugin/plugin.json",
            ".codex-plugin/plugin.json",
            ".grok-plugin/plugin.json",
          ]) {
            try {
              manifests[file] = JSON.parse(
                await readFile(join(read.plugin.root, file), "utf8"),
              );
            } catch {}
          }
          const hookFiles = {};
          try {
            for (const file of (
              await readdir(join(read.plugin.root, "hooks"))
            ).slice(0, 64)) {
              if (file.endsWith(".json"))
                hookFiles[file] = JSON.parse(
                  await readFile(join(read.plugin.root, "hooks", file), "utf8"),
                );
            }
          } catch {}
          await context.writeArtifactJson(`inspection-${index + 1}.json`, {
            id: item.pluginId,
            files: await readdir(read.plugin.root),
            manifests,
            hookFiles,
          });
        }

        row.componentStatus = row.components.length
          ? "declared_components_available"
          : "no_active_components";
        row.status = "installed";
      } catch (error) {
        row.status = "failed";
        row.error = context.redactText(
          error instanceof Error ? error.message : String(error),
        );
        await rpc
          .request(
            "plugin/install/cancel",
            { installAttemptId: `matrix-${marketKey}-${index}` },
            10000,
          )
          .catch(() => {});
      } finally {
        if (installed) {
          try {
            await rpc.request(
              "plugin/uninstall",
              { pluginId: item.pluginId, purgeData: true },
              20000,
            );
            row.uninstalled = true;
          } catch (error) {
            row.status = "failed";
            row.cleanupError = context.redactText(String(error));
          }
        }
      }
      row.durationMs = Date.now() - started;
      report.results.push(row);
      await context.writeArtifactJson(`installation-${index + 1}.json`, row);
      console.log(
        JSON.stringify({
          market: marketKey,
          index: index + 1,
          total: selected.length,
          ...row,
        }),
      );
    }
    await context.writeArtifactJson("installation-matrix.json", report);
    assert.equal(
      report.results.filter((item) => item.status === "failed").length,
      0,
      "Package failures recorded in installation-matrix.json",
    );
  },
);
