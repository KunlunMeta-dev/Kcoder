import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { startOwnedAiVerify } from "../../harness/ai-verify-client.mjs";
import {
  appRoot,
  repoRoot,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
const require = createRequire(resolve(appRoot, "renderer/package.json"));
const JSZip = require("jszip");
if (!process.env.KCODER_E2E_TAURI_BIN)
  throw new Error("UNMET_PREREQUISITE: explicit owned Tauri binary required");
// QA: production upload components in an owned native component fixture. Current
// local KCoder management has a path import UI; cloud publishing is not asserted.
await runE2E(
  import.meta.url,
  {
    testId: "tauri-upload-native-keyboard-and-package-presentation",
    tier: "full-integration",
    modelPolicy:
      "model-independent native production component presentation, no upload or model RPC",
    retainSuccessEvidence: true,
    evidenceReason: "Both upload shells in light and dark native WebViews",
  },
  async (context) => {
    const output = context.pathInState("upload-renderer");
    const build = context.spawnOwned(
      "build-native-upload",
      process.execPath,
      [resolve(appRoot, "e2e/fixtures/native-upload/build.mjs"), output],
      { cwd: resolve(appRoot, "renderer") },
    );
    await waitFor(
      () => build.exitCode !== null,
      60000,
      "native upload fixture build",
    );
    assert.equal(build.exitCode, 0);
    const client = await startOwnedAiVerify(context, {
      tauriBin: process.env.KCODER_E2E_TAURI_BIN,
      kcoderBin:
        process.env.KCODER_E2E_KCODER_BIN ||
        resolve(repoRoot, "target/debug/kcoder"),
      rendererRoot: output,
    });
    const cmd = (action, id, rest = {}) =>
      client.command(action, { selector: `[data-testid="${id}"]`, ...rest });
    const isFocused = async (selector) =>
      JSON.parse(await client.command("getElementMetrics", { selector }))[0]
        .focused;
    try {
      for (const theme of ["light", "dark"]) {
        if (theme === "dark") await cmd("click", "upload-theme");
        if (theme === "dark")
          assert.equal(
            await client.command("getAttribute", {
              selector: "html",
              value: "data-theme",
            }),
            "dark",
          );
        for (const kind of ["plugin", "skill"]) {
          const trigger = `open-${kind}-upload`,
            dialog = `${kind}-upload-dialog`;
          await cmd("press", trigger, { key: "Enter" });
          await cmd("click", trigger);
          await cmd("waitFor", dialog);
          assert.equal(
            await cmd("getAttribute", dialog, { value: "role" }),
            "dialog",
          );
          assert.equal(
            await isFocused(`[data-testid="${dialog}-close"]`),
            true,
          );
          const lastControl =
            kind === "skill"
              ? "skill-upload-cancel"
              : "plugin-upload-confirm-button";
          await cmd("press", lastControl, { key: "Tab" });
          assert.equal(
            await isFocused(`[data-testid="${dialog}-close"]`),
            true,
          );
          await cmd("press", `${dialog}-close`, { key: "Shift+Tab" });
          assert.equal(await isFocused(`[data-testid="${lastControl}"]`), true);
          if (kind === "skill") {
            const zip = new JSZip();
            zip.file(
              "SKILL.md",
              "---\nname: owned-native-skill\ndescription: Native package presentation\n---\nOwned local fixture.",
            );
            await cmd("fill", "skill-upload-file-input", {
              value: JSON.stringify([
                {
                  name: "owned.ZIP",
                  contentBase64: await zip.generateAsync({
                    type: "base64",
                    compression: "STORE",
                  }),
                },
              ]),
            });
            await cmd("waitFor", "skill-upload-name-input");
            assert.equal(
              await cmd("getValue", "skill-upload-name-input"),
              "owned-native-skill",
            );
            await cmd("fill", "skill-upload-file-input", {
              value: JSON.stringify([
                { name: "invalid.zip", text: "invalid package" },
              ]),
            });
            await waitFor(
              async () =>
                (await cmd("getElementCount", "skill-upload-name-input")) ===
                "0",
              5000,
              "invalid package clears previous selection",
            );
            await cmd("fill", "skill-upload-file-input", {
              value: JSON.stringify([
                {
                  name: "owned.ZIP",
                  contentBase64: await zip.generateAsync({
                    type: "base64",
                    compression: "STORE",
                  }),
                },
              ]),
            });
            await cmd("waitFor", "skill-upload-name-input");
          }
          await client.capture(`${kind}-upload-${theme}.png`);
          await cmd("press", `${dialog}-close`, { key: "Escape" });
          assert.equal(await cmd("getElementCount", dialog), "0");
          assert.equal(await isFocused(`[data-testid="${trigger}"]`), true);
        }
      }
      await context.writeArtifactJson("native-upload-presentation.json", {
        realTauri: true,
        productionComponents: true,
        nativeLocalZipRead: true,
        focusContainment: true,
        escapeAndFocusReturn: true,
        lightAndDark: true,
        modelCalls: 0,
        cloudPublishingTested: false,
      });
    } catch (error) {
      client.markFailed();
      await client.capture("native-upload-failure.png").catch(() => {});
      throw error;
    }
  },
);
