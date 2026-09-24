#!/usr/bin/env node
import { runResponseBudgetScenario } from '../lib/response-budget-scenario.mjs';

import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import { WebSocketServer } from "ws";
import {
  createImagePasteFixture,
  imagePasteKeyForPlatform,
} from "../lib/image-paste-fixture.mjs";
import {
  assertModeSupported,
  configEnvironment,
  delayedSpawn,
  interactionBudgetsForPlatform,
  platformDescription,
  platformShell,
  requestGracefulPtyStop,
  settleWithin,
  terminalPreambleForPlatform,
  terminateProcessWithoutConsoleAttach,
} from "../lib/platform-adapter.mjs";
import {
  browserLaunchOptions,
  defaultCommandString,
  parseArgs,
  ptyCommand,
  shellQuote,
} from "../lib/runner-options.mjs";
import {
  createRunContext,
  verifyRunContextIntegrity,
} from "../lib/run-context.mjs";
import {
  collectRecordingTimelineSamples,
  compressVideo,
  extractVideoFrames,
  moveRecordedVideo,
  probeVideo,
  remainingDeadlineMs,
  validateRecordingSuccess,
  withinAbsoluteDeadline,
} from "../lib/recording-artifacts.mjs";
import { renderTerminalPage } from "../lib/terminal-page.mjs";
import { runOutlineNavigationScenario } from "../lib/outline-navigation-scenario.mjs";
import { runMarkdownRenderingScenario } from "../lib/markdown-rendering-scenario.mjs";
import { runCopyViewScenario } from "../lib/copy-view-scenario.mjs";
import { runModelRefreshScenario } from "../lib/model-refresh-scenario.mjs";
import { runTailMenuScenario } from "../lib/tail-menu-scenario.mjs";
import {
  focusTerminal,
  pressTerminalEscape,
  readComposerText,
  readShellComposerText,
  submitTerminalLine,
  tryWaitForTerminalText,
  tryWaitForTerminalTextMissing,
  typeHumanText,
  waitForComposerText,
  waitForShellComposerText,
  waitForTerminalText,
  waitForTerminalTextCount,
  waitForTerminalTextMissing,
  waitForTerminalTextPattern,
  waitForTerminalTextState,
} from "../lib/terminal-interaction.mjs";
import {
  collectHistoryEvidence,
  collectLiveSteerRequestEvidence,
  collectRequestEvidence,
  waitForHistoryEvidence,
  waitForOrchestrateControlEvidence,
  waitForRequestEvidence,
  waitForSubagentEvidence,
  waitForTargetedSubagentStopEvidence,
  waitForTargetedSubagentSteerEvidence,
} from "../lib/evidence.mjs";
import {
  attachBrowserConsole,
  captureStep,
  capturedArtifactPath,
  formatBrowserConsole,
} from "../lib/browser-evidence.mjs";
import {
  runBrowserScenarioLifecycle,
  settleLifecycleStep,
  validateBrowserCleanup,
} from "../lib/browser-lifecycle.mjs";
import {
  captureFailurePageEvidence,
  writeFailureArtifact,
} from "../lib/failure-artifact.mjs";
import {
  extractTuiSessionId,
  makeSessionMemoryCompactRecentPayload,
  writeSessionMemoryCompactSettings,
  waitForProjectDirForSession,
  waitForStableRequestCount,
  waitForRequestCountAtLeast,
  secureWindowsUserOnlyAcl,
  collectSessionMemoryCompactStateEvidence,
  collectSessionMemoryCompactRequestEvidence,
  runSessionMemoryCompactAssertions,
} from "../lib/session-memory-evidence.mjs";
import {
  maxConsecutiveBlankLines,
  normalizeShellComposerText,
  runAssertions,
} from "../lib/assertions.mjs";
import {
  pressRepeated,
  firstVisibleHistoryMarker,
  textHasMixedToolsSummary,
  textContainsAcrossWrap,
  textHasEarlyToolHistory,
  waitForTextMatch,
  measureTranscriptScrollbarDrag,
  textSignature,
  measureWheelFromTailSamples,
  measureNormalWheelToBounds,
  measureScrollbarThumbStabilityDuringDrag,
  measureStreamingScrollbarDragDuringOutput,
  measureReleasedMouseMoveStability,
  measureHeldScrollbarDragSamples,
  measureReleasedMouseMoveDetailed,
  measureRapidPageScroll,
  measureFullScrollCycles,
  measureWheelScrollCycles,
  measureSustainedWheelScroll,
} from "../lib/scroll-metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(toolRoot, "..", "..");
const targetRoot = path.join(repoRoot, "target", "tui-lab");
const defaultWorkspaceTemplate = path.join(toolRoot, "workspace-template");
const writeFailureArtifacts = (options) =>
  writeFailureArtifact({ ...options, repoRoot });
const nodeModulesBin = path.join(toolRoot, "node_modules", ".bin");
function runContextRuntime() {
  const userHome = os.homedir();
  return {
    now: new Date(),
    pid: process.pid,
    platform: process.platform,
    cwd: process.cwd(),
    targetRoot,
    configRoot:
      process.env.KCODER_TUI_LAB_CONFIG_ROOT ||
      path.join(userHome, ".kcoder-tui-lab"),
    configTrustRoot: process.env.KCODER_TUI_LAB_CONFIG_TRUST_ROOT || userHome,
    windowsVmVerified: process.env.KCODER_TUI_LAB_WINDOWS_VM_VERIFIED === "1",
    repoRoot,
    spawnSync,
  };
}

const TMUX_RESIZE_SEQUENCE = [
  { cols: 100, rows: 24 },
  { cols: 100, rows: 38 },
  { cols: 100, rows: 18 },
  { cols: 100, rows: 32 },
];
const VISUAL_RESIZE_SEQUENCE = [
  { width: 980, height: 560 },
  { width: 980, height: 760 },
  { width: 980, height: 420 },
  { width: 980, height: 650 },
];

const usage = `Usage:
  npm run open -- [--scenario full-turn] [--cols 100] [--rows 32]
  npm run run -- [--scenario full-turn] [--message TEXT] [--out target/tui-lab]
  npm run inline -- [--scenario full-turn] [--message TEXT] [--out target/tui-lab]
  npm run two-turn -- [--scenario full-turn] [--message TEXT] [--second-message TEXT]
  npm run slash-overlay -- [--scenario full-turn] [--out target/tui-lab]
  npm run external-editor -- [--scenario full-turn] [--out target/tui-lab]
  npm run slash-after-history -- [--scenario full-turn] [--out target/tui-lab]
  npm run goal-command -- [--scenario full-turn] [--out target/tui-lab]
  npm run run -- --scenario subagent-trace [--out target/tui-lab]
  npm run targeted-subagent-steer -- [--out target/tui-lab]
  npm run targeted-subagent-stop -- [--out target/tui-lab]
  npm run lsp-diagnostics -- [--out target/tui-lab]
  npm run ocr-review -- [--out target/tui-lab]
  npm run streaming-scrollbar -- [--stream-delay-ms 80] [--out target/tui-lab]
  npm run history-scrollbar -- --history PATH [--fallback-history PATH] [--drag-duration-ms 6000] [--video-fps 30]
  npm run clipboard -- [--scenario full-turn] [--out target/tui-lab]
  npm run copy-view -- --description copy-view-linux [--software-webgl] [--out target/tui-lab]
  node bin/tui-lab.mjs model-refresh --description model-hot-reload --out target/tui-lab
  npm run tail-menu -- --description tail-follow-menu [--software-webgl] [--out target/tui-lab]
  npm run image-paste -- [--scenario full-turn] [--out target/tui-lab]
  npm run history-search -- [--scenario full-turn] [--out target/tui-lab]
  npm run mention -- [--scenario full-turn] [--out target/tui-lab]
  npm run paste -- [--scenario full-turn] [--out target/tui-lab]
  npm run shell-prompt -- [--scenario full-turn] [--out target/tui-lab]
  npm run session-memory-compact -- [--scenario full-turn] [--out target/tui-lab]
  npm run session-resume -- [--scenario full-turn] [--out target/tui-lab]
  npm run resize-visual -- [--scenario full-turn] [--out target/tui-lab]
  node bin/tui-lab.mjs response-budget --scenario tail-follow --stream-delay-ms 10 --software-webgl
  npm run record -- [--command TEXT] [--send-message] [--record-seconds 30] [--sample-fps 1]
  npm run startup -- [--command TEXT] [--out target/tui-lab]
  npm run outline-navigation -- [--outline-inline] [--outline-streaming] [--out target/tui-lab]
  npm run screenshot -- [--scenario full-turn] [--out target/tui-lab]
  npm run tmux:startup -- [--command TEXT] [--out target/tui-lab]
  npm run tmux:smoke -- [--scenario full-turn] [--out target/tui-lab]

Options:
  --command TEXT       Override the default cargo command.
  --description TEXT   Description used in the run directory name.
  --message TEXT       Text inserted into the TUI composer before Enter.
  --second-message TEXT
                       Text inserted after the first turn completes in two-turn mode.
  --steer-after-tool   In two-turn mode, submit the second message while the first tool is still running.
  --out PATH           Base output directory. Outside the repository it must already be a private,
                       current-user-owned trusted directory; pathname checks cannot provide openat isolation.
  --workspace-template PATH
                       Template workspace copied into each timestamped run directory.
  --scenario NAME      Mock scenario passed to kcoder tui-dev.
  --cols N             PTY columns. Default: 100.
  --rows N             PTY rows. Default: 32.
  --timeout-ms N       Wait timeout. Default: 180000.
  --record-seconds N   Record duration for record mode. Default: 30.
  --sample-fps N       Timeline/video-frame sampling rate for record mode. Default: 1.
  --video-fps N        Compressed video frame rate for record mode. Default: 6.
  --stream-delay-ms N  Delay each tui-dev mock stream event by N ms. Default: 0, or 80 for streaming-scrollbar.
  --history PATH       Existing JSONL history to resume for history-scrollbar.
  --history-workspace PATH
                       Working directory that owns --history. Required when it differs from the new artifact workspace.
  --fallback-history PATH
                       Secondary JSONL history to try if --history is unavailable.
  --drag-duration-ms N Duration for history-scrollbar's held drag gesture. Default: 980.
  --drag-samples N     Number of samples during history-scrollbar's held drag. Default: 14.
  --send-message       In record mode, type --message after the welcome screen and press Enter.
  --headed             Run Playwright with a visible browser for run/screenshot.
  --headless           Run Playwright headless for open/run/screenshot.
  --software-webgl     Explicitly use ANGLE SwiftShader for WebGL screenshots.
  --outline-inline     Verify outline-navigation using the managed inline history layer.
  --outline-streaming  Also verify lookback while a deterministic mock turn completes.
  --copy-inline        Verify copy-view in Linux inline mode, entering with F9.
`;

function browserAttachDelaySeconds() {
  const raw = process.env.KCODER_TUI_LAB_ATTACH_DELAY_MS || "700";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed / 1000;
}

async function writeTextArtifact(file, content) {
  await writeFile(file, content, { mode: 0o644 });
  await chmod(file, 0o644);
}

async function writeJsonArtifact(file, value) {
  await writeTextArtifact(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
}

async function startSession(options) {
  const { file, args } = ptyCommand(options);
  const attachDelaySeconds = browserAttachDelaySeconds();
  const delayed =
    attachDelaySeconds > 0
      ? delayedSpawn(
          file,
          args,
          attachDelaySeconds,
          process.platform,
          process.env,
        )
      : { file, args };
  const spawnedFile = delayed.file;
  const spawnedArgs = delayed.args;
  const configHome = options.configHome || options.runDir || "";
  // TUI Lab validates real terminal colors; NO_COLOR is suitable only for plain-text logs and must not reach TUI child processes.
  const { NO_COLOR: _noColor, ...inheritedEnv } = process.env;
  const env = {
    ...inheritedEnv,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PATH: `${nodeModulesBin}${path.delimiter}${process.env.PATH || ""}`,
    ...configEnvironment(configHome, process.platform),
    RUST_LOG:
      process.env.RUST_LOG ||
      (options.scenario === "lsp-diagnostics"
        ? "warn,kcoder_tools::lsp=info"
        : "warn"),
    KCODER_TUI_LAB: "1",
    KCODER_TUI_LAB_RUN_DIR: options.runDir || "",
    KCODER_TUI_LAB_WORKSPACE: options.workspaceDir || "",
    KCODER_TUI_LAB_REQUEST_DIR: options.requestsDir || "",
    KCODER_TUI_LAB_CLIPBOARD_IMAGE_PATH:
      options.clipboardImageFixturePath || "",
    KCODER_TUI_LAB_STREAM_DELAY_MS: String(options.streamDelayMs || 0),
    KCODER_TUI_LAB_TEXT_CHUNK_CHARS:
      options.tuiLabMode === "targeted-subagent-steer"
        ? "2000"
        : options.scenario === "markdown-streaming"
          ? "1024"
          : options.tuiLabMode === "tail-menu"
            ? "32"
            : "",
    KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS:
      options.tuiLabMode === "targeted-subagent-steer" ||
      options.tuiLabMode === "targeted-subagent-stop"
        ? process.env.KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS || "1500"
        : options.scenario === "orchestrate-control"
          ? process.env.KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS || "25"
          : process.env.KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS || "",
    KCODER_TUI_LAB_FULL_TURN_TOOL_DELAY_MS: options.steerAfterTool
      ? "10000"
      : "",
    KCODER_TUI_INPUT_TRACE:
      options.tuiLabMode === "paste"
        ? path.join(options.runDir, "input-source-trace.log")
        : "",
    KCODER_LSP_ENABLED:
      options.scenario === "lsp-diagnostics"
        ? "1"
        : process.env.KCODER_LSP_ENABLED || "",
    KCODER_LSP_TIMEOUT_MS:
      options.scenario === "lsp-diagnostics"
        ? "10000"
        : process.env.KCODER_LSP_TIMEOUT_MS || "",
  };
  delete env.KCODER_HISTORY_DIR;
  if (options.tuiLabMode === "copy-view") {
    env.SSH_CONNECTION = "tui-lab-osc52";
    delete env.TMUX;
    delete env.STY;
  }
  if (options.externalEditorCommand) {
    env.VISUAL = options.externalEditorCommand;
    env.EDITOR = options.externalEditorCommand;
    env.KCODER_TUI_LAB_EDITOR_MARKER = options.externalEditorMarker;
  }

  const ptyProcess = pty.spawn(spawnedFile, spawnedArgs, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: repoRoot,
    env,
  });

  let backlog = "";
  let ptyLog = "";
  let exitInfo = null;
  let exited = false;
  const diagnostics = [];
  const exitPromise = new Promise((resolve) => {
    ptyProcess.onExit((event) => {
      exited = true;
      exitInfo = {
        exitCode: event.exitCode,
        signal: event.signal,
        at: new Date().toISOString(),
      };
      diagnostics.push({ type: "exit", ...exitInfo });
      resolve(exitInfo);
    });
  });
  const clients = new Set();
  ptyProcess.onData((data) => {
    ptyLog += data;
    backlog += data;
    if (backlog.length > 400000) {
      backlog = backlog.slice(-250000);
    }
    for (const ws of clients) {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    }
  });

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderTerminalPage(options));
      return;
    }
    if (requestUrl.pathname === "/viewport-diagnostics") {
      const tracePath = path.join(options.runDir || "", "viewport-trace.jsonl");
      const afterSequence = Math.max(
        0,
        Number.parseInt(requestUrl.searchParams.get("after") || "0", 10) || 0,
      );
      void readFile(tracePath, "utf8")
        .catch((error) => {
          if (error?.code === "ENOENT") return "";
          throw error;
        })
        .then((content) => {
          const events = content
            .split("\n")
            .filter(Boolean)
            .flatMap((line) => {
              try {
                return [JSON.parse(line)];
              } catch {
                // Rust may still be writing the final line; the sampler consumes complete JSONL records only.
                return [];
              }
            });
          const inputs = events.filter((event) => event.phase === "input");
          const commits = events.filter((event) => event.phase === "commit");
          const sequencedEvents = events.filter(
            (event) =>
              Number.isSafeInteger(event.sequence) &&
              event.sequence > afterSequence,
          );
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(
            JSON.stringify({
              inputCount: inputs.length,
              commitCount: commits.length,
              afterSequence,
              latestSequence: events.at(-1)?.sequence || 0,
              events: sequencedEvents,
              latestInput: inputs.at(-1) || null,
              latestCommit: commits.at(-1) || null,
            }),
          );
        })
        .catch((error) => {
          res.writeHead(500, {
            "content-type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ error: formatError(error) }));
        });
      return;
    }
    const staticMap = new Map([
      [
        "/xterm.css",
        path.join(
          toolRoot,
          "node_modules",
          "@xterm",
          "xterm",
          "css",
          "xterm.css",
        ),
      ],
      [
        "/xterm.js",
        path.join(
          toolRoot,
          "node_modules",
          "@xterm",
          "xterm",
          "lib",
          "xterm.js",
        ),
      ],
      [
        "/addon-fit.js",
        path.join(
          toolRoot,
          "node_modules",
          "@xterm",
          "addon-fit",
          "lib",
          "addon-fit.js",
        ),
      ],
      [
        "/addon-webgl.js",
        path.join(
          toolRoot,
          "node_modules",
          "@xterm",
          "addon-webgl",
          "lib",
          "addon-webgl.js",
        ),
      ],
    ]);
    const filePath = staticMap.get(requestUrl.pathname);
    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": filePath.endsWith(".css")
        ? "text/css"
        : "application/javascript",
    });
    createReadStream(filePath).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: "/pty" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    const terminalPreamble = terminalPreambleForPlatform(
      process.platform,
      options.tuiLabMode,
    );
    if (terminalPreamble) {
      ws.send(terminalPreamble);
    }
    if (backlog) {
      ws.send(backlog);
    }
    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "input") {
        try {
          ptyProcess.write(message.data);
        } catch (error) {
          diagnostics.push({
            type: "write-error",
            at: new Date().toISOString(),
            error: formatError(error),
          });
        }
      } else if (message.type === "resize") {
        const cols = Number.parseInt(message.cols, 10);
        const rows = Number.parseInt(message.rows, 10);
        if (
          Number.isFinite(cols) &&
          Number.isFinite(rows) &&
          cols > 0 &&
          rows > 0
        ) {
          try {
            if (!exited) {
              ptyProcess.resize(cols, rows);
            } else {
              diagnostics.push({
                type: "resize-after-exit",
                at: new Date().toISOString(),
                cols,
                rows,
                exitInfo,
              });
            }
          } catch (error) {
            diagnostics.push({
              type: "resize-error",
              at: new Date().toISOString(),
              cols,
              rows,
              error: formatError(error),
            });
          }
        }
      }
    });
    ws.on("close", () => clients.delete(ws));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const stop = async () => {
    try {
      const stoppedGracefully = await requestGracefulPtyStop(
        ptyProcess,
        exitPromise,
        () => exited,
        process.platform,
      );
      if (!stoppedGracefully && !exited) {
        if (process.platform === "win32") {
          const terminated = terminateProcessWithoutConsoleAttach(
            ptyProcess.pid,
          );
          diagnostics.push({
            type: terminated
              ? "process-terminated-without-console-attach"
              : "kill-skipped-after-missed-exit",
            at: new Date().toISOString(),
            pid: ptyProcess.pid,
          });
        } else {
          ptyProcess.kill();
        }
      }
    } catch {
      // Best-effort shutdown only.
    }
    for (const ws of clients) {
      ws.terminate();
    }
    wss.close();
    server.closeAllConnections?.();
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  };

  return {
    url,
    stop,
    ptyProcess,
    exitPromise,
    getExitInfo: () => exitInfo,
    getPtyLog: () => ptyLog,
    getDiagnostics: () => diagnostics.slice(),
  };
}

