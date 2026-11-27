const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ready = process.argv[2];
if (!ready || !fs.existsSync(path.join(path.dirname(ready), '.owner.json'))) throw Error('Owned fixture root required');
let upgradesStarted = 0, upgradesClosed = 0;
const server = http.createServer((request, response) => {
  if (request.url.startsWith('/api/servers?fault=body')) {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
    response.write('partial');
    setImmediate(() => response.socket.destroy());
  } else if (request.url.startsWith('/api/servers')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ mount: request.headers['x-kcoder-mobile-mount'] ?? null,
      proof: request.headers['x-kcoder-mobile-mount-proof'] ?? null, upgradesStarted, upgradesClosed }));
  } else if (request.url === '/mobile/worker.js') {
    response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
    response.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));");
  } else {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Owned isolated Relay</title><main>Owned loopback fixture</main>');
  }
});
server.on('upgrade', (_request, socket) => {
  upgradesStarted++;
  socket.on('error', () => {});
  socket.once('end', () => socket.destroy());
  socket.once('close', () => { upgradesClosed++; });
  socket.resume();
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(ready, JSON.stringify({ port: server.address().port }), { flag: 'wx' }));
