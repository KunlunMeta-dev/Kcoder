import { createRunContext } from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import {
  defaultCommandString,
  browserLaunchOptions,
} from "../runner-options.mjs";
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
  waitForTerminalText,
  typeHumanText,
} from "../terminal-interaction.mjs";
import { runSlashAfterHistoryAssertions } from "../scenario-assertions.mjs";
import { settleWithin } from "../platform-adapter.mjs";

export async function runSlashAfterHistoryScenario(options) {
  const artifacts = await createRunContext(
    options,
    "slash-after-history",
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
  const beforeSlashScreenshot = path.join(
    artifacts.dir,
    "before-slash-after-history.png",
  );
  const slashAfterHistoryScreenshot = path.join(
    artifacts.dir,
    "slash-after-history.png",
  );
  await writeStartMeta(artifacts, runOptions, command, "slash-after-history");
  try {
    session = await startSession(runOptions);
    browser = await chromium.launch(browserLaunchOptions(options));
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
    await page.locator("#terminal").click();
    await typeHumanText(page, options.message);
    await page.waitForTimeout(350);
    await page.keyboard.press("Enter");
    await waitForTerminalText(
      page,
      "tui-lab-final-sentinel",
      options.timeoutMs,
    );
    await page.waitForTimeout(250);
    await page.evaluate(() => window.tuiLab.scrollToBottom());
    await page.waitForTimeout(250);
    await captureStep(
      page,
      trace,
      "before-slash-after-history",
      beforeSlashScreenshot,
    );
    const beforeDimensions = await page.evaluate(() =>
      window.tuiLab.dimensions(),
    );

    await page.locator("#terminal").click();
    await page.keyboard.insertText("/");
    await page.waitForTimeout(350);
    await captureStep(
      page,
      trace,
      "slash-after-history",
      slashAfterHistoryScreenshot,
    );

    const text = await page.evaluate(() => window.tuiLab.text());
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const assertions = runSlashAfterHistoryAssertions({
      text,
      beforeDimensions,
      dimensions,
    });
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `TUI slash-after-history assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "slash-after-history",
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
      message: options.message,
      scenario: options.scenario,
      screenshots: {
        beforeSlash: beforeSlashScreenshot,
        slashAfterHistory: slashAfterHistoryScreenshot,
      },
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      hasScrollbar,
      beforeDimensions,
      dimensions,
      trace,
      ptyExit: session.getExitInfo(),
      ptyDiagnostics: session.getDiagnostics(),
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "slash-after-history",
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
      mode: "slash-after-history",
      session,
      page,
      browserConsole,
      trace,
      error,
    });
    throw error;
  } finally {
    if (browser) {
      await settleWithin(browser.close(), 5000);
    }
    if (session) {
      await settleWithin(session.stop(), 5000);
    }
  }
}
