import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNativePluginLeaseEvidence, settleNativePluginLeaseThreads } from './native-plugin-source-leases.mjs';

// These synthetic frames exercise the evidence oracle, not Native or model behavior.
function evidence(kind = 'disabled') {
  const name = `owned-${kind}`, tuple = { threadId: 'thread', turnId: 'turn', attemptId: 'attempt' };
  const toolName = 'mcp__plugin_owned_peer__lease_read', toolCallId = `lease-${name}`;
  const choice = { sourceRef: { id: 'original-source', revision: 'one' }, accountRef: null };
  const descriptor = { ...structuredClone(choice), kind: 'plugin_mcp', displayName: 'plugin.owned.peer', state: 'ready', capabilities: ['tools'], reasonCode: null };
  const schema = { type: 'object', properties: { version_1: { type: 'string', maxLength: 64 } }, required: ['version_1'], additionalProperties: false };
  const invocation = { phase: name, toolName, toolCallId, schema, input: { version_1: name } };
  const frame = (method, value) => ({ method, params: { threadId: tuple.threadId, turnId: tuple.turnId, ...value } });
  const result = { id: toolCallId, type: 'toolCall', name: toolName, status: 'failed', output: 'NATIVE_TASK_AUTHORITY_UNAVAILABLE', outputTruncated: false };
  const sourceSnapshot = { threadId: tuple.threadId, effectiveSources: [choice] };
  const sourceCatalog = { items: [descriptor] };
  const currentPlugin = { id: 'owned', root: '/owned/version-two', enabled: true };
  return { name, tuple, version: 1, invocation, calls: [], sourceSnapshot, sourceCatalog,
    expectedServer: descriptor.displayName,
    positive: { outcome: 'peer_completed', invocation: { ...structuredClone(invocation), phase: 'positive', input: { version_1: 'positive' } }, sourceChoice: structuredClone(choice) },
    denial: { action: kind, pluginId: 'owned', currentRoot: currentPlugin.root,
      before: { plugins: [currentPlugin] }, after: { plugins: kind === 'disabled' ? [{ ...currentPlugin, enabled: false }] : [] },
      sourceSnapshot, ...(kind === 'disabled' ? { sourceCatalog: { items: [] } } : { sourceCatalogReply: {
        contractVersion: 'parallel-v1', status: 'unavailable', result: null,
        error: { code: 'TASK_CAPABILITY_SOURCE_CHOICES_UNAVAILABLE', messageKey: 'integrations.tasks.sourceChoicesUnavailable', recovery: 'retry_read' } } }),
      guardDiagnostic: { stage: 'tool', code: kind === 'disabled' ? 'NATIVE_PLUGIN_GLOBALLY_DISABLED' : 'PLUGIN_VERSION_UNINSTALLED' } },
    terminal: frame('turn/completed', { turn: { id: tuple.turnId, status: 'failed' }, error: { message: 'NATIVE_TASK_AUTHORITY_UNAVAILABLE' },
      reviewEvidence: { version: 1, threadId: tuple.threadId, turnId: tuple.turnId, attemptId: tuple.attemptId, state: 'settled', omittedCount: 0,
        observations: [{ toolCallId, toolName, outcome: 'denied', outputPreview: 'NATIVE_TASK_AUTHORITY_UNAVAILABLE', detailsTruncated: false }] } }),
    frames: [frame('item/started', { item: { id: toolCallId, type: 'toolCall', name: toolName, input: invocation.input, inputTruncated: false } }),
      frame('item/event', { event: { type: 'tool_denied', id: toolCallId, name: toolName, reason: 'NATIVE_TASK_AUTHORITY_UNAVAILABLE' } }),
      frame('item/completed', { attemptId: tuple.attemptId, item: result })] };
}

for (const kind of ['disabled', 'uninstalled']) test(`model-independent oracle accepts correlated ${kind} provenance`, () => {
  assert.equal(assertNativePluginLeaseEvidence(evidence(kind)).denial.action, kind);
});

