import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startProtocolStreamFixture } from '../../harness/protocol-stream-fixture.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';
await runE2E(import.meta.url, {
  testId: 'three-protocol-stream-thinking-text-and-eof', tier: 'full-integration',
  modelPolicy: 'model-independent exact stream projection; real HTTP/Gateway/Engine with bounded loopback SSE',
}, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'protocol-stream' });
  const fixture = await startProtocolStreamFixture(context);
  const results = [];
  for (const apiFormat of ['anthropic_messages', 'openai_chat_completions', 'openai_responses']) {
    const home = context.pathInState(apiFormat);
    const key = 'protocol-fixture-only'; context.registerSecret(key);
    await context.writeStateJson(`${apiFormat}/credentials.json`, { fixture: { type: 'api', key } });
    await context.writeStateJson(`${apiFormat}/settings.json`, {
      active_provider: 'fixture', max_retries: 0, permission_mode: 'yolo',
      providers: { fixture: { api_format: apiFormat, endpoint: apiFormat === 'anthropic_messages' ? fixture.baseUrl.replace(/\/v1$/, '') : fixture.baseUrl,
        ...(apiFormat === 'openai_chat_completions' ? { chat_protocol: 'minimax' } : {}), default_model: 'fixture-model', no_proxy: true,
        context_window_tokens: 128000, max_output_tokens: 1024, output_headroom_tokens: 1024 } },
    });
    const serversFile = await context.writeStateJson(`${apiFormat}-servers.json`, [{
      id: 'fixture', label: 'Protocol fixture', transport: 'local', command: resolve(repoRoot, 'target/debug/kcoder'), workspace,
    }]);
    const gateway = await startGateway(context, { label: apiFormat, workspace, serversFile,
      env: { KCODER_CONFIG_DIR: home, KCODER_MAX_RETRIES: '0' } });
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'fixture', await waitForGatewayRpcToken(context, gateway)));
    context.addCleanup(`close ${apiFormat} rpc`, () => rpc.close());
    await initializeRpc(rpc, 'protocol-stream-matrix');
    for (const mode of ['complete', 'eof', 'tool', 'no_thinking']) {
      const truncated = mode === 'eof';
      const beforeRequests = fixture.requests.length;
      const beforeTool = await readFile(resolve(workspace, 'protocol-tool-count.txt'), 'utf8').catch(() => '');
      const { thread } = await rpc.request('thread/start');
      const { turn } = await rpc.request('turn/start', { threadId: thread.id,
        input: [{ type: 'text', text: `FIXTURE_${mode.toUpperCase()}` }] });
      const done = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id && message.params?.threadId === thread.id, 30000, 'protocol terminal outcome');
      const frames = rpc.messages().filter(message => message.params?.turnId === turn.id && message.params?.threadId === thread.id);
      const text = frames.filter(message => message.method === 'item/delta').map(message => message.params?.delta?.text || '').join('');
      const thinkingEvents = frames.filter(message => message.params?.event?.type === 'assistant_thinking_delta');
      await context.writeArtifactJson(`${apiFormat}-${mode}.json`, { status: done.params.turn.status, error: done.params.turn.error, failures: frames.filter(message => /error|failed/.test(JSON.stringify(message))), text, thinkingEvents, providerRequests: fixture.requests.length });
      assert.equal(done.params.turn.status, truncated ? 'failed' : 'completed');
      assert.equal(text, 'TEXT_TAIL');
      assert.equal(thinkingEvents.map(message => message.params.event.text).join(''), mode === 'no_thinking' ? '' : 'THINK_TAIL', 'thinking must reach the client exactly once even before EOF');
      const afterTool = await readFile(resolve(workspace, 'protocol-tool-count.txt'), 'utf8').catch(() => '');
      assert.equal(afterTool, beforeTool + (mode === 'tool' ? 'x' : ''));
      assert.equal(fixture.requests.length - beforeRequests, mode === 'tool' ? 2 : 1);
      results.push({ apiFormat, mode, status: done.params.turn.status });
      await rpc.request('thread/delete', { threadId: thread.id });
    }
    rpc.close(); await context.stopOwned(apiFormat);
  }
  assert.equal(fixture.requests.length, 15);
  return { results, requests: fixture.requests.length };
});
