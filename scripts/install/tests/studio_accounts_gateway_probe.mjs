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
// Fixed responses exercise persisted history authorization, independent of model behavior.
const fixture = await startApprovalModelFixture({ addCleanup: (_name, callback) => cleanup.push(callback), registerPort() {} },
  { textOnly: true, textOnlyResponse: 'ISOLATED_ACCOUNT_REPLY' });
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
  process.stdout.write(JSON.stringify({ passed: true, ids, crossAccountHistoryDenied: true,
    sameAccountOtherClientSharesHistory: true }) + '\n');
} finally {
  for (const client of clients) client.close();
  for (const callback of cleanup.reverse()) await callback();
}
