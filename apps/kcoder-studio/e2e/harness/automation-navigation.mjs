/** Normal UI navigation only: no hidden RPC, permission changes, retry or task creation. */
export async function openWorkflowTaskCreator(page) {
  await page.getByTestId('automations-button').click();
  await page.getByTestId('automation-tab-settings').click();
  await page.getByTestId('scheduled-task-kind').selectOption('workflow');
  const templates = page.getByTestId('scheduled-builtin-templates');
  if (await templates.getAttribute('aria-expanded') !== 'true') await templates.click();
  const advanced = page.getByTestId('advanced-workflow-subscriptions');
  if (!await advanced.evaluate(element => element.parentElement.open)) await advanced.click();
  const form = page.getByTestId('subscription-form-toggle');
  if (!await form.evaluate(element => element.parentElement.open)) await form.click();
  const limits = page.getByTestId('subscription-limits-toggle');
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
  await page.getByTestId('wiki-workspace-tab-shared').click();
}
export async function openWikiLibrary(page) {
  await page.getByTestId('knowledge-button').click();
  await page.getByTestId('wiki-workspace-tab-library').click();
}
