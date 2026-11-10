import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { RunContext } from './run-context.mjs';
import { octopEnvironment, analyzeOctopResearch, withOctopProviderStops } from './octop-search-baseline.mjs';
import { protectedModelForward } from './protected-model-forward.mjs';

async function owned(body) {
  const context = await RunContext.create(import.meta.url, { testId: 'octop-adapter-offline-fixtures', tier: 'model-independent', modelPolicy: 'loopback/auth/projection fixtures; no live model or public search' });
  let error;
  try { return await body(context); }
  catch (failure) { error = failure; throw failure; }
  finally { await context.finish(error ? 'failed' : 'passed', {}, error); await assert.rejects(access(context.stateDir)); }
}

const consent = { KCODER_E2E_REAL_MODEL: '1', KCODER_TEST_SEARCH_EXTERNAL: '1' };
const budget = { maxResponses: 8, repeats: 1, caseWallMs: 3000, outputTokens: 512 };
async function upstream(context) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    seen.push({ key: request.headers['x-api-key'], path: request.url, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.addCleanup('stop fixture upstream', () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const configDir = context.pathInState('fixture-approved');
  await context.writeStateJson('fixture-approved/credentials.json', { fixture: { type: 'api', key: 'fixture-upstream-only' } });
  return { seen, model: { configDir, provider: 'fixture', model: 'fixture-model', providerConfig: { endpoint: `http://127.0.0.1:${server.address().port}`, api_format: 'anthropic_messages' } } };
}
const body = (tools = ['searchfree_search', 'web_fetch']) => JSON.stringify({ model: 'fixture-model', max_tokens: 512, tools: tools.map(name => ({ name, input_schema: { type: 'object' } })) });

test('Octop inherits only owned roots and explicit network variables, no parent provider/search/desktop state', () => owned(async context => {
    const state = context.pathInState('octop');
    const env = octopEnvironment(context, state);
    assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.KCODER_CONFIG_DIR, undefined);
    assert.equal(env.DISPLAY, undefined); assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.equal(env.OCTOP_HOME, `${state}/octop`); assert.equal(env.HOME, `${state}/home`); assert.equal(env.XDG_CONFIG_HOME, `${state}/config`);
    assert.throws(() => octopEnvironment(context, state, { SEARCHFREE_ENDPOINT: 'http://fixture' }), /Only explicit network/);
}));

test('protected baseline refuses missing consent and keyring references without sending any model request', () => owned(async context => {
  const { model, seen } = await upstream(context);
  await assert.rejects(protectedModelForward(context, model, budget, { env: {} }), /consent/);
  await context.writeStateJson('fixture-keyring/credentials.json', { fixture: { type: 'keyring', reference: 'do-not-open' } });
  await assert.rejects(protectedModelForward(context, { ...model, configDir: context.pathInState('fixture-keyring') }, budget, { env: consent }), /keyring\/subscription/);
  assert.equal(seen.length, 0);
}));

test('lease rejects wrong token, URL and unexpected tools; only the host substitutes upstream API auth', () => owned(async context => {
  const { model, seen } = await upstream(context);
  const observer = await protectedModelForward(context, model, budget, { env: consent });
  const headers = { 'x-api-key': observer.forwardToken, 'content-type': 'application/json' };
  assert.equal((await fetch(`${observer.endpoint}/v1/messages`, { method: 'POST', headers: { ...headers, 'x-api-key': 'wrong-lease' }, body: body() })).status, 401);
  assert.equal((await fetch(`${observer.endpoint}/v1/models`, { method: 'POST', headers, body: body() })).status, 403);
  assert.equal((await fetch(`${observer.endpoint}/v1/messages`, { method: 'POST', headers, body: body(['execute']) })).status, 502);
  assert.equal((await fetch(`${observer.endpoint}/v1/messages`, { method: 'POST', headers, body: body().replace('512', '513') })).status, 502);
  assert.equal((await fetch(`${observer.endpoint}/v1/messages`, { method: 'POST', headers, body: body().replace('fixture-model', 'wrong-model') })).status, 502);
  assert.equal(seen.length, 0);
  const response = await fetch(`${observer.endpoint}/v1/messages`, { method: 'POST', headers, body: body() }); await response.text();
  assert.equal(response.status, 200); assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'fixture-upstream-only'); assert.equal(seen[0].path, '/v1/messages');
  assert.ok(!JSON.stringify(observer.observations).includes('fixture-upstream-only'));
  assert.notEqual(observer.forwardToken, 'fixture-upstream-only');
}));

