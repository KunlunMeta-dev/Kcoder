import { createRunContext, verifyRunContextIntegrity } from "./run-context.mjs";
import { runContextRuntime, repoRoot } from "./runtime-paths.mjs";
import {
  defaultCommandString,
  browserLaunchOptions,
} from "./runner-options.mjs";
import path from "node:path";
import { mkdir, writeFile, stat } from "node:fs/promises";
import {
  createImagePasteFixture,
  imagePasteKeyForPlatform,
} from "./image-paste-fixture.mjs";
import process from "node:process";
import {
  writeStartMeta,
  writeTextArtifact,
  writeJsonArtifact,
  writeFailureArtifacts,
} from "./runtime-artifacts.mjs";
import {
  runBrowserScenarioLifecycle,
  settleLifecycleStep,
} from "./browser-lifecycle.mjs";
import { startSession } from "./session.mjs";
import { chromium } from "@playwright/test";
import {
  attachBrowserConsole,
  captureStep,
  formatBrowserConsole,
  capturedArtifactPath,
} from "./browser-evidence.mjs";
import {
  waitForTerminalText,
  focusTerminal,
  typeHumanText,
  tryWaitForTerminalText,
  tryWaitForTerminalTextMissing,
} from "./terminal-interaction.mjs";
import {
  extractTuiSessionId,
  waitForProjectDirForSession,
} from "./session-memory-evidence.mjs";
import {
  scenarioToolNeedle,
  scenarioFinalNeedle,
} from "./scenario-markers.mjs";
import { exerciseAgentSteer } from "./scenarios/targeted-subagent-steer.mjs";
import { exerciseAgentStop } from "./scenarios/targeted-subagent-stop.mjs";
import {
  pressRepeated,
  measureTranscriptScrollbarDrag,
  measureScrollbarThumbStabilityDuringDrag,
  measureRapidPageScroll,
  measureFullScrollCycles,
  measureWheelScrollCycles,
  measureSustainedWheelScroll,
} from "./scroll-metrics.mjs";
import { exerciseImagePaste } from "./scenarios/image-paste.mjs";
import { exerciseClipboard } from "./scenarios/clipboard.mjs";
import { exerciseHistorySearch } from "./scenarios/history-search.mjs";
import { exerciseMention } from "./scenarios/mention.mjs";
import { exercisePaste } from "./scenarios/paste.mjs";
import { exerciseShellPrompt } from "./scenarios/shell-prompt.mjs";
import {
  waitForHistoryEvidence,
  collectHistoryEvidence,
  waitForRequestEvidence,
  collectRequestEvidence,
  collectLiveSteerRequestEvidence,
  waitForSubagentEvidence,
  waitForTargetedSubagentSteerEvidence,
  waitForTargetedSubagentStopEvidence,
  waitForOrchestrateControlEvidence,
} from "./evidence.mjs";
import { runAssertions } from "./assertions.mjs";
import { captureFailurePageEvidence } from "./failure-artifact.mjs";

export async function runBrowserScenario(options, prefix, mode = "single") {
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
        ({ targetedSteerEvidence } = await exerciseAgentSteer({
          page,
          options,
          trace,
          artifacts,
          sessionId,
          targetedSteerEvidence,
        }));
      }
      if (mode === "targeted-subagent-stop") {
        ({ targetedStopEvidence } = await exerciseAgentStop({
          artifacts,
          page,
          options,
          targetedStopEvidence,
          trace,
        }));
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
        await exerciseImagePaste({
          page,
          imagePasteEvidence,
          options,
          trace,
          artifacts,
        });
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
        ({ clipboardEvidence } = await exerciseClipboard({
          page,
          options,
          artifacts,
          trace,
          clipboardScreenshot,
          clipboardEvidence,
        }));
      }
      if (mode === "history-search") {
        ({ historySearchEvidence } = await exerciseHistorySearch({
          page,
          options,
          trace,
          artifacts,
          historySearchEvidence,
        }));
      }
      if (mode === "mention") {
        ({ mentionEvidence } = await exerciseMention({
          page,
          options,
          artifacts,
          trace,
          mentionEvidence,
        }));
      }
      if (mode === "paste") {
        ({ pasteEvidence } = await exercisePaste({
          page,
          options,
          artifacts,
          trace,
          pasteEvidence,
        }));
      }
      if (mode === "shell-prompt") {
        ({ shellPromptEvidence } = await exerciseShellPrompt({
          page,
          options,
          artifacts,
          trace,
          shellPromptEvidence,
        }));
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
