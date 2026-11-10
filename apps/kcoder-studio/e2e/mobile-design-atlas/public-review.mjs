import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { runE2E } from "../harness/run-context.mjs";
import { startChromium } from "../harness/chromium.mjs";

process.umask(0o077);
if (process.env.KCODER_ATLAS_PUBLIC_REVIEW !== "1") throw new Error("Public atlas review requires explicit opt-in");
await runE2E(import.meta.url, { testId: "design-atlas-public-encrypted-access", tier: "manual-live", retainSuccessLogs: true,
  modelPolicy: "User-authorized static public atlas access only; owned browser, no Gateway, user session or model" }, async run => {
  const access = JSON.parse(await readFile(process.env.KCODER_ATLAS_ACCESS_FILE, "utf8"));
  const linkOnly = process.env.KCODER_ATLAS_LINK_ONLY === "1";
  const password = linkOnly ? "" : (await readFile(process.env.KCODER_ATLAS_PASSWORD_FILE, "utf8")).trim();
  const login = new URL(access.url), token = new URLSearchParams(login.hash.slice(1)).get("token");
  assert.equal(login.origin, "https://49.234.36.54:8451");
  assert.equal(login.pathname, "/fixtures/mobile-design-atlas-v1/login");
  assert.ok(token); run.registerSecret(token); run.registerSecret(access.url);
  if (password.length >= 8) run.registerSecret(password);
  const root = `${login.origin}/fixtures/mobile-design-atlas-v1/`;
  for (const file of ["", "images/SEND-unknown-1.png", "catalog.json", "kcoder-design-atlas-v1.zip"]) {
    const response = await fetch(root + file); assert.equal(response.status, 401, `Unauthenticated ${file || "index"} must be protected`);
  }
  const browser = await startChromium(run, { label: "atlas-public-browser", noSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], traffic = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol)) traffic.push(url.pathname); });
  const heading = () => page.getByRole("heading", { name: "让每一种状态，都能被看懂。", exact: true });
  if (!linkOnly) {
    await page.goto(root + "login", { waitUntil: "load" });
    await page.getByLabel("访问口令", { exact: true }).fill(password);
    await page.getByRole("button", { name: "打开图册", exact: true }).click();
    await heading().waitFor({ timeout: 30_000 });
    const cookies = await page.context().cookies(root);
    assert.ok(cookies.some(cookie => cookie.name === "__Secure-kcoder-design-atlas-v1" && cookie.secure && cookie.httpOnly && cookie.sameSite === "Strict"));
    await page.context().clearCookies();
  }
  await page.goto(access.url, { waitUntil: "load" });
  await heading().waitFor({ timeout: 30_000 });
  assert.equal(page.url(), root, "Encrypted credential is removed after the one-click login");
  const linkCookies = await page.context().cookies(root);
  assert.ok(linkCookies.some(cookie => cookie.name === "__Secure-kcoder-design-atlas-v1" && cookie.secure && cookie.httpOnly && cookie.sameSite === "Strict"));
  const published = await page.evaluate(() => ({ edition: window.ATLAS.edition, states: window.ATLAS.states.length,
    pngs: window.ATLAS.imageCount, added: window.ATLAS.addedCount ?? 0 }));
  if (process.env.KCODER_ATLAS_EXPECT_EDITION) assert.equal(published.edition, process.env.KCODER_ATLAS_EXPECT_EDITION);
  if (["03", "04", "05"].includes(published.edition)) {
    assert.equal(await page.locator(".card").count(), published.states);
    const provenance = await page.evaluate(() => ({ onlyV3: window.ATLAS.v3Only,
      fresh: window.ATLAS.states.every(s => s.version === "V3" && s.freshness === "本次组件采样" &&
        s.rendererTreeSha256 === window.ATLAS.rendererTreeSha256 && s.variants.every(v => v.source.startsWith("current-fixture/App.tsx?"))) }));
    assert.deepEqual(provenance, { onlyV3: true, fresh: true });
    assert.equal(await page.getByLabel("界面版本", { exact: true }).locator("option").count(), 1);
    for (const file of ["images/PROJECT-01-1.png", "states/CONNECT-01.html"]) {
      assert.equal(await page.evaluate(async file => (await fetch(file)).status, file), 404, "Archived states must not remain publicly reachable");
    }
    await page.getByRole("searchbox").fill("GOAL-01"); await page.locator('.card[data-state="GOAL-01"]').click();
    await page.getByRole("dialog").getByRole("heading", { name: "Goal 运行中", exact: true }).waitFor();
    await page.getByRole("button", { name: "关闭状态详情", exact: true }).click();
  }
  if (published.edition === "05") {
    const count = await page.evaluate(() => window.ATLAS.states.filter(s => s.transition?.from.length && s.transition?.trigger.steps.length && s.transition?.next.length).length);
    assert.equal(count, published.states);
    await page.getByRole("searchbox").fill("AGENT-01"); await page.locator('.card[data-state="AGENT-01"]').click();
    await page.locator('[data-transition="AGENT-01"]').waitFor();
    await page.getByRole("dialog").locator('.next-states a[data-state="AGENT-09"]').click();
    await page.locator('[data-transition="AGENT-09"]').waitFor();
    await page.screenshot({ path: run.pathInArtifacts("public-atlas-trigger-chain.png") });
    await page.getByRole("button", { name: "关闭状态详情", exact: true }).click();
  }
  if (process.env.KCODER_ATLAS_EXPECT_PACK) {
    for (const file of ["index.html", "catalog.json"]) {
      const local = await readFile(resolve(process.env.KCODER_ATLAS_EXPECT_PACK, file));
      const actual = await page.evaluate(async file => Array.from(new Uint8Array(await (await fetch(file)).arrayBuffer())), file);
      assert.equal(createHash("sha256").update(Buffer.from(actual)).digest("hex"), createHash("sha256").update(local).digest("hex"), `Public ${file} must match the verified local pack`);
    }
  }
  if (published.edition === "02") {
    assert.equal(await page.locator(".card").count(), published.states);
    await page.getByRole("tab", { name: "本次新增", exact: true }).click();
    assert.equal(await page.locator(".card").count(), published.added);
    for (const [id, title] of [["GOAL-01", "Goal 常驻状态和控制"], ["AGENT-01", "子代理提问与父会话定位"]]) {
      await page.getByRole("searchbox").fill(id); await page.locator(`.card[data-state="${id}"]`).click();
      await page.getByRole("dialog").getByRole("heading", { name: title, exact: true }).waitFor();
      await page.getByRole("button", { name: "关闭状态详情", exact: true }).click();
    }
    await page.getByRole("tab", { name: "状态图册", exact: true }).click();
  }
  await page.getByRole("searchbox").fill("SEND-unknown"); await page.locator('.card[data-state="SEND-unknown"]').click();
  await page.getByRole("dialog").getByRole("heading", { name: "发送结果待核对", exact: true }).waitFor();
  await page.screenshot({ path: run.pathInArtifacts("public-atlas-authenticated.png") });
  const hashes = await page.evaluate(async () => {
    const files = window.ATLAS.states.flatMap(state => state.variants);
    const results = [];
    for (let i = 0; i < files.length; i += 4) {
      results.push(...await Promise.all(files.slice(i, i + 4).map(async file => {
        const response = await fetch(file.image); const bytes = await response.arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
        return { image: file.image, status: response.status, matches: hash === file.sha256 };
      })));
    }
    return results;
  });
  assert.equal(hashes.length, published.pngs); assert.ok(hashes.every(item => item.status === 200 && item.matches));
  for (const file of ["catalog.json", "states/SEND-unknown.html", "briefs/SEND-unknown.md", "kcoder-design-atlas-v1.zip"]) {
    assert.equal(await page.evaluate(async file => (await fetch(file)).status, file), 200);
  }
  assert.ok(traffic.every(path => path.startsWith("/fixtures/mobile-design-atlas-v1/")), "Only dedicated atlas resources may be requested");
  assert.deepEqual(errors, []);
  await run.writeArtifactJson("public-access-verification.json", { root, passwordLogin: !linkOnly, matchesExpectedPack: Boolean(process.env.KCODER_ATLAS_EXPECT_PACK), triggerChains: published.edition === "05" ? published.states : 0, encryptedLink: true, urlCredentialRemoved: true,
    secureHttpOnlyCookie: true, deniedWithoutLogin: true, screenshotHashes: hashes, pageErrors: errors, tlsVerification: "normal browser and Node defaults", linkExpiresAt: access.expiresAt });
  return { root, ...published, protectedPNGs: hashes.length, passwordLogin: !linkOnly, encryptedOneClick: true, pageErrors: errors };
});