test('model request/token ceilings reject before outbound dispatch and owned cleanup releases the listener', () => owned(async context => {
  const { model, seen } = await upstream(context);
  const observer = await protectedModelForward(context, model, { ...budget, maxResponses: 1 }, { env: consent });
  const headers = { 'x-api-key': observer.forwardToken };
  const first = await fetch(`${observer.endpoint}/v1/messages`, { method: 'POST', headers, body: body() }); await first.text();
  const second = await fetch(`${observer.endpoint}/v1/messages`, { method: 'POST', headers, body: body() }); await second.text();
  assert.equal(first.status, 200); assert.equal(second.status, 502); assert.equal(seen.length, 1);
  const peer = await protectedModelForward(context, model, budget, { env: consent });
  await observer.stop();
  await assert.rejects(fetch(`${observer.endpoint}/v1/messages`, { method: 'POST', headers, body: body() }));
  const active = await fetch(`${peer.endpoint}/v1/messages`, { method: 'POST', headers: { 'x-api-key': peer.forwardToken }, body: body() }); await active.text();
  assert.equal(active.status, 200); assert.equal(seen.length, 2, 'releasing one lease must preserve its peer');
}));

test('legacy Octop tool result bodies, dates, failures and direct-read final answers survive public projection without native IDs', () => {
  const task = { id: 'fixture', require_page_read: true, expected_entry: 'WebSearch' };
  const frames = [
    { type: 'token', text: 'Reading. ', repeat: 0 },
    { type: 'tool_call_chunk', id: 'read-1', name: 'web_fetch', args: '{"url":"https://example.com"}', repeat: 0 },
    { type: 'tool_result', messages: [{ tool_call_id: 'read-1', name: 'web_fetch', content: 'Official page published 2026-01-02. Exact body.' }], repeat: 0 },
    { type: 'token', text: 'Supported final answer [source](https://example.com).', repeat: 0 },
    { type: 'done', repeat: 0 }, { type: 'sample_end', repeat: 0, elapsedMs: 40, temperature: 'process_cold', threadId: 'owned' },
  ];
  const result = analyzeOctopResearch(task, frames);
  assert.equal(result.mechanicalPassed, true); assert.equal(result.materialReadObserved, true); assert.equal(result.preferredEntryObserved, false);
  assert.equal(result.searchChainObserved, null); assert.equal(result.legacySearchFetchObserved, false);
  assert.match(result.legacySourceMaterials[0].output, /published 2026-01-02/); assert.ok(!result.finalAnswer.includes('Reading.'));
  const duplicate = structuredClone(frames); duplicate.splice(3, 0, structuredClone(frames[2]));
  assert.equal(analyzeOctopResearch(task, duplicate).legacySourceMaterials.length, 1);
  const fragmented = structuredClone(frames); fragmented[1].args = ''; fragmented[1].index = 0;
  fragmented.splice(2, 0, { type: 'tool_call_chunk', index: 0, args: '{"url":"https://example.com"}', repeat: 0 });
  assert.equal(analyzeOctopResearch(task, fragmented).legacySourceMaterials[0].inputText, '{"url":"https://example.com"}');
  const failed = structuredClone(frames); failed[2].messages[0].content = 'Error: HTTP 403';
  assert.equal(analyzeOctopResearch(task, failed).mechanicalPassed, false);
  const interrupted = structuredClone(frames); interrupted.at(-1).interrupted = true;
  assert.equal(analyzeOctopResearch(task, interrupted).terminal, 'interrupted');
  const limited = withOctopProviderStops(result, [{ request: 1, status: 200, stopReason: 'max_tokens', inputUsage: 10, outputUsage: 512 }]);
  assert.equal(limited.finalAnswer, result.finalAnswer); assert.equal(limited.finalAnswerCompleted, false); assert.equal(limited.mechanicalPassed, false);
  assert.equal(withOctopProviderStops(result, []).stopEvidence, 'unavailable_not_inferred');
});
