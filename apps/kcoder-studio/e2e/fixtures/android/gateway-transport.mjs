import { createServer, connect } from 'node:net';

// Model-independent transport loss. Forward bytes unchanged to this run's loopback Gateway.
export async function startNativeGatewayTransport(context, gateway) {
  let online = true, droppedConnections = 0;
  let targetPort = gateway?.port;
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket)); return socket;
  };
  const server = createServer(client => {
    if (!online || !targetPort || sockets.size >= 32) { client.destroy(); return; }
    track(client);
    const upstream = track(connect(targetPort, '127.0.0.1', () => {
      client.pipe(upstream); upstream.pipe(client);
    }));
    client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
  });
  context.addCleanup('close native Gateway transport fixture', async () => {
    const closed = new Promise(done => server.close(done));
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port; context.registerPort('native-gateway-transport', port);
  return { port, baseUrl: `http://127.0.0.1:${port}`, get droppedConnections() { return droppedConnections; },
    setTarget(value) { if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw Error('Invalid owned Gateway port'); targetPort = value.port; },
    setOnline(value) { online = value; if (!value) { droppedConnections += sockets.size; for (const socket of sockets) socket.destroy(); } } };
}
