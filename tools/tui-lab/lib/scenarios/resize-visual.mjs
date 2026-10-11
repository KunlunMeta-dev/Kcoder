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
  VISUAL_RESIZE_SEQUENCE,
  visualResizeChromeCheck,
} from "../terminal-geometry.mjs";
import path from "node:path";

export async function runResizeVisualScenario(options) {
  const artifacts = await createRunContext(
    options,
    "resize-visual",
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
  await writeStartMeta(artifacts, runOptions, command, "resize-visual");
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

    const resizeCaptures = [];
    const resizeChecks = [];
    for (const [index, size] of VISUAL_RESIZE_SEQUENCE.entries()) {
      await page.setViewportSize(size);
      await page.waitForTimeout(450);
      await page.evaluate(() => window.tuiLab.scrollToBottom());
      await page.waitForTimeout(100);
      const screenshot = path.join(
        artifacts.dir,
        `resize-visual-${index + 1}.png`,
      );
      await captureStep(page, trace, `resize-visual-${index + 1}`, screenshot);
      const text = await page.evaluate(() => window.tuiLab.text());
      const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
      const check = visualResizeChromeCheck(text, `resize-visual-${index + 1}`);
      resizeChecks.push(check);
      resizeCaptures.push({
        step: index + 1,
        ...size,
        screenshot,
        dimensions,
        check,
      });
    }

    const text = await page.evaluate(() => window.tuiLab.text());
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const failed = resizeChecks.flatMap((check) => check.failed);
    const assertions = {
      ok: failed.length === 0,
      failed,
      checks: resizeChecks,
    };
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `TUI resize-visual assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "resize-visual",
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
      resizeSequence: VISUAL_RESIZE_SEQUENCE,
      resizeCaptures,
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      hasScrollbar,
      dimensions,
      trace,
      ptyExit: session.getExitInfo(),
      ptyDiagnostics: session.getDiagnostics(),
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "resize-visual",
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
      mode: "resize-visual",
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
