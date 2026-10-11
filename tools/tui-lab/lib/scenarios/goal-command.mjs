import { createRunContext } from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import {
  defaultCommandString,
  browserLaunchOptions,
} from "../runner-options.mjs";
import {
  typeHumanText,
  waitForTerminalText,
  waitForComposerText,
  waitForTerminalTextPattern,
} from "../terminal-interaction.mjs";
import path from "node:path";
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
  settleLifecycleStep,
  validateBrowserCleanup,
} from "../browser-lifecycle.mjs";
import { runGoalCommandAssertions } from "../scenario-assertions.mjs";

export async function runGoalCommandScenario(options) {
  // This scenario asserts the complete lifecycle footer. Compact-width behavior
  // is covered separately by resize-visual and slash-overlay.
  options = { ...options, cols: Math.max(options.cols, 180) };
  const artifacts = await createRunContext(
    options,
    "goal-command",
    runContextRuntime(),
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
  let session;
  let browser;
  let page;
  const stageTexts = {};
  const submitGoalLine = async (page, text) => {
    await page.evaluate(() => window.tuiLab.focus());
    await typeHumanText(page, text);
    await page.waitForTimeout(120);
    await page.evaluate(() => window.tuiLab.sendInput("\r"));
  };
  const screenshots = {
    slashGoal: path.join(artifacts.dir, "slash-goal-filter.png"),
    invalidBudget: path.join(artifacts.dir, "goal-invalid-budget.png"),
    goalRunning: path.join(artifacts.dir, "goal-running.png"),
    goalPaused: path.join(artifacts.dir, "goal-paused.png"),
    answerRunning: path.join(artifacts.dir, "goal-pro-answer-running.png"),
    answerStatus: path.join(artifacts.dir, "goal-pro-answer-status.png"),
  };
  await writeStartMeta(artifacts, runOptions, command, "goal-command");
  try {
    session = await startSession(runOptions);
    browser = await chromium.launch(browserLaunchOptions(options));
    page = await browser.newPage({
      viewport: {
        width: Math.max(900, options.cols * 9 + 80),
        height: Math.max(560, options.rows * 18 + 80),
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
    await page.locator("#terminal").click();

    const removedCommand = `/${"lo"}${"op"}`;
    await typeHumanText(page, removedCommand);
    await waitForComposerText(page, removedCommand, options.timeoutMs);
    stageTexts.legacyGoalAbsent = await page.evaluate(() =>
      window.tuiLab.text(),
    );
    await page.keyboard.press("Control+U");
    await page.waitForTimeout(200);

    await page.keyboard.insertText("/");
    await page.waitForTimeout(150);
    await typeHumanText(page, "goal");
    await waitForComposerText(page, "/goal", options.timeoutMs);
    await captureStep(page, trace, "slash-goal-filter", screenshots.slashGoal);
    stageTexts.slashGoal = await page.evaluate(() => window.tuiLab.text());
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+U");
    await page.waitForTimeout(200);

    await typeHumanText(page, "/goal --budget");
    await page.waitForTimeout(350);
    await page.keyboard.press("Enter");
    await waitForTerminalText(page, "Usage: /goal", options.timeoutMs);
    await page.waitForTimeout(250);
    await captureStep(
      page,
      trace,
      "goal-invalid-budget",
      screenshots.invalidBudget,
    );
    stageTexts.invalidBudget = await page.evaluate(() => window.tuiLab.text());

    await typeHumanText(
      page,
      "/goal --budget 50000 验证长任务体验，持续检查状态、滚动和停止方式。",
    );
    await page.waitForTimeout(350);
    await page.keyboard.press("Enter");
    await waitForTerminalText(
      page,
      "Goal started (budget: 50000 tokens)",
      options.timeoutMs,
    );
    await waitForTerminalTextPattern(
      page,
      "Goal running turn \\d+",
      options.timeoutMs,
    );
    stageTexts.goalTurnObserved = "Goal running turn observed by terminal wait";
    stageTexts.goalTurn = await page.evaluate(() => window.tuiLab.text());
    await page.waitForTimeout(500);
    await captureStep(page, trace, "goal-running", screenshots.goalRunning);
    stageTexts.goalRunning = await page.evaluate(() => window.tuiLab.text());

    // Focus without clicking transcript cells: a click creates a selection,
    // whose Escape handler intentionally clears selection before pausing.
    await page.evaluate(() => window.tuiLab.focus());
    await page.keyboard.press("Escape");
    await waitForTerminalText(page, "Goal paused", options.timeoutMs);
    await page.waitForTimeout(250);
    await captureStep(page, trace, "goal-paused", screenshots.goalPaused);
    stageTexts.goalPaused = await page.evaluate(() => window.tuiLab.text());

    // The pause notice appears before the foreground turn fully exits; a new session prevents the Answer command from entering the follow-up queue.
    const restartSteps = [];
    restartSteps.push(
      await settleLifecycleStep("restart-browser", () => browser.close(), 5000),
    );
    restartSteps.push(
      await settleLifecycleStep("restart-session", () => session.stop(), 5000),
    );
    const restartPtyExit = await settleLifecycleStep(
      "restart-pty-exit",
      () => session.exitPromise,
      1000,
    );
    const restartCleanup = {
      steps: restartSteps,
      ptyExitObserved: restartPtyExit.status === "completed",
      ptyExit:
        restartPtyExit.status === "completed" ? restartPtyExit.value : null,
    };
    validateBrowserCleanup(restartCleanup);
    browser = null;
    session = null;
    session = await startSession({
      ...runOptions,
      streamDelayMs: Math.max(runOptions.streamDelayMs || 0, 80),
    });
    browser = await chromium.launch(browserLaunchOptions(options));
    page = await browser.newPage({
      viewport: {
        width: Math.max(900, options.cols * 9 + 80),
        height: Math.max(560, options.rows * 18 + 80),
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
    await submitGoalLine(
      page,
      "/goal-pro --answer --budget 50000 审核最终研究结论并输出可复核报告。",
    );
    await waitForTerminalTextPattern(
      page,
      "Goal Pro running turn \\d+",
      options.timeoutMs,
    );
    stageTexts.answerRunning = await page.evaluate(() => window.tuiLab.text());
    await captureStep(
      page,
      trace,
      "goal-pro-answer-running",
      screenshots.answerRunning,
    );
    // Focus without clicking transcript cells: a click creates a selection,
    // whose Escape handler intentionally clears selection before pausing.
    await page.evaluate(() => window.tuiLab.focus());
    await page.keyboard.press("Escape");
    await waitForTerminalText(page, "/goal-pro resume", options.timeoutMs);
    // The pause notice precedes foreground-task cleanup; allow time for slash commands to return to the direct execution path.
    await page.waitForTimeout(2000);
    await submitGoalLine(page, "/goal-pro status");
    await waitForTerminalText(page, "verification=answer", options.timeoutMs);
    await captureStep(
      page,
      trace,
      "goal-pro-answer-status",
      screenshots.answerStatus,
    );
    stageTexts.answerStatus = await page.evaluate(() => window.tuiLab.text());

    const text = await page.evaluate(() => window.tuiLab.text());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const assertions = runGoalCommandAssertions({ stageTexts, text });
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `TUI goal-command assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    const ptyDiagnostics = session.getDiagnostics();
    const cleanupSteps = [];
    cleanupSteps.push(
      await settleLifecycleStep("browser", () => browser.close(), 5000),
    );
    browser = null;
    const completedSession = session;
    cleanupSteps.push(
      await settleLifecycleStep("session", () => completedSession.stop(), 5000),
    );
    const ptyExit = await settleLifecycleStep(
      "pty-exit",
      () => completedSession.exitPromise,
      1000,
    );
    const cleanup = {
      steps: cleanupSteps,
      ptyExitObserved: ptyExit.status === "completed",
      ptyExit: ptyExit.status === "completed" ? ptyExit.value : null,
    };
    validateBrowserCleanup(cleanup);
    session = null;
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "goal-command",
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
      scenario: options.scenario,
      screenshots,
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      hasScrollbar,
      dimensions,
      trace,
      stageTexts,
      restartCleanup,
      cleanup,
      ptyExit: cleanup.ptyExit,
      ptyDiagnostics,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "goal-command",
          ...artifacts,
          hasScrollbar,
          dimensions,
          assertions,
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
      mode: "goal-command",
      session,
      page,
      browserConsole,
      trace,
      error,
    });
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (session) {
      await session.stop().catch(() => {});
    }
  }
}
