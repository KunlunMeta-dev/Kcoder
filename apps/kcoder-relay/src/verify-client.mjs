import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { fetchGatewayPairing } from './pair.mjs';

const PROTOCOL_VERSION = '2026-07-27';
const failure = code => Object.assign(new Error(code), { code });
const token = value => typeof value === 'string' && /^[A-Za-z0-9._~-]{1,16384}$/.test(value);

/** Controlled transports may exercise the same verifier without a public Relay or real account. */
export async function verifyRelay({ urls, selectedGateway, localGateway = 'http://127.0.0.1:4186',
  fetchResponse = fetch, getPairing = fetchGatewayPairing, Socket = WebSocket, timeoutMs = 10000,
  evidenceDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../target/kcoder-relay') }) {
  const gatewayUrl = urls.gatewayBase.toString().replace(/\/$/, '');
  const endpoint = path => urls.gatewayEndpoint(path);
  async function request(url, phase, options = {}) {
    try { return await fetchResponse(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw failure(`RELAY_VERIFICATION_${phase}_REQUEST_FAILED`); }
  }
  async function json(response, phase) {
    if (!response.ok) throw failure(`RELAY_VERIFICATION_${phase}_HTTP_${response.status}`);
    try { return await response.json(); } catch { throw failure(`RELAY_VERIFICATION_${phase}_INVALID_JSON`); }
  }
  const healthUrl = new URL('/_relay/health', urls.publicRoot);
  const health = await json(await request(healthUrl, 'HEALTH'), 'HEALTH');
  if (health?.online !== true) throw failure('RELAY_VERIFICATION_HEALTH_OFFLINE');
  const sessionUrl = endpoint('/api/mobile/session');
  const post = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  if ((await request(sessionUrl, 'INVALID_PAIRING', post({ token: 'invalid' }))).status !== 401)
    throw failure('RELAY_VERIFICATION_INVALID_PAIRING_ACCEPTED');
  if ((await request(sessionUrl, 'INTERNAL_PAIRING', post({ token: selectedGateway.gatewaySecret, durableDeviceAuthorization: true }))).status !== 401)
    throw failure('RELAY_VERIFICATION_INTERNAL_CREDENTIAL_ACCEPTED');
  const pairing = await getPairing({ localGateway, gatewaySecret: selectedGateway.gatewaySecret, publicGateway: gatewayUrl });
  let headers, ws, evidence, primary, rpcFailure;
  const pending = new Map();
  function failRpc(error) {
    rpcFailure ??= error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(rpcFailure); }
    pending.clear();
  }
  try {
    let response;
    try { response = await request(sessionUrl, 'SESSION', post({ token: pairing.token, durableDeviceAuthorization: true })); }
    catch { throw Object.assign(failure('RELAY_VERIFICATION_SESSION_UNCONFIRMED'), { externalOutcome: 'unknown' }); }
    if (response.status !== 200) throw failure(`RELAY_VERIFICATION_SESSION_HTTP_${response.status}`);
    let session;
    try { session = await response.json(); }
    catch { throw Object.assign(failure('RELAY_VERIFICATION_SESSION_UNCONFIRMED'), { externalOutcome: 'unknown' }); }
    if (!token(session?.accessToken)) throw Object.assign(failure('RELAY_VERIFICATION_SESSION_UNCONFIRMED'), { externalOutcome: 'unknown' });
    headers = { authorization: `Bearer ${session.accessToken}` };
    if (!token(session.rpcToken)) throw failure('RELAY_VERIFICATION_SESSION_RPC_TOKEN_MISSING');
    const servers = await json(await request(endpoint('/api/servers'), 'SERVERS', { headers }), 'SERVERS');
    if (!Array.isArray(servers?.servers) || servers.servers[0]?.id !== 'local') throw failure('RELAY_VERIFICATION_SERVERS_INVALID');
    const rpcUrl = endpoint('/rpc'); rpcUrl.protocol = 'wss:';
    rpcUrl.searchParams.set('token', session.rpcToken); rpcUrl.searchParams.set('server', 'local');
    ws = new Socket(rpcUrl, { headers, handshakeTimeout: timeoutMs });
    ws.on('error', () => failRpc(failure('RELAY_VERIFICATION_WEBSOCKET_FAILED')));
    ws.on('close', () => failRpc(failure('RELAY_VERIFICATION_WEBSOCKET_CLOSED')));
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { failRpc(failure('RELAY_VERIFICATION_RPC_INVALID_JSON')); return; }
      if (message && Object.hasOwn(message, 'method')) return;
      const request = pending.get(message?.id);
      if (!request) return;
      const hasResult = Object.hasOwn(message, 'result'), hasError = Object.hasOwn(message, 'error');
      // The app protocol accepts an omitted legacy version; an explicit version must be 2.0.
      if ((message.jsonrpc !== undefined && message.jsonrpc !== '2.0') || hasResult === hasError ||
          (hasError && (!message.error || typeof message.error !== 'object' || Array.isArray(message.error) ||
            !Number.isInteger(message.error.code) || typeof message.error.message !== 'string'))) {
        failRpc(failure('RELAY_VERIFICATION_RPC_INVALID_FRAME')); return;
      }
      clearTimeout(request.timer); pending.delete(message.id);
      if (hasError) request.reject(failure('RELAY_VERIFICATION_RPC_REJECTED'));
      else request.resolve(message.result);
    });
    let sequence = 0;
    function rpc(method, params = {}) {
      if (rpcFailure) return Promise.reject(rpcFailure);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(failure('RELAY_VERIFICATION_RPC_TIMEOUT')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }), error => {
          if (error) failRpc(failure('RELAY_VERIFICATION_RPC_SEND_FAILED'));
        }); } catch { failRpc(failure('RELAY_VERIFICATION_RPC_SEND_FAILED')); }
      });
    }
    // events.once already rejects on error even when another error listener exists.
    try { await once(ws, 'open', { signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw rpcFailure ?? failure('RELAY_VERIFICATION_WEBSOCKET_OPEN_UNCONFIRMED'); }
    const init = await rpc('initialize', { protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'kcoder-relay-verifier', version: '0.1.0' }, capabilities: { experimental: { threadRunSummaryV1: true } } });
    if (init?.protocolVersion !== PROTOCOL_VERSION) throw failure('RELAY_VERIFICATION_PROTOCOL_MISMATCH');
    try { ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }), error => {
      if (error) failRpc(failure('RELAY_VERIFICATION_RPC_SEND_FAILED'));
    }); } catch { throw failure('RELAY_VERIFICATION_RPC_SEND_FAILED'); }
    const threads = await rpc('thread/list', { limit: 1 });
    if (rpcFailure) throw rpcFailure;
    if (!threads || typeof threads !== 'object' || !Array.isArray(threads.threads))
      throw failure('RELAY_VERIFICATION_THREAD_LIST_INVALID');
    evidence = { timestamp: new Date().toISOString(), publicUrl: urls.publicRoot.toString(), gatewayUrl,
      healthUrl: healthUrl.toString(), gatewayId: selectedGateway.id,
      scope: 'HTTPS/WSS, pairing rejection, remote client session, server list, app-server initialize, thread/list',
      https: 'PASS', invalidPairingToken: 'PASS', internalCredentialRejected: 'PASS', deviceSession: 'PASS', serverList: 'PASS',
      wss: 'PASS', appServerInitialize: 'PASS', threadList: 'PASS', protocolVersion: init.protocolVersion,
      threadResultKeys: Object.keys(threads || {}), modelTurn: 'NOT_RUN', deploymentPerformedByVerifier: false };
  } catch (error) { primary = error; }
  finally {
    failRpc(failure('RELAY_VERIFICATION_FINISHED'));
    try { ws?.terminate(); } catch { primary ??= failure('RELAY_VERIFICATION_WEBSOCKET_CLOSE_UNCONFIRMED'); }
    if (headers) {
      try {
        const revoked = await request(sessionUrl, 'SESSION_REVOKE', { method: 'DELETE', headers });
        if (revoked.status !== 204) throw failure('RELAY_VERIFICATION_SESSION_REVOKE_UNCONFIRMED');
      } catch {
        if (primary) primary.cleanupUnconfirmed = true;
        else primary = failure('RELAY_VERIFICATION_SESSION_REVOKE_UNCONFIRMED');
      }
    }
  }
  if (primary) throw primary;
  // A success artifact is published only after the owned session revocation is confirmed.
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(resolve(evidenceDir, 'verification.json'), JSON.stringify(evidence, null, 2) + '\n');
  return evidence;
}
