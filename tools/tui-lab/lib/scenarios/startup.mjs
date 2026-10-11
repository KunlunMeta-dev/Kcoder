import { createRunContext } from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import {
  defaultCommandString,
  browserLaunchOptions,
} from "../runner-options.mjs";
import {
  settleLifecycleStep,
  validateBrowserCleanup,
} from "../browser-lifecycle.mjs";
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
import { waitForTerminalText } from "../terminal-interaction.mjs";
import { runStartupAssertions } from "../scenario-assertions.mjs";

export async function runStartupScenario(options) {
  const artifacts = await createRunContext(
    options,
    "startup",
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
  let cleanupPromise;
  const cleanupOnce = () => {
    cleanupPromise ||= (async () => {
      const steps = [];
      if (browser)
        steps.push(
          await settleLifecycleStep("browser", () => browser.close(), 5000),
        );
      if (session) {
        steps.push(
          await settleLifecycleStep("session", () => session.stop(), 5000),
        );
        const exit = await settleLifecycleStep(
          "pty-exit",
          () => session.exitPromise,
          1000,
        );
        return {
          steps,
          ptyExitObserved: exit.status === "completed",
          ptyExit: exit.value ?? null,
        };
      }
      return { steps, ptyExitObserved: true, ptyExit: null };
    })();
    return cleanupPromise;
  };
  await writeStartMeta(artifacts, runOptions, command, "startup");
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
    await waitForTerminalText(page, "Welcome to KCoder!", options.timeoutMs);
    await page.waitForTimeout(350);
    await captureStep(page, trace, "welcome", artifacts.welcomeScreenshot);

    const text = await page.evaluate(() => window.tuiLab.text());
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const assertions = runStartupAssertions({ text, trace });
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `TUI startup assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    // Successful startup-validation artifacts require both browser closure and confirmed PTY exit.
    const cleanup = await cleanupOnce();
    validateBrowserCleanup(cleanup);
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "startup",
      cleanup,
      browserLaunch: browserLaunchOptions(options),
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
        welcome: artifacts.welcomeScreenshot,
      },
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
          mode: "startup",
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
      mode: "startup",
      session,
      page,
      browserConsole,
      trace,
      error,
    });
    throw error;
  } finally {
    await cleanupOnce();
  }
}
