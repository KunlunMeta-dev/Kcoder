import assert from 'node:assert/strict';
import { Agent, createServer, request as upstreamRequest } from 'node:http';

/** Owned loopback network fault. It never parses a WebSocket payload, token,
 * credential or body, and never changes the product's authorization decisions.
 */
export async function startPeerDeviceProxy(context, gateway) {
  const target = new URL(gateway.baseUrl);
  assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1');
  const agent = new Agent({ keepAlive: false });
  const sockets = new Set(), requests = new Set(), peers = new Map();
  let closed = false, holdNewPeers = false, upgrades = 0, rejected = 0, drops = 0, httpRequests = 0, receiverConnectedAtSourceDrop = false;
  const own = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const ownRequest = request => { requests.add(request); request.once('close', () => requests.delete(request));
    request.once('socket', own); return request; };
  const options = request => ({ hostname: target.hostname, port: Number(target.port), method: request.method,
    path: request.url, headers: { ...request.headers, host: target.host }, agent });
  const server = createServer((request, response) => {
    httpRequests++;
    const upstream = ownRequest(upstreamRequest(options(request), result => {
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
      result.once('error', () => response.destroy());
    }));
    upstream.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => upstream.destroy()); request.pipe(upstream);
  });
  server.on('connection', own);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (request, socket, head) => {
    let peer;
    try { const address = new URL(request.url, 'http://127.0.0.1');
      peer = address.pathname === '/rpc' && address.searchParams.get('channel') === 'agent-peer';
    } catch { socket.destroy(); return; }
    if (peer && holdNewPeers) {
      rejected++; socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    const upstream = ownRequest(upstreamRequest(options(request)));
    let bound, remoteSocket;
    const settle = () => { if (bound) bound.closed = true; remoteSocket?.destroy(); upstream.destroy(); };
    socket.once('close', settle); socket.once('error', settle);
    upstream.once('error', () => socket.destroy());
    upstream.once('response', result => {
      socket.write(`HTTP/1.1 ${result.statusCode} ${result.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      result.resume(); socket.end();
    });
    upstream.once('upgrade', (result, remote, remoteHead) => {
      remoteSocket = remote;
      own(remote);
      if (closed || socket.destroyed || peer && holdNewPeers) { remote.destroy(); socket.destroy(); return; }
      if (peer) {
        const ordinal = ++upgrades;
        bound = { ordinal, socket, upstream: remote, closed: false };
        peers.set(ordinal, bound);
      }
      const headers = [`HTTP/1.1 ${result.statusCode} ${result.statusMessage}`];
      for (let index = 0; index < result.rawHeaders.length; index += 2) headers.push(`${result.rawHeaders[index]}: ${result.rawHeaders[index + 1]}`);
      socket.write(headers.join('\r\n') + '\r\n\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.once('error', () => socket.destroy());
      remote.once('close', () => { if (bound) bound.closed = true; socket.destroy(); });
      socket.pipe(remote); remote.pipe(socket);
    });
    upstream.end();
  });
  const close = async () => {
    if (closed) return;
    closed = true; agent.destroy();
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  context.addCleanup('close owned peer-device network proxy', close);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  context.registerPort('peer-device-network-proxy', server.address().port);
  const snapshot = () => ({ peerUpgrades: upgrades, sourceConnected: Boolean(peers.get(1) && !peers.get(1).closed),
    receiverConnected: Boolean(peers.get(2) && !peers.get(2).closed), sourceDrops: drops,
    receiverConnectedAtSourceDrop, rejectedNewPeerUpgrades: rejected, newPeersBlocked: holdNewPeers, httpRequests, closed });
  return Object.freeze({ baseUrl: `http://127.0.0.1:${server.address().port}`, snapshot,
    closeSourceOnly() {
      assert.equal(closed, false); assert.equal(upgrades, 2, 'Start exactly one Source and then one Receiver before this fault');
      const source = peers.get(1), receiver = peers.get(2);
      assert.ok(source && !source.closed && receiver && !receiver.closed, 'Both original peer sockets must still be connected');
      holdNewPeers = true; drops++; receiverConnectedAtSourceDrop = !receiver.closed;
      source.closed = true; source.socket.destroy(); source.upstream.destroy();
      return snapshot();
    },
    allowNewPeerConnections() { assert.equal(closed, false); holdNewPeers = false; },
    close,
  });
}
