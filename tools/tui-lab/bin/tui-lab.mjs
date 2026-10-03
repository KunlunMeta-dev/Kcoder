#!/usr/bin/env node
import { parseArgs } from "../lib/runner-options.mjs";
import process from "node:process";
import {
  defaultWorkspaceTemplate,
  repoRoot,
  runContextRuntime,
} from "../lib/runtime-paths.mjs";
import { usage } from "../lib/cli-usage.mjs";
import { assertModeSupported } from "../lib/platform-adapter.mjs";
import { openInteractive } from "../lib/scenarios/open-interactive.mjs";
import { runBrowserScenario } from "../lib/browser-scenario.mjs";
import { runSlashOverlayScenario } from "../lib/scenarios/slash-overlay.mjs";
import { runExternalEditorScenario } from "../lib/scenarios/external-editor.mjs";
import { runSlashAfterHistoryScenario } from "../lib/scenarios/slash-after-history.mjs";
import { runGoalCommandScenario } from "../lib/scenarios/goal-command.mjs";
import { runStreamingScrollbarScenario } from "../lib/scenarios/streaming-scrollbar.mjs";
import { runHistoryScrollbarScenario } from "../lib/scenarios/history-scrollbar.mjs";
import { runSessionMemoryCompactScenario } from "../lib/scenarios/session-memory-compact.mjs";
import { runSessionResumeScenario } from "../lib/scenarios/session-resume.mjs";
import { runResizeVisualScenario } from "../lib/scenarios/resize-visual.mjs";
import { runRecordingScenario } from "../lib/scenarios/recording.mjs";
import { runStartupScenario } from "../lib/scenarios/startup.mjs";
import { runOutlineNavigationScenario } from "../lib/outline-navigation-scenario.mjs";
import { startSession } from "../lib/session.mjs";
import { writeStartMeta } from "../lib/runtime-artifacts.mjs";
import { runResponseBudgetScenario } from "../lib/response-budget-scenario.mjs";
import { runMarkdownRenderingScenario } from "../lib/markdown-rendering-scenario.mjs";
import { runCopyViewScenario } from "../lib/copy-view-scenario.mjs";
import { runModelRefreshScenario } from "../lib/model-refresh-scenario.mjs";
import { runTailMenuScenario } from "../lib/tail-menu-scenario.mjs";
import { tmuxStartup } from "../lib/scenarios/tmux-startup.mjs";
import { tmuxSmoke } from "../lib/scenarios/tmux-smoke.mjs";

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
      await runResponseBudgetScenario(options, {
        startSession,
        runContextRuntime,
        writeStartMeta,
        repoRoot,
      });
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
      await runModelRefreshScenario(options, {
        startSession,
        runContextRuntime,
        writeStartMeta,
        repoRoot,
      });
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
