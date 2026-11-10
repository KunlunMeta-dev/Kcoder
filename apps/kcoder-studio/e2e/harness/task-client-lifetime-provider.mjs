import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Controlled transport cancellation, not a real-model behavior assertion.
export async function startTaskClientLifetimeProvider(context) {
  const attempts = [];
  const pending = new Set();
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        assert.ok(bytes <= 1024 * 1024);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const hold = JSON.stringify(body.messages.at(-1)).includes('LIFETIME_HOLD');
      assert.ok(attempts.length < 2, 'Cancellation must never replay model input');
      const attempt = { hold, closed: false };
      attempts.push(attempt);
      response.once('close', () => { attempt.closed = true; pending.delete(response); });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      if (hold) { pending.add(response); return; }
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0,
        delta: { role: 'assistant', content: 'LIFETIME_PEER_COMPLETED' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0,
        delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    })().catch(() => response.destroy());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  context.registerPort('controlled-task-lifetime-provider', server.address().port);
  context.addCleanup('close controlled task lifetime provider', async () => {
    const stopped = new Promise(done => server.close(done));
    for (const response of pending) response.destroy();
    server.closeAllConnections();
    await stopped;
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, attempts };
}