function overwriteWindowsClipboardForTest(marker) {
  if (process.platform !== "win32") {
    return {
      ok: true,
      skipped: true,
      reason: "native marker reset is Windows-only",
    };
  }
  const escaped = marker.replaceAll("'", "''");
  const result = spawnSync(
    process.env.KCODER_TUI_LAB_POWERSHELL || "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Set-Clipboard -Value '${escaped}'`,
    ],
    { encoding: "utf8" },
  );
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: result.stderr?.trim() || "",
  };
}

async function runBrowserScenario(options, prefix, mode = "single") {
  const artifacts = await createRunContext(
    options,
    prefix,
    runContextRuntime(),
  );
  const runOptions = {
    ...options,
    tuiLabMode: mode,
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
  let sessionId = "";
  let projectDir = artifacts.projectDir;
  let clipboardEvidence = null;
  let imagePasteEvidence = null;
  let historySearchEvidence = null;
  let mentionEvidence = null;
  let pasteEvidence = null;
  let shellPromptEvidence = null;
  let inlineSurfaceEvidence = null;
  let targetedSteerEvidence = null;
  let targetedStopEvidence = null;
  if (mode === "mention") {
    const directoryName = "folder with spaces";
    const fileName = "\u6606\u4ed1 \u6587\u4ef6.txt";
    const absolutePath = path.join(
      artifacts.workspace,
      directoryName,
      fileName,
    );
    const relativePath = [directoryName, fileName].join(path.sep);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "kcoder Windows mention fixture\n", "utf8");
    mentionEvidence = {
      relativePath,
      mentionText: `@${relativePath}`,
      absolutePath,
      fixtureExists: (await stat(absolutePath)).isFile(),
    };
  }
  if (mode === "image-paste") {
    const fixture = await createImagePasteFixture(artifacts.dir);
    runOptions.clipboardImageFixturePath = fixture.path;
    imagePasteEvidence = {
      fixturePath: fixture.path,
      fixtureBytes: fixture.byteLength,
      shortcut: imagePasteKeyForPlatform(process.platform),
    };
  }
  await writeStartMeta(artifacts, runOptions, command, mode);
  return runBrowserScenarioLifecycle({
    execute: async () => {
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
      const welcomeText = await page.evaluate(() => window.tuiLab.text());
      sessionId = extractTuiSessionId(welcomeText);
      await page.waitForTimeout(250);
      await captureStep(page, trace, "welcome", artifacts.welcomeScreenshot);

      let afterToolText = "";
      let expandedToolText = "";
      let toolExpansionInputEvents = [];
      let secondMessageSubmitted = false;
      await focusTerminal(page);
      await typeHumanText(page, options.message);
      await page.waitForTimeout(350);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(120);
      await captureStep(
        page,
        trace,
        "after-enter",
        artifacts.afterEnterScreenshot,
      );
      await page.waitForTimeout(350);
      await captureStep(
        page,
        trace,
        "streaming",
        artifacts.streamingScreenshot,
      );
      const afterToolNeedle =
        mode === "two-turn" && options.steerAfterTool
          ? "counted-line output smoke"
          : mode === "targeted-subagent-steer" ||
              mode === "targeted-subagent-stop"
            ? "Agent Swarm"
            : scenarioToolNeedle(options.scenario);
      if (mode === "two-turn" && options.steerAfterTool) {
        await waitForTerminalText(page, afterToolNeedle, options.timeoutMs);
      } else {
        await tryWaitForTerminalText(
          page,
          afterToolNeedle,
          Math.min(options.timeoutMs, 5000),
        );
      }
      await captureStep(
        page,
        trace,
        "after-tool",
        artifacts.afterToolScreenshot,
      );
      afterToolText = await page.evaluate(() => window.tuiLab.text());
      if (mode === "two-turn" && options.steerAfterTool) {
        await focusTerminal(page);
        await typeHumanText(page, options.secondMessage);
        await page.waitForTimeout(120);
        await page.keyboard.press("Enter");
        secondMessageSubmitted = true;
        await captureStep(
          page,
          trace,
          "after-second-message",
          artifacts.afterSecondMessageScreenshot,
        );
      }
      await waitForTerminalText(
        page,
        scenarioFinalNeedle(options.scenario),
        options.timeoutMs,
      );
      await page.waitForTimeout(250);
      await captureStep(page, trace, "after-final", artifacts.finalScreenshot);
      if (mode === "targeted-subagent-steer") {
        // Test visible parent input order while the delegated panel is still live.
        const parentInput = "Pause request: TUI_LAB_PARENT_INPUT_SENTINEL";
        await focusTerminal(page);
        await typeHumanText(page, parentInput);
        await page.keyboard.press("Enter");
        await waitForTerminalText(page, "TUI_LAB_PARENT_INPUT_ACK", options.timeoutMs);
        const parentInputScreen = await page.evaluate(() => window.tuiLab.visibleText());
        const parentOld = parentInputScreen.indexOf("tui-lab-subagent-trace-final-sentinel");
        const parentUser = parentInputScreen.indexOf(parentInput);
        const parentAck = parentInputScreen.indexOf("TUI_LAB_PARENT_INPUT_ACK");
        const parentInputOrdered = parentOld >= 0 && parentOld < parentUser && parentUser < parentAck &&
          parentInputScreen.split("TUI_LAB_PARENT_INPUT_SENTINEL").length === 2;
        await captureStep(page, trace, "parent-input-after-live-panel",
          path.join(artifacts.dir, "parent-input-after-live-panel.png"));
        const sentinel = "TUI_LAB_TARGETED_STEER_SENTINEL";
        const listScreenshot = path.join(
          artifacts.dir,
          "targeted-steer-agent-list.png",
        );
        const viewScreenshot = path.join(
          artifacts.dir,
          "targeted-steer-agent-view.png",
        );
        const queuedScreenshot = path.join(
          artifacts.dir,
          "targeted-steer-queued.png",
        );
        const appliedScreenshot = path.join(
          artifacts.dir,
          "targeted-steer-applied.png",
        );
        await focusTerminal(page);
        await typeHumanText(page, "/agent list");
        await page.keyboard.press("Enter");
        await waitForTerminalText(page, "Sub-agents", options.timeoutMs);
        await page.waitForTimeout(150);
        const agentListText = await page.evaluate(() => window.tuiLab.text());
        const agentRows = Array.from(
          agentListText.matchAll(
            /((?:agent|job)-[A-Za-z0-9._-]+)\s+\[([^\]]+)\]/g,
          ),
          (match) => ({ agentId: match[1], status: match[2] }),
        ).filter(
          (row, index, all) =>
            all.findIndex((candidate) => candidate.agentId === row.agentId) ===
            index,
        );
        const agentIds = agentRows.map((row) => row.agentId);
        if (agentIds.length < 2) {
          throw new Error(
            `targeted steer scenario expected two sub-agents, found ${agentIds.length}`,
          );
        }
        const targetAgentId = agentIds[0];
        const siblingAgentIds = agentIds.slice(1);
        await captureStep(
          page,
          trace,
          "targeted-steer-agent-list",
          listScreenshot,
        );

        await page.evaluate(() => window.tuiLab.focus());
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("Enter");
        await waitForTerminalText(
          page,
          "Esc returns to parent",
          options.timeoutMs,
        );
        const viewText = await page.evaluate(() => window.tuiLab.visibleText());
        const childTailNearComposer = (text) => {
          const rows = text.split("\n");
          const status = rows.findIndex((row) => row.includes("Agent status:"));
          const composer = rows.findIndex((row) => row.includes("Esc returns to parent"));
          return status >= 0 && composer > status && composer - status <= 4;
        };
        await captureStep(
          page,
          trace,
          "targeted-steer-agent-view",
          viewScreenshot,
        );

        // Prove that visible text arrives before the durable response boundary.
        const liveProjectDir = await waitForProjectDirForSession(artifacts.configDir, sessionId, options.timeoutMs);
        await waitForTerminalText(page, "tui-lab-child-line-020", options.timeoutMs);
        const earlyLiveText = await page.evaluate(() => window.tuiLab.visibleText());
        await captureStep(page, trace, "targeted-live-early",
          path.join(artifacts.dir, "targeted-live-early.png"));
        await waitForTerminalText(page, "tui-lab-child-line-180", options.timeoutMs);
        const liveViewText = await page.evaluate(() => window.tuiLab.visibleText());
        const childPath = path.join(liveProjectDir, sessionId, "subagents", targetAgentId, "transcript.json");
        const checkpointBeforeDone = await readFile(childPath, "utf8");
        const liveBeforeCheckpoint = earlyLiveText.includes("tui-lab-child-line-020") &&
          !earlyLiveText.includes("tui-lab-child-line-180") && liveViewText.includes("tui-lab-child-line-180") &&
          !checkpointBeforeDone.includes("tui-lab-child-line-180");
        const tailNearComposer = [viewText, earlyLiveText, liveViewText].every(childTailNearComposer);
        await captureStep(page, trace, "targeted-live-before-checkpoint",
          path.join(artifacts.dir, "targeted-live-before-checkpoint.png"));

        await focusTerminal(page);
        await typeHumanText(page, sentinel);
        await page.keyboard.press("Enter");
        await waitForTerminalText(page, "Steering queued", options.timeoutMs);
        const queuedText = await page.evaluate(() =>
          window.tuiLab.visibleText(),
        );
        await captureStep(
          page,
          trace,
          "targeted-steer-queued",
          queuedScreenshot,
        );
        await waitForTerminalText(page, "Steering applied", options.timeoutMs);
        const appliedText = await page.evaluate(() =>
          window.tuiLab.visibleText(),
        );
        await captureStep(
          page,
          trace,
          "targeted-steer-applied",
          appliedScreenshot,
        );
        await waitForTerminalText(
          page,
          "tui-lab-child-line-180",
          options.timeoutMs,
        );
        const longChildBottomText = await page.evaluate(() =>
          window.tuiLab.visibleText(),
        );
        await pressRepeated(page, "PageUp", 32);
        await page.waitForTimeout(250);
        const longChildScrolledText = await page.evaluate(() =>
          window.tuiLab.visibleText(),
        );
        await pressRepeated(page, "PageDown", 32);
        await page.waitForTimeout(250);
        const longChildRestoredBottomText = await page.evaluate(() =>
          window.tuiLab.visibleText(),
        );
        const completed = await waitForTargetedSubagentSteerEvidence(liveProjectDir, {
          targetAgentId, siblingAgentIds, sentinel, timeoutMs: options.timeoutMs,
        });
        if (!completed.hasAllRequired) throw new Error("child tasks must finish before the synthetic collapsed-history probe");
        const originalChildTranscript = await readFile(childPath, "utf8");
        let collapsedTailFilled = false;
        try {
          // This is a restored rendering fixture, not evidence of executed tools.
          const fixture = JSON.parse(originalChildTranscript);
          for (let index = 0; index < 100; index += 1) {
            fixture.push({ role: "assistant", content: [{ type: "text", text: `tui-lab-backfill-history-${String(index).padStart(3, "0")}` }] });
          }
          fixture.push({ role: "assistant", content: Array.from({ length: 350 }, (_, index) => ({
            type: "tool_use", id: `backfill-read-${index}`, name: "read", input: { file_path: `fixture-${index}.md` },
          })) });
          fixture.push({ role: "assistant", content: [{ type: "text", text: "TUI_LAB_COLLAPSED_TAIL_END" }] });
          await writeFile(childPath, JSON.stringify(fixture), { mode: 0o600 });
          await waitForTerminalText(page, "TUI_LAB_COLLAPSED_TAIL_END", options.timeoutMs);
          const filledText = await page.evaluate(() => window.tuiLab.visibleText());
          const fillsTop = (text) => text.split("\n").slice(0, 3).some((line) => line.includes("tui-lab-backfill-history-"));
          await captureStep(page, trace, "targeted-collapsed-tail-filled",
            path.join(artifacts.dir, "targeted-collapsed-tail-filled.png"));
          await pressRepeated(page, "PageUp", 1);
          await page.waitForTimeout(250);
          await pressRepeated(page, "PageDown", 2);
          await waitForTerminalText(page, "TUI_LAB_COLLAPSED_TAIL_END", options.timeoutMs);
          const returnedText = await page.evaluate(() => window.tuiLab.visibleText());
          collapsedTailFilled = fillsTop(filledText) && fillsTop(returnedText) &&
            filledText.includes("tui-lab-backfill-history-099") && returnedText.includes("tui-lab-backfill-history-099");
          await captureStep(page, trace, "targeted-collapsed-tail-returned",
            path.join(artifacts.dir, "targeted-collapsed-tail-returned.png"));
        } finally {
          await writeFile(childPath, originalChildTranscript, { mode: 0o600 });
        }
        targetedSteerEvidence = {
          parentInputOrdered,
          pickerDescriptionVisible: agentListText.includes("tui-lab-subagent-worker-sentinel"),
          pickerKeyboardEnteredTarget: viewText.includes(targetAgentId),
          liveBeforeCheckpoint,
          tailNearComposer,
          collapsedTailFilled,
          sentinel,
          targetAgentId,
          siblingAgentIds,
          agentListCount: agentIds.length,
          targetWasRunning:
            agentRows.find((row) => row.agentId === targetAgentId)?.status ===
            "running",
          viewVisible: viewText.includes("Esc returns to parent"),
          viewShowsChildTranscript: textContainsAcrossWrap(
            viewText,
            "tui-lab-subagent-worker-sentinel",
          ),
          viewHidesPostSpawnParentTranscript: !textContainsAcrossWrap(
            viewText,
            "tui-lab-subagent-trace-final-sentinel",
          ),
          queuedVisible: queuedText.includes("Steering queued"),
          queuedLiveVisible: queuedText.includes("queued_live"),
          appliedVisible: appliedText.includes("Steering applied"),
          longChildBottomVisible: textContainsAcrossWrap(
            longChildBottomText,
            "tui-lab-child-line-180",
          ),
          longChildScrolledBack: textContainsAcrossWrap(
            longChildScrolledText,
            "tui-lab-child-line-001",
          ),
          longChildBottomRestored: textContainsAcrossWrap(
            longChildRestoredBottomText,
            "tui-lab-child-line-180",
          ),
          screenshots: {
            agentList: listScreenshot,
            agentView: viewScreenshot,
            queued: queuedScreenshot,
            applied: appliedScreenshot,
          },
        };
        await pressTerminalEscape(page, process.platform);
        await waitForTerminalTextMissing(
          page,
          "Esc returns to parent",
          options.timeoutMs,
        );
      }
      if (mode === "targeted-subagent-stop") {
        const stopScreenshot = path.join(
          artifacts.dir,
          "targeted-stop-result.png",
        );
        await focusTerminal(page);
        await typeHumanText(page, "/agent list");
        await page.keyboard.press("Enter");
        await waitForTerminalText(page, "Sub-agents", options.timeoutMs);
        await page.waitForTimeout(150);
        const agentListText = await page.evaluate(() => window.tuiLab.text());
        const agentRows = Array.from(
          agentListText.matchAll(
            /((?:agent|job)-[A-Za-z0-9._-]+)\s+\[([^\]]+)\]/g,
          ),
          (match) => ({ agentId: match[1], status: match[2] }),
        ).filter(
          (row, index, all) =>
            all.findIndex((candidate) => candidate.agentId === row.agentId) ===
            index,
        );
        if (agentRows.length < 2) {
          throw new Error(
            `targeted stop scenario expected two sub-agents, found ${agentRows.length}`,
          );
        }
        const targetAgentId = agentRows[0].agentId;
        const siblingAgentIds = agentRows.slice(1).map((row) => row.agentId);
        targetedStopEvidence = {
          targetAgentId,
          siblingAgentIds,
          agentListCount: agentRows.length,
          allAgentsWereRunning: agentRows.every(
            (row) => row.status === "running",
          ),
          commandVisible: false,
          artifacts: null,
          screenshot: stopScreenshot,
        };
        await page.evaluate(() => window.tuiLab.focus());
        await pressTerminalEscape(page, process.platform);
        await typeHumanText(page, `/stop ${targetAgentId}`);
        await page.keyboard.press("Enter");
        await waitForTerminalText(
          page,
          `Stopping 1 background task(s): ${targetAgentId}`,
          options.timeoutMs,
        );
        targetedStopEvidence.commandVisible = true;
        await captureStep(page, trace, "targeted-stop-result", stopScreenshot);
      }
      await focusTerminal(page);
      let scrollbarDrag = null;
      let scrollbarThumbStability = null;
      let rapidPageScroll = null;
      let fullScrollCycles = null;
      let wheelScrollCycles = null;
      let sustainedWheelScroll = null;
      let scrollTopText = "";
      let scrollBottomText = "";
      if (
        options.scenario === "lsp-diagnostics" ||
        options.scenario === "ocr-review" ||
        options.scenario === "subagent-trace" ||
        options.scenario === "long-write"
      ) {
        const inputEventCount = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );
        await page.keyboard.press("Alt+T");
        toolExpansionInputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          inputEventCount,
        );
        await tryWaitForTerminalTextMissing(
          page,
          "alt + t to expand tools",
          Math.min(options.timeoutMs, 5000),
        );
        await captureStep(
          page,
          trace,
          "after-tool-expanded",
          artifacts.afterToolExpandedScreenshot,
        );
        expandedToolText = await page.evaluate(() => window.tuiLab.text());
        await page.evaluate(() => window.tuiLab.scrollToTop());
        await page.waitForTimeout(250);
        await captureStep(
          page,
          trace,
          "after-scroll-top",
          artifacts.afterScrollTopScreenshot,
        );
        scrollTopText = [
          expandedToolText,
          await page.evaluate(() => window.tuiLab.text()),
        ].join("\n");
        await page.evaluate(() => window.tuiLab.scrollToBottom());
        await page.waitForTimeout(250);
        await captureStep(
          page,
          trace,
          "after-scroll-bottom",
          artifacts.afterScrollBottomScreenshot,
        );
        scrollBottomText = await page.evaluate(() => window.tuiLab.text());
      } else if (
        options.scenario === "orchestrate-control" ||
        mode === "inline" ||
        mode === "screenshot" ||
        mode === "clipboard" ||
        mode === "image-paste" ||
        mode === "history-search" ||
        mode === "mention" ||
        mode === "paste" ||
        mode === "shell-prompt"
      ) {
        if (mode === "inline") {
          inlineSurfaceEvidence = await page.evaluate(() => ({
            internalScrollbar: window.tuiLab.internalScrollbar(),
            hasHostScrollbar: window.tuiLab.hasScrollbar(),
            dimensions: window.tuiLab.dimensions(),
          }));
          await page.evaluate(() => window.tuiLab.scrollToTop());
        } else {
          await pressRepeated(page, "PageUp", 16);
        }
        await page.waitForTimeout(250);
        await captureStep(
          page,
          trace,
          "after-scroll-top",
          artifacts.afterScrollTopScreenshot,
        );
        scrollTopText = await page.evaluate(() => window.tuiLab.text());
        if (mode === "inline") {
          await page.evaluate(() => window.tuiLab.scrollToBottom());
        } else {
          await pressRepeated(page, "PageDown", 16);
        }
        await page.waitForTimeout(250);
        await captureStep(
          page,
          trace,
          "after-scroll-bottom",
          artifacts.afterScrollBottomScreenshot,
        );
        scrollBottomText = await page.evaluate(() => window.tuiLab.text());
      } else {
        scrollbarDrag = await measureTranscriptScrollbarDrag(page);
        await captureStep(
          page,
          trace,
          "after-scrollbar-drag-bottom",
          artifacts.afterScrollbarDragBottomScreenshot,
        );
        scrollbarThumbStability =
          await measureScrollbarThumbStabilityDuringDrag(page);
        rapidPageScroll = await measureRapidPageScroll(page);
        fullScrollCycles = await measureFullScrollCycles(page);
        wheelScrollCycles = await measureWheelScrollCycles(page);
        sustainedWheelScroll = await measureSustainedWheelScroll(page);
        await pressRepeated(page, "PageUp", 16);
        await page.waitForTimeout(250);
        await captureStep(
          page,
          trace,
          "after-scroll-top",
          artifacts.afterScrollTopScreenshot,
        );
        scrollTopText = await page.evaluate(() => window.tuiLab.text());
        await pressRepeated(page, "PageDown", 16);
        await page.waitForTimeout(250);
        await captureStep(
          page,
          trace,
          "after-scroll-bottom",
          artifacts.afterScrollBottomScreenshot,
        );
        scrollBottomText = await page.evaluate(() => window.tuiLab.text());
      }

      if (mode === "image-paste") {
        await focusTerminal(page);
        const inputStart = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );
        await page.keyboard.press(imagePasteEvidence.shortcut);
        await waitForTerminalText(page, "[Image #1]", options.timeoutMs);
        await page.waitForTimeout(250);
        imagePasteEvidence.composedText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        imagePasteEvidence.inputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          inputStart,
        );
        await captureStep(
          page,
          trace,
          "image-paste-composed",
          artifacts.imagePasteComposedScreenshot,
        );

        await typeHumanText(page, " describe the clipboard fixture");
        await page.keyboard.press("Enter");
        const submittedRequest = await waitForRequestEvidence(
          artifacts.requestsDir,
          {
            mustContain: ['"type": "image"', '"media_type": "image/png"'],
            timeoutMs: options.timeoutMs,
          },
        );
        const followupText =
          "Does the previous clipboard image remain visible?";
        await focusTerminal(page);
        await typeHumanText(page, followupText);
        await page.keyboard.press("Enter");
        const contextRequest = await waitForRequestEvidence(
          artifacts.requestsDir,
          {
            mustContain: [
              followupText,
              '"type": "image"',
              '"media_type": "image/png"',
            ],
            timeoutMs: options.timeoutMs,
          },
        );
        await page.waitForTimeout(250);
        imagePasteEvidence.submittedText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        imagePasteEvidence.requestCaptured = submittedRequest.hasAllRequired;
        imagePasteEvidence.followupText = followupText;
        imagePasteEvidence.contextRequestCaptured =
          contextRequest.hasAllRequired;
        imagePasteEvidence.contextRequestFiles = contextRequest.files
          .filter((file) => Object.values(file.contains || {}).every(Boolean))
          .map((file) => file.file);
        await captureStep(
          page,
          trace,
          "image-paste-submitted",
          artifacts.imagePasteSubmittedScreenshot,
        );
        imagePasteEvidence.screenshots = {
          composed: artifacts.imagePasteComposedScreenshot,
          submitted: artifacts.imagePasteSubmittedScreenshot,
        };
      }

      if (mode === "two-turn") {
        if (!secondMessageSubmitted) {
          await focusTerminal(page);
          await typeHumanText(page, options.secondMessage);
          await page.waitForTimeout(250);
          await page.keyboard.press("Enter");
          await page.waitForTimeout(250);
          await captureStep(
            page,
            trace,
            "after-second-message",
            artifacts.afterSecondMessageScreenshot,
          );
        }
        await waitForTerminalText(
          page,
          options.steerAfterTool
            ? "tui-lab-live-steer-sentinel"
            : "tui-lab-second-turn-sentinel",
          options.timeoutMs,
        );
        await page.waitForTimeout(250);
        await captureStep(
          page,
          trace,
          "after-second-final",
          artifacts.afterSecondFinalScreenshot,
        );
      }
      const clipboardScreenshot = path.join(artifacts.dir, "after-copy.png");
      if (mode === "clipboard") {
        const nativeSelectionInputStart = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );
        const nativeSelectionText = await page.evaluate(() =>
          window.tuiLab.selectAll(),
        );
        await page.keyboard.press("Control+C");
        const nativeSelectionInputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          nativeSelectionInputStart,
        );
        await page.evaluate(() => window.tuiLab.clearSelection());

        await focusTerminal(page);
        const noSelectionCtrlCInputStart = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );
        await page.keyboard.press("Control+C");
        await waitForTerminalText(
          page,
          "ctrl + c again to quit",
          options.timeoutMs,
        );
        const noSelectionCtrlCInputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          noSelectionCtrlCInputStart,
        );
        const firstIdleCtrlCShowsQuitHint = (
          await page.evaluate(() => window.tuiLab.text())
        ).includes("ctrl + c again to quit");
        const quitHintScreenshot = path.join(
          artifacts.dir,
          "after-first-idle-ctrl-c.png",
        );
        await captureStep(
          page,
          trace,
          "after-first-idle-ctrl-c",
          quitHintScreenshot,
        );

        await focusTerminal(page);
        await typeHumanText(page, "/copy");
        await page.keyboard.press("Enter");
        await waitForTerminalText(
          page,
          "Copied last message to clipboard",
          options.timeoutMs,
        );
        await page.waitForTimeout(250);
        await captureStep(page, trace, "after-copy", clipboardScreenshot);

        const markerReset = overwriteWindowsClipboardForTest(
          `WINDOWS_CLIPBOARD_BEFORE_CTRL_O_${Date.now()}`,
        );
        const copyNoticeCount = await page.evaluate(
          () =>
            (
              window.tuiLab.text().match(/Copied last message to clipboard/g) ||
              []
            ).length,
        );
        const shortcutInputStart = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );
        await page.keyboard.press("Control+O");
        await page.waitForFunction(
          (previousCount) =>
            (
              window.tuiLab.text().match(/Copied last message to clipboard/g) ||
              []
            ).length > previousCount,
          copyNoticeCount,
          { timeout: options.timeoutMs },
        );
        const shortcutInputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          shortcutInputStart,
        );
        const afterCopyShortcutScreenshot = path.join(
          artifacts.dir,
          "after-copy-shortcut.png",
        );
        await captureStep(
          page,
          trace,
          "after-copy-shortcut",
          afterCopyShortcutScreenshot,
        );

        await focusTerminal(page);
        await typeHumanText(page, "/raw on");
        await page.keyboard.press("Enter");
        await waitForTerminalText(
          page,
          "Raw output mode on: transcript text is shown for clean terminal selection.",
          options.timeoutMs,
        );
        await page.waitForTimeout(250);
        const rawOnCommandText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        const rawOnCommandScreenshot = path.join(
          artifacts.dir,
          "raw-on-command.png",
        );
        await captureStep(
          page,
          trace,
          "raw-on-command",
          rawOnCommandScreenshot,
        );

        await focusTerminal(page);
        await typeHumanText(page, "/raw off");
        await page.keyboard.press("Enter");
        await waitForTerminalText(
          page,
          "Raw output mode off: rich transcript rendering restored.",
          options.timeoutMs,
        );
        await page.waitForTimeout(250);
        const rawOffCommandText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        const rawOffCommandScreenshot = path.join(
          artifacts.dir,
          "raw-off-command.png",
        );
        await captureStep(
          page,
          trace,
          "raw-off-command",
          rawOffCommandScreenshot,
        );

        const rawShortcutInputStart = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );
        await page.keyboard.press("Alt+R");
        await waitForTerminalTextState(page, "```", true, options.timeoutMs);
        const rawOnShortcutText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        const rawOnShortcutScreenshot = path.join(
          artifacts.dir,
          "raw-on-shortcut.png",
        );
        await captureStep(
          page,
          trace,
          "raw-on-shortcut",
          rawOnShortcutScreenshot,
        );
        await page.keyboard.press("Alt+R");
        await waitForTerminalTextState(page, "```", false, options.timeoutMs);
        const rawOffShortcutText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        const rawOffShortcutScreenshot = path.join(
          artifacts.dir,
          "raw-off-shortcut.png",
        );
        await captureStep(
          page,
          trace,
          "raw-off-shortcut",
          rawOffShortcutScreenshot,
        );
        const rawShortcutInputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          rawShortcutInputStart,
        );
        clipboardEvidence = {
          nativeSelectionText,
          nativeSelectionInputEvents,
          noSelectionCtrlCInputEvents,
          firstIdleCtrlCShowsQuitHint,
          markerReset,
          shortcutInputEvents,
          rawShortcutInputEvents,
          rawOnCommandHasFence: rawOnCommandText.includes("```"),
          rawOffCommandHasFence: rawOffCommandText.includes("```"),
          rawOnShortcutHasFence: rawOnShortcutText.includes("```"),
          rawOffShortcutHasFence: rawOffShortcutText.includes("```"),
          screenshots: {
            quitHint: quitHintScreenshot,
            afterCopyShortcut: afterCopyShortcutScreenshot,
            rawOnCommand: rawOnCommandScreenshot,
            rawOffCommand: rawOffCommandScreenshot,
            rawOnShortcut: rawOnShortcutScreenshot,
            rawOffShortcut: rawOffShortcutScreenshot,
          },
        };
      }
      if (mode === "history-search") {
        const oldest = "windows-history-alpha oldest";
        const newest = "windows-history-alpha newest";
        const originalDraft = "windows history draft survives cancel";
        for (const [name, message] of [
          ["oldest", oldest],
          ["newest", newest],
        ]) {
          const previousSentinels = await page.evaluate(
            () =>
              (
                window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) ||
                []
              ).length,
          );
          await focusTerminal(page);
          await typeHumanText(page, message);
          await page.keyboard.press("Enter");
          await page.waitForFunction(
            (previousCount) =>
              (
                window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) ||
                []
              ).length > previousCount,
            previousSentinels,
            { timeout: options.timeoutMs },
          );
          await captureStep(
            page,
            trace,
            `history-seed-${name}`,
            path.join(artifacts.dir, `history-seed-${name}.png`),
          );
        }

        await focusTerminal(page);
        await typeHumanText(page, originalDraft);
        const inputStart = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );
        await page.keyboard.press("Control+R");
        await waitForTerminalText(page, "reverse-i-search:", options.timeoutMs);
        await typeHumanText(page, "windows-history-alpha");
        await waitForComposerText(page, newest, options.timeoutMs);
        const newestComposer = await readComposerText(page);
        const newestScreenshot = path.join(
          artifacts.dir,
          "history-search-newest.png",
        );
        await captureStep(
          page,
          trace,
          "history-search-newest",
          newestScreenshot,
        );

        await page.keyboard.press("Control+R");
        await waitForComposerText(page, oldest, options.timeoutMs);
        const oldestComposer = await readComposerText(page);
        const oldestScreenshot = path.join(
          artifacts.dir,
          "history-search-oldest.png",
        );
        await captureStep(
          page,
          trace,
          "history-search-oldest",
          oldestScreenshot,
        );
        await page.keyboard.press("Control+S");
        await waitForComposerText(page, newest, options.timeoutMs);
        const ctrlSComposer = await readComposerText(page);
        await page.keyboard.press("ArrowUp");
        await waitForComposerText(page, oldest, options.timeoutMs);
        const arrowUpComposer = await readComposerText(page);
        await page.keyboard.press("ArrowDown");
        await waitForComposerText(page, newest, options.timeoutMs);
        const arrowDownComposer = await readComposerText(page);
        await page.keyboard.press("Enter");
        await waitForTerminalTextMissing(
          page,
          "reverse-i-search:",
          options.timeoutMs,
        );
        const acceptedComposer = await readComposerText(page);

        await page.keyboard.press("Control+U");
        await typeHumanText(page, originalDraft);
        await page.keyboard.press("Control+R");
        await waitForTerminalText(page, "reverse-i-search:", options.timeoutMs);
        await typeHumanText(page, "windows-history-alpha");
        await waitForComposerText(page, newest, options.timeoutMs);
        await page.keyboard.press("Escape");
        await waitForTerminalTextMissing(
          page,
          "reverse-i-search:",
          options.timeoutMs,
        );
        await waitForComposerText(page, originalDraft, options.timeoutMs);
        const cancelledComposer = await readComposerText(page);
        const cancelledScreenshot = path.join(
          artifacts.dir,
          "history-search-cancelled.png",
        );
        await captureStep(
          page,
          trace,
          "history-search-cancelled",
          cancelledScreenshot,
        );

        await page.keyboard.press("Control+R");
        await waitForTerminalText(page, "reverse-i-search:", options.timeoutMs);
        await typeHumanText(page, "definitely-no-history-match");
        await waitForTerminalText(page, "no match", options.timeoutMs);
        await page.keyboard.press("Enter");
        const enterWithoutMatchStayedOpen = await tryWaitForTerminalText(
          page,
          "reverse-i-search:",
          1000,
        );
        const noMatchScreenshot = path.join(
          artifacts.dir,
          "history-search-no-match.png",
        );
        await captureStep(
          page,
          trace,
          "history-search-no-match",
          noMatchScreenshot,
        );
        await page.keyboard.press("Escape");
        await waitForTerminalTextMissing(
          page,
          "reverse-i-search:",
          options.timeoutMs,
        );
        const restoredAfterNoMatch = await readComposerText(page);
        const inputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          inputStart,
        );
        historySearchEvidence = {
          oldest,
          newest,
          originalDraft,
          newestComposer,
          oldestComposer,
          ctrlSComposer,
          arrowUpComposer,
          arrowDownComposer,
          acceptedComposer,
          cancelledComposer,
          restoredAfterNoMatch,
          enterWithoutMatchStayedOpen,
          inputEvents,
          screenshots: {
            newest: newestScreenshot,
            oldest: oldestScreenshot,
            cancelled: cancelledScreenshot,
            noMatch: noMatchScreenshot,
          },
        };
      }
      if (mode === "mention") {
        const inputStart = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );
        await focusTerminal(page);
        await typeHumanText(page, "/mention");
        await page.keyboard.press("Enter");
        await waitForComposerText(page, "@", options.timeoutMs);
        const prefilledComposer = await readComposerText(page);
        const prefilledScreenshot = path.join(
          artifacts.dir,
          "mention-prefilled.png",
        );
        await captureStep(
          page,
          trace,
          "mention-prefilled",
          prefilledScreenshot,
        );

        await typeHumanText(page, mentionEvidence.relativePath);
        await waitForComposerText(
          page,
          mentionEvidence.mentionText,
          options.timeoutMs,
        );
        const composedText = await readComposerText(page);
        const composedScreenshot = path.join(
          artifacts.dir,
          "mention-composed.png",
        );
        await captureStep(page, trace, "mention-composed", composedScreenshot);

        const previousSentinels = await page.evaluate(
          () =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length,
        );
        await page.keyboard.press("Enter");
        await page.waitForFunction(
          (previousCount) =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length > previousCount,
          previousSentinels,
          { timeout: options.timeoutMs },
        );
        await page.waitForTimeout(250);
        const submittedText = await page.evaluate(() => window.tuiLab.text());
        const submittedScreenshot = path.join(
          artifacts.dir,
          "mention-submitted.png",
        );
        await captureStep(
          page,
          trace,
          "mention-submitted",
          submittedScreenshot,
        );
        const inputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          inputStart,
        );
        mentionEvidence = {
          ...mentionEvidence,
          prefilledComposer,
          composedText,
          submittedText,
          inputEvents,
          screenshots: {
            prefilled: prefilledScreenshot,
            composed: composedScreenshot,
            submitted: submittedScreenshot,
          },
        };
      }
      if (mode === "paste") {
        const smallPastedRaw = [
          "paste-small-alpha with spaces",
          "\u7b2c\u4e8c\u884c Windows Unicode",
          "paste-small-third-line",
        ].join("\r\n");
        const smallPasted = smallPastedRaw.replaceAll("\r\n", "\n");
        const largePasted = `paste-large-start-${"x".repeat(1100)}-\u6606\u4ed1-large-end`;
        const largePlaceholder = `[Pasted Content ${Array.from(largePasted).length} chars]`;
        const inputStart = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );

        await focusTerminal(page);
        const sentinelsBeforeSmallPaste = await page.evaluate(
          () =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length,
        );
        await page.evaluate(
          (payload) =>
            window.tuiLab.sendInput(`\u001b[200~${payload}\u001b[201~`),
          smallPastedRaw,
        );
        await waitForTerminalText(
          page,
          "paste-small-third-line",
          options.timeoutMs,
        );
        await page.waitForTimeout(250);
        const smallComposerText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        const sentinelsAfterSmallPaste = await page.evaluate(
          () =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length,
        );
        const smallComposedScreenshot = path.join(
          artifacts.dir,
          "paste-small-composed.png",
        );
        await captureStep(
          page,
          trace,
          "paste-small-composed",
          smallComposedScreenshot,
        );

        await page.keyboard.press("Enter");
        await page.waitForFunction(
          (previousCount) =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length > previousCount,
          sentinelsAfterSmallPaste,
          { timeout: options.timeoutMs },
        );
        await page.waitForTimeout(250);
        const smallSubmittedScreenshot = path.join(
          artifacts.dir,
          "paste-small-submitted.png",
        );
        await captureStep(
          page,
          trace,
          "paste-small-submitted",
          smallSubmittedScreenshot,
        );

        const sentinelsBeforeLargePaste = await page.evaluate(
          () =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length,
        );
        await page.evaluate(
          (payload) =>
            window.tuiLab.sendInput(`\u001b[200~${payload}\u001b[201~`),
          largePasted,
        );
        await waitForComposerText(
          page,
          largePlaceholder,
          Math.min(options.timeoutMs, 15000),
        );
        await page.waitForTimeout(250);
        const largeComposerText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        const largeComposedScreenshot = path.join(
          artifacts.dir,
          "paste-large-placeholder.png",
        );
        await captureStep(
          page,
          trace,
          "paste-large-placeholder",
          largeComposedScreenshot,
        );

        await page.keyboard.press("Enter");
        await page.waitForFunction(
          (previousCount) =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length > previousCount,
          sentinelsBeforeLargePaste,
          { timeout: options.timeoutMs },
        );
        await page.waitForTimeout(250);
        const largeSubmittedText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        const largeSubmittedScreenshot = path.join(
          artifacts.dir,
          "paste-large-submitted.png",
        );
        await captureStep(
          page,
          trace,
          "paste-large-submitted",
          largeSubmittedScreenshot,
        );
        const inputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          inputStart,
        );
        pasteEvidence = {
          smallPasted,
          largePasted,
          largePlaceholder,
          smallComposerText,
          largeComposerText,
          largeSubmittedText,
          sentinelsBeforeSmallPaste,
          sentinelsAfterSmallPaste,
          inputEvents,
          screenshots: {
            smallComposed: smallComposedScreenshot,
            smallSubmitted: smallSubmittedScreenshot,
            largePlaceholder: largeComposedScreenshot,
            largeSubmitted: largeSubmittedScreenshot,
          },
        };
      }
      if (mode === "shell-prompt") {
        const commandText =
          process.platform === "win32"
            ? "Write-Output ('tui-shell-output-' + [char]0x6606 + [char]0x4ED1)"
            : "printf 'tui-shell-output-\\346\\230\\206\\344\\273\\221\\n'";
        const historyText = `!${commandText}`;
        const marker = "tui-shell-output-\u6606\u4ed1";
        const inputStart = await page.evaluate(
          () => window.tuiLab.inputEvents().length,
        );
        const secondTurnSentinelsBefore = await page.evaluate(
          () =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length,
        );

        await focusTerminal(page);
        await typeHumanText(page, historyText);
        await waitForShellComposerText(page, commandText, options.timeoutMs);
        const composedText = await readShellComposerText(page);
        const composedScreenshot = path.join(
          artifacts.dir,
          "shell-prompt-composed.png",
        );
        await captureStep(
          page,
          trace,
          "shell-prompt-composed",
          composedScreenshot,
        );

        await page.keyboard.press("Enter");
        await waitForTerminalText(page, marker, options.timeoutMs);
        await page.waitForTimeout(500);
        const afterText = await page.evaluate(() => window.tuiLab.text());
        const afterScreenshot = path.join(
          artifacts.dir,
          "shell-prompt-finished.png",
        );
        await captureStep(
          page,
          trace,
          "shell-prompt-finished",
          afterScreenshot,
        );
        const secondTurnSentinelsAfter = await page.evaluate(
          () =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length,
        );

        await page.keyboard.press("ArrowUp");
        await waitForShellComposerText(page, commandText, options.timeoutMs);
        const restoredComposer = await readShellComposerText(page);
        const restoredScreenshot = path.join(
          artifacts.dir,
          "shell-prompt-history-restored.png",
        );
        await captureStep(
          page,
          trace,
          "shell-prompt-history-restored",
          restoredScreenshot,
        );
        await page.keyboard.press("Control+U");

        const cancelCommand =
          process.platform === "win32"
            ? "Write-Output ('tui-shell-cancel-' + 'start'); Start-Sleep -Seconds 5; Set-Content -LiteralPath 'tui-shell-cancel-tail.txt' -Value 'forbidden'"
            : "printf 'tui-shell-cancel-%s\\n' start; sleep 5; printf forbidden > tui-shell-cancel-tail.txt";
        const cancelHistoryText = `!${cancelCommand}`;
        const cancelTailPath = path.join(
          artifacts.workspace,
          "tui-shell-cancel-tail.txt",
        );
        await focusTerminal(page);
        await typeHumanText(page, cancelHistoryText);
        await waitForShellComposerText(page, cancelCommand, options.timeoutMs);
        await page.keyboard.press("Enter");
        await waitForTerminalText(
          page,
          "esc interrupt",
          Math.min(options.timeoutMs, 10000),
        );
        const cancelStartedAt = Date.now();
        const cancelRunningText = await page.evaluate(() =>
          window.tuiLab.text(),
        );
        const cancelRunningScreenshot = path.join(
          artifacts.dir,
          "shell-prompt-cancel-running.png",
        );
        await captureStep(
          page,
          trace,
          "shell-prompt-cancel-running",
          cancelRunningScreenshot,
        );
        await page.keyboard.press("Escape");
        await waitForTerminalText(
          page,
          "Cancelled.",
          Math.min(options.timeoutMs, 10000),
        );
        const cancelElapsedMs = Date.now() - cancelStartedAt;
        await page.waitForTimeout(1500);
        const cancelledText = await page.evaluate(() => window.tuiLab.text());
        const cancelFinishedScreenshot = path.join(
          artifacts.dir,
          "shell-prompt-cancelled.png",
        );
        await captureStep(
          page,
          trace,
          "shell-prompt-cancelled",
          cancelFinishedScreenshot,
        );
        await page.waitForTimeout(5000);
        const cancelTailFileExists = existsSync(cancelTailPath);

        const recoveryCommand =
          process.platform === "win32"
            ? "Write-Output ('tui-shell-' + 'recovered')"
            : "printf 'tui-shell-%s\\n' recovered";
        const recoveryHistoryText = `!${recoveryCommand}`;
        const recoveryMarker = "tui-shell-recovered";
        await focusTerminal(page);
        await typeHumanText(page, recoveryHistoryText);
        await waitForShellComposerText(
          page,
          recoveryCommand,
          options.timeoutMs,
        );
        await page.keyboard.press("Enter");
        await waitForTerminalText(page, recoveryMarker, options.timeoutMs);
        await page.waitForTimeout(500);
        const recoveredText = await page.evaluate(() => window.tuiLab.text());
        const recoveryScreenshot = path.join(
          artifacts.dir,
          "shell-prompt-recovered.png",
        );
        await captureStep(
          page,
          trace,
          "shell-prompt-recovered",
          recoveryScreenshot,
        );
        const secondTurnSentinelsAfterAllShellCommands = await page.evaluate(
          () =>
            (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
              .length,
        );

        let inputHistoryEntries = [];
        let inputHistoryError;
        try {
          const inputHistoryPath = path.join(
            artifacts.configDir,
            "history",
            "input_history.jsonl",
          );
          inputHistoryEntries = (await readFile(inputHistoryPath, "utf8"))
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        } catch (error) {
          inputHistoryError = formatError(error);
        }
        const inputEvents = await page.evaluate(
          (start) => window.tuiLab.inputEvents().slice(start),
          inputStart,
        );
        shellPromptEvidence = {
          commandText,
          historyText,
          marker,
          composedText,
          afterText,
          restoredComposer,
          secondTurnSentinelsBefore,
          secondTurnSentinelsAfter,
          secondTurnSentinelsAfterAllShellCommands,
          cancelCommand,
          cancelHistoryText,
          cancelTailPath,
          cancelTailFileExists,
          cancelElapsedMs,
          cancelRunningText,
          cancelledText,
          recoveryCommand,
          recoveryHistoryText,
          recoveryMarker,
          recoveredText,
          inputHistoryEntries,
          inputHistoryError,
          inputEvents,
          expectedTool: process.platform === "win32" ? "PowerShell" : "bash",
          screenshots: {
            composed: composedScreenshot,
            finished: afterScreenshot,
            historyRestored: restoredScreenshot,
            cancelRunning: cancelRunningScreenshot,
            cancelled: cancelFinishedScreenshot,
            recovered: recoveryScreenshot,
          },
        };
      }

      const text = await page.evaluate(() => window.tuiLab.text());
      const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
      const hasScrollbar = await page.evaluate(() =>
        window.tuiLab.hasScrollbar(),
      );
      if (
        options.scenario === "lsp-diagnostics" ||
        options.scenario === "ocr-review" ||
        options.scenario === "subagent-trace" ||
        options.scenario === "orchestrate-control" ||
        options.scenario === "long-write" ||
        mode === "mention" ||
        mode === "paste" ||
        mode === "image-paste"
      ) {
        projectDir = await waitForProjectDirForSession(
          artifacts.configDir,
          sessionId,
          options.timeoutMs,
        );
        artifacts.projectDir = projectDir;
        artifacts.projectKey = path.basename(projectDir);
      }
      const historyEvidence =
        options.scenario === "lsp-diagnostics"
          ? await waitForHistoryEvidence(projectDir, {
              mustContain: [
                options.message,
                '<diagnostics source="lsp"',
                'server="pyright"',
                "reportArgumentType",
                "诊断 fixture",
              ],
              timeoutMs: Math.min(options.timeoutMs, 8000),
            })
          : options.scenario === "ocr-review"
            ? await waitForHistoryEvidence(projectDir, {
                mustContain: [
                  options.message,
                  "OpenCodeReview command:",
                  "ocr review",
                  "--preview",
                  "Exit status: exit code: 0",
                  "Preview:",
                  "tui-lab-ocr-review-final-sentinel",
                ],
                timeoutMs: Math.min(options.timeoutMs, 8000),
              })
            : options.scenario === "long-write"
              ? await waitForHistoryEvidence(projectDir, {
                  mustContain: [
                    options.message,
                    "line-0001:",
                    "line-0520:",
                    "tui-lab-long-write-deleted",
                    "tui-lab-long-write-final-sentinel",
                  ],
                  timeoutMs: Math.min(options.timeoutMs, 8000),
                })
              : mode === "inline"
                ? await waitForHistoryEvidence(projectDir, {
                    mustContain: [options.message],
                    timeoutMs: Math.min(options.timeoutMs, 8000),
                  })
                : mode === "mention"
                  ? await waitForHistoryEvidence(projectDir, {
                      mustContain: [mentionEvidence.mentionText],
                      timeoutMs: Math.min(options.timeoutMs, 8000),
                    })
                  : mode === "paste"
                    ? await waitForHistoryEvidence(projectDir, {
                        mustContain: [
                          pasteEvidence.smallPasted,
                          pasteEvidence.largePasted,
                        ],
                        timeoutMs: Math.min(options.timeoutMs, 8000),
                      })
                    : mode === "image-paste"
                      ? await waitForHistoryEvidence(projectDir, {
                          mustContain: [
                            "[Image #1]",
                            "describe the clipboard fixture",
                          ],
                          timeoutMs: Math.min(options.timeoutMs, 8000),
                        })
                      : await collectHistoryEvidence(projectDir);
      const requestEvidence =
        options.scenario === "lsp-diagnostics"
          ? await waitForRequestEvidence(artifacts.requestsDir, {
              mustContain: [
                '<diagnostics source="lsp"',
                'server="pyright"',
                "reportArgumentType",
                "诊断 fixture",
              ],
              timeoutMs: Math.min(options.timeoutMs, 8000),
            })
          : options.scenario === "ocr-review"
            ? await waitForRequestEvidence(artifacts.requestsDir, {
                mustContain: [
                  "OpenCodeReview command:",
                  "ocr review",
                  "--preview",
                  "Exit status: exit code: 0",
                  "Preview:",
                ],
                timeoutMs: Math.min(options.timeoutMs, 8000),
              })
            : mode === "inline"
              ? await waitForRequestEvidence(artifacts.requestsDir, {
                  mustContain: [options.message],
                  timeoutMs: Math.min(options.timeoutMs, 8000),
                })
              : mode === "image-paste"
                ? await waitForRequestEvidence(artifacts.requestsDir, {
                    mustContain: [
                      '"type": "image"',
                      '"media_type": "image/png"',
                    ],
                    timeoutMs: Math.min(options.timeoutMs, 8000),
                  })
                : options.scenario === "full-turn"
                  ? await waitForRequestEvidence(artifacts.requestsDir, {
                      mustContain: [
                        "tui-lab-tool-line-001",
                        "tui-lab-tool-line-420",
                      ],
                      timeoutMs: Math.min(options.timeoutMs, 8000),
                    })
                  : await collectRequestEvidence(artifacts.requestsDir);
      const liveSteerEvidence =
        mode === "two-turn" && options.steerAfterTool
          ? await collectLiveSteerRequestEvidence(
              artifacts.requestsDir,
              options.secondMessage,
            )
          : null;
      const subagentEvidence =
        options.scenario === "subagent-trace"
          ? await waitForSubagentEvidence(projectDir, {
              timeoutMs: Math.min(options.timeoutMs, 8000),
            })
          : null;
      if (mode === "targeted-subagent-steer" && targetedSteerEvidence) {
        targetedSteerEvidence.artifacts =
          await waitForTargetedSubagentSteerEvidence(projectDir, {
            targetAgentId: targetedSteerEvidence.targetAgentId,
            siblingAgentIds: targetedSteerEvidence.siblingAgentIds,
            sentinel: targetedSteerEvidence.sentinel,
            timeoutMs: Math.min(options.timeoutMs, 60_000),
          });
      }
      if (mode === "targeted-subagent-stop" && targetedStopEvidence) {
        targetedStopEvidence.artifacts =
          await waitForTargetedSubagentStopEvidence(projectDir, {
            targetAgentId: targetedStopEvidence.targetAgentId,
            siblingAgentIds: targetedStopEvidence.siblingAgentIds,
            timeoutMs: Math.min(options.timeoutMs, 60_000),
          });
      }
      const orchestrateControlEvidence =
        options.scenario === "orchestrate-control"
          ? await waitForOrchestrateControlEvidence(projectDir, sessionId, {
              timeoutMs: Math.min(options.timeoutMs, 12_000),
            })
          : null;
      const ptyLog = session.getPtyLog();
      const assertions = runAssertions({
        text,
        ptyLog,
        hasScrollbar,
        dimensions,
        trace,
        afterToolText,
        expandedToolText,
        toolExpansionInputEvents,
        scrollTopText,
        scrollBottomText,
        rapidPageScroll,
        fullScrollCycles,
        wheelScrollCycles,
        scrollbarDrag,
        scrollbarThumbStability,
        sustainedWheelScroll,
        mode,
        scenario: options.scenario,
        message: options.message,
        secondMessage: options.secondMessage,
        steerAfterTool: options.steerAfterTool,
        historyEvidence,
        requestEvidence,
        liveSteerEvidence,
        subagentEvidence,
        targetedSteerEvidence,
        targetedStopEvidence,
        orchestrateControlEvidence,
        clipboardEvidence,
        imagePasteEvidence,
        historySearchEvidence,
        mentionEvidence,
        pasteEvidence,
        shellPromptEvidence,
        inlineSurfaceEvidence,
      });
      await writeTextArtifact(artifacts.text, text);
      await writeTextArtifact(artifacts.ptyLog, ptyLog);
      await writeTextArtifact(
        artifacts.browserConsoleLog,
        formatBrowserConsole(browserConsole),
      );
      await writeJsonArtifact(artifacts.assertions, assertions);
      if (!assertions.ok) {
        const error = new Error(
          `TUI lab assertions failed: ${assertions.failed.join(", ")}`,
        );
        error.assertions = assertions;
        throw error;
      }
      return async (cleanupReport) => {
        await verifyRunContextIntegrity(artifacts, runContextRuntime());
        await writeJsonArtifact(artifacts.meta, {
          ok: true,
          mode,
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
          secondMessage:
            mode === "two-turn" ? options.secondMessage : undefined,
          scenario: options.scenario,
          sessionId,
          screenshots: {
            welcome: artifacts.welcomeScreenshot,
            afterEnter: artifacts.afterEnterScreenshot,
            streaming: artifacts.streamingScreenshot,
            afterTool: artifacts.afterToolScreenshot,
            afterToolExpanded: capturedArtifactPath(
              artifacts.afterToolExpandedScreenshot,
            ),
            afterFinal: artifacts.finalScreenshot,
            afterScrollbarDragBottom:
              artifacts.afterScrollbarDragBottomScreenshot,
            afterScrollTop: artifacts.afterScrollTopScreenshot,
            afterScrollBottom: artifacts.afterScrollBottomScreenshot,
            afterSecondMessage:
              mode === "two-turn"
                ? artifacts.afterSecondMessageScreenshot
                : undefined,
            afterSecondFinal:
              mode === "two-turn"
                ? artifacts.afterSecondFinalScreenshot
                : undefined,
            afterCopy: mode === "clipboard" ? clipboardScreenshot : undefined,
            ...(clipboardEvidence?.screenshots || {}),
            ...(imagePasteEvidence?.screenshots || {}),
            ...(historySearchEvidence?.screenshots || {}),
            ...(mentionEvidence?.screenshots || {}),
            ...(pasteEvidence?.screenshots || {}),
            ...(shellPromptEvidence?.screenshots || {}),
            ...(targetedSteerEvidence?.screenshots || {}),
          },
          afterToolExpandedScreenshot: capturedArtifactPath(
            artifacts.afterToolExpandedScreenshot,
          ),
          screenshot: artifacts.afterScrollTopScreenshot,
          text: artifacts.text,
          ptyLog: artifacts.ptyLog,
          browserConsoleLog: artifacts.browserConsoleLog,
          assertions: artifacts.assertions,
          requestsDir: artifacts.requestsDir,
          configHome: artifacts.configHome,
          configDir: artifacts.configDir,
          projectKey: artifacts.projectKey,
          projectDir,
          historyEvidence,
          requestEvidence,
          subagentEvidence,
          targetedSteerEvidence,
          orchestrateControlEvidence,
          clipboardEvidence,
          imagePasteEvidence,
          historySearchEvidence,
          mentionEvidence,
          pasteEvidence,
          shellPromptEvidence,
          inlineSurfaceEvidence,
          hasScrollbar,
          dimensions,
          trace,
          rapidPageScroll,
          fullScrollCycles,
          wheelScrollCycles,
          scrollbarDrag,
          scrollbarThumbStability,
          sustainedWheelScroll,
          cleanup: cleanupReport,
          ptyExit: session.getExitInfo(),
          ptyDiagnostics: session.getDiagnostics(),
        });
        console.log(
          JSON.stringify(
            {
              ok: true,
              mode,
              ...artifacts,
              hasScrollbar,
              dimensions,
              assertions,
            },
            null,
            2,
          ),
        );
      };
    },
    onSuccess: async (finalize, cleanupReport) => finalize(cleanupReport),
    captureBeforeCleanup: async () =>
      captureFailurePageEvidence({
        page,
        timeoutMs: 1000,
      }),
    onFailure: async (error, pageEvidence) =>
      writeFailureArtifacts({
        artifacts,
        runOptions,
        command,
        mode,
        session,
        page,
        browserConsole,
        trace,
        error,
        pageEvidence,
      }),
    cleanup: async () => {
      const steps = [];
      if (browser) {
        steps.push(
          await settleLifecycleStep("browser", () => browser.close(), 5000),
        );
      }
      if (session) {
        steps.push(
          await settleLifecycleStep("session", () => session.stop(), 5000),
        );
        const ptyExit = await settleLifecycleStep(
          "pty-exit",
          () => session.exitPromise,
          1000,
        );
        return {
          steps,
          ptyExitObserved: ptyExit.status === "completed",
          ptyExit: ptyExit.status === "completed" ? ptyExit.value : null,
        };
      }
      return { steps, ptyExitObserved: true, ptyExit: null };
    },
  });
}

