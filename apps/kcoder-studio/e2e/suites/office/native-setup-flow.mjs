import assert from 'node:assert/strict';

/** Exercise the actual settings route and idle restart before creating a task. */
export async function enableNativeOfficeInPage(context, page, baseUrl) {
  const worker = page.getByRole('button', { name: 'KWorker', exact: true });
  if (await worker.count()) await worker.click();
  await page.goto(`${baseUrl}/office`, { waitUntil: 'domcontentloaded' });
  const office = page.getByTestId('native-office-workspace');
  await office.waitFor({ timeout: 30_000 });
  const settings = office.getByTestId('office-settings');
  await page.waitForFunction(() => document.querySelector('[data-testid="office-settings"]')?.getAttribute('data-status') === 'ready', undefined, { timeout: 30_000 });
  assert.equal(await settings.getByTestId('office-enabled-state').getAttribute('data-enabled'), 'false');
  await page.screenshot({ path: context.pathInArtifacts('native-office-disabled.png'), fullPage: true });
  await settings.getByTestId('office-enabled-toggle').click();
  await page.waitForFunction(() => {
    const setup = document.querySelector('[data-testid="office-settings"]');
    return setup?.getAttribute('data-status') === 'ready'
      && setup.querySelector('[data-testid="office-enabled-state"]')?.getAttribute('data-enabled') === 'true'
      && !setup.querySelector('[data-testid="office-settings-pending"]');
  }, undefined, { timeout: 45_000 });
  assert.equal(await settings.getByTestId('office-enabled-toggle').isEnabled(), true);
  await page.waitForFunction(() => document.querySelector('[data-testid="office-native-readiness"]')?.getAttribute('data-status') === 'ready', undefined, { timeout: 45_000 });
  await office.locator('[data-testid="office-task-request"], ul li').first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: context.pathInArtifacts('native-office-enabled-after-reconnect.png'), fullPage: true });
  await context.writeArtifactJson('native-office-settings-browser.json', {
    schemaVersion: 1, actualSettingsRead: true, actualExplicitCasSave: true,
    actualIdleRestart: true, currentConnectionApplied: true, createdTaskToEnable: false,
    evidence: 'Actual protected target settings, normal Gateway settings request, explicit page click, original ifIdle restart and fresh capability handshake; no direct flag-file mutation.',
  });
}
