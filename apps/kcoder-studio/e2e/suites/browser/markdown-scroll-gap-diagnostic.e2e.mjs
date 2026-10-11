import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { startChromium } from "../../harness/chromium.mjs";
import { startGateway } from "../../harness/gateway.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import { repoRoot, runE2E } from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

await assertRendererBuildFresh();
await runE2E(import.meta.url, {
  testId: "markdown-scroll-gap-diagnostic",
  tier: "full-integration",
  modelPolicy: "model-independent long Markdown layout and real browser scrolling",
  retainSuccessLogs: true,
}, async context => {
  // QA: stream mixed CJK prose, math and tables; traverse in both directions,
  // resize, and inspect settled visible placeholders. Keep geometry evidence
  // and a screenshot on failure; the harness owns all state and processes.
  const { path: workspace } = await materializeWorkspace(context, "minimal", { instanceId: "markdown-gap" });
  const profile = context.pathInState("profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await context.writeStateJson("profile/settings.json", {});
  context.registerSecret("layout-fixture-key");
  await context.writeStateJson("profile/credentials.json", { "layout-model": { type: "api", key: "layout-fixture-key" } });
  // Keep ordinary reload coverage within the protocol's 64 KiB message preview.
  // Oversized replay separately exercises the unresolved full-history boundary.
  const repetitions = process.env.KCODER_E2E_LAYOUT_OVERSIZED === "1" ? 100 : 20;
  let chunks = Array.from({ length: 28 }, (_, index) =>
    `\n## Contribution ${index}\n\n${"完整的实验结果需要保留证据和限制条件。 ".repeat(repetitions)}\n\n` +
    "3. **偏差显式声明**——`depth` 关闭了 agent 嵌套层级，`replay-reasoning` 显式声明上轮内容。\n\n" +
    "| Audit | 含义 |\n| --- | --- |\n| Complete observable records | 必需字段到齐率 |\n| Resolved before $K_{max}$ | 在预算内完成 |\n\n冻结参数：$K_{max}=512, B=0.5$.\n"
  );
  if (process.env.KCODER_E2E_LAYOUT_TRANSCRIPT) {
    const records = (await readFile(process.env.KCODER_E2E_LAYOUT_TRANSCRIPT, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const text = records.filter(record => record.role === "assistant")
      .flatMap(record => record.content ?? [])
      .find(block => typeof block.text === "string" && block.text.includes("偏差显式声明") && block.text.includes("端到端验证协议"))?.text;
    assert.ok(text, "The explicitly selected transcript lacks the reported assistant response");
    chunks = text.match(/[\s\S]{1,240}/g);
  }
  chunks.push("\n\nLAYOUT_STREAM_DONE\n");
  const model = await startApprovalModelFixture(context, { textOnly: true, textOnlyChunks: chunks, textOnlyChunkDelayMs: 100 });
  const settingsFile = await context.writeStateJson("settings.json", {
    active_provider: "layout-model",
    providers: { "layout-model": { api_format: "openai_chat_completions", endpoint: model.baseUrl,
      default_model: "layout-model", context_window_tokens: 128000, output_headroom_tokens: 8192,
      max_output_tokens: 8192, no_proxy: true } },
  });
  const serversFile = await context.writeStateJson("servers.json", [{ id: "local", label: "Layout Diagnostic",
    runtime: "kcoder", transport: "local", command: resolve(repoRoot, "target/debug/kcoder"), workspace, settingsFile }]);
  const gateway = await startGateway(context, { workspace, serversFile, auth: true, env: { KCODER_CONFIG_DIR: profile } });
  const chromium = await startChromium(context);
  const page = await chromium.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(gateway.baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith("/login")), page.locator('button[type="submit"]').click()]);
  const project = page.getByTestId("project-item").filter({ hasText: "Layout Diagnostic" }).first();
  await project.waitFor({ timeout: 60000 });
  await project.hover();
  await project.getByTestId("project-new-conversation-button").click();
  await page.getByTestId("chat-message-input").click();
  await page.keyboard.insertText("Output the layout fixture.");
  await page.getByTestId("send-message-button").click();
  await page.locator('.assistant-markdown h2').first().waitFor({ timeout: 30000 });
  const samples = [];
  async function sample(label) {
    const geometry = await page.evaluate(() => {
      const first = document.querySelector('[data-markdown-window-chunk]');
      if (!first) throw new Error("No Markdown chunks");
      let scroller = first.parentElement;
      while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      if (!scroller) throw new Error("No message scroller");
      const viewport = scroller.getBoundingClientRect();
      return {
        scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, viewportHeight: scroller.clientHeight,
        messages: [...document.querySelectorAll('[data-testid="message-assistant"], [data-testid="message-user"]')].map(node => {
          const rect = node.getBoundingClientRect();
          return { id: node.dataset.messageId, top: rect.top, bottom: rect.bottom, height: rect.height };
        }),
        chunks: [...document.querySelectorAll('[data-markdown-window-chunk]')].map((node, index) => {
          const rect = node.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(node);
          const contentRect = range.getBoundingClientRect();
          return { index, top: rect.top, bottom: rect.bottom, height: rect.height,
            contentHeight: contentRect.height, children: node.childElementCount,
            minHeight: getComputedStyle(node).minHeight,
            visible: rect.bottom > viewport.top + 2 && rect.top < viewport.bottom - 2,
            textLength: node.textContent.length };
        }),
      };
    });
    samples.push({ label, ...geometry });
    return geometry;
  }
  await sample("streaming-initial");
  await page.getByText("LAYOUT_STREAM_DONE", { exact: true }).waitFor({ timeout: 60000 });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
  await sample("completed-bottom");
  if (process.env.KCODER_E2E_LAYOUT_MULTI_TURN === "1") {
    for (let round = 0; round < 3; round++) {
      const previousId = await page.getByTestId("message-assistant").last().getAttribute("data-message-id");
      await page.getByTestId("chat-message-input").click();
      await page.keyboard.insertText(`Repeat the layout fixture ${round}.`);
      await page.getByTestId("send-message-button").click();
      await page.waitForFunction(previousId => {
        const last = [...document.querySelectorAll('[data-testid="message-assistant"]')].at(-1);
        return last?.dataset.messageId !== previousId && last?.textContent.includes("LAYOUT_STREAM_DONE");
      }, previousId, { timeout: 60000 });
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
    }
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("message-assistant").last().waitFor({ timeout: 60000 });
  const loadFull = page.getByTestId("load-full-runtime-transcript-button").last();
  if (await loadFull.count()) await loadFull.click();
  try {
    await page.getByText("LAYOUT_STREAM_DONE", { exact: true }).last().waitFor({ timeout: 30000 });
  } catch (error) {
    await context.writeArtifactJson("restore-state.json", await page.evaluate(() => ({
      assistantCount: document.querySelectorAll('[data-testid="message-assistant"]').length,
      textLength: document.querySelector('[data-testid="message-assistant"]')?.textContent.length,
      loadFullCount: document.querySelectorAll('[data-testid="load-full-runtime-transcript-button"]').length,
      containsEnd: document.body.textContent.includes("LAYOUT_STREAM_DONE"),
    })));
    await page.screenshot({ path: context.pathInArtifacts("restore-failure.png") });
    throw error;
  }
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
  await sample("restored-history-bottom");
  const pointer = await page.evaluate(() => {
    let node = document.querySelector('[data-markdown-window-chunk]').parentElement;
    while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(pointer.x, pointer.y);
  for (const direction of [-1, 1, -1]) {
    for (let step = 0; step < 20; step++) {
      await page.mouse.wheel(0, direction * 380);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
      const result = await sample(`wheel-${direction}-${step}`);
      if (result.chunks.some(chunk => chunk.visible && chunk.children === 0)) {
        await context.writeArtifactJson("geometry.json", { samples, errors });
        await page.screenshot({ path: context.pathInArtifacts("visible-gap.png") });
        assert.fail("Visible unmounted Markdown after mouse scrolling");
      }
    }
  }
  for (const width of [1280, 900, 1500]) {
    await page.setViewportSize({ width, height: 900 });
    for (const fraction of [0, 0.1, 0.3, 0.5, 0.8, 1, 0.8, 0.5, 0.3, 0.1, 0]) {
      await page.evaluate(fraction => {
        let node = document.querySelector('[data-markdown-window-chunk]').parentElement;
        while (node && !/auto|scroll/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
        node.scrollTop = (node.scrollHeight - node.clientHeight) * fraction;
      }, fraction);
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
      const result = await sample(`width-${width}-fraction-${fraction}`);
      if (width === 1280 && fraction === 0.5) {
        await page.screenshot({ path: context.pathInArtifacts("middle-content.png") });
      }
      const blank = result.chunks.filter(chunk => chunk.visible && chunk.children === 0);
      const oversized = result.chunks.filter(chunk => chunk.visible && chunk.children > 0 && chunk.height - chunk.contentHeight > 300);
      if (blank.length || oversized.length) {
        await context.writeArtifactJson("geometry.json", { samples, errors, blank, oversized });
        await page.screenshot({ path: context.pathInArtifacts("visible-gap.png") });
        assert.fail(`Visible Markdown gap: empty=${blank.length}, oversized=${oversized.length}`);
      }
    }
  }
  const unexpectedJumps = samples.flatMap((sample, index) => {
    const previous = samples[index - 1];
    if (!previous || !sample.label.startsWith("wheel-")) return [];
    const delta = sample.scrollTop - previous.scrollTop;
    const sizeCorrection = Math.abs(sample.scrollHeight - previous.scrollHeight);
    return Math.abs(delta) > 380 + sizeCorrection + 150
      ? [{ label: sample.label, requestedWheelDelta: sample.label.startsWith("wheel--1") ? -380 : 380,
          actualScrollDelta: delta, contentHeightDelta: sample.scrollHeight - previous.scrollHeight }]
      : [];
  });
  await context.writeArtifactJson("geometry.json", { samples, errors, unexpectedJumps });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedJumps, [], "Mouse scrolling must not jump beyond its input plus layout correction");
  return { passed: true, samples: samples.length };
});
