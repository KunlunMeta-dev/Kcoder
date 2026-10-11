import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { startChromium } from "./chromium.mjs";
import { RunContext } from "./run-context.mjs";

const chromiumAvailable = process.platform === "linux" && process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX === "1";

test("system Chromium uses a run-owned profile, OS-selected CDP port and owned process group", {
  skip: chromiumAvailable ? false : "需要在隔离 VM 中显式设置 KCODER_E2E_CHROMIUM_NO_SANDBOX=1",
}, async () => {
  const context = await RunContext.create(import.meta.url, {
    testId: "chromium-harness-lifecycle",
    modelPolicy: "model-independent browser lifecycle check",
  });
  let failure;
  try {
    const browser = await startChromium(context);
    assert.equal(browser.executablePath, process.env.KCODER_E2E_CHROMIUM_BIN || "/usr/bin/chromium");
    assert.ok(Number.isInteger(browser.cdpPort) && browser.cdpPort > 0);
    assert.equal(context.ports.find(port => port.label === "chromium-cdp")?.port, browser.cdpPort);
    assert.ok(browser.profileDir.startsWith(context.stateDir));

    const page = await browser.newPage();
    await page.setContent("<main id='probe'>真实 Chromium</main>");
    assert.equal(await page.locator("#probe").textContent(), "真实 Chromium");
    await browser.close();
  } catch (error) {
    failure = error;
  }
  await context.finish(failure ? "failed" : "passed", { verified: !failure }, failure);
  if (failure) throw failure;

  const manifest = JSON.parse(await readFile(`${context.runRoot}/manifest.json`, "utf8"));
  assert.equal(manifest.status, "passed");
  assert.equal(manifest.processes.find(process => process.label === "chromium")?.stopped, true);
  await assert.rejects(access(`${context.runRoot}/state`));
});
