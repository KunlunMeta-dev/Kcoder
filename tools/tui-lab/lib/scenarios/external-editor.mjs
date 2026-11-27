import { readFile, mkdir } from "node:fs/promises";
import { sleep } from "../timing.mjs";
import { createRunContext } from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import path from "node:path";
import {
  writeTextArtifact,
  writeStartMeta,
  writeJsonArtifact,
  writeFailureArtifacts,
} from "../runtime-artifacts.mjs";
import process from "node:process";
import {
  defaultCommandString,
  browserLaunchOptions,
} from "../runner-options.mjs";
import { startSession } from "../session.mjs";
import { chromium } from "@playwright/test";
import {
  attachBrowserConsole,
  captureStep,
  formatBrowserConsole,
} from "../browser-evidence.mjs";
import {
  waitForTerminalText,
  focusTerminal,
  typeHumanText,
} from "../terminal-interaction.mjs";
import { waitForStableRequestCount } from "../session-memory-evidence.mjs";

export function quoteExternalEditorArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

export async function waitForJsonValue(file, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (predicate(value)) return value;
    } catch {
      // The fixture may not have created the file yet, or it may be between writes.
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for external editor JSON state: ${file}`);
}

export async function runExternalEditorScenario(options) {
  const artifacts = await createRunContext(
    options,
    "external-editor",
    runContextRuntime(),
  );
  const fixtureDir = path.join(artifacts.dir, "editor fixture");
  const editorScript = path.join(fixtureDir, "editor fixture.mjs");
  const editorMarker = path.join(fixtureDir, "editor-marker.json");
  const editorContent =
    "tui-lab-external-editor-sentinel\n第二行 Windows/Linux editor";
  await mkdir(fixtureDir, { recursive: true });
  await writeTextArtifact(
    editorScript,
    [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "const target = process.argv.at(-1);",
      `const content = ${JSON.stringify(editorContent)};`,
      "const markerPath = process.env.KCODER_TUI_LAB_EDITOR_MARKER;",
      "let previous = { target, content, invocations: [] };",
      "try { previous = JSON.parse(await readFile(markerPath, 'utf8')); } catch {}",
      "const seed = await readFile(target, 'utf8');",
      "const invocation = { attempt: previous.invocations.length + 1, target, seed };",
      "const invocations = [...previous.invocations, invocation];",
      "if (invocation.attempt === 1) {",
      "  invocation.outcome = 'success';",
      "  await writeFile(target, content, 'utf8');",
      "} else {",
      "  invocation.outcome = 'failure';",
      "  invocation.exitCode = 37;",
      "  process.exitCode = 37;",
      "}",
      "await writeFile(markerPath, JSON.stringify({ target, content, invocations }), 'utf8');",
      "",
    ].join("\n"),
  );
  const externalEditorCommand = `${quoteExternalEditorArg(process.execPath)} ${quoteExternalEditorArg(editorScript)}`;
  const runOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
    externalEditorCommand,
    externalEditorMarker: editorMarker,
  };
  const command = defaultCommandString(runOptions);
  const trace = [];
  const browserConsole = [];
  const screenshots = {
    beforeEditor: path.join(artifacts.dir, "before-editor.png"),
    afterEditor: path.join(artifacts.dir, "after-editor.png"),
    afterResume: path.join(artifacts.dir, "after-resume.png"),
    afterFailure: path.join(artifacts.dir, "after-editor-failure.png"),
    afterFailureResume: path.join(
      artifacts.dir,
      "after-editor-failure-resume.png",
    ),
  };
  let session;
  let browser;
  let page;
  await writeStartMeta(artifacts, runOptions, command, "external-editor");
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
    await focusTerminal(page);
    await typeHumanText(page, "draft-before-external-editor");
    await captureStep(page, trace, "before-editor", screenshots.beforeEditor);
    const inputEventStart = await page.evaluate(
      () => window.tuiLab.inputEvents().length,
    );
    await page.keyboard.press("Control+G");
    const successMarker = await waitForJsonValue(
      editorMarker,
      (value) => value?.invocations?.length >= 1,
      options.timeoutMs,
    );
    await waitForTerminalText(
      page,
      "tui-lab-external-editor-sentinel",
      options.timeoutMs,
    );
    await page.waitForTimeout(250);
    await captureStep(page, trace, "after-editor", screenshots.afterEditor);
    await typeHumanText(page, "-after-resume");
    await waitForTerminalText(page, "-after-resume", options.timeoutMs);
    await captureStep(page, trace, "after-resume", screenshots.afterResume);

    const requestCountBeforeFailure = await waitForStableRequestCount(
      artifacts.requestsDir,
    );
    await page.keyboard.press("Control+G");
    const marker = await waitForJsonValue(
      editorMarker,
      (value) => value?.invocations?.length >= 2,
      options.timeoutMs,
    );
    await waitForTerminalText(
      page,
      "Failed to open editor:",
      options.timeoutMs,
    );
    await captureStep(
      page,
      trace,
      "after-editor-failure",
      screenshots.afterFailure,
    );
    await typeHumanText(page, "-after-editor-failure");
    await waitForTerminalText(page, "-after-editor-failure", options.timeoutMs);
    await captureStep(
      page,
      trace,
      "after-editor-failure-resume",
      screenshots.afterFailureResume,
    );
    const requestCountAfterFailure = await waitForStableRequestCount(
      artifacts.requestsDir,
    );

    const text = await page.evaluate(() => window.tuiLab.text());
    const inputEvents = await page.evaluate(
      (start) => window.tuiLab.inputEvents().slice(start),
      inputEventStart,
    );
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const checks = {
      markerTargetIsMarkdown:
        typeof marker.target === "string" && marker.target.endsWith(".md"),
      markerHasSentinel: marker.content === editorContent,
      successEditorReceivedOriginalDraft:
        successMarker.invocations?.[0]?.seed === "draft-before-external-editor",
      composerHasSentinel: text.includes("tui-lab-external-editor-sentinel"),
      composerAcceptedMoreInput: text.includes("-after-resume"),
      originalDraftWasReplaced: !text.includes("draft-before-external-editor"),
      failedEditorReceivedCurrentUnicodeDraft:
        marker.invocations?.[1]?.seed === `${editorContent}-after-resume`,
      failedEditorExitedNonZero:
        marker.invocations?.[1]?.outcome === "failure" &&
        marker.invocations?.[1]?.exitCode === 37,
      failedEditorReportedError: text.includes("Failed to open editor:"),
      failedEditorPreservedDraft:
        text.includes("tui-lab-external-editor-sentinel") &&
        text.includes("-after-resume"),
      composerAcceptedInputAfterEditorFailure: text.includes(
        "-after-editor-failure",
      ),
      failedEditorDidNotTriggerModelRequest:
        requestCountAfterFailure === requestCountBeforeFailure,
      controlGReachedPty: inputEvents.some((value) => value.includes("\u0007")),
      tuiStillRunning: session.getExitInfo() === null,
      noAnsiInScreenText: !text.includes("\u001b["),
    };
    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    const assertions = { ok: failed.length === 0, failed, checks };
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `TUI external-editor assertions failed: ${failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "external-editor",
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
      editorScript,
      editorMarker,
      marker,
      successMarker,
      requestCountBeforeFailure,
      requestCountAfterFailure,
      screenshots,
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      hasScrollbar,
      dimensions,
      trace,
      inputEvents: inputEvents.map((value) =>
        Buffer.from(value).toString("hex"),
      ),
      ptyExit: session.getExitInfo(),
      ptyDiagnostics: session.getDiagnostics(),
    });
    console.log(
      JSON.stringify(
        { ok: true, mode: "external-editor", ...artifacts, assertions },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFailureArtifacts({
      artifacts,
      runOptions,
      command,
      mode: "external-editor",
      session,
      page,
      browserConsole,
      trace,
      error,
    });
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (session) await session.stop().catch(() => {});
  }
}