test('model-independent oracle rejects the original empty-peer false positives', () => {
  for (const status of ['failed', 'interrupted', 'running']) {
    const value = evidence(); value.terminal.params.turn.status = status; value.invocation = undefined;
    assert.throws(() => assertNativePluginLeaseEvidence(value), /exposed invocation/);
  }
  const value = evidence(); value.frames = [];
  assert.throws(() => assertNativePluginLeaseEvidence(value), /exact native tool start/);
});

test('model-independent oracle separates schema errors, peer errors and assistant claims from revocation', () => {
  for (const output of ['NATIVE_TASK_AUTHORITY_DENIED', 'Error', 'OWNED_VERSION_SCHEMA_MISMATCH', 'input validation failed', 'Assistant says NATIVE_TASK_AUTHORITY_UNAVAILABLE']) {
    const value = evidence(); value.frames.at(-1).params.item.output = output;
    assert.throws(() => assertNativePluginLeaseEvidence(value), /revoked-source authority/);
  }
  const value = evidence(); value.frames[1].params.event.reason = 'NATIVE_TASK_AUTHORITY_DENIED';
  assert.throws(() => assertNativePluginLeaseEvidence(value), /authority-denied event/);
});

test('model-independent oracle rejects stale, unrelated or unverified denial evidence', () => {
  const mutations = [
    [v => { v.frames[0].params.turnId = 'old-turn'; }, /exact native tool start/],
    [v => { v.frames.at(-1).params.attemptId = 'old-attempt'; }, /exact native tool result/],
    [v => { v.frames[1].params.event.id = 'other-call'; }, /authority-denied event/],
    [v => { v.frames[0].params.item.input = { version_2: v.name }; }, /native tool input/],
    [v => { v.invocation.schema.required = ['version_2']; }, /version schema/],
    [v => { v.sourceCatalog.items[0].sourceRef.revision = 'other'; }, /positive source/],
    [v => { v.denial.after.plugins[0].enabled = true; }, /disabled plugin readback/],
    [v => { v.positive.outcome = 'schema_rejected'; }, /positive control/],
    [v => { v.terminal.params.turn.status = 'completed'; }, /revoked turn terminal/],
    [v => { v.terminal.params.error.message = 'unrelated failure'; }, /revoked turn error/],
    [v => { v.terminal.params.reviewEvidence = undefined; }, /settled review/],
    [v => { v.terminal.params.reviewEvidence.attemptId = 'other-attempt'; }, /exact attempt/],
    [v => { v.terminal.params.reviewEvidence.turnId = 'other-turn'; }, /exact attempt/],
    [v => { v.terminal.params.reviewEvidence.observations[0].toolCallId = 'other-call'; }, /revocation review/],
    [v => { v.terminal.params.reviewEvidence.observations[0].toolName = 'other-tool'; }, /revocation review/],
    [v => { v.terminal.params.reviewEvidence.observations[0].outcome = 'unknown'; }, /classify the tool/],
    [v => { v.denial.sourceCatalog = undefined; }, /./],
    [v => { v.denial.guardDiagnostic.code = 'OTHER_FAILURE'; }, /revocation boundary/],
    [v => { v.calls.push({ version: '1', phase: v.name }); }, /no peer invocation/],
  ];
  for (const [mutate, message] of mutations) { const value = structuredClone(evidence()); mutate(value); assert.throws(() => assertNativePluginLeaseEvidence(value), message); }
});

test('model-independent uninstall oracle requires the exact original unavailable catalog reply', () => {
  for (const mutate of [v => { delete v.denial.sourceCatalogReply; }, v => { v.denial.sourceCatalogReply.status = 'unknown'; },
    v => { v.denial.sourceCatalogReply.error.code = 'OTHER_FAILURE'; }, v => { v.denial.sourceCatalog = { items: [] }; }]) {
    const value = evidence('uninstalled'); mutate(value);
    assert.throws(() => assertNativePluginLeaseEvidence(value));
  }
});

