import { createRunContext } from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import path from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
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
  waitForTextMatch,
  measureWheelFromTailSamples,
  measureNormalWheelToBounds,
  measureHeldScrollbarDragSamples,
  measureReleasedMouseMoveDetailed,
  textSignature,
} from "../scroll-metrics.mjs";
import { runHistoryScrollbarAssertions } from "../scenario-assertions.mjs";
import {
  moveRecordedVideo,
  compressVideo,
  extractVideoFrames,
} from "../recording-artifacts.mjs";

export async function runHistoryScrollbarScenario(options) {
  const artifacts = await createRunContext(
    options,
    "history-scrollbar",
    runContextRuntime(),
  );
  const candidates = [options.historyPath, options.fallbackHistoryPath].filter(
    Boolean,
  );
  const selectedHistory = candidates
    .map((candidate) =>
      path.isAbsolute(candidate)
        ? candidate
        : path.resolve(process.cwd(), candidate),
    )
    .find((candidate) => existsSync(candidate));
  if (!selectedHistory) {
    throw new Error(
      `no readable history file found from candidates: ${candidates.join(", ") || "<none>"}`,
    );
  }
  const selectedWorkspace = options.historyWorkspacePath
    ? path.isAbsolute(options.historyWorkspacePath)
      ? options.historyWorkspacePath
      : path.resolve(process.cwd(), options.historyWorkspacePath)
    : artifacts.workspace;
  if (!existsSync(selectedWorkspace)) {
    throw new Error(`history workspace does not exist: ${selectedWorkspace}`);
  }

  const runOptions = {
    ...options,
    scenario: "full-turn",
    runDir: artifacts.dir,
    workspaceDir: selectedWorkspace,
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
  await writeStartMeta(artifacts, runOptions, command, "history-scrollbar");
  try {
    session = await startSession(runOptions);
    browser = await chromium.launch(browserLaunchOptions(options));
    const viewport = {
      width: Math.max(900, options.cols * 9 + 80),
      height: Math.max(640, options.rows * 18 + 80),
    };
    context = await browser.newContext({
      viewport,
      recordVideo: {
        dir: artifacts.dir,
        size: viewport,
      },
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
    await typeHumanText(page, `/resume ${selectedHistory} `);
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    const resumeFinished = () => {
      const text = window.tuiLab?.text() || "";
      return (
        text.includes("Resumed session from") ||
        text.includes("Failed to preflight session")
      );
    };
    let resumeResult;
    try {
      resumeResult = await waitForTextMatch(page, resumeFinished, 5000);
    } catch {
      await page.keyboard.press("Enter");
      resumeResult = await waitForTextMatch(
        page,
        resumeFinished,
        options.timeoutMs,
      );
    }
    if (resumeResult.text.includes("Failed to preflight session")) {
      throw new Error(
        `TUI history resume preflight failed: ${resumeResult.text.trim()}`,
      );
    }
    await page.waitForTimeout(300);
    const resumeText = resumeResult.text;
    await captureStep(
      page,
      trace,
      "after-resume",
      artifacts.afterScrollBottomScreenshot,
    );
    await page.keyboard.press("Alt+T");
    await page.waitForTimeout(300);
    await captureStep(
      page,
      trace,
      "history-scrollbar-tools-expanded",
      path.join(artifacts.dir, "history-scrollbar-tools-expanded.png"),
    );

    const wheelFromTail = await measureWheelFromTailSamples(
      page,
      trace,
      artifacts,
      "history-scrollbar-wheel-from-tail",
    );
    const normalWheelToBounds = await measureNormalWheelToBounds(
      page,
      trace,
      artifacts,
      "history-scrollbar-normal-wheel",
    );
    const heldDrag = await measureHeldScrollbarDragSamples(
      page,
      trace,
      artifacts,
      "history-scrollbar-held-drag",
      {
        sampleCount: options.dragSamples,
        dragDurationMs: options.dragDurationMs,
      },
    );
    const releasedMove = await measureReleasedMouseMoveDetailed(
      page,
      trace,
      artifacts,
      "history-scrollbar-released-move",
    );

    const text = await page.evaluate(() => window.tuiLab.text());
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const assertions = runHistoryScrollbarAssertions({
      resumeText,
      wheelFromTail,
      normalWheelToBounds,
      heldDrag,
      releasedMove,
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
    await browser.close();
    browser = null;

    await writeJsonArtifact(artifacts.meta, {
      ok: assertions.ok,
      mode: "history-scrollbar",
      command,
      cwd: repoRoot,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      selectedHistory,
      candidates,
      resumeTextSample: textSignature(resumeText),
      runDir: artifacts.dir,
      workspace: selectedWorkspace,
      artifactWorkspace: artifacts.workspace,
      screenshots: {
        welcome: artifacts.welcomeScreenshot,
        afterResume: artifacts.afterScrollBottomScreenshot,
        ...heldDrag.screenshots,
        ...releasedMove.screenshots,
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
      wheelFromTail,
      normalWheelToBounds,
      heldDrag,
      releasedMove,
      hasScrollbar,
      dimensions,
      trace,
    });
    console.log(
      JSON.stringify(
        {
          ok: assertions.ok,
          mode: "history-scrollbar",
          dir: artifacts.dir,
          selectedHistory,
          assertions,
          wheelFromTail: {
            firstEventChanged: wheelFromTail.firstEventChanged,
            changedEvents: wheelFromTail.changedEvents,
            firstChangedEvent: wheelFromTail.firstChangedEvent,
          },
          normalWheelToBounds,
          heldDrag: {
            contentChangedWhileHeld: heldDrag.contentChangedWhileHeld,
            thumbMovedWhileHeld: heldDrag.thumbMovedWhileHeld,
            thumbHeightDeltaRows: heldDrag.thumbHeightDeltaRows,
            afterUpThumbJumpRows: heldDrag.afterUpThumbJumpRows,
          },
          releasedMove: {
            stable: releasedMove.stable,
            uniqueSignatures: releasedMove.uniqueSignatures,
            thumbTopDeltaRows: releasedMove.thumbTopDeltaRows,
            thumbHeightDeltaRows: releasedMove.thumbHeightDeltaRows,
          },
        },
        null,
        2,
      ),
    );
    if (!assertions.ok) {
      const error = new Error(
        `TUI lab history-scrollbar assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
  } catch (error) {
    await writeFailureArtifacts({
      error,
      artifacts,
      runOptions,
      command,
      mode: "history-scrollbar",
      trace,
      session,
      browserConsole,
      page,
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
      await session.stop().catch(() => {});
    }
  }
}
