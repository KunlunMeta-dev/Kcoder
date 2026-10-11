import { createServer } from 'node:http';

// In-memory credential comparison only; never record request headers or keys.
export async function startCredentialObserver(context, upstreamUrl, { label, oldKey, newKey }) {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1') throw new Error('Credential observer requires an owned loopback upstream');
  context.registerSecret(oldKey); context.registerSecret(newKey);
  const authentication = [];
  const active = new Set();
  const server = createServer((request, response) => {
    const operation = (async () => {
      authentication.push(request.headers.authorization === `Bearer ${oldKey}` ? 'old'
        : request.headers.authorization === `Bearer ${newKey}` ? 'new' : 'unexpected');
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('credential observer request exceeds limit');
        chunks.push(chunk);
      }
      const upstream = await fetch(new URL(request.url, upstreamUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(15000),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') });
      response.end(await upstream.text());
    })().catch(() => response.destroy());
    active.add(operation); void operation.finally(() => active.delete(operation));
  });
  context.addCleanup(`close ${label}`, async () => {
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); await Promise.allSettled([...active]); await stopped;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.registerPort(label, server.address().port);
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, authentication };
}
