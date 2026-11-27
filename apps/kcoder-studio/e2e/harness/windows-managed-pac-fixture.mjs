import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { BlockList, connect, isIP } from 'node:net';
import { createSecureContext, createServer as createTlsServer } from 'node:tls';

export const WINDOWS_MANAGED_PAC_HOST = 'www.bing.com';
const deniedV4 = new BlockList(), globalV6 = new BlockList(), deniedV6 = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) deniedV4.addSubnet(address, prefix, 'ipv4');
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) deniedV6.addSubnet(address, prefix, 'ipv6');

function publicIp(value) {
  if (typeof value !== 'string' || value.includes('%')) return false;
  return isIP(value) === 4 ? !deniedV4.check(value, 'ipv4')
    : isIP(value) === 6 && globalV6.check(value, 'ipv6') && !deniedV6.check(value, 'ipv6');
}
function ipKey(value) {
  assert.ok(publicIp(value), 'Controlled CONNECT destinations must be public numeric addresses');
  return new URL(`http://${isIP(value) === 6 ? `[${value}]` : value}/`).hostname.replace(/^\[|\]$/g, '');
}

export function windowsManagedPacPayload(fixtureId) {
  assert.match(fixtureId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const marker = `KCODEROWNEDPAC${fixtureId.replaceAll('-', '').toUpperCase()}`;
  const expectedSources = Array.from({ length: 3 }, (_, index) => ({
    url: `https://example.com/kcoder-owned-pac-${fixtureId}/source-${index + 1}`,
    title: `Owned PAC Bing result ${index + 1}`,
    content: `Owned synthetic source ${index + 1} ${marker}`,
  }));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Owned Bing fixture</title></head><body><ol id="b_results">${expectedSources.map(source => `<li class="b_algo"><h2><a href="${source.url}">${source.title}</a></h2><p>${source.content}</p></li>`).join('')}</ol></body></html>`;
  return { fixtureId, marker, nativeQuery: `!bing ${marker}`, expectedSources, html };
}

/** All accepted tunnels terminate at this owner's TLS listener, never at their requested IP. */
export async function startWindowsManagedPacFixture({ fixtureId, caPem, certificatePem, privateKeyPem, allowedConnectAddresses }, owner = {}) {
  const payload = windowsManagedPacPayload(fixtureId);
  assert.ok(Array.isArray(allowedConnectAddresses) && allowedConnectAddresses.length > 0 && allowedConnectAddresses.length <= 64);
  const allowed = new Set(allowedConnectAddresses.map(ipKey));
  for (const pem of [caPem, certificatePem, privateKeyPem]) assert.ok(typeof pem === 'string' || Buffer.isBuffer(pem));
  const servers = [], sockets = new Set(), events = [];
  const counts = { pacRequests: 0, connectAccepted: 0, connectDenied: 0, tlsAccepted: 0, tlsRejected: 0, originRequests: 0, originDenied: 0, transportErrors: 0 };
  let closed = false, closing;
  const stats = () => ({ schemaVersion: 1, fixtureId, ...counts, activeSockets: sockets.size, externalConnections: 0, closed, events: events.map(event => ({ ...event })) });
  const event = value => { if (events.length < 128) events.push(value); };
  const track = socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(10000, () => socket.destroy());
    if (closed || sockets.size > 128) socket.destroy();
    return socket;
  };
  const stop = () => closing ??= (async () => {
    closed = true;
    const ended = [...sockets].map(socket => new Promise(resolve => { if (socket.closed) resolve(); else socket.once('close', resolve); socket.destroy(); }));
    await Promise.all(ended);
    await Promise.all(servers.map(server => new Promise(resolve => { if (server.listening) server.close(resolve); else resolve(); })));
    return stats();
  })();
  owner.addCleanup?.('stop owned managed PAC/Bing fixture', stop);
  const listen = async (server, label) => {
    servers.push(server); server.on('connection', track);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port; owner.registerPort?.(label, port); return port;
  };
  try {
    const origin = createServer((request, response) => {
      const url = new URL(request.url, `https://${WINDOWS_MANAGED_PAC_HOST}`);
      const host = request.headers.host?.toLowerCase();
      const permitted = request.method === 'GET' && [WINDOWS_MANAGED_PAC_HOST, `${WINDOWS_MANAGED_PAC_HOST}:443`].includes(host)
        && url.origin === `https://${WINDOWS_MANAGED_PAC_HOST}` && url.pathname === '/search' && url.searchParams.get('q') === payload.marker
        && [...url.searchParams.keys()].every(key => ['q', 'adlt', 'setlang', 'cc'].includes(key))
        && !request.headers.authorization && !request.headers['proxy-authorization'] && !request.headers.cookie && counts.originRequests < 4;
      if (!permitted) { counts.originDenied++; event({ kind: 'origin', accepted: false }); response.writeHead(403, { connection: 'close' }); response.end(); return; }
      counts.originRequests++; event({ kind: 'origin', accepted: true, method: 'GET', host: WINDOWS_MANAGED_PAC_HOST, path: '/search', markerMatched: true, resultCount: 3 });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(payload.html), 'cache-control': 'no-store', connection: 'close' }); response.end(payload.html);
    });
    const secureContext = createSecureContext({ key: privateKeyPem, cert: certificatePem });
    const tls = createTlsServer({ key: privateKeyPem, cert: certificatePem, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'],
      SNICallback(servername, callback) { if (servername !== WINDOWS_MANAGED_PAC_HOST) { counts.tlsRejected++; event({ kind: 'tls', accepted: false }); callback(new Error('Owned TLS host denied')); } else callback(null, secureContext); },
    }, socket => {
      track(socket);
      if (socket.servername !== WINDOWS_MANAGED_PAC_HOST) { counts.tlsRejected++; event({ kind: 'tls', accepted: false }); socket.destroy(); return; }
      counts.tlsAccepted++; event({ kind: 'tls', accepted: true, servername: WINDOWS_MANAGED_PAC_HOST, alpn: socket.alpnProtocol || null }); origin.emit('connection', socket);
    });
    tls.on('tlsClientError', () => { counts.transportErrors++; });
    const tlsPort = await listen(tls, 'managed-pac-owned-tls');
    const proxy = createServer((_request, response) => { counts.connectDenied++; response.writeHead(403, { connection: 'close' }); response.end(); });
    proxy.on('connect', (request, socket, head) => {
      const match = /^([^:\[\]]+):443$/.exec(request.url) || /^\[([0-9a-fA-F:]+)\]:443$/.exec(request.url);
      let address;
      try { if (match) address = ipKey(match[1]); } catch { /* Unknown/private authorities never become dial targets. */ }
      if (!address || !allowed.has(address) || head.length || counts.connectAccepted >= 32 || closed) {
        counts.connectDenied++; event({ kind: 'connect', accepted: false }); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      counts.connectAccepted++; event({ kind: 'connect', accepted: true, numericAddress: address, port: 443 });
      // The sole dial operation is a fixed owned loopback listener. The supplied
      // numeric destination is only an assertion, never a socket destination.
      const upstream = track(connect({ host: '127.0.0.1', port: tlsPort }));
      socket.once('close', () => upstream.destroy()); upstream.once('close', () => socket.destroy());
      upstream.once('error', () => { counts.transportErrors++; socket.destroy(); });
      upstream.once('connect', () => { if (closed || socket.destroyed) { upstream.destroy(); return; } socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); socket.pipe(upstream); upstream.pipe(socket); });
    });
    const proxyPort = await listen(proxy, 'managed-pac-owned-connect');
    const script = `function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${proxyPort}"; }\n`;
    const prefix = `/owned-${fixtureId}`;
    const pac = createServer((request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      if (!['GET', 'HEAD'].includes(request.method) || path !== `${prefix}/policy.pac`) { response.writeHead(404, { connection: 'close' }); response.end(); return; }
      counts.pacRequests++; event({ kind: 'pac', method: request.method }); response.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'content-length': Buffer.byteLength(script), 'cache-control': 'no-store', connection: 'close' }); response.end(request.method === 'HEAD' ? undefined : script);
    });
    const pacPort = await listen(pac, 'managed-pac-owned-policy');
    return { fixture: { schemaVersion: 1, fixtureId, marker: payload.marker, nativeQuery: payload.nativeQuery, expectedSources: payload.expectedSources,
      pacUrl: `http://127.0.0.1:${pacPort}${prefix}/policy.pac`, proxyUrl: `http://127.0.0.1:${proxyPort}`,
      allowedConnectAddresses: [...allowed], tlsHost: WINDOWS_MANAGED_PAC_HOST, caSha256: createHash('sha256').update(caPem).digest('hex'), certificateSha256: createHash('sha256').update(certificatePem).digest('hex'),
      externalForwarding: false, certificateStoreWrites: 0, modelCalls: 0 }, stats, stop };
  } catch (error) { await stop(); throw error; }
}
