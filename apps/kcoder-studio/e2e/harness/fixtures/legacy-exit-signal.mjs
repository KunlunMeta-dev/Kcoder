import { writeFile } from "node:fs/promises";
import { runE2E } from "../run-context.mjs";
import { withLegacyExitSignals } from "../legacy-desktop-run.mjs";

await withLegacyExitSignals(() =>
  runE2E(
    import.meta.url,
    { testId: "legacy-signal-cleanup-probe" },
    async (context, signal) => {
      const keepAlive = setInterval(() => {}, 1000);
      context.addCleanup("clear signal wait", () => clearInterval(keepAlive));
      const proof = context.pathInArtifacts("cleanup-proof.json");
      context.addCleanup("signal cleanup proof", () =>
        writeFile(
          proof,
          JSON.stringify(context.redactValue({ cleanupRan: true })),
          { flag: "wx", mode: 0o600 },
        ),
      );
      const aborted = new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      console.log(`RUN_ROOT:${context.runRoot}`);
      console.log("SIGNAL_READY");
      await aborted;
    },
  ),
);
