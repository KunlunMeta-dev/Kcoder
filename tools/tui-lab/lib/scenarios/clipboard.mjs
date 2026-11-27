import {
  focusTerminal,
  waitForTerminalText,
  typeHumanText,
  waitForTerminalTextState,
} from "../terminal-interaction.mjs";
import path from "node:path";
import { captureStep } from "../browser-evidence.mjs";
import process from "node:process";
import { spawnSync } from "node:child_process";

export async function exerciseClipboard({
  page,
  options,
  artifacts,
  trace,
  clipboardScreenshot,
  clipboardEvidence,
}) {
  const nativeSelectionInputStart = await page.evaluate(
    () => window.tuiLab.inputEvents().length,
  );
  const nativeSelectionText = await page.evaluate(() =>
    window.tuiLab.selectAll(),
  );
  await page.keyboard.press("Control+C");
  const nativeSelectionInputEvents = await page.evaluate(
    (start) => window.tuiLab.inputEvents().slice(start),
    nativeSelectionInputStart,
  );
  await page.evaluate(() => window.tuiLab.clearSelection());

  await focusTerminal(page);
  const noSelectionCtrlCInputStart = await page.evaluate(
    () => window.tuiLab.inputEvents().length,
  );
  await page.keyboard.press("Control+C");
  await waitForTerminalText(page, "ctrl + c again to quit", options.timeoutMs);
  const noSelectionCtrlCInputEvents = await page.evaluate(
    (start) => window.tuiLab.inputEvents().slice(start),
    noSelectionCtrlCInputStart,
  );
  const firstIdleCtrlCShowsQuitHint = (
    await page.evaluate(() => window.tuiLab.text())
  ).includes("ctrl + c again to quit");
  const quitHintScreenshot = path.join(
    artifacts.dir,
    "after-first-idle-ctrl-c.png",
  );
  await captureStep(page, trace, "after-first-idle-ctrl-c", quitHintScreenshot);

  await focusTerminal(page);
  await typeHumanText(page, "/copy");
  await page.keyboard.press("Enter");
  await waitForTerminalText(
    page,
    "Copied last message to clipboard",
    options.timeoutMs,
  );
  await page.waitForTimeout(250);
  await captureStep(page, trace, "after-copy", clipboardScreenshot);

  const markerReset = overwriteWindowsClipboardForTest(
    `WINDOWS_CLIPBOARD_BEFORE_CTRL_O_${Date.now()}`,
  );
  const copyNoticeCount = await page.evaluate(
    () =>
      (window.tuiLab.text().match(/Copied last message to clipboard/g) || [])
        .length,
  );
  const shortcutInputStart = await page.evaluate(
    () => window.tuiLab.inputEvents().length,
  );
  await page.keyboard.press("Control+O");
  await page.waitForFunction(
    (previousCount) =>
      (window.tuiLab.text().match(/Copied last message to clipboard/g) || [])
        .length > previousCount,
    copyNoticeCount,
    { timeout: options.timeoutMs },
  );
  const shortcutInputEvents = await page.evaluate(
    (start) => window.tuiLab.inputEvents().slice(start),
    shortcutInputStart,
  );
  const afterCopyShortcutScreenshot = path.join(
    artifacts.dir,
    "after-copy-shortcut.png",
  );
  await captureStep(
    page,
    trace,
    "after-copy-shortcut",
    afterCopyShortcutScreenshot,
  );

  await focusTerminal(page);
  await typeHumanText(page, "/raw on");
  await page.keyboard.press("Enter");
  await waitForTerminalText(
    page,
    "Raw output mode on: transcript text is shown for clean terminal selection.",
    options.timeoutMs,
  );
  await page.waitForTimeout(250);
  const rawOnCommandText = await page.evaluate(() => window.tuiLab.text());
  const rawOnCommandScreenshot = path.join(artifacts.dir, "raw-on-command.png");
  await captureStep(page, trace, "raw-on-command", rawOnCommandScreenshot);

  await focusTerminal(page);
  await typeHumanText(page, "/raw off");
  await page.keyboard.press("Enter");
  await waitForTerminalText(
    page,
    "Raw output mode off: rich transcript rendering restored.",
    options.timeoutMs,
  );
  await page.waitForTimeout(250);
  const rawOffCommandText = await page.evaluate(() => window.tuiLab.text());
  const rawOffCommandScreenshot = path.join(
    artifacts.dir,
    "raw-off-command.png",
  );
  await captureStep(page, trace, "raw-off-command", rawOffCommandScreenshot);

  const rawShortcutInputStart = await page.evaluate(
    () => window.tuiLab.inputEvents().length,
  );
  await page.keyboard.press("Alt+R");
  await waitForTerminalTextState(page, "```", true, options.timeoutMs);
  const rawOnShortcutText = await page.evaluate(() => window.tuiLab.text());
  const rawOnShortcutScreenshot = path.join(
    artifacts.dir,
    "raw-on-shortcut.png",
  );
  await captureStep(page, trace, "raw-on-shortcut", rawOnShortcutScreenshot);
  await page.keyboard.press("Alt+R");
  await waitForTerminalTextState(page, "```", false, options.timeoutMs);
  const rawOffShortcutText = await page.evaluate(() => window.tuiLab.text());
  const rawOffShortcutScreenshot = path.join(
    artifacts.dir,
    "raw-off-shortcut.png",
  );
  await captureStep(page, trace, "raw-off-shortcut", rawOffShortcutScreenshot);
  const rawShortcutInputEvents = await page.evaluate(
    (start) => window.tuiLab.inputEvents().slice(start),
    rawShortcutInputStart,
  );
  clipboardEvidence = {
    nativeSelectionText,
    nativeSelectionInputEvents,
    noSelectionCtrlCInputEvents,
    firstIdleCtrlCShowsQuitHint,
    markerReset,
    shortcutInputEvents,
    rawShortcutInputEvents,
    rawOnCommandHasFence: rawOnCommandText.includes("```"),
    rawOffCommandHasFence: rawOffCommandText.includes("```"),
    rawOnShortcutHasFence: rawOnShortcutText.includes("```"),
    rawOffShortcutHasFence: rawOffShortcutText.includes("```"),
    screenshots: {
      quitHint: quitHintScreenshot,
      afterCopyShortcut: afterCopyShortcutScreenshot,
      rawOnCommand: rawOnCommandScreenshot,
      rawOffCommand: rawOffCommandScreenshot,
      rawOnShortcut: rawOnShortcutScreenshot,
      rawOffShortcut: rawOffShortcutScreenshot,
    },
  };

  return { clipboardEvidence };
}

export function overwriteWindowsClipboardForTest(marker) {
  if (process.platform !== "win32") {
    return {
      ok: true,
      skipped: true,
      reason: "native marker reset is Windows-only",
    };
  }
  const escaped = marker.replaceAll("'", "''");
  const result = spawnSync(
    process.env.KCODER_TUI_LAB_POWERSHELL || "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Set-Clipboard -Value '${escaped}'`,
    ],
    { encoding: "utf8" },
  );
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: result.stderr?.trim() || "",
  };
}
