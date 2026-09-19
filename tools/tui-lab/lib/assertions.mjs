import { interactionBudgetsForPlatform } from "./platform-adapter.mjs";
import {
  textContainsAcrossWrap,
  textHasEarlyToolHistory,
  textHasMixedToolsSummary,
} from "./scroll-metrics.mjs";

export function runAssertions({
  text,
  ptyLog,
  hasScrollbar,
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
  scenario,
  message,
  secondMessage,
  steerAfterTool,
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
}) {
  const checks = [];
  const add = (name, ok, detail = {}) =>
    checks.push({ name, ok: Boolean(ok), ...detail });
  const combinedText = [text, afterToolText, scrollTopText, scrollBottomText]
    .filter(Boolean)
    .join("\n");
  add("screen-text-has-no-ansi-esc", !/\x1b/.test(text));
  add(
    "screen-text-has-no-cursor-position-response",
    !/\^\[\[[0-9;]+R/.test(text),
  );
  if (mode === "inline") {
    add(
      "inline-surface-omits-committed-scrollbar",
      Boolean(
        inlineSurfaceEvidence &&
        inlineSurfaceEvidence.internalScrollbar.trackRows.length === 0 &&
        inlineSurfaceEvidence.internalScrollbar.thumbRows.length === 0,
      ),
      inlineSurfaceEvidence || {},
    );
    add(
      "inline-surface-uses-host-scrollback",
      Boolean(
        inlineSurfaceEvidence?.hasHostScrollbar === true &&
        inlineSurfaceEvidence.dimensions.scrollHeight >
          inlineSurfaceEvidence.dimensions.clientHeight * 2,
      ),
      inlineSurfaceEvidence || {},
    );
  }
  const terminalTitles = Array.from(
    (ptyLog || "").matchAll(/\x1b\]0;([^\x07]*)\x07/g),
    (match) => match[1],
  );
  const readyIndex = terminalTitles.findIndex((title) =>
    title.startsWith("[READY]"),
  );
  const runIndex = terminalTitles.findIndex(
    (title, index) => index > readyIndex && title.startsWith("[RUN]"),
  );
  const returnedReadyIndex = terminalTitles.findIndex(
    (title, index) => index > runIndex && title.startsWith("[READY]"),
  );
  add(
    "terminal-title-lifecycle-ready-run-ready",
    readyIndex >= 0 && runIndex > readyIndex && returnedReadyIndex > runIndex,
    { terminalTitles },
  );
  if (
    scenario === "lsp-diagnostics" ||
    scenario === "ocr-review" ||
    scenario === "subagent-trace" ||
    scenario === "long-write"
  ) {
    add(
      "tool-expansion-applied",
      Boolean(expandedToolText) &&
        !expandedToolText.includes("alt + t to expand tools"),
      {
        capturedExpandedText: Boolean(expandedToolText),
        stillShowsCollapsedHint: expandedToolText.includes(
          "alt + t to expand tools",
        ),
        inputEvents: toolExpansionInputEvents.map((value) =>
          Array.from(value, (character) => character.codePointAt(0)),
        ),
      },
    );
  }
  const userMessageVisibleAtTail = textContainsAcrossWrap(text, message);
  const userMessageVisibleAfterScrollTop = textContainsAcrossWrap(
    scrollTopText,
    message,
  );
  const firstUserVisible =
    scenario === "lsp-diagnostics"
      ? userMessageVisibleAtTail ||
        userMessageVisibleAfterScrollTop ||
        Boolean(historyEvidence?.hasAllRequired)
      : scenario === "ocr-review"
        ? userMessageVisibleAtTail ||
          userMessageVisibleAfterScrollTop ||
          Boolean(historyEvidence?.hasAllRequired)
        : scenario === "subagent-trace"
          ? Boolean(
              historyEvidence?.fileCount > 0 &&
              subagentEvidence?.hasAllRequired,
            )
          : scenario === "long-write"
            ? Boolean(historyEvidence?.hasAllRequired)
            : mode === "inline"
              ? Boolean(requestEvidence?.hasAllRequired)
              : userMessageVisibleAtTail || userMessageVisibleAfterScrollTop;
  add("first-user-message-present", firstUserVisible, {
    message,
    visibleAtTail: userMessageVisibleAtTail,
    visibleAfterScrollTop: userMessageVisibleAfterScrollTop,
  });
  if (scenario === "lsp-diagnostics") {
    add(
      "lsp-diagnostics-final-sentinel-present",
      combinedText.includes("tui-lab-lsp-diagnostics-final-sentinel"),
    );
    add(
      "final-sentinel-present",
      combinedText.includes("tui-lab-final-sentinel"),
    );
    add(
      "lsp-diagnostics-report-visible",
      combinedText.includes('<diagnostics source="lsp"'),
      {
        hasPyright: combinedText.includes('server="pyright"'),
        hasReportArgumentType: combinedText.includes("reportArgumentType"),
        hasUnicodeSpacePath: combinedText.includes("diagnostic-fixture"),
      },
    );
    add(
      "lsp-diagnostics-path-visible",
      combinedText.includes("diagnostic-fixture"),
    );
    add(
      "lsp-diagnostics-recognized-by-model",
      combinedText.includes("contains real pyright LSP diagnostics"),
    );
    add(
      "lsp-diagnostics-not-missing",
      !combinedText.includes("does not contain real pyright LSP diagnostics"),
    );
    add(
      "lsp-diagnostics-project-transcript-written",
      Boolean(historyEvidence?.fileCount > 0),
      {
        projectDir: historyEvidence?.dir,
        fileCount: historyEvidence?.fileCount || 0,
        error: historyEvidence?.error,
      },
    );
    add(
      "lsp-diagnostics-in-project-transcript",
      Boolean(historyEvidence?.hasAllRequired),
      historyEvidence || {},
    );
    add(
      "lsp-diagnostics-model-request-captured",
      Boolean(requestEvidence?.fileCount > 0),
      {
        requestsDir: requestEvidence?.dir,
        fileCount: requestEvidence?.fileCount || 0,
        error: requestEvidence?.error,
      },
    );
    add(
      "lsp-diagnostics-in-model-request",
      Boolean(requestEvidence?.hasAllRequired),
      requestEvidence || {},
    );
    add("no-large-blank-run", maxConsecutiveBlankLines(text) <= 8, {
      maxBlankRun: maxConsecutiveBlankLines(text),
    });
    const failed = checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
    return {
      ok: failed.length === 0,
      failed,
      checks,
    };
  }
  if (scenario === "ocr-review") {
    add(
      "ocr-review-final-sentinel-present",
      combinedText.includes("tui-lab-ocr-review-final-sentinel"),
    );
    add(
      "final-sentinel-present",
      combinedText.includes("tui-lab-final-sentinel"),
    );
    add(
      "ocr-preview-tool-output-visible",
      combinedText.includes("OpenCodeReview command:"),
      {
        hasReviewCommand: combinedText.includes("ocr review"),
        hasPreviewFlag: combinedText.includes("--preview"),
      },
    );
    add(
      "ocr-preview-command-succeeded",
      Boolean(
        historyEvidence?.hasAllRequired && requestEvidence?.hasAllRequired,
      ),
      {
        transcriptHasSuccessfulPreview: historyEvidence?.hasAllRequired,
        modelRequestHasSuccessfulPreview: requestEvidence?.hasAllRequired,
      },
    );
    add(
      "ocr-preview-recognized-by-model",
      combinedText.includes("contains OpenCodeReview preview output"),
    );
    add(
      "ocr-preview-not-missing",
      !combinedText.includes("does not contain OpenCodeReview preview output"),
    );
    add(
      "ocr-review-project-transcript-written",
      Boolean(historyEvidence?.fileCount > 0),
      {
        projectDir: historyEvidence?.dir,
        fileCount: historyEvidence?.fileCount || 0,
        error: historyEvidence?.error,
      },
    );
    add(
      "ocr-review-in-project-transcript",
      Boolean(historyEvidence?.hasAllRequired),
      historyEvidence || {},
    );
    add(
      "ocr-review-model-request-captured",
      Boolean(requestEvidence?.fileCount > 0),
      {
        requestsDir: requestEvidence?.dir,
        fileCount: requestEvidence?.fileCount || 0,
        error: requestEvidence?.error,
      },
    );
    add(
      "ocr-review-in-model-request",
      Boolean(requestEvidence?.hasAllRequired),
      requestEvidence || {},
    );
    add("no-large-blank-run", maxConsecutiveBlankLines(text) <= 8, {
      maxBlankRun: maxConsecutiveBlankLines(text),
    });
    const failed = checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
    return {
      ok: failed.length === 0,
      failed,
      checks,
    };
  }
  if (scenario === "subagent-trace") {
    add(
      "subagent-trace-final-sentinel-present",
      combinedText.includes("tui-lab-subagent-trace-final-sentinel"),
    );
    add(
      "final-sentinel-present",
      combinedText.includes("tui-lab-final-sentinel"),
    );
    add(
      "subagent-spawn-output-visible",
      combinedText.includes("spawn_agent") &&
        (combinedText.includes("agent_id") ||
          Boolean(subagentEvidence?.hasAllRequired)),
      {
        hasOutputFile: combinedText.includes("output_file"),
        hasSpawnTool: combinedText.includes("spawn_agent"),
        hasAgentId: combinedText.includes("agent_id"),
        artifactComplete: Boolean(subagentEvidence?.hasAllRequired),
      },
    );
    add(
      "subagent-project-transcript-written",
      Boolean(historyEvidence?.fileCount > 0),
      {
        projectDir: historyEvidence?.dir,
        fileCount: historyEvidence?.fileCount || 0,
        error: historyEvidence?.error,
      },
    );
    add(
      "subagent-model-request-captured",
      Boolean(requestEvidence?.fileCount > 0),
      {
        requestsDir: requestEvidence?.dir,
        fileCount: requestEvidence?.fileCount || 0,
        error: requestEvidence?.error,
      },
    );
    add(
      "subagent-artifacts-complete",
      Boolean(subagentEvidence?.hasAllRequired),
      subagentEvidence || {},
    );
    if (mode === "targeted-subagent-steer") {
      add("agent-picker-shows-task-descriptions", targetedSteerEvidence?.pickerDescriptionVisible === true);
      add("parent-user-input-visible-in-order-with-live-subagents", targetedSteerEvidence?.parentInputOrdered === true);
      add("agent-picker-keyboard-enters-selected-id", targetedSteerEvidence?.pickerKeyboardEnteredTarget === true);
      add("targeted-live-text-visible-before-durable-checkpoint", targetedSteerEvidence?.liveBeforeCheckpoint === true);
      add("targeted-live-tail-stays-near-composer", targetedSteerEvidence?.tailNearComposer === true);
      add("targeted-collapsed-tail-fills-history-above-bottom", targetedSteerEvidence?.collapsedTailFilled === true);
      add(
        "targeted-steer-two-agents-visible",
        Number(targetedSteerEvidence?.agentListCount || 0) >= 2,
        {
          agentListCount: targetedSteerEvidence?.agentListCount || 0,
          targetAgentId: targetedSteerEvidence?.targetAgentId,
          siblingAgentIds: targetedSteerEvidence?.siblingAgentIds || [],
        },
      );
      add(
        "targeted-steer-agent-view-visible",
        targetedSteerEvidence?.viewVisible === true,
      );
      add(
        "targeted-steer-child-transcript-visible",
        targetedSteerEvidence?.viewShowsChildTranscript === true,
      );
      add(
        "targeted-steer-post-spawn-parent-transcript-hidden-in-child-view",
        targetedSteerEvidence?.viewHidesPostSpawnParentTranscript === true,
      );
      add(
        "targeted-steer-target-was-running",
        targetedSteerEvidence?.targetWasRunning === true,
      );
      add(
        "targeted-steer-queued-visible",
        targetedSteerEvidence?.queuedVisible === true,
      );
      add(
        "targeted-steer-used-live-queue",
        targetedSteerEvidence?.queuedLiveVisible === true,
      );
      add(
        "targeted-steer-applied-visible",
        targetedSteerEvidence?.appliedVisible === true,
      );
      add(
        "targeted-steer-long-child-scrolls-independently",
        targetedSteerEvidence?.longChildBottomVisible === true &&
          targetedSteerEvidence?.longChildScrolledBack === true &&
          targetedSteerEvidence?.longChildBottomRestored === true,
        {
          bottomVisible: targetedSteerEvidence?.longChildBottomVisible === true,
          scrolledBack: targetedSteerEvidence?.longChildScrolledBack === true,
          bottomRestored:
            targetedSteerEvidence?.longChildBottomRestored === true,
        },
      );
      add(
        "targeted-steer-isolated-in-durable-artifacts",
        targetedSteerEvidence?.artifacts?.hasAllRequired === true,
        targetedSteerEvidence?.artifacts || {},
      );
    }
    if (mode === "targeted-subagent-stop") {
      add(
        "targeted-stop-two-running-agents-visible",
        Number(targetedStopEvidence?.agentListCount || 0) >= 2 &&
          targetedStopEvidence?.allAgentsWereRunning === true,
        {
          agentListCount: targetedStopEvidence?.agentListCount || 0,
          targetAgentId: targetedStopEvidence?.targetAgentId,
          siblingAgentIds: targetedStopEvidence?.siblingAgentIds || [],
        },
      );
      add(
        "targeted-stop-command-visible",
        targetedStopEvidence?.commandVisible === true,
      );
      add(
        "targeted-stop-cancels-only-selected-agent",
        targetedStopEvidence?.artifacts?.hasAllRequired === true,
        targetedStopEvidence?.artifacts || {},
      );
    }
    add("no-large-blank-run", maxConsecutiveBlankLines(text) <= 8, {
      maxBlankRun: maxConsecutiveBlankLines(text),
    });
    const failed = checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
    return {
      ok: failed.length === 0,
      failed,
      checks,
    };
  }
  if (scenario === "orchestrate-control") {
    const panelEvidence = `${combinedText}\n${ptyLog || ""}`;
    add(
      "orchestrate-control-final-sentinel-present",
      combinedText.includes("tui-lab-orchestrate-control-final-sentinel"),
    );
    add(
      "final-sentinel-present",
      combinedText.includes("tui-lab-final-sentinel"),
    );
    add("orchestrate-paused-panel-visible", panelEvidence.includes("Paused."), {
      hasPausedLabel: panelEvidence.includes("Paused."),
    });
    add(
      "orchestrate-queue-and-breaker-visible",
      panelEvidence.includes("queue 1") && panelEvidence.includes("breaker"),
      {
        hasQueue: panelEvidence.includes("queue 1"),
        hasBreaker: panelEvidence.includes("breaker"),
      },
    );
    add(
      "orchestrate-control-durable-state-and-audit-proven",
      Boolean(orchestrateControlEvidence?.hasAllRequired),
      orchestrateControlEvidence || {},
    );
    add("no-large-blank-run", maxConsecutiveBlankLines(text) <= 8, {
      maxBlankRun: maxConsecutiveBlankLines(text),
    });
    const failed = checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
    return { ok: failed.length === 0, failed, checks };
  }
  if (scenario === "long-write") {
    add(
      "long-write-final-sentinel-present",
      combinedText.includes("tui-lab-long-write-final-sentinel"),
    );
    add(
      "long-write-preview-visible",
      Boolean(historyEvidence?.hasAllRequired),
      {
        hasFirstLine: Boolean(historyEvidence?.hasAllRequired),
        hasWriteTool: combinedText.includes("write"),
      },
    );
    add(
      "long-write-delete-visible",
      combinedText.includes("tui-lab-long-write-deleted"),
    );
    add(
      "long-write-project-transcript-written",
      Boolean(historyEvidence?.fileCount > 0),
      {
        projectDir: historyEvidence?.dir,
        fileCount: historyEvidence?.fileCount || 0,
      },
    );
    add(
      "long-write-model-requests-captured",
      Boolean(requestEvidence?.fileCount >= 3),
      {
        requestsDir: requestEvidence?.dir,
        fileCount: requestEvidence?.fileCount || 0,
      },
    );
    add("no-large-blank-run", maxConsecutiveBlankLines(text) <= 8, {
      maxBlankRun: maxConsecutiveBlankLines(text),
    });
    const failed = checks
      .filter((check) => !check.ok)
      .map((check) => check.name);
    return { ok: failed.length === 0, failed, checks };
  }
  const finalTailEvidence =
    mode === "history-search" ||
    mode === "mention" ||
    mode === "paste" ||
    mode === "image-paste" ||
    mode === "shell-prompt"
      ? combinedText
      : text;
  add(
    "first-final-sentinel-present",
    finalTailEvidence.includes("tui-lab-final-sentinel"),
  );
  add(
    "counted-final-tail-present",
    finalTailEvidence.includes("tui-lab-final-line-120"),
  );
  if (mode !== "inline") {
    add("host-terminal-scrollback-not-required", hasScrollbar === false, {
      hasScrollbar,
    });
  }
  add("no-large-blank-run", maxConsecutiveBlankLines(text) <= 8, {
    maxBlankRun: maxConsecutiveBlankLines(text),
  });

  const top = trace.find((entry) => entry.name === "after-scroll-top");
  const bottom = trace.find((entry) => entry.name === "after-scroll-bottom");
  add(
    "tui-scroll-top-shows-earlier-history",
    Boolean(
      top &&
      (textHasEarlyToolHistory(scrollTopText || "") ||
        (mode === "inline" &&
          scrollTopText?.includes("alt + t to expand tools")) ||
        textContainsAcrossWrap(scrollTopText, message)),
    ),
    {
      captured: Boolean(top),
      hasToolStart: Boolean(scrollTopText?.includes("tui-lab-tool-start")),
      hasToolLine001: Boolean(scrollTopText?.includes("tui-lab-tool-line-001")),
      hasMixedToolsSummary: Boolean(
        textHasMixedToolsSummary(scrollTopText || ""),
      ),
      hasUserMessage: textContainsAcrossWrap(scrollTopText, message),
    },
  );
  if (scenario === "mixed-tools") {
    add("mixed-tools-summary-present", textHasMixedToolsSummary(combinedText));
    add(
      "mixed-tools-summary-includes-edit",
      textHasMixedToolsSummary(combinedText),
      {
        hasOrdinaryToolSummary: textHasMixedToolsSummary(combinedText),
        hasEditInSummary: combinedText.includes("edit x1"),
      },
    );
    add(
      "mixed-tools-final-sentinel-present",
      combinedText.includes("tui-lab-mixed-tools-final-sentinel"),
    );
    const finalizedReviewText = [scrollTopText, scrollBottomText]
      .filter(Boolean)
      .join("\n");
    add(
      "mixed-tools-edit-has-no-standalone-patch-after-collapse",
      textHasMixedToolsSummary(finalizedReviewText) &&
        !finalizedReviewText.includes("◆ patch"),
      {
        summaryVisibleInReview: textHasMixedToolsSummary(finalizedReviewText),
        hasStandalonePatchInReview: finalizedReviewText.includes("◆ patch"),
      },
    );
  }
  add(
    "tui-scroll-bottom-shows-final-tail",
    Boolean(bottom && scrollBottomText?.includes("tui-lab-final-line-120")),
    {
      captured: Boolean(bottom),
      hasFinalLine120: Boolean(
        scrollBottomText?.includes("tui-lab-final-line-120"),
      ),
      hasFinalSentinel: Boolean(
        scrollBottomText?.includes("tui-lab-final-sentinel"),
      ),
    },
  );
  if (
    mode !== "inline" &&
    mode !== "screenshot" &&
    mode !== "clipboard" &&
    mode !== "image-paste" &&
    mode !== "history-search" &&
    mode !== "mention" &&
    mode !== "paste" &&
    mode !== "shell-prompt"
  ) {
    const budgets = interactionBudgetsForPlatform(process.platform);
    add(
      "rapid-3-page-scroll-up-responsive",
      Boolean(
        rapidPageScroll?.changedOnPageUp &&
        rapidPageScroll.upMs <= budgets.rapidPageMs,
      ),
      rapidPageScroll || {},
    );
    add(
      "rapid-3-page-scroll-down-responsive",
      Boolean(
        rapidPageScroll?.returnedToTail &&
        rapidPageScroll.downMs <= budgets.rapidPageMs,
      ),
      rapidPageScroll || {},
    );
    add(
      "full-scroll-cycle-up-responsive",
      Boolean(
        fullScrollCycles?.allReachedTop &&
        fullScrollCycles.maxUpMs <= budgets.fullPageMs,
      ),
      fullScrollCycles || {},
    );
    add(
      "full-scroll-cycle-down-responsive",
      Boolean(
        fullScrollCycles?.allReturnedToTail &&
        fullScrollCycles.maxDownMs <= budgets.fullPageMs,
      ),
      fullScrollCycles || {},
    );
    add(
      "wheel-full-scroll-cycle-up-responsive",
      Boolean(
        wheelScrollCycles?.allReachedTop &&
        wheelScrollCycles.maxUpMs <= budgets.wheelBoundMs,
      ),
      wheelScrollCycles || {},
    );
    add(
      "wheel-full-scroll-cycle-down-responsive",
      Boolean(
        wheelScrollCycles?.allReturnedToTail &&
        wheelScrollCycles.maxDownMs <= budgets.wheelBoundMs,
      ),
      wheelScrollCycles || {},
    );
    add(
      "scrollbar-drag-top-to-bottom-responsive",
      Boolean(
        scrollbarDrag?.reachedTop &&
        scrollbarDrag?.returnedToTail &&
        scrollbarDrag.dragDownMs <= budgets.scrollbarDragMs,
      ),
      scrollbarDrag || {},
    );
    add(
      "scrollbar-drag-covered-entire-viewport-range",
      Boolean(scrollbarDrag?.coverageWithinOneDisplayRow),
      scrollbarDrag || {},
    );
    if (scenario === "full-turn") {
      add(
        "full-turn-fixture-has-420-logical-tool-lines",
        Boolean(requestEvidence?.hasAllRequired),
        requestEvidence || {},
      );
    }
    add(
      "scrollbar-thumb-height-stable-during-drag",
      Boolean(
        scrollbarThumbStability &&
        scrollbarThumbStability.samplesWithScrollbar >= 4 &&
        scrollbarThumbStability.stableThumbHeight,
      ),
      scrollbarThumbStability || {},
    );
    add(
      "sustained-wheel-input-reaches-tui",
      Boolean(sustainedWheelScroll?.inputDeliveryOk),
      {
        sent: sustainedWheelScroll?.sentTotal || 0,
        observed: sustainedWheelScroll?.observedTotal || 0,
        inputNotDeliveredSeconds:
          sustainedWheelScroll?.inputNotDeliveredSeconds || [],
      },
    );
    add(
      "sustained-wheel-input-produces-render-commits",
      Boolean(sustainedWheelScroll?.commitObserved),
      {
        observed: sustainedWheelScroll?.observedTotal || 0,
        committed: sustainedWheelScroll?.committedTotal || 0,
        inputNotCommittedSeconds:
          sustainedWheelScroll?.inputNotCommittedSeconds || [],
      },
    );
    add(
      "sustained-wheel-viewport-observation-is-fresh",
      Boolean(sustainedWheelScroll?.observationFresh),
      {
        staleObservationSeconds:
          sustainedWheelScroll?.staleObservationSeconds || [],
        longestNonBoundaryStall:
          sustainedWheelScroll?.longestNonBoundaryStall || 0,
      },
    );
    add(
      "sustained-wheel-progress-per-effective-input",
      Boolean(sustainedWheelScroll?.progressRequirementMet),
      {
        progressRows: sustainedWheelScroll?.progressRows || 0,
        effectiveInputs: sustainedWheelScroll?.effectiveInputs || 0,
        coalescedInputs: sustainedWheelScroll?.coalescedInputs || 0,
        boundaryTruncatedInputs: sustainedWheelScroll?.boundaryTruncatedInputs || 0,
        excludedOutwardInputs: sustainedWheelScroll?.excludedOutwardInputs || 0,
        progressPerEffectiveInput:
          sustainedWheelScroll?.progressPerEffectiveInput || 0,
        minimumProgressRows: sustainedWheelScroll?.minimumProgressRows || null,
      },
    );
    add(
      "sustained-wheel-scroll-does-not-stall-after-5s",
      Boolean(
        sustainedWheelScroll &&
        sustainedWheelScroll.inputDeliveryOk &&
        sustainedWheelScroll.commitObserved &&
        sustainedWheelScroll.observationFresh &&
        sustainedWheelScroll.longestNonBoundaryStall <= 1,
      ),
      sustainedWheelScroll || {},
    );
  }

  if (mode === "clipboard") {
    add(
      "native-terminal-selection-is-nonempty",
      Boolean(clipboardEvidence?.nativeSelectionText?.trim()),
      {
        selectedChars: clipboardEvidence?.nativeSelectionText?.length || 0,
      },
    );
    add(
      "ctrl-c-with-native-selection-does-not-reach-tui",
      !clipboardEvidence?.nativeSelectionInputEvents?.some((event) =>
        event.includes("\x03"),
      ),
      { inputEvents: clipboardEvidence?.nativeSelectionInputEvents || [] },
    );
    add(
      "ctrl-c-without-selection-reaches-tui",
      Boolean(
        clipboardEvidence?.noSelectionCtrlCInputEvents?.some((event) =>
          event.includes("\x03"),
        ),
      ),
      { inputEvents: clipboardEvidence?.noSelectionCtrlCInputEvents || [] },
    );
    add(
      "first-idle-ctrl-c-shows-quit-hint",
      clipboardEvidence?.firstIdleCtrlCShowsQuitHint === true,
    );
    add(
      "copy-command-reported-success",
      text.includes("Copied last message to clipboard"),
    );
    add(
      "ctrl-o-reported-success-after-marker-reset",
      Boolean(clipboardEvidence?.markerReset?.ok),
      clipboardEvidence?.markerReset || {},
    );
    add(
      "ctrl-o-reached-tui",
      Boolean(
        clipboardEvidence?.shortcutInputEvents?.some((event) =>
          event.includes("\x0f"),
        ),
      ),
      { inputEvents: clipboardEvidence?.shortcutInputEvents || [] },
    );
    add(
      "raw-on-command-shows-source-fence",
      clipboardEvidence?.rawOnCommandHasFence === true,
    );
    add(
      "raw-off-command-restores-rich-rendering",
      clipboardEvidence?.rawOffCommandHasFence === false,
    );
    add(
      "alt-r-reached-tui-twice",
      Boolean(
        clipboardEvidence?.rawShortcutInputEvents?.filter((event) =>
          event.includes("\x1br"),
        ).length >= 2,
      ),
      { inputEvents: clipboardEvidence?.rawShortcutInputEvents || [] },
    );
    add(
      "alt-r-enables-raw-source-rendering",
      clipboardEvidence?.rawOnShortcutHasFence === true,
    );
    add(
      "alt-r-restores-rich-rendering",
      clipboardEvidence?.rawOffShortcutHasFence === false,
    );
  }

  if (mode === "image-paste") {
    add(
      "image-paste-fixture-created",
      Boolean(imagePasteEvidence?.fixtureBytes > 0),
      {
        path: imagePasteEvidence?.fixturePath,
        bytes: imagePasteEvidence?.fixtureBytes,
      },
    );
    add(
      "image-paste-shortcut-reached-pty",
      Boolean(imagePasteEvidence?.inputEvents?.length),
      {
        shortcut: imagePasteEvidence?.shortcut,
        inputEvents: imagePasteEvidence?.inputEvents || [],
      },
    );
    add(
      "image-placeholder-appears-in-composer",
      imagePasteEvidence?.composedText?.includes("[Image #1]"),
    );
    add(
      "image-submission-reaches-model-request",
      imagePasteEvidence?.requestCaptured === true,
    );
    add(
      "next-turn-request-retains-prior-image-block",
      imagePasteEvidence?.contextRequestCaptured === true,
      {
        followup: imagePasteEvidence?.followupText,
        files: imagePasteEvidence?.contextRequestFiles || [],
      },
    );
    add(
      "image-block-written-to-model-request",
      requestEvidence?.hasAllRequired === true,
      {
        requestsDir: requestEvidence?.dir,
        required: requestEvidence?.required,
      },
    );
    add(
      "image-placeholder-written-to-history",
      historyEvidence?.hasAllRequired === true,
      {
        projectDir: historyEvidence?.dir,
        required: historyEvidence?.required,
      },
    );
  }

  if (mode === "history-search") {
    const events = historySearchEvidence?.inputEvents || [];
    add(
      "ctrl-r-opens-and-cycles-history-search",
      events.filter((event) => event.includes("\x12")).length >= 4 &&
        historySearchEvidence?.newestComposer?.includes(
          historySearchEvidence?.newest,
        ) &&
        historySearchEvidence?.oldestComposer?.includes(
          historySearchEvidence?.oldest,
        ),
      {
        inputEvents: events,
        newestComposer: historySearchEvidence?.newestComposer,
        oldestComposer: historySearchEvidence?.oldestComposer,
      },
    );
    add(
      "ctrl-s-cycles-forward-through-history-search",
      events.some((event) => event.includes("\x13")) &&
        historySearchEvidence?.ctrlSComposer?.includes(
          historySearchEvidence?.newest,
        ),
      { inputEvents: events, composer: historySearchEvidence?.ctrlSComposer },
    );
    add(
      "arrow-keys-cycle-history-search",
      historySearchEvidence?.arrowUpComposer?.includes(
        historySearchEvidence?.oldest,
      ) &&
        historySearchEvidence?.arrowDownComposer?.includes(
          historySearchEvidence?.newest,
        ),
      {
        arrowUpComposer: historySearchEvidence?.arrowUpComposer,
        arrowDownComposer: historySearchEvidence?.arrowDownComposer,
      },
    );
    add(
      "enter-accepts-newest-history-match",
      historySearchEvidence?.acceptedComposer?.includes(
        historySearchEvidence?.newest,
      ),
      { composer: historySearchEvidence?.acceptedComposer },
    );
    add(
      "escape-restores-original-draft",
      historySearchEvidence?.cancelledComposer?.includes(
        historySearchEvidence?.originalDraft,
      ),
      { composer: historySearchEvidence?.cancelledComposer },
    );
    add(
      "enter-without-match-keeps-search-open",
      historySearchEvidence?.enterWithoutMatchStayedOpen === true,
    );
    add(
      "no-match-cancel-restores-original-draft",
      historySearchEvidence?.restoredAfterNoMatch?.includes(
        historySearchEvidence?.originalDraft,
      ),
      { composer: historySearchEvidence?.restoredAfterNoMatch },
    );
  }

  if (mode === "mention") {
    add("mention-fixture-created", mentionEvidence?.fixtureExists === true, {
      path: mentionEvidence?.absolutePath,
    });
    add(
      "mention-command-prefills-at-sign-only",
      mentionEvidence?.prefilledComposer?.trim() === "\u203a @",
      {
        composer: mentionEvidence?.prefilledComposer,
      },
    );
    add(
      "mention-path-preserved-in-composer",
      mentionEvidence?.composedText?.includes(mentionEvidence?.mentionText),
      {
        expected: mentionEvidence?.mentionText,
        composer: mentionEvidence?.composedText,
      },
    );
    add(
      "mention-path-echoed-by-second-turn",
      textContainsAcrossWrap(
        mentionEvidence?.submittedText,
        mentionEvidence?.mentionText,
      ),
      { expected: mentionEvidence?.mentionText },
    );
    add(
      "mention-path-written-to-project-transcript",
      historyEvidence?.hasAllRequired === true,
      {
        projectDir: historyEvidence?.dir,
        files: historyEvidence?.files,
        required: historyEvidence?.required,
      },
    );
    add(
      "windows-mention-uses-native-backslash",
      process.platform !== "win32" ||
        mentionEvidence?.relativePath?.includes("\\"),
      { relativePath: mentionEvidence?.relativePath },
    );
  }

  if (mode === "paste") {
    const pasteEvents = pasteEvidence?.inputEvents || [];
    add(
      "bracketed-paste-sequences-reached-pty-twice",
      pasteEvents.filter(
        (event) =>
          event.includes("\u001b[200~") && event.includes("\u001b[201~"),
      ).length >= 2,
      {
        inputEvents: pasteEvents.map((event) =>
          Buffer.from(event).toString("hex").slice(0, 80),
        ),
      },
    );
    add(
      "small-multiline-paste-does-not-submit-early",
      pasteEvidence?.sentinelsAfterSmallPaste ===
        pasteEvidence?.sentinelsBeforeSmallPaste,
      {
        before: pasteEvidence?.sentinelsBeforeSmallPaste,
        after: pasteEvidence?.sentinelsAfterSmallPaste,
      },
    );
    add(
      "small-paste-normalizes-crlf-and-preserves-unicode",
      textContainsAcrossWrap(
        pasteEvidence?.smallComposerText,
        pasteEvidence?.smallPasted,
      ),
      { expected: pasteEvidence?.smallPasted },
    );
    add(
      "large-paste-renders-placeholder",
      pasteEvidence?.largeComposerText?.includes(
        pasteEvidence?.largePlaceholder,
      ),
      {
        placeholder: pasteEvidence?.largePlaceholder,
        payloadChars: Array.from(pasteEvidence?.largePasted || "").length,
      },
    );
    add(
      "large-paste-hides-full-payload-in-composer",
      !pasteEvidence?.largeComposerText?.includes("-\u6606\u4ed1-large-end"),
    );
    add(
      "small-and-large-pastes-written-to-project-transcript",
      historyEvidence?.hasAllRequired === true,
      {
        projectDir: historyEvidence?.dir,
        files: historyEvidence?.files,
        requiredCount: historyEvidence?.required?.length,
      },
    );
  }

  if (mode === "shell-prompt") {
    add(
      "shell-prompt-composer-shows-command-after-bang-prefix",
      normalizeShellComposerText(shellPromptEvidence?.composedText) ===
        normalizeShellComposerText(shellPromptEvidence?.commandText),
      {
        expectedVisibleText: shellPromptEvidence?.commandText,
        persistedHistoryText: shellPromptEvidence?.historyText,
        actual: shellPromptEvidence?.composedText,
      },
    );
    add(
      "shell-prompt-runs-native-platform-tool",
      shellPromptEvidence?.afterText
        ?.toLowerCase()
        .includes(shellPromptEvidence?.expectedTool?.toLowerCase()),
      { expectedTool: shellPromptEvidence?.expectedTool },
    );
    add(
      "shell-prompt-output-preserves-unicode",
      textContainsAcrossWrap(
        shellPromptEvidence?.afterText,
        shellPromptEvidence?.marker,
      ),
      { marker: shellPromptEvidence?.marker },
    );
    add(
      "shell-prompt-does-not-trigger-model-turn",
      shellPromptEvidence?.secondTurnSentinelsAfterAllShellCommands ===
        shellPromptEvidence?.secondTurnSentinelsBefore,
      {
        before: shellPromptEvidence?.secondTurnSentinelsBefore,
        afterFirstCommand: shellPromptEvidence?.secondTurnSentinelsAfter,
        afterAllCommands:
          shellPromptEvidence?.secondTurnSentinelsAfterAllShellCommands,
      },
    );
    add(
      "shell-prompt-up-restores-history-entry",
      normalizeShellComposerText(shellPromptEvidence?.restoredComposer) ===
        normalizeShellComposerText(shellPromptEvidence?.commandText),
      {
        expectedVisibleText: shellPromptEvidence?.commandText,
        actual: shellPromptEvidence?.restoredComposer,
      },
    );
    add(
      "shell-prompt-persists-input-history",
      shellPromptEvidence?.inputHistoryEntries?.includes(
        shellPromptEvidence?.historyText,
      ) &&
        shellPromptEvidence?.inputHistoryEntries?.includes(
          shellPromptEvidence?.cancelHistoryText,
        ) &&
        shellPromptEvidence?.inputHistoryEntries?.includes(
          shellPromptEvidence?.recoveryHistoryText,
        ),
      {
        historyEntries: shellPromptEvidence?.inputHistoryEntries,
        error: shellPromptEvidence?.inputHistoryError,
      },
    );
    add(
      "shell-prompt-long-command-starts-before-cancel",
      shellPromptEvidence?.cancelRunningText?.includes("esc interrupt"),
      { runningFooter: "esc interrupt" },
    );
    add(
      "shell-prompt-escape-cancels-within-ten-seconds",
      shellPromptEvidence?.cancelledText?.includes("Cancelled.") &&
        shellPromptEvidence?.cancelElapsedMs < 10000,
      { elapsedMs: shellPromptEvidence?.cancelElapsedMs },
    );
    add(
      "shell-prompt-cancel-terminates-process-before-tail-file",
      shellPromptEvidence?.cancelTailFileExists === false,
      {
        tailPath: shellPromptEvidence?.cancelTailPath,
        exists: shellPromptEvidence?.cancelTailFileExists,
      },
    );
    add(
      "shell-prompt-recovers-after-cancel",
      textContainsAcrossWrap(
        shellPromptEvidence?.recoveredText,
        shellPromptEvidence?.recoveryMarker,
      ),
      { marker: shellPromptEvidence?.recoveryMarker },
    );
  }

  if (mode === "two-turn") {
    const secondMessagePresent =
      textContainsAcrossWrap(text, secondMessage) ||
      Boolean(liveSteerEvidence?.ordered);
    const afterSecond = secondMessagePresent ? text : "";
    add("second-user-message-present", secondMessagePresent, { secondMessage });
    if (steerAfterTool) {
      add(
        "live-turn-steer-sentinel-present",
        text.includes("tui-lab-live-steer-sentinel"),
      );
      add(
        "live-turn-steer-follows-tool-result-before-assistant",
        Boolean(liveSteerEvidence?.ordered),
        liveSteerEvidence || {},
      );
    } else {
      add(
        "second-turn-sentinel-present",
        text.includes("tui-lab-second-turn-sentinel"),
      );
    }
    add(
      "second-turn-did-not-start-bash-tool",
      !afterSecond.includes("▶ run bash"),
    );
    add(
      "second-turn-did-not-repeat-tool-output",
      !afterSecond.includes("tui-lab-tool-line-001"),
    );
  }

  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failed.length === 0,
    failed,
    checks,
  };
}

export function maxConsecutiveBlankLines(text) {
  let max = 0;
  let current = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

export function normalizeShellComposerText(value = "") {
  return value.replace(/\s+/g, "");
}
