import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startSubagentModelFixture, subagentFixtureSettings, recordSubagentTestInputs } from '../../harness/subagent-model.mjs';
import { startGateway, waitForGatewayRpcToken } from '../../harness/gateway.mjs';
import { gatewayRpcUrl, initializeRpc, openRpc } from '../../harness/rpc.mjs';
import { repoRoot, runE2E, waitFor } from '../../harness/run-context.mjs';
import { materializeWorkspace } from '../../harness/workspace-fixture.mjs';

/** QA: real Gateway/app-server/Engine with fixed SSE; validates protocol safety, not model quality.
 * Spawn two completed and four background workers. Read token activity, queue dual commands
 * during a real tool, answer a source-bound question after parent completion, verify durable
 * duplicate receipts and safe paging, archive epoch CAS, cross-thread denial and stop run CAS.
 * RunContext owns model/Gateway/workspace/config/RPC handles and proves cleanup.
 */
await runE2E(import.meta.url, { testId: 'subagent-public-workspace-protocol-and-recovery', tier: 'full-integration', modelPolicy: 'model-independent actual Agent stream/tool/question/receipt protocol using bounded loopback SSE' }, async context => {
  const { path: workspace } = await materializeWorkspace(context, 'minimal', { instanceId: 'subagent-workspace' });
  const fixture = await startSubagentModelFixture(context);
  const configDir = context.pathInState('config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const key = 'owned-subagent-fixture'; context.registerSecret(key);
  const settings = await context.writeStateJson('config/settings.json', subagentFixtureSettings(fixture.baseUrl));
  await context.writeStateJson('config/credentials.json', { fixture: { type: 'api', key } });
  const binary = process.env.KCODER_E2E_KCODER_BIN || resolve(repoRoot, 'target/debug/kcoder');
  await recordSubagentTestInputs(context, binary);
  const servers = await context.writeStateJson('servers.json', [{ id: 'subagent-local', label: 'Owned Agent target', runtime: 'kcoder', transport: 'local', command: binary, workspacePath: workspace, settingsFile: settings }]);
  const gateway = await startGateway(context, { label: 'subagent-gateway', kcoderBin: binary, workspace, serversFile: servers, env: { KCODER_CONFIG_DIR: configDir } });
  const token = await waitForGatewayRpcToken(context, gateway);
  const connect = async label => {
    const rpc = await openRpc(gatewayRpcUrl(gateway, 'subagent-local', token), { headers: { Origin: gateway.baseUrl } });
    context.addCleanup(`close ${label}`, () => rpc.close());
    const initialized = await initializeRpc(rpc, label);
    for (const name of ['agentArtifactPagesV1', 'agentCommandReceiptsV1', 'agentLiveViewV1', 'agentStopV1']) assert.equal(initialized.capabilities.experimental[name], true, name);
    return rpc;
  };
  let rpc = await connect('subagent-client');
  let diagnosticIdentity;
  try {
  const thread = (await rpc.request('thread/start', { cwd: workspace })).thread.id;
  const turn = (await rpc.request('turn/start', { threadId: thread, input: [{ type: 'text', text: 'S03_START' }] })).turn.id;
  const foregroundQuestion = await waitFor(() => {
    const failure = fixture.observations.find(item => item.kind === 'error');
    if (failure) throw new Error(`Protocol fixture failure: ${failure.message}`);
    const terminal = rpc.messages().find(frame => frame.method === 'turn/completed' && frame.params?.turnId === turn && frame.params?.status === 'failed');
    if (terminal) throw new Error(`Actual turn failed before Agent question: ${JSON.stringify(terminal.params)}`);
    return rpc.messages().find(frame => frame.method === 'question/request' && frame.params?.questions?.some(question => question.prompt === 'S03_ACTUAL_FOREGROUND_QUESTION'));
  }, 30000, 'actual foreground Agent source question');
  assert.ok(foregroundQuestion.params.sourceAgent?.agentId);
  assert.equal(foregroundQuestion.params.sourceAgent.parentSessionId, thread);
  if (foregroundQuestion.params.sourceAgent.backgroundRun) assert.equal(foregroundQuestion.params.sourceAgent.backgroundRun.agentId, foregroundQuestion.params.sourceAgent.agentId);
  rpc.respond(foregroundQuestion.id, { questionId: foregroundQuestion.params.questionId, threadId: thread, turnId: foregroundQuestion.params.turnId, answers: { 'question-1': { answers: ['Proceed'] } } });
  const list = await waitFor(async () => { const value = await rpc.request('agent/list', { threadId: thread }); return value.agents.length === 6 ? value : null; }, 60000, 'all six real Agent identities');
  await rpc.waitFor(frame => frame.method === 'turn/completed' && frame.params?.turnId === turn, 30000, 'parent completed with background workers alive');
  const primary = list.agents.find(agent => agent.presentation?.goal?.includes('S03_WORKER_primary'));
  const stoppable = list.agents.find(agent => agent.presentation?.goal?.includes('S03_WORKER_stoppable'));
  assert.ok(primary && stoppable, 'identity is discovered from authoritative Agent presentation');
  diagnosticIdentity = { threadId: thread, agentId: primary.agentId };
  assert.equal(primary.presentation.canStop, true);
  const live = await waitFor(async () => { const value = await rpc.request('agent/live/read', { threadId: thread, agentId: primary.agentId }); return value.content.includes('S03_LIVE_VISIBLE') ? value : null; }, 15000, 'public token stream');
  assert.ok(!live.content.includes('S03_PRIVATE_THINKING'));
  const unchanged = await rpc.request('agent/live/read', { threadId: thread, agentId: primary.agentId, previousRevision: live.revision });
  assert.equal(unchanged.unchanged, true);
  fixture.release('primary-model');
  await waitFor(async () => (await rpc.request('agent/live/read', { threadId: thread, agentId: primary.agentId })).phase?.includes('Running bash'), 15000, 'real child tool activity');
  const first = await rpc.request('agent/steer', { threadId: thread, agentId: primary.agentId, message: 'S03_ADJUST_ONE', clientMessageId: 'cmd:0:protocol-one' });
  const second = await rpc.request('agent/steer', { threadId: thread, agentId: primary.agentId, message: 'S03_ADJUST_TWO', clientMessageId: 'cmd:0:protocol-two' });
  assert.equal(first.queued, true); assert.equal(second.queued, true); assert.notEqual(first.messageId, second.messageId);
  const missing = await rpc.request('agent/message/read', { threadId: thread, agentId: primary.agentId, clientMessageId: 'cmd:0:never-sent' });
  assert.equal(missing.receipt, undefined);
  const question = await rpc.waitFor(frame => frame.method === 'question/request' && frame.params?.sourceAgent?.agentId === primary.agentId, 30000, 'source-bound actual child question');
  assert.equal(question.params.sourceAgent.parentSessionId, thread);
  assert.deepEqual(question.params.sourceAgent.backgroundRun, primary.backgroundRun);
  const answer = { questionId: question.params.questionId, threadId: thread, turnId: question.params.turnId, answers: { 'question-1': { answers: ['Proceed'] } } };
  rpc.respond(question.id, answer);
  await rpc.waitFor(frame => frame.method === 'question/resolved' && frame.params?.requestId === question.id, 15000, 'shared reply receipt');
  rpc.respond(question.id, answer);
  const ignoredQuestion = await rpc.waitFor(frame => frame.method === 'question/request' && frame.params?.questions?.some(value => value.prompt === 'S03_AGENT_IGNORE_QUESTION'), 15000, 'source question to ignore');
  fixture.release('stoppable-question');
  const otherPending = await rpc.waitFor(frame => frame.method === 'question/request' && frame.params?.sourceAgent?.agentId === stoppable.agentId, 15000, 'other actual pending Agent question');
  rpc.respond(ignoredQuestion.id, { questionId: ignoredQuestion.params.questionId, threadId: thread, turnId: ignoredQuestion.params.turnId, answers: {}, annotations: { ignored: true } });
  await waitFor(async () => (await rpc.request('agent/list', { threadId: thread })).agents.find(agent => agent.agentId === primary.agentId)?.status === 'completed', 30000, 'Agent finished after source reply');
  assert.ok(!rpc.messages().some(frame => frame.method === 'question/resolved' && frame.params?.requestId === otherPending.id), 'other source question remains pending');
  const historical = await rpc.request('agent/messages/list', { threadId: thread, agentId: primary.agentId, limit: 64 });
  assert.equal(historical.retainedCount, 2);
  assert.ok(historical.receipts.every(receipt => receipt.status === 'applied'));
  const requireAppliedRun = process.env.KCODER_E2E_REQUIRE_APPLIED_RUN === '1';
  if (requireAppliedRun) for (const receipt of historical.receipts) {
    assert.deepEqual(receipt.backgroundRun, primary.backgroundRun, 'original admission identity remains compatible');
    assert.deepEqual(receipt.appliedBackgroundRun, primary.backgroundRun, 'actual checkpoint application identity is authoritative');
  }
  const duplicate = await rpc.request('agent/steer', { threadId: thread, agentId: primary.agentId, message: 'S03_ADJUST_ONE', clientMessageId: 'cmd:0:protocol-one' });
  assert.equal(duplicate.messageId, first.messageId); assert.equal(duplicate.status, 'applied');
  if (requireAppliedRun) {
    const exact = await rpc.request('agent/message/read', { threadId: thread, agentId: primary.agentId, clientMessageId: 'cmd:0:protocol-one' });
    assert.equal(exact.receipt.messageId, first.messageId);
    assert.deepEqual(exact.receipt.appliedBackgroundRun, primary.backgroundRun, 'exact receipt lookup preserves the application identity after a duplicate command');
  }
  assert.equal((await rpc.request('agent/messages/list', { threadId: thread, agentId: primary.agentId })).retainedCount, 2);
  let offset = 0, revision; const pages = [];
  for (let n = 0; n < 16; n += 1) {
    const page = await rpc.request('agent/artifact/read', { threadId: thread, agentId: primary.agentId, kind: 'transcript', offset, limit: 65536, ...(revision ? { revision } : {}) });
    assert.equal(page.offset, offset); if (revision) assert.equal(page.revision, revision); revision = page.revision; pages.push(page.content);
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.ok(pages.length > 1); const content = pages.join('');
  assert.ok(content.includes('S03_AGENT_DONE')); assert.ok(!content.includes('S03_PRIVATE_THINKING'));
  assert.ok(content.includes('S03_ADJUST_ONE') && content.includes('S03_ADJUST_TWO'));
  let archiveReceipts = historical.receipts;
  if (requireAppliedRun) {
    const continued = await rpc.request('agent/steer', { threadId: thread, agentId: primary.agentId, message: 'S03_ADJUST_AFTER_COMPLETE', clientMessageId: 'cmd:0:protocol-after-complete' });
    assert.equal(continued.queued, true);
    const resumedReceipt = await waitFor(async () => {
      const value = await rpc.request('agent/message/read', { threadId: thread, agentId: primary.agentId, clientMessageId: 'cmd:0:protocol-after-complete' });
      return value.receipt?.status === 'applied' ? value.receipt : null;
    }, 15000, 'actual terminal continuation command checkpoint');
    assert.deepEqual(resumedReceipt.backgroundRun, primary.backgroundRun, 'terminal command retains its admission run');
    assert.equal(resumedReceipt.appliedBackgroundRun.parentSessionId, thread);
    assert.equal(resumedReceipt.appliedBackgroundRun.agentId, primary.agentId);
    assert.notEqual(resumedReceipt.appliedBackgroundRun.runId, primary.backgroundRun.runId, 'actual continuation applies in a new run');
    const resumedAgent = await waitFor(async () => (await rpc.request('agent/list', { threadId: thread })).agents.find(agent => agent.agentId === primary.agentId && agent.status === 'completed'), 15000, 'actual continuation completed');
    assert.deepEqual(resumedAgent.backgroundRun, resumedReceipt.appliedBackgroundRun);
    const resumedOutput = await rpc.request('agent/artifact/read', { threadId: thread, agentId: primary.agentId, kind: 'output', limit: 65536 });
    assert.ok(resumedOutput.content.includes('S03_RESUMED_AGENT_DONE'), 'actual continuation output checkpoint is public');
    const oldDuplicate = await rpc.request('agent/steer', { threadId: thread, agentId: primary.agentId, message: 'S03_ADJUST_ONE', clientMessageId: 'cmd:0:protocol-one' });
    assert.equal(oldDuplicate.messageId, first.messageId);
    assert.equal(oldDuplicate.status, 'applied');
    const original = await rpc.request('agent/message/read', { threadId: thread, agentId: primary.agentId, clientMessageId: 'cmd:0:protocol-one' });
    assert.deepEqual(original.receipt.appliedBackgroundRun, primary.backgroundRun, 'old duplicate keeps its original application run');
    const retained = await rpc.request('agent/messages/list', { threadId: thread, agentId: primary.agentId });
    assert.equal(retained.retainedCount, 3);
    archiveReceipts = retained.receipts;
    assert.equal(fixture.observations.filter(value => value.kind === 'terminal-continuation-command').length, 1);
  }
  const other = (await rpc.request('thread/start', { cwd: workspace })).thread.id;
  await assert.rejects(rpc.request('agent/artifact/read', { threadId: other, agentId: primary.agentId, kind: 'output' }));
  await assert.rejects(rpc.request('agent/stop', { threadId: thread, agentId: stoppable.agentId, expectedBackgroundRun: { ...stoppable.backgroundRun, runId: 'wrong-run' } }));
  const stopped = await rpc.request('agent/stop', { threadId: thread, agentId: stoppable.agentId, expectedBackgroundRun: stoppable.backgroundRun });
  assert.equal(stopped.stopped, true); assert.equal(stopped.status, 'stopped');
  const archived = await rpc.request('agent/messages/archive', { threadId: thread, agentId: primary.agentId, expectedEpoch: 0, confirmedMessageIds: archiveReceipts.map(receipt => receipt.messageId) });
  assert.equal(archived.receiptEpoch, 1);
  const stale = await rpc.request('agent/steer', { threadId: thread, agentId: primary.agentId, message: 'S03_ADJUST_ONE', clientMessageId: 'cmd:0:protocol-one' });
  assert.equal(stale.queued, false); assert.equal(stale.reasonCode, 'stale_client_message_epoch');
  rpc.close(); rpc = await connect('subagent-reconnected');
  await rpc.request('thread/resume', { threadId: thread });
  const restored = await rpc.request('agent/messages/list', { threadId: thread, agentId: primary.agentId });
  assert.equal(restored.receiptEpoch, 1); assert.equal(restored.retainedCount, 0);
  assert.equal(fixture.observations.filter(value => value.kind === 'worker-request' && value.tag === 'primary').length, requireAppliedRun ? 5 : 4);
  assert.ok(!fixture.observations.some(value => value.kind === 'error'), JSON.stringify(fixture.observations.filter(value => value.kind === 'error')));
  return { discoveredAgents: 6, publicLive: true, publicPages: pages.length, durableSameId: true, foregroundSourceQuestion: true, scopedQuestion: true, independentStop: stopped.status, restoredEpoch: restored.receiptEpoch, appliedRunVerified: requireAppliedRun, terminalContinuationVerified: requireAppliedRun };
  } catch (error) {
    const continuationState = diagnosticIdentity ? await Promise.allSettled([
      rpc.request('agent/list', { threadId: diagnosticIdentity.threadId }),
      rpc.request('agent/messages/list', diagnosticIdentity),
      rpc.request('agent/artifact/read', { ...diagnosticIdentity, kind: 'output', limit: 8192 }),
    ]) : [];
    await context.writeArtifactJson('subagent-continuation-state.json', continuationState);
    await context.writeArtifactJson('subagent-failure-evidence.json', { fixture: fixture.observations, frames: rpc.messages().filter(frame => ['question/request', 'question/resolved', 'turn/completed', 'item/completed'].includes(frame.method)).slice(-40) });
    throw error;
  }
});