test('owned Native cleanup interrupts and observes the original turn before deleting threads', async () => {
  const calls = [], turns = new Map([['original-thread', 'original-turn']]), threads = ['original-thread'];
  const rpc = {
    request: async (method, params) => { calls.push({ method, params }); },
    waitFor: async predicate => {
      calls.push({ method: 'observe-terminal' });
      assert.equal(predicate({ method: 'turn/completed', params: { threadId: 'other-thread', turnId: 'original-turn' } }), false);
      assert.equal(predicate({ method: 'turn/completed', params: { threadId: 'original-thread', turnId: 'original-turn' } }), true);
    },
  };
  await settleNativePluginLeaseThreads(rpc, turns, threads);
  assert.deepEqual(calls, [{ method: 'turn/interrupt', params: { threadId: 'original-thread', turnId: 'original-turn' } },
    { method: 'observe-terminal' }, { method: 'thread/delete', params: { threadId: 'original-thread' } }]);
  assert.equal(turns.size, 0); assert.deepEqual(threads, []);
});

test('owned Native cleanup retains its handles when the original terminal is unknown', async () => {
  const turns = new Map([['original-thread', 'original-turn']]), threads = ['original-thread'];
  const rpc = { request: async method => { assert.equal(method, 'turn/interrupt'); }, waitFor: async () => { throw new Error('original terminal unknown'); } };
  await assert.rejects(settleNativePluginLeaseThreads(rpc, turns, threads), /original terminal unknown/);
  assert.equal(turns.get('original-thread'), 'original-turn'); assert.deepEqual(threads, ['original-thread']);
});

test('model-independent oracle matches successful native output to the independent peer control', () => {
  const value = evidence(); delete value.denial; delete value.positive;
  value.calls = [{ pid: 123, version: '1', phase: value.name }];
  value.frames.splice(1, 1); value.terminal.params.turn.status = 'completed'; delete value.terminal.params.error;
  value.frames.at(-1).params.item.status = 'completed'; value.frames.at(-1).params.item.output = JSON.stringify(value.calls[0]);
  assert.equal(assertNativePluginLeaseEvidence(value).outcome, 'peer_completed');
  value.terminal.params.error = null;
  assert.equal(assertNativePluginLeaseEvidence(value).outcome, 'peer_completed');
  for (const error of [false, 0, '', { message: 'unrelated failure' }]) {
    const invalid = structuredClone(value); invalid.terminal.params.error = error;
    assert.throws(() => assertNativePluginLeaseEvidence(invalid));
  }
  value.frames.at(-1).params.item.output = JSON.stringify({ ...value.calls[0], phase: 'unrelated-control' });
  assert.throws(() => assertNativePluginLeaseEvidence(value), /independently recorded peer/);
});

test('model-independent oracle requires exact schema rejection and a completed turn', () => {
  const value = evidence(); delete value.denial; value.wrongField = 'version_2';
  value.invocation.input = { version_2: value.name }; value.frames[0].params.item.input = value.invocation.input;
  value.frames.splice(1, 1); value.terminal.params.turn.status = 'completed'; delete value.terminal.params.error;
  value.frames.at(-1).params.item.output = `Tool \`${value.invocation.toolName}\` input validation failed.\nDetails: $.version_1: missing required field. Expected field \`version_1\` to be present.\nThe tool was not executed.`;
  assert.equal(assertNativePluginLeaseEvidence(value).outcome, 'schema_rejected');
  for (const output of ['OWNED_VERSION_SCHEMA_MISMATCH', 'NATIVE_TASK_AUTHORITY_DENIED', 'input validation failed']) {
    const invalid = structuredClone(value); invalid.frames.at(-1).params.item.output = output;
    assert.throws(() => assertNativePluginLeaseEvidence(invalid), /native schema rejection/);
  }
  value.terminal.params.turn.status = 'failed';
  assert.throws(() => assertNativePluginLeaseEvidence(value), /completed turn/);
});
