import { createServer } from 'node:http';

/** Account-free real MCP peers: protocol rejection, HTTP401, disconnect, timeout, zero tools. */
export async function startActivationMcp(context) {
  const server = createServer(async (request, response) => {
    if (request.url === '/disconnect') { request.socket.destroy(); return; }
    if (request.url === '/timeout') return;
    if (request.url === '/unauthorized') {
      response.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'text/plain' });
      response.end('private-protocol-marker'); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (!Object.hasOwn(input, 'id')) { response.writeHead(202); response.end(); return; }
    const output = request.url === '/protocol'
      ? { error: { code: -32602, message: 'private-protocol-marker' } }
      : { result: input.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '0' } }
        : { tools: [] } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, ...output }));
  });
  context.addCleanup('close activation MCP peers', async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  context.registerPort('activation MCP peers', port);
  return `http://127.0.0.1:${port}`;
}
