import { createServer, connect } from 'node:net';

// Owned loopback ports only. The first speaks CONNECT but cannot carry TLS;
// the second tunnels solely to the explicitly selected probe host.
export async function startPluginProxyFixture(context, options = {}) {
  const destination = new URL(options.origin || 'https://github.com/');
  const authority = `${destination.hostname}:${destination.port || 443}`;
  const upstream = options.upstreamProxy ? new URL(options.upstreamProxy) : null;
  if (destination.protocol !== 'https:' || destination.username || destination.password) throw new Error('HTTPS fixture origin required');
  if (upstream && (upstream.protocol !== 'http:' || upstream.username || upstream.password)) throw new Error('Credential-free HTTP fixture upstream required');
  const events = [], counts = { bad: 0, good: 0, forwardedBytes: 0 };
  const start = async role => {
    const sockets = new Set();
    const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
    const server = createServer(client => {
      const peer = client.remoteAddress || '';
      if (peer !== '::1' && !peer.startsWith('127.') && !peer.startsWith('::ffff:127.')) { client.destroy(); return; }
      track(client); client.setTimeout(10000, () => client.destroy());
      let buffered = Buffer.alloc(0);
      const first = chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > 8192 || buffered[0] !== 67) { client.destroy(); return; }
        const end = buffered.indexOf('\r\n\r\n'); if (end < 0) return;
        client.removeListener('data', first);
        const line = buffered.subarray(0, buffered.indexOf('\r\n')).toString();
        if (line !== `CONNECT ${authority} HTTP/1.1` && line !== `CONNECT ${authority} HTTP/1.0`) { client.destroy(); return; }
        counts[role]++; events.push(role);
        if (role === 'bad') { client.end('HTTP/1.1 200 Connection Established\r\n\r\n'); return; }
        const target = track(connect(upstream ? Number(upstream.port || 80) : Number(destination.port || 443), upstream ? upstream.hostname : destination.hostname, () => {
          if (upstream) target.write(buffered);
          else { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (buffered.length > end + 4) target.write(buffered.subarray(end + 4)); }
          client.on('data', data => { counts.forwardedBytes += data.length; });
          target.on('data', data => { counts.forwardedBytes += data.length; });
          client.pipe(target); target.pipe(client);
        }));
        target.once('error', () => client.destroy());
        client.once('close', () => target.destroy()); target.once('close', () => client.destroy());
      };
      client.on('data', first);
    });
    context.addCleanup(`close owned ${role} plugin proxy`, async () => {
      const closed = new Promise(done => server.close(done));
      for (const socket of sockets) socket.destroy();
      await closed;
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen({ host: '::', port: 0, ipv6Only: false }, done); });
    const port = server.address().port; context.registerPort(`plugin-${role}-proxy`, port);
    return port;
  };
  const badPort = await start('bad'), goodPort = await start('good');
  return { badPort, goodPort, events, counts };
}
