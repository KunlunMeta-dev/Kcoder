import assert from 'node:assert/strict';
import { login } from './http.mjs';
import { waitForGatewayRpcToken } from './gateway.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, openRpc } from './rpc.mjs';

/** Real HTTP browser login, independent of the TUI's durable device family.
 * No synthetic subject, Native Source owner, or forged broker is introduced.
 */
export async function openOwnedPeerBrowserRuntime(context, gateway, { serverId, workspace, extraCapabilities = {} }) {
  const base = new URL(gateway.baseUrl);
  assert.equal(base.protocol, 'http:'); assert.equal(base.hostname, '127.0.0.1');
  assert.ok(typeof serverId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(serverId));
  assert.ok(typeof workspace === 'string' && workspace.length > 0);
  const cookie = await login(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { Cookie: cookie }, expectedToken: 'cookie-auth' });
  const url = new URL(gatewayRpcUrl(gateway, serverId, token));
  url.searchParams.set('workspace', workspace);
  const rpc = await openRpc(url.href, { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
  let closed = false;
  const close = async () => { if (!closed) { await closeRpcAndWait(rpc, 'owned independent browser runtime'); closed = true; } };
  context.addCleanup('close owned independent browser peer runtime', close);
  try {
    const initialized = await initializeRpc(rpc, 'owned-browser-peer-runtime', {
      crossSessionDiscoveryV1: true, crossSessionMessagesV1: true, peerAgentMessagesV1: true,
      gatewaySharedThreadsV1: true, ...extraCapabilities,
    });
    assert.equal(initialized.cwd, workspace, 'Native must confirm the original owned workspace');
    for (const name of ['crossSessionDiscoveryV1', 'crossSessionMessagesV1', 'peerAgentMessagesV1', ...Object.keys(extraCapabilities)])
      assert.equal(initialized.capabilities?.experimental?.[name], true, `Actual Native ${name} is required`);
    return Object.freeze({ request: (method, params, timeoutMs) => rpc.request(method, params, timeoutMs),
      waitFor: (...args) => rpc.waitFor(...args), messages: () => rpc.messages(), socket: rpc.socket, close,
      async devices() {
        assert.equal(closed, false, 'The owned browser runtime is closed');
        let response;
        try { response = await fetch(gateway.baseUrl + '/api/mobile/pairing', {
          headers: { Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
        }); } catch { throw new Error('Owned browser device observation transport unconfirmed'); }
        assert.equal(response.status, 200, 'Owned browser device observation was not authorized');
        let body;
        try { const raw = await response.text(); assert.ok(Buffer.byteLength(raw) <= 1024 * 1024); body = JSON.parse(raw); }
        catch { throw new Error('Owned browser device observation is malformed'); }
        // This admin response also includes pairing credentials and route
        // proofs. Neither the full object nor a parse error may leave this scope.
        assert.ok(Array.isArray(body.devices) && body.devices.length <= 128, 'Owned browser device observations missing');
        return body.devices.map(row => {
          assert.ok(typeof row.id === 'string' && /^[A-Za-z0-9-]{16,128}$/.test(row.id) &&
            [row.lastUsedAt, row.expiresAt].every(value => Number.isSafeInteger(value) && value >= 0),
          'Owned browser device observation fields invalid');
          return { id: row.id, lastUsedAt: row.lastUsedAt, expiresAt: row.expiresAt };
        });
      },
      authentication: 'actual-http-browser-cookie', independentDeviceFamily: true,
      serverId, workspace, capabilities: initialized.capabilities });
  } catch (error) { await close(); throw error; }
}
