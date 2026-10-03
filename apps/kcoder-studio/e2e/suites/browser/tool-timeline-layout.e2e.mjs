import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  chromium,
  expect,
} from "../../../renderer/node_modules/@playwright/test/index.mjs";
import { startApprovalModelFixture } from "../../harness/approval-model.mjs";
import { assertRendererBuildFresh } from "../../harness/renderer-build.mjs";
import {
  appRoot,
  repoRoot,
  requireExecutable,
  runE2E,
  waitFor,
} from "../../harness/run-context.mjs";
import { materializeWorkspace } from "../../harness/workspace-fixture.mjs";

// QA: real Electron -> Gateway -> Rust -> gated loopback SSE provider. Model
// choice/quality is not under test; deterministic gates expose exact UI states.
// Cover chronology, collapsed reasoning, scrollbar geometry in both themes,
// mouse follow/unfollow/recovery, final output and persisted history. Every
// process, profile and fixture is owned and cleaned by this run, including failures.
await assertRendererBuildFresh();
const thinkingSpinnerOnly = process.env.KCODER_E2E_THINKING_SPINNER_ONLY === "1";
await runE2E(
  import.meta.url,
  {
    testId: "electron-tool-timeline-order-scroll-and-duration-layout",
    tier: "full-integration",
    modelPolicy:
      "model-independent ordered SSE rendering and native Electron scroll geometry",
    retainSuccessLogs: true,
  },
  async (context) => {
    if (
      process.platform !== "linux" ||
      process.env.KCODER_E2E_CHROMIUM_NO_SANDBOX !== "1"
    ) {
      throw new Error(
        "UNMET_PREREQUISITE: Linux Xvfb and explicit isolated no-sandbox opt-in required",
      );
    }
    const xvfb = await requireExecutable("/usr/bin/xvfb-run", "Xvfb");
    const electron = await requireExecutable(
      process.env.KCODER_E2E_ELECTRON_BIN || resolve(appRoot, "node_modules/electron/dist/electron"),
      "Electron",
    );
    const binary = await requireExecutable(
      process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, "target/debug/kcoder"),
      "KCoder",
    );
    const { path: workspace } = await materializeWorkspace(context, "minimal", {
      instanceId: "tool-timeline",
    });
    let allowedRequest = 8;
    let showFinalReasoning = false;
    let finish = false;
    let initialReasoningChecked = false;
    const model = await startApprovalModelFixture(context, {
      responseSteps: ({ requestNumber }) =>
        thinkingSpinnerOnly ? [
          { delta: { role: "assistant", reasoning_content: "REASONING_BEFORE_TOOLS" } },
          { ready: () => finish, delta: { content: "TIMELINE_FINAL_ANSWER" } },
          { finishReason: "stop" },
        ] : requestNumber <= 10
          ? [
              ...(requestNumber === 1
                ? [
                    {
                      delta: {
                        role: "assistant",
                        reasoning_content: "REASONING_BEFORE_TOOLS",
                      },
                    },
                    { ready: () => initialReasoningChecked, delta: { content: "TIMELINE_COMMENTARY" } },
                  ]
                : []),
              {
                ready: () => requestNumber <= allowedRequest,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `timeline-tool-${requestNumber}`,
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({
                          command: `printf 'TIMELINE_TOOL_${requestNumber}\\n'`,
                        }),
                      },
                    },
                  ],
                },
              },
              { finishReason: "tool_calls" },
            ]
          : [
              {
                ready: () => showFinalReasoning,
                delta: { reasoning_content: "REASONING_AFTER_TOOLS" },
              },
              {
                ready: () => finish,
                delta: { content: "TIMELINE_FINAL_ANSWER" },
              },
              { finishReason: "stop" },
            ],
    });
    const profile = context.pathInState("profile");
    await context.writeStateJson("profile/settings.json", {});
    context.registerSecret("local-synthetic-timeline-key");
    await context.writeStateJson("profile/credentials.json", {
      "timeline-fixture": { type: "api", key: "local-synthetic-timeline-key" },
    });
    const settingsFile = await context.writeStateJson("settings.json", {
      active_provider: "timeline-fixture",
      permission_mode: "yolo",
      providers: {
        "timeline-fixture": {
          api_format: "openai_chat_completions",
          endpoint: model.baseUrl,
          default_model: "timeline-fixture",
          context_window_tokens: 128000,
          output_headroom_tokens: 8192,
          max_output_tokens: 8192,
          no_proxy: true,
          request_timeout_secs: 180,
        },
      },
    });
    const serversFile = await context.writeStateJson("servers.json", [
      {
        id: "local",
        label: "Timeline fixture",
        transport: "local",
        command: binary,
        workspace,
        settingsFile,
      },
    ]);
    let output = "";
    const child = context.spawnOwned(
      "timeline-electron",
      xvfb,
      [
        "-a",
        "-s",
        "-screen 0 1440x1000x24 -nolisten tcp",
        electron,
        "--no-sandbox",
        "--disable-gpu",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        resolve(appRoot, "desktop/main.mjs"),
      ],
      {
        cwd: appRoot,
        env: context.isolatedEnvironment({
          KCODER_CONFIG_DIR: profile,
          KCODER_STUDIO_SERVERS_FILE: serversFile,
          KCODER_STUDIO_WORKSPACE: workspace,
          KCODER_STUDIO_KCODER_BIN: binary,
          KCODER_STUDIO_WEB_ROOT: resolve(appRoot, "renderer/dist"),
          KCODER_STUDIO_DESKTOP_USER_DATA_DIR:
            context.pathInState("electron-profile"),
        }),
      },
    );
    const capture = (chunk) => {
      output = `${output}${chunk}`.slice(-16000);
    };
    child.stderr.on("data", capture);
    child.stdout.on("data", capture);
    const cdpUrl = await waitFor(
      () => {
        if (child.exitCode !== null)
          throw new Error(`Electron exited (${child.exitCode})`);
        return output.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/,
        )?.[1];
      },
      30000,
      "timeline Electron CDP",
      100,
      context.abortSignal,
    );
    context.registerPort("timeline-electron-cdp", Number(new URL(cdpUrl).port));
    const browser = await chromium.connectOverCDP(cdpUrl);
    context.addCleanup("close timeline Electron CDP", () => browser.close());
    const page = await waitFor(
      () =>
        browser
          .contexts()
          .flatMap((item) => item.pages())
          .find((item) => item.url().startsWith("http://127.0.0.1:")),
      30000,
      "timeline window",
      100,
      context.abortSignal,
    );
    const checks = {};
    try {
      await page.getByTestId("desktop-sidebar").waitFor({ timeout: 60000 });
      const project = page
        .getByTestId("project-item")
        .filter({ hasText: "Timeline fixture" })
        .first();
      await project.waitFor({ timeout: 60000 });
      await project.hover();
      await project.getByTestId("project-new-conversation-button").click();
      await page.getByTestId("chat-message-input").click();
      await page.keyboard.insertText(
        "Verify deterministic tool timeline rendering.",
      );
      await page.getByTestId("send-message-button").click();
      const spinner = page.getByTestId("assistant-thinking-spinner");
      const reasoning = page.getByTestId("assistant-thinking-toggle").first();
      await expect(spinner).toBeVisible({ timeout: 20000 });
      await expect(reasoning).toHaveAttribute("aria-expanded", "false");
      // Progress remains animated even when decorative desktop motion is reduced.
      for (const reducedMotion of ["reduce", "no-preference"]) {
        await page.emulateMedia({ reducedMotion });
        assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
          reducedMotion === "reduce");
        const style = await spinner.evaluate(node => ({
          animation: getComputedStyle(node).animationName,
          iterations: getComputedStyle(node).animationIterationCount,
          transform: getComputedStyle(node).transform,
        }));
        (checks.thinkingMotion ??= {})[reducedMotion] = style;
        assert.match(style.animation, /spin/);
        assert.equal(style.iterations, "infinite");
        await expect.poll(() => spinner.evaluate(node => getComputedStyle(node).transform)).not.toBe(style.transform);
      }
      await reasoning.click();
      await expect(page.getByTestId("assistant-thinking-content")).toHaveText("REASONING_BEFORE_TOOLS");
      await expect(spinner).toBeVisible();
      await reasoning.click();
      initialReasoningChecked = true;
      if (thinkingSpinnerOnly) {
        finish = true;
        await page.getByText("TIMELINE_FINAL_ANSWER", { exact: true }).waitFor({ timeout: 20000 });
        await expect(spinner).toHaveCount(0);
        assert.equal(model.requests.length, 1);
        await context.writeArtifactJson("checks.json", checks);
        return { passed: true, realElectron: true, thinkingMotion: checks.thinkingMotion,
          scope: "thinking rotation with normal and reduced motion, disclosure and completion",
          providerRequests: 1 };
      }
      const scroll = page.getByTestId("processing-live-preview-scroll").last();
      await expect(scroll.locator("[data-processing-block-id]")).toHaveCount(
        8,
        { timeout: 60000 },
      );
      await expect(page.getByTestId("tool-block-waiting")).toHaveText(
        "等待响应",
      );
      await expect(
        page.getByTestId("assistant-thinking-toggle"),
      ).toHaveAttribute("aria-expanded", "false");
      await expect(page.getByText("正在思考", { exact: true })).toHaveCount(0);
      await scroll.scrollIntoViewIfNeeded();
      const distance = () =>
        scroll.evaluate(
          (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
        );
      await expect.poll(distance).toBeLessThanOrEqual(2);
      await scroll.hover();
      await page.mouse.wheel(0, -100);
      await expect.poll(distance).toBeGreaterThan(20);
      const before = await scroll.evaluate((node) => node.scrollTop);
      allowedRequest = 9;
      await expect(scroll.locator("[data-processing-block-id]")).toHaveCount(9);
      await expect(page.getByTestId("tool-block-waiting")).toHaveCount(1);
      await expect
        .poll(() => scroll.evaluate((node) => node.scrollTop))
        .toBe(before);
      checks.userScrollPreserved = true;
      await scroll.hover();
      await page.mouse.wheel(0, 2000);
      await expect.poll(distance).toBeLessThanOrEqual(2);
      allowedRequest = 10;
      await expect(scroll.locator("[data-processing-block-id]")).toHaveCount(
        10,
      );
      await expect(page.getByTestId("tool-block-waiting")).toHaveCount(1);
      await expect.poll(distance).toBeLessThanOrEqual(2);
      checks.followResumed = true;
      const geometry = [];
      for (const dark of [false, true]) {
        await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          dark ? "dark" : "light",
        );
        geometry.push(
          await scroll.evaluate((node) => {
            const style = getComputedStyle(node);
            const durations = [
              ...node.querySelectorAll('[data-testid="tool-block-duration"]'),
            ];
            const right =
              node.getBoundingClientRect().left +
              node.clientLeft +
              node.clientWidth;
            return {
              padding: parseFloat(style.paddingRight),
              gutter: style.scrollbarGutter,
              color: style.scrollbarColor,
              gap: Math.min(
                ...durations.map(
                  (item) => right - item.getBoundingClientRect().right,
                ),
              ),
              overflow: node.scrollWidth > node.clientWidth,
              height: node.clientHeight,
            };
          }),
        );
        assert.ok(
          geometry.at(-1).gap >= 12,
          "elapsed labels must have a 12px scrollbar gap",
        );
        assert.equal(geometry.at(-1).gutter, "stable");
        assert.equal(geometry.at(-1).overflow, false);
        await page.screenshot({
          path: context.pathInArtifacts(
            `tool-list-${dark ? "dark" : "light"}.png`,
          ),
        });
      }
      checks.geometry = geometry;
      await page.emulateMedia({ colorScheme: "light" });
      showFinalReasoning = true;
      const toggles = page.getByTestId("assistant-thinking-toggle");
      await expect(toggles).toHaveCount(2);
      await expect(toggles.last()).toHaveText("正在思考");
      await expect(page.getByTestId("tool-block-waiting")).toHaveCount(0);
      await assertTimeline(page);
      finish = true;
      await page
        .getByText("TIMELINE_FINAL_ANSWER", { exact: true })
        .waitFor({ timeout: 30000 });
      await page.getByTestId("final-processing-toggle").click();
      await assertTimeline(page);
      for (const toggle of await toggles.all()) await toggle.click();
      await expect(
        page.getByTestId("assistant-thinking-content").first(),
      ).toHaveText("REASONING_BEFORE_TOOLS");
      await expect(
        page.getByTestId("assistant-thinking-content").last(),
      ).toHaveText("REASONING_AFTER_TOOLS");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByText("TIMELINE_FINAL_ANSWER", { exact: true })
        .waitFor({ timeout: 30000 });
      // Durable history may split commentary into a separate assistant message.
      for (const finalToggle of await page
        .getByTestId("final-processing-toggle")
        .all()) {
        if ((await finalToggle.getAttribute("aria-expanded")) === "false")
          await finalToggle.click();
      }
      await assertTimeline(page);
      checks.liveAndRestoredChronology = true;
      assert.equal(model.requests.length, 11, "the fixture must not trigger extra model requests");
      await context.writeArtifactJson("checks.json", checks);
      return {
        passed: true,
        checks,
        realElectron: true,
        providerRequests: model.requests.length,
      };
    } catch (error) {
      await page
        .screenshot({ path: context.pathInArtifacts("failure.png") })
        .catch(() => {});
      await context.writeArtifactJson("checks.json", {
        checks,
        error: error.message,
        body: await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      });
      throw error;
    }
  },
);

async function assertTimeline(page) {
  const order = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid="assistant-thinking-details"], [data-testid="process-text-block"], [data-testid="processing-summary-header"], [data-testid="assistant-message-content"]',
      ),
    ].flatMap((node) => {
      if (node.getAttribute("data-testid") !== "assistant-message-content")
        return [node.getAttribute("data-testid")];
      return node.textContent === "TIMELINE_COMMENTARY"
        ? ["process-text-block"]
        : [];
    }),
  );
  assert.deepEqual(order, [
    "assistant-thinking-details",
    "process-text-block",
    "processing-summary-header",
    "assistant-thinking-details",
  ]);
}
