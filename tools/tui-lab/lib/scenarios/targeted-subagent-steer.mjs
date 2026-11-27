import {
  focusTerminal,
  typeHumanText,
  waitForTerminalText,
  pressTerminalEscape,
  waitForTerminalTextMissing,
} from "../terminal-interaction.mjs";
import { captureStep } from "../browser-evidence.mjs";
import path from "node:path";
import { waitForProjectDirForSession } from "../session-memory-evidence.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { textContainsAcrossWrap, pressRepeated } from "../scroll-metrics.mjs";
import { waitForTargetedSubagentSteerEvidence } from "../evidence.mjs";
import process from "node:process";

export async function exerciseAgentSteer({
  page,
  options,
  trace,
  artifacts,
  sessionId,
  targetedSteerEvidence,
}) {
  // Test visible parent input order while the delegated panel is still live.
  const parentInput = "Pause request: TUI_LAB_PARENT_INPUT_SENTINEL";
  await focusTerminal(page);
  await typeHumanText(page, parentInput);
  await page.keyboard.press("Enter");
  await waitForTerminalText(
    page,
    "TUI_LAB_PARENT_INPUT_ACK",
    options.timeoutMs,
  );
  const parentInputScreen = await page.evaluate(() =>
    window.tuiLab.visibleText(),
  );
  const parentOld = parentInputScreen.indexOf(
    "tui-lab-subagent-trace-final-sentinel",
  );
  const parentUser = parentInputScreen.indexOf(parentInput);
  const parentAck = parentInputScreen.indexOf("TUI_LAB_PARENT_INPUT_ACK");
  const parentInputOrdered =
    parentOld >= 0 &&
    parentOld < parentUser &&
    parentUser < parentAck &&
    parentInputScreen.split("TUI_LAB_PARENT_INPUT_SENTINEL").length === 2;
  await captureStep(
    page,
    trace,
    "parent-input-after-live-panel",
    path.join(artifacts.dir, "parent-input-after-live-panel.png"),
  );
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
    agentListText.matchAll(/((?:agent|job)-[A-Za-z0-9._-]+)\s+\[([^\]]+)\]/g),
    (match) => ({ agentId: match[1], status: match[2] }),
  ).filter(
    (row, index, all) =>
      all.findIndex((candidate) => candidate.agentId === row.agentId) === index,
  );
  const agentIds = agentRows.map((row) => row.agentId);
  if (agentIds.length < 2) {
    throw new Error(
      `targeted steer scenario expected two sub-agents, found ${agentIds.length}`,
    );
  }
  const targetAgentId = agentIds[0];
  const siblingAgentIds = agentIds.slice(1);
  await captureStep(page, trace, "targeted-steer-agent-list", listScreenshot);

  await page.evaluate(() => window.tuiLab.focus());
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await waitForTerminalText(page, "Esc returns to parent", options.timeoutMs);
  const viewText = await page.evaluate(() => window.tuiLab.visibleText());
  const childTailNearComposer = (text) => {
    const rows = text.split("\n");
    const status = rows.findIndex((row) => row.includes("Agent status:"));
    const composer = rows.findIndex((row) =>
      row.includes("Esc returns to parent"),
    );
    return status >= 0 && composer > status && composer - status <= 4;
  };
  await captureStep(page, trace, "targeted-steer-agent-view", viewScreenshot);

  // Prove that visible text arrives before the durable response boundary.
  const liveProjectDir = await waitForProjectDirForSession(
    artifacts.configDir,
    sessionId,
    options.timeoutMs,
  );
  await waitForTerminalText(page, "tui-lab-child-line-020", options.timeoutMs);
  const earlyLiveText = await page.evaluate(() => window.tuiLab.visibleText());
  await captureStep(
    page,
    trace,
    "targeted-live-early",
    path.join(artifacts.dir, "targeted-live-early.png"),
  );
  await waitForTerminalText(page, "tui-lab-child-line-180", options.timeoutMs);
  const liveViewText = await page.evaluate(() => window.tuiLab.visibleText());
  const childPath = path.join(
    liveProjectDir,
    sessionId,
    "subagents",
    targetAgentId,
    "transcript.json",
  );
  const checkpointBeforeDone = await readFile(childPath, "utf8");
  const liveBeforeCheckpoint =
    earlyLiveText.includes("tui-lab-child-line-020") &&
    !earlyLiveText.includes("tui-lab-child-line-180") &&
    liveViewText.includes("tui-lab-child-line-180") &&
    !checkpointBeforeDone.includes("tui-lab-child-line-180");
  const tailNearComposer = [viewText, earlyLiveText, liveViewText].every(
    childTailNearComposer,
  );
  await captureStep(
    page,
    trace,
    "targeted-live-before-checkpoint",
    path.join(artifacts.dir, "targeted-live-before-checkpoint.png"),
  );

  await focusTerminal(page);
  await typeHumanText(page, sentinel);
  await page.keyboard.press("Enter");
  await waitForTerminalText(page, "Steering queued", options.timeoutMs);
  const queuedText = await page.evaluate(() => window.tuiLab.visibleText());
  await captureStep(page, trace, "targeted-steer-queued", queuedScreenshot);
  await waitForTerminalText(page, "Steering applied", options.timeoutMs);
  const appliedText = await page.evaluate(() => window.tuiLab.visibleText());
  await captureStep(page, trace, "targeted-steer-applied", appliedScreenshot);
  await waitForTerminalText(page, "tui-lab-child-line-180", options.timeoutMs);
  const longChildBottomText = await page.evaluate(() =>
    window.tuiLab.visibleText(),
  );
  // The child has earlier task/contract history before line 001. Stop
  // when the first output line is visible instead of paging past it.
  let longChildScrolledText = longChildBottomText;
  for (let step = 0; step < 32; step += 1) {
    if (textContainsAcrossWrap(longChildScrolledText, "tui-lab-child-line-001"))
      break;
    await pressRepeated(page, "PageUp", 1);
    longChildScrolledText = await page.evaluate(async (previous) => {
      const deadline = performance.now() + 1000;
      let last = previous;
      let stableFrames = 0;
      do {
        await new Promise(requestAnimationFrame);
        const current = window.tuiLab.visibleText();
        stableFrames = current === last ? stableFrames + 1 : 0;
        last = current;
        if (current !== previous && stableFrames >= 2) return current;
      } while (performance.now() < deadline);
      return last;
    }, longChildScrolledText);
  }
  await pressRepeated(page, "PageDown", 32);
  await page.waitForTimeout(250);
  const longChildRestoredBottomText = await page.evaluate(() =>
    window.tuiLab.visibleText(),
  );
  const completed = await waitForTargetedSubagentSteerEvidence(liveProjectDir, {
    targetAgentId,
    siblingAgentIds,
    sentinel,
    timeoutMs: options.timeoutMs,
  });
  if (!completed.hasAllRequired)
    throw new Error(
      "child tasks must finish before the synthetic collapsed-history probe",
    );
  const originalChildTranscript = await readFile(childPath, "utf8");
  let collapsedTailFilled = false;
  try {
    // This is a restored rendering fixture, not evidence of executed tools.
    const fixture = JSON.parse(originalChildTranscript);
    for (let index = 0; index < 100; index += 1) {
      fixture.push({
        role: "assistant",
        content: [
          {
            type: "text",
            text: `tui-lab-backfill-history-${String(index).padStart(3, "0")}`,
          },
        ],
      });
    }
    fixture.push({
      role: "assistant",
      content: Array.from({ length: 350 }, (_, index) => ({
        type: "tool_use",
        id: `backfill-read-${index}`,
        name: "read",
        input: { file_path: `fixture-${index}.md` },
      })),
    });
    fixture.push({
      role: "assistant",
      content: [{ type: "text", text: "TUI_LAB_COLLAPSED_TAIL_END" }],
    });
    await writeFile(childPath, JSON.stringify(fixture), { mode: 0o600 });
    await waitForTerminalText(
      page,
      "TUI_LAB_COLLAPSED_TAIL_END",
      options.timeoutMs,
    );
    const filledText = await page.evaluate(() => window.tuiLab.visibleText());
    const fillsTop = (text) =>
      text
        .split("\n")
        .slice(0, 3)
        .some((line) => line.includes("tui-lab-backfill-history-"));
    await captureStep(
      page,
      trace,
      "targeted-collapsed-tail-filled",
      path.join(artifacts.dir, "targeted-collapsed-tail-filled.png"),
    );
    await pressRepeated(page, "PageUp", 1);
    await page.waitForTimeout(250);
    await pressRepeated(page, "PageDown", 2);
    await waitForTerminalText(
      page,
      "TUI_LAB_COLLAPSED_TAIL_END",
      options.timeoutMs,
    );
    const returnedText = await page.evaluate(() => window.tuiLab.visibleText());
    collapsedTailFilled =
      fillsTop(filledText) &&
      fillsTop(returnedText) &&
      filledText.includes("tui-lab-backfill-history-099") &&
      returnedText.includes("tui-lab-backfill-history-099");
    await captureStep(
      page,
      trace,
      "targeted-collapsed-tail-returned",
      path.join(artifacts.dir, "targeted-collapsed-tail-returned.png"),
    );
  } finally {
    await writeFile(childPath, originalChildTranscript, { mode: 0o600 });
  }
  targetedSteerEvidence = {
    parentInputOrdered,
    pickerDescriptionVisible: agentListText.includes(
      "tui-lab-subagent-worker-sentinel",
    ),
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

  return { targetedSteerEvidence };
}
