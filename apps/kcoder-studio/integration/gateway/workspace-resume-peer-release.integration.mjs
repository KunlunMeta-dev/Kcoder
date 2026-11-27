import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApprovalModelFixture } from '../../e2e/harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../e2e/harness/gateway.mjs';
import { login } from '../../e2e/harness/http.mjs';
import { closeRpcAndWait, gatewayRpcUrl, initializeRpc, isTurnCompletion, openRpc } from '../../e2e/harness/rpc.mjs';
import { repoRoot, requireExecutable, runIntegration, waitFor } from '../../e2e/harness/run-context.mjs';
import { materializeWorkspace } from '../../e2e/harness/workspace-fixture.mjs';

await runIntegration(import.meta.url, {
  testId: 'workspace-resume-after-idle-peer-disconnect',
  tier: 'full-integration',
  modelPolicy: 'Real Gateway and local app-server with a deterministic provider registering one persisted async question; no live model.',
  retainSuccessEvidence: true,
}, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'current KCoder app-server');
  const prompt = 'Which format should the report use?';
  const model = await startApprovalModelFixture(context, {
    responseSteps: ({ body }) => body.messages.some(message => message.role === 'tool')
      ? [{ delta: { role: 'assistant', content: 'The question is saved.' } }, { finishReason: 'stop' }]
      : [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'owned-question', type: 'function',
        function: { name: 'AskUserQuestionAsync', arguments: JSON.stringify({ questions: [{
          header: 'Format', question: prompt, options: [
            { label: 'CSV', description: 'Tabular output' },
            { label: 'JSON', description: 'Structured output' },
          ],
          multi_select: false,
        }] }) } }] } }, { finishReason: 'tool_calls' }],
  });
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'duplicate-broker' });
  const config = context.pathInState('config');
  await context.writeStateJson('config/settings.json', {
    active_provider: 'owned-fixture', permission_mode: 'ask', max_retries: 0,
    allowed_tools: ['AskUserQuestionAsync'], tools: { profile: 'full', disabled: [], studio: { kcoder: ['AskUserQuestionAsync'] } },
    session_memory: { enabled: false },
    providers: { 'owned-fixture': { api_format: 'openai_chat_completions', authentication: { mode: 'none' },
      endpoint: model.baseUrl, default_model: 'owned-fixture', context_window_tokens: 128000,
      max_output_tokens: 4096, output_headroom_tokens: 8192, no_proxy: true, discover_models: false } },
  });
  const serversFile = await context.writeStateJson('servers.json', [
    { id: 'local', label: 'Owned local', transport: 'local', command: binary, workspace },
  ]);
  const gateway = await startGateway(context, {
    auth: true, workspace, serversFile, kcoderBin: binary,
    env: { KCODER_CONFIG_DIR: config },
  });
  const cookie = await login(gateway.baseUrl, gateway.authToken);
  context.registerSecret(cookie);
  const token = await waitForGatewayRpcToken(context, gateway, { headers: { cookie }, expectedToken: 'cookie-auth' });
  const url = new URL(gatewayRpcUrl(gateway, 'local', token));
  url.searchParams.set('workspace', workspace);
  const connect = async label => {
    const rpc = await openRpc(url.toString(), { headers: { Cookie: cookie, Origin: gateway.baseUrl } });
    context.addCleanup(`close ${label} RPC`, () => closeRpcAndWait(rpc, label));
    return rpc;
  };
  // Leave the first connection uninitialized until the second owns the task.
  // Depending on the initialized broker topology, the conflict is enforced by
  // the Gateway connection owner or by the app-server's session lease.
  const first = await connect('first');
  const second = await connect('second');
  const capabilities = { asyncUserQuestionsV1: true };
  const secondInit = await initializeRpc(second, 'owned-second', capabilities);
  assert.equal(secondInit.capabilities.experimental.asyncUserQuestionsV1, true);
  const threadId = (await second.request('thread/start', {})).thread.id;
  assert.ok(threadId);
  const { turn } = await second.request('turn/start', {
    threadId, asyncUserQuestions: true, input: [{ type: 'text', text: 'Ask which format to use.' }],
  });
  const completed = await second.waitFor(message => isTurnCompletion(message, threadId, turn.id),
    45_000, 'the owned thread to be persisted');
  assert.equal(completed.params.turn.status, 'completed', completed.params.error?.message);
  assert.equal(model.requests.length, 2);
  assert.ok(model.requests[0].tools.some(tool => tool.function?.name === 'AskUserQuestionAsync'));
  const toolReceipt = model.requests[1].messages.find(message => message.role === 'tool');
  assert.ok(toolReceipt, 'the continuation receives the actual registration receipt');
  assert.equal(JSON.parse(toolReceipt.content).accepted, true);
  const listParams = { threadId, includeTerminal: true };
  const listQuestions = rpc => rpc.request('asyncQuestion/list', listParams);
  const original = await listQuestions(second);
  assert.equal(original.threadId, threadId);
  assert.equal(original.questions.length, 1);
  const [question] = original.questions;
  assert.equal(question.threadId, threadId);
  assert.equal(question.sourceTurnId, turn.id);
  assert.equal(question.status, 'pending');
  assert.equal(question.questions[0]?.question, prompt);
  const firstInit = await initializeRpc(first, 'owned-first', capabilities);
  assert.equal(firstInit.capabilities.experimental.asyncUserQuestionsV1, true);
  assert.ok(firstInit.sessionId && secondInit.sessionId, 'initialize identifies both app-server sessions');
  const sameAppServer = firstInit.sessionId === secondInit.sessionId;
  const assertOwnedConflict = error => {
    assert.equal(error?.code, sameAppServer ? -32023 : -32022);
    assert.match(error.message, sameAppServer ? /^thread is already active in another Gateway client$/ :
      /^session is already active in another app-server:/);
  };

  let nextId = 0;
  const requestFrame = (method, params) => {
    const id = `owned-peer-${++nextId}`;
    first.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return first.waitFor(message => message.id === id, 10_000, `owned ${method} response`);
  };
  const resume = () => requestFrame('thread/resume', { threadId });
  const whileOwned = await resume();
  assertOwnedConflict(whileOwned.error);
  const unboundList = await requestFrame('asyncQuestion/list', listParams);
  assert.equal(unboundList.error?.code, -32023);
  assert.equal(unboundList.result, undefined);
  assert.deepEqual(await listQuestions(second), original);
  assert.equal((await second.request('thread/goal/get', { threadId })).threadId, threadId,
    'an active peer must remain usable after the conflict');

  await closeRpcAndWait(second, 'second');
  let conflicts = 0;
  const resumed = await waitFor(async () => {
    const response = await resume();
    if (!response.error) return response.result;
    assertOwnedConflict(response.error);
    conflicts += 1;
    return false;
  }, 15_000, 'the original thread to resume after its idle peer disconnects', 200, context.abortSignal);
  assert.equal(resumed.thread?.id, threadId);
  assert.equal((await first.request('thread/goal/get', { threadId })).threadId, threadId);
  assert.deepEqual(await listQuestions(first), original, 'readback keeps the original durable question and revision');
  const cancel = expectedRevision => first.request('asyncQuestion/cancel', {
    threadId, questionId: question.questionId, expectedRevision,
  });
  const cancelled = await cancel(question.revision);
  assert.equal(cancelled.question.status, 'cancelled');
  assert.equal(cancelled.question.revision, question.revision + 1);
  assert.deepEqual((await listQuestions(first)).questions, [cancelled.question]);
  assert.deepEqual(await cancel(cancelled.question.revision), cancelled,
    'an explicit repeat at the saved cancellation revision returns the original receipt');
  assert.deepEqual((await listQuestions(first)).questions, [cancelled.question],
    'the repeated cancellation does not advance the persisted revision');
  assert.equal(model.requests.length, 2, 'recovery does not replay the registration turn');
  await context.writeArtifactJson('peer-resume-evidence.json', {
    schemaVersion: 1, sameOriginalThread: true, sameOriginalQuestion: true, activePeerProtected: true,
    sameAppServer, conflictCode: whileOwned.error.code, conflicts, providerRequests: model.requests.length,
    limitation: 'Local Gateway sockets and a fixed provider fixture; no browser, remote transport, or live model.',
  });
  return { sameOriginalThread: true, sameOriginalQuestion: true, activePeerProtected: true, sameAppServer };
});
