import assert from "node:assert/strict";
import { runE2E } from "../../harness/run-context.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { buildRecoveryFixture } from "../../fixtures/mobile-send-recovery/build.mjs";
import { startRecoveryFixture } from "../../fixtures/mobile-send-recovery/server.mjs";

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-send-recovery-presentation", tier: "full-integration", retainSuccessLogs: true,
  modelPolicy: "Model-independent frozen recovery states in actual V3 composer; no Gateway or provider",
}, async run => {
  const publicUrl = process.env.KCODER_E2E_RECOVERY_PUBLIC_URL;
  if (publicUrl && process.env.KCODER_E2E_RECOVERY_PUBLIC_REVIEW !== "1") throw new Error("Public review requires explicit opt-in");
  const built = !publicUrl && !process.env.KCODER_E2E_RECOVERY_FIXTURE_EXPORT ? await buildRecoveryFixture(run) : null;
  const url = publicUrl || await startRecoveryFixture(run, process.env.KCODER_E2E_RECOVERY_FIXTURE_EXPORT || built.output);
  const browser = await startChromium(run, { label: "send-recovery-browser", noSandbox: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [], traffic = [], failures = [], results = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { const path = new URL(request.url()).pathname; if (/\/(rpc|api)(\/|$)/.test(path)) traffic.push(path); });
  page.on("response", response => { if (response.status() >= 400) failures.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  await page.addInitScript(() => localStorage.setItem("recovery-fixture-storage-sentinel", "untouched"));
  const matrix = [
    { width: 390, theme: "light", language: "zh-CN" }, { width: 320, theme: "dark", language: "zh-CN" },
    { width: 390, theme: "dark", language: "en" }, { width: 320, theme: "light", language: "en" },
  ];
  for (const scenario of matrix) {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    const tones = new Map();
    for (const state of ["none", "preparing", "retaining", "sending", "accepted", "unknown", "failed"]) {
      await page.goto(`${url}?${new URLSearchParams({ ...scenario, state })}`, { waitUntil: "networkidle" });
      try { await page.getByTestId("send-recovery-fixture").waitFor({ timeout: 10_000 }); }
      catch (error) {
        await run.writeArtifactJson("page-failure.json", { errors, failures, text: await page.locator("body").innerText() });
        await page.screenshot({ path: run.pathInArtifacts("page-failure.png") });
        throw error;
      }
      assert.equal(await page.getByTestId("send-message").isDisabled(), true);
      if (state === "none") { assert.equal(await page.getByTestId("failed-submission").count(), 0); continue; }
      const card = page.getByTestId("failed-submission");
      const title = page.getByTestId("submission-recovery-title");
      const text = await title.innerText();
      const tone = await title.evaluate(node => getComputedStyle(node).color);
      const border = await card.evaluate(node => getComputedStyle(node).borderTopColor);
      tones.set(state, { tone, border });
      const pending = ["preparing", "retaining", "sending"].includes(state);
      assert.equal(await page.getByTestId("dismiss-failed-submission").isDisabled(), pending);
      if (pending) {
        assert.equal(await card.getByRole("progressbar").count(), 1);
        assert.equal(await page.getByTestId(state === "sending" ? "verify-failed-submission" : "retry-failed-submission").isDisabled(), true);
      }
      if (state === "retaining") {
        assert.ok(text.includes(scenario.language === "en" ? "Preparing message" : "正在准备消息"));
        assert.equal(text.includes(scenario.language === "en" ? "attachment" : "附件"), false);
        await page.getByTestId("message-input").fill(scenario.language === "en" ? "A newer draft" : "下一条草稿");
        await page.getByTestId("failed-submission-content").getByText("1+1=", { exact: true }).waitFor();
        assert.equal(await page.getByTestId("failed-submission-error").count(), 0);
      }
      if (state === "accepted") {
        assert.equal(await page.getByTestId("retry-failed-submission").count(), 0);
        assert.equal(await page.getByTestId("verify-failed-submission").isEnabled(), true);
      }
      const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].flatMap(node => {
        const rect = node.getBoundingClientRect();
        return rect.right > innerWidth + 1 ? [{ tag: node.tagName, id: node.getAttribute("data-testid"), text: node.textContent?.slice(0, 60), right: rect.right }] : [];
      }));
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
        await run.writeArtifactJson("overflow.json", { scenario, state, overflow });
        await page.screenshot({ path: run.pathInArtifacts("overflow.png") });
        assert.fail(`${scenario.width}/${scenario.language}/${state} horizontal overflow`);
      }
      if (["retaining", "unknown", "failed"].includes(state)) {
        await page.evaluate(() => document.activeElement?.blur()); await page.waitForTimeout(300);
        await page.screenshot({ path: run.pathInArtifacts(`${scenario.width}-${scenario.language}-${scenario.theme}-${state}.png`) });
      }
      results.push({ ...scenario, state, text, tone, border });
    }
    for (const state of ["preparing", "retaining", "sending", "accepted"]) {
      assert.notEqual(tones.get(state).tone, tones.get("failed").tone, "Normal progress must not have error text color");
      assert.notEqual(tones.get(state).border, tones.get("failed").border, "Normal progress must not have an error border");
    }
    assert.notEqual(tones.get("unknown").tone, tones.get("failed").tone, "Unknown receipt is a warning, not confirmed failure");
  }
  await page.goto(`${url}?state=retaining`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000); await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("submission-recovery-title").getByText("正在准备消息，恢复记录已保存", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("recovery-fixture-storage-sentinel")), "untouched");
  assert.equal(await page.evaluate(() => localStorage.getItem("kcoder-studio:mobile-app-preferences:v1")), null);
  assert.deepEqual(traffic, []); assert.deepEqual(errors, []); assert.deepEqual(failures, []);
  await run.writeArtifactJson("state-matrix.json", results);
  return { cases: results.length + matrix.length, stableAfterReload: true, noBackendRequests: true, noProductionStorageWrites: true,
    output: built?.output, errors, failures };
});