async function runStreamingScrollbarScenario(options) {
  const artifacts = await createRunContext(
    options,
    "streaming-scrollbar",
    runContextRuntime(),
  );
  const runOptions = {
    ...options,
    scenario: "full-turn",
    streamDelayMs: options.streamDelayMs || 80,
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
  let context;
  let page;
  await writeStartMeta(artifacts, runOptions, command, "streaming-scrollbar");
  try {
    session = await startSession(runOptions);
    browser = await chromium.launch(browserLaunchOptions(options));
    const viewport = {
      width: Math.max(900, options.cols * 9 + 80),
      height: Math.max(640, options.rows * 18 + 80),
    };
    context = await browser.newContext({
      viewport,
      recordVideo: { dir: artifacts.dir, size: viewport },
    });
    page = await context.newPage();
    const video = page.video();
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
    await page.waitForTimeout(250);
    await captureStep(page, trace, "welcome", artifacts.welcomeScreenshot);

    await page.locator("#terminal").click();
    await typeHumanText(page, options.message);
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(120);
    await captureStep(
      page,
      trace,
      "after-enter",
      artifacts.afterEnterScreenshot,
    );
    // Collapsed tool output need not expose line-001; waiting for that hidden
    // row can miss the entire final stream. Observe the actual streamed region.
    await waitForTerminalText(page, "tui-lab-final-line-", options.timeoutMs);
    await captureStep(page, trace, "after-tool", artifacts.afterToolScreenshot);

    const streamingScrollbarDrag =
      await measureStreamingScrollbarDragDuringOutput(
        page,
        trace,
        artifacts,
        runOptions.streamDelayMs,
        options.dragDurationMs,
        options.dragSamples,
      );
    await waitForTerminalText(
      page,
      "tui-lab-final-sentinel",
      Math.min(options.timeoutMs, 20_000),
    );
    await page.waitForTimeout(250);
    await captureStep(page, trace, "after-final", artifacts.finalScreenshot);
    const releasedMouseMove = await measureReleasedMouseMoveStability(
      page,
      trace,
      artifacts,
    );
    const markerBeforeExpand = firstVisibleHistoryMarker(
      await page.evaluate(() => window.tuiLab.text()),
    );
    await page.keyboard.press("Alt+T");
    await page.waitForTimeout(300);
    const expandedText = await page.evaluate(() => window.tuiLab.text());
    await captureStep(
      page,
      trace,
      "streaming-scrollbar-tools-expanded",
      path.join(artifacts.dir, "streaming-scrollbar-tools-expanded.png"),
    );
    const wheelScrollCycles = await measureWheelScrollCycles(page, 3, 160);
    await page.keyboard.press("End");
    await page.waitForTimeout(200);
    const markerBeforeCollapse = firstVisibleHistoryMarker(
      await page.evaluate(() => window.tuiLab.text()),
    );
    await page.keyboard.press("Alt+T");
    await page.waitForTimeout(300);
    const collapsedText = await page.evaluate(() => window.tuiLab.text());
    const markerAfterCollapse = firstVisibleHistoryMarker(collapsedText);
    await captureStep(
      page,
      trace,
      "streaming-scrollbar-tools-collapsed",
      path.join(artifacts.dir, "streaming-scrollbar-tools-collapsed.png"),
    );
    const folding = {
      markerBeforeExpand,
      markerBeforeCollapse,
      markerAfterCollapse,
      expandedShowsAtLeast400ToolRows:
        expandedText.includes("tui-lab-tool-line-001") &&
        expandedText.includes("tui-lab-tool-line-420"),
      collapseStayedAtTail:
        collapsedText.includes("tui-lab-final-sentinel") &&
        (markerAfterCollapse?.score ?? -1) >=
          (markerBeforeCollapse?.score ?? -1),
    };

    const text = await page.evaluate(() => window.tuiLab.text());
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const assertions = runStreamingScrollbarAssertions({
      text,
      hasScrollbar,
      trace,
      streamingScrollbarDrag,
      releasedMouseMove,
      wheelScrollCycles,
      folding,
    });
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    await context.close();
    context = null;
    const rawVideo = await moveRecordedVideo(video, artifacts.recordingRaw);
    const compression = rawVideo
      ? compressVideo(rawVideo, artifacts.recordingVideo, options.videoFps)
      : {
          ok: false,
          skipped: true,
          reason: "Playwright did not produce a video",
        };
    const selectedVideo = compression.ok ? artifacts.recordingVideo : rawVideo;
    const extractedFrames = selectedVideo
      ? extractVideoFrames(
          selectedVideo,
          artifacts.recordingFramesDir,
          options.sampleFps,
        )
      : { ok: false, skipped: true, reason: "no video to sample" };
    await writeJsonArtifact(artifacts.meta, {
      ok: assertions.ok,
      mode: "streaming-scrollbar",
      command,
      cwd: repoRoot,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      description: artifacts.description,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      workspaceTemplate: artifacts.workspaceTemplate,
      message: options.message,
      scenario: runOptions.scenario,
      streamDelayMs: runOptions.streamDelayMs,
      screenshots: {
        welcome: artifacts.welcomeScreenshot,
        afterEnter: artifacts.afterEnterScreenshot,
        afterTool: artifacts.afterToolScreenshot,
        streamingScrollbarBeforeDrag:
          artifacts.streamingScrollbarBeforeDragScreenshot,
        streamingScrollbarTop: artifacts.streamingScrollbarTopScreenshot,
        streamingScrollbarBottom: artifacts.streamingScrollbarBottomScreenshot,
        afterFinal: artifacts.finalScreenshot,
        afterReleaseMouseMove: artifacts.afterReleaseMouseMoveScreenshot,
      },
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      rawVideo,
      compressedVideo: compression.ok ? artifacts.recordingVideo : undefined,
      compression,
      extractedFrames,
      recordingFramesDir: artifacts.recordingFramesDir,
      requestsDir: artifacts.requestsDir,
      configHome: artifacts.configHome,
      configDir: artifacts.configDir,
      projectKey: artifacts.projectKey,
      projectDir: artifacts.projectDir,
      streamingScrollbarDrag,
      releasedMouseMove,
      wheelScrollCycles,
      folding,
      hasScrollbar,
      dimensions,
      trace,
    });
    if (!assertions.ok) {
      const error = new Error(
        `TUI lab streaming-scrollbar assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "streaming-scrollbar",
          dir: artifacts.dir,
          assertions,
          streamingScrollbarDrag,
          releasedMouseMove,
          wheelScrollCycles,
          folding,
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
      mode: "streaming-scrollbar",
      session,
      page,
      browserConsole,
      trace,
      error,
    });
    throw error;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (session) {
      await session.stop();
    }
  }
}

async function runSessionMemoryCompactScenario(options) {
  const artifacts = await createRunContext(
    options,
    "session-memory-compact",
    runContextRuntime(),
  );
  await writeSessionMemoryCompactSettings(artifacts, artifacts.configHome);
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
  await writeStartMeta(
    artifacts,
    runOptions,
    command,
    "session-memory-compact",
  );
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
    await page.waitForTimeout(250);
    await captureStep(page, trace, "welcome", artifacts.welcomeScreenshot);

    const welcomeText = await page.evaluate(() => window.tuiLab.text());
    const sessionId = extractTuiSessionId(welcomeText);
    const memorySentinel = `SMC_SENTINEL_${sessionId}`;
    const oldMarker = `SMC_OLD_RAW_${sessionId}`;
    const recentMarker = `SMC_RECENT_TAIL_${sessionId}`;
    const probeMarker = `SMC_POST_COMPACT_PROBE_${sessionId}`;
    let projectDir = artifacts.projectDir;
    let transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    let sessionStatePath = path.join(projectDir, sessionId, "state.json");
    let summaryPath = path.join(
      projectDir,
      sessionId,
      "session-memory",
      "summary.md",
    );
    let llmHistoryDir = path.join(projectDir, sessionId, "llm-requests");

    await submitTerminalLine(page, `${oldMarker} first turn before compact`);
    await waitForTerminalTextCount(
      page,
      "tui-lab-final-sentinel",
      1,
      options.timeoutMs,
    );
    await captureStep(
      page,
      trace,
      "after-old-turn",
      artifacts.afterEnterScreenshot,
    );

    // Windows may canonicalize a mapped drive (for example Z:) to its UNC
    // target before deriving the project key. Discover the authoritative
    // directory from the session transcript instead of assuming that the
    // runner and the Rust process canonicalize paths identically.
    projectDir = await waitForProjectDirForSession(
      artifacts.configDir,
      sessionId,
      options.timeoutMs,
    );
    artifacts.projectDir = projectDir;
    artifacts.projectKey = path.basename(projectDir);
    transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    sessionStatePath = path.join(projectDir, sessionId, "state.json");
    summaryPath = path.join(
      projectDir,
      sessionId,
      "session-memory",
      "summary.md",
    );
    llmHistoryDir = path.join(projectDir, sessionId, "llm-requests");
    await mkdir(path.dirname(summaryPath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(summaryPath), 0o700);
    secureWindowsUserOnlyAcl(path.dirname(summaryPath), true);
    await writeFile(summaryPath, sessionMemoryCompactSummary(memorySentinel), {
      mode: 0o600,
    });
    await chmod(summaryPath, 0o600);
    secureWindowsUserOnlyAcl(summaryPath, false);

    const hugeRecentPayload =
      makeSessionMemoryCompactRecentPayload(recentMarker);
    for (let index = 1; index <= 5; index += 1) {
      await submitTerminalLine(
        page,
        `${recentMarker}_${index} ${hugeRecentPayload}`,
      );
      await waitForRequestCountAtLeast(
        artifacts.requestsDir,
        2 + index,
        options.timeoutMs,
      );
      await page.waitForTimeout(350);
    }
    await captureStep(
      page,
      trace,
      "after-recent-tail",
      artifacts.streamingScreenshot,
    );
    const requestCountBeforeCompact = await waitForStableRequestCount(
      artifacts.requestsDir,
    );

    await submitTerminalLine(page, "/compact");
    await waitForTerminalText(
      page,
      "Context compaction completed",
      options.timeoutMs,
    );
    await page.waitForTimeout(500);
    const requestCountAfterCompact = await waitForStableRequestCount(
      artifacts.requestsDir,
    );
    const afterCompactText = await page.evaluate(() => window.tuiLab.text());
    await captureStep(
      page,
      trace,
      "after-compact",
      artifacts.afterToolScreenshot,
    );

    const finalSentinelCountBeforeProbe = countOccurrences(
      await page.evaluate(() => window.tuiLab.text()),
      "tui-lab-final-sentinel",
    );
    await submitTerminalLine(page, probeMarker);
    await waitForRequestCountAtLeast(
      artifacts.requestsDir,
      requestCountAfterCompact + 1,
      options.timeoutMs,
    );
    await waitForTerminalTextCount(
      page,
      "tui-lab-final-sentinel",
      finalSentinelCountBeforeProbe + 1,
      options.timeoutMs,
    );
    await page.waitForTimeout(250);
    await captureStep(
      page,
      trace,
      "after-post-compact-probe",
      artifacts.finalScreenshot,
    );

    const text = await page.evaluate(() => window.tuiLab.text());
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const stateEvidence = await collectSessionMemoryCompactStateEvidence({
      projectDir,
      transcriptPath,
      sessionStatePath,
      summaryPath,
      oldMarker,
      recentMarker,
      memorySentinel,
    });
    const requestEvidence = await collectSessionMemoryCompactRequestEvidence({
      requestsDir: artifacts.requestsDir,
      llmHistoryDir,
      transcriptPath,
      oldMarker,
      recentMarker,
      memorySentinel,
      probeMarker,
    });
    const compactAssertions = runSessionMemoryCompactAssertions({
      text,
      afterCompactText,
      stateEvidence,
      requestEvidence,
      requestCountBeforeCompact,
      requestCountAfterCompact,
      finalSentinelCountBeforeProbe,
    });

    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, compactAssertions);
    if (!compactAssertions.ok) {
      const error = new Error(
        `Session memory compact assertions failed: ${compactAssertions.failed.join(", ")}`,
      );
      error.assertions = compactAssertions;
      throw error;
    }
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "session-memory-compact",
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
      sessionId,
      configHome: artifacts.configHome,
      configDir: artifacts.configDir,
      projectKey: artifacts.projectKey,
      projectDir,
      transcriptPath,
      sessionStatePath,
      summaryPath,
      llmHistoryDir,
      markers: {
        memorySentinel,
        oldMarker,
        recentMarker,
        probeMarker,
      },
      requestCountBeforeCompact,
      requestCountAfterCompact,
      afterCompactText,
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      screenshots: {
        welcome: artifacts.welcomeScreenshot,
        afterOldTurn: artifacts.afterEnterScreenshot,
        afterRecentTail: artifacts.streamingScreenshot,
        afterCompact: artifacts.afterToolScreenshot,
        afterPostCompactProbe: artifacts.finalScreenshot,
      },
      assertions: artifacts.assertions,
      stateEvidence,
      requestEvidence,
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
          mode: "session-memory-compact",
          runDir: artifacts.dir,
          sessionId,
          projectDir,
          transcriptPath,
          sessionStatePath,
          summaryPath,
          llmHistoryDir,
          requestCountBeforeCompact,
          requestCountAfterCompact,
          stateEvidence,
          requestEvidence,
          assertions: compactAssertions,
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
      mode: "session-memory-compact",
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

async function runSessionResumeScenario(options) {
  const artifacts = await createRunContext(
    options,
    "session-resume",
    runContextRuntime(),
  );
  const firstRequestsDir = path.join(artifacts.requestsDir, "first");
  const resumedRequestsDir = path.join(artifacts.requestsDir, "resumed");
  const baseRunOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    configHome: artifacts.configHome,
  };
  const command = defaultCommandString(baseRunOptions);
  const trace = [];
  const browserConsole = [];
  const beforeMarker = `WINDOWS_RESUME_BEFORE_${artifacts.runLabel}`;
  const afterMarker = `WINDOWS_RESUME_AFTER_${artifacts.runLabel}`;
  let session;
  let browser;
  let page;
  let firstPtyLog = "";
  let transcriptPath = "";
  let projectDir = artifacts.projectDir;
  let sessionId = "";
  await writeStartMeta(artifacts, baseRunOptions, command, "session-resume");
  try {
    browser = await chromium.launch(browserLaunchOptions(options));
    session = await startSession({
      ...baseRunOptions,
      requestsDir: firstRequestsDir,
    });
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
    const welcomeText = await page.evaluate(() => window.tuiLab.text());
    sessionId = extractTuiSessionId(welcomeText);
    await submitTerminalLine(page, beforeMarker);
    await waitForTerminalText(
      page,
      "tui-lab-final-sentinel",
      options.timeoutMs,
    );
    await captureStep(
      page,
      trace,
      "before-resume-source",
      artifacts.afterEnterScreenshot,
    );
    projectDir = await waitForProjectDirForSession(
      artifacts.configDir,
      sessionId,
      options.timeoutMs,
    );
    artifacts.projectDir = projectDir;
    artifacts.projectKey = path.basename(projectDir);
    transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    firstPtyLog = session.getPtyLog();
    await session.stop();
    session = null;
    await page.close();
    page = null;

    session = await startSession({
      ...baseRunOptions,
      requestsDir: resumedRequestsDir,
    });
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
    await submitTerminalLine(page, `/resume ${transcriptPath}`);
    await waitForTerminalText(page, "Resumed session from", options.timeoutMs);
    const resumeTailText = await page.evaluate(() => window.tuiLab.text());
    if (options.scenario === "orchestrate-control") {
      await pressRepeated(page, "PageUp", 16);
      await waitForTerminalText(
        page,
        "Paused.",
        Math.min(options.timeoutMs, 12_000),
      );
      await waitForTerminalText(
        page,
        "queue 1",
        Math.min(options.timeoutMs, 12_000),
      );
    }
    const resumeText = await page.evaluate(() => window.tuiLab.text());
    await captureStep(
      page,
      trace,
      "after-resume",
      artifacts.afterToolScreenshot,
    );
    if (options.scenario === "orchestrate-control") {
      await pressRepeated(page, "PageDown", 16);
    }
    await submitTerminalLine(page, afterMarker);
    await waitForTerminalText(
      page,
      "tui-lab-second-turn-sentinel",
      options.timeoutMs,
    );
    await captureStep(
      page,
      trace,
      "after-resumed-turn",
      artifacts.finalScreenshot,
    );

    const resumedText = await page.evaluate(() => window.tuiLab.text());
    const requestEvidence = await waitForRequestEvidence(resumedRequestsDir, {
      mustContain: [beforeMarker, afterMarker],
      timeoutMs: Math.min(options.timeoutMs, 8000),
    });
    let transcript = "";
    const transcriptDeadline = Date.now() + Math.min(options.timeoutMs, 8000);
    do {
      transcript = await readFile(transcriptPath, "utf8").catch(() => "");
      if (transcript.includes(afterMarker)) break;
      await sleep(150);
    } while (Date.now() < transcriptDeadline);
    const orchestrateControlEvidence =
      options.scenario === "orchestrate-control"
        ? await waitForOrchestrateControlEvidence(projectDir, sessionId, {
            timeoutMs: Math.min(options.timeoutMs, 12_000),
          })
        : null;

    const checks = [
      {
        name: "resume-command-confirmed",
        ok: resumeTailText.includes("Resumed session from"),
      },
      {
        name: "resume-renders-prior-assistant-output",
        ok: resumeTailText.includes("tui-lab-final-sentinel"),
      },
      {
        name: "resumed-turn-completes",
        ok: resumedText.includes("tui-lab-second-turn-sentinel"),
      },
      {
        name: "resumed-request-contains-prior-marker",
        ok: requestEvidence.hasAllRequired,
      },
      {
        name: "resumed-transcript-appends-new-marker",
        ok: transcript.includes(afterMarker),
      },
    ];
    if (options.scenario === "orchestrate-control") {
      checks.push(
        {
          name: "resumed-orchestrate-panel-restores-paused-state",
          ok: resumeText.includes("Paused.") && resumeText.includes("queue 1"),
        },
        {
          name: "resumed-orchestrate-sidecar-retains-control-and-delivery",
          ok: Boolean(orchestrateControlEvidence?.hasAllRequired),
          ...(orchestrateControlEvidence || {}),
        },
      );
    }
    const failed = checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
    const assertions = { ok: failed.length === 0, failed, checks };
    await writeTextArtifact(artifacts.text, resumedText);
    await writeTextArtifact(
      artifacts.ptyLog,
      `${firstPtyLog}\n\n--- resumed process ---\n\n${session.getPtyLog()}`,
    );
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `Session resume assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "session-resume",
      command,
      runId: artifacts.runId,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      configHome: artifacts.configHome,
      projectDir,
      sessionId,
      transcriptPath,
      firstRequestsDir,
      resumedRequestsDir,
      markers: { beforeMarker, afterMarker },
      requestEvidence,
      orchestrateControlEvidence,
      assertions: artifacts.assertions,
      trace,
      ptyExit: session.getExitInfo(),
      ptyDiagnostics: session.getDiagnostics(),
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "session-resume",
          runDir: artifacts.dir,
          sessionId,
          transcriptPath,
          requestEvidence,
          orchestrateControlEvidence,
          assertions,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFailureArtifacts({
      artifacts,
      runOptions: baseRunOptions,
      command,
      mode: "session-resume",
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

async function runStartupScenario(options) {
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

function quoteExternalEditorArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

async function waitForJsonValue(file, predicate, timeoutMs) {
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

async function runExternalEditorScenario(options) {
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

async function runRecordingScenario(options) {
  const scenarioDeadlineMs = Date.now() + options.timeoutMs;
  const cleanupReserveMs = Math.min(
    12000,
    Math.max(2000, Math.floor(options.timeoutMs / 5)),
  );
  const workDeadlineMs = scenarioDeadlineMs - cleanupReserveMs;
  const stage = (label, promise, deadlineMs = workDeadlineMs) =>
    withinAbsoluteDeadline(promise, deadlineMs, label);
  const cleanupTimeout = (capMs) =>
    Math.max(1, remainingDeadlineMs(scenarioDeadlineMs, {}, capMs));
  const artifacts = await stage(
    "recording run-context preparation",
    createRunContext(options, "record", runContextRuntime()),
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
  const timeline = {
    sampleFps: options.sampleFps,
    recordSeconds: options.recordSeconds,
    launchedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    events: [],
    samples: [],
  };
  let session;
  let browser;
  let context;
  let page;
  let stopSampling = false;
  let samplePromise = null;
  let cleanupFinished = false;
  let cleanupReport = null;
  try {
    await stage(
      "recording start metadata",
      writeStartMeta(artifacts, runOptions, command, "record"),
    );
    await stage(
      "recording artifact directories",
      Promise.all([
        mkdir(artifacts.recordingSamplesDir, { recursive: false, mode: 0o755 }),
        mkdir(artifacts.recordingFramesDir, { recursive: false, mode: 0o755 }),
      ]),
    );
    session = await stage(
      "recording PTY session startup",
      startSession(runOptions),
    );
    browser = await stage(
      "recording browser startup",
      chromium.launch(browserLaunchOptions(options)),
    );
    const viewport = {
      width: Math.max(900, options.cols * 9 + 80),
      height: Math.max(640, options.rows * 18 + 80),
    };
    context = await stage(
      "recording browser context startup",
      browser.newContext({
        viewport,
        recordVideo: {
          dir: artifacts.dir,
          size: viewport,
        },
      }),
    );
    page = await stage("recording page startup", context.newPage());
    const video = page.video();
    attachBrowserConsole(page, browserConsole);
    await stage("recording page navigation", page.goto(session.url));
    await stage(
      "recording terminal readiness",
      page.waitForFunction(() => window.tuiLab && window.tuiLab.ready, null, {
        timeout: options.timeoutMs,
      }),
    );

    const readyAtMs = Date.now();
    await stage(
      "recording welcome text",
      waitForTerminalText(page, "Welcome to KCoder!", options.timeoutMs),
    );
    timeline.events.push({
      name: "welcome",
      startupAtMs: Date.now() - readyAtMs,
      at: new Date().toISOString(),
    });
    await stage(
      "recording welcome capture",
      captureStep(page, trace, "welcome", artifacts.welcomeScreenshot),
    );

    if (options.sendMessage) {
      await stage(
        "recording message submission",
        (async () => {
          await page.locator("#terminal").click();
          await typeHumanText(page, options.message);
          await page.waitForTimeout(250);
          await page.keyboard.press("Enter");
        })(),
      );
      timeline.events.push({
        name: "message-submitted",
        at: new Date().toISOString(),
        message: options.message,
      });
      await stage(
        "recording after-enter capture",
        captureStep(page, trace, "after-enter", artifacts.afterEnterScreenshot),
      );
    }

    const startedAtMs = Date.now();
    const recordingDeadlineMs = Math.min(
      workDeadlineMs,
      startedAtMs + Math.round(options.recordSeconds * 1000),
    );
    timeline.startedAt = new Date(startedAtMs).toISOString();
    timeline.events.push({
      name: "recording-started",
      atMs: 0,
      at: timeline.startedAt,
    });
    samplePromise = collectRecordingTimelineSamples({
      page,
      artifacts,
      timeline,
      startedAtMs,
      options,
      shouldStop: () => stopSampling,
      runtime: { deadlineMs: recordingDeadlineMs },
    });

    await sleep(Math.max(0, recordingDeadlineMs - Date.now()));
    stopSampling = true;
    await stage(
      "recording timeline sampling",
      samplePromise,
      Math.min(workDeadlineMs, recordingDeadlineMs + 100),
    );
    samplePromise = null;
    timeline.finishedAt = new Date().toISOString();
    timeline.events.push({
      name: "recording-stopped",
      atMs: Date.now() - startedAtMs,
      at: timeline.finishedAt,
    });

    const [text, dimensions, hasScrollbar] = await stage(
      "recording final page evidence",
      Promise.all([
        page.evaluate(() => window.tuiLab.text()),
        page.evaluate(() => window.tuiLab.dimensions()),
        page.evaluate(() => window.tuiLab.hasScrollbar()),
      ]),
    );
    await stage(
      "recording final capture",
      captureStep(page, trace, "final", artifacts.finalScreenshot),
    );
    await stage(
      "recording evidence writes",
      Promise.all([
        writeTextArtifact(artifacts.text, text),
        writeTextArtifact(artifacts.ptyLog, session.getPtyLog()),
        writeTextArtifact(
          artifacts.browserConsoleLog,
          formatBrowserConsole(browserConsole),
        ),
        writeJsonArtifact(artifacts.recordingTimeline, timeline),
      ]),
    );

    const cleanupSteps = [];
    cleanupSteps.push(
      await settleLifecycleStep(
        "context",
        () => context.close(),
        cleanupTimeout(5000),
      ),
    );
    context = null;
    const rawVideo = await moveRecordedVideo(video, artifacts.recordingRaw, {
      deadlineMs: workDeadlineMs,
    });
    const mediaRuntime = { deadlineMs: workDeadlineMs };
    const compression = rawVideo
      ? compressVideo(
          rawVideo,
          artifacts.recordingVideo,
          options.videoFps,
          mediaRuntime,
        )
      : {
          ok: false,
          skipped: true,
          reason: "Playwright did not produce a video",
        };
    const selectedVideo = compression.ok ? artifacts.recordingVideo : rawVideo;
    const videoProbe = selectedVideo
      ? probeVideo(selectedVideo, mediaRuntime)
      : null;
    const extractedFrames = selectedVideo
      ? extractVideoFrames(
          selectedVideo,
          artifacts.recordingFramesDir,
          options.sampleFps,
          mediaRuntime,
        )
      : { ok: false, skipped: true, reason: "no video to sample" };

    cleanupSteps.push(
      await settleLifecycleStep(
        "browser",
        () => browser.close(),
        cleanupTimeout(5000),
      ),
    );
    browser = null;
    cleanupSteps.push(
      await settleLifecycleStep(
        "session",
        () => session.stop(),
        cleanupTimeout(5000),
      ),
    );
    const ptyExit = await settleLifecycleStep(
      "pty-exit",
      () => session.exitPromise,
      cleanupTimeout(1000),
    );
    cleanupReport = {
      steps: cleanupSteps,
      ptyExitObserved: ptyExit.status === "completed",
      ptyExit: ptyExit.status === "completed" ? ptyExit.value : null,
    };
    cleanupFinished = true;
    validateBrowserCleanup(cleanupReport);
    validateRecordingSuccess({
      timeline,
      rawVideo,
      compression,
      videoProbe,
      extractedFrames,
    });
    await stage(
      "recording artifact integrity",
      verifyRunContextIntegrity(artifacts, runContextRuntime()),
      scenarioDeadlineMs,
    );

    await stage(
      "recording success metadata",
      writeJsonArtifact(artifacts.meta, {
        ok: true,
        mode: "record",
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
        message: options.sendMessage ? options.message : undefined,
        sendMessage: options.sendMessage,
        scenario: options.scenario,
        recordSeconds: options.recordSeconds,
        sampleFps: options.sampleFps,
        videoFps: options.videoFps,
        screenshots: {
          welcome: artifacts.welcomeScreenshot,
          afterEnter: options.sendMessage
            ? artifacts.afterEnterScreenshot
            : undefined,
          final: artifacts.finalScreenshot,
        },
        rawVideo,
        video: selectedVideo,
        compressedVideo: compression.ok ? artifacts.recordingVideo : undefined,
        compression,
        videoProbe,
        extractedFrames,
        cleanup: cleanupReport,
        recordingTimeline: artifacts.recordingTimeline,
        recordingSamplesDir: artifacts.recordingSamplesDir,
        recordingFramesDir: artifacts.recordingFramesDir,
        text: artifacts.text,
        ptyLog: artifacts.ptyLog,
        browserConsoleLog: artifacts.browserConsoleLog,
        hasScrollbar,
        dimensions,
        trace,
        ptyExit: session.getExitInfo(),
        ptyDiagnostics: session.getDiagnostics(),
      }),
      scenarioDeadlineMs,
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "record",
          runDir: artifacts.dir,
          video: selectedVideo,
          rawVideo,
          recordingTimeline: artifacts.recordingTimeline,
          recordingSamplesDir: artifacts.recordingSamplesDir,
          recordingFramesDir: artifacts.recordingFramesDir,
          sampleCount: timeline.samples.length,
          extractedFrames,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    stopSampling = true;
    const pageEvidence = await captureFailurePageEvidence({
      page,
      failureScreenshot: artifacts.failureScreenshot,
      timeoutMs: cleanupTimeout(1000),
    });
    if (!cleanupFinished) {
      const cleanupSteps = [];
      if (samplePromise) {
        cleanupSteps.push(
          await settleLifecycleStep(
            "recording-samples",
            () => samplePromise,
            cleanupTimeout(1000),
          ),
        );
        samplePromise = null;
      }
      if (context) {
        cleanupSteps.push(
          await settleLifecycleStep(
            "context",
            () => context.close(),
            cleanupTimeout(5000),
          ),
        );
        context = null;
      }
      if (browser) {
        cleanupSteps.push(
          await settleLifecycleStep(
            "browser",
            () => browser.close(),
            cleanupTimeout(5000),
          ),
        );
        browser = null;
      }
      let ptyExitObserved = !session;
      let ptyExit = null;
      if (session) {
        cleanupSteps.push(
          await settleLifecycleStep(
            "session",
            () => session.stop(),
            cleanupTimeout(5000),
          ),
        );
        const exitOutcome = await settleLifecycleStep(
          "pty-exit",
          () => session.exitPromise,
          cleanupTimeout(1000),
        );
        ptyExitObserved = exitOutcome.status === "completed";
        ptyExit = ptyExitObserved ? exitOutcome.value : null;
      }
      cleanupReport = { steps: cleanupSteps, ptyExitObserved, ptyExit };
      cleanupFinished = true;
    }
    error.cleanup = cleanupReport;
    await writeFailureArtifacts({
      artifacts,
      runOptions,
      command,
      mode: "record",
      session,
      page,
      browserConsole,
      trace,
      error,
      pageEvidence,
    });
    throw error;
  } finally {
    stopSampling = true;
    if (!cleanupFinished && context) {
      await settleLifecycleStep(
        "context",
        () => context.close(),
        cleanupTimeout(5000),
      );
      context = null;
    }
    if (!cleanupFinished && browser) {
      await settleLifecycleStep(
        "browser",
        () => browser.close(),
        cleanupTimeout(5000),
      );
      browser = null;
    }
    if (!cleanupFinished && session) {
      await settleLifecycleStep(
        "session",
        () => session.stop(),
        cleanupTimeout(5000),
      );
    }
  }
}

function scenarioToolNeedle(scenario) {
  if (scenario === "orchestrate") {
    return "README.md";
  }
  if (scenario === "orchestrate-control") {
    return "ControlAgent";
  }
  if (scenario === "lsp-diagnostics") {
    return "reportArgumentType";
  }
  if (scenario === "ocr-review") {
    return "OpenCodeReview command:";
  }
  if (scenario === "subagent-trace") {
    return "output_file";
  }
  if (scenario === "mixed-tools") {
    return "sample workspace file edited by mixed tool scenario";
  }
  return "tui-lab-tool-line-001";
}

function scenarioFinalNeedle(scenario) {
  if (scenario === "long-write") {
    return "tui-lab-long-write-final-sentinel";
  }
  if (scenario === "orchestrate-control") {
    return "tui-lab-orchestrate-control-final-sentinel";
  }
  return "tui-lab-final-sentinel";
}

async function runSlashOverlayScenario(options) {
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

async function runSlashAfterHistoryScenario(options) {
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

async function runResizeVisualScenario(options) {
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

async function runGoalCommandScenario(options) {
  // This scenario asserts the complete lifecycle footer. Compact-width behavior
  // is covered separately by resize-visual and slash-overlay.
  options = { ...options, cols: Math.max(options.cols, 180) };
  const artifacts = await createRunContext(
    options,
    "goal-command",
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
  const submitGoalLine = async (page, text) => {
    await page.evaluate(() => window.tuiLab.focus());
    await typeHumanText(page, text);
    await page.waitForTimeout(120);
    await page.evaluate(() => window.tuiLab.sendInput("\r"));
  };
  const screenshots = {
    slashGoal: path.join(artifacts.dir, "slash-goal-filter.png"),
    invalidBudget: path.join(artifacts.dir, "goal-invalid-budget.png"),
    goalRunning: path.join(artifacts.dir, "goal-running.png"),
    goalPaused: path.join(artifacts.dir, "goal-paused.png"),
    answerRunning: path.join(artifacts.dir, "goal-pro-answer-running.png"),
    answerStatus: path.join(artifacts.dir, "goal-pro-answer-status.png"),
  };
  await writeStartMeta(artifacts, runOptions, command, "goal-command");
  try {
    session = await startSession(runOptions);
    browser = await chromium.launch(browserLaunchOptions(options));
    page = await browser.newPage({
      viewport: {
        width: Math.max(900, options.cols * 9 + 80),
        height: Math.max(560, options.rows * 18 + 80),
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

    const removedCommand = `/${"lo"}${"op"}`;
    await typeHumanText(page, removedCommand);
    await waitForComposerText(page, removedCommand, options.timeoutMs);
    stageTexts.legacyGoalAbsent = await page.evaluate(() =>
      window.tuiLab.text(),
    );
    await page.keyboard.press("Control+U");
    await page.waitForTimeout(200);

    await page.keyboard.insertText("/");
    await page.waitForTimeout(150);
    await typeHumanText(page, "goal");
    await waitForComposerText(page, "/goal", options.timeoutMs);
    await captureStep(page, trace, "slash-goal-filter", screenshots.slashGoal);
    stageTexts.slashGoal = await page.evaluate(() => window.tuiLab.text());
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+U");
    await page.waitForTimeout(200);

    await typeHumanText(page, "/goal --budget");
    await page.waitForTimeout(350);
    await page.keyboard.press("Enter");
    await waitForTerminalText(page, "Usage: /goal", options.timeoutMs);
    await page.waitForTimeout(250);
    await captureStep(
      page,
      trace,
      "goal-invalid-budget",
      screenshots.invalidBudget,
    );
    stageTexts.invalidBudget = await page.evaluate(() => window.tuiLab.text());

    await typeHumanText(
      page,
      "/goal --budget 50000 验证长任务体验，持续检查状态、滚动和停止方式。",
    );
    await page.waitForTimeout(350);
    await page.keyboard.press("Enter");
    await waitForTerminalText(
      page,
      "Goal started (budget: 50000 tokens)",
      options.timeoutMs,
    );
    await waitForTerminalTextPattern(
      page,
      "Goal running turn \\d+",
      options.timeoutMs,
    );
    stageTexts.goalTurnObserved = "Goal running turn observed by terminal wait";
    stageTexts.goalTurn = await page.evaluate(() => window.tuiLab.text());
    await page.waitForTimeout(500);
    await captureStep(page, trace, "goal-running", screenshots.goalRunning);
    stageTexts.goalRunning = await page.evaluate(() => window.tuiLab.text());

    // Focus without clicking transcript cells: a click creates a selection,
    // whose Escape handler intentionally clears selection before pausing.
    await page.evaluate(() => window.tuiLab.focus());
    await page.keyboard.press("Escape");
    await waitForTerminalText(page, "Goal paused", options.timeoutMs);
    await page.waitForTimeout(250);
    await captureStep(page, trace, "goal-paused", screenshots.goalPaused);
    stageTexts.goalPaused = await page.evaluate(() => window.tuiLab.text());

    // The pause notice appears before the foreground turn fully exits; a new session prevents the Answer command from entering the follow-up queue.
    const restartSteps = [];
    restartSteps.push(
      await settleLifecycleStep("restart-browser", () => browser.close(), 5000),
    );
    restartSteps.push(
      await settleLifecycleStep("restart-session", () => session.stop(), 5000),
    );
    const restartPtyExit = await settleLifecycleStep(
      "restart-pty-exit",
      () => session.exitPromise,
      1000,
    );
    const restartCleanup = {
      steps: restartSteps,
      ptyExitObserved: restartPtyExit.status === "completed",
      ptyExit:
        restartPtyExit.status === "completed" ? restartPtyExit.value : null,
    };
    validateBrowserCleanup(restartCleanup);
    browser = null;
    session = null;
    session = await startSession({
      ...runOptions,
      streamDelayMs: Math.max(runOptions.streamDelayMs || 0, 80),
    });
    browser = await chromium.launch(browserLaunchOptions(options));
    page = await browser.newPage({
      viewport: {
        width: Math.max(900, options.cols * 9 + 80),
        height: Math.max(560, options.rows * 18 + 80),
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
    await submitGoalLine(
      page,
      "/goal-pro --answer --budget 50000 审核最终研究结论并输出可复核报告。",
    );
    await waitForTerminalTextPattern(
      page,
      "Goal Pro running turn \\d+",
      options.timeoutMs,
    );
    stageTexts.answerRunning = await page.evaluate(() => window.tuiLab.text());
    await captureStep(
      page,
      trace,
      "goal-pro-answer-running",
      screenshots.answerRunning,
    );
    // Focus without clicking transcript cells: a click creates a selection,
    // whose Escape handler intentionally clears selection before pausing.
    await page.evaluate(() => window.tuiLab.focus());
    await page.keyboard.press("Escape");
    await waitForTerminalText(page, "/goal-pro resume", options.timeoutMs);
    // The pause notice precedes foreground-task cleanup; allow time for slash commands to return to the direct execution path.
    await page.waitForTimeout(2000);
    await submitGoalLine(page, "/goal-pro status");
    await waitForTerminalText(page, "verification=answer", options.timeoutMs);
    await captureStep(
      page,
      trace,
      "goal-pro-answer-status",
      screenshots.answerStatus,
    );
    stageTexts.answerStatus = await page.evaluate(() => window.tuiLab.text());

    const text = await page.evaluate(() => window.tuiLab.text());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const assertions = runGoalCommandAssertions({ stageTexts, text });
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `TUI goal-command assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    const ptyDiagnostics = session.getDiagnostics();
    const cleanupSteps = [];
    cleanupSteps.push(
      await settleLifecycleStep("browser", () => browser.close(), 5000),
    );
    browser = null;
    const completedSession = session;
    cleanupSteps.push(
      await settleLifecycleStep("session", () => completedSession.stop(), 5000),
    );
    const ptyExit = await settleLifecycleStep(
      "pty-exit",
      () => completedSession.exitPromise,
      1000,
    );
    const cleanup = {
      steps: cleanupSteps,
      ptyExitObserved: ptyExit.status === "completed",
      ptyExit: ptyExit.status === "completed" ? ptyExit.value : null,
    };
    validateBrowserCleanup(cleanup);
    session = null;
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "goal-command",
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
      screenshots,
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      hasScrollbar,
      dimensions,
      trace,
      stageTexts,
      restartCleanup,
      cleanup,
      ptyExit: cleanup.ptyExit,
      ptyDiagnostics,
    });
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "goal-command",
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
      mode: "goal-command",
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

async function writeStartMeta(artifacts, runOptions, command, mode) {
  await writeJsonArtifact(artifacts.startMeta, {
    ok: null,
    mode,
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
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
    configDir: artifacts.configDir,
    projectKey: artifacts.projectKey,
    projectDir: artifacts.projectDir,
    message: runOptions.message,
    secondMessage: mode === "two-turn" ? runOptions.secondMessage : undefined,
    scenario: runOptions.scenario,
    cols: runOptions.cols,
    rows: runOptions.rows,
    timeoutMs: runOptions.timeoutMs,
    browserLaunch: browserLaunchOptions(runOptions),
    recordSeconds: mode === "record" ? runOptions.recordSeconds : undefined,
    sampleFps: mode === "record" ? runOptions.sampleFps : undefined,
    videoFps: mode === "record" ? runOptions.videoFps : undefined,
    sendMessage: mode === "record" ? runOptions.sendMessage : undefined,
    startedAt: new Date().toISOString(),
    hostPlatform: platformDescription(process.platform, process.env),
  });
}

async function runHistoryScrollbarScenario(options) {
  const artifacts = await createRunContext(
    options,
    "history-scrollbar",
    runContextRuntime(),
  );
  const candidates = [options.historyPath, options.fallbackHistoryPath].filter(
    Boolean,
  );
  const selectedHistory = candidates
    .map((candidate) =>
      path.isAbsolute(candidate)
        ? candidate
        : path.resolve(process.cwd(), candidate),
    )
    .find((candidate) => existsSync(candidate));
  if (!selectedHistory) {
    throw new Error(
      `no readable history file found from candidates: ${candidates.join(", ") || "<none>"}`,
    );
  }
  const selectedWorkspace = options.historyWorkspacePath
    ? path.isAbsolute(options.historyWorkspacePath)
      ? options.historyWorkspacePath
      : path.resolve(process.cwd(), options.historyWorkspacePath)
    : artifacts.workspace;
  if (!existsSync(selectedWorkspace)) {
    throw new Error(`history workspace does not exist: ${selectedWorkspace}`);
  }

  const runOptions = {
    ...options,
    scenario: "full-turn",
    runDir: artifacts.dir,
    workspaceDir: selectedWorkspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const command = defaultCommandString(runOptions);
  const trace = [];
  const browserConsole = [];
  let session;
  let browser;
  let context;
  let page;
  await writeStartMeta(artifacts, runOptions, command, "history-scrollbar");
  try {
    session = await startSession(runOptions);
    browser = await chromium.launch(browserLaunchOptions(options));
    const viewport = {
      width: Math.max(900, options.cols * 9 + 80),
      height: Math.max(640, options.rows * 18 + 80),
    };
    context = await browser.newContext({
      viewport,
      recordVideo: {
        dir: artifacts.dir,
        size: viewport,
      },
    });
    page = await context.newPage();
    const video = page.video();
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
    await page.waitForTimeout(250);
    await captureStep(page, trace, "welcome", artifacts.welcomeScreenshot);

    await page.locator("#terminal").click();
    await typeHumanText(page, `/resume ${selectedHistory} `);
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    const resumeFinished = () => {
      const text = window.tuiLab?.text() || "";
      return (
        text.includes("Resumed session from") ||
        text.includes("Failed to preflight session")
      );
    };
    let resumeResult;
    try {
      resumeResult = await waitForTextMatch(page, resumeFinished, 5000);
    } catch {
      await page.keyboard.press("Enter");
      resumeResult = await waitForTextMatch(
        page,
        resumeFinished,
        options.timeoutMs,
      );
    }
    if (resumeResult.text.includes("Failed to preflight session")) {
      throw new Error(
        `TUI history resume preflight failed: ${resumeResult.text.trim()}`,
      );
    }
    await page.waitForTimeout(300);
    const resumeText = resumeResult.text;
    await captureStep(
      page,
      trace,
      "after-resume",
      artifacts.afterScrollBottomScreenshot,
    );
    await page.keyboard.press("Alt+T");
    await page.waitForTimeout(300);
    await captureStep(
      page,
      trace,
      "history-scrollbar-tools-expanded",
      path.join(artifacts.dir, "history-scrollbar-tools-expanded.png"),
    );

    const wheelFromTail = await measureWheelFromTailSamples(
      page,
      trace,
      artifacts,
      "history-scrollbar-wheel-from-tail",
    );
    const normalWheelToBounds = await measureNormalWheelToBounds(
      page,
      trace,
      artifacts,
      "history-scrollbar-normal-wheel",
    );
    const heldDrag = await measureHeldScrollbarDragSamples(
      page,
      trace,
      artifacts,
      "history-scrollbar-held-drag",
      {
        sampleCount: options.dragSamples,
        dragDurationMs: options.dragDurationMs,
      },
    );
    const releasedMove = await measureReleasedMouseMoveDetailed(
      page,
      trace,
      artifacts,
      "history-scrollbar-released-move",
    );

    const text = await page.evaluate(() => window.tuiLab.text());
    const dimensions = await page.evaluate(() => window.tuiLab.dimensions());
    const hasScrollbar = await page.evaluate(() =>
      window.tuiLab.hasScrollbar(),
    );
    const assertions = runHistoryScrollbarAssertions({
      resumeText,
      wheelFromTail,
      normalWheelToBounds,
      heldDrag,
      releasedMove,
    });
    await writeTextArtifact(artifacts.text, text);
    await writeTextArtifact(artifacts.ptyLog, session.getPtyLog());
    await writeTextArtifact(
      artifacts.browserConsoleLog,
      formatBrowserConsole(browserConsole),
    );
    await writeJsonArtifact(artifacts.assertions, assertions);

    await context.close();
    context = null;
    const rawVideo = await moveRecordedVideo(video, artifacts.recordingRaw);
    const compression = rawVideo
      ? compressVideo(rawVideo, artifacts.recordingVideo, options.videoFps)
      : {
          ok: false,
          skipped: true,
          reason: "Playwright did not produce a video",
        };
    const selectedVideo = compression.ok ? artifacts.recordingVideo : rawVideo;
    const extractedFrames = selectedVideo
      ? extractVideoFrames(
          selectedVideo,
          artifacts.recordingFramesDir,
          options.sampleFps,
        )
      : { ok: false, skipped: true, reason: "no video to sample" };
    await browser.close();
    browser = null;

    await writeJsonArtifact(artifacts.meta, {
      ok: assertions.ok,
      mode: "history-scrollbar",
      command,
      cwd: repoRoot,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      selectedHistory,
      candidates,
      resumeTextSample: textSignature(resumeText),
      runDir: artifacts.dir,
      workspace: selectedWorkspace,
      artifactWorkspace: artifacts.workspace,
      screenshots: {
        welcome: artifacts.welcomeScreenshot,
        afterResume: artifacts.afterScrollBottomScreenshot,
        ...heldDrag.screenshots,
        ...releasedMove.screenshots,
      },
      text: artifacts.text,
      ptyLog: artifacts.ptyLog,
      browserConsoleLog: artifacts.browserConsoleLog,
      assertions: artifacts.assertions,
      rawVideo,
      compressedVideo: compression.ok ? artifacts.recordingVideo : undefined,
      compression,
      extractedFrames,
      recordingFramesDir: artifacts.recordingFramesDir,
      wheelFromTail,
      normalWheelToBounds,
      heldDrag,
      releasedMove,
      hasScrollbar,
      dimensions,
      trace,
    });
    console.log(
      JSON.stringify(
        {
          ok: assertions.ok,
          mode: "history-scrollbar",
          dir: artifacts.dir,
          selectedHistory,
          assertions,
          wheelFromTail: {
            firstEventChanged: wheelFromTail.firstEventChanged,
            changedEvents: wheelFromTail.changedEvents,
            firstChangedEvent: wheelFromTail.firstChangedEvent,
          },
          normalWheelToBounds,
          heldDrag: {
            contentChangedWhileHeld: heldDrag.contentChangedWhileHeld,
            thumbMovedWhileHeld: heldDrag.thumbMovedWhileHeld,
            thumbHeightDeltaRows: heldDrag.thumbHeightDeltaRows,
            afterUpThumbJumpRows: heldDrag.afterUpThumbJumpRows,
          },
          releasedMove: {
            stable: releasedMove.stable,
            uniqueSignatures: releasedMove.uniqueSignatures,
            thumbTopDeltaRows: releasedMove.thumbTopDeltaRows,
            thumbHeightDeltaRows: releasedMove.thumbHeightDeltaRows,
          },
        },
        null,
        2,
      ),
    );
    if (!assertions.ok) {
      const error = new Error(
        `TUI lab history-scrollbar assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
  } catch (error) {
    await writeFailureArtifacts({
      error,
      artifacts,
      runOptions,
      command,
      mode: "history-scrollbar",
      trace,
      session,
      browserConsole,
      page,
    });
    throw error;
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (session) {
      await session.stop().catch(() => {});
    }
  }
}

function runHistoryScrollbarAssertions({
  resumeText,
  wheelFromTail,
  normalWheelToBounds,
  heldDrag,
  releasedMove,
}) {
  const checks = [];
  const add = (name, ok, detail = {}) =>
    checks.push({ name, ok: Boolean(ok), ...detail });
  add("history-resumed", resumeText.includes("Resumed session from"), {
    resumeTextSample: textSignature(resumeText),
  });
  add(
    "first-wheel-event-leaves-tail-immediately",
    wheelFromTail?.firstEventChanged,
    wheelFromTail || {},
  );
  add(
    "normal-wheel-reaches-400-line-history-top",
    normalWheelToBounds?.up?.reached,
    normalWheelToBounds || {},
  );
  add(
    "normal-wheel-returns-to-history-tail",
    normalWheelToBounds?.down?.reached,
    normalWheelToBounds || {},
  );
  add(
    "held-drag-content-updates-before-mouseup",
    heldDrag?.contentChangedWhileHeld,
    heldDrag || {},
  );
  add(
    "held-drag-thumb-moves-before-mouseup",
    heldDrag?.thumbMovedWhileHeld,
    heldDrag || {},
  );
  add(
    "held-drag-thumb-height-stable",
    (heldDrag?.thumbHeightDeltaRows ?? 999) === 0,
    heldDrag || {},
  );
  add(
    "mouseup-does-not-cause-large-thumb-jump",
    (heldDrag?.afterUpThumbJumpRows ?? 999) <= 2,
    heldDrag || {},
  );
  add(
    "released-mouse-move-does-not-jump",
    releasedMove?.stable,
    releasedMove || {},
  );
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
  };
}

function runStreamingScrollbarAssertions({
  text,
  hasScrollbar,
  trace,
  streamingScrollbarDrag,
  releasedMouseMove,
  wheelScrollCycles,
  folding,
}) {
  const checks = [];
  const add = (name, ok, detail = {}) =>
    checks.push({ name, ok: Boolean(ok), ...detail });

  add("screen-text-has-no-ansi-esc", !/\x1b/.test(text));
  add(
    "final-sentinel-present-after-stream",
    text.includes("tui-lab-final-sentinel"),
  );
  add("host-terminal-scrollback-not-required", hasScrollbar === false, {
    hasScrollbar,
  });
  add(
    "streaming-scrollbar-started-before-final-sentinel",
    Boolean(streamingScrollbarDrag?.startedBeforeFinalSentinel),
    streamingScrollbarDrag || {},
  );
  add(
    "streaming-scrollbar-had-live-samples-before-final",
    Boolean(streamingScrollbarDrag?.samplesBeforeFinalSentinel >= 1),
    streamingScrollbarDrag || {},
  );
  add(
    "streaming-scrollbar-top-reached-while-streaming",
    Boolean(streamingScrollbarDrag?.topReached),
    streamingScrollbarDrag || {},
  );
  add(
    "streaming-scrollbar-thumb-contiguous-during-drag",
    Boolean(
      streamingScrollbarDrag?.samplesWithScrollbar >= 4 &&
      streamingScrollbarDrag?.contiguousThumbDuringDrag,
    ),
    streamingScrollbarDrag || {},
  );
  add(
    "streaming-scrollbar-stays-in-one-terminal-column",
    Boolean(
      streamingScrollbarDrag?.samplesWithScrollbar >= 4 &&
      streamingScrollbarDrag?.singleColumnRailDuringDrag,
    ),
    streamingScrollbarDrag || {},
  );
  add(
    "streaming-scrollbar-drag-returned-to-live-tail",
    Boolean(streamingScrollbarDrag?.returnedToLiveTail),
    streamingScrollbarDrag || {},
  );
  add(
    "resize-during-drag-was-exercised",
    Boolean(streamingScrollbarDrag?.resizedDuringDrag),
    streamingScrollbarDrag || {},
  );
  add(
    "resize-during-drag-kept-visible-anchor",
    Boolean(streamingScrollbarDrag?.resizeKeptVisibleAnchor),
    streamingScrollbarDrag || {},
  );
  add(
    "released-mouse-move-keeps-transcript-stable",
    Boolean(
      releasedMouseMove?.sameText &&
      releasedMouseMove?.sameMarker &&
      releasedMouseMove?.sameThumbRows &&
      releasedMouseMove?.sameThumbRuns,
    ),
    releasedMouseMove || {},
  );
  add(
    "expanded-400-line-history-wheel-reaches-top",
    Boolean(wheelScrollCycles?.allReachedTop),
    wheelScrollCycles || {},
  );
  add(
    "expanded-400-line-history-wheel-returns-to-tail",
    Boolean(wheelScrollCycles?.allReturnedToTail),
    wheelScrollCycles || {},
  );
  add(
    "alt-t-collapse-keeps-tail-stable",
    Boolean(folding?.collapseStayedAtTail),
    folding || {},
  );
  for (const name of [
    "streaming-scrollbar-before-drag",
    "streaming-scrollbar-top",
    "streaming-scrollbar-bottom",
    "streaming-scrollbar-resize-during-drag",
    "streaming-scrollbar-tools-expanded",
    "streaming-scrollbar-tools-collapsed",
    "after-final",
    "after-release-mouse-move",
  ]) {
    add(
      `trace-${name}-captured`,
      trace.some((entry) => entry.name === name),
    );
  }

  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
  };
}

function runStartupAssertions({ text, trace }) {
  const checks = [];
  const add = (name, ok, detail = {}) =>
    checks.push({ name, ok: Boolean(ok), ...detail });
  const counts = {
    title: countOccurrences(text, "Welcome to KCoder!"),
    topBorder: countOccurrences(text, "╭"),
    bottomBorder: countOccurrences(text, "╰"),
    composer: countOccurrences(text, "Ask KCoder"),
    footer: countOccurrences(text, "? for shortcuts"),
  };
  add("screen-text-has-no-ansi-esc", !/\x1b/.test(text));
  add("welcome-title-visible-once", counts.title === 1, {
    count: counts.title,
  });
  add("welcome-top-border-visible-once", counts.topBorder === 1, {
    count: counts.topBorder,
  });
  add("welcome-bottom-border-visible-once", counts.bottomBorder === 1, {
    count: counts.bottomBorder,
  });
  const welcomeBlock = findWelcomeBlock(text);
  add("welcome-card-contiguous", welcomeBlock.contiguous, welcomeBlock.detail);
  for (const label of ["Directory:", "Session:", "Model:", "Version:"]) {
    add(
      `welcome-metadata-${label.toLowerCase().replace(":", "")}`,
      text.includes(label),
    );
  }
  add("composer-visible-once", counts.composer === 1, {
    count: counts.composer,
  });
  add("footer-visible-once", counts.footer === 1, { count: counts.footer });
  const geometry = visibleChromeGeometry(text);
  add(
    "fullscreen-composer-anchored-after-welcome",
    geometry.composerLine >= geometry.totalLines - 3,
    geometry,
  );
  add("footer-bottom-slack-bounded", geometry.footerBottomMaxBlankRun <= 5, {
    footerBottomBlankLines: geometry.footerBottomBlankLines,
    footerBottomMaxBlankRun: geometry.footerBottomMaxBlankRun,
    footerLine: geometry.footerLine,
    totalLines: geometry.totalLines,
  });
  if (trace) {
    add(
      "welcome-screenshot-captured",
      trace.some(
        (entry) =>
          entry.name === "welcome" &&
          entry.visualEvidenceValid &&
          entry.renderer === "webgl",
      ),
    );
  }
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
    counts,
  };
}

function findWelcomeBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("╭"));
  const end =
    start >= 0
      ? lines.findIndex((line, index) => index > start && line.includes("╰"))
      : -1;
  if (start < 0 || end < 0 || end <= start) {
    return {
      contiguous: false,
      detail: { start, end },
    };
  }
  const block = lines.slice(start, end + 1);
  const invalid = [];
  for (const [offset, line] of block.entries()) {
    const index = start + offset;
    const trimmed = line.trim();
    let ok;
    if (offset === 0) {
      ok = trimmed.includes("╭") && trimmed.includes("╮");
    } else if (offset === block.length - 1) {
      ok = trimmed.includes("╰") && trimmed.includes("╯");
    } else {
      ok = trimmed.startsWith("│") && trimmed.endsWith("│");
    }
    if (!ok) {
      invalid.push({ index, line: trimmed.slice(0, 160) });
    }
  }
  return {
    contiguous: invalid.length === 0,
    detail: {
      start,
      end,
      lineCount: block.length,
      invalid,
    },
  };
}

function runSlashOverlayAssertions({ stageTexts, trace }) {
  const checks = [];
  const add = (name, ok, detail = {}) =>
    checks.push({ name, ok: Boolean(ok), ...detail });
  const allText = Object.values(stageTexts).join("\n");
  add("screen-text-has-no-ansi-esc", !/\x1b/.test(allText));
  add(
    "slash-menu-visible",
    stageTexts.slashOpen?.includes("/quit") &&
      stageTexts.slashOpen?.includes("/new"),
  );
  add("slash-composer-visible", stageTexts.slashOpen?.includes("› /"));
  add("slash-query-visible", stageTexts.slashModelQuery?.includes("› /model"));
  add("model-picker-visible", stageTexts.modelPicker?.includes("Select Model"));
  add(
    "model-picker-clears-composer-band",
    !stageTexts.modelPicker?.includes("› Ask KCoder"),
  );
  add(
    "footer-shortcuts-visible",
    stageTexts.footerShortcuts?.includes("shortcuts") ||
      stageTexts.footerShortcuts?.includes("Shortcuts"),
  );
  for (const name of [
    "slash-open",
    "slash-model-query",
    "model-picker",
    "footer-shortcuts",
  ]) {
    add(
      `${name}-captured`,
      trace.some((entry) => entry.name === name),
    );
  }
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
  };
}

function runSlashAfterHistoryAssertions({
  text,
  beforeDimensions,
  dimensions,
}) {
  const checks = [];
  const add = (name, ok, detail = {}) =>
    checks.push({ name, ok: Boolean(ok), ...detail });
  const slashMenuRows = text
    .split("\n")
    .filter((line) =>
      /^\s*\/(?:quit|new|luna|init|clear|copy|raw|model)\s/.test(line),
    );
  const contaminatedSlashMenuRows = slashMenuRows.filter((line) =>
    /[^\x00-\x7f]/.test(line),
  );
  add("screen-text-has-no-ansi-esc", !/\x1b/.test(text));
  add(
    "slash-menu-visible-after-history",
    text.includes("/quit") && text.includes("/new"),
  );
  add(
    "slash-menu-rows-have-no-transcript-residue",
    slashMenuRows.length >= 8 && contaminatedSlashMenuRows.length === 0,
    {
      slashMenuRowCount: slashMenuRows.length,
      contaminatedRows: contaminatedSlashMenuRows,
    },
  );
  add("composer-slash-visible-after-history", text.includes("› /"));
  add("final-history-still-present", text.includes("tui-lab-final-sentinel"));
  add(
    "host-terminal-scrollback-not-required",
    dimensions.scrollHeight <= dimensions.clientHeight + 2,
    {
      scrollHeight: dimensions.scrollHeight,
      clientHeight: dimensions.clientHeight,
    },
  );
  add(
    "slash-does-not-grow-host-scrollback",
    dimensions.scrollHeight <= beforeDimensions.scrollHeight,
    {
      beforeScrollHeight: beforeDimensions.scrollHeight,
      afterScrollHeight: dimensions.scrollHeight,
    },
  );
  const maxScroll = Math.max(
    0,
    dimensions.scrollHeight - dimensions.clientHeight,
  );
  add("slash-keeps-terminal-at-bottom", dimensions.scrollTop >= maxScroll - 2, {
    scrollTop: dimensions.scrollTop,
    maxScroll,
  });
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
  };
}

function runGoalCommandAssertions({ stageTexts, text }) {
  const checks = [];
  const add = (name, ok, detail = {}) =>
    checks.push({ name, ok: Boolean(ok), ...detail });
  const allText = Object.values(stageTexts).join("\n");
  add("screen-text-has-no-ansi-esc", !/\x1b/.test(allText));
  add(
    "legacy-goal-command-has-no-menu-entry",
    !stageTexts.legacyGoalAbsent?.includes(
      `/${"lo"}${"op"}  Run a persistent objective`,
    ),
  );
  add(
    "slash-goal-filter-finds-command",
    stageTexts.slashGoal?.includes("/goal"),
  );
  add(
    "invalid-budget-shows-usage",
    stageTexts.invalidBudget?.includes("Usage: /goal"),
  );
  add(
    "invalid-budget-does-not-start-goal",
    !stageTexts.invalidBudget?.includes("Goal started"),
  );
  add(
    "goal-running-shows-turn-status",
    stageTexts.goalTurnObserved?.includes("Goal running turn observed") ||
      stageTexts.goalTurn?.includes("Goal running tu"),
  );
  add(
    "goal-running-shows-esc-pause-hint",
    stageTexts.goalRunning?.includes("Esc pauses") ||
      stageTexts.goalRunning?.toLowerCase().includes("esc interrupt"),
  );
  add(
    "goal-paused-uses-goal-resume",
    stageTexts.goalPaused?.includes("/goal resume"),
  );
  add(
    "goal-paused-footer-is-not-running",
    !stageTexts.goalPaused?.includes("Goal running turn"),
  );
  add(
    "goal-pro-answer-starts-in-strict-mode",
    stageTexts.answerRunning?.includes("Goal Pro running turn"),
  );
  add(
    "goal-pro-answer-status-shows-verification-kind",
    stageTexts.answerStatus?.includes("verification=answer"),
  );
  add("final-text-has-paused-goal", /Goal(?: Pro)? paused/.test(text));
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
  };
}

function terminalLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function blankLinesBetween(lines, start, end) {
  if (start < 0 || end < 0 || end <= start + 1) {
    return 0;
  }
  return lines.slice(start + 1, end).filter((line) => line.trim() === "")
    .length;
}

function maxBlankRunInLines(lines) {
  let max = 0;
  let current = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function visibleChromeGeometry(text) {
  const lines = terminalLines(text);
  const welcomeBottom = lines.findIndex((line) => line.includes("╰"));
  const composer = lines.findIndex((line) => line.includes("Ask KCoder"));
  const footer = lines.findIndex((line) => line.includes("? for shortcuts"));
  let previousContentBeforeComposer = composer - 1;
  while (
    previousContentBeforeComposer >= 0 &&
    lines[previousContentBeforeComposer].trim() === ""
  ) {
    previousContentBeforeComposer -= 1;
  }
  return {
    totalLines: lines.length,
    welcomeBottomLine: welcomeBottom >= 0 ? welcomeBottom + 1 : null,
    composerLine: composer >= 0 ? composer + 1 : null,
    footerLine: footer >= 0 ? footer + 1 : null,
    welcomeComposerBlankLines: blankLinesBetween(
      lines,
      welcomeBottom,
      composer,
    ),
    blankBeforeComposer: blankLinesBetween(
      lines,
      previousContentBeforeComposer,
      composer,
    ),
    footerBottomBlankLines:
      footer >= 0 ? lines.length - footer - 1 : Number.POSITIVE_INFINITY,
    footerBottomMaxBlankRun:
      footer >= 0
        ? maxBlankRunInLines(lines.slice(footer + 1))
        : Number.POSITIVE_INFINITY,
    maxBlankRun: maxConsecutiveBlankLines(text),
  };
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

function assertTmuxResizeChrome(text, stage, options = {}) {
  const { requireWelcome = true, requireSentinel = true } = options;
  const expectedOnce = ["Ask KCoder", "? for shortcuts"];
  if (requireWelcome) {
    expectedOnce.unshift("Welcome to KCoder!");
  }
  const counts = Object.fromEntries(
    expectedOnce.map((needle) => [needle, countOccurrences(text, needle)]),
  );
  const bad = Object.entries(counts).filter(([, count]) => count !== 1);
  if (bad.length > 0) {
    throw new Error(
      `tmux ${stage} resize capture has stale/missing live chrome: ${JSON.stringify(counts)}`,
    );
  }
  const blankRun = maxConsecutiveBlankLines(text);
  const geometry = visibleChromeGeometry(text);
  if (
    geometry.blankBeforeComposer > 12 ||
    geometry.footerBottomBlankLines > 12
  ) {
    throw new Error(
      `tmux ${stage} visible capture has excessive chrome gap: ${JSON.stringify(
        {
          blankBeforeComposer: geometry.blankBeforeComposer,
          footerBottomBlankLines: geometry.footerBottomBlankLines,
          maxBlankRun: blankRun,
          composerLine: geometry.composerLine,
          footerLine: geometry.footerLine,
          totalLines: geometry.totalLines,
        },
      )}`,
    );
  }
  if (requireSentinel && !text.includes("tui-lab-final-sentinel")) {
    throw new Error(`tmux ${stage} resize capture lost final sentinel`);
  }
}

function visualResizeChromeCheck(text, stage) {
  const checks = [];
  const add = (name, ok, detail = {}) =>
    checks.push({ name: `${stage}:${name}`, ok: Boolean(ok), ...detail });
  const counts = {
    ask: countOccurrences(text, "Ask KCoder"),
    footer: countOccurrences(text, "? for shortcuts"),
  };
  add("composer-visible-once", counts.ask === 1, { count: counts.ask });
  add("footer-visible-once", counts.footer === 1, { count: counts.footer });
  add("screen-text-has-no-ansi-esc", !/\x1b/.test(text));
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
    counts,
  };
}

function sessionMemoryCompactSummary(memorySentinel) {
  return `# Session Title

_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

Session memory compact automation ${memorySentinel}

# Current State

_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

The current session is intentionally prepared for Session Memory Compact verification. ${memorySentinel} must survive in compacted model context, while the earliest raw user turn must be represented only by this summary without preserving its exact marker text.

# Task specification

_What did the user ask to build? Any design decisions or other explanatory context_

Verify that /compact prefers the session-memory Markdown file, keeps the user-visible transcript append-only, records a compact boundary and summary in JSONL, and uses that compacted context for the next provider request.

# Files and Functions

_What are the important files? In short, what do they contain and why are they relevant?_

The test writes this session-scoped summary under <projectDir>/<session>/session-memory/summary.md, inspects <projectDir>/<session>.jsonl compact boundary records, and inspects <projectDir>/<session>/state.json only for non-transcript session metadata.

# Workflow

_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

Submit an old turn, submit a large recent tail, run /compact, then submit a post-compact probe.

# Errors & Corrections

_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

No errors are expected. If the old raw marker appears after the latest compact boundary or in post-compact request payloads, Session Memory Compact did not replace the old conversation segment.

# Codebase and System Documentation

_What are the important system components? How do they work/fit together?_

KCoder stores the user transcript as append-only JSONL; compacted model context is reconstructed from the latest compact boundary and summary records.

# Learnings

_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

Session Memory Compact should not need a summary-model request when this markdown file is valid and fits the context budget.

# Key results

_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

Pending verification by tui-lab.

# Worklog

_Step by step, what was attempted, done? Very terse summary for each step_

Generated by tools/tui-lab session-memory-compact scenario.
`;
}

async function openInteractive(options) {
  const artifacts = await createRunContext(
    options,
    "open",
    runContextRuntime(),
  );
  const runOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const session = await startSession(runOptions);
  const browser = await chromium.launch(browserLaunchOptions(options));
  const page = await browser.newPage({
    viewport: {
      width: Math.max(900, options.cols * 9 + 80),
      height: Math.max(640, options.rows * 18 + 80),
    },
  });
  await page.goto(session.url);
  await writeJsonArtifact(artifacts.meta, {
    command: defaultCommandString(runOptions),
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
    url: session.url,
    mode: "open",
  });
  console.log(`KCoder TUI Lab open at ${session.url}`);
  console.log(`Run directory: ${artifacts.dir}`);
  console.log("Close the browser or press Ctrl+C here to stop the PTY.");

  const stop = async () => {
    await browser.close().catch(() => {});
    await session.stop().catch(() => {});
  };
  process.once("SIGINT", async () => {
    await stop();
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    await stop();
    process.exit(143);
  });

  while (browser.isConnected()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await stop();
}

async function tmuxSmoke(options) {
  const artifacts = await createRunContext(
    options,
    "tmux-smoke",
    runContextRuntime(),
  );
  const runOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const sessionName = `kcoder-tui-lab-${process.pid}`;
  const command = `cd ${shellQuote(repoRoot)} && exec ${defaultCommandString(runOptions)}`;
  await writeStartMeta(artifacts, runOptions, command, "tmux-smoke");
  spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
  const start = spawnSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      String(options.cols),
      "-y",
      String(options.rows),
      command,
    ],
    { encoding: "utf8" },
  );
  if (start.status !== 0) {
    throw new Error(start.stderr || "failed to start tmux session");
  }
  try {
    await pollTmuxText(
      sessionName,
      "TUI dev mode is running mock scenario",
      options.timeoutMs,
    );
    spawnSync("tmux", ["send-keys", "-l", "-t", sessionName, options.message], {
      encoding: "utf8",
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
      encoding: "utf8",
    });
    await pollTmuxText(
      sessionName,
      "tui-lab-final-sentinel",
      options.timeoutMs,
    );
    const resizeCaptures = [];
    for (const [index, size] of TMUX_RESIZE_SEQUENCE.entries()) {
      const resize = spawnSync(
        "tmux",
        [
          "resize-window",
          "-t",
          sessionName,
          "-x",
          String(size.cols),
          "-y",
          String(size.rows),
        ],
        { encoding: "utf8" },
      );
      if (resize.status !== 0) {
        throw new Error(
          resize.stderr || `failed to resize tmux window at step ${index + 1}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
      const stageText = captureTmux(sessionName);
      const stageVisibleText = captureTmux(sessionName, { history: false });
      const stageAnsiText = captureTmux(sessionName, { ansi: true });
      const textPath = path.join(
        artifacts.dir,
        `screen-resize-${index + 1}.txt`,
      );
      const visibleTextPath = path.join(
        artifacts.dir,
        `screen-resize-${index + 1}-visible.txt`,
      );
      const ansiPath = path.join(
        artifacts.dir,
        `screen-resize-${index + 1}.ansi.txt`,
      );
      await writeTextArtifact(textPath, stageText);
      await writeTextArtifact(visibleTextPath, stageVisibleText);
      await writeTextArtifact(ansiPath, stageAnsiText);
      assertTmuxResizeChrome(stageVisibleText, `resize-${index + 1}`, {
        requireWelcome: false,
        requireSentinel: true,
      });
      resizeCaptures.push({
        step: index + 1,
        ...size,
        text: textPath,
        visibleText: visibleTextPath,
        ansiText: ansiPath,
      });
    }
    const capture = captureTmux(sessionName);
    const visibleCapture = captureTmux(sessionName, { history: false });
    const ansiCapture = captureTmux(sessionName, { ansi: true });
    assertTmuxResizeChrome(visibleCapture, "final", {
      requireWelcome: false,
      requireSentinel: true,
    });
    await writeTextArtifact(artifacts.text, capture);
    const visibleText = path.join(artifacts.dir, "screen-visible.txt");
    await writeTextArtifact(visibleText, visibleCapture);
    await writeTextArtifact(artifacts.ansiText, ansiCapture);
    await writeJsonArtifact(artifacts.meta, {
      command,
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
      text: artifacts.text,
      visibleText,
      ansiText: artifacts.ansiText,
      resizeSequence: TMUX_RESIZE_SEQUENCE,
      resizeCaptures,
      resizedTo: TMUX_RESIZE_SEQUENCE[TMUX_RESIZE_SEQUENCE.length - 1],
    });
    console.log(
      JSON.stringify(
        { ok: true, text: artifacts.text, meta: artifacts.meta },
        null,
        2,
      ),
    );
  } catch (error) {
    let text = "";
    try {
      text = captureTmux(sessionName);
      await writeTextArtifact(artifacts.text, text);
    } catch {
      // Session may not exist or may have exited before capture.
    }
    await writeJsonArtifact(artifacts.failure, {
      ok: false,
      mode: "tmux-smoke",
      command,
      cwd: repoRoot,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      description: artifacts.description,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      workspaceTemplate: artifacts.workspaceTemplate,
      message: options.message,
      scenario: options.scenario,
      text: text ? artifacts.text : undefined,
      error: formatError(error),
      failedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
  }
}

async function tmuxStartup(options) {
  const artifacts = await createRunContext(
    options,
    "tmux-startup",
    runContextRuntime(),
  );
  const runOptions = {
    ...options,
    runDir: artifacts.dir,
    workspaceDir: artifacts.workspace,
    requestsDir: artifacts.requestsDir,
    configHome: artifacts.configHome,
  };
  const sessionName = `kcoder-tui-lab-startup-${process.pid}`;
  const command = defaultCommandString(runOptions);
  await writeStartMeta(artifacts, runOptions, command, "tmux-startup");
  spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
  const start = spawnSync(
    "tmux",
    [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      String(options.cols),
      "-y",
      String(options.rows),
      "-c",
      repoRoot,
    ],
    { encoding: "utf8" },
  );
  if (start.status !== 0) {
    throw new Error(start.stderr || "failed to start tmux session");
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    spawnSync("tmux", ["send-keys", "-l", "-t", sessionName, command], {
      encoding: "utf8",
    });
    spawnSync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
      encoding: "utf8",
    });
    await pollTmuxText(sessionName, "Welcome to KCoder!", options.timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const capture = captureTmux(sessionName);
    const ansiCapture = captureTmux(sessionName, { ansi: true });
    const assertions = runStartupAssertions({ text: capture });
    await writeTextArtifact(artifacts.text, capture);
    await writeTextArtifact(artifacts.ansiText, ansiCapture);
    await writeJsonArtifact(artifacts.assertions, assertions);
    if (!assertions.ok) {
      const error = new Error(
        `tmux startup assertions failed: ${assertions.failed.join(", ")}`,
      );
      error.assertions = assertions;
      throw error;
    }
    await writeJsonArtifact(artifacts.meta, {
      ok: true,
      mode: "tmux-startup",
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
      text: artifacts.text,
      ansiText: artifacts.ansiText,
      assertions: artifacts.assertions,
      pty: {
        cols: options.cols,
        rows: options.rows,
        launch: "interactive-shell",
      },
    });
    console.log(
      JSON.stringify(
        { ok: true, mode: "tmux-startup", text: artifacts.text, assertions },
        null,
        2,
      ),
    );
  } catch (error) {
    let text = "";
    try {
      text = captureTmux(sessionName);
      await writeTextArtifact(artifacts.text, text);
    } catch {
      // Session may not exist or may have exited before capture.
    }
    await writeJsonArtifact(artifacts.failure, {
      ok: false,
      mode: "tmux-startup",
      command,
      cwd: repoRoot,
      runId: artifacts.runId,
      date: artifacts.dateStamp,
      time: artifacts.timeStamp,
      description: artifacts.description,
      runDir: artifacts.dir,
      workspace: artifacts.workspace,
      workspaceTemplate: artifacts.workspaceTemplate,
      scenario: options.scenario,
      text: text ? artifacts.text : undefined,
      assertions: error.assertions,
      error: formatError(error),
      failedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    spawnSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
  }
}

async function pollTmuxText(sessionName, expected, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = captureTmux(sessionName);
    if (text.includes(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for tmux text: ${expected}`);
}

function captureTmux(sessionName, options = {}) {
  const args = ["capture-pane", options.ansi ? "-epJ" : "-pJ"];
  if (options.history !== false) {
    args.push("-S", "-");
  }
  args.push("-t", sessionName);
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "tmux capture-pane failed");
  }
  return result.stdout;
}

async function main() {
  const options = parseArgs(process.argv.slice(2), {
    defaultWorkspaceTemplate,
  });
  options.repoRoot = repoRoot;
  if (options.help) {
    console.log(usage);
    return;
  }
  assertModeSupported(options.command, process.platform);

  switch (options.command) {
    case "open":
      await openInteractive(options);
      break;
    case "run":
      await runBrowserScenario(options, "run");
      break;
    case "inline":
      await runBrowserScenario(options, "inline", "inline");
      break;
    case "two-turn":
      await runBrowserScenario(options, "two-turn", "two-turn");
      break;
    case "targeted-subagent-steer":
      await runBrowserScenario(
        options,
        "targeted-subagent-steer",
        "targeted-subagent-steer",
      );
      break;
    case "targeted-subagent-stop":
      await runBrowserScenario(
        options,
        "targeted-subagent-stop",
        "targeted-subagent-stop",
      );
      break;
    case "slash-overlay":
      await runSlashOverlayScenario(options);
      break;
    case "external-editor":
      await runExternalEditorScenario(options);
      break;
    case "slash-after-history":
      await runSlashAfterHistoryScenario(options);
      break;
    case "goal-command":
      await runGoalCommandScenario(options);
      break;
    case "lsp-diagnostics":
      await runBrowserScenario(options, "lsp-diagnostics");
      break;
    case "ocr-review":
      await runBrowserScenario(options, "ocr-review");
      break;
    case "streaming-scrollbar":
      await runStreamingScrollbarScenario(options);
      break;
    case "history-scrollbar":
      await runHistoryScrollbarScenario(options);
      break;
    case "clipboard":
      await runBrowserScenario(options, "clipboard", "clipboard");
      break;
    case "image-paste":
      await runBrowserScenario(options, "image-paste", "image-paste");
      break;
    case "history-search":
      await runBrowserScenario(options, "history-search", "history-search");
      break;
    case "mention":
      await runBrowserScenario(options, "mention", "mention");
      break;
    case "paste":
      await runBrowserScenario(options, "paste", "paste");
      break;
    case "shell-prompt":
      await runBrowserScenario(options, "shell-prompt", "shell-prompt");
      break;
    case "session-memory-compact":
      await runSessionMemoryCompactScenario(options);
      break;
    case "session-resume":
      await runSessionResumeScenario(options);
      break;
    case "resize-visual":
      await runResizeVisualScenario(options);
      break;
    case "record":
      await runRecordingScenario(options);
      break;
    case "startup":
      await runStartupScenario(options);
      break;
    case "outline-navigation":
      await runOutlineNavigationScenario(options, {
        startSession,
        runContextRuntime,
        writeStartMeta,
        repoRoot,
      });
      break;
    case "response-budget":
      await runResponseBudgetScenario(options, { startSession, runContextRuntime, writeStartMeta, repoRoot });
      break;
    case "markdown-rendering":
      await runMarkdownRenderingScenario(options, {
        startSession,
        runContextRuntime,
        writeStartMeta,
        repoRoot,
      });
      break;
    case "copy-view":
      await runCopyViewScenario(options, {
        startSession,
        runContextRuntime,
        writeStartMeta,
        repoRoot,
      });
      break;
    case "model-refresh":
      await runModelRefreshScenario(options, { startSession, runContextRuntime, writeStartMeta, repoRoot });
      break;
    case "tail-menu":
      await runTailMenuScenario(options, {
        startSession,
        runContextRuntime,
        writeStartMeta,
        repoRoot,
      });
      break;
    case "screenshot":
      await runBrowserScenario(options, "screenshot", "screenshot");
      break;
    case "tmux-startup":
      await tmuxStartup(options);
      break;
    case "tmux-smoke":
      await tmuxSmoke(options);
      break;
    default:
      throw new Error(`unknown command: ${options.command}`);
  }
}

main().then(
  () => {
    // ConPTY can leave native handles alive after a graceful child exit. All
    // artifacts have been flushed when main resolves, so do not hang CI/SSH.
    if (process.platform === "win32") process.exit(0);
  },
  (error) => {
    console.error(error.stack || error.message || String(error));
    console.error("");
    console.error(usage);
    process.exit(1);
  },
);
