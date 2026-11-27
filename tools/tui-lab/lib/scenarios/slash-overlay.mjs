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
  waitForComposerText,
} from "../terminal-interaction.mjs";
import path from "node:path";
import { runSlashOverlayAssertions } from "../scenario-assertions.mjs";

export async function runSlashOverlayScenario(options) {
  const artifacts = await createRunContext(
    options,
    "slash-overlay",
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
  await writeStartMeta(artifacts, runOptions, command, "slash-overlay");
  try {
    session = await startSession(runOptions);
    browser = await chromium.launch(browserLaunchOptions(options));
    page = await browser.newPage({
      viewport: {
        width: Math.max(700, options.cols * 9 + 80),
        height: Math.max(260, options.rows * 18 + 80),
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
    const startupScreenshot = path.join(
      artifacts.dir,
      "startup-before-slash.png",
    );
    await captureStep(page, trace, "startup-before-slash", startupScreenshot);
    stageTexts.startupBeforeSlash = await page.evaluate(() =>
      window.tuiLab.text(),
    );

    await page.keyboard.insertText("/");
    await page.waitForTimeout(250);
    const slashOpenScreenshot = path.join(artifacts.dir, "slash-open.png");
    await captureStep(page, trace, "slash-open", slashOpenScreenshot);
    stageTexts.slashOpen = await page.evaluate(() => window.tuiLab.text());

    await typeHumanText(page, "model");
    await waitForComposerText(page, "/model", options.timeoutMs);
    const slashModelQueryScreenshot = path.join(
      artifacts.dir,
      "slash-model-query.png",
    );
    await captureStep(
      page,
      trace,
      "slash-model-query",
      slashModelQueryScreenshot,
    );
    stageTexts.slashModelQuery = await page.evaluate(() =>
      window.tuiLab.text(),
    );

    await page.keyboard.press("Enter");
    await waitForTerminalText(page, "Select Model", options.timeoutMs);
    await page.waitForTimeout(250);
    const modelPickerScreenshot = path.join(artifacts.dir, "model-picker.png");
    await captureStep(page, trace, "model-picker", modelPickerScreenshot);
    stageTexts.modelPicker = await page.evaluate(() => window.tuiLab.text());

    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    await page.keyboard.press("?");
    await page.waitForTimeout(250);
    const footerShortcutsScreenshot = path.join(
      artifacts.dir,
      "footer-shortcuts.png",
    );
    await captureStep(
      page,
      trace,
      "footer-shortcuts",
      footerShortcutsScreenshot,
    );
    stageTexts.footerShortcuts = await page.evaluate(() =>
      window.tuiLab.text(),
    );

    const text = await page.evaluate(() => window.tuiLab.text());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const assertions = runSlashOverlayAssertions({ stageTexts, trace });
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `TUI slash-overlay assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "slash-overlay",
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
      screenshots: {
        slashOpen: slashOpenScreenshot,
        slashModelQuery: slashModelQueryScreenshot,
        modelPicker: modelPickerScreenshot,
        footerShortcuts: footerShortcutsScreenshot,
      },
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      hasScrollbar,
      dimensions,
      trace,
      stageTexts,
      ptyExit: session.getExitInfo(),
      ptyDiagnostics: session.getDiagnostics(),
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "slash-overlay",
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
      mode: "slash-overlay",
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
