import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { startChromium } from './chromium.mjs';
import { startGateway } from './gateway.mjs';
import { initializeRpc, openPageGatewayRpc, closeRpcAndWait } from './rpc.mjs';
import { assertRendererBuildFresh } from './renderer-build.mjs';
import { webNativeBinaryIdentity, webNativeModelOnlySettings } from './web-search-native-session.mjs';
import { observeFrontendInitialize, roundedMilliseconds as ms, signInAndWaitSidebar } from './browser-startup-observer.mjs';
import { materializeWorkspace } from './workspace-fixture.mjs';
import { runE2E, requireExecutable } from './run-context.mjs';

/** No source forwarding or inference response exists in this boundary fixture. */
export async function startStartupBoundary(context) {
  const counters = { modelGenerations: 0, modelMetadataRequests: 0, searchAttempts: 0, pageAttempts: 0, forbiddenConnects: 0 };
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.url === '/v1/models' && request.method === 'GET') { counters.modelMetadataRequests++; response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ object: 'list', data: [{ id: 'owned-search-model', object: 'model' }] })); return; }
    if (request.method === 'HEAD' && request.url?.startsWith('/v1')) { counters.modelMetadataRequests++; response.end(); return; }
    if (request.url === '/v1/chat/completions' && request.method === 'POST') counters.modelGenerations++;
    else if (/\/search|\/mcp/.test(request.url || '')) counters.searchAttempts++;
    else counters.pageAttempts++;
    request.resume(); response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Startup boundary forbids business requests' } }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', (_request, socket) => { counters.forbiddenConnects++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  context.addCleanup('close startup deny proxy and metadata-only model fixture', async () => {
    const done = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); server.closeAllConnections(); await done;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; context.registerPort('startup-boundary', port);
  return { counters, proxyUrl: `http://127.0.0.1:${port}`, modelUrl: `http://127.0.0.1:${port}/v1` };
}

export async function staticSearchComponents(binary) {
  const bin = dirname(binary), candidates = [resolve(bin, '../searxng'), resolve(bin, '../lib/kcoder/searxng'), resolve(bin, 'lib/kcoder/searxng')];
  return Promise.all(candidates.map(async path => {
    const manifest = resolve(path, 'runtime-manifest.json');
    const bytes = await readFile(manifest).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    return { path, manifestPresent: bytes !== null, manifestSha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null, scope: 'Static presence only; no service health or launch' };
  }));
}

async function ownedGatewayProcesses(pid) {
  const rows = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const text = await readFile(`/proc/${name}/status`, 'utf8').catch(() => '');
    const ppid = Number(text.match(/^PPid:\s+(\d+)/m)?.[1]); const comm = text.match(/^Name:\s+(.+)$/m)?.[1];
    if (ppid && comm) rows.push({ pid: Number(name), ppid, comm });
  }
  const owned = new Set([pid]); let previous = 0;
  while (owned.size !== previous) { previous = owned.size; for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid); }
  return rows.filter(row => owned.has(row.pid));
}

