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
  const agentColumns = options.scenario === "subagent-trace"
    && options.message.includes("tui-lab-targeted-subagent-");
  const resizeSequence = agentColumns
    ? [{ width: 980, height: 800 }, { width: 1380, height: 800 }, { width: 640, height: 900 }, { width: 980, height: 800 }]
    : VISUAL_RESIZE_SEQUENCE;
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
      agentColumns ? "Agent Swarm" : "tui-lab-final-sentinel",
      options.timeoutMs,
    );
    if (agentColumns) {
      await waitForTerminalText(page, "002", options.timeoutMs);
    }
    await page.waitForTimeout(250);
    await page.evaluate(() => window.tuiLab.scrollToBottom());
    await page.waitForTimeout(250);

    const resizeCaptures = [];
    const resizeChecks = [];
    const summaryOffsetsByCols = new Map();
    for (const [index, size] of resizeSequence.entries()) {
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
      let memberCells;
      let summaryCells;
      if (agentColumns) {
        memberCells = await page.evaluate(() => ["001", "002"].map(id => ({
          id,
          hits: window.tuiLab.textHitCells(id).filter(hit => /^\s*00[12]\s/.test(hit.text)),
        })));
        const [first, second] = memberCells.map(member => member.hits[0]);
        const visible = memberCells.every(member => member.hits.length === 1);
        const aligned = visible && (dimensions.cols >= 74
          ? first.row === second.row && Math.abs(second.column - first.column - dimensions.cols / 2) <= 2
          : first.row !== second.row && first.column === second.column);
        resizeChecks.push({ ok: aligned, failed: aligned ? [] : [`subagent column geometry at resize ${index + 1}`], memberCells });
        summaryCells = await page.evaluate((members) => {
          const candidates = ["tui", "Sub"].flatMap(needle => window.tuiLab.textHitCells(needle));
          return members.map((member, index) => {
            const start = member.hits[0];
            const end = members[index + 1]?.hits[0];
            const hits = start ? candidates.filter(hit => hit.row === start.row
              && hit.column > start.column
              && (!end || end.row !== start.row || hit.column < end.column)) : [];
            return { id: member.id, hits, offset: hits.length === 1 ? hits[0].column - start.column : null };
          });
        }, memberCells);
        const offsets = summaryCells.map(member => member.offset);
        const previousOffsets = summaryOffsetsByCols.get(dimensions.cols);
        const summariesAligned = offsets.every(offset => offset !== null && offset === offsets[0])
          && (!previousOffsets || offsets.every((offset, i) => offset === previousOffsets[i]));
        summaryOffsetsByCols.set(dimensions.cols, offsets);
        resizeChecks.push({ ok: summariesAligned, failed: summariesAligned ? [] : [`subagent summary field geometry at resize ${index + 1}`], summaryCells });
      }
      resizeCaptures.push({
        step: index + 1,
        ...size,
        screenshot,
        dimensions,
        check,
        memberCells,
        summaryCells,
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
      resizeSequence,
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
