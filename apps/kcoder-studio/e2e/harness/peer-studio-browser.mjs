import { startChromium } from './chromium.mjs';

/** Actual renderer entry and browser cookie login. The returned page retains
 * the normal UI ownership paths; this helper never injects a client subject.
 */
export async function openOwnedPeerStudioPage(context, gateway, { label = 'owned-peer-studio-chromium', waitForSidebar = true } = {}) {
  const browser = await startChromium(context, { label });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const diagnostics = [];
  page.on('pageerror', error => { if (diagnostics.length < 32) diagnostics.push({ kind: 'pageerror', message: String(error) }); });
  page.on('console', message => { if (message.type() === 'error' && diagnostics.length < 32) diagnostics.push({ kind: 'console', message: message.text() }); });
  try {
  await page.goto(gateway.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="token"]').fill(gateway.authToken);
  await Promise.all([page.waitForURL(url => !url.pathname.startsWith('/login')),
    page.locator('button[type="submit"]').click()]);
  for (const cookie of await page.context().cookies(gateway.baseUrl)) context.registerSecret(cookie.value);
  if (waitForSidebar) await page.getByTestId('desktop-sidebar').waitFor({ state: 'visible', timeout: 30_000 });
  return { page, baseUrl: gateway.baseUrl };
  } catch (error) {
    await context.writeArtifactJson(`${label}-startup-failure.json`, { diagnostics,
      body: await page.locator('body').innerText().catch(() => ''), phase: 'authenticated-renderer-startup' });
    await page.screenshot({ path: context.pathInArtifacts(`${label}-startup-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  }
}
