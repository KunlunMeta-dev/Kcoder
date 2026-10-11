import {
  focusTerminal,
  typeHumanText,
  waitForTerminalText,
  waitForComposerText,
  readComposerText,
  waitForTerminalTextMissing,
  tryWaitForTerminalText,
} from "../terminal-interaction.mjs";
import { captureStep } from "../browser-evidence.mjs";
import path from "node:path";

export async function exerciseHistorySearch({
  page,
  options,
  trace,
  artifacts,
  historySearchEvidence,
}) {
  const oldest = "windows-history-alpha oldest";
  const newest = "windows-history-alpha newest";
  const originalDraft = "windows history draft survives cancel";
  for (const [name, message] of [
    ["oldest", oldest],
    ["newest", newest],
  ]) {
    const previousSentinels = await page.evaluate(
      () =>
        (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
          .length,
    );
    await focusTerminal(page);
    await typeHumanText(page, message);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (previousCount) =>
        (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
          .length > previousCount,
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
  await captureStep(page, trace, "history-search-newest", newestScreenshot);

  await page.keyboard.press("Control+R");
  await waitForComposerText(page, oldest, options.timeoutMs);
  const oldestComposer = await readComposerText(page);
  const oldestScreenshot = path.join(
    artifacts.dir,
    "history-search-oldest.png",
  );
  await captureStep(page, trace, "history-search-oldest", oldestScreenshot);
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
  await captureStep(page, trace, "history-search-no-match", noMatchScreenshot);
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

  return { historySearchEvidence };
}
