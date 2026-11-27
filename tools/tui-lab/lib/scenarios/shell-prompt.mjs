import process from "node:process";
import {
  focusTerminal,
  typeHumanText,
  waitForShellComposerText,
  readShellComposerText,
  waitForTerminalText,
} from "../terminal-interaction.mjs";
import path from "node:path";
import { captureStep } from "../browser-evidence.mjs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { formatError } from "../runtime-artifacts.mjs";

export async function exerciseShellPrompt({
  page,
  options,
  artifacts,
  trace,
  shellPromptEvidence,
}) {
  const commandText =
    process.platform === "win32"
      ? "Write-Output ('tui-shell-output-' + [char]0x6606 + [char]0x4ED1)"
      : "printf 'tui-shell-output-\\346\\230\\206\\344\\273\\221\\n'";
  const historyText = `!${commandText}`;
  const marker = "tui-shell-output-\u6606\u4ed1";
  const inputStart = await page.evaluate(
    () => window.tuiLab.inputEvents().length,
  );
  const secondTurnSentinelsBefore = await page.evaluate(
    () =>
      (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
        .length,
  );

  await focusTerminal(page);
  await typeHumanText(page, historyText);
  await waitForShellComposerText(page, commandText, options.timeoutMs);
  const composedText = await readShellComposerText(page);
  const composedScreenshot = path.join(
    artifacts.dir,
    "shell-prompt-composed.png",
  );
  await captureStep(page, trace, "shell-prompt-composed", composedScreenshot);

  await page.keyboard.press("Enter");
  await waitForTerminalText(page, marker, options.timeoutMs);
  await page.waitForTimeout(500);
  const afterText = await page.evaluate(() => window.tuiLab.text());
  const afterScreenshot = path.join(artifacts.dir, "shell-prompt-finished.png");
  await captureStep(page, trace, "shell-prompt-finished", afterScreenshot);
  const secondTurnSentinelsAfter = await page.evaluate(
    () =>
      (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
        .length,
  );

  await page.keyboard.press("ArrowUp");
  await waitForShellComposerText(page, commandText, options.timeoutMs);
  const restoredComposer = await readShellComposerText(page);
  const restoredScreenshot = path.join(
    artifacts.dir,
    "shell-prompt-history-restored.png",
  );
  await captureStep(
    page,
    trace,
    "shell-prompt-history-restored",
    restoredScreenshot,
  );
  await page.keyboard.press("Control+U");

  const cancelCommand =
    process.platform === "win32"
      ? "Write-Output ('tui-shell-cancel-' + 'start'); Start-Sleep -Seconds 5; Set-Content -LiteralPath 'tui-shell-cancel-tail.txt' -Value 'forbidden'"
      : "printf 'tui-shell-cancel-%s\\n' start; sleep 5; printf forbidden > tui-shell-cancel-tail.txt";
  const cancelHistoryText = `!${cancelCommand}`;
  const cancelTailPath = path.join(
    artifacts.workspace,
    "tui-shell-cancel-tail.txt",
  );
  await focusTerminal(page);
  await typeHumanText(page, cancelHistoryText);
  await waitForShellComposerText(page, cancelCommand, options.timeoutMs);
  await page.keyboard.press("Enter");
  await waitForTerminalText(
    page,
    "esc interrupt",
    Math.min(options.timeoutMs, 10000),
  );
  const cancelStartedAt = Date.now();
  const cancelRunningText = await page.evaluate(() => window.tuiLab.text());
  const cancelRunningScreenshot = path.join(
    artifacts.dir,
    "shell-prompt-cancel-running.png",
  );
  await captureStep(
    page,
    trace,
    "shell-prompt-cancel-running",
    cancelRunningScreenshot,
  );
  await page.keyboard.press("Escape");
  await waitForTerminalText(
    page,
    "Cancelled.",
    Math.min(options.timeoutMs, 10000),
  );
  const cancelElapsedMs = Date.now() - cancelStartedAt;
  await page.waitForTimeout(1500);
  const cancelledText = await page.evaluate(() => window.tuiLab.text());
  const cancelFinishedScreenshot = path.join(
    artifacts.dir,
    "shell-prompt-cancelled.png",
  );
  await captureStep(
    page,
    trace,
    "shell-prompt-cancelled",
    cancelFinishedScreenshot,
  );
  await page.waitForTimeout(5000);
  const cancelTailFileExists = existsSync(cancelTailPath);

  const recoveryCommand =
    process.platform === "win32"
      ? "Write-Output ('tui-shell-' + 'recovered')"
      : "printf 'tui-shell-%s\\n' recovered";
  const recoveryHistoryText = `!${recoveryCommand}`;
  const recoveryMarker = "tui-shell-recovered";
  await focusTerminal(page);
  await typeHumanText(page, recoveryHistoryText);
  await waitForShellComposerText(page, recoveryCommand, options.timeoutMs);
  await page.keyboard.press("Enter");
  await waitForTerminalText(page, recoveryMarker, options.timeoutMs);
  await page.waitForTimeout(500);
  const recoveredText = await page.evaluate(() => window.tuiLab.text());
  const recoveryScreenshot = path.join(
    artifacts.dir,
    "shell-prompt-recovered.png",
  );
  await captureStep(page, trace, "shell-prompt-recovered", recoveryScreenshot);
  const secondTurnSentinelsAfterAllShellCommands = await page.evaluate(
    () =>
      (window.tuiLab.text().match(/tui-lab-second-turn-sentinel/g) || [])
        .length,
  );

  let inputHistoryEntries = [];
  let inputHistoryError;
  try {
    const inputHistoryPath = path.join(
      artifacts.configDir,
      "history",
      "input_history.jsonl",
    );
    inputHistoryEntries = (await readFile(inputHistoryPath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    inputHistoryError = formatError(error);
  }
  const inputEvents = await page.evaluate(
    (start) => window.tuiLab.inputEvents().slice(start),
    inputStart,
  );
  shellPromptEvidence = {
    commandText,
    historyText,
    marker,
    composedText,
    afterText,
    restoredComposer,
    secondTurnSentinelsBefore,
    secondTurnSentinelsAfter,
    secondTurnSentinelsAfterAllShellCommands,
    cancelCommand,
    cancelHistoryText,
    cancelTailPath,
    cancelTailFileExists,
    cancelElapsedMs,
    cancelRunningText,
    cancelledText,
    recoveryCommand,
    recoveryHistoryText,
    recoveryMarker,
    recoveredText,
    inputHistoryEntries,
    inputHistoryError,
    inputEvents,
    expectedTool: process.platform === "win32" ? "PowerShell" : "bash",
    screenshots: {
      composed: composedScreenshot,
      finished: afterScreenshot,
      historyRestored: restoredScreenshot,
      cancelRunning: cancelRunningScreenshot,
      cancelled: cancelFinishedScreenshot,
      recovered: recoveryScreenshot,
    },
  };

  return { shellPromptEvidence };
}
