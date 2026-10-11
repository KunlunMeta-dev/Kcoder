import { pathToFileURL } from "node:url";
import { taskFlowUsage } from "../../../renderer/e2e/desktop/task-flow-args.mjs";
import { runE2E } from "../../harness/run-context.mjs";
import {
  executeLegacyDesktopTaskFlow,
  withLegacyExitSignals,
} from "../../harness/legacy-desktop-run.mjs";

export async function runLegacyDesktopTaskFlow() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(taskFlowUsage());
    return;
  }
  return withLegacyExitSignals(() =>
    runE2E(
      import.meta.url,
      {
        testId: "legacy-desktop-task-flow",
        tier: "manual-live",
        modelPolicy:
          "Deterministic loopback protocol fixtures with real compatible executor and Tauri; no model-quality claim",
        bodyAbortTimeoutMs: 20_000,
      },
      executeLegacyDesktopTaskFlow,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runLegacyDesktopTaskFlow();
}
