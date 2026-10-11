import {
  focusTerminal,
  waitForTerminalText,
  typeHumanText,
} from "../terminal-interaction.mjs";
import { captureStep } from "../browser-evidence.mjs";
import { waitForRequestEvidence } from "../evidence.mjs";

export async function exerciseImagePaste({
  page,
  imagePasteEvidence,
  options,
  trace,
  artifacts,
}) {
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
  const submittedRequest = await waitForRequestEvidence(artifacts.requestsDir, {
    mustContain: ['"type": "image"', '"media_type": "image/png"'],
    timeoutMs: options.timeoutMs,
  });
  const followupText = "Does the previous clipboard image remain visible?";
  await focusTerminal(page);
  await typeHumanText(page, followupText);
  await page.keyboard.press("Enter");
  const contextRequest = await waitForRequestEvidence(artifacts.requestsDir, {
    mustContain: [followupText, '"type": "image"', '"media_type": "image/png"'],
    timeoutMs: options.timeoutMs,
  });
  await page.waitForTimeout(250);
  imagePasteEvidence.submittedText = await page.evaluate(() =>
    window.tuiLab.text(),
  );
  imagePasteEvidence.requestCaptured = submittedRequest.hasAllRequired;
  imagePasteEvidence.followupText = followupText;
  imagePasteEvidence.contextRequestCaptured = contextRequest.hasAllRequired;
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

  return {};
}
