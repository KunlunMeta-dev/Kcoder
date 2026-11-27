import assert from 'node:assert/strict';
import { startChromium } from '../../e2e/harness/chromium.mjs';
import { startFixtureSite } from '../../e2e/harness/fixture-site.mjs';
import { gatewayRequestCounts, observeGatewayRequests } from '../../e2e/harness/gateway-request-counts.mjs';
import { runIntegration } from '../../e2e/harness/run-context.mjs';

const churn = process.env.KCODER_E2E_REQUEST_ROUTE_CHURN === '1';
await runIntegration(import.meta.url, {
  testId: 'chromium-request-observation', variantId: churn ? 'route-churn' : 'stable',
  tier: 'pr-smoke', retainSuccessLogs: true,
  modelPolicy: 'Owned browser and HTTP fixture; request observation only, no product or model backend',
}, async context => {
  const site = await startFixtureSite(context, { assets: {
    '/api/servers/status': { body: '{}', contentType: 'text/plain; charset=utf-8' },
  } });
  const origin = new URL(site.url).origin;
  let received = 0;
  const count = request => { if (request.url === '/api/servers/status') received++; };
  site.server.on('request', count);
  context.addCleanup('detach fixture request counter', () => site.server.off('request', count));
  const browser = await startChromium(context);
  const page = await browser.newPage();
  const phase = { name: 'reads', ...gatewayRequestCounts() };
  const { validate, directoryReads: directory } = await observeGatewayRequests(context, page, origin, () => phase);
  let playwrightRequests = 0;
  const observePage = value => { if (value.url() === `${origin}/api/servers/status`) playwrightRequests++; };
  page.on('request', observePage);
  context.addCleanup('detach page diagnostic counter', () => page.off('request', observePage));
  await page.goto(site.url);
  const pattern = '**/unused-owned-asset.js';
  const route = value => value.continue();
  for (let index = 0; index < 20; index++) {
    const read = page.evaluate(() => Promise.all(Array.from({ length: 4 }, () => fetch('/api/servers/status').then(r => r.text()))));
    if (churn) await page.route(pattern, route);
    await read;
    if (churn) await page.unroute(pattern, route);
  }
  validate();
  const result = { received, observedRequests: phase.http['GET /api/servers/status'] || 0, playwrightRequests,
    cdpRequests: directory.healthRequests.length, overflow: directory.overflow };
  await context.writeArtifactJson('request-observation.json', result);
  assert.equal(result.received, 80);
  assert.equal(result.cdpRequests, result.received);
  assert.equal(result.observedRequests, result.received);
  return result;
});
