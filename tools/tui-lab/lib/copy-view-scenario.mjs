import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
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
import { submitTerminalLine, typeHumanText } from "./terminal-interaction.mjs";

const json = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });

export async function runCopyViewScenario(options, runtime) {
  const artifacts = await createRunContext(
    options,
    "copy-view",
    runtime.runContextRuntime(),
  );
  const runOptions = {
    ...options,
    tuiLabMode: "copy-view",
    scenario: "full-turn",
    streamDelayMs: 200,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    configHome: artifacts.configHome,
    requestsDir: artifacts.requestsDir,
  };
  if (options.copyInline)
    runOptions.commandOverride = `${defaultCommandString(runOptions)} --no-alt-screen`;
  const command = defaultCommandString(runOptions);
  const code =
    'COPY_CODE_FIRST = "中文🙂é"\n' +
    `long_value = "${"abcdefgh".repeat(45)}"\n` +
    Array.from(
      { length: 100 },
      (_, i) => `    # COPY_LINE_${String(i).padStart(3, "0")} 中文内容`,
    ).join("\n") +
    '\n\tprint("COPY_CODE_LAST")\n';
  const answer = `# COPY_ANSWER_ROOT\n\n这是固定的 **Markdown** 回答。\n\n\`\`\`python\n${code}\`\`\`\n\nCOPY_ANSWER_TAIL`;
  const history = path.join(artifacts.dir, "copy-fixture.jsonl");
  const state = path.join(artifacts.dir, "copy-fixture");
  await mkdir(state, { mode: 0o700 });
  await json(path.join(state, "state.json"), {
    cwd: artifacts.workspace,
    base_cwd: artifacts.workspace,
  });
  await writeFile(
    history,
    [
      ["user", "测试复制历史回答"],
      ["assistant", answer],
    ]
      .map(([role, text], index) =>
        JSON.stringify({
          session_id: "copy-fixture",
          timestamp_ms: 1780000000000 + index,
          uuid: `copy-${index}`,
          parentUuid: index ? "copy-0" : null,
          role,
          content: [{ type: "text", text }],
        }),
      )
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  const trace = [],
    browserConsole = [],
    checks = [];
  let browser, session, page;
  const assertions = () => ({ ok: checks.every((check) => check.ok), checks });
  const check = (name, ok) => {
    checks.push({ name, ok: Boolean(ok) });
    if (!ok)
      throw Object.assign(new Error(`copy-view: ${name}`), {
        assertions: assertions(),
      });
  };
  const visible = () => page.evaluate(() => window.tuiLab.visibleText());
  const waitText = (needle) =>
    page.waitForFunction(
      (needle) => window.tuiLab?.visibleText().includes(needle),
      needle,
      { timeout: options.timeoutMs },
    );
  const capture = async (name) => {
    await captureStep(
      page,
      trace,
      name,
      path.join(artifacts.dir, `${name}.png`),
    );
    await writeFile(path.join(artifacts.dir, `${name}.txt`), await visible());
  };
  const point = (column, row) =>
    page.evaluate(
      ({ column, row }) => {
        const rect = document
          .querySelector(".xterm-screen")
          .getBoundingClientRect();
        const dims = window.tuiLab.dimensions();
        return {
          x: rect.x + ((column + 0.5) * rect.width) / dims.cols,
          y: rect.y + ((row + 0.5) * rect.height) / dims.rows,
        };
      },
      { column, row },
    );
  const click = async (needle) => {
    const hit = await page.evaluate(
      (needle) => window.tuiLab.textHitCells(needle)[0],
      needle,
    );
    if (!hit) throw new Error(`missing clickable text: ${needle}`);
    const position = await point(hit.column, hit.row);
    await page.mouse.click(position.x, position.y);
    await page.waitForTimeout(120);
  };
  const copy = async (action = () => page.keyboard.press("Control+C")) => {
    const count = await page.evaluate(
      () => window.tuiLab.clipboardCopies().length,
    );
    await action();
    await page.waitForFunction(
      (count) => window.tuiLab.clipboardCopies().length > count,
      count,
      { timeout: 10_000 },
    );
    return page.evaluate(() => navigator.clipboard.readText());
  };
  await runtime.writeStartMeta(artifacts, runOptions, command, "copy-view");
  return runBrowserScenarioLifecycle({
    execute: async () => {
      session = await runtime.startSession(runOptions);
      browser = await chromium.launch(browserLaunchOptions(options));
      page = await browser.newPage({
        permissions: ["clipboard-read", "clipboard-write"],
        viewport: { width: 1000, height: 740 },
      });
      attachBrowserConsole(page, browserConsole);
      await page.goto(session.url);
      await page.waitForFunction(() => window.tuiLab?.ready, null, {
        timeout: options.timeoutMs,
      });
      await waitText("TUI dev mode is running mock scenario");
      await submitTerminalLine(page, `/resume ${history}`);
      await waitText("COPY_ANSWER_TAIL");
      await typeHumanText(page, "copy-draft-preserved");
      // Inline mode preserves native host-terminal selection and captures the mouse only after entering copy view.
      if (options.copyInline) await page.keyboard.press("F9");
      else await click("F9 copy");
      await waitText("Copy view");
      check(
        options.copyInline
          ? "f9-opens-inline-copy-view"
          : "footer-click-opens-copy-view",
        (await visible()).includes("fixed snapshot"),
      );
      check(
        "whole-answer-clipboard-is-original-markdown",
        (await copy()) === answer,
      );
      await click("Code 1");
      await waitText("COPY_CODE_FIRST");
      check(
        "click-copy-code-preserves-original-indent-and-newlines",
        (await copy(() => click("Copy text"))) === code,
      );
      await capture("01-code-source");
      const hit = await page.evaluate(
        () => window.tuiLab.textHitCells("COPY_CODE_FIRST")[0],
      );
      const first = await point(hit.column, hit.row);
      const dims = await page.evaluate(() => window.tuiLab.dimensions());
      const edge = await point(dims.cols - 3, dims.rows - 4);
      await page.mouse.move(first.x, first.y);
      await page.mouse.down();
      await page.mouse.move(edge.x, edge.y, { steps: 12 });
      await page.waitForTimeout(1600);
      await page.mouse.up();
      const selected = await copy();
      check(
        "edge-drag-copies-beyond-initial-screen",
        selected.includes("COPY_LINE_040"),
      );
      check(
        "selection-is-exact-source-prefix-without-soft-wraps",
        code.startsWith(selected),
      );
      await capture("02-cross-screen-selection");
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(250);
      check(
        "wheel-after-selection-does-not-change-copied-text",
        (await copy()) === selected,
      );
      await page.setViewportSize({ width: 820, height: 650 });
      await page.waitForTimeout(350);
      check(
        "resize-does-not-change-source-selection",
        (await copy()) === selected,
      );
      await capture("03-resized-selection");
      await page.keyboard.press("Control+A");
      check(
        "ctrl-a-copies-entire-code-not-current-screen",
        (await copy()) === code,
      );
      await page.keyboard.press("Escape");
      await waitText("copy-draft-preserved");
      check(
        "close-restores-composer-draft",
        (await visible()).includes("copy-draft-preserved"),
      );
      await page.keyboard.press("Control+U");
      await submitTerminalLine(page, "Run the complete streaming scenario");
      await waitText("tui-lab-final-line-001");
      check(
        "opened-during-live-output",
        !(await visible()).includes("tui-lab-final-sentinel"),
      );
      await page.keyboard.press("F9");
      await waitText("Copy view");
      await click("Answer 1");
      check("history-still-copyable-during-stream", (await copy()) === answer);
      await page.waitForTimeout(1400);
      check(
        "new-output-cannot-change-copy-snapshot",
        (await copy()) === answer,
      );
      await capture("04-copy-during-stream");
      await page.keyboard.press("Escape");
      await waitText("tui-lab-final-sentinel");
      check(
        "copy-ctrl-c-does-not-cancel-main-task",
        (await visible()).includes("tui-lab-final-sentinel"),
      );
      await capture("05-task-finished");
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
        mode: "copy-view",
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
        writeFile(artifacts.text, text),
        writeFile(artifacts.ptyLog, session.getPtyLog()),
        writeFile(
          artifacts.browserConsoleLog,
          formatBrowserConsole(browserConsole),
        ),
        json(artifacts.assertions, assertions()),
        json(artifacts.meta, {
          ok: true,
          command,
          trace,
          cleanup,
          clipboardBackend: "OSC 52 -> xterm parser -> browser clipboard",
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
