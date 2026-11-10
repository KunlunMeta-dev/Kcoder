import { runE2E } from "./harness/run-context.mjs";
import { buildRecoveryFixture } from "./fixtures/mobile-send-recovery/build.mjs";

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-send-recovery-static-export", tier: "manual-live", retainSuccessLogs: true,
  modelPolicy: "Model-independent static presentation export; no Gateway or model",
}, async run => {
  const { output } = await buildRecoveryFixture(run);
  return { output, synthetic: true, productionStartupChanged: false };
});
