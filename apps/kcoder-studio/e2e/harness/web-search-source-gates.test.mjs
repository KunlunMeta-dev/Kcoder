import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { RunContext, waitFor } from './run-context.mjs';
import { createWebSourceGates } from './web-search-source-gates.mjs';

test('a paused owned response records transport cancellation while an independent peer finishes', async () => {
  const context = await RunContext.create(import.meta.url, { testId: 'source-http-gate-cancel-late-reply-and-peer', tier: 'harness-unit', modelPolicy: 'Owned loopback HTTP lifecycle only; no model/native-tool claim' });
  let failure;
  const gates = createWebSourceGates(), tasks = new Set(), sockets = new Set();
  const server = createServer((request, response) => {
    const task = (async () => {
      if (request.url === '/peer') { response.end('peer remains available'); return; }
      response.writeHead(200); response.write('first chunk');
      await gates.pause('owner-stream', response); response.end('late final chunk');
    })();
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  context.addCleanup('close owned source gate unit server', async () => {
    gates.releaseAll(); const done = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy(); await done; await Promise.allSettled([...tasks]);
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; context.registerPort('source-gate-unit', port);
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/owner`, { signal: controller.signal });
    const reader = response.body.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), 'first chunk');
    controller.abort(); await assert.rejects(() => reader.read());
    await waitFor(() => gates.observations[0]?.closedBeforeRelease, 3000, 'actual cancelled transport close');
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/peer`)).text(), 'peer remains available');
    assert.equal(gates.release('owner-stream'), true);
    await waitFor(() => gates.observations[0].replyAttempted, 3000, 'late server reply after native transport close');
    assert.equal(gates.observations[0].transportClosedAtReply, true);
  } catch (error) { failure = error; throw error; }
  finally { await context.finish(failure ? 'failed' : 'passed', { observations: gates.observations }, failure); }
});
