import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { runE2E, waitFor } from '../harness/run-context.mjs';
import { startChromium } from '../harness/chromium.mjs';

if (process.env.KCODER_E2E_LIVE_GATEWAY_CONNECTIVITY !== '1') throw new Error('Explicit live connectivity acceptance consent is required');
const loginFile = process.env.KCODER_E2E_CONNECTIVITY_LOGIN_FILE;
if (!loginFile) throw new Error('A private current Gateway login URL file is required');
process.umask(0o077);
await runE2E(import.meta.url, {
  testId: 'current-mobile-web-ui-connectivity', tier: 'manual-live',
  modelPolicy: 'Explicit live acceptance of the actual current Mobile Web; one owned device authorization, history reads, and exact device revocation; no sends or models',
}, async run => {
  const login = new URL((await readFile(loginFile, 'utf8')).trim());
  const baseUrl = login.searchParams.get('gateway') || login.origin + login.pathname.replace(/\/login$/, '');
  const secrets = [login.searchParams.get('token'), new URLSearchParams(login.hash.slice(1)).get('token')];
  assert.ok(secrets[1], 'Gateway-generated dynamic pairing token is required');
  for (const value of secrets) if (value) run.registerSecret(value);
  const browser = await startChromium(run, { label: 'current-ui-connectivity', noSandbox: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const provePeerOnly = process.env.KCODER_E2E_PROVE_P2P_ONLY === '1';
  const blockedRelayBusiness = [];
  if (provePeerOnly) {
    const gateway = new URL(baseUrl);
    await page.route(url => url.origin === gateway.origin &&
      (url.pathname === gateway.pathname + '/api/servers' || url.pathname.startsWith(gateway.pathname + '/api/servers/')), route => {
      blockedRelayBusiness.push({ kind: 'http', path: new URL(route.request().url()).pathname });
      return route.abort('failed');
    });
    assert.equal(typeof page.routeWebSocket, 'function', 'WebSocket routing is required for the owned relay-block proof');
    await page.routeWebSocket(url => url.host === gateway.host && url.pathname === gateway.pathname + '/rpc', socket => {
      blockedRelayBusiness.push({ kind: 'websocket', path: new URL(socket.url()).pathname });
      socket.close({ code: 1000, reason: 'Owned browser proof blocks Relay business RPC' });
    });
  }
  const grants = [];
  const grantReads = [];
  const privateHttpRequests = [];
  const observedOrigins = new Set();
  const isPrivate = url => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(new URL(url).hostname);
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol)) observedOrigins.add(url.origin);
    if (isPrivate(request.url())) privateHttpRequests.push(new URL(request.url()).origin);
  });
  page.on('response', response => {
    const request = response.request();
    if (request.method() !== 'POST' || !new URL(response.url()).pathname.endsWith('/api/mobile/session') || response.status() !== 200) return;
    grantReads.push(response.json().then(grant => {
      for (const name of ['accessToken', 'rpcToken', 'refreshToken']) if (typeof grant[name] === 'string') run.registerSecret(grant[name]);
      if (typeof grant.accessToken === 'string') grants.push(grant);
      assert.ok(grant.connectionRoutes?.endpoints.every(endpoint => endpoint.kind === 'public'), 'Gateway advertises only public endpoints');
    }));
  });
  page.on('websocket', socket => {
    observedOrigins.add(new URL(socket.url()).origin);
    if (isPrivate(socket.url())) privateHttpRequests.push(new URL(socket.url()).origin);
  });
  await page.addInitScript(() => {
    const Original = globalThis.RTCPeerConnection;
    globalThis.__ownedConnectivityPeers = [];
    globalThis.RTCPeerConnection = new Proxy(Original, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget);
        globalThis.__ownedConnectivityPeers.push(peer);
        return peer;
      },
    });
  });
  let cleanupVerified = false;
  try {
    console.log('Opening actual one-click Mobile Web UI');
    await page.goto(login.toString(), { waitUntil: 'commit', timeout: 30000 });
    await page.waitForFunction(() => !location.hash.includes('token=') && location.pathname.includes('/h/'), null, { timeout: 120000 });
    await page.locator('[data-testid^="toggle-server-"]').first().waitFor({ state: 'visible', timeout: 45000 });
    const project = page.getByTestId('toggle-server-local');
    if (await project.getAttribute('aria-expanded') === 'false') await project.click();
    if (provePeerOnly) await page.locator('[data-testid^="thread-"]').first().waitFor({ state: 'visible', timeout: 45000 });
    await Promise.all(grantReads);
    assert.equal(grants.length, 1, 'the actual Mobile UI must create exactly its one owned device session');
    assert.ok(grants[0].deviceId, 'the actual UI must use modern device authorization');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid^="toggle-server-"]').first().waitFor({ state: 'visible', timeout: 45000 });
    assert.equal(grants.length, 1, 'refresh restores the existing device instead of pairing a new one');
    let evidence;
    // Await each native stats read in the harness before deciding whether the peer is ready.
    await waitFor(async () => {
      const candidate = await page.evaluate(async () => {
        const peers = [];
        for (const peer of globalThis.__ownedConnectivityPeers) {
          if (peer.connectionState !== 'connected') continue;
          const stats = await peer.getStats();
          const channels = [...stats.values()].filter(row => row.type === 'data-channel').map(row => ({
            state: row.state, messagesSent: row.messagesSent, messagesReceived: row.messagesReceived,
            bytesSent: row.bytesSent, bytesReceived: row.bytesReceived,
          }));
          const transport = [...stats.values()].find(row => row.type === 'transport' && row.selectedCandidatePairId);
          const pair = transport ? stats.get(transport.selectedCandidatePairId) : [...stats.values()].find(row =>
            row.type === 'candidate-pair' && row.state === 'succeeded' && row.nominated);
          const local = pair && stats.get(pair.localCandidateId);
          const remote = pair && stats.get(pair.remoteCandidateId);
          peers.push({ state: peer.connectionState, channels,
            localCandidateType: local?.candidateType, remoteCandidateType: remote?.candidateType });
        }
        return { route: location.pathname, tokenRemoved: !location.hash.includes('token='), peers };
      });
      if (!candidate.peers.some(peer => peer.channels.some(channel => channel.state === 'open' &&
          channel.bytesSent > 0 && channel.bytesReceived > 0))) return false;
      evidence = candidate;
      return true;
    }, 30000, 'connected peer with bidirectional application DataChannel bytes', 250);
    assert.ok(evidence.peers.some(peer => peer.channels.some(channel => channel.state === 'open' &&
      channel.bytesSent > 0 && channel.bytesReceived > 0)));
    assert.equal(new URL(page.url()).origin, new URL(baseUrl).origin, 'The actual page must remain on the configured current origin');
    assert.ok([...observedOrigins].every(origin => new URL(origin).host === new URL(baseUrl).host),
      'The inspected first-party page must not retain an old public host');
    assert.deepEqual(privateHttpRequests, [], 'Mobile must never probe or connect to private HTTP/WebSocket endpoints');
    if (provePeerOnly) {
      const controls = await page.evaluate(async base => {
        let httpBlocked = false;
        try { await fetch(base + '/api/servers?ownedP2PProof=control'); }
        catch { httpBlocked = true; }
        const ws = new URL(base + '/rpc');
        ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
        const websocketBlocked = await new Promise(resolve => {
          const socket = new WebSocket(ws.toString());
          const timer = setTimeout(() => { socket.close(); resolve(false); }, 3000);
          socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(false); };
          socket.onclose = () => { clearTimeout(timer); resolve(true); };
        });
        return { httpBlocked, websocketBlocked };
      }, baseUrl);
      assert.deepEqual(controls, { httpBlocked: true, websocketBlocked: true });
      assert.ok(blockedRelayBusiness.some(row => row.kind === 'http'));
      assert.ok(blockedRelayBusiness.some(row => row.kind === 'websocket'));
    }
    const inspectV3 = process.env.KCODER_E2E_CURRENT_UI_V3 === '1';
    if (inspectV3) {
      const ui = id => page.locator(`[data-testid="${id}"]:visible`);
      await ui('home-settings').click();
      await ui('settings-appearance').click();
      await ui('settings-interface-row').click();
      await ui('settings-interface-choice-v3').click();
      await ui('settings-detail-back').click(); await ui('settings-detail-back').click();
      await ui('home-interface-v3').waitFor();
      await ui('new-workspace-local-0').click();
      await ui('conversation-v3-background').waitFor();
      await ui('conversation-v3-welcome-mark').waitFor();
      assert.equal(await ui('task-header').innerText(), '');
      await ui('task-new').waitFor(); await ui('task-more').waitFor();
      assert.equal(await ui('draft-permission-selector').count(), 0);
      await page.screenshot({ path: run.pathInArtifacts('current-mobile-v3-draft-390.png') });
      await ui('v3-conversation-menu').click();
      assert.equal(await ui('v3-menu-permissions').count(), 0);
      await ui('v3-conversation-menu-sheet-close').click();
      await ui('task-more').click(); await ui('v3-menu-permissions').waitFor();
      await page.screenshot({ path: run.pathInArtifacts('current-mobile-v3-more-390.png') });
      await ui('v3-draft-more-close').click();
    }
    await page.screenshot({ path: run.pathInArtifacts('current-mobile-ui-connected-390.png') });
    console.log('Actual Mobile Web connected over P2P without any LAN HTTP probe');
    return { ...evidence, v3ConversationVerified: inspectV3, origin: new URL(page.url()).origin, privateHttpRequests,
      observedOrigins: [...observedOrigins],
      publicBusinessBlocked: provePeerOnly, freshHistoryVisibleWithRelayBlocked: provePeerOnly, blockedRelayBusiness,
      selectedTransport: 'peer', modernDeviceAuthorization: true, ownedDeviceRevoked: true,
      boundary: 'Current HMR UI and actual Gateway in owned desktop Chromium; no native phone, remote NAT or model proof' };
  } catch (error) {
    await writeFile(run.pathInArtifacts('ui-connectivity-failure.json'), JSON.stringify({
      origin: new URL(page.url()).origin, path: new URL(page.url()).pathname, privateHttpRequests,
    }, null, 2));
    if (!new URL(page.url()).hash.includes('token=')) await page.screenshot({ path: run.pathInArtifacts('ui-connectivity-failure.png') });
    throw error;
  } finally {
    await Promise.all(grantReads);
    for (const grant of grants) {
      const status = await page.evaluate(async ({ url, token }) => (await fetch(url + '/api/mobile/session', {
        method: 'DELETE', headers: { authorization: `Bearer ${token}` },
      })).status, { url: baseUrl, token: grant.accessToken });
      if (status !== 204) throw new Error('Owned UI device revocation was not acknowledged; do not retry blindly');
    }
    cleanupVerified = grants.length > 0;
    if (cleanupVerified) console.log('Owned UI device authorization revoked');
  }
});
