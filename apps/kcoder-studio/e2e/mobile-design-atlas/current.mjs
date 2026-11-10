import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runE2E, repoRoot, waitFor } from "../harness/run-context.mjs";
import { startChromium } from "../harness/chromium.mjs";
import { captureMobileExportSourceSnapshot } from "../harness/mobile-export-source-snapshot.mjs";
import { startRecoveryFixture } from "../fixtures/mobile-send-recovery/server.mjs";
import { buildCurrentFixture } from "./current-fixture/build.mjs";
import { groups, concepts } from "./catalog.mjs";
import { incrementalGroups, incrementalConcepts, remainingGaps } from "./incremental-catalog.mjs";
import { currentCases } from "./current-catalog.mjs";
import { resolvedTransition, validateTransitions } from "./current-transitions.mjs";
import { indexPage, statePage, aiBrief, handoff } from "./pages.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const renderInputs = files => files.filter(file => !file.path.split("/").includes("__tests__") && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path));
process.umask(0o077);
await runE2E(import.meta.url, { testId: "design-atlas-current-v3-only", tier: "manual-live", retainSuccessLogs: true,
  modelPolicy: "Fresh source-frozen actual V3 React Native Web components with synthetic inputs; no historical screenshots, Gateway, personal sessions or model calls" }, async run => {
  validateTransitions(currentCases);
  const sampledAt = new Date().toISOString();
  const atlasFiles = ["current.mjs", "current-catalog.mjs", "current-transitions.mjs", "transition-view.mjs", "pages.mjs", "atlas.js", "atlas.css"];
  const atlasSource = await Promise.all(atlasFiles.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(resolve(dir, path))).digest("hex") })));
  await run.writeArtifactJson("frozen-atlas-source.json", atlasSource);
  console.log("[V3 atlas] freezing current Mobile, shared source and fixture inputs");
  let built;
  const reused = process.env.KCODER_ATLAS_CURRENT_RUN;
  if (reused) {
    const prior = resolve(reused, "artifacts");
    const previous = JSON.parse(await readFile(resolve(prior, "frozen-mobile-source.json"), "utf8"));
    const source = await captureMobileExportSourceSnapshot({ snapshotRoot: run.pathInState("frozen-source"), layout: "preflight-source-root", freezeFiles: true,
      sourceRoots: [{ name: "mobile", path: resolve(repoRoot, "apps/kcoder-studio/mobile"), destination: "apps/kcoder-studio/mobile" },
        { name: "studio-shared", path: resolve(repoRoot, "apps/kcoder-studio/shared"), destination: "apps/kcoder-studio/shared" }] });
    assert.deepEqual(renderInputs(source.files), renderInputs(previous.files), "Reused build must exactly match current render inputs; test-only files are not bundled");
    const fixture = JSON.parse(await readFile(resolve(prior, "frozen-fixture-source.json"), "utf8"));
    for (const file of fixture) assert.equal(createHash("sha256").update(await readFile(resolve(dir, "current-fixture", file.path))).digest("hex"), file.sha256);
    const output = resolve(prior, "site/fixtures/mobile-send-recovery-v3");
    const assets = JSON.parse(await readFile(resolve(prior, "static-files.json"), "utf8"));
    for (const file of assets) assert.equal(createHash("sha256").update(await readFile(resolve(output, file.path))).digest("hex"), file.sha256);
    await run.writeArtifactJson("frozen-mobile-source.json", source);
    await run.writeArtifactJson("frozen-fixture-source.json", fixture);
    await run.writeArtifactJson("reused-build.json", { source: reused, sourceTreeSha256: source.sourceTreeSha256,
      originalBuildSourceTreeSha256: previous.sourceTreeSha256, renderInputsIdentical: true,
      testOnlySourceDrift: JSON.stringify(source.files) !== JSON.stringify(previous.files), allAssetHashesVerified: true, reusedScreenshots: false });
    built = { source, output };
  } else built = await buildCurrentFixture(run);
  built.source.runtimeTreeSha256 = createHash("sha256").update(JSON.stringify(renderInputs(built.source.files))).digest("hex");
  const base = await startRecoveryFixture(run, built.output);
  const browser = await startChromium(run, { label: "current-v3-atlas-browser", noSandbox: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol) && url.origin !== new URL(base).origin) external.push(url.origin + url.pathname); });
  // Capture the delivered viewer before replacing it; this is not a new product screenshot.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(pathToFileURL(resolve(repoRoot, "docs/phone/show/index.html")).href + "#AGENT-01");
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: run.pathInArtifacts("atlas-trigger-before.png") });
  const out = run.pathInArtifacts("kcoder-design-atlas-v1");
  for (const folder of ["images", "states", "briefs"]) await mkdir(resolve(out, folder), { recursive: true });
  const terms = [...concepts, ...incrementalConcepts];
  const byGroup = { selection: ["target", "project", "session"], draft: ["draft", "connection"], conversation: ["turn", "thinking", "permission"],
    input: ["draft", "provider", "attachment"], commands: ["goal", "plan", "turn"], agents: ["subagent", "turn", "permission"], actions: ["permission", "session"],
    workspace: ["workspaceTools", "target"], history: ["session", "project", "cache"], recovery: ["recovery", "receipt", "queue"], settings: ["cache", "session"] };
  const variants = [{ width: 390, theme: "light", language: "zh-CN" }];
  const enterSubagents = async (selected) => {
    await page.getByTestId("task-more").click();
    await page.getByTestId("mobile-subagents-open").click();
    await page.getByTestId("mobile-subagent-list").waitFor();
    if (selected) {
      await page.getByTestId("mobile-subagent-layout-agent").click();
      await page.getByTestId("mobile-subagent-conversation").waitFor();
    }
  };
  const states = [];
  for (const [i, [id, title, group, scenario, condition, recipe, action]] of currentCases.entries()) {
    const item = { id, title, group, condition, recipe, version: "V3", kind: "当前组件标本", freshness: "本次组件采样", addedIn: "05", captureDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(sampledAt)),
      evidence: "本轮冻结源码构建的真实 V3 组件；合成输入，不是正式页面完整业务验收", rendererTreeSha256: built.source.runtimeTreeSha256,
      transition: resolvedTransition(id, currentCases), concepts: byGroup[group], can: [condition, "查看当前组件的布局、层级与状态语义"],
      constraints: ["这是当前源码的组件标本；外层组合用于设计检查，不冒充完整生产路由。", "实际写入、网络、发送和系统选择器均冻结，不可据按钮外观推断完整业务开放条件。", "示例名称、用量与时间来自合成输入，不固定为产品值。"], hotspots: [], variants: [] };
    if (group === "commands") item.constraints.push("暂停持续目标与停止当前回合不同；终态目标不能当作仍可编辑。");
    if (group === "agents") item.constraints.push("列表与公开记录复用正式查看器的呈现组件；代理读写、审批和停止的运行时归属仍由正式控制器负责，标本不连接后端。");
    if (group === "recovery") item.constraints.push("准备和等待不是错误；结果未知不能直接当失败重发。");
    for (const variant of variants) {
      await page.setViewportSize({ width: variant.width, height: 844 });
      await page.goto(`${base}?${new URLSearchParams({ state: scenario, ...variant })}`, { waitUntil: "load" });
      await page.getByTestId("current-v3-fixture").waitFor();
      if (!scenario.startsWith("selection")) await page.getByTestId("conversation-v3-background").waitFor();
      // Match the existing editable-export keyboard path without forcing a blocked pointer hit.
      if (action === "project") await page.getByTestId("v3-project-folder-api-1").press("Enter");
      if (action === "edit") await page.getByTestId("task-goal-edit").click();
      if (action === "details") await page.getByTestId("task-goal-expand").click();
      if (action === "navigation") await page.getByTestId("v3-conversation-menu").click();
      if (action === "agents-list" || action === "agent-conversation") await enterSubagents(action === "agent-conversation");
      if (action === "phrase-edit") await page.getByTestId("quick-phrase-edit-review").click();
      if (action === "reply-more") await page.getByTestId("assistant-response-more").click();
      if (action === "thinking") await page.locator('[data-testid$="-toggle"]:visible').first().click();
      if (action === "plan" || action === "plan-pin-scroll") {
        await page.getByTestId("task-more").click();
        await page.getByTestId("task-menu-plan").click();
        if (action === "plan-pin-scroll") await page.getByTestId("task-plan-pin-toggle").click();
      }
      if (action === "plan-pin-scroll") await page.getByTestId("fixture-transcript").evaluate(node => { node.scrollTop = 320; });
      await page.evaluate(async () => { await document.fonts.ready; document.activeElement?.blur();
        for (const animation of document.getAnimations()) { try { animation.finish(); } catch { animation.pause(); } } });
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${id}/${variant.width} overflow`);
      assert.deepEqual(errors, [], `${id} page errors`);
      const image = `images/${id}-${item.variants.length + 1}.png`, path = resolve(out, image);
      await page.screenshot({ path });
      const bytes = await readFile(path);
      item.variants.push({ image, label: `${variant.width}-${variant.language}-${variant.theme}`, width: variant.width, height: 844,
        source: `current-fixture/App.tsx?state=${scenario}${action ? `&action=${action}` : ""}`, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    item.aiBrief = aiBrief(item, terms); states.push(item);
    console.log(`[V3 atlas] ${i + 1}/${currentCases.length} ${id}`);
  }
  for (const variant of [
    { width: 390, language: "zh-CN", theme: "light" },
    { width: 320, language: "zh-CN", theme: "dark" },
    { width: 390, language: "en", theme: "dark" },
    { width: 320, language: "en", theme: "light" },
  ]) {
    await page.setViewportSize({ width: variant.width, height: 844 });
    await page.goto(`${base}?${new URLSearchParams({ state: "agent-steer", ...variant })}`, { waitUntil: "load" });
    await page.getByTestId("current-v3-fixture").waitFor();
    const draft = "parent draft preserved";
    await page.getByTestId("message-input").fill(draft);
    await enterSubagents(false);
    assert.equal(await page.getByTestId("mobile-subagent-list").getByRole("button").count(), 3);
    await page.getByTestId("mobile-subagent-layout-agent").click();
    await page.getByTestId("mobile-subagent-conversation").waitFor();
    assert.ok((await page.getByTestId("mobile-subagent-conversation").innerText()).includes("布局检查记录"));
    assert.equal(await page.getByTestId("mobile-subagent-conversation").locator('[data-testid="conversation-markdown-body"]').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: run.pathInArtifacts(`subagent-conversation-${variant.width}-${variant.language}-${variant.theme}.png`) });
    await page.getByTestId("mobile-subagent-back").click();
    await page.getByTestId("mobile-subagent-list").waitFor();
    await page.getByTestId("mobile-subagent-review-agent").click();
    await page.getByTestId("mobile-subagent-conversation").waitFor();
    await page.getByTestId("mobile-subagent-parent").click();
    await page.getByTestId("mobile-subagent-panel").waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("message-input").inputValue(), draft);
    await enterSubagents(false);
    await page.getByTestId("mobile-subagent-back").click();
    await page.getByTestId("mobile-subagent-panel").waitFor({ state: "hidden" });
  }
  assert.deepEqual(external, []);
  const data = { edition: "05", v3Only: true, sampledAt, createdAtUtc: new Date().toISOString(),
    createdAt: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(new Date()) + " UTC+08:00",
    states, groups: [...groups, ...incrementalGroups].filter(([id]) => states.some(s => s.group === id)), concepts: terms,
    flows: [],
    backlog: [...remainingGaps, ["完整页面采样", "本轮是当前 V3 组件标本；历史完整页面、设置路由、连接与完整专业面板需要从同一冻结源码另行补采，不用旧图代替", "current-fixture/ 与正常 App 路由分别验证"]],
    routes: [], skipped: [], imageCount: states.length * variants.length, freshCount: states.length, componentCount: states.length, addedCount: states.length,
    rendererTreeSha256: built.source.runtimeTreeSha256 };
  for (const file of atlasSource) assert.equal(createHash("sha256").update(await readFile(resolve(dir, file.path))).digest("hex"), file.sha256, `Atlas input changed during generation: ${file.path}`);
  const css = await readFile(resolve(dir, "atlas.css"), "utf8"), js = await readFile(resolve(dir, "atlas.js"), "utf8");
  await writeFile(resolve(out, "index.html"), indexPage(data, css, js));
  for (const item of states) { await writeFile(resolve(out, `states/${item.id}.html`), statePage(item, terms, css)); await writeFile(resolve(out, `briefs/${item.id}.md`), item.aiBrief); }
  await writeFile(resolve(out, "catalog.json"), JSON.stringify(data, null, 2));
  await writeFile(resolve(out, "provenance.json"), JSON.stringify({ edition: "05", sampledAt, source: built.source, atlasSource,
    fixtureSource: JSON.parse(await readFile(run.pathInArtifacts("frozen-fixture-source.json"), "utf8")),
    screenshotPolicy: "Current-source V3 only; no archive images imported; actual component specimens with frozen synthetic inputs", files: states.flatMap(s => s.variants) }, null, 2));
  for (const filename of ["START_HERE.md", "DESIGN_BRIEF.md"]) await writeFile(resolve(out, filename), handoff(data));
  const csv = rows => "\uFEFF" + rows.map(row => row.map(v => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
  await writeFile(resolve(out, "coverage.csv"), csv([["领域", "状态", "证据边界"], ...states.map(s => [s.group, `${s.id} ${s.title}`, s.evidence]), ...data.backlog.map(([name, missing]) => [name, missing, "待补采；无旧图替代"])]));
  await writeFile(resolve(out, "feedback-template.csv"), csv([["状态编号", "区域", "问题", "建议", "是否改变行为"]]));
  await page.route(/^https?:\/\//, route => route.abort());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(pathToFileURL(resolve(out, "index.html")).href, { waitUntil: "load" });
  assert.equal(await page.locator(".card").count(), states.length);
  const detail = page.getByRole("dialog");
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    for (const state of states) {
      await page.evaluate(id => { location.hash = id; }, state.id);
      await detail.locator(`[data-transition="${state.id}"]`).waitFor();
      assert.equal(await detail.locator(".transition").count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.querySelector("#detail").scrollWidth > document.querySelector("#detail").clientWidth + 1), false, `atlas/${state.id}/${width} overflow`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { location.hash = "AGENT-01"; });
  await detail.locator('[data-transition="AGENT-01"]').waitFor();
  await page.screenshot({ path: run.pathInArtifacts("atlas-trigger-after.png") });
  await detail.locator('.next-states a[data-state="AGENT-09"]').click();
  await detail.locator('[data-transition="AGENT-09"]').waitFor();
  await page.goBack();
  await detail.locator('[data-transition="AGENT-01"]').waitFor();
  await page.setViewportSize({ width: 320, height: 844 });
  await detail.locator(".transition").scrollIntoViewIfNeeded();
  await page.screenshot({ path: run.pathInArtifacts("atlas-trigger-narrow.png") });
  await page.getByRole("button", { name: "关闭状态详情" }).click();
  await page.getByRole("searchbox").fill("回执");
  assert.ok(await page.locator('.card[data-state="SEND-sending"]').count());
  await page.getByRole("searchbox").fill("查看子代理");
  assert.ok(await page.locator('.card[data-state="AGENT-01"]').count());
  await page.getByRole("tab", { name: "操作路径", exact: true }).click();
  assert.equal(await page.locator(".flow-branch").count(), states.length);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "320px branches overflow");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: run.pathInArtifacts("atlas-trigger-branches.png") });
  await page.getByRole("tab", { name: "状态图册", exact: true }).click();
  await page.getByRole("searchbox").fill("");
  await page.screenshot({ path: run.pathInArtifacts("current-v3-overview.png") });
  // Verify static cross-state anchors too: these pages must work without JavaScript.
  await page.goto(pathToFileURL(resolve(out, "states/AGENT-09.html")).href);
  assert.equal(await page.locator("script").count(), 0);
  await page.locator('.state-links a[href="./AGENT-01.html"]').click();
  await page.locator('[data-transition="AGENT-01"]').waitFor();
  await run.writeArtifactJson("trigger-verification.json", { states: states.length, detailViewports: [1440, 320],
    linkedNavigationAndBrowserBack: true, triggerSearch: ["回执", "查看子代理"], standaloneCrossLinks: true,
    flowBranchStates: states.length, pageErrors: errors });
  assert.deepEqual(errors, []);
  const archive = run.pathInArtifacts("kcoder-design-atlas-v1.zip");
  const child = run.spawnOwned("current-v3-zip", "python3", ["-c", "import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:\n for f in sorted(p.rglob('*')):\n  if f.is_file():z.write(f,str(pathlib.Path(p.name)/f.relative_to(p)))", out, archive]);
  await waitFor(() => child.exitCode !== null, 60_000, "current V3 zip"); assert.equal(child.exitCode, 0);
  return { out, archive, edition: "05", states: states.length, pngs: data.imageCount, v3Only: true, sourceTreeSha256: built.source.sourceTreeSha256, pageErrors: errors };
});
