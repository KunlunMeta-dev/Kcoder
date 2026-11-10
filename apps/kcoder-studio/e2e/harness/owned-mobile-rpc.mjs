import assert from 'node:assert/strict';
import { openRpc, gatewayRpcUrl, initializeRpc, closeRpcAndWait } from './rpc.mjs';

/** A new fixture session uses the normal Mobile login contract and owns its own cleanup.
 * No existing page/device session is read, rotated or revoked. */
export async function openOwnedMobileRpc(context, gateway, serverId, workspace, { fetchImpl = fetch, connect = openRpc, experimental } = {}) {
  const origin = new URL(gateway.baseUrl);
  assert.equal(origin.hostname, '127.0.0.1', 'owned loopback Gateway required');
  const response = await fetchImpl(`${gateway.baseUrl}/api/mobile/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: gateway.authToken }),
  });
  assert.equal(response.status, 200, 'fixture observer Mobile authorization failed');
  const credentials = await response.json();
  assert.equal(typeof credentials.accessToken, 'string');
  assert.equal(typeof credentials.rpcToken, 'string');
  context.registerSecret(credentials.accessToken); context.registerSecret(credentials.rpcToken);
  let rpc = null, closed = false;
  const close = async () => {
    if (closed) return;
    await closeRpcAndWait(rpc, 'owned Mobile migration observer');
    const revoked = await fetchImpl(`${gateway.baseUrl}/api/mobile/session`, {
      method: 'DELETE', headers: { authorization: `Bearer ${credentials.accessToken}` },
    });
    assert.ok([204, 401].includes(revoked.status), 'owned observer session cleanup was not confirmed');
    closed = true;
  };
  context.addCleanup('close only owned Mobile migration observer and session', close);
  const url = new URL(gatewayRpcUrl(gateway, serverId, credentials.rpcToken));
  if (workspace !== undefined) url.searchParams.set('workspace', workspace);
  rpc = await connect(url.toString(), { headers: { authorization: `Bearer ${credentials.accessToken}`, origin: gateway.baseUrl } });
  const initialized = await initializeRpc(rpc, 'owned-mobile-migration-observer', experimental);
  return { rpc, initialized, close };
}
