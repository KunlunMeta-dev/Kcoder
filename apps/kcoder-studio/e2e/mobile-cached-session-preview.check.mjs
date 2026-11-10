import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runE2E, waitFor } from "./harness/run-context.mjs";
import { startChromium } from "./harness/chromium.mjs";

process.umask(0o077);
const runRoot = resolve(process.argv[2] || "");
const origin = process.env.KCODER_CACHE_FIXTURE_ORIGIN || "https://hyf2333.top";
const prefix = "/fixtures/mobile-cache-20261018";
await runE2E(import.meta.url, {
  testId: "mobile-cached-session-fixture-browser", tier: "manual-live", modelPolicy: "model-independent",
}, async run => {
  const { token } = JSON.parse(await readFile(resolve(runRoot, "state/access.json"), "utf8"));
  run.registerSecret(token);
  const launcher = await startChromium(run, { label: "cache-fixture-browser", noSandbox: true });
  const page = await launcher.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  const backendRequests = [];
  const websockets = [];
  const foreignRequests = [];
  const failedResponses = [];
  let navigations = 0;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    const path = url.pathname;
    if (["https:", "http:"].includes(url.protocol) && url.origin !== origin) foreignRequests.push(url.origin + path);
    if (/\/(api|rpc)(\/|$)/.test(path)) backendRequests.push(path);
  });
  page.on("response", response => { if (response.status() >= 400) failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
  page.on("websocket", ws => websockets.push({ url: new URL(ws.url()).pathname, secure: ws.url().startsWith("wss:") }));
  const login = options => `${origin}${prefix}/login?${new URLSearchParams({ token, ...options })}`;
  const cache = page.getByTestId("session-cache-view");
  const cases = [
    { width: 390, theme: "dark", language: "zh-CN" },
    { width: 320, theme: "light", language: "zh-CN" },
    { width: 390, theme: "light", language: "en" },
    { width: 320, theme: "dark", language: "en", state: "offline", history: "short", draft: "empty" },
  ];
  for (const item of cases) {
    await page.setViewportSize({ width: item.width, height: 844 });
    await page.goto(login(item), { waitUntil: "domcontentloaded", timeout: 120_000 });
    await cache.waitFor({ state: "visible", timeout: 90_000 });
    await page.getByTestId("cached-session-composer").waitFor({ state: "visible" });
    assert.equal(await page.getByTestId("cached-session-model-selector").isDisabled(), true);
    assert.equal(await page.getByTestId("cached-session-permission-selector").isDisabled(), true);
    assert.equal(await page.getByTestId("send-message").isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(run.artifactsDir, `${item.width}-${item.language}-${item.theme}.png`) });
    assert.equal(await page.getByTestId("message-edit-last").count(), 0);
    assert.equal(await page.getByTestId("message-fork").count(), 0);
    await page.getByTestId("task-search").click();
    const short = item.history === "short";
    await page.getByTestId("transcript-search-input").fill(short ? "sample history" : item.language === "en" ? "Hello" : "你好");
    await waitFor(async () => await page.getByTestId("transcript-search-count").innerText() === (short ? "1/1" : "1/2"), 10_000, "cached body search count");
    if (!short) {
      const target = page.locator('[id="message-fixture-user-0"]');
      await waitFor(async () => {
        const row = await target.boundingBox(); const list = await page.getByTestId("message-list").boundingBox();
        return row && list && row.y >= list.y - 1 && row.y < list.y + list.height;
      }, 10_000, "search jumps to an earlier cached message");
      await page.getByTestId("transcript-search-next").click();
      assert.equal(await page.getByTestId("transcript-search-count").innerText(), "2/2");
      await page.getByTestId("transcript-search-previous").click();
      assert.equal(await page.getByTestId("transcript-search-count").innerText(), "1/2");
    }
    await page.screenshot({ path: resolve(run.artifactsDir, `search-${item.width}-${item.language}-${item.theme}.png`) });
    await page.getByTestId("transcript-search-close").click();
  }
  await page.goto(login({ theme: "dark" }), { waitUntil: "domcontentloaded", timeout: 120_000 });
  await cache.waitFor({ state: "visible" });
  await page.waitForTimeout(5000);
  assert.equal(await cache.isVisible(), true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await cache.waitFor({ state: "visible" });
  const beforeNavigations = navigations;
  const historyFile = new URL("./fixtures/mobile-cached-session/history.ts", import.meta.url);
  const original = await readFile(historyFile, "utf8");
  assert(original.includes('"移动端会话布局"'));
  try {
    await writeFile(historyFile, original.replace('"移动端会话布局"', '"移动端会话布局 · 热更新校验"'));
    await page.getByText("移动端会话布局 · 热更新校验", { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(navigations, beforeNavigations, "HMR must update without navigating away from the cached page");
  } finally {
    await writeFile(historyFile, original);
  }
  await page.getByText("移动端会话布局", { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await cache.isVisible(), true);
  assert.equal(backendRequests.length, 0, "Fixture must not connect to a real Gateway or model");
  assert.deepEqual(foreignRequests, [], "Resources must stay inside the fixture origin");
  assert.deepEqual(failedResponses, []);
  assert.deepEqual(errors, []);
  assert(websockets.some(ws => ws.url === `${prefix}/hot` && (origin.startsWith("https:") ? ws.secure : true)));
  assert(websockets.every(ws => ws.url.startsWith(`${prefix}/`)));
  return { cases, cachedBodySearch: true, readOnlyMutationActionsAbsent: true, persistentCache: true, reload: true, hotUpdateWithoutNavigation: true, backendRequests, foreignRequests, failedResponses, errors, websockets };
});
