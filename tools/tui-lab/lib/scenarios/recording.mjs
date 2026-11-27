import {
  withinAbsoluteDeadline,
  remainingDeadlineMs,
  collectRecordingTimelineSamples,
  moveRecordedVideo,
  compressVideo,
  probeVideo,
  extractVideoFrames,
  validateRecordingSuccess,
} from "../recording-artifacts.mjs";
import {
  createRunContext,
  verifyRunContextIntegrity,
} from "../run-context.mjs";
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
import { mkdir } from "node:fs/promises";
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
import { sleep } from "../timing.mjs";
import {
  settleLifecycleStep,
  validateBrowserCleanup,
} from "../browser-lifecycle.mjs";
import { captureFailurePageEvidence } from "../failure-artifact.mjs";

export async function runRecordingScenario(options) {
  const scenarioDeadlineMs = Date.now() + options.timeoutMs;
  const cleanupReserveMs = Math.min(
    12000,
    Math.max(2000, Math.floor(options.timeoutMs / 5)),
  );
  const workDeadlineMs = scenarioDeadlineMs - cleanupReserveMs;
  const stage = (label, promise, deadlineMs = workDeadlineMs) =>
    withinAbsoluteDeadline(promise, deadlineMs, label);
  const cleanupTimeout = (capMs) =>
    Math.max(1, remainingDeadlineMs(scenarioDeadlineMs, {}, capMs));
  const artifacts = await stage(
    "recording run-context preparation",
    createRunContext(options, "record", runContextRuntime()),
  );
  const runOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const command = defaultCommandString(runOptions);
  const trace = [];
  const browserConsole = [];
  const timeline = {
    sampleFps: options.sampleFps,
    recordSeconds: options.recordSeconds,
    launchedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    events: [],
    samples: [],
  };
  let session;
  let browser;
  let context;
  let page;
  let stopSampling = false;
  let samplePromise = null;
  let cleanupFinished = false;
  let cleanupReport = null;
  try {
    await stage(
      "recording start metadata",
      writeStartMeta(artifacts, runOptions, command, "record"),
    );
    await stage(
      "recording artifact directories",
      Promise.all([
        mkdir(artifacts.recordingSamplesDir, { recursive: false, mode: 0o755 }),
        mkdir(artifacts.recordingFramesDir, { recursive: false, mode: 0o755 }),
      ]),
    );
    session = await stage(
      "recording PTY session startup",
      startSession(runOptions),
    );
    browser = await stage(
      "recording browser startup",
      chromium.launch(browserLaunchOptions(options)),
    );
    const viewport = {
      width: Math.max(900, options.cols * 9 + 80),
      height: Math.max(640, options.rows * 18 + 80),
    };
    context = await stage(
      "recording browser context startup",
      browser.newContext({
        viewport,
        recordVideo: {
          dir: artifacts.dir,
          size: viewport,
        },
      }),
    );
    page = await stage("recording page startup", context.newPage());
    const video = page.video();
    attachBrowserConsole(page, browserConsole);
    await stage("recording page navigation", page.goto(session.url));
    await stage(
      "recording terminal readiness",
      page.waitForFunction(() => window.tuiLab && window.tuiLab.ready, null, {
        timeout: options.timeoutMs,
      }),
    );

    const readyAtMs = Date.now();
    await stage(
      "recording welcome text",
      waitForTerminalText(page, "Welcome to KCoder!", options.timeoutMs),
    );
    timeline.events.push({
      name: "welcome",
      startupAtMs: Date.now() - readyAtMs,
      at: new Date().toISOString(),
    });
    await stage(
      "recording welcome capture",
      captureStep(page, trace, "welcome", artifacts.welcomeScreenshot),
    );

    if (options.sendMessage) {
      await stage(
        "recording message submission",
        (async () => {
          await page.locator("#terminal").click();
          await typeHumanText(page, options.message);
          await page.waitForTimeout(250);
          await page.keyboard.press("Enter");
        })(),
      );
      timeline.events.push({
        name: "message-submitted",
        at: new Date().toISOString(),
        message: options.message,
      });
      await stage(
        "recording after-enter capture",
        captureStep(page, trace, "after-enter", artifacts.afterEnterScreenshot),
      );
    }

    const startedAtMs = Date.now();
    const recordingDeadlineMs = Math.min(
      workDeadlineMs,
      startedAtMs + Math.round(options.recordSeconds * 1000),
    );
    timeline.startedAt = new Date(startedAtMs).toISOString();
    timeline.events.push({
      name: "recording-started",
      atMs: 0,
      at: timeline.startedAt,
    });
    samplePromise = collectRecordingTimelineSamples({
      page,
      artifacts,
      timeline,
      startedAtMs,
      options,
      shouldStop: () => stopSampling,
      runtime: { deadlineMs: recordingDeadlineMs },
    });

    await sleep(Math.max(0, recordingDeadlineMs - Date.now()));
    stopSampling = true;
    await stage(
      "recording timeline sampling",
      samplePromise,
      Math.min(workDeadlineMs, recordingDeadlineMs + 100),
    );
    samplePromise = null;
    timeline.finishedAt = new Date().toISOString();
    timeline.events.push({
      name: "recording-stopped",
      atMs: Date.now() - startedAtMs,
      at: timeline.finishedAt,
    });

    const [text, dimensions, hasScrollbar] = await stage(
      "recording final page evidence",
      Promise.all([
        page.evaluate(() => window.tuiLab.text()),
        page.evaluate(() => window.tuiLab.dimensions()),
        page.evaluate(() => window.tuiLab.hasScrollbar()),
      ]),
    );
    await stage(
      "recording final capture",
      captureStep(page, trace, "final", artifacts.finalScreenshot),
    );
    await stage(
      "recording evidence writes",
      Promise.all([
        writeTextArtifact(artifacts.text, text),
        writeTextArtifact(artifacts.ptyLog, session.getPtyLog()),
        writeTextArtifact(
          artifacts.browserConsoleLog,
          formatBrowserConsole(browserConsole),
        ),
        writeJsonArtifact(artifacts.recordingTimeline, timeline),
      ]),
    );

    const cleanupSteps = [];
    cleanupSteps.push(
      await settleLifecycleStep(
        "context",
        () => context.close(),
        cleanupTimeout(5000),
      ),
    );
    context = null;
    const rawVideo = await moveRecordedVideo(video, artifacts.recordingRaw, {
      deadlineMs: workDeadlineMs,
    });
    const mediaRuntime = { deadlineMs: workDeadlineMs };
    const compression = rawVideo
      ? compressVideo(
          rawVideo,
          artifacts.recordingVideo,
          options.videoFps,
          mediaRuntime,
        )
      : {
          ok: false,
          skipped: true,
          reason: "Playwright did not produce a video",
        };
    const selectedVideo = compression.ok ? artifacts.recordingVideo : rawVideo;
    const videoProbe = selectedVideo
      ? probeVideo(selectedVideo, mediaRuntime)
      : null;
    const extractedFrames = selectedVideo
      ? extractVideoFrames(
          selectedVideo,
          artifacts.recordingFramesDir,
          options.sampleFps,
          mediaRuntime,
        )
      : { ok: false, skipped: true, reason: "no video to sample" };

    cleanupSteps.push(
      await settleLifecycleStep(
        "browser",
        () => browser.close(),
        cleanupTimeout(5000),
      ),
    );
    browser = null;
    cleanupSteps.push(
      await settleLifecycleStep(
        "session",
        () => session.stop(),
        cleanupTimeout(5000),
      ),
    );
    const ptyExit = await settleLifecycleStep(
      "pty-exit",
      () => session.exitPromise,
      cleanupTimeout(1000),
    );
    cleanupReport = {
      steps: cleanupSteps,
      ptyExitObserved: ptyExit.status === "completed",
      ptyExit: ptyExit.status === "completed" ? ptyExit.value : null,
    };
    cleanupFinished = true;
    validateBrowserCleanup(cleanupReport);
    validateRecordingSuccess({
      timeline,
      rawVideo,
      compression,
      videoProbe,
      extractedFrames,
    });
    await stage(
      "recording artifact integrity",
      verifyRunContextIntegrity(artifacts, runContextRuntime()),
      scenarioDeadlineMs,
    );

    await stage(
      "recording success metadata",
      writeJsonArtifact(artifacts.meta, {
        ok: true,
        mode: "record",
        command,
        cwd: repoRoot,
        runId: artifacts.runId,
        date: artifacts.dateStamp,
        time: artifacts.timeStamp,
        description: artifacts.description,
        dateDir: artifacts.dateDir,
        runLabel: artifacts.runLabel,
        runDir: artifacts.dir,
        workspace: artifacts.workspace,
        workspaceTemplate: artifacts.workspaceTemplate,
        message: options.sendMessage ? options.message : undefined,
        sendMessage: options.sendMessage,
        scenario: options.scenario,
        recordSeconds: options.recordSeconds,
        sampleFps: options.sampleFps,
        videoFps: options.videoFps,
        screenshots: {
          welcome: artifacts.welcomeScreenshot,
          afterEnter: options.sendMessage
            ? artifacts.afterEnterScreenshot
            : undefined,
          final: artifacts.finalScreenshot,
        },
        rawVideo,
        video: selectedVideo,
        compressedVideo: compression.ok ? artifacts.recordingVideo : undefined,
        compression,
        videoProbe,
        extractedFrames,
        cleanup: cleanupReport,
        recordingTimeline: artifacts.recordingTimeline,
        recordingSamplesDir: artifacts.recordingSamplesDir,
        recordingFramesDir: artifacts.recordingFramesDir,
        text: artifacts.text,
        ptyLog: artifacts.ptyLog,
        browserConsoleLog: artifacts.browserConsoleLog,
        hasScrollbar,
        dimensions,
        trace,
        ptyExit: session.getExitInfo(),
        ptyDiagnostics: session.getDiagnostics(),
      }),
      scenarioDeadlineMs,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "record",
          runDir: artifacts.dir,
          video: selectedVideo,
          rawVideo,
          recordingTimeline: artifacts.recordingTimeline,
          recordingSamplesDir: artifacts.recordingSamplesDir,
          recordingFramesDir: artifacts.recordingFramesDir,
          sampleCount: timeline.samples.length,
          extractedFrames,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    stopSampling = true;
    const pageEvidence = await captureFailurePageEvidence({
      page,
      failureScreenshot: artifacts.failureScreenshot,
      timeoutMs: cleanupTimeout(1000),
    });
    if (!cleanupFinished) {
      const cleanupSteps = [];
      if (samplePromise) {
        cleanupSteps.push(
          await settleLifecycleStep(
            "recording-samples",
            () => samplePromise,
            cleanupTimeout(1000),
          ),
        );
        samplePromise = null;
      }
      if (context) {
        cleanupSteps.push(
          await settleLifecycleStep(
            "context",
            () => context.close(),
            cleanupTimeout(5000),
          ),
        );
        context = null;
      }
      if (browser) {
        cleanupSteps.push(
          await settleLifecycleStep(
            "browser",
            () => browser.close(),
            cleanupTimeout(5000),
          ),
        );
        browser = null;
      }
      let ptyExitObserved = !session;
      let ptyExit = null;
      if (session) {
        cleanupSteps.push(
          await settleLifecycleStep(
            "session",
            () => session.stop(),
            cleanupTimeout(5000),
          ),
        );
        const exitOutcome = await settleLifecycleStep(
          "pty-exit",
          () => session.exitPromise,
          cleanupTimeout(1000),
        );
        ptyExitObserved = exitOutcome.status === "completed";
        ptyExit = ptyExitObserved ? exitOutcome.value : null;
      }
      cleanupReport = { steps: cleanupSteps, ptyExitObserved, ptyExit };
      cleanupFinished = true;
    }
    error.cleanup = cleanupReport;
    await writeFailureArtifacts({
      artifacts,
      runOptions,
      command,
      mode: "record",
      session,
      page,
      browserConsole,
      trace,
      error,
      pageEvidence,
    });
    throw error;
  } finally {
    stopSampling = true;
    if (!cleanupFinished && context) {
      await settleLifecycleStep(
        "context",
        () => context.close(),
        cleanupTimeout(5000),
      );
      context = null;
    }
    if (!cleanupFinished && browser) {
      await settleLifecycleStep(
        "browser",
        () => browser.close(),
        cleanupTimeout(5000),
      );
      browser = null;
    }
    if (!cleanupFinished && session) {
      await settleLifecycleStep(
        "session",
        () => session.stop(),
        cleanupTimeout(5000),
      );
    }
  }
}