export async function runStartupSamples(sourceUrl, { group, ...metadata }) {
  assert.equal(process.platform, 'linux', 'This owned process-tree comparison requires the actual Linux host');
  const binary = await requireExecutable(process.env.KCODER_E2E_STARTUP_BIN, 'Explicit frozen startup binary');
  const expected = process.env.KCODER_E2E_STARTUP_SHA256; assert.match(expected || '', /^[0-9a-f]{64}$/);
  for (let sample = 1; sample <= 5; sample++) {
    await runE2E(sourceUrl, { ...metadata, testId: `startup-zero-business-${group}-${sample}`, group, sample, budgets: { modelRequests: 0, sourceQueries: 0, pageReads: 0, wallClockMs: 90000 }, retainSuccessEvidence: true }, async context => {
      context.abortSignal = AbortSignal.any([context.abortSignal, AbortSignal.timeout(90000)]);
      const identity = await webNativeBinaryIdentity(binary); assert.equal(identity.sha256, expected);
      const renderer = await assertRendererBuildFresh(), components = await staticSearchComponents(binary);
      const boundary = await startStartupBoundary(context);
      const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: `startup-${group}-${sample}` });
      const document = webNativeModelOnlySettings(boundary), settingsFile = await context.writeStateJson('config/settings.json', document), initial = await readFile(settingsFile);
      const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: '启动零业务验收', transport: 'local', runtime: 'kcoder', command: binary, workspace, settingsFile }]);
      const browser = await startChromium(context, { label: 'startup-browser' });
      const browserContext = await browser.browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'UTC' }); context.addCleanup('close startup browser context', () => browserContext.close());
      const page = await browserContext.newPage(), errors = [], methods = [], uiInitialize = observeFrontendInitialize(page);
      page.on('pageerror', error => errors.push(context.redactText(error.message)));
      page.on('websocket', socket => socket.on('framesent', ({ payload }) => { try { const frame = JSON.parse(String(payload)); if (frame.method) methods.push(frame.method); } catch { /* Method names only. */ } }));
      let rpc;
      const started = performance.now();
      const gateway = await startGateway(context, { label: 'startup-gateway', workspace, kcoderBin: binary, serversFile, serversStore: context.pathInState('servers-store.json'), auth: true,
        env: { KCODER_CONFIG_DIR: resolve(settingsFile, '..'), HTTP_PROXY: boundary.proxyUrl, HTTPS_PROXY: boundary.proxyUrl, ALL_PROXY: boundary.proxyUrl,
          http_proxy: boundary.proxyUrl, https_proxy: boundary.proxyUrl, all_proxy: boundary.proxyUrl, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' } });
      const listeningMs = ms(performance.now() - started);
      try {
        const sidebarReadyMs = ms(await signInAndWaitSidebar(page, gateway) - started);
        const observerStart = performance.now(); rpc = await openPageGatewayRpc(context, page, gateway, 'startup observer');
        const initialized = await initializeRpc(rpc, 'startup-zero-business'); const observerInitializeMs = ms(performance.now() - observerStart);
        const catalog = await rpc.request('runtime.models.list', {}); assert.ok(JSON.stringify(catalog).includes('owned-search-model'), 'The same model-only configuration must be valid in both CLI groups');
        const resources = await rpc.request('server/resources/read', {});
        assert.equal(resources.activity.runningTurns, 0); const processes = await ownedGatewayProcesses(gateway.child.pid);
        assert.ok(!processes.some(row => /python|searx/i.test(row.comm)), 'No owned SearXNG worker may start during the measured startup');
        assert.equal(boundary.counters.modelGenerations, 0); assert.equal(boundary.counters.searchAttempts, 0); assert.equal(boundary.counters.pageAttempts, 0); assert.equal(boundary.counters.forbiddenConnects, 0);
        assert.ok(!methods.some(method => method === 'turn/start' || method.startsWith('webSearch/probe/')));
        assert.deepEqual(await readFile(settingsFile), initial); assert.deepEqual(Object.keys(document).sort(), ['active_provider', 'providers']); assert.deepEqual(errors, []);
        const result = { group, sample, binary: { path: binary, ...identity }, renderer, components, resourceLookupOverrides: false,
          durations: { gatewayListeningMs: listeningMs, gatewaySidebarReadyMs: sidebarReadyMs, observerInitializeMs }, uiInitialize, counters: boundary.counters,
          methods, configuredModelPresent: true, resources, ownedProcesses: processes, noServiceWorkerObserved: true, noTurnOrProbe: true,
          comparisonScope: 'Same-host fresh owned profiles; small-sample startup timing, no public/model quality or native platform claim' };
        await context.writeArtifactJson('startup-zero-business.json', result);
        await closeRpcAndWait(rpc); rpc = null; await context.stopOwned('startup-gateway'); return result;
      } catch (error) { await context.writeArtifactJson('startup-zero-business-failure.json', { error: String(error), group, sample, binary: identity, counters: boundary.counters, methods, errors, body: (await page.locator('body').innerText()).slice(0, 12000) }); throw error; }
      finally { await closeRpcAndWait(rpc); await context.stopOwned('startup-gateway'); }
    });
  }
}
