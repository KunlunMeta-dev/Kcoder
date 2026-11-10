import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runE2E, repoRoot, waitFor } from "../harness/run-context.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { buildRecoveryFixture } from "../fixtures/mobile-send-recovery/build.mjs";
import { startRecoveryFixture } from "../fixtures/mobile-send-recovery/server.mjs";
import { captureMobileExportSourceSnapshot } from "../harness/mobile-export-source-snapshot.mjs";
import { groups, concepts, documentStates, libraryStates, recoveryStates, flows, backlog, state } from "./catalog.mjs";
import { aiBrief, handoff, indexPage, statePage } from "./pages.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = path => readFile(path, "utf8").then(JSON.parse);
const optional = async path => { try { return await readFile(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
const relativeSource = path => relative(repoRoot, path).split("\\").join("/");

async function successfulLibrary() {
  const root = resolve(repoRoot, "target/test/apps/kcoder-studio/e2e/suites/mobile/mobile-v3-library.e2e.mjs");
  const candidates = [];
  for (const name of await readdir(root)) {
    try {
      const dir = resolve(root, name), manifest = await json(resolve(dir, "manifest.json"));
      if (manifest.status !== "passed") continue;
      if (!await optional(resolve(dir, "artifacts/375-zh-CN-light-history-v3.png"))) continue;
      candidates.push({ dir, manifest });
    } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  }
  candidates.sort((a, b) => b.manifest.endedAt.localeCompare(a.manifest.endedAt));
  assert.ok(candidates.length, "A completed synthetic V3 library capture is required");
  return candidates[0];
}

async function routeInventory() {
  const base = resolve(repoRoot, "apps/kcoder-studio/mobile/src/app");
  return (await readdir(base, { recursive: true })).filter(name => name.endsWith(".tsx") && !name.includes("__tests__") &&
    !name.split("/").at(-1).startsWith("_") && !name.split("/").at(-1).startsWith("+")).sort();
}

process.umask(0o077);
await runE2E(import.meta.url, {
  testId: "mobile-design-atlas-v1", tier: "manual-live", retainSuccessLogs: true,
  modelPolicy: "Synthetic static design handoff: actual frozen recovery components plus attributed existing screenshots; no personal sessions, Gateway, model calls or production writes",
}, async run => {
  const out = run.pathInArtifacts("kcoder-design-atlas-v1");
  for (const folder of ["images", "states", "briefs"]) await mkdir(resolve(out, folder), { recursive: true });
  const reused = process.env.KCODER_DESIGN_ATLAS_RECOVERY_EXPORT;
  let built;
  if (reused) {
    const source = await captureMobileExportSourceSnapshot({ snapshotRoot: run.pathInState("frozen-source"), layout: "preflight-source-root", freezeFiles: true,
      sourceRoots: [
        { name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
        { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" },
      ] });
    const prior = await json(resolve(reused, "../../../frozen-mobile-source.json"));
    assert.deepEqual(source.files, prior.files, "Reused component export must match the current source inputs");
    built = { output: resolve(reused), source };
    await run.writeArtifactJson("frozen-mobile-source.json", source);
  } else built = await buildRecoveryFixture(run);
  const fixtureUrl = await startRecoveryFixture(run, built.output);
  const browser = await startChromium(run, { label: "design-atlas-browser", noSandbox: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const pageErrors = [], forbidden = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("request", request => { if (/\/(api|rpc)(\/|$)/.test(new URL(request.url()).pathname)) forbidden.push(new URL(request.url()).pathname); });
  const states = [], skipped = [];
  async function addImage(item, path, label, metadata = {}) {
    const bytes = await optional(path);
    if (!bytes) return false;
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `PNG required: ${relativeSource(path)}`);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    const name = `${item.id}-${item.variants.length + 1}.png`, image = `images/${name}`;
    await writeFile(resolve(out, image), bytes);
    item.variants.push({ image, label, width, height, sha256: sha(bytes), source: relativeSource(path), ...metadata });
    return true;
  }
  const docAssets = resolve(repoRoot, "docs/phone/diff/assets");
  for (const definition of documentStates) {
    const date = definition.image.split("/")[0].slice(0, 10);
    const item = { ...definition, variants: [], captureDate: date,
      freshness: date < new Date().toISOString().slice(0, 10) ? "历史采样" : definition.freshness,
      evidence: "既有合成数据验收截图" };
    if (!await addImage(item, resolve(docAssets, definition.image), "原始采样")) { skipped.push({ id: item.id, reason: "Screenshot source is missing", source: definition.image }); continue; }
    const match = definition.image.match(/^(.*\/)(390-zh-CN-light|375-zh-CN-light)(.*)$/);
    if (match) for (const variant of ["320-zh-CN-dark", "390-en-dark", "320-en-light"])
      await addImage(item, resolve(docAssets, `${match[1]}${variant}${match[3]}`), variant);
    delete item.image; states.push(item);
  }
  const library = await successfulLibrary();
  const librarySource = await json(resolve(library.dir, "artifacts/frozen-source.json"));
  for (const [id, title, group, suffix, condition, version = "V3"] of libraryStates) {
    const item = { ...state(id, title, group, "", { condition, version }), variants: [], captureDate: library.manifest.endedAt.slice(0, 10),
      evidence: "隔离 Gateway 的已完成合成会话采样", freshness: "既有采样", rendererTreeSha256: librarySource.sourceTreeSha256,
      recipe: group === "history" ? "sessions.tsx / session-filters.tsx" : "ConversationPreferencesSettings.tsx / index.tsx" };
    for (const prefix of ["375-zh-CN-light", "390-zh-CN-light", "320-zh-CN-dark", "390-en-dark", "320-en-light"])
      await addImage(item, resolve(library.dir, `artifacts/${prefix}-${suffix}.png`), prefix);
    if (!item.variants.length) { skipped.push({ id, reason: "No completed capture for this state" }); continue; }
    delete item.image; states.push(item);
  }
  const fixtureCases = [
    { width: 390, theme: "light", language: "zh-CN" },
    { width: 320, theme: "dark", language: "zh-CN" },
    { width: 390, theme: "dark", language: "en" },
    { width: 320, theme: "light", language: "en" },
  ];
  const sampledAt = new Date().toISOString();
  for (const [index, [phase, title, kind, condition]] of recoveryStates.entries()) {
    const item = { ...state(`SEND-${phase}`, title, "recovery", "", { kind, condition }), variants: [], captureDate: sampledAt.slice(0, 10),
      freshness: "本次组件采样", evidence: "真实 TaskComposer 的冻结组件状态", rendererTreeSha256: built.source.sourceTreeSha256,
      recipe: "TaskComposer.tsx / failedTaskSubmissions.ts" };
    for (const scenario of fixtureCases) {
      await page.setViewportSize({ width: scenario.width, height: 844 });
      await page.goto(`${fixtureUrl}?${new URLSearchParams({ state: phase, ...scenario })}`, { waitUntil: "networkidle" });
      await page.getByTestId("send-recovery-fixture").waitFor({ timeout: 20_000 });
      await page.evaluate(async () => { await document.fonts.ready; document.activeElement?.blur(); });
      const card = page.getByTestId("failed-submission");
      if (phase === "none") assert.equal(await card.count(), 0);
      else await card.waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${phase}/${scenario.width} overflow`);
      if (scenario === fixtureCases[0]) {
        const input = await page.getByTestId("message-input-root").boundingBox();
        item.hotspots = [];
        if (phase !== "none") { const box = await card.boundingBox(); item.hotspots.push([box.x / 390 * 100, box.y / 844 * 100, box.width / 390 * 100, box.height / 844 * 100, "发送恢复记录", "本机恢复信息，不等于后端队列；不同阶段对应不同的核对或恢复动作。"]); }
        item.hotspots.push([input.x / 390 * 100, input.y / 844 * 100, input.width / 390 * 100, input.height / 844 * 100, "输入区", "这里的新草稿与恢复卡片中的旧问题分开保留。"]);
      }
      const label = `${scenario.width}-${scenario.language}-${scenario.theme}`;
      const path = run.pathInArtifacts(`fresh-${phase}-${label}.png`);
      await page.screenshot({ path }); await addImage(item, path, label, { fixtureState: phase });
    }
    delete item.image; states.push(item);
    console.log(`[design-atlas] ${index + 1}/7 frozen recovery state: ${phase}`);
  }
  assert.deepEqual(pageErrors, [], "Component export must not produce page errors");
  assert.deepEqual(forbidden, [], "The design export must not call a Gateway or API");
  assert.equal(new Set(states.map(s => s.id)).size, states.length);
  for (const item of states) item.aiBrief = aiBrief(item, concepts);
  const data = { edition: "01", createdAt: `${new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(new Date())} UTC+08:00`,
    createdAtUtc: new Date().toISOString(), states, groups, concepts, flows, backlog, skipped, routes: await routeInventory(),
    imageCount: states.reduce((sum, s) => sum + s.variants.length, 0), freshCount: states.filter(s => s.freshness === "本次组件采样").length };
  const css = await readFile(resolve(sourceDir, "atlas.css"), "utf8"), js = await readFile(resolve(sourceDir, "atlas.js"), "utf8");
  await writeFile(resolve(out, "index.html"), indexPage(data, css, js));
  for (const item of states) {
    await writeFile(resolve(out, `states/${item.id}.html`), statePage(item, concepts, css));
    await writeFile(resolve(out, `briefs/${item.id}.md`), item.aiBrief);
  }
  const intro = handoff(data);
  await writeFile(resolve(out, "START_HERE.md"), intro);
  await writeFile(resolve(out, "DESIGN_BRIEF.md"), intro);
  await writeFile(resolve(out, "catalog.json"), JSON.stringify(data, null, 2));
  const provenance = { generatedAt: data.createdAtUtc, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    recoverySourceTreeSha256: built.source.sourceTreeSha256, librarySourceTreeSha256: librarySource.sourceTreeSha256,
    libraryCapture: relativeSource(library.dir), screenshotPolicy: "Explicit allowlist of synthetic test captures; original dates and unknown revision bindings retained",
    files: states.flatMap(s => s.variants.map(v => ({ state: s.id, ...v }))), skipped };
  await writeFile(resolve(out, "provenance.json"), JSON.stringify(provenance, null, 2));
  const csv = rows => rows.map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  await writeFile(resolve(out, "coverage.csv"), "\uFEFF" + csv([["领域", "状态", "采样状态", "源码线索"], ...backlog.map(([name, missing, source]) => [name, missing, "待补充", source])]));
  await writeFile(resolve(out, "feedback-template.csv"), "\uFEFF" + csv([["状态编号", "变体", "区域", "问题", "建议", "是否改变行为"], ["SEND-unknown", "390-zh-CN-light", "恢复卡片", "", "", ""]]));

  // Verify the delivered site over file:// with all network access blocked.
  const blocked = [];
  await page.route(/^https?:\/\//, route => { blocked.push(route.request().url()); return route.abort(); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(pathToFileURL(resolve(out, "index.html")).href, { waitUntil: "load" });
  await page.getByRole("heading", { name: "让每一种状态，都能被看懂。" }).waitFor();
  assert.ok(await page.locator(".card").count() > 10);
  await page.screenshot({ path: run.pathInArtifacts("atlas-overview.png"), fullPage: false });
  await page.getByRole("searchbox").fill("SEND-unknown");
  assert.equal(await page.locator(".card").count(), 1);
  await page.locator(".card").click();
  await page.getByRole("dialog").getByRole("heading", { name: "发送结果待核对", exact: true }).waitFor();
  assert.equal(await page.locator(".dialog .phone img").evaluate(node => node.complete && node.naturalWidth > 0), true);
  await page.getByLabel("选择截图变体").selectOption("1");
  await page.getByLabel("注释", { exact: true }).uncheck();
  assert.equal(await page.locator(".hotspot:visible").count(), 0);
  const previewBox = await page.locator(".dialog .phone").boundingBox(), dialogBox = await page.getByRole("dialog").boundingBox();
  assert.ok(previewBox.y + previewBox.height < dialogBox.y + dialogBox.height, "Desktop preview keeps the complete phone state visible");
  await page.screenshot({ path: run.pathInArtifacts("atlas-detail.png"), fullPage: false });
  const standalone = page.waitForEvent("popup");
  await page.getByRole("link", { name: "独立说明页 ↗" }).click();
  const detail = await standalone;
  await detail.getByRole("heading", { name: "发送结果待核对", exact: true }).waitFor();
  assert.equal(await detail.locator("img").first().evaluate(node => node.complete && node.naturalWidth > 0), true);
  await detail.close(); await page.getByRole("button", { name: "关闭状态详情" }).click();
  for (const name of ["操作路径", "关键概念", "覆盖与缺口"]) { await page.getByRole("tab", { name }).click(); assert.ok((await page.locator("#content").innerText()).length > 100); }
  await page.getByRole("tab", { name: "状态图册" }).click();
  await page.getByRole("searchbox").fill(""); await page.getByLabel("界面版本", { exact: true }).selectOption("all");
  await page.getByLabel("包括历史采样").check(); assert.equal(await page.locator(".card").count(), states.length);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: run.pathInArtifacts("atlas-mobile.png"), fullPage: false });
  await run.writeArtifactJson("atlas-mobile-layout.json", await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
    outside: [...document.querySelectorAll("body *")].filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 20)
      .map(node => ({ tag: node.tagName, class: String(node.className), width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right })) })));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "Atlas navigation must fit mobile width");
  assert.deepEqual(blocked, [], "Offline atlas must not request any network resource");
  assert.deepEqual(pageErrors, []);
  await run.writeArtifactJson("atlas-validation.json", { states: states.length, pngs: data.imageCount, freshStates: data.freshCount, offline: true, standalone: true,
    search: true, variants: true, annotations: true, tabs: true, mobileOverflow: false, pageErrors, forbiddenRequests: forbidden, skipped });
  const archive = run.pathInArtifacts("kcoder-design-atlas-v1.zip");
  const zip = run.spawnOwned("design-atlas-zip", "python3", ["-c", "import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:\n for f in sorted(p.rglob('*')):\n  if f.is_file(): z.write(f,str(pathlib.Path(p.name)/f.relative_to(p)))", out, archive]);
  await waitFor(() => zip.exitCode !== null, 60_000, "design atlas zip"); assert.equal(zip.exitCode, 0);
  const delivery = process.env.KCODER_DESIGN_ATLAS_DELIVERY;
  if (delivery) {
    const destination = resolve(delivery); assert.ok(destination.startsWith("/home/hyf/.codex/visualizations/"), "Delivery copies belong in the task visualization directory");
    await mkdir(destination, { recursive: true });
    await cp(out, resolve(destination, "kcoder-design-atlas-v1"), { recursive: true });
    await cp(archive, resolve(destination, "kcoder-design-atlas-v1.zip"));
    await cp(run.pathInArtifacts("atlas-overview.png"), resolve(destination, "atlas-overview.png"));
  }
  console.log(`[design-atlas] ${states.length} states / ${data.imageCount} PNGs / ${data.freshCount} freshly rendered states`);
  return { out, archive, states: states.length, pngs: data.imageCount, freshStates: data.freshCount, skipped, offline: true };
});
