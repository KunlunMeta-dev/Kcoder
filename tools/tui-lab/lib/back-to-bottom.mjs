import assert from 'node:assert/strict';
import path from 'node:path';
import { terminalCellGeometry } from './scroll-metrics.mjs';
import { captureStep } from './browser-evidence.mjs';
import { pressTerminalEscape, waitForTerminalText, waitForTerminalTextMissing } from './terminal-interaction.mjs';

/** Exercise actual xterm cells and PTY input; never invoke app internals. */
export async function verifyBackToBottom(page, trace, artifacts, { live = false } = {}) {
  const text = () => page.evaluate(() => window.tuiLab.visibleText());
  const wheelUp = async () => {
    const { box } = await terminalCellGeometry(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.wheel(0, -600);
    await waitForTerminalText(page, 'Back to bottom', 5000);
  };
  assert.equal(await page.evaluate(() => window.tuiLab.renderer), 'webgl');
  await waitForTerminalTextMissing(page, 'Back to bottom', 5000);
  if (live) await waitForTerminalText(page, 'tui-lab-final-line-020', 15000);
  const startedBeforeFinal = !(await text()).includes('tui-lab-final-sentinel');
  if (!live) await page.keyboard.insertText('unfinished draft');
  await wheelUp();
  await captureStep(page, trace, live ? 'back-to-bottom-live' : 'back-to-bottom-idle',
    path.join(artifacts.dir, live ? 'back-to-bottom-live.png' : 'back-to-bottom-idle.png'));
  const hit = await page.evaluate(() => window.tuiLab.textHitCells('Back to bottom')[0]);
  assert.ok(hit, 'Button must exist in visible terminal cells');
  const { box, cellWidth, cellHeight } = await terminalCellGeometry(page);
  await page.mouse.click(box.x + (hit.column + 2.5) * cellWidth, box.y + (hit.row + 0.5) * cellHeight);
  await waitForTerminalTextMissing(page, 'Back to bottom', 5000);
  const clickedText = await text();
  await wheelUp();
  await pressTerminalEscape(page, process.platform);
  await waitForTerminalTextMissing(page, 'Back to bottom', 5000);
  const escapedText = await text();
  assert.ok(!escapedText.includes('Cancelled.'), 'Returning to tail must preserve the active turn');
  if (live) assert.ok(startedBeforeFinal, 'Live button must be exercised before completion');
  else {
    assert.ok(clickedText.includes('tui-lab-final-sentinel') && escapedText.includes('tui-lab-final-sentinel'));
    assert.ok(clickedText.includes('unfinished draft') && escapedText.includes('unfinished draft'));
  }
  return { renderer: 'webgl', mouseClickReturnedToTail: true, escapeReturnedToTail: true,
    activeTurnPreserved: true, startedBeforeFinal };
}
