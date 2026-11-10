import assert from 'node:assert/strict';

/** The provider's final SSE delta remains held while the real UI verifies a committed widget. */
export async function verifyProductionWidgetLifecycle(context, page, releaseFinal) {
  await page.getByText('WIDGET_FINAL_IS_HELD', { exact: true }).waitFor({ timeout: 30000 });
  // Re-enter the real running task so its durable transcript and live stream reconcile.
  await page.getByText('新建任务', { exact: true }).first().click();
  await page.getByText('Generate the completed widget history fixture.', { exact: true }).last().click();
  await page.getByTestId('pause-response-button').waitFor();
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => ({
    visibleHosts: [...document.querySelectorAll('[data-testid="inline-widget"]')].filter(node => !node.closest('[data-testid="widget-first-frame-probe"]')).length,
    statusRows: document.querySelectorAll('[data-testid="widget-deferred-status"]').length,
    running: Boolean(document.querySelector('[data-testid="pause-response-button"]')),
    messageRows: [...document.querySelectorAll('[data-message-id]')].map(node => ({ id: node.dataset.messageId, text: node.textContent?.slice(0, 400) })),
  }));
  await context.writeArtifactJson('held-final-widget-ownership.json', before);
  assert.equal(before.running, true, 'The model turn must still be active');
  assert.equal(before.visibleHosts, 0, 'No historical body segment may expand the current attempt before its final output');
  releaseFinal();
  await page.getByText('COMPLETED_WIDGET_HISTORY_END', { exact: true }).waitFor();
  await page.getByTestId('pause-response-button').waitFor({ state: 'hidden' });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => ({
    visibleHosts: [...document.querySelectorAll('[data-testid="inline-widget"]')].filter(node => !node.closest('[data-testid="widget-first-frame-probe"]')).length,
    ids: [...document.querySelectorAll('[data-testid="inline-widget"]')].map(node => node.dataset.widgetId),
  }));
  await context.writeArtifactJson('completed-final-widget-ownership.json', after);
  assert.equal(after.visibleHosts, 1, 'The completed attempt must display its artifact exactly once');
  return { heldFinal: true, visibleWhileRunning: before.visibleHosts, finalArtifacts: after.visibleHosts };
}
