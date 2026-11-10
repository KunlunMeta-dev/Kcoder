import assert from 'node:assert/strict';
import { createServer } from 'node:http';

export function migrationRequestAudit(requests) {
  const connectivity = request => request.method === 'HEAD' && request.path === '/v1/chat/completions';
  const inference = request => request.method === 'POST' && request.path === '/v1/chat/completions';
  return { totalRequests: requests.length, connectivityRequests: requests.filter(connectivity).length,
    inferenceRequests: requests.filter(inference).length,
    unexpectedRequests: requests.filter(request => !connectivity(request) && !inference(request)) };
}
export function assertNoMigrationInference(requests) {
  const audit = migrationRequestAudit(requests);
  assert.equal(audit.inferenceRequests, 0); assert.deepEqual(audit.unexpectedRequests, []);
  return audit;
}
export async function startMigrationNoInferenceFixture(context) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.writeHead(500); response.end('No inference is permitted in this fixture');
    if (requests.length > 64) server.closeAllConnections();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.registerPort('no-inference-audit', server.address().port);
  context.addCleanup('close owned no-inference fixture', async () => {
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
