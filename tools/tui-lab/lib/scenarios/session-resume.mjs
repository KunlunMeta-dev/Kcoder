import { createRunContext } from "../run-context.mjs";
import { runContextRuntime } from "../runtime-paths.mjs";
import path from "node:path";
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
import { chromium } from "@playwright/test";
import { startSession } from "../session.mjs";
import {
  attachBrowserConsole,
  captureStep,
  formatBrowserConsole,
} from "../browser-evidence.mjs";
import {
  waitForTerminalText,
  submitTerminalLine,
} from "../terminal-interaction.mjs";
import {
  extractTuiSessionId,
  waitForProjectDirForSession,
} from "../session-memory-evidence.mjs";
import { pressRepeated } from "../scroll-metrics.mjs";
import {
  waitForRequestEvidence,
  waitForOrchestrateControlEvidence,
} from "../evidence.mjs";
import { readFile } from "node:fs/promises";
import { sleep } from "../timing.mjs";

export async function runSessionResumeScenario(options) {
  const artifacts = await createRunContext(
    options,
    "session-resume",
    runContextRuntime(),
  );
  const firstRequestsDir = path.join(artifacts.requestsDir, "first");
  const resumedRequestsDir = path.join(artifacts.requestsDir, "resumed");
  const baseRunOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    configHome: artifacts.configHome,
  };
  const command = defaultCommandString(baseRunOptions);
  const trace = [];
  const browserConsole = [];
  const beforeMarker = `WINDOWS_RESUME_BEFORE_${artifacts.runLabel}`;
  const afterMarker = `WINDOWS_RESUME_AFTER_${artifacts.runLabel}`;
  let session;
  let browser;
  let page;
  let firstPtyLog = "";
  let transcriptPath = "";
  let projectDir = artifacts.projectDir;
  let sessionId = "";
  await writeStartMeta(artifacts, baseRunOptions, command, "session-resume");
  try {
    browser = await chromium.launch(browserLaunchOptions(options));
    session = await startSession({
      ...baseRunOptions,
      requestsDir: firstRequestsDir,
    });
    page = await browser.newPage({
      viewport: {
        width: Math.max(900, options.cols * 9 + 80),
        height: Math.max(640, options.rows * 18 + 80),
      },
    });
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
    const welcomeText = await page.evaluate(() => window.tuiLab.text());
    sessionId = extractTuiSessionId(welcomeText);
    await submitTerminalLine(page, beforeMarker);
    await waitForTerminalText(
      page,
      "tui-lab-final-sentinel",
      options.timeoutMs,
    );
    await captureStep(
      page,
      trace,
      "before-resume-source",
      artifacts.afterEnterScreenshot,
    );
    projectDir = await waitForProjectDirForSession(
      artifacts.configDir,
      sessionId,
      options.timeoutMs,
    );
    artifacts.projectDir = projectDir;
    artifacts.projectKey = path.basename(projectDir);
    transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    firstPtyLog = session.getPtyLog();
    await session.stop();
    session = null;
    await page.close();
    page = null;

    session = await startSession({
      ...baseRunOptions,
      requestsDir: resumedRequestsDir,
    });
    page = await browser.newPage({
      viewport: {
        width: Math.max(900, options.cols * 9 + 80),
        height: Math.max(640, options.rows * 18 + 80),
      },
    });
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
    await submitTerminalLine(page, `/resume ${transcriptPath}`);
    await waitForTerminalText(page, "Resumed session from", options.timeoutMs);
    const resumeTailText = await page.evaluate(() => window.tuiLab.text());
    if (options.scenario === "orchestrate-control") {
      await pressRepeated(page, "PageUp", 16);
      await waitForTerminalText(
        page,
        "Paused.",
        Math.min(options.timeoutMs, 12_000),
      );
      await waitForTerminalText(
        page,
        "queue 1",
        Math.min(options.timeoutMs, 12_000),
      );
    }
    const resumeText = await page.evaluate(() => window.tuiLab.text());
    await captureStep(
      page,
      trace,
      "after-resume",
      artifacts.afterToolScreenshot,
    );
    if (options.scenario === "orchestrate-control") {
      await pressRepeated(page, "PageDown", 16);
    }
    await submitTerminalLine(page, afterMarker);
    await waitForTerminalText(
      page,
      "tui-lab-second-turn-sentinel",
      options.timeoutMs,
    );
    await captureStep(
      page,
      trace,
      "after-resumed-turn",
      artifacts.finalScreenshot,
    );

    const resumedText = await page.evaluate(() => window.tuiLab.text());
    const requestEvidence = await waitForRequestEvidence(resumedRequestsDir, {
      mustContain: [beforeMarker, afterMarker],
      timeoutMs: Math.min(options.timeoutMs, 8000),
    });
    let transcript = "";
    const transcriptDeadline = Date.now() + Math.min(options.timeoutMs, 8000);
    do {
      transcript = await readFile(transcriptPath, "utf8").catch(() => "");
      if (transcript.includes(afterMarker)) break;
      await sleep(150);
    } while (Date.now() < transcriptDeadline);
    const orchestrateControlEvidence =
      options.scenario === "orchestrate-control"
        ? await waitForOrchestrateControlEvidence(projectDir, sessionId, {
            timeoutMs: Math.min(options.timeoutMs, 12_000),
          })
        : null;

    const checks = [
      {
        name: "resume-command-confirmed",
        ok: resumeTailText.includes("Resumed session from"),
      },
      {
        name: "resume-renders-prior-assistant-output",
        ok: resumeTailText.includes("tui-lab-final-sentinel"),
      },
      {
        name: "resumed-turn-completes",
        ok: resumedText.includes("tui-lab-second-turn-sentinel"),
      },
      {
        name: "resumed-request-contains-prior-marker",
        ok: requestEvidence.hasAllRequired,
      },
      {
        name: "resumed-transcript-appends-new-marker",
        ok: transcript.includes(afterMarker),
      },
    ];
    if (options.scenario === "orchestrate-control") {
      checks.push(
        {
          name: "resumed-orchestrate-panel-restores-paused-state",
          ok: resumeText.includes("Paused.") && resumeText.includes("queue 1"),
        },
        {
          name: "resumed-orchestrate-sidecar-retains-control-and-delivery",
          ok: Boolean(orchestrateControlEvidence?.hasAllRequired),
          ...(orchestrateControlEvidence || {}),
        },
      );
    }
    const failed = checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
    const assertions = { ok: failed.length === 0, failed, checks };
    await writeTextArtifact(artifacts.text, resumedText);
    await writeTextArtifact(
      artifacts.ptyLog,
      `${firstPtyLog}\n\n--- resumed process ---\n\n${session.getPtyLog()}`,
    );
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `Session resume assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "session-resume",
      command,
      runId: artifacts.runId,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      configHome: artifacts.configHome,
      projectDir,
      sessionId,
      transcriptPath,
      firstRequestsDir,
      resumedRequestsDir,
      markers: { beforeMarker, afterMarker },
      requestEvidence,
      orchestrateControlEvidence,
      assertions: artifacts.assertions,
      trace,
      ptyExit: session.getExitInfo(),
      ptyDiagnostics: session.getDiagnostics(),
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "session-resume",
          runDir: artifacts.dir,
          sessionId,
          transcriptPath,
          requestEvidence,
          orchestrateControlEvidence,
          assertions,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFailureArtifacts({
      artifacts,
      runOptions: baseRunOptions,
      command,
      mode: "session-resume",
      session,
      page,
      browserConsole,
      trace,
      error,
    });
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (session) await session.stop().catch(() => {});
  }
}
