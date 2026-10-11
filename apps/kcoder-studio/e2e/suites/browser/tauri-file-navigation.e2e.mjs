import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startOwnedAiVerify } from "../../harness/ai-verify-client.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import {
  appRoot,
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";

await assertRendererBuildFresh();
if (!process.env.KCODER_E2E_TAURI_BIN)
  throw new Error("UNMET_PREREQUISITE: owned Tauri binary required");
// QA: genuine file links, directory-kind RPC receipts, native CodeMirror edits,
// cancel/save/discard navigation and disk bytes. A local fixture supplies links;
// model variance adds no coverage to this navigation/receipt ownership boundary.
await runE2E(
  import.meta.url,
  {
    testId: "native-file-links-late-kind-receipt-and-dirty-navigation",
    tier: "full-integration",
    modelPolicy:
      "model-independent real native Tauri/Gateway/app-server file interaction; local link fixture, zero paid calls",
    retainSuccessEvidence: true,
    evidenceReason: "Critical native late receipt preserves the edited B file",
  },
  async (context) => {
    const client = await startOwnedAiVerify(context, {
      tauriBin: process.env.KCODER_E2E_TAURI_BIN,
      kcoderBin:
        process.env.KCODER_E2E_KCODER_BIN ||
        resolve(repoRoot, "target/debug/kcoder"),
      rendererRoot: resolve(appRoot, "renderer/dist"),
      uiReceiptFault: true,
    });
    const workspace = resolve(
      dirname(dirname(client.settingsPath)),
      "workspaces/tauri-verification",
    );
    const artifacts = resolve(client.runRoot, "artifacts");
    const pathA = resolve(workspace, "nav-a/owned-nav-A.ts"),
      pathB = resolve(workspace, "nav-a/owned-nav-B.ts"),
      pathC = resolve(workspace, "nav-c/owned-nav-C.ts");
    const cmd = (action, id, args = {}) =>
      client.command(action, { selector: `[data-testid="${id}"]`, ...args });
    const link = (name) =>
      `[data-testid="assistant-markdown-link"][aria-label*="${name}"]`;
    const editor = '[data-testid="workspace-file-editor"] .cm-content';
    const fault = async () => {
      const raw = await readFile(
        resolve(artifacts, "ui-receipt-fault.json"),
        "utf8",
      ).catch(() => "{}");
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      } // A polling read can overlap the owned writer.
    };
    try {
      await mkdir(dirname(pathA));
      await mkdir(dirname(pathC));
      await writeFile(pathA, "A original\n");
      await writeFile(pathB, "B original\n");
      await writeFile(pathC, "C original\n");
      const fixture = await startApprovalModelFixture(context, {
        textOnly: true,
        textOnlyResponse: `[Owned A](file://${pathA}) [Owned B](file://${pathB}) [Owned directory](file://${dirname(pathA)}) [Owned C](file://${pathC})`,
      });
      await writeFile(
        client.settingsPath,
        JSON.stringify({
          active_provider: "fixture",
          permission_mode: "yolo",
          max_retries: 0,
          providers: {
            fixture: {
              api_format: "openai_chat_completions",
              authentication: { mode: "none" },
              endpoint: fixture.baseUrl,
              default_model: "fixture",
              context_window_tokens: 128000,
              max_output_tokens: 1024,
              output_headroom_tokens: 1024,
              no_proxy: true,
            },
          },
        }),
      );
      await client.command("navigate", { value: "/settings/personal/models" });
      await cmd("waitFor", "provider-edit-fixture::fixture");
      await client.command("navigate", { value: "/" });
      await cmd("waitFor", "chat-message-input");
      await cmd("fill", "chat-message-input", {
        value: "Render owned file navigation links",
      });
      await cmd("waitFor", "send-message-button", { enabled: true });
      await cmd("click", "send-message-button");
      await client.command("waitFor", {
        selector: link("owned-nav-A.ts"),
        timeoutMs: 30000,
      });
      // Establish the shared directory target before arming the next link's
      // lookup; the initial tree load is a separate real request.
      await client.command("click", { selector: link("owned-nav-B.ts") });
      await cmd("waitFor", "workspace-file-path", { text: "owned-nav-B.ts" });
      await cmd("waitFor", "workspace-file-edit-button");
      await writeFile(
        resolve(artifacts, "ui-receipt-plan.json"),
        JSON.stringify({ mode: "file-kind" }),
      );
      await client.command("click", { selector: link("owned-nav-A.ts") });
      await waitFor(
        async () => (await fault())["file-kind"]?.held,
        5000,
        "genuine A directory-kind receipt held",
      );
      await client.command("click", { selector: link("owned-nav-B.ts") });
      await cmd("waitFor", "workspace-file-path", { text: "owned-nav-B.ts" });
      await cmd("waitFor", "workspace-file-edit-button");
      await cmd("click", "workspace-file-edit-button");
      await client.command("fill", {
        selector: editor,
        value: "B newer unsaved draft",
      });
      await cmd("waitFor", "workspace-file-save-button", { enabled: true });
      assert.equal(
        Number(await cmd("getElementCount", "workspace-file-unsaved-dialog")),
        0,
        "first edit must not replay the consumed link request",
      );
      await writeFile(
        resolve(artifacts, "ui-receipt-release-file-kind"),
        "release",
      );
      await waitFor(
        async () => (await fault())["file-kind"]?.released,
        5000,
        "old A lookup released",
      );
      assert.equal((await fault())["file-kind"].timedOut, false);
      assert.match(
        await cmd("getText", "workspace-file-path"),
        /owned-nav-B\.ts$/,
      );
      assert.equal(
        await client.command("getText", { selector: editor }),
        "B newer unsaved draft",
      );
      await client.capture("native-late-lookup-retains-b-draft.png");
      await client.command("click", { selector: link("owned-nav-A.ts") });
      await cmd("waitFor", "workspace-file-unsaved-dialog");
      await cmd("click", "workspace-file-unsaved-cancel");
      assert.equal(
        await client.command("getText", { selector: editor }),
        "B newer unsaved draft",
      );
      await client.command("click", { selector: link("owned-nav-A.ts") });
      await cmd("waitFor", "workspace-file-unsaved-dialog");
      await cmd("click", "workspace-file-unsaved-save");
      await cmd("waitFor", "workspace-file-path", { text: "owned-nav-A.ts" });
      await cmd("waitFor", "workspace-file-edit-button");
      assert.equal(await readFile(pathB, "utf8"), "B newer unsaved draft");
      await cmd("click", "workspace-file-edit-button");
      await client.command("fill", {
        selector: editor,
        value: "A discarded draft",
      });
      await client.command("click", { selector: link("owned-nav-B.ts") });
      await cmd("waitFor", "workspace-file-unsaved-dialog");
      await cmd("click", "workspace-file-unsaved-discard");
      await cmd("waitFor", "workspace-file-path", { text: "owned-nav-B.ts" });
      await cmd("waitFor", "workspace-file-edit-button");
      assert.equal(await readFile(pathA, "utf8"), "A original\n");
      // An absolute link in a different directory proposes a new workspace
      // target. Its target must wait for the current file's dirty decision.
      await cmd("click", "workspace-file-edit-button");
      await client.command("fill", {
        selector: editor,
        value: "B cross-target draft",
      });
      await cmd("waitFor", "workspace-file-save-button", { enabled: true });
      await client.command("click", { selector: link("owned-nav-C.ts") });
      await cmd("waitFor", "workspace-file-unsaved-dialog");
      await cmd("click", "workspace-file-unsaved-cancel");
      assert.match(
        await cmd("getText", "workspace-file-path"),
        /owned-nav-B\.ts$/,
      );
      assert.equal(
        await client.command("getText", { selector: editor }),
        "B cross-target draft",
      );
      await client.command("click", { selector: link("owned-nav-C.ts") });
      await cmd("waitFor", "workspace-file-unsaved-dialog");
      await cmd("click", "workspace-file-unsaved-save");
      await cmd("waitFor", "workspace-file-path", { text: "owned-nav-C.ts" });
      await cmd("waitFor", "workspace-file-edit-button");
      assert.equal(await readFile(pathB, "utf8"), "B cross-target draft");
      await cmd("click", "workspace-file-edit-button");
      await client.command("fill", {
        selector: editor,
        value: "C discarded draft",
      });
      await cmd("waitFor", "workspace-file-save-button", { enabled: true });
      await client.command("click", { selector: link("owned-nav-B.ts") });
      await cmd("waitFor", "workspace-file-unsaved-dialog");
      await cmd("click", "workspace-file-unsaved-discard");
      await cmd("waitFor", "workspace-file-path", { text: "owned-nav-B.ts" });
      await cmd("waitFor", "workspace-file-edit-button");
      assert.equal(await readFile(pathC, "utf8"), "C original\n");
      await client.capture("native-cross-target-decisions.png");
      assert.equal(fixture.requests.length, 1);
      return {
        native: true,
        oldKindReplyIgnored: true,
        firstEditNoModal: true,
        cancel: true,
        save: true,
        discard: true,
        localProviderRequests: 1,
        paidProviderRequests: 0,
        crossTargetCancel: true,
        crossTargetSave: true,
        crossTargetDiscard: true,
      };
    } catch (error) {
      client.markFailed();
      await client.capture("failure.png").catch(() => {});
      throw error;
    } finally {
      assert.equal((await client.stop()).cleaned, true);
    }
  },
);
