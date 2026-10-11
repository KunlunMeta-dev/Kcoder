import { createRunContext } from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import {
  defaultCommandString,
  browserLaunchOptions,
} from "../runner-options.mjs";
import {
  writeStartMeta,
  writeTextArtifact,
  writeJsonArtifact,
  writeFailureArtifacts,
} from "../runtime-artifacts.mjs";
import { startSession } from "../session.mjs";
import { chromium } from "@playwright/test";
import {
  attachBrowserConsole,
  captureStep,
  formatBrowserConsole,
} from "../browser-evidence.mjs";
import {
  waitForTerminalText,
  typeHumanText,
} from "../terminal-interaction.mjs";
import {
  measureStreamingScrollbarDragDuringOutput,
  measureReleasedMouseMoveStability,
  firstVisibleHistoryMarker,
  measureWheelScrollCycles,
} from "../scroll-metrics.mjs";
import path from "node:path";
import { runStreamingScrollbarAssertions } from "../scenario-assertions.mjs";
import {
  moveRecordedVideo,
  compressVideo,
  extractVideoFrames,
} from "../recording-artifacts.mjs";

export async function runStreamingScrollbarScenario(options) {
  const artifacts = await createRunContext(
    options,
    "streaming-scrollbar",
    runContextRuntime(),
  );
  const runOptions = {
    ...options,
    scenario: "full-turn",
    streamDelayMs: options.streamDelayMs || 80,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const command = defaultCommandString(runOptions);
  const trace = [];
  const browserConsole = [];
  let session;
  let browser;
  let context;
  let page;
  await writeStartMeta(artifacts, runOptions, command, "streaming-scrollbar");
  try {
    session = await startSession(runOptions);
    browser = await chromium.launch(browserLaunchOptions(options));
    const viewport = {
      width: Math.max(900, options.cols * 9 + 80),
      height: Math.max(640, options.rows * 18 + 80),
    };
    context = await browser.newContext({
      viewport,
      recordVideo: { dir: artifacts.dir, size: viewport },
    });
    page = await context.newPage();
    const video = page.video();
    attachBrowserConsole(page, browserConsole);
    await page.goto(session.url);
    await page.waitForFunction(
      () => window.tuiLab && window.tuiLab.ready,
      null,
      {
        timeout: options.timeoutMs,
      },
    );
    await waitForTerminalText(
      page,
      "TUI dev mode is running mock scenario",
      options.timeoutMs,
    );
    await page.waitForTimeout(250);
    await captureStep(page, trace, "welcome", artifacts.welcomeScreenshot);

    await page.locator("#terminal").click();
    await typeHumanText(page, options.message);
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(120);
    await captureStep(
      page,
      trace,
      "after-enter",
      artifacts.afterEnterScreenshot,
    );
    // Collapsed tool output need not expose line-001; waiting for that hidden
    // row can miss the entire final stream. Observe the actual streamed region.
    await waitForTerminalText(page, "tui-lab-final-line-", options.timeoutMs);
    await captureStep(page, trace, "after-tool", artifacts.afterToolScreenshot);

    const streamingScrollbarDrag =
      await measureStreamingScrollbarDragDuringOutput(
        page,
        trace,
        artifacts,
        runOptions.streamDelayMs,
        options.dragDurationMs,
        options.dragSamples,
      );
    await waitForTerminalText(
      page,
      "tui-lab-final-sentinel",
      Math.min(options.timeoutMs, 20_000),
    );
    await page.waitForTimeout(250);
    await captureStep(page, trace, "after-final", artifacts.finalScreenshot);
    const releasedMouseMove = await measureReleasedMouseMoveStability(
      page,
      trace,
      artifacts,
    );
    const markerBeforeExpand = firstVisibleHistoryMarker(
      await page.evaluate(() => window.tuiLab.text()),
    );
    await page.keyboard.press("Alt+T");
    await page.waitForTimeout(300);
    const expandedText = await page.evaluate(() => window.tuiLab.text());
    await captureStep(
      page,
      trace,
      "streaming-scrollbar-tools-expanded",
      path.join(artifacts.dir, "streaming-scrollbar-tools-expanded.png"),
    );
    const wheelScrollCycles = await measureWheelScrollCycles(page, 3, 160);
    await page.keyboard.press("End");
    await page.waitForTimeout(200);
    const markerBeforeCollapse = firstVisibleHistoryMarker(
      await page.evaluate(() => window.tuiLab.text()),
    );
    await page.keyboard.press("Alt+T");
    await page.waitForTimeout(300);
    const collapsedText = await page.evaluate(() => window.tuiLab.text());
    const markerAfterCollapse = firstVisibleHistoryMarker(collapsedText);
    await captureStep(
      page,
      trace,
      "streaming-scrollbar-tools-collapsed",
      path.join(artifacts.dir, "streaming-scrollbar-tools-collapsed.png"),
    );
    const folding = {
      markerBeforeExpand,
      markerBeforeCollapse,
      markerAfterCollapse,
      expandedShowsAtLeast400ToolRows:
        expandedText.includes("tui-lab-tool-line-001") &&
        expandedText.includes("tui-lab-tool-line-420"),
      collapseStayedAtTail:
        collapsedText.includes("tui-lab-final-sentinel") &&
        (markerAfterCollapse?.score ?? -1) >=
          (markerBeforeCollapse?.score ?? -1),
    };

    const text = await page.evaluate(() => window.tuiLab.text());
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const assertions = runStreamingScrollbarAssertions({
      text,
      hasScrollbar,
      trace,
      streamingScrollbarDrag,
      releasedMouseMove,
      wheelScrollCycles,
      folding,
    });
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    await context.close();
    context = null;
    const rawVideo = await moveRecordedVideo(video, artifacts.recordingRaw);
    const compression = rawVideo
      ? compressVideo(rawVideo, artifacts.recordingVideo, options.videoFps)
      : {
          ok: false,
          skipped: true,
          reason: "Playwright did not produce a video",
        };
    const selectedVideo = compression.ok ? artifacts.recordingVideo : rawVideo;
    const extractedFrames = selectedVideo
      ? extractVideoFrames(
          selectedVideo,
          artifacts.recordingFramesDir,
          options.sampleFps,
        )
      : { ok: false, skipped: true, reason: "no video to sample" };
    await writeJsonArtifact(artifacts.meta, {
      ok: assertions.ok,
      mode: "streaming-scrollbar",
      command,
      cwd: repoRoot,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      description: artifacts.description,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      workspaceTemplate: artifacts.workspaceTemplate,
      message: options.message,
      scenario: runOptions.scenario,
      streamDelayMs: runOptions.streamDelayMs,
      screenshots: {
        welcome: artifacts.welcomeScreenshot,
        afterEnter: artifacts.afterEnterScreenshot,
        afterTool: artifacts.afterToolScreenshot,
        streamingScrollbarBeforeDrag:
          artifacts.streamingScrollbarBeforeDragScreenshot,
        streamingScrollbarTop: artifacts.streamingScrollbarTopScreenshot,
        streamingScrollbarBottom: artifacts.streamingScrollbarBottomScreenshot,
        afterFinal: artifacts.finalScreenshot,
        afterReleaseMouseMove: artifacts.afterReleaseMouseMoveScreenshot,
      },
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      rawVideo,
      compressedVideo: compression.ok ? artifacts.recordingVideo : undefined,
      compression,
      extractedFrames,
      recordingFramesDir: artifacts.recordingFramesDir,
      requestsDir: artifacts.requestsDir,
      configHome: artifacts.configHome,
      configDir: artifacts.configDir,
      projectKey: artifacts.projectKey,
      projectDir: artifacts.projectDir,
      streamingScrollbarDrag,
      releasedMouseMove,
      wheelScrollCycles,
      folding,
      hasScrollbar,
      dimensions,
      trace,
    });
    if (!assertions.ok) {
      const error = new Error(
        `TUI lab streaming-scrollbar assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "streaming-scrollbar",
          dir: artifacts.dir,
          assertions,
          streamingScrollbarDrag,
          releasedMouseMove,
          wheelScrollCycles,
          folding,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFailureArtifacts({
      artifacts,
      runOptions,
      command,
      mode: "streaming-scrollbar",
      session,
      page,
      browserConsole,
      trace,
      error,
    });
    throw error;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (session) {
      await session.stop();
    }
  }
}
