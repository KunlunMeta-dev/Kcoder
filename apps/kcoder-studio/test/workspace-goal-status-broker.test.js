import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerFixture, fakeClient, validInitializeParams } from './workspace-app-server-broker.test-support.js';

test("Goal batch observations require explicit per-client negotiation", () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const legacy = fakeClient(); const modern = fakeClient(); broker.attach(legacy); broker.attach(modern);
  broker.receive(legacy, JSON.stringify({ id: 1, method: "initialize", params: validInitializeParams() }));
  assert.equal(upstream[0].params.capabilities.experimental.threadGoalStatusBatchV1, true);
  respond({ id: upstream[0].id, result: { capabilities: { experimental: { residentThreads: true, threadGoalStatusBatchV1: true } } } });
  broker.receive(modern, JSON.stringify({ id: 2, method: "initialize", params: { ...validInitializeParams(), capabilities: { experimental: { threadGoalStatusBatchV1: true } } } }));
  const before = upstream.length;
  broker.receive(legacy, JSON.stringify({ id: 10, method: "thread/goal/status/readMany", params: { threadIds: ["thread-1"] } }));
  assert.equal(upstream.length, before);
  assert.equal(legacy.messages.at(-1).error.code, -32601);
  broker.receive(modern, JSON.stringify({ id: 11, method: "thread/goal/status/readMany", params: { threadIds: ["thread-1"] } }));
  assert.equal(upstream.at(-1).method, "thread/goal/status/readMany");
  const observations = [{ threadId: "thread-1", availability: "available", status: "active" }];
  respond({ id: upstream.at(-1).id, result: { observations } });
  assert.deepEqual(modern.messages.at(-1).result.observations, observations);
  broker.receive(legacy, JSON.stringify({ id: 12, method: "model/list", params: {} }));
  respond({ id: upstream.at(-1).id, result: [{ id: "model-1" }] });
  assert.deepEqual(legacy.messages.at(-1).result, [{ id: "model-1" }]);
});

test("Goal batch observation is rejected when the target does not advertise it", () => {
  const { broker, upstream, respond } = brokerFixture({ residentThreads: true });
  const client = fakeClient(); broker.attach(client);
  broker.receive(client, JSON.stringify({ id: 1, method: "initialize", params: { ...validInitializeParams(), capabilities: { experimental: { threadGoalStatusBatchV1: true } } } }));
  respond({ id: upstream[0].id, result: { capabilities: { experimental: { residentThreads: true } } } });
  const before = upstream.length;
  broker.receive(client, JSON.stringify({ id: 2, method: "thread/goal/status/readMany", params: { threadIds: ["thread-1"] } }));
  assert.equal(upstream.length, before);
  assert.equal(client.messages.at(-1).error.code, -32601);
});
