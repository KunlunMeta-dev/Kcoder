import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { runE2E } from './run-context.mjs';
import { probeOctopIsolation, runOctopProcess, analyzeOctopResearch } from './octop-search-baseline.mjs';
import { protectedModelForward } from './protected-model-forward.mjs';

function sse(model, tool) {
  const content = tool ? { type: 'tool_use', id: 'owned-read', name: 'web_fetch', input: {} } : { type: 'text', text: '' };
  const frames = [
    { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: content },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{"url":"http://127.0.0.1:1/owned-denied"}' } : { type: 'text_delta', text: '离线协议 fixture：读取已被原生 SSRF 拒绝。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}

await runE2E(import.meta.url, { testId: 'octop-native-owned-home-no-model-probe', tier: 'model-independent', modelPolicy: 'Actual installed embedded Octop initialization only; no model turn or public search' }, async context => {
  const root = process.env.KCODER_E2E_SEARCH_OCTOP_ROOT;
  assert.ok(root, 'explicit installed Octop checkout required');
  let requests = 0;
  const server = createServer((request, response) => { requests++; request.resume(); response.writeHead(500); response.end('No model requests allowed in probe'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.addCleanup('stop no-model witness', () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const result = await probeOctopIsolation(context, root, `http://127.0.0.1:${server.address().port}`);
  assert.equal(requests, 0); assert.equal(result.ready.searchPolicy, 'auto');
  assert.deepEqual(result.ready.researchToolCeiling, ['searchfree_search', 'web_fetch']);
  assert.equal(result.ready.sourceIdentity.commit, 'dd9dce470844c25d59effb50615bb3c667ea25cd');
  assert.match(result.ready.runtimeFingerprint, /^[a-f0-9]{64}$/);
  const probe = result.frames.find(frame => frame.type === 'probe');
  assert.equal(probe.home, `${result.state}/home`); assert.equal(probe.nativeRoot, `${result.state}/octop`);
  assert.equal(probe.projectionFixture.messages[0].content, 'Owned fixture body; published 2026-01-02');
  assert.equal(probe.reasoningExcluded, true);
  assert.match(probe.dispatchDeniedFixture.messages[0].content, /not a valid tool/);
  assert.equal(await readFile(`${probe.home}/owned-home-probe.txt`, 'utf8'), 'owned');
  await assert.rejects(access(`${probe.home}/.octop`));
  await context.writeArtifactJson('owned-home-probe.json', { ...result.ready, stateRoot: 'owned_run_state', nativeRootOwned: true, modelRequests: requests, homeWriteOwned: true });
  // A scripted loopback provider validates native embedded chunk transport. It
  // asks only for a private URL that native web_fetch must reject before I/O.
  let fixtureRequests = 0;
  const ownerAbort = new AbortController();
  let abortedAt = null;
  const upstream = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); fixtureRequests++;
    assert.equal(request.headers['x-api-key'], 'owned-fixture-upstream');
    assert.deepEqual(body.tools.map(tool => tool.name).sort(), ['searchfree_search', 'web_fetch']);
    if (fixtureRequests === 4) { abortedAt = Date.now(); ownerAbort.abort(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(sse('fixture-model', fixtureRequests % 2 === 1));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  context.addCleanup('stop scripted loopback provider', () => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  await context.writeStateJson('fixture-auth/credentials.json', { fixture: { type: 'api', key: 'owned-fixture-upstream' } });
  const model = { provider: 'fixture', model: 'fixture-model', configDir: context.pathInState('fixture-auth'), providerConfig: { api_format: 'anthropic_messages', endpoint: `http://127.0.0.1:${upstream.address().port}`, context_window_tokens: 131072 } };
  const budget = { outputTokens: 512, repeats: 1, caseWallMs: 10000, maxResponses: 2, maxSearchCalls: 1, maxFetchCalls: 1 };
  const shapes = [];
  const observer = await protectedModelForward(context, model, budget, { env: { KCODER_E2E_REAL_MODEL: '1', KCODER_TEST_SEARCH_EXTERNAL: '1' }, onRequestShape: shape => shapes.push(shape) });
  const task = { id: 'offline-native-tool-transport', query: 'Offline protocol fixture.', require_page_read: true, expected_entry: 'WebFetch' };
  const collected = await runOctopProcess(context, root, task, model, budget, observer);
  const record = analyzeOctopResearch(task, collected.frames);
  assert.equal(collected.ready.runtimeFingerprint, result.ready.runtimeFingerprint);
  await context.writeArtifactJson('offline-native-tool-transport.json', { record, frames: collected.frames, requestShapes: shapes, modelObservations: observer.observations, scope: 'scripted loopback model; native SSRF-denied fetch; no public search or quality inference' });
  assert.equal(fixtureRequests, 2); assert.equal(record.legacySourceMaterials.length, 1);
  assert.match(record.legacySourceMaterials[0].output, /^Error:/); assert.equal(record.legacySourceMaterials[0].name, 'web_fetch');
  assert.match(record.finalAnswer, /离线协议 fixture/); assert.equal(record.finalAnswerCompleted, true);
  assert.equal(record.mechanicalPassed, false, 'a native SSRF failure is not a successful page read');
  await observer.stop();
  const limited = { ...budget, maxFetchCalls: 0, maxResponses: 1 };
  const limitedObserver = await protectedModelForward(context, model, limited, { env: { KCODER_E2E_REAL_MODEL: '1', KCODER_TEST_SEARCH_EXTERNAL: '1' } });
  const limitedTask = { ...task, id: 'offline-native-tool-budget' };
  const cancelled = await runOctopProcess(context, root, limitedTask, model, limited, limitedObserver);
  const interrupted = analyzeOctopResearch(limitedTask, cancelled.frames);
  assert.equal(interrupted.terminal, 'interrupted'); assert.equal(interrupted.mechanicalPassed, false);
  assert.equal(fixtureRequests, 3, 'native observer cancellation must settle without a second upstream response');
  await limitedObserver.stop();
  await context.writeArtifactJson('offline-native-budget-cancel.json', { record: interrupted, frames: cancelled.frames, modelObservations: limitedObserver.observations,
    scope: 'fixture zero-read ceiling; native cancel_stream; no public network', remoteWithdrawalClaimed: false });
  const abortObserver = await protectedModelForward(context, model, { ...budget, maxResponses: 1 }, { env: { KCODER_E2E_REAL_MODEL: '1', KCODER_TEST_SEARCH_EXTERNAL: '1' } });
  try {
    await assert.rejects(runOctopProcess(context, root, { ...task, id: 'offline-owner-abort' }, model, budget, abortObserver, { signal: ownerAbort.signal }), /failed or did not settle/);
    assert.equal(fixtureRequests, 4); assert.ok(Date.now() - abortedAt < 6000, 'owned model-stream abort must settle promptly');
  } finally { await abortObserver.stop(); }
  return { actualEmbeddedInitialized: true, modelRequests: requests, loopbackFixtureModelRequests: fixtureRequests, publicSearchRequests: 0, versions: { octop: result.ready.octopVersion, harness: result.ready.harnessVersion } };
});
