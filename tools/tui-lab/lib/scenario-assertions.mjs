import { textSignature } from "./scroll-metrics.mjs";
import {
  countOccurrences,
  visibleChromeGeometry,
} from "./terminal-geometry.mjs";

export function runHistoryScrollbarAssertions({
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

export function runStreamingScrollbarAssertions({
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

export function runStartupAssertions({ text, trace }) {
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

export function findWelcomeBlock(text) {
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

export function runSlashOverlayAssertions({ stageTexts, trace }) {
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

export function runSlashAfterHistoryAssertions({
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

export function runGoalCommandAssertions({ stageTexts, text }) {
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
