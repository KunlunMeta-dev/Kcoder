import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runE2E, repoRoot, waitFor } from "../harness/run-context.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { incrementalStates, incrementalGroups, incrementalConcepts, incrementalFlows, remainingGaps } from "./incremental-catalog.mjs";
import { aiBrief, indexPage, statePage, handoff } from "./pages.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
process.umask(0o077);
await runE2E(import.meta.url, { testId: "mobile-design-atlas-increment-02", tier: "manual-live", retainSuccessLogs: true,
  modelPolicy: "Static synthetic historical capture curation only; no new product processes, personal sessions, Gateway or provider calls" }, async run => {
  const base = resolve(process.env.KCODER_ATLAS_BASE_PACK);
  assert.ok(base.startsWith("/home/hyf/.codex/visualizations/") || base.startsWith(resolve(repoRoot, "target/test") + "/"));
  const prior = JSON.parse(await readFile(resolve(base, "catalog.json"), "utf8"));
  assert.equal(prior.edition, "01", "Increment 02 starts from the delivered first edition");
  const out = run.pathInArtifacts("kcoder-design-atlas-v1");
  for (const folder of ["images", "states", "briefs"]) await mkdir(resolve(out, folder), { recursive: true });
  for (const item of prior.states) for (const variant of item.variants) {
    assert.match(variant.image, /^images\/[A-Za-z0-9_-]+\.png$/);
    const bytes = await readFile(resolve(base, variant.image)); assert.equal(sha(bytes), variant.sha256);
    await writeFile(resolve(out, variant.image), bytes);
  }
  const states = prior.states.map(s => ({ ...s, freshness: s.freshness === "本次组件采样" ? "既有组件采样" : s.freshness }));
  for (const definition of incrementalStates) {
    const { image, variants: extra, ...rest } = definition;
    const item = { ...rest, variants: [], captureDate: image.split("/")[0].slice(0, 10),
      evidence: rest.evidence ?? "既有隔离合成测试截图；沿用原日期", addedIn: "02" };
    for (const [i, file] of [image, ...extra].entries()) {
      assert.match(file, /^2026-\d\d-\d\d[^/]*\/[A-Za-z0-9_.-]+\.png$/);
      const original = resolve(repoRoot, "docs/phone/diff/assets", file), bytes = await readFile(original);
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
      const destination = `images/${item.id}-${i + 1}.png`;
      await writeFile(resolve(out, destination), bytes);
      item.variants.push({ image: destination, label: file.split("/").at(-1).replace(/\.png$/, ""), width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20), sha256: sha(bytes), source: relative(repoRoot, original) });
    }
    states.push(item);
  }
  assert.equal(new Set(states.map(s => s.id)).size, states.length);
  const concepts = [...prior.concepts, ...incrementalConcepts], groups = [...prior.groups, ...incrementalGroups];
  for (const item of states) {
    assert.ok(groups.some(([id]) => id === item.group));
    assert.ok(item.concepts.every(id => concepts.some(c => c.id === id)));
    item.aiBrief = aiBrief(item, concepts);
  }
  const data = { ...prior, edition: "02", createdAtUtc: new Date().toISOString(),
    createdAt: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(new Date()) + " UTC+08:00",
    states, groups, concepts, flows: [...prior.flows, ...incrementalFlows], backlog: remainingGaps,
    imageCount: states.reduce((n, s) => n + s.variants.length, 0), freshCount: 0, componentCount: prior.freshCount,
    addedCount: incrementalStates.length, baseEdition: prior.createdAtUtc, skipped: [] };
  const css = await readFile(resolve(sourceDir, "atlas.css"), "utf8"), js = await readFile(resolve(sourceDir, "atlas.js"), "utf8");
  await writeFile(resolve(out, "index.html"), indexPage(data, css, js));
  for (const item of states) {
    await writeFile(resolve(out, `states/${item.id}.html`), statePage(item, concepts, css));
    await writeFile(resolve(out, `briefs/${item.id}.md`), item.aiBrief);
  }
  for (const name of ["START_HERE.md", "DESIGN_BRIEF.md"]) await writeFile(resolve(out, name), handoff(data));
  await writeFile(resolve(out, "catalog.json"), JSON.stringify(data, null, 2));
  await writeFile(resolve(out, "provenance.json"), JSON.stringify({ edition: "02", baseEdition: prior.createdAtUtc,
    screenshotPolicy: "Explicit reviewed synthetic evidence allowlist; no user screenshots or production data", generatedAt: data.createdAtUtc,
    newCaptures: false, files: states.flatMap(s => s.variants.map(v => ({ state: s.id, ...v }))) }, null, 2));
  const csv = rows => "\uFEFF" + rows.map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  await writeFile(resolve(out, "coverage.csv"), csv([["领域", "状态", "采样状态", "源码线索"],
    ...states.map(s => [s.group, `${s.id} ${s.title}`, `${s.freshness} / ${s.version}`, s.recipe]),
    ...remainingGaps.map(([name, missing, source]) => [name, missing, "待补采样", source])]));
  await cp(resolve(base, "feedback-template.csv"), resolve(out, "feedback-template.csv"));
  const browser = await startChromium(run, { label: "incremental-atlas-browser", noSandbox: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], network = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(/^https?:\/\//, route => { network.push(route.request().url()); return route.abort(); });
  await page.goto(pathToFileURL(resolve(out, "index.html")).href, { waitUntil: "load" });
  assert.equal(await page.locator(".card").count(), states.length, "All historical additions must be visible by default");
  await page.getByRole("tab", { name: "本次新增", exact: true }).click();
  assert.equal(await page.locator(".card").count(), incrementalStates.length);
  await page.screenshot({ path: run.pathInArtifacts("atlas-increment-02.png") });
  await page.getByRole("searchbox").fill("GOAL-01");
  assert.equal(await page.locator(".card").count(), 1); await page.locator(".card").click();
  await page.getByRole("dialog").getByRole("heading", { name: "Goal 常驻状态和控制", exact: true }).waitFor();
  assert.ok((await page.getByRole("dialog").innerText()).includes("暂停目标与停止当前回合"));
  await page.screenshot({ path: run.pathInArtifacts("atlas-goal-detail.png") });
  await page.getByRole("button", { name: "关闭状态详情" }).click();
  await page.getByRole("searchbox").fill("AGENT-01"); await page.locator(".card").click();
  await page.getByRole("dialog").getByRole("heading", { name: "子代理提问与父会话定位", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭状态详情" }).click();
  for (const name of ["操作路径", "关键概念", "覆盖与缺口"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    assert.ok((await page.locator("#content").innerText()).length > 100);
  }
  await page.getByRole("tab", { name: "状态图册", exact: true }).click();
  await page.getByRole("searchbox").fill("");
  const images = await page.evaluate(async () => {
    const files = window.ATLAS.states.flatMap(s => s.variants.map(v => v.image));
    return Promise.all(files.map(src => new Promise(resolve => { const img = new Image(); img.onload = () => resolve(true); img.onerror = () => resolve(false); img.src = src; })));
  });
  assert.ok(images.length === data.imageCount && images.every(Boolean));
  for (const definition of incrementalStates) {
    await page.goto(pathToFileURL(resolve(out, `states/${definition.id}.html`)).href, { waitUntil: "load" });
    await page.getByRole("heading", { name: definition.title, exact: true }).waitFor();
    assert.ok(await page.locator("img").first().evaluate(img => img.complete && img.naturalWidth > 0));
  }
  await page.goto(pathToFileURL(resolve(out, "index.html")).href, { waitUntil: "load" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(errors, []); assert.deepEqual(network, []);
  await run.writeArtifactJson("increment-validation.json", { edition: "02", states: states.length, added: data.addedCount, pngs: data.imageCount,
    allVisibleByDefault: true, imageLoads: images.length, standalonePages: incrementalStates.length, pageErrors: errors, network, nativeVerified: false });
  const archive = run.pathInArtifacts("kcoder-design-atlas-v1.zip");
  const child = run.spawnOwned("atlas-increment-zip", "python3", ["-c", "import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:\n for f in sorted(p.rglob('*')):\n  if f.is_file(): z.write(f,str(pathlib.Path(p.name)/f.relative_to(p)))", out, archive]);
  await waitFor(() => child.exitCode !== null, 60_000, "increment zip"); assert.equal(child.exitCode, 0);
  console.log(`[atlas increment 02] ${states.length} states, +${data.addedCount}, ${data.imageCount} PNGs`);
  return { out, archive, edition: "02", states: states.length, added: data.addedCount, pngs: data.imageCount };
});
