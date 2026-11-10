import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { randomBytes } from 'node:crypto';

const WINDOWS_PAC_TEST_MODULE = 'web_network::windows_auto_proxy::owned_pac_tests::';
export const WINDOWS_PAC_TEST_FILTER = WINDOWS_PAC_TEST_MODULE + 'owned_pac_';
export const WINDOWS_PAC_TESTS = Object.freeze([
  'owned_pac_resolves_original_url_direct_and_proxy',
  'owned_pac_errors_do_not_fall_back_to_direct',
  'owned_pac_cancel_closes_only_owner_and_late_callbacks_settle',
  'owned_pac_deadline_closes_resolver',
  'owned_pac_snapshot_is_lazy_and_private',
].map(name => WINDOWS_PAC_TEST_MODULE + name));

/** Owns only these loopback servers/sockets. Never reads or changes system proxy settings. */
export async function startWindowsPacFixture(owner = {}) {
  const servers = [], sockets = new Set(), pacSockets = new Set();
  const counts = { pacRequests: 0, slowPacRequests: 0, proxyConnections: 0 };
  let stopped = false;
  const stats = () => ({ ...counts, activeSockets: pacSockets.size, closed: stopped });
  const stop = async () => {
    if (stopped) return stats();
    stopped = true;
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => {
      if (!server.listening) { resolve(); return; }
      server.close(resolve);
    })));
    sockets.clear(); pacSockets.clear();
    return stats();
  };
  owner.addCleanup?.('stop owned Windows PAC fixture', stop);
  const listen = async (server, label) => {
    servers.push(server);
    server.on('connection', socket => {
      if (stopped) { socket.destroy(); return; }
      sockets.add(socket); socket.on('close', () => { sockets.delete(socket); pacSockets.delete(socket); });
    });
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const port = server.address().port;
    owner.registerPort?.(label, port);
    return port;
  };
  try {
    // Resolution-only tests must never connect to a returned proxy endpoint.
    const rejectProxy = () => createTcpServer(socket => { counts.proxyConnections++; socket.destroy(); });
    const portA = await listen(rejectProxy(), 'windows-pac-proxy-a');
    const portB = await listen(rejectProxy(), 'windows-pac-proxy-b');
    const prefix = '/' + randomBytes(16).toString('hex');
    const urls = { a: 'http://same.pac.invalid/a', b: 'http://same.pac.invalid/b', direct: 'https://direct.pac.invalid/value',
      secureA: 'https://a.pac.invalid/value', secureB: 'https://b.pac.invalid/value' };
    const script = revision => `function FindProxyForURL(url, host) {
  if (host === "direct.pac.invalid") return "DIRECT";
  if (url === "${urls.a}" || host === "a.pac.invalid") return "PROXY 127.0.0.1:${revision === 1 ? portA : portB}";
  if (url === "${urls.b}" || host === "b.pac.invalid") return "PROXY 127.0.0.1:${revision === 1 ? portB : portA}";
  return "PROXY 127.0.0.1:${portA}";
}\n`;
    const server = createServer((request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      if (request.method !== 'GET') { response.writeHead(405, { connection: 'close' }); response.end(); return; }
      if (path === prefix + '/stats') {
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'cache-control': 'no-store' });
        response.end(JSON.stringify(stats())); return;
      }
      if (!path.startsWith(prefix + '/')) { response.writeHead(404, { connection: 'close' }); response.end(); return; }
      counts.pacRequests++; pacSockets.add(request.socket);
      if (path === prefix + '/slow.pac') {
        counts.slowPacRequests++;
        // WinHTTP may keep a service-level download after closing one resolver.
        // Cleanup closes this fixture's socket; it never terminates that service.
        response.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'content-length': '4096', 'cache-control': 'no-store' });
        response.flushHeaders(); return;
      }
      if (path === prefix + '/missing.pac') { response.writeHead(404, { connection: 'close' }); response.end('Owned missing PAC'); return; }
      if (![prefix + '/policy.pac', prefix + '/policy-v2.pac', prefix + '/bad.pac'].includes(path)) { response.writeHead(404, { connection: 'close' }); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', connection: 'close', 'cache-control': 'no-store' });
      response.end(path === prefix + '/bad.pac' ? 'function FindProxyForURL( {' : script(path === prefix + '/policy-v2.pac' ? 2 : 1));
    });
    const port = await listen(server, 'windows-pac-script');
    const base = `http://127.0.0.1:${port}${prefix}`;
    return { fixture: { schemaVersion: 1, pacUrl: base + '/policy.pac', pacV2Url: base + '/policy-v2.pac', slowPacUrl: base + '/slow.pac',
      badPacUrl: base + '/bad.pac', missingPacUrl: base + '/missing.pac', statsUrl: base + '/stats',
      proxyA: `http://127.0.0.1:${portA}`, proxyB: `http://127.0.0.1:${portB}`, urls }, stats, stop };
  } catch (error) { await stop(); throw error; }
}
