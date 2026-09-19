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
import {
  submitTerminalLine,
  typeHumanText,
  readComposerText,
  pressTerminalEscape,
  waitForComposerText,
} from "./terminal-interaction.mjs";

const json = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
export async function runTailMenuScenario(options, runtime) {
  const artifacts = await createRunContext(
    options,
    "tail-menu",
    runtime.runContextRuntime(),
  );
  const runOptions = {
    ...options,
    tuiLabMode: "tail-menu",
    scenario: "tail-follow",
    streamDelayMs: 200,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    configHome: artifacts.configHome,
    requestsDir: artifacts.requestsDir,
  };
  const command = defaultCommandString(runOptions);
  const trace = [],
    browserConsole = [],
    checks = [],
    samples = [];
  let browser, session, page;
  const assertions = () => ({ ok: checks.every((check) => check.ok), checks });
  const check = (name, ok) => {
    checks.push({ name, ok: Boolean(ok) });
    if (!ok)
      throw Object.assign(new Error(`tail-menu: ${name}`), {
        assertions: assertions(),
      });
  };
  const visible = () => page.evaluate(() => window.tuiLab.visibleText());
  const waitText = (text) =>
    page.waitForFunction(
      (text) => window.tuiLab?.visibleText().includes(text),
      text,
      { timeout: options.timeoutMs },
    );
  const state = async () => {
    const text = await visible();
    const markers = [...text.matchAll(/tui-lab-final-line-(\d{3})/g)].map(
      (match) => Number(match[1]),
    );
    const diagnostics = await page.evaluate(() =>
      window.tuiLab.viewportDiagnostics(),
    );
    const value = {
      at: Date.now(),
      first: markers[0],
      last: markers.at(-1),
      viewport: diagnostics.latestCommit,
      text,
    };
    samples.push(value);
    return value;
  };
  const tail = (value) => value.viewport?.anchor.includes("anchor: Tail");
  const capture = async (name) => {
    await captureStep(
      page,
      trace,
      name,
      path.join(artifacts.dir, `${name}.png`),
    );
    await writeFile(path.join(artifacts.dir, `${name}.txt`), await visible());
  };
  const clear = async () => {
    await page.keyboard.press("Control+U");
    await page.waitForTimeout(80);
  };
  const selected = (name) =>
    page.evaluate(
      (name) =>
        window.tuiLab
          .textStyleCells(name)
          .some(
            (hit) =>
              hit.text.trimStart().split(/\s+/)[0] === name &&
              hit.cells.every((cell) => cell.bold),
          ),
      name,
    );
  const chooseFromBareMenu = async (name) => {
    await typeHumanText(page, "/");
    await page.waitForTimeout(100);
    for (let step = 0; step < 80 && !(await selected(name)); step++) {
      await page.keyboard.press("ArrowDown");
      // Wait for the idle TUI's next draw frame so stale highlighting cannot send another arrow key past the target.
      await page.waitForTimeout(180);
    }
    check(`bare-menu-selects-${name}`, await selected(name));
  };
  const wheel = async (delta) => {
    const before = await page.evaluate(
      async () =>
        (await window.tuiLab.viewportDiagnostics()).latestInput
          ?.input_sequence || 0,
    );
    const box = await page.locator(".xterm-screen").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.wheel(0, delta);
    await page.waitForFunction(
      async (before) => {
        const state = await window.tuiLab.viewportDiagnostics();
        return (
          state.latestInput?.input_sequence > before &&
          state.latestCommit?.applied_through_input_sequence >=
            state.latestInput.input_sequence
        );
      },
      before,
      { timeout: 3000 },
    );
    // The server commit precedes browser rendering of PTY data; do not pair an old frame with new diagnostics.
    await page.waitForTimeout(150);
  };
  const reachTailByWheel = async (delta = 120) => {
    for (let i = 0; i < 250; i++) {
      if (tail(await state())) return;
      await wheel(delta);
    }
    check("wheel-reaches-tail", false);
  };
  await runtime.writeStartMeta(artifacts, runOptions, command, "tail-menu");
  return runBrowserScenarioLifecycle({
    execute: async () => {
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 980, height: 640 } });
      attachBrowserConsole(page, browserConsole);
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, {
        timeout: options.timeoutMs,
      });
      await waitText("TUI dev mode is running mock scenario");
      await chooseFromBareMenu("/jump");
      await capture("00-required-selected");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(100);
      check(
        "required-command-is-prefilled-not-executed",
        (await readComposerText(page)).trimEnd().endsWith("/jump"),
      );
      await capture("01-required-command");
      await typeHumanText(page, "latest");
      await waitForComposerText(page, "/jump latest", 3000);
      await page.waitForTimeout(120);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        () =>
          !window.tuiLab
            .visibleText()
            .split("\n")
            .findLast((line) => line.trimStart().startsWith("›"))
            ?.includes("/jump"),
        null,
        { timeout: 3000 },
      );
      check(
        "arguments-submit-normally",
        !(await readComposerText(page)).includes("/jump"),
      );

      await chooseFromBareMenu("/model");
      await page.keyboard.press("Enter");
      await waitText("Select Model");
      check(
        "no-argument-command-executes-from-bare-list",
        (await visible()).includes("Select Model"),
      );
      await capture("02-command-executed");
      await pressTerminalEscape(page, process.platform);
      await page.waitForFunction(
        () => !window.tuiLab.visibleText().includes("Select Model"),
      );
      for (const input of ["/", "/mod", "/skills"]) {
        await typeHumanText(page, input);
        await waitForComposerText(page, input, 3000);
        await page.waitForTimeout(150);
        await page.keyboard.press("Tab");
        const expected =
          input === "/" ? "/help" : input === "/mod" ? "/model" : "/skills";
        await waitForComposerText(page, expected, 3000);
        check(
          `tab-only-completes-${input}`,
          (await readComposerText(page)).trimEnd().endsWith(expected),
        );
        await clear();
      }
      await capture("03-menu-completion");
      await submitTerminalLine(
        page,
        "Verify output following at the tail and stable position during review",
      );
      await waitText("tui-lab-final-line-040");
      const start = await state();
      await page.waitForTimeout(700);
      const following = await state();
      check(
        "initial-tail-follows-new-output",
        tail(start) && tail(following) && following.last > start.last,
      );
      await capture("04-following");
      await wheel(-120);
      const review = await state();
      await page.waitForTimeout(1100);
      const reviewing = await state();
      check("up-wheel-pauses-following", !tail(review) && !tail(reviewing));
      check(
        "new-output-keeps-reviewed-content",
        Number.isInteger(review.first) &&
          review.first === reviewing.first &&
          reviewing.viewport.content_rows > review.viewport.content_rows,
      );
      await capture("05-reviewing");
      await reachTailByWheel();
      const resumed = await state();
      await page.waitForTimeout(700);
      const resumedLater = await state();
      check(
        "wheel-to-bottom-resumes-following",
        tail(resumedLater) && resumedLater.last > resumed.last,
      );

      await wheel(-240);
      const geometry = await page.evaluate(() => {
        const bar = window.tuiLab.internalScrollbar();
        const rect = document
          .querySelector(".xterm-screen")
          .getBoundingClientRect();
        const dims = window.tuiLab.dimensions();
        return {
          x: rect.x + ((bar.col + 0.5) * rect.width) / dims.cols,
          y:
            rect.y +
            ((bar.thumbRows[Math.floor(bar.thumbRows.length / 2)] + 0.5) *
              rect.height) /
              dims.rows,
          bottom:
            rect.y + ((bar.trackRows.at(-1) + 0.5) * rect.height) / dims.rows,
        };
      });
      await page.mouse.move(geometry.x, geometry.y);
      await page.mouse.down();
      await page.waitForTimeout(80);
      await page.mouse.move(geometry.x, geometry.bottom, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(180);
      const dragged = await state();
      await page.waitForTimeout(700);
      const draggedLater = await state();
      check(
        "drag-to-bottom-resumes-following",
        tail(draggedLater) && draggedLater.last > dragged.last,
      );
      await capture("06-dragged-to-bottom");
      await wheel(-120);
      const finalReview = await state();
      await page.waitForFunction(
        () => window.tuiLab.title().startsWith("[READY]"),
        null,
        { timeout: options.timeoutMs },
      );
      await page.waitForTimeout(200);
      const finished = await state();
      check(
        "completion-does-not-cancel-review",
        Number.isInteger(finalReview.first) &&
          !tail(finished) &&
          finished.first === finalReview.first,
      );
      await capture("07-completed-while-reviewing");
      await reachTailByWheel(1200);
      await waitText("tui-lab-final-sentinel");
      await capture("08-final-tail");
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
    onFailure: async (error, pageEvidence) => {
      await json(path.join(artifacts.dir, "state-samples.json"), samples);
      return writeFailureArtifact({
        artifacts,
        runOptions,
        command,
        mode: "tail-menu",
        session,
        page,
        browserConsole,
        trace,
        error,
        repoRoot: runtime.repoRoot,
        pageEvidence,
      });
    },
    onSuccess: async (text, cleanup) => {
      await verifyRunContextIntegrity(artifacts, runtime.runContextRuntime());
      await Promise.all([
        writeFile(artifacts.text, text),
        writeFile(artifacts.ptyLog, session.getPtyLog()),
        writeFile(
          artifacts.browserConsoleLog,
          formatBrowserConsole(browserConsole),
        ),
        json(artifacts.assertions, assertions()),
        json(path.join(artifacts.dir, "state-samples.json"), samples),
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
