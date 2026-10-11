import path from "node:path";
import {
  focusTerminal,
  typeHumanText,
  waitForTerminalText,
  pressTerminalEscape,
} from "../terminal-interaction.mjs";
import process from "node:process";
import { captureStep } from "../browser-evidence.mjs";

export async function exerciseAgentStop({
  artifacts,
  page,
  options,
  targetedStopEvidence,
  trace,
}) {
  const stopScreenshot = path.join(artifacts.dir, "targeted-stop-result.png");
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
  if (agentRows.length < 2) {
    throw new Error(
      `targeted stop scenario expected two sub-agents, found ${agentRows.length}`,
    );
  }
  const targetAgentId = agentRows[0].agentId;
  const siblingAgentIds = agentRows.slice(1).map((row) => row.agentId);
  targetedStopEvidence = {
    targetAgentId,
    siblingAgentIds,
    agentListCount: agentRows.length,
    allAgentsWereRunning: agentRows.every((row) => row.status === "running"),
    commandVisible: false,
    artifacts: null,
    screenshot: stopScreenshot,
  };
  await page.evaluate(() => window.tuiLab.focus());
  await pressTerminalEscape(page, process.platform);
  await typeHumanText(page, `/stop ${targetAgentId}`);
  await page.keyboard.press("Enter");
  await waitForTerminalText(
    page,
    `Stopping 1 background task(s): ${targetAgentId}`,
    options.timeoutMs,
  );
  targetedStopEvidence.commandVisible = true;
  await captureStep(page, trace, "targeted-stop-result", stopScreenshot);

  return { targetedStopEvidence };
}
