import {
  focusTerminal,
  typeHumanText,
  waitForComposerText,
  readComposerText,
} from "../terminal-interaction.mjs";
import path from "node:path";
import { captureStep } from "../browser-evidence.mjs";

export async function exerciseMention({
  page,
  options,
  artifacts,
  trace,
  mentionEvidence,
}) {
  const inputStart = await page.evaluate(
    () => window.tuiLab.inputEvents().length,
  );
  await focusTerminal(page);
  await typeHumanText(page, "/mention");
  await page.keyboard.press("Enter");
  await waitForComposerText(page, "@", options.timeoutMs);
  const prefilledComposer = await readComposerText(page);
  const prefilledScreenshot = path.join(artifacts.dir, "mention-prefilled.png");
  await captureStep(page, trace, "mention-prefilled", prefilledScreenshot);

  await typeHumanText(page, mentionEvidence.relativePath);
  await waitForComposerText(
    page,
    mentionEvidence.mentionText,
    options.timeoutMs,
  );
  const composedText = await readComposerText(page);
  const composedScreenshot = path.join(artifacts.dir, "mention-composed.png");
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
  const submittedScreenshot = path.join(artifacts.dir, "mention-submitted.png");
  await captureStep(page, trace, "mention-submitted", submittedScreenshot);
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

  return { mentionEvidence };
}
