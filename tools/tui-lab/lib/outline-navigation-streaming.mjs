import { readFile, readdir } from "node:fs/promises";
import {
  OUTLINE_MARKERS as m,
  verifyOutlineTargetVisible,
} from "./outline-navigation-fixture.mjs";
import {
  pressTerminalEscape,
  submitTerminalLine,
} from "./terminal-interaction.mjs";

export async function runOutlineStreamingProbe({
  page,
  history,
  requestsDir,
  capture,
  check,
  waitVisible,
  waitTarget,
  inline,
  timeoutMs,
}) {
  const final = "tui-lab-final-sentinel";
  await submitTerminalLine(
    page,
    "OUTLINE_STREAMING_TASK complete the deterministic scrolling test",
  );
  // A second real request means the tool result returned and the final answer is streaming with delay.
  const requestDeadline = Date.now() + Math.min(timeoutMs, 60_000);
  let requestsStarted = false;
  while (Date.now() < requestDeadline) {
    if (
      (await readdir(requestsDir)).filter((name) =>
        /^request_.*\.json$/.test(name),
      ).length >= 2
    ) {
      requestsStarted = true;
      break;
    }
    await page.waitForTimeout(150);
  }
  check("final-stream-provider-request-started", requestsStarted);
  await submitTerminalLine(page, `/outline ${m.duplicateTitle}`);
  await waitVisible("Conversation outline ·");
  await page.waitForFunction(
    (needle) =>
      window.tuiLab
        .textHitCells(needle)
        .filter((hit) => !hit.text.includes("Search:")).length >= 2,
    m.duplicateTitle,
    { timeout: 30_000 },
  );
  const hit = await page.evaluate((needle) => {
    const target = window.tuiLab
      .textHitCells(needle)
      .filter((hit) => !hit.text.includes("Search:"))[1];
    const rect = document
      .querySelector(".xterm-screen")
      .getBoundingClientRect();
    const { cols, rows } = window.tuiLab.dimensions();
    return {
      x: rect.x + ((target.column + 0.5) * rect.width) / cols,
      y: rect.y + ((target.row + 0.5) * rect.height) / rows,
    };
  }, m.duplicateTitle);
  await page.mouse.move(hit.x, hit.y);
  await page.mouse.down({ button: "left" });
  await page.waitForTimeout(80);
  await page.mouse.up({ button: "left" });
  await waitTarget("10-streaming-target");
  const before = await capture("10-target-during-stream");
  check(
    "old-source-visible-while-streaming",
    verifyOutlineTargetVisible(before),
  );
  check(
    "selection-precedes-final-commit",
    !(await readFile(history, "utf8")).includes(final),
  );
  if (inline)
    check(
      "streaming-inline-history-layer-visible",
      before.includes("History ·"),
    );

  const deadline = Date.now() + Math.min(timeoutMs, 60_000);
  let completed = false;
  while (Date.now() < deadline) {
    if ((await readFile(history, "utf8")).includes(final)) {
      completed = true;
      break;
    }
    await page.waitForTimeout(150);
  }
  check("background-turn-completes-with-retained-evidence", completed);
  await page.waitForTimeout(500);
  const after = await capture("11-old-target-after-stream-completes");
  check(
    "completed-output-does-not-steal-lookback",
    verifyOutlineTargetVisible(after),
  );
  check(
    "live-tail-does-not-write-through-history-view",
    !after.includes(final),
  );
  if (inline) {
    check(
      "inline-history-layer-survives-completion",
      after.includes("History ·"),
    );
    await pressTerminalEscape(page, process.platform);
    await waitVisible("History ·", false);
  }
  await submitTerminalLine(page, "/jump latest");
  await waitVisible(final);
  check(
    "latest-restores-follow-after-new-output",
    (await capture("12-follow-new-live-tail")).includes(final),
  );
}
