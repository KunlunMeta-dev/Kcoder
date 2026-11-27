import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openRpc, initializeRpc, gatewayRpcUrl } from '../../../apps/kcoder-studio/e2e/harness/rpc.mjs';
import { startApprovalModelFixture } from '../../../apps/kcoder-studio/e2e/harness/approval-model.mjs';

let inputText = '';
for await (const chunk of process.stdin) {
  inputText += chunk;
  if (inputText.length > 16384) throw new Error('Probe input exceeds its limit');
}
const input = JSON.parse(inputText);
const cleanup = [];
const clients = [];
const heldTurnPrompt = 'CASE28_HOLD_ACTIVE_TURN';
let releaseHeldTurn = false;
// Fixed responses exercise persisted history authorization, independent of model behavior.
const fixture = await startApprovalModelFixture({ addCleanup: (_name, callback) => cleanup.push(callback), registerPort() {} },
  { responseSteps: ({ body }) => {
    const messages = JSON.stringify(body.messages ?? []);
    if (messages.includes(heldTurnPrompt)) {
      return [
        { delta: { content: 'CASE28_PROVIDER_HELD' } },
        { ready: () => releaseHeldTurn, delta: { content: 'CASE28_PROVIDER_RELEASED' } },
        { delta: {}, finishReason: 'stop' },
      ];
    }
    return [
      { delta: { content: 'ISOLATED_ACCOUNT_REPLY' } },
      { delta: {}, finishReason: 'stop' },
    ];
  } });
const connect = async endpoint => {
  const client = await openRpc(gatewayRpcUrl({ wsUrl: endpoint.url.replace('http:', 'ws:') }, 'shared', 'cookie-auth'),
    { headers: { Cookie: endpoint.cookie, Origin: endpoint.url } });
  clients.push(client);
  await initializeRpc(client, 'shared-ssh-account-isolation');
  return client;
};
try {
  for (const endpoint of input.endpoints.slice(0, 2)) {
    await writeFile(join(endpoint.home, '.config/kcoder/settings.json'), JSON.stringify({
      active_provider: 'fixture', max_retries: 0, tools: { disabled: ['*'] },
      providers: { fixture: { api_format: 'openai_chat_completions', endpoint: fixture.baseUrl,
        default_model: 'fixture', authentication: { mode: 'none' },
        context_window_tokens: 131072, max_output_tokens: 1024, output_headroom_tokens: 1024 } },
    }));
  }
  const ids = [];
  for (const [index, endpoint] of input.endpoints.slice(0, 2).entries()) {
    const client = await connect(endpoint);
    const { thread } = await client.request('thread/start');
    ids.push(thread.id);
    const { turn } = await client.request('turn/start', { threadId: thread.id,
      input: [{ type: 'text', text: `PRIVATE_ACCOUNT_${index}_MARKER` }] });
    const done = await client.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id,
      30000, 'isolated account turn');
    assert.equal(done.params.turn.status, 'completed', JSON.stringify(await client.request('thread/read', { threadId: thread.id })));
    await client.request('gateway/app-server/restart', { confirm: true });
    client.close();
  }
  for (const [index, endpoint] of input.endpoints.slice(0, 2).entries()) {
    const client = await connect(endpoint);
    const listed = JSON.stringify(await client.request('thread/list', { limit: 100 }));
    assert.ok(listed.includes(ids[index]), 'own persisted history must survive reconnect');
    assert.ok(!listed.includes(ids[1 - index]), 'other account history must not enter the list');
    const own = JSON.stringify(await client.request('thread/read', { threadId: ids[index] }));
    assert.ok(own.includes(`PRIVATE_ACCOUNT_${index}_MARKER`));
    await assert.rejects(client.request('thread/read', { threadId: ids[1 - index] }));
    await assert.rejects(client.request('thread/resume', { threadId: ids[1 - index] }));
    await assert.rejects(client.request('thread/delete', { threadId: ids[1 - index] }));
  }
  const sameUser = await connect(input.endpoints[2]);
  assert.ok(JSON.stringify(await sameUser.request('thread/read', { threadId: ids[0] })).includes('PRIVATE_ACCOUNT_0_MARKER'));
  await assert.rejects(sameUser.request('thread/read', { threadId: ids[1] }));

  const owner = await connect(input.endpoints[0]);
  const otherAccount = await connect(input.endpoints[1]);
  const { thread: activeThread } = await owner.request('thread/start');
  const { turn: activeTurn } = await owner.request('turn/start', { threadId: activeThread.id,
    input: [{ type: 'text', text: `${heldTurnPrompt}: keep this synthetic task active until Bob's request is checked` }] });
  await owner.waitFor(message => message.method === 'item/delta' &&
    message.params?.threadId === activeThread.id && message.params?.turnId === activeTurn.id &&
    JSON.stringify(message.params?.delta).includes('CASE28_PROVIDER_HELD'),
  30000, 'Alice active turn partial delta');
  assert.equal((await owner.request('thread/read', { threadId: activeThread.id })).thread.status, 'running');

  await assert.rejects(otherAccount.request('thread/read', { threadId: activeThread.id }));
  const refusedCancel = await otherAccount.request('turn/interrupt', {
    threadId: activeThread.id,
    turnId: activeTurn.id,
  });
  assert.deepEqual(refusedCancel, { interrupted: false }, 'Bob app-server must refuse Alice’s foreign active turn');
  assert.ok(JSON.stringify(await otherAccount.request('thread/read', { threadId: ids[1] }))
    .includes('PRIVATE_ACCOUNT_1_MARKER'), 'Bob’s authenticated connection must remain usable after the refusal');

  const ownerTerminalsBeforeRelease = owner.messages().filter(message =>
    ['turn/completed', 'turn/interrupted'].includes(message.method) &&
    message.params?.threadId === activeThread.id && message.params?.turnId === activeTurn.id);
  assert.deepEqual(ownerTerminalsBeforeRelease, [], 'Alice’s active turn must remain nonterminal before provider release');
  assert.equal((await owner.request('thread/read', { threadId: activeThread.id })).thread.status, 'running');

  releaseHeldTurn = true;
  const completed = await owner.waitFor(message => message.method === 'turn/completed' &&
    message.params?.threadId === activeThread.id && message.params?.turnId === activeTurn.id,
  30000, 'Alice turn completion after foreign cancellation refusal');
  assert.equal(completed.params.turn.status, 'completed');
  assert.equal(fixture.requests.filter(body => JSON.stringify(body.messages ?? []).includes(heldTurnPrompt)).length, 1,
    'the held account-isolation turn must use exactly one synthetic provider request');
  process.stdout.write(JSON.stringify({ passed: true, crossAccountHistoryDenied: true,
    sameAccountOtherClientSharesHistory: true, crossAccountCancelDenied: true,
    ownerTurnContinued: true }) + '\n');
} finally {
  releaseHeldTurn = true;
  for (const client of clients) client.close();
  for (const callback of cleanup.reverse()) await callback();
}
