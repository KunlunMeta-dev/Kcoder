import {
  focusTerminal,
  waitForTerminalText,
  waitForComposerText,
} from "../terminal-interaction.mjs";
import path from "node:path";
import { captureStep } from "../browser-evidence.mjs";

export async function exercisePaste({
  page,
  options,
  artifacts,
  trace,
  pasteEvidence,
}) {
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
    (payload) => window.tuiLab.sendInput(`\u001b[200~${payload}\u001b[201~`),
    smallPastedRaw,
  );
  await waitForTerminalText(page, "paste-small-third-line", options.timeoutMs);
  await page.waitForTimeout(250);
  const smallComposerText = await page.evaluate(() => window.tuiLab.text());
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
    (payload) => window.tuiLab.sendInput(`\u001b[200~${payload}\u001b[201~`),
    largePasted,
  );
  await waitForComposerText(
    page,
    largePlaceholder,
    Math.min(options.timeoutMs, 15000),
  );
  await page.waitForTimeout(250);
  const largeComposerText = await page.evaluate(() => window.tuiLab.text());
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
  const largeSubmittedText = await page.evaluate(() => window.tuiLab.text());
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

  return { pasteEvidence };
}
