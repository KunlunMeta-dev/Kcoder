/** Normal UI navigation only: no hidden RPC, permission changes, retry or task creation. */
async function requiredControl(page, id, boundary) {
  const control = page.getByTestId(id);
  if (await control.count() !== 1 || !await control.isVisible())
    throw new Error(`UNMET_PREREQUISITE: current UI does not expose ${boundary} required by this suite`);
  return control;
}

export async function openWorkflowTaskCreator(page) {
  await page.getByTestId('automations-button').click();
  await page.getByTestId('automation-tab-settings').click();
  await page.getByTestId('scheduled-task-kind').selectOption('workflow');
  await page.getByTestId('scheduled-workflow-tasks').waitFor({ state: 'visible', timeout: 10000 });
  const templates = await requiredControl(page, 'scheduled-builtin-templates', 'the advanced workflow subscription creator');
  if (await templates.getAttribute('aria-expanded') !== 'true') await templates.click();
  const advanced = await requiredControl(page, 'advanced-workflow-subscriptions', 'advanced workflow subscriptions');
  if (!await advanced.evaluate(element => element.parentElement.open)) await advanced.click();
  const form = await requiredControl(page, 'subscription-form-toggle', 'the subscription form');
  if (!await form.evaluate(element => element.parentElement.open)) await form.click();
  const limits = await requiredControl(page, 'subscription-limits-toggle', 'subscription limits');
  if (!await limits.evaluate(element => element.parentElement.open)) await limits.click();
}
export async function openScheduledTaskRecords(page) {
  await page.getByTestId('automations-button').click();
  await page.getByTestId('automation-tab-history').click();
}
export async function openWikiMemory(page) {
  await page.getByTestId('knowledge-button').click();
  await page.getByTestId('wiki-workspace-tab-memory').click();
}
export async function openWikiSharedKnowledge(page) {
  await page.getByTestId('knowledge-button').click();
  const shared = page.getByTestId('wiki-workspace-tab-shared');
  if (await shared.count() === 1 && await shared.isVisible()) { await shared.click(); return; }
  await page.getByTestId('wiki-workspace-tab-memory').click();
  await requiredControl(page, 'knowledge-publications', 'knowledge publications in the selected workspace');
}
export async function openWikiLibrary(page) {
  await page.getByTestId('knowledge-button').click();
  await page.getByTestId('wiki-workspace-tab-library').click();
}
