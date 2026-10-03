import { createRunContext } from "../run-context.mjs";
import { runContextRuntime, repoRoot } from "../runtime-paths.mjs";
import {
  writeSessionMemoryCompactSettings,
  extractTuiSessionId,
  waitForProjectDirForSession,
  secureWindowsUserOnlyAcl,
  makeSessionMemoryCompactRecentPayload,
  waitForRequestCountAtLeast,
  waitForStableRequestCount,
  collectSessionMemoryCompactStateEvidence,
  collectSessionMemoryCompactRequestEvidence,
  runSessionMemoryCompactAssertions,
} from "../session-memory-evidence.mjs";
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
  submitTerminalLine,
  waitForTerminalTextCount,
} from "../terminal-interaction.mjs";
import path from "node:path";
import { mkdir, chmod, writeFile } from "node:fs/promises";
import { countOccurrences } from "../terminal-geometry.mjs";

export async function runSessionMemoryCompactScenario(options) {
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

export function sessionMemoryCompactSummary(memorySentinel) {
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
