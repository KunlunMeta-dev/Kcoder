import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// In-memory credential comparison only; never record request headers or keys.
export async function startCredentialObserver(context, upstreamUrl, { label, oldKey, newKey }) {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1') throw new Error('Credential observer requires an owned loopback upstream');
  context.registerSecret(oldKey); context.registerSecret(newKey);
  const authentication = [];
  const active = new Set();
  const controllers = new Set();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    timeout.unref();
    const abort = () => controller.abort();
    response.once('close', abort);
    const operation = (async () => {
      const target = new URL(request.url, upstream);
      if (target.origin !== upstream.origin) throw new Error('Credential observer request escaped its owned upstream');
      authentication.push(request.headers.authorization === `Bearer ${oldKey}` ? 'old'
        : request.headers.authorization === `Bearer ${newKey}` ? 'new' : 'unexpected');
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('credential observer request exceeds limit');
        chunks.push(chunk);
      }
      const upstreamResponse = await fetch(target, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: Buffer.concat(chunks), signal: controller.signal, redirect: 'error',
      });
      response.writeHead(upstreamResponse.status, { 'content-type': upstreamResponse.headers.get('content-type') || 'application/octet-stream' });
      response.flushHeaders();
      if (upstreamResponse.body) await pipeline(Readable.fromWeb(upstreamResponse.body), response);
      else response.end();
    })().catch(() => response.destroy()).finally(() => {
      clearTimeout(timeout);
      controllers.delete(controller);
      response.removeListener('close', abort);
    });
    active.add(operation); void operation.finally(() => active.delete(operation));
  });
  context.addCleanup(`close ${label}`, async () => {
    const stopped = new Promise(resolve => server.close(resolve));
    for (const controller of controllers) controller.abort();
    server.closeAllConnections(); await Promise.allSettled([...active]); await stopped;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.registerPort(label, server.address().port);
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, authentication };
}
