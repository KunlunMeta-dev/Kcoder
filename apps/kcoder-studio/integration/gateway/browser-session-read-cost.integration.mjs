import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { get } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createMobileDeviceAuth, mobileDeviceStoreIdentity } from '../../src/mobile-device-auth.js';
import { RUNTIME_ACTIVITY_CHANGED } from '../../shared/runtimeActivityEvents.js';
import { observeAuthReads, summarizeAuthFileTrace, holdAuthStoreMutex } from '../../e2e/harness/auth-read-cost.mjs';
import { startApprovalModelFixture } from '../../e2e/harness/approval-model.mjs';
import { startGateway } from '../../e2e/harness/gateway.mjs';
import { startChromium } from '../../e2e/harness/chromium.mjs';
import { fingerprintRendererSource } from '../../e2e/harness/settings-fingerprints.mjs';
import { login } from '../../e2e/harness/http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from '../../e2e/harness/rpc.mjs';
import { repoRoot, requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';

const clockUs = () => Number(process.hrtime.bigint() / 1000n);
async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function ledgerSnapshot(path) {
  const info = await stat(path, { bigint: true });
  return { sha256: await digestFile(path), ...Object.fromEntries(
    ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, String(info[key])])) };
}

await runIntegration(import.meta.url, { testId: 'browser-session-read-cost', tier: 'full-integration',
  modelPolicy: 'Owned authenticated Gateway and real Rust app-server with controlled loopback SSE. Linux Node filesystem counts, not renderer, installed-package, public-network or live-model performance.' }, async context => {
  assert.equal(process.platform, 'linux', 'UNMET_PREREQUISITE: shared monotonic Linux filesystem tracing');
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'Native app-server');
  const binarySha = await digestFile(binary);
  if (process.env.KCODER_E2E_KCODER_BIN_SHA256) assert.equal(binarySha, process.env.KCODER_E2E_KCODER_BIN_SHA256);
  const workspace = await materializeWorkspace(context, 'minimal', { instanceId: 'auth-read-cost' });
  const profile = context.pathInState('profile'), data = context.pathInState('gateway-data'), web = context.pathInState('web');
  await Promise.all([profile, data, web].map(path => mkdir(path, { mode: 0o700 })));
  const staticCode = `export const text=${JSON.stringify('owned static code '.repeat(8000))};`;
  await writeFile(resolve(web, 'large.js'), staticCode);
  await mkdir(resolve(web, 'assets'));
  await writeFile(resolve(web, 'assets/entry-1234ABCD.js'), staticCode);
  await writeFile(resolve(web, 'index.html'), '<html><head></head><body>owned static fixture</body></html>');
  const rendererRoot = resolve(repoRoot, 'apps/kcoder-studio/renderer');
  const { build } = createRequire(resolve(rendererRoot, 'package.json'))('vite');
  const sourceBefore = await fingerprintRendererSource(rendererRoot);
  const transportEntry = resolve(repoRoot, 'apps/kcoder-studio/e2e/fixtures/runtime-read-cost-entry.ts');
  const entrySha256 = await digestFile(transportEntry);
  const transportBuild = await build({ configFile: false, envFile: false, root: rendererRoot, logLevel: 'error',
    resolve: { alias: { '@': resolve(rendererRoot, 'src') } },
    define: { 'process.env.NODE_ENV': JSON.stringify('production'),
      __KCODER_STUDIO_APP_VERSION__: JSON.stringify(JSON.parse(await readFile(resolve(rendererRoot, 'package.json'), 'utf8')).version) },
    build: { write: false, minify: false, lib: { entry: transportEntry,
      name: 'KCoderGatewayTransport', formats: ['iife'] } } });
  const transportCode = (Array.isArray(transportBuild) ? transportBuild[0] : transportBuild).output
    .find(item => item.type === 'chunk').code;
  assert.deepEqual(await fingerprintRendererSource(rendererRoot), sourceBefore, 'transport source must stay fixed during bundling');
  assert.equal(await digestFile(transportEntry), entrySha256);
  await context.writeArtifactJson('transport-source.json', sourceBefore);
  await context.writeArtifactJson('transport-build.json', { entry: 'e2e/fixtures/runtime-read-cost-entry.ts', entrySha256,
    sha256: createHash('sha256').update(transportCode).digest('hex'), sourceUnchanged: true });
  await writeFile(resolve(web, 'gateway-transport.js'), transportCode);
  let streaming = false, finish = false, startedAt = 0;
  const model = await startApprovalModelFixture(context, { responseSteps: () => [
    ...Array.from({ length: 60 }, (_, index) => ({
      ready: () => streaming && performance.now() >= startedAt + index * 80,
      delta: { ...(index === 0 ? { role: 'assistant' } : {}), content: index === 59 ? 'AUTH_STREAM_LAST' : 'sample ' },
    })), { ready: () => finish, finishReason: 'stop' },
  ] });
  const settings = await context.writeStateJson('models.json', { active_provider: 'fixture', credential_store: 'file',
    max_retries: 0, max_tokens: 256, tools: { profile: 'none' }, session_memory: { enabled: false },
    integrations: { office: { enabled: false }, connectivity: { enabled: false }, services: { enabled: false } },
    providers: { fixture: { api_format: 'openai_chat_completions', endpoint: model.baseUrl,
      authentication: { mode: 'none' }, default_model: 'fixture', discover_models: false, no_proxy: true,
      context_window_tokens: 128000, output_headroom_tokens: 1024, max_output_tokens: 256, request_timeout_secs: 30 } } });
  const servers = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Owned Native', transport: 'local',
    command: binary, workspace: workspace.path, settingsFile: settings }]);
  const gateway = await startGateway(context, { auth: true, workspace: workspace.path, serversFile: servers, kcoderBin: binary,
    passEnv: ['KCODER_TARGET_DIR'],
    env: { KCODER_CONFIG_DIR: profile, KCODER_HOME: profile, KCODER_STUDIO_DATA_DIR: data, KCODER_STUDIO_WEB_ROOT: web,
      KCODER_E2E_AUTH_OBSERVE: '1', NODE_OPTIONS: '--trace-events-enabled --trace-event-categories=node.fs.async ' +
        `--trace-event-file-pattern=${context.pathInState('fs-${pid}.json')}` } });
  const readCounts = observeAuthReads(context, gateway.child.stdout);
  const cookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(cookie);
  const cookieId = cookie.slice(cookie.indexOf('=') + 1); context.registerSecret(cookieId);
  const additionalBrowserLogins = 16;
  for (let index = 0; index < additionalBrowserLogins; index++)
    context.registerSecret(await login(gateway.baseUrl, gateway.authToken));
  const clients = [];
  for (const [index, observer] of ['owned_page_00000001', 'owned_page_00000001', 'owned_page_00000002'].entries()) {
    const url = new URL(gatewayRpcUrl(gateway, 'local', 'cookie-auth')); url.searchParams.set('runtimeObserver', observer);
    const client = await openRpc(url, { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    clients.push(client);
    context.addCleanup(`close auth cost client ${index}`, () => closeRpcAndWait(client));
    await initializeRpc(client, `auth-cost-${index}`);
  }
  const owner = clients[0];
  const thread = (await owner.request('thread/start', { cwd: workspace.path })).thread;
  const notices = () => clients.map(client => client.messages().filter(value => value.method === RUNTIME_ACTIVITY_CHANGED).length);
  const countNotices = () => notices().reduce((sum, value) => sum + value, 0);
  await waitFor(() => countNotices() >= 2, 5000, 'initial authorized page notifications', 20, context.abortSignal);
  // Let the existing 50 ms notification debounce finish before a measured phase.
  await delay(150, undefined, { signal: context.abortSignal });
  const ledger = resolve(data, 'mobile-device-auth/devices.json'), key = resolve(data, 'mobile-device-auth/.key');
  const phases = [];
  async function measure(name, operation, unchanged = true) {
    const before = await readCounts(), snapshot = unchanged ? await ledgerSnapshot(ledger) : null;
    const phase = { name, startUs: clockUs() }; phases.push(phase);
    const result = await operation();
    const after = await waitFor(async () => {
      const counts = await readCounts(); return counts.completed === counts.queued ? counts : null;
    }, 5000, `${name} authorization completion`, 20, context.abortSignal);
    phase.endUs = clockUs(); phase.durationMs = (phase.endUs - phase.startUs) / 1000;
    phase.auth = Object.fromEntries(Object.keys(before).map(field => [field, after[field] - before[field]]));
    phase.result = result;
    if (snapshot) { assert.deepEqual(await ledgerSnapshot(ledger), snapshot, `${name} must not rewrite the private ledger`); phase.ledgerUnchanged = true; }
    await context.writeArtifactJson(`phases/${name}.json`, phase);
    return phase;
  }
  const getServers = async (credential = cookie) => {
    const response = await fetch(`${gateway.baseUrl}/api/servers`, { headers: { Cookie: credential },
      signal: AbortSignal.any([context.abortSignal, AbortSignal.timeout(10000)]) });
    await response.arrayBuffer(); return response.status;
  };
  await measure('static-asset-encoding', async () => {
    const raw = (path, encoding, authenticated = true) => new Promise((resolve, reject) => {
      const request = get(`${gateway.baseUrl}${path}`, { headers: {
        'accept-encoding': encoding, ...(authenticated ? { Cookie: cookie } : {}),
      }, signal: context.abortSignal }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      });
      request.on('error', reject);
    });
    const plain = await raw('/large.js', 'identity');
    const gzip = await raw('/large.js', 'gzip');
    assert.equal(gzip.status, 200); assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.deepEqual(gunzipSync(gzip.body), plain.body); assert.equal(plain.body.toString(), staticCode);
    assert.ok(gzip.body.length < plain.body.length / 10);
    const html = await raw('/', 'gzip');
    assert.equal(html.headers['content-encoding'], undefined);
    assert.match(html.body.toString(), /name="kcoder-rpc-token" content="cookie-auth"/);
    assert.ok(!html.body.includes(gateway.authToken), 'the login secret must not enter navigation HTML');
    const denied = await raw('/large.js', 'gzip', false);
    assert.equal(denied.status, 401, 'compression must not move mutable assets before authentication');
    return { identityBytes: plain.body.length, gzipBytes: gzip.body.length, htmlCompressed: false, unauthenticatedStatus: denied.status };
  });
  let sourceAssetEtag;
  const sourceAssetPhase = await measure('source-static-conditional-assets', async () => {
    const first = await fetch(`${gateway.baseUrl}/assets/entry-1234ABCD.js`, { headers: { Cookie: cookie }, signal: context.abortSignal });
    assert.equal(first.status, 200); assert.equal(await first.text(), staticCode);
    sourceAssetEtag = first.headers.get('etag'); assert.match(sourceAssetEtag, /^W\/"source-/);
    assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    const statuses = []; let bodyBytes = 0;
    for (let index = 0; index < 8; index++) {
      const response = await fetch(`${gateway.baseUrl}/assets/entry-1234ABCD.js`, {
        method: index % 2 ? 'HEAD' : 'GET', signal: context.abortSignal,
        headers: { Cookie: cookie, 'if-none-match': sourceAssetEtag, 'accept-encoding': 'gzip' },
      });
      statuses.push(response.status); bodyBytes += (await response.arrayBuffer()).byteLength;
    }
    assert.deepEqual(statuses, Array(8).fill(304)); assert.equal(bodyBytes, 0);
    const denied = await fetch(`${gateway.baseUrl}/assets/entry-1234ABCD.js`, {
      headers: { 'if-none-match': sourceAssetEtag }, signal: context.abortSignal,
    });
    await denied.arrayBuffer(); assert.equal(denied.status, 401);
    return { conditionalRequests: statuses.length, status: 304, bodyBytes, unauthenticatedStatus: denied.status };
  });
  assert.ok(sourceAssetPhase.auth.started >= 9, 'each serial conditional asset request still needs a fresh authentication read');
  await measure('idle-websocket-32s', async () => {
    await delay(32000, undefined, { signal: context.abortSignal });
    assert.ok(clients.every(client => client.socket.readyState === 1), 'idle sockets must survive a real ping interval');
    return { sockets: clients.length, observerPages: 2 };
  });
  await measure('serial-http', async () => {
    const statuses = []; for (let index = 0; index < 6; index++) statuses.push(await getServers());
    assert.deepEqual(statuses, Array(6).fill(200)); return { requests: statuses.length };
  });
  await measure('concurrent-http', async () => {
    const statuses = await Promise.all(Array.from({ length: 20 }, () => getServers()));
    assert.deepEqual(statuses, Array(20).fill(200)); return { requests: statuses.length };
  });
  await measure('large-websocket-native-read', async () => {
    const id = 'owned-large-native-read';
    const message = JSON.stringify({ jsonrpc: '2.0', id, method: 'server/resources/read', params: {} })
      + ' '.repeat(1024 * 1024);
    const reply = owner.waitFor(value => value.id === id, 15000, 'large WebSocket Native read receipt');
    owner.socket.send(message);
    const value = await reply;
    assert.equal(value.error, undefined);
    assert.equal(typeof value.result?.instanceId, 'string');
    assert.equal(owner.messages().filter(value => value.id === id).length, 1);
    return { applicationBytes: Buffer.byteLength(message), nativeReplies: 1, requests: 1 };
  });
  await measure('fragmented-websocket-native-read', async () => {
    const id = 'owned-fragmented-native-read';
    const message = JSON.stringify({ jsonrpc: '2.0', id, method: 'server/resources/read', params: {} })
      + ' '.repeat(1024 * 1024);
    const reply = owner.waitFor(value => value.id === id, 15000, 'fragmented WebSocket Native read receipt');
    owner.socket.sendFragmented(message, 512);
    const value = await reply;
    assert.equal(value.error, undefined);
    assert.equal(typeof value.result?.instanceId, 'string');
    assert.equal(owner.messages().filter(value => value.id === id).length, 1);
    return { applicationBytes: Buffer.byteLength(message), fragmentBytes: 512,
      fragments: Math.ceil(Buffer.byteLength(message) / 512), nativeReplies: 1, requests: 1 };
  });
  let turn;
  await measure('turn-start', async () => {
    const before = countNotices();
    turn = (await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Owned auth stream measurement' }] })).turn;
    await waitFor(() => countNotices() >= before + 2, 10000, 'turn start page notifications', 20, context.abortSignal);
    await delay(100, undefined, { signal: context.abortSignal });
    assert.equal(countNotices() - before, 2, 'two sockets in one page share one directory invalidation');
    return { pageNotifications: countNotices() - before };
  });
  await measure('streaming-deltas', async () => {
    const before = countNotices(); startedAt = performance.now(); streaming = true;
    await owner.waitFor(value => value.method === 'item/delta' && value.params?.threadId === thread.id &&
      value.params?.turnId === turn.id && String(value.params?.delta?.text).includes('AUTH_STREAM_LAST'), 15000, 'last gated text delta');
    const deltas = owner.messages().filter(value => value.method === 'item/delta' && value.params?.turnId === turn.id).length;
    assert.equal(countNotices(), before, 'text deltas must not invalidate the directory');
    assert.ok(deltas >= 10, 'measure an actual sequence of streamed updates'); return { deltas, pageNotifications: 0 };
  });
  await measure('turn-completed', async () => {
    const before = countNotices(); finish = true;
    const completed = await owner.waitFor(value => value.method === 'turn/completed' && value.params?.threadId === thread.id &&
      value.params?.turnId === turn.id, 15000, 'owned turn completion');
    assert.equal(completed.params.turn.status, 'completed');
    await waitFor(() => countNotices() >= before + 2, 5000, 'completion page notifications', 20, context.abortSignal);
    await delay(100, undefined, { signal: context.abortSignal });
    assert.equal(countNotices() - before, 2); return { pageNotifications: countNotices() - before };
  });
  const chromium = await startChromium(context, { label: 'session-recovery-browser' });
  try {
    const page = await chromium.newPage();
    await page.context().addCookies([{ name: 'kcoder_studio_session', value: cookieId,
      url: gateway.baseUrl, httpOnly: true, sameSite: 'Strict' }]);
    await page.goto(gateway.baseUrl);
    await page.addScriptTag({ url: `${gateway.baseUrl}/gateway-transport.js` });
    await measure('concurrent-runtime-clock-samples', async () => {
      let requests = 0, replies = 0, threadStarts = 0, turnStarts = 0;
      const observe = socket => {
        const pending = new Set();
        socket.on('framesent', ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (frame.method === 'thread/start') threadStarts++;
          if (frame.method === 'turn/start') turnStarts++;
          if (frame.method === 'server/resources/read') { requests++; pending.add(frame.id); }
        });
        socket.on('framereceived', ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (pending.delete(frame.id)) {
            assert.ok(Number.isSafeInteger(frame.result?.sampledAtMs), 'Native clock response must be successful');
            replies++;
          }
        });
      };
      page.on('websocket', observe);
      try {
        const samples = await page.evaluate(async () => {
          const runtime = new globalThis.KCoderGatewayTransport.KCoderGatewayRuntime('cookie-auth');
          try {
            const parallel = await Promise.all(Array.from({ length: 12 }, () =>
              runtime.request('runtime.clock.read', { serverId: 'local' })));
            const subsequent = await runtime.request('runtime.clock.read', { serverId: 'local' });
            return { parallel: parallel.map(value => value.sampledAtMs), subsequent: subsequent.sampledAtMs };
          } finally { await runtime.dispose(); }
        });
        assert.equal(samples.parallel.length, 12);
        assert.ok(samples.parallel.every(value => Number.isSafeInteger(value) && value > 0));
        assert.equal(new Set(samples.parallel).size, 1);
        assert.ok(samples.subsequent >= samples.parallel[0]);
        assert.equal(requests, 2, 'one pending sample plus one fresh subsequent sample');
        assert.equal(replies, 2);
        assert.equal(threadStarts, 0); assert.equal(turnStarts, 0);
        return { concurrentConsumers: 12, pendingSampleReads: 1, subsequentSampleReads: 1, successfulNativeReplies: replies, threadStarts, turnStarts };
      } finally { page.off('websocket', observe); }
    });
    await measure('connection-identity-lifetime', async () => {
      const result = await page.evaluate(async () => {
        const client = new globalThis.KCoderGatewayTransport.GatewayRpcClient('local', 'cookie-auth');
        try {
          await client.connect();
          const first = client.diagnosticConnection, captured = { ...first };
          const firstStable = Array.from({ length: 100 }, () => client.diagnosticConnection).every(value => value === first);
          const before = await client.request('server/resources/read', {});
          client.close();
          await client.connect();
          const current = client.diagnosticConnection;
          const after = await client.request('server/resources/read', {});
          return { firstStable,
            recoveredStable: Array.from({ length: 100 }, () => client.diagnosticConnection).every(value => value === current),
            replaced: current.connectionId !== first.connectionId && current.targetId === first.targetId,
            originalPreserved: first.connectionId === captured.connectionId && first.targetId === captured.targetId,
            frozen: Object.isFrozen(first) && Object.isFrozen(current),
            successfulNativeReads: [before, after].filter(value => typeof value.instanceId === 'string').length };
        } finally { client.close(); }
      });
      assert.deepEqual(result, { firstStable: true, recoveredStable: true, replaced: true,
        originalPreserved: true, frozen: true, successfulNativeReads: 2 });
      return result;
    });
    await measure('failed-socket-session-checks', async () => {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let directoryReads = 0, socketCloses = 0;
      const closed = socket => socket.on('close', () => { socketCloses++; });
      page.on('websocket', closed);
      const holdDirectory = async route => { directoryReads++; await gate; await route.continue(); };
      await page.route('**/api/servers', holdDirectory);
      // Unconfigured run-owned targets make the real Gateway reject these WS connections.
      // Their actual production clients then check the same authenticated directory.
      const pending = page.evaluate(async () => {
        const { GatewayRpcClient } = globalThis.KCoderGatewayTransport;
        const clients = [0, 1, 2].map(index => new GatewayRpcClient(`owned-recovery-missing-${index}`, 'cookie-auth'));
        const probe = globalThis.__gatewayRecoveryProbe = { clients, settled: 0 };
        try {
          const outcomes = await Promise.allSettled(clients.map(client => client.connect().finally(() => { probe.settled++; })));
          return { failedConnections: outcomes.filter(value => value.status === 'rejected').length };
        } finally { clients.forEach(client => client.close()); delete globalThis.__gatewayRecoveryProbe; }
      });
      // Keep failed test cleanup from leaving a rejected browser evaluation unobserved.
      void pending.catch(() => {});
      try {
        await waitFor(() => socketCloses === 3 && directoryReads >= 1,
          4000, 'three real socket failures with pending directory checks', 20, context.abortSignal);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const concurrentDirectoryReads = directoryReads;
        assert.equal(concurrentDirectoryReads, 1, 'concurrent real failed-socket checks must share one directory GET');
        await page.evaluate(() => globalThis.__gatewayRecoveryProbe.clients[0].close());
        await waitFor(() => page.evaluate(() => globalThis.__gatewayRecoveryProbe?.settled === 1),
          1000, 'departed client releases its check without waiting for the held HTTP', 20, context.abortSignal);
        assert.equal(directoryReads, 1, 'closing one owner must not restart or cancel its peers directory read');
        release();
        assert.deepEqual(await pending, { failedConnections: 3 });
        assert.equal(await page.evaluate(async () =>
          (await globalThis.KCoderGatewayTransport.fetchGatewayServers()).some(server => server.id === 'local')), true);
        assert.equal(directoryReads, 2, 'a completed check must not cache authorization for a subsequent directory read');
        return { failedConnections: 3, concurrentDirectoryReads, subsequentDirectoryReads: 1,
          departedClientSettledBeforeRelease: true, peersPendingBeforeRelease: 2,
          transport: 'production GatewayRpcClient in Chromium; real rejected WS and authenticated HTTP' };
      } finally {
        release();
        await pending.catch(() => {});
        await page.unroute('**/api/servers', holdDirectory);
        page.off('websocket', closed);
      }
    });
    for (const kind of ['directory', 'health']) for (const boundary of ['account', 'configuration']) {
      await measure(`retired-${kind}-401-${boundary}`, async () => {
        const path = kind === 'directory' ? '/api/servers' : '/api/servers/status';
        let release, ready = false, responseStatus;
        const gate = new Promise(resolve => { release = resolve; });
        const originalUrl = page.url();
        const heldResponse = async route => {
          // Use a real Gateway 401 without altering this browser's valid Cookie.
          const response = await route.fetch({ headers: { ...route.request().headers(), cookie: '' } });
          try {
            responseStatus = response.status(); ready = true;
            await gate;
            await route.fulfill({ response });
          } finally { await response.dispose(); }
        };
        await page.route(`**${path}`, heldResponse);
        const pending = page.evaluate(async kind => {
          const api = globalThis.KCoderGatewayTransport;
          try {
            await (kind === 'directory' ? api.fetchGatewayServers() : api.fetchGatewayServerStatuses());
            return { outcome: 'unexpected-success' };
          } catch (error) { return { outcome: error.name }; }
        }, kind);
        void pending.catch(() => {});
        try {
          await waitFor(() => ready, 5000, 'real unauthorized response held before scope invalidation', 20, context.abortSignal);
          assert.equal(responseStatus, 401);
          await page.evaluate(boundary => {
            window.dispatchEvent(boundary === 'account'
              ? new CustomEvent('kcoder:account-context-invalidated', { detail: { targetId: 'local' } })
              : new Event('kcoder:servers-changed'));
          }, boundary);
          release();
          assert.deepEqual(await pending, { outcome: 'AbortError' });
          assert.equal(page.url(), originalUrl, 'obsolete auth failure must not navigate the current page');
          await page.unroute(`**${path}`, heldResponse);
          const currentHasTarget = await page.evaluate(async kind => {
            const api = globalThis.KCoderGatewayTransport;
            const values = await (kind === 'directory' ? api.fetchGatewayServers() : api.fetchGatewayServerStatuses());
            return values.some(value => value.id === 'local');
          }, kind);
          assert.equal(currentHasTarget, true, 'current Cookie must remain usable after the obsolete 401');
          return { kind, boundary, actualStatus: responseStatus, obsoleteOutcome: 'AbortError',
            navigationSuppressed: true, currentHasTarget };
        } finally {
          release();
          await pending.catch(() => {});
          await page.unroute(`**${path}`, heldResponse);
        }
      });
    }
    await measure('current-browser-401-navigates', async () => {
      await page.context().clearCookies();
      const denied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/servers' && response.status() === 401);
      const pending = page.evaluate(() => globalThis.KCoderGatewayTransport.fetchGatewayServers().catch(() => {}));
      void pending.catch(() => {});
      const response = await denied;
      await page.waitForURL(url => url.pathname === '/login', { timeout: 5000 });
      await page.locator('#gateway-login input[name="token"]').waitFor({ state: 'visible' });
      await pending.catch(() => {});
      return { actualStatus: response.status(), loginFormVisible: true };
    });
  } finally { await chromium.close(); }
  await measure('contended-authorization-store', async () => {
    const release = await holdAuthStoreMutex(context, resolve(data, 'mobile-device-auth'));
    let status, retryAfter;
    try {
      const response = await fetch(`${gateway.baseUrl}/api/servers`, { headers: { Cookie: cookie },
        signal: AbortSignal.any([context.abortSignal, AbortSignal.timeout(15000)]) });
      status = response.status; retryAfter = response.headers.get('retry-after');
      const body = await response.json();
      assert.equal(status, 503, 'actual lock contention must be a temporary storage failure');
      assert.equal(retryAfter, '5');
      assert.equal(body.error, 'Service unavailable');
    } finally { await release(); }
    const recoveredStatus = await getServers();
    assert.equal(recoveredStatus, 200, 'the same Cookie must be freshly accepted once the original mutex is available');
    return { status, retryAfter, recoveredStatus };
  });
  // This harness process mutates only its own ledger; the Gateway is a different OS process.
  const sibling = await createMobileDeviceAuth({ directory: data, identity: mobileDeviceStoreIdentity(gateway.authToken) }).browserSessions();
  await sibling.remove(cookieId);
  await measure('sibling-logout', async () => {
    const status = await getServers(); assert.equal(status, 401);
    const asset = await fetch(`${gateway.baseUrl}/assets/entry-1234ABCD.js`, { signal: context.abortSignal,
      headers: { Cookie: cookie, 'if-none-match': sourceAssetEtag } });
    await asset.arrayBuffer(); assert.equal(asset.status, 401, 'a revoked Cookie must not receive a conditional 304');
    return { status, conditionalAssetStatus: asset.status };
  }, false);
  const corruptionCookie = await login(gateway.baseUrl, gateway.authToken); context.registerSecret(corruptionCookie);
  assert.equal(await getServers(corruptionCookie), 200, 'corruption must challenge a currently accepted Cookie');
  await measure('corrupt-ledger', async () => {
    await writeFile(ledger, '{invalid ledger', { mode: 0o600 });
    const status = await getServers(corruptionCookie); assert.ok([500, 503].includes(status));
    const asset = await fetch(`${gateway.baseUrl}/assets/entry-1234ABCD.js`, { signal: context.abortSignal,
      headers: { Cookie: corruptionCookie, 'if-none-match': sourceAssetEtag } });
    await asset.arrayBuffer(); assert.ok([500, 503].includes(asset.status));
    return { status, conditionalAssetStatus: asset.status };
  }, false);
  for (const client of clients) await closeRpcAndWait(client);
  await context.stopOwned('gateway');
  const trace = JSON.parse(await readFile(context.pathInState(`fs-${gateway.child.pid}.json`), 'utf8'));
  const filesystem = summarizeAuthFileTrace(trace, { pid: gateway.child.pid, ledger, key, phases });
  await context.writeArtifactJson('read-cost.json', { binarySha, nodeVersion: process.version, platform: process.platform,
    scope: 'Gateway Node filesystem counts plus production Chromium transport failure checks; tracing and held requests are controlled; no full renderer, installed release or public latency measurement',
    phases, filesystem, additionalBrowserLogins, modelRequests: model.requests.length });
  for (const phase of phases.filter(phase => phase.ledgerUnchanged)) {
    const io = filesystem.find(value => value.name === phase.name);
    assert.equal(io.ledgerTemporaryOpens, 0, phase.name); assert.equal(io.ledgerRenames, 0, phase.name);
    assert.equal(io.fsyncCalls, 0, phase.name);
    if (['idle-websocket-32s', 'streaming-deltas'].includes(phase.name)) {
      assert.equal(phase.auth.started, 0, phase.name);
      // Durable retention revocations have an independent 30-second cross-process sweep.
      const sweepBound = phase.name === 'idle-websocket-32s' ? Math.ceil(phase.durationMs / 30000) : 1;
      assert.ok(io.ledgerOpens <= sweepBound, `${phase.name}: bounded background retention sweeps`);
      assert.equal(io.keyOpens, io.ledgerOpens, phase.name);
    }
  }
  const contention = phases.find(value => value.name === 'contended-authorization-store');
  assert.equal(contention.auth.started, 2, 'blocked and recovered requests need independent authoritative checks');
  assert.equal(contention.auth.failed, 1);
  const contentionIo = filesystem.find(value => value.name === contention.name);
  assert.ok(contentionIo.ledgerOpens >= 1, 'recovery must reread the actual ledger');
  for (const field of ['ledgerTemporaryOpens', 'ledgerRenames', 'fsyncCalls']) assert.equal(contentionIo[field], 0);
  const serial = phases.find(value => value.name === 'serial-http');
  assert.equal(serial.auth.started, 6, 'sequential requests must freshly inspect authorization');
  assert.equal(serial.auth.coalesced, 0);
  assert.equal(serial.auth.queued + serial.auth.coalesced, serial.result.requests);
  assert.equal(filesystem.find(value => value.name === serial.name).ledgerOpens, 6);
  const concurrent = phases.find(value => value.name === 'concurrent-http');
  assert.ok(concurrent.auth.started > 0 && concurrent.auth.started <= concurrent.result.requests);
  assert.equal(concurrent.auth.queued + concurrent.auth.coalesced, concurrent.result.requests,
    'every admitted HTTP auth call is either queued or merged before inspection');
  assert.equal(filesystem.find(value => value.name === concurrent.name).ledgerOpens, concurrent.auth.started);
  assert.ok(model.requests.length >= 1 && model.requests.length <= 3, 'bounded loopback-only model requests');
  assert.equal(await digestFile(binary), binarySha, 'Native input must remain fixed throughout the run');
});
