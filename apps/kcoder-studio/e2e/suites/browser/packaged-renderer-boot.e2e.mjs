import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runE2E } from '../../harness/run-context.mjs';
import { startGateway } from '../../harness/gateway.mjs';
import { startChromium } from '../../harness/chromium.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

await runE2E(import.meta.url, {
  testId: 'shipped-production-renderer-boot-diagnostic', tier: 'manual-live', retainSuccessLogs: true,
  modelPolicy: 'One shipped renderer boot in owned Chromium/Gateway; no model turn, Windows host or personal profile.',
}, async context => {
  const resources = process.env.KCODER_E2E_PACKAGED_RESOURCES;
  assert.ok(resources && resources === resolve(resources));
  const candidate = process.env.KCODER_E2E_CANDIDATE_RENDERER_ROOT ?? process.env.KCODER_E2E_RENDERER_ROOT;
  if (candidate) assert.equal(candidate, resolve(candidate));
  const webRoot = candidate ?? resolve(resources, 'renderer-dist');
  const index = await readFile(resolve(webRoot, 'index.html'));
  assert.equal(createHash('sha256').update(index).digest('hex'), process.env.KCODER_E2E_RENDERER_INDEX_SHA256);
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'shipped-boot' });
  const config = context.pathInState('native-profile');
  await context.writeStateJson('native-profile/settings.json', { providers: {} });
  const gateway = await startGateway(context, { gatewayRoot: resolve(resources, 'gateway'), workspace: workspace.path,
    auth: true, serversStore: context.pathInState('servers.json'), env: {
      KCODER_STUDIO_WEB_ROOT: webRoot, KCODER_CONFIG_DIR: config, KCODER_HOME: config,
    } });
  const chromium = await startChromium(context, { label: 'shipped-renderer-boot' });
  const page = await chromium.newPage({ viewport: { width: 1365, height: 900 } });
  const diagnostics = { errors: [], console: [], failedRequests: [], failedResponses: [], gatewayResources: resources,
    rendererRoot: webRoot, rendererIndexSha256: createHash('sha256').update(index).digest('hex') };
  page.on('pageerror', error => { if (diagnostics.errors.length < 12) diagnostics.errors.push({ message: error.message, stack: error.stack }); });
  page.on('console', message => { if (['error', 'warning'].includes(message.type()) && diagnostics.console.length < 20)
    diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 2000) }); });
  page.on('requestfailed', request => { if (diagnostics.failedRequests.length < 20)
    diagnostics.failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }); });
  page.on('response', response => { if (response.status() >= 400 && diagnostics.failedResponses.length < 20)
    diagnostics.failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  let response;
  try {
    response = await page.goto(gateway.baseUrl + '/login?token=' + encodeURIComponent(gateway.authToken), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByTestId('chat-message-input').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('main').first().waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(3000);
    diagnostics.path = new URL(page.url()).pathname;
    diagnostics.csp = response?.headers()['content-security-policy'];
    diagnostics.dom = await page.evaluate(() => ({ rootChildren: document.getElementById('root')?.childElementCount ?? 0,
      bodyText: document.body.innerText.slice(0, 3000), title: document.title }));
    diagnostics.appMainVisible = await page.locator('main').first().isVisible();
    diagnostics.composerVisible = await page.getByTestId('chat-message-input').isVisible();
    assert.equal(diagnostics.errors.length, 0, diagnostics.errors.map(row => row.message).join('; '));
    assert.ok(diagnostics.dom.rootChildren > 0, 'Shipped renderer root did not mount');
    assert.equal(diagnostics.appMainVisible, true); assert.equal(diagnostics.composerVisible, true);
    assert.deepEqual(diagnostics.failedRequests, []); assert.deepEqual(diagnostics.failedResponses, []);
    return { rendererRole: candidate ? 'candidate' : 'shipped', actualPackagedGateway: true,
      rootMounted: true, appMainVisible: true, composerVisible: true, modelCalls: 0, windowsHostAcceptance: false };
  } finally {
    diagnostics.path ??= new URL(page.url()).pathname;
    diagnostics.csp ??= response?.headers()['content-security-policy'];
    diagnostics.dom ??= await page.evaluate(() => ({ rootChildren: document.getElementById('root')?.childElementCount ?? 0,
      bodyText: document.body.innerText.slice(0, 3000), title: document.title })).catch(() => null);
    await page.screenshot({ path: context.pathInArtifacts('shipped-renderer-boot.png') }).catch(() => {});
    await context.writeArtifactJson('shipped-renderer-boot.json', diagnostics);
  }
});
