import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startApprovalModelFixture } from '../../harness/approval-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, requireExecutable, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

// M06/M11: reuse one resident thread, not a newly constructed conversation.
await runE2E(import.meta.url, { testId: 'resident-model-refresh-and-deletion', tier: 'full-integration',
  modelPolicy: 'model-independent loopback request parameters and idle turn boundaries' }, async context => {
  const binary = await requireExecutable(process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder'), 'KCoder');
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'resident-model' });
  let releaseTool = false;
  const marker = 'SNAPSHOT_TOOL';
  const latestUser = body => JSON.stringify(body.messages?.filter(message => message.role === 'user').at(-1)?.content ?? '');
  const fixture = await startApprovalModelFixture(context, { responseSteps: ({ body }) => {
    if (body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(marker)) && !body.messages.some(message => message.role === 'tool')) {
      return [{ ready: () => releaseTool, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'snapshot-tool', type: 'function', function: { name: 'bash', arguments: JSON.stringify({command: 'printf x >> snapshot-tool-count.txt'}) } }] } }, { finishReason: 'tool_calls' }];
    }
    return [{ delta: { role: 'assistant', content: 'OK' } }, { finishReason: 'stop' }];
  } });
  const key = `fixture-${randomBytes(16).toString('hex')}`;
  context.registerSecret(key);
  await context.writeStateJson('profile/settings.json', { active_provider: 'shared', permission_mode: 'yolo', max_retries: 0,
    providers: { shared: { api_format: 'openai_chat_completions', endpoint: fixture.baseUrl, default_model: 'model-A',
      context_window_tokens: 128000, output_headroom_tokens: 1024, max_output_tokens: 1024, extra_body: { temperature: 0.2 } },
      companion: { api_format: 'openai_chat_completions', endpoint: fixture.baseUrl, default_model: 'model-B',
        context_window_tokens: 128000, output_headroom_tokens: 1024, max_output_tokens: 1024 } } });
  await context.writeStateJson('profile/credentials.json', { shared: { type: 'api', key }, companion: { type: 'api', key }, templated: { type: 'api', key } });
  const serversFile = await context.writeStateJson('servers.json', [{ id: 'local', label: 'Resident fixture', transport: 'local', command: binary, workspace }]);
  const gateway = await startGateway(context, { workspace, serversFile, kcoderBin: binary, env: { KCODER_CONFIG_DIR: context.pathInState('profile') } });
  const token = await waitForGatewayRpcToken(context, gateway);
  let rpc;
  const connect = async () => {
    const client = await openRpc(gatewayRpcUrl(gateway, 'local', token));
    context.addCleanup('close resident model RPC', () => client.close());
    const initialized = await initializeRpc(client, 'resident-model-refresh');
    assert.equal(initialized.capabilities.experimental.modelSelectionModeV1, true);
    return client;
  };
  rpc = await connect();
  const restartAndResume = async threadId => {
    const result = await rpc.request('gateway/app-server/restart', { confirm: true }, 30000);
    assert.equal(result.stopped, true);
    rpc.close();
    rpc = await connect();
    await rpc.request('thread/resume', { threadId }, 30000);
  };
  const { thread } = await rpc.request('thread/start', { cwd: workspace, model: 'shared::model-A' });
  const turn = async (model, threadId = thread.id, selectionMode) => {
    const before = fixture.requests.length;
    const { turn } = await rpc.request('turn/start', { threadId, ...(model ? { model } : {}), ...(selectionMode ? { modelSelectionMode: selectionMode } : {}), input: [{ type: 'text', text: 'Reply OK.' }] });
    const done = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === turn.id && message.params?.threadId === threadId, 30000, 'resident turn');
    assert.equal(done.params.turn.status, 'completed');
    assert.equal(fixture.requests.length, before + 1);
    return fixture.requests.at(-1);
  };
  assert.equal((await turn()).temperature, 0.2);
  const heldRequestOffset = fixture.requests.length;
  const held = await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: marker }] });
  await waitFor(() => fixture.requests.some(body => latestUser(body).includes(marker)), 30000, 'in-flight model request');
  await rpc.request('runtime.providers.upsert', { id: 'shared', model: 'model-A', originalModel: 'model-A', apiFormat: 'openai_chat_completions',
    endpoint: fixture.baseUrl, contextWindowTokens: 128000, maxOutputTokens: 1024, modelExtraBody: { temperature: 0.7 } }, 30000);
  releaseTool = true;
  const heldDone = await rpc.waitFor(message => message.method === 'turn/completed' && message.params?.turnId === held.turn.id, 30000, 'tool snapshot turn');
  assert.equal(heldDone.params.turn.status, 'completed');
  assert.deepEqual(fixture.requests.slice(heldRequestOffset).filter(body => !latestUser(body).includes('Reply only OK.')).map(body => body.temperature), [0.2, 0.2], 'tool continuation must keep the current turn snapshot');
  assert.equal(await readFile(resolve(workspace, 'snapshot-tool-count.txt'), 'utf8'), 'x');
  assert.equal((await turn()).temperature, 0.7, 'the next turn of the same resident thread must reload the selected model');
  const templateContent = temperature => JSON.stringify({ active_provider: 'templated', max_tokens: 128, providers: { templated: {
    api_format: 'openai_chat_completions', endpoint: fixture.baseUrl, default_model: 'frozen',
    context_window_tokens: 128000, output_headroom_tokens: 1024, max_output_tokens: 1024, extra_body: { temperature },
  } } });
  const savedTemplate = await rpc.request('settings/templates/save', { name: 'Frozen model', content: templateContent(0.3) });
  const templateId = savedTemplate.template.id;
  const frozen = await rpc.request('thread/start', { cwd: workspace, settingsTemplate: templateId, model: 'templated::frozen' });
  const frozenRequest = await turn(undefined, frozen.thread.id);
  assert.equal(frozenRequest.temperature, 0.3);
  assert.equal(frozenRequest.max_tokens ?? frozenRequest.max_completion_tokens, 128, 'root-level template limits retain priority');
  await rpc.request('settings/templates/save', { id: templateId, name: 'Frozen model', content: templateContent(0.8) });
  assert.equal((await turn(undefined, frozen.thread.id)).temperature, 0.3, 'an existing conversation keeps its bound template');
  const updatedTemplate = await rpc.request('thread/start', { cwd: workspace, settingsTemplate: templateId, model: 'templated::frozen' });
  assert.equal((await turn(undefined, updatedTemplate.thread.id)).temperature, 0.8, 'a new conversation loads the updated template');

  await rpc.request('runtime.providers.upsert', { id: 'shared', model: 'model-B', apiFormat: 'openai_chat_completions',
    endpoint: fixture.baseUrl, contextWindowTokens: 128000, maxOutputTokens: 1024, modelExtraBody: { temperature: 0.9 } }, 30000);
  await rpc.request('runtime.providers.delete', { id: 'shared', model: 'model-A', replacementModel: 'model-B', confirm: true }, 30000);
  const residentCatalog = await rpc.request('runtime.models.list', { threadId: thread.id });
  assert.equal(residentCatalog.providers.flatMap(provider => provider.data).some(model => model.id === 'shared::model-A'), false,
    'the resident catalog must not advertise a deleted model from its running snapshot');
  assert.equal(residentCatalog.providers.flatMap(provider => provider.data).some(model => model.id === 'shared::model-B'), true);
  const beforeMissingModel = fixture.requests.length;
  await assert.rejects(rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Do not revive removed model A.' }] }), /model|configured|removed|available/i);
  assert.equal(fixture.requests.length, beforeMissingModel);
  assert.equal((await turn('shared::model-B')).temperature, 0.9);
  await rpc.request('runtime.providers.delete', { id: 'shared', confirm: true, replacementProvider: 'companion', removeCredentials: false }, 30000);
  const before = fixture.requests.length;
  await assert.rejects(rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Do not use the deleted API.' }] }), /model|provider|configured|removed|available/i);
  assert.equal(fixture.requests.length, before, 'a deleted provider must not be resurrected from cached credentials');
  assert.equal((await turn(undefined, thread.id, 'follow_target_default')).model, 'model-B',
    'explicitly following defaults resolves the replacement provider instead of the removed selection');
  await rpc.request('runtime.providers.upsert', { id: 'companion', model: 'model-C', apiFormat: 'openai_chat_completions',
    endpoint: fixture.baseUrl, contextWindowTokens: 128000, maxOutputTokens: 1024, makeDefault: true,
    modelExtraBody: { temperature: 0.6 } }, 30000);
  const followed = await turn();
  assert.equal(followed.model, 'model-C');
  assert.equal(followed.temperature, 0.6);
  assert.equal((await turn('companion::model-B', thread.id, 'explicit')).model, 'model-B');
  assert.equal((await turn()).model, 'model-B', 'explicit model must remain selected even while target default is C');
  await restartAndResume(thread.id);
  assert.equal((await turn()).model, 'model-B', 'explicit identity must survive process restart while default remains C');
  assert.equal((await turn(undefined, thread.id, 'follow_target_default')).model, 'model-C');
  await restartAndResume(thread.id);
  await rpc.request('runtime.providers.upsert', { id: 'companion', model: 'model-B', originalModel: 'model-B',
    apiFormat: 'openai_chat_completions', endpoint: fixture.baseUrl, contextWindowTokens: 128000,
    maxOutputTokens: 1024, makeDefault: true, modelExtraBody: { temperature: 0.4 } }, 30000);
  const resumedDefault = await turn();
  assert.equal(resumedDefault.model, 'model-B', 'follow-default intent must survive process restart');
  assert.equal(resumedDefault.temperature, 0.4);
  const restoredSelection = await rpc.request('thread/read', { threadId: thread.id });
  assert.equal(restoredSelection.thread.modelSelectionMode, 'follow_target_default');
  assert.equal(restoredSelection.thread.selectedModel, 'companion::model-B');
  const beforeConflict = fixture.requests.length;
  await assert.rejects(rpc.request('turn/start', { threadId: thread.id, model: 'companion::model-B',
    modelSelectionMode: 'follow_target_default', input: [{ type: 'text', text: 'invalid selection' }] }), /cannot include model/);
  assert.equal(fixture.requests.length, beforeConflict);
  const deleteDuringToolTurn = async (model, temperature, deletion) => {
    const { thread: active } = await rpc.request('thread/start', { cwd: workspace, model: `companion::${model}` });
    releaseTool = false;
    const offset = fixture.requests.length;
    const toolsBefore = await readFile(resolve(workspace, 'snapshot-tool-count.txt'), 'utf8');
    const started = await rpc.request('turn/start', { threadId: active.id, input: [{ type: 'text', text: marker }] });
    await waitFor(() => fixture.requests.length > offset, 30000, 'request held before deleting its configuration');
    await rpc.request('runtime.providers.delete', deletion, 30000);
    releaseTool = true;
    const completed = await rpc.waitFor(message => message.method === 'turn/completed'
      && message.params?.threadId === active.id && message.params?.turnId === started.turn.id, 30000, 'deleted configuration snapshot completes');
    assert.equal(completed.params.turn.status, 'completed');
    await context.writeArtifactJson(`deletion-${model}-requests.json`, fixture.requests.slice(offset).map(body => ({
      model: body.model, temperature: body.temperature, latestUser: latestUser(body), roles: body.messages.map(message => message.role), tools: body.tools?.map(tool => tool.function?.name),
    })));
    assert.deepEqual(fixture.requests.slice(offset).map(body => [body.model, body.temperature]), [[model, temperature], [model, temperature]]);
    assert.equal(await readFile(resolve(workspace, 'snapshot-tool-count.txt'), 'utf8'), toolsBefore + 'x');
    const after = fixture.requests.length;
    await assert.rejects(rpc.request('turn/start', { threadId: active.id, input: [{ type: 'text', text: 'do not revive deleted configuration' }] }), /model|provider|configured|removed|available/i);
    assert.equal(fixture.requests.length, after);
  };
  await deleteDuringToolTurn('model-B', 0.4, { id: 'companion', model: 'model-B', replacementModel: 'model-C', confirm: true });
  const surviving = await rpc.request('runtime.providers.list');
  assert.ok(surviving.profiles.some(profile => profile.id === 'companion' && profile.model === 'model-C'));
  await deleteDuringToolTurn('model-C', 0.6, { id: 'companion', removeCredentials: false, confirm: true });
  const beforeDeletedNewThread = fixture.requests.length;
  await assert.rejects(rpc.request('thread/start', { cwd: workspace, model: 'companion::model-C' }), /model|provider|configured|removed|available/i);
  assert.equal(fixture.requests.length, beforeDeletedNewThread);
  return { deletionDuringToolLoop: true, sameResidentThread: true, followDefaultAndExplicitIntent: true, selectionIntentSurvivesRestart: true, activeToolLoopSnapshotPreserved: true, idleModelParametersRefreshed: true, removedProviderRejected: true, removedModelRejected: true, boundTemplatePreserved: true, requests: fixture.requests.length };
});
