import { chromium } from "@playwright/test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
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
  pressTerminalEscape,
  submitTerminalLine,
  typeHumanText,
} from "./terminal-interaction.mjs";
import {
  countPaletteQueries,
  makeOutlineHistoryFixture,
  OUTLINE_MARKERS as m,
  verifyOutlineTargetVisible,
} from "./outline-navigation-fixture.mjs";
import { runOutlineStreamingProbe } from "./outline-navigation-streaming.mjs";

const json = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });

export async function runOutlineNavigationScenario(options, runtime) {
  const artifacts = await createRunContext(
    options,
    "outline-navigation",
    runtime.runContextRuntime(),
  );
  const runOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    configHome: artifacts.configHome,
    requestsDir: artifacts.requestsDir,
    streamDelayMs: options.outlineStreaming
      ? options.streamDelayMs || 400
      : options.streamDelayMs,
  };
  if (options.outlineInline) {
    runOptions.commandOverride = `${defaultCommandString(runOptions)} --no-alt-screen`;
  }
  const command = defaultCommandString(runOptions);
  const fixture = makeOutlineHistoryFixture();
  const history = path.join(artifacts.dir, "outline-navigation-fixture.jsonl");
  await mkdir(artifacts.requestsDir, { mode: 0o700 });
  await writeFile(history, fixture.jsonl, { mode: 0o600, flag: "wx" });
  // A real session resume must declare its original workspace and cannot bypass the cross-project recovery gate.
  const fixtureState = path.join(artifacts.dir, "outline-navigation-fixture");
  await mkdir(fixtureState, { mode: 0o700 });
  await json(path.join(fixtureState, "state.json"), {
    cwd: artifacts.workspace,
    base_cwd: artifacts.workspace,
  });
  const trace = [];
  const browserConsole = [];
  const checks = [];
  const interactions = [];
  let browser;
  let session;
  let page;
  const assertions = () => ({
    ok: checks.every((check) => check.ok),
    failed: checks.filter((check) => !check.ok).map((check) => check.name),
    checks,
  });
  const check = (name, ok, detail = {}) => {
    checks.push({ name, ok: Boolean(ok), ...detail });
    if (!ok)
      throw Object.assign(
        new Error(`outline-navigation assertion failed: ${name}`),
        { assertions: assertions() },
      );
  };
  const visible = () => page.evaluate(() => window.tuiLab.visibleText());
  const waitVisible = (text, present = true) =>
    page.waitForFunction(
      ({ text, present }) =>
        Boolean(window.tuiLab) &&
        window.tuiLab.visibleText().includes(text) === present,
      { text, present },
      { timeout: Math.min(options.timeoutMs, 30_000) },
    );
  const capture = async (name) => {
    await captureStep(
      page,
      trace,
      name,
      path.join(artifacts.dir, `${name}.png`),
    );
    const text = await visible();
    await writeFile(path.join(artifacts.dir, `${name}.txt`), text, {
      mode: 0o644,
    });
    return text;
  };
  const waitTarget = async (stage) => {
    const samples = [];
    const deadline = Date.now() + Math.min(options.timeoutMs, 30_000);
    let stableSince = null;
    while (Date.now() < deadline) {
      const text = await visible();
      const valid = verifyOutlineTargetVisible(text);
      samples.push({
        at: Date.now(),
        targetVisible: valid,
        locating: text.includes("Locating…"),
      });
      if (valid) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= 300) {
          await json(
            path.join(artifacts.dir, `${stage}-stability.json`),
            samples,
          );
          return;
        }
      } else {
        stableSince = null;
      }
      await page.waitForTimeout(50);
    }
    await json(path.join(artifacts.dir, `${stage}-stability.json`), samples);
    check(`${stage}-source-remains-stably-visible`, false);
  };
  await runtime.writeStartMeta(
    artifacts,
    runOptions,
    command,
    "outline-navigation",
  );
  return runBrowserScenarioLifecycle({
    execute: async () => {
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({ viewport: { width: 1050, height: 740 } });
      attachBrowserConsole(page, browserConsole);
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, {
        timeout: options.timeoutMs,
      });
      await waitVisible("TUI dev mode is running mock scenario");
      await capture("01-welcome");
      const startupPaletteQueries = countPaletteQueries(session.getPtyLog());
      check(
        "startup-osc10-query-not-duplicated",
        startupPaletteQueries.foreground <= 1,
        startupPaletteQueries,
      );
      check(
        "startup-osc11-query-not-duplicated",
        startupPaletteQueries.background <= 1,
        startupPaletteQueries,
      );
      await submitTerminalLine(page, `/resume ${history}`);
      await waitVisible("Resumed session from");
      await capture("02-resumed-tail");

      const underlay = await page.evaluate(
        (needle) => ({
          cells: window.tuiLab.underlinedCells(),
          linksUnderlined: window.tuiLab
            .textStyleCells(needle)
            .some((hit) => hit.cells.some((cell) => cell.underline)),
        }),
        m.underlayLink,
      );
      check(
        "underlying-markdown-links-are-underlined",
        underlay.linksUnderlined,
      );

      await submitTerminalLine(page, "/outline");
      await waitVisible("Conversation outline ·");
      check(
        "outline-command-opens-local-directory",
        (await visible()).includes("Search:"),
      );
      await capture("03-outline-command");
      const overlay = await page.evaluate(() => {
        const top = window.tuiLab
          .textHitCells("┌")
          .find((hit) => hit.text.includes("Conversation outline"));
        const bottom =
          top &&
          window.tuiLab
            .textHitCells("└")
            .find((hit) => hit.column === top.column && hit.row > top.row);
        const right =
          top &&
          window.tuiLab
            .textHitCells("┐")
            .find((hit) => hit.row === top.row && hit.column > top.column);
        return {
          bounds:
            top && bottom && right
              ? {
                  left: top.column,
                  top: top.row,
                  right: right.column,
                  bottom: bottom.row,
                }
              : null,
          cells: window.tuiLab.underlinedCells(),
        };
      });
      await json(path.join(artifacts.dir, "outline-style-isolation.json"), {
        underlay,
        overlay,
      });
      check("outline-style-check-has-visible-bounds", Boolean(overlay.bounds));
      const inside = (cell) =>
        cell.column >= overlay.bounds.left &&
        cell.column <= overlay.bounds.right &&
        cell.row >= overlay.bounds.top &&
        cell.row <= overlay.bounds.bottom;
      check(
        "outline-covers-underlined-source-cells",
        underlay.cells.some(inside),
      );
      check(
        "outline-text-and-spaces-have-no-inherited-underline",
        !overlay.cells.some(inside),
      );
      await pressTerminalEscape(page, process.platform);
      await waitVisible("Conversation outline ·", false);
      check(
        "closing-outline-restores-markdown-underlines",
        await page.evaluate(
          (needle) =>
            window.tuiLab
              .textStyleCells(needle)
              .some((hit) => hit.cells.some((cell) => cell.underline)),
          m.underlayLink,
        ),
      );
      await typeHumanText(page, m.draft);
      await page.keyboard.press("F8");
      await waitVisible("Conversation outline ·");
      await page.keyboard.press("F8");
      await waitVisible("Conversation outline ·", false);
      await waitVisible(m.draft);
      check(
        "f8-preserves-unsubmitted-draft",
        (await visible()).includes(m.draft),
      );
      await capture("04-draft-preserved");
      await page.keyboard.press("Control+U");
      await waitVisible(m.draft, false);

      await submitTerminalLine(page, `/outline ${m.taskAlpha}`);
      await waitVisible("Conversation outline ·");
      await page.waitForFunction(
        (needle) =>
          window.tuiLab
            .textHitCells(needle)
            .some((hit) => !hit.text.includes("Search:")),
        m.taskAlpha,
        { timeout: 30_000 },
      );
      check(
        "task-search-finds-visible-task",
        (await visible()).includes(m.taskAlpha),
      );
      await capture("05-task-search");
      await pressTerminalEscape(page, process.platform);
      await waitVisible("Conversation outline ·", false);
      await submitTerminalLine(page, `/outline ${m.duplicateTitle}`);
      await waitVisible("Conversation outline ·");
      await page.waitForFunction(
        (needle) =>
          window.tuiLab
            .textHitCells(needle)
            .filter((hit) => !hit.text.includes("Search:")).length >= 2,
        m.duplicateTitle,
        { timeout: 30_000 },
      );
      await capture("06-duplicate-heading-search");

      const hit = await page.evaluate((needle) => {
        const hits = window.tuiLab
          .textHitCells(needle)
          .filter((hit) => !hit.text.includes("Search:"));
        const target = hits[1];
        const rect = document
          .querySelector(".xterm-screen")
          .getBoundingClientRect();
        const { cols, rows } = window.tuiLab.dimensions();
        return {
          ...target,
          x: rect.x + ((target.column + 0.5) * rect.width) / cols,
          y: rect.y + ((target.row + 0.5) * rect.height) / rows,
          inputStart: window.tuiLab.inputEvents().length,
          occurrence: 2,
        };
      }, m.duplicateTitle);
      interactions.push({
        kind: "mouse-heading",
        ...hit,
        expectedSourceByte: fixture.targetSourceByte,
      });
      await json(path.join(artifacts.dir, "interactions.json"), interactions);
      const viewport = page.viewportSize();
      check(
        "mouse-target-inside-current-browser-viewport",
        hit.x >= 0 &&
          hit.y >= 0 &&
          hit.x < viewport.width &&
          hit.y < viewport.height,
        { hit, viewport },
      );
      await page.mouse.move(hit.x, hit.y);
      await page.mouse.down({ button: "left" });
      await page.waitForTimeout(80);
      await page.mouse.up({ button: "left" });
      await page.waitForTimeout(150);
      const mouseEvents = await page.evaluate(
        (start) => window.tuiLab.inputEvents().slice(start),
        hit.inputStart,
      );
      await json(path.join(artifacts.dir, "mouse-events.json"), mouseEvents);
      check(
        "real-left-mouse-down-up-reached-pty",
        mouseEvents.some((value) => /\x1b\[<0;\d+;\d+M/.test(value)) &&
          mouseEvents.some((value) => /\x1b\[<0;\d+;\d+m/.test(value)),
      );
      await waitTarget("07-target");
      const targeted = await capture("07-second-duplicate-target");
      check(
        "second-duplicate-source-is-actually-visible",
        verifyOutlineTargetVisible(targeted),
      );
      if (options.outlineInline)
        check(
          "inline-jump-opens-managed-history-layer",
          targeted.includes("History ·"),
        );

      await page.setViewportSize({ width: 1180, height: 810 });
      await waitTarget("08-resized-target");
      await page.waitForTimeout(350);
      check(
        "resize-keeps-target-source-visible",
        verifyOutlineTargetVisible(await capture("08-target-after-resize")),
      );
      if (options.outlineInline) {
        await pressTerminalEscape(page, process.platform);
        await waitVisible("History ·", false);
      }
      await submitTerminalLine(page, "/jump latest");
      await waitVisible(m.latest);
      check(
        "jump-latest-restores-loaded-tail",
        (await visible()).includes(m.latest),
      );
      check(
        "navigation-did-not-request-a-model",
        (await readdir(artifacts.requestsDir)).filter((name) =>
          name.endsWith(".json"),
        ).length === 0,
      );
      await capture("09-jump-latest");
      if (options.outlineStreaming) {
        await runOutlineStreamingProbe({
          page,
          history,
          requestsDir: artifacts.requestsDir,
          capture,
          check,
          waitVisible,
          waitTarget,
          inline: options.outlineInline,
          timeoutMs: options.timeoutMs,
        });
      }
      const text = await visible();
      const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
      const paletteQueries = countPaletteQueries(session.getPtyLog());
      check(
        "session-osc10-query-not-duplicated",
        paletteQueries.foreground <= 1,
        paletteQueries,
      );
      check(
        "session-osc11-query-not-duplicated",
        paletteQueries.background <= 1,
        paletteQueries,
      );
      return { text, dimensions, paletteQueries };
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
        mode: "outline-navigation",
        session,
        page,
        browserConsole,
        trace,
        error,
        repoRoot: runtime.repoRoot,
        pageEvidence,
      }),
    onSuccess: async ({ text, dimensions, paletteQueries }, cleanup) => {
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
      ]);
      const meta = {
        ok: true,
        mode: "outline-navigation",
        inline: options.outlineInline,
        streaming: options.outlineStreaming,
        command,
        runDir: artifacts.dir,
        history,
        expectedSourceByte: fixture.targetSourceByte,
        expectedSourceLine: fixture.targetSourceLine,
        dimensions,
        interactions,
        trace,
        cleanup,
        paletteQueries,
        browserLaunch: browserLaunchOptions(options),
        assertions: artifacts.assertions,
        ptyExit: session.getExitInfo(),
        ptyDiagnostics: session.getDiagnostics(),
      };
      await json(artifacts.meta, meta);
      console.log(
        JSON.stringify(
          {
            ok: true,
            runDir: artifacts.dir,
            inline: options.outlineInline,
            assertions: assertions(),
          },
          null,
          2,
        ),
      );
      return meta;
    },
  });
}
