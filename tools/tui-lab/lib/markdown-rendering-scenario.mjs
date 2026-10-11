import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  attachBrowserConsole,
  captureStep,
  formatBrowserConsole,
} from "./browser-evidence.mjs";
import {
  runBrowserScenarioLifecycle,
  settleLifecycleStep,
} from "./browser-lifecycle.mjs";
import {
  captureFailurePageEvidence,
  writeFailureArtifact,
} from "./failure-artifact.mjs";
import {
  browserLaunchOptions,
  defaultCommandString,
} from "./runner-options.mjs";
import { createRunContext, verifyRunContextIntegrity } from "./run-context.mjs";
import { submitTerminalLine } from "./terminal-interaction.mjs";

const json = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
const codeNeedle = 'let color = "stream";';

export async function runMarkdownRenderingScenario(options, runtime) {
  const artifacts = await createRunContext(
    options,
    "markdown-rendering",
    runtime.runContextRuntime(),
  );
  const runOptions = {
    ...options,
    scenario: "markdown-streaming",
    streamDelayMs: options.streamDelayMs || 100,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    configHome: artifacts.configHome,
    requestsDir: artifacts.requestsDir,
  };
  const command = defaultCommandString(runOptions);
  const trace = [];
  const browserConsole = [];
  const checks = [];
  const evidence = {};
  let browser;
  let session;
  let page;
  const assertions = () => ({ ok: checks.every((check) => check.ok), checks });
  const check = (name, ok, detail = {}) => {
    checks.push({ name, ok: Boolean(ok), ...detail });
    if (!ok)
      throw Object.assign(new Error(`markdown-rendering: ${name}`), {
        assertions: assertions(),
      });
  };
  const visible = () => page.evaluate(() => window.tuiLab.visibleText());
  const waitVisible = (needle) =>
    page.waitForFunction(
      (needle) => window.tuiLab?.visibleText().includes(needle),
      needle,
      { timeout: options.timeoutMs },
    );
  const styles = (needle) =>
    page.evaluate((needle) => window.tuiLab.textStyleCells(needle), needle);
  const capture = async (stage) => {
    await captureStep(
      page,
      trace,
      stage,
      path.join(artifacts.dir, `${stage}.png`),
    );
    await writeFile(path.join(artifacts.dir, `${stage}.txt`), await visible(), {
      mode: 0o644,
    });
  };
  await runtime.writeStartMeta(
    artifacts,
    runOptions,
    command,
    "markdown-rendering",
  );
  return runBrowserScenarioLifecycle({
    execute: async () => {
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      attachBrowserConsole(page, browserConsole);
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, {
        timeout: options.timeoutMs,
      });
      await waitVisible("TUI dev mode is running mock scenario");
      await capture("01-welcome");
      await submitTerminalLine(page, "Test colors in long streaming Markdown");
      // Reaching line 1600 means the fence exceeds 78 KiB; a final frame alone cannot prove streaming colors remained intact.
      await page.waitForFunction(
        () => {
          const text = window.tuiLab.visibleText();
          return (
            !text.includes("tui-lab-final-sentinel") &&
            [...text.matchAll(/codex-stream-line-(\d+)/g)].some(
              (match) => Number(match[1]) >= 1600,
            )
          );
        },
        null,
        { timeout: options.timeoutMs },
      );
      evidence.streaming = await styles(codeNeedle);
      check(
        "large-code-visible-before-final",
        !(await visible()).includes("tui-lab-final-sentinel"),
      );
      check(
        "streaming-code-has-multiple-syntax-colors",
        new Set(
          evidence.streaming[0]?.cells
            .filter((cell) => cell.rgb)
            .map((cell) => cell.fg),
        ).size >= 3,
      );
      await capture("02-streaming-above-64-kib");
      await waitVisible("tui-lab-final-sentinel");
      await page.waitForTimeout(400);
      evidence.final = await styles(codeNeedle);
      check(
        "final-code-preserves-streaming-colors",
        evidence.final.length > 0 &&
          JSON.stringify(evidence.final[0].cells) ===
            JSON.stringify(evidence.streaming[0].cells),
      );
      for (const [needle, color, underline] of [
        ["quote_green", 2, false],
        ["inline_cyan", 6, false],
        ["link_cyan", 6, true],
      ]) {
        evidence[needle] = await styles(needle);
        check(
          `${needle}-semantic-palette`,
          evidence[needle][0]?.cells.every(
            (cell) =>
              !cell.rgb && cell.fg === color && (!underline || cell.underline),
          ),
        );
      }
      evidence.heading = await styles("Markdown palette");
      check(
        "heading-bold",
        evidence.heading[0]?.cells.every((cell) => cell.bold),
      );
      evidence.ordered = (await styles("1. ")).filter((hit) =>
        hit.text.includes("ordered_blue"),
      );
      check(
        "ordered-marker-light-blue",
        evidence.ordered[0]?.cells
          .slice(0, 2)
          .every((cell) => !cell.rgb && cell.fg === 12),
      );
      evidence.table = await styles("Header");
      check(
        "table-header-uses-syntax-theme",
        evidence.table[0]?.cells.every((cell) => cell.bold && cell.rgb),
      );
      await capture("03-final-palette");
      await page.setViewportSize({ width: 900, height: 780 });
      await page.waitForTimeout(400);
      evidence.resized = await styles("inline_cyan");
      check(
        "resize-preserves-markdown-color",
        evidence.resized[0]?.cells.every((cell) => cell.fg === 6),
      );
      await capture("04-resized");
      await submitTerminalLine(page, "Verify streaming colors again");
      await page.waitForFunction(
        () =>
          !window.tuiLab.visibleText().includes("tui-lab-final-sentinel") &&
          window.tuiLab.textStyleCells('let color = "stream";').length > 0,
        null,
        { timeout: options.timeoutMs },
      );
      check(
        "second-turn-code-is-colored",
        (await styles(codeNeedle))[0]?.cells.some((cell) => cell.rgb),
      );
      await waitVisible("tui-lab-final-sentinel");
      await capture("05-second-turn");
      return await visible();
    },
    captureBeforeCleanup: () =>
      captureFailurePageEvidence({ page, timeoutMs: 1000 }),
    cleanup: async () => {
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
    },
    onFailure: (error, pageEvidence) =>
      writeFailureArtifact({
        artifacts,
        runOptions,
        command,
        mode: "markdown-rendering",
        session,
        page,
        browserConsole,
        trace,
        error,
        repoRoot: runtime.repoRoot,
        pageEvidence,
      }),
    onSuccess: async (text, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await Promise.all([
        writeFile(artifacts.text, text, { mode: 0o644 }),
        writeFile(artifacts.ptyLog, session.getPtyLog(), { mode: 0o644 }),
        writeFile(
          artifacts.browserConsoleLog,
          formatBrowserConsole(browserConsole),
          { mode: 0o644 },
        ),
        json(artifacts.assertions, assertions()),
        json(path.join(artifacts.dir, "color-evidence.json"), evidence),
        json(artifacts.meta, {
          ok: true,
          command,
          trace,
          cleanup,
          assertions: assertions(),
        }),
      ]);
      console.log(
        JSON.stringify(
          { ok: true, runDir: artifacts.dir, assertions: assertions() },
          null,
          2,
        ),
      );
    },
  });
}
