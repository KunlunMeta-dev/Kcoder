import test from 'node:test';
import assert from 'node:assert/strict';
import { pauseWikiBeforeLogout } from '../wiki-logout.js';

function fixture(response) {
  const methods = [];
  let detached = false;
  const broker = {
    attach() {}, detach() { detached = true; },
    receive(client, frame) {
      const request = JSON.parse(frame);
      methods.push(request.method);
      queueMicrotask(() => client.send(response(request)));
    },
  };
  return { broker, methods, detached: () => detached };
}

test('logout waits for authenticated target pause acknowledgement', async () => {
  const value = fixture(request => request.id === 1
    ? { id: 1, result: { capabilities: { experimental: { knowledgeIngestV1: true } } } }
    : { id: 2, result: { pausedJobs: 2 } });
  await pauseWikiBeforeLogout(value.broker);
  assert.deepEqual(value.methods, ['initialize', 'knowledge/job/pauseAll']);
  assert.equal(value.detached(), true);
});

test('older targets without Wiki need no pause call', async () => {
  const value = fixture(() => ({ id: 1, result: { capabilities: {} } }));
  await pauseWikiBeforeLogout(value.broker);
  assert.deepEqual(value.methods, ['initialize']);
});

test('remote error is not reported as confirmed pause', async () => {
  const value = fixture(request => request.id === 1
    ? { id: 1, result: { capabilities: { experimental: { knowledgeIngestV1: true } } } }
    : { id: 2, error: { message: 'Unavailable' } });
  await assert.rejects(pauseWikiBeforeLogout(value.broker), /not confirmed/);
  assert.equal(value.detached(), true);
});

test('timeout releases the temporary subscriber', async () => {
  let detached = false;
  await assert.rejects(pauseWikiBeforeLogout({ attach() {}, receive() {}, detach() { detached = true; } },
    { timeoutMs: 5 }), /not confirmed/);
  assert.equal(detached, true);
});
