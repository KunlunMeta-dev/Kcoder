import assert from "node:assert/strict";
import { startChromium } from "../../harness/chromium.mjs";
import { startOwnedDisplay } from "../../harness/ai-verify-gateway.mjs";
import { requireExecutable, runE2E } from "../../harness/run-context.mjs";
import { captureRealPageVisibilityCycle } from "./helpers/refresh-send-background-fixture.mjs";

await runE2E(import.meta.url, {
  testId: "mobile-web-headful-two-tab-visibility-diagnostic",
  tier: "manual-live",
  modelPolicy: "model-independent visibility diagnostic in owned headful Chromium under Xvfb; trusted document visibility events only; RunContext PASS means the harness completed, while visibility passes only when the artifact status is PASS; no Gateway, Provider, or native-app claim",
  retainSuccessLogs: true,
}, async runContext => {
  if (process.platform !== "linux") {
    throw new Error("UNMET_PREREQUISITE: owned Xvfb headful Chromium diagnostic requires Linux");
  }
  if (process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1" && process.env.KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX !== "1") {
    throw new Error("UNMET_PREREQUISITE: explicitly opt in to isolated Chromium sandbox policy");
  }

  await requireExecutable("/usr/bin/Xvfb", "owned Xvfb");
  await requireExecutable("/usr/bin/xauth", "owned X display authorization");
  await requireExecutable(process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium", "system Chromium");

  const display = await startOwnedDisplay(runContext);
  const launcher = await startChromium(runContext, {
    label: "headful-visibility-chromium",
    headless: false,
    display: display.display,
    env: { DISPLAY: display.display, XAUTHORITY: display.authority },
  });

  let browserContext;
  try {
    browserContext = await launcher.browser.newContext({ viewport: { width: 1280, height: 800 } });
    runContext.addCleanup("close headful visibility BrowserContext", () => browserContext.close());
    const page = await browserContext.newPage();
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });

    const outcome = await captureRealPageVisibilityCycle(page, { timeoutMs: 2_000, pollIntervalMs: 20 });
    const result = {
      schemaVersion: 1,
      status: outcome.status,
      runnerPassMeaning: "RunContext PASS means the diagnostic harness completed and cleaned up; it does not mean the visibility cycle passed",
      diagnosticOnly: true,
      claimBoundary: "headful desktop Chromium under owned Xvfb; does not establish Android/iOS WebView or native AppState behavior",
      launch: {
        headless: launcher.headless,
        display: launcher.display,
        xauthorityProvided: true,
        backgroundSchedulingFlagsUnchanged: true,
        syntheticVisibilityEventDispatched: outcome.syntheticVisibilityEventDispatched,
      },
      pageCountAtStart: 1,
      visibilityCycle: outcome,
    };
    await runContext.writeArtifactJson("headful-two-tab-visibility-diagnostic.json", result);
    assert.equal(launcher.headless, false, "diagnostic must actually use headful Chromium");
    assert.equal(launcher.display, display.display, "Chromium must use the owned Xvfb display");
    return result;
  } finally {
    if (browserContext) await browserContext.close().catch(() => {});
    await launcher.close();
  }
});
