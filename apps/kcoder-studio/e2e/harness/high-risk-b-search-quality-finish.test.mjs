import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { rpcClient } from './rpc.mjs';
import { runE2E } from './run-context.mjs';
import { runResearchTurn } from './web-search-quality.mjs';

const threadId = 'thread-1', turnId = 'turn-1';
const task = { id: 'owned-search-lifecycle-fault', query: 'Fixed public lifecycle fixture; no external request.',
  expected_entry: 'WebSearch', require_page_read: true, valid_empty_allowed: false, allowed_source_domains: ['example.com'] };
const nativeReceipt = JSON.parse(await readFile(new URL('../../shared/generated/examples.web-sources.json', import.meta.url)))
  .WebSourcesToolResultV1.find(row => row.name === 'native-summary').value.webSources;
const notification = (method, params = {}) => ({ method, params: { threadId, turnId, attemptId: 'attempt-1', ...params } });

function completedFrames() {
  const search = { id: 'search-1', type: 'toolCall', name: 'WebSearch', status: 'completed', output: 'Fixed public search fixture', webSources: nativeReceipt };
  const fetch = { id: 'fetch-1', type: 'toolCall', name: 'WebFetch', status: 'completed', output: 'Fixed public read fixture',
    webSources: { ...nativeReceipt, operation: 'fetch', toolCallId: 'fetch-1', sources: nativeReceipt.sources.map(row => ({ ...row, readStatus: 'read' })) } };
  return [notification('item/started', { item: search }), notification('item/completed', { item: search }),
    notification('item/started', { item: fetch }), notification('item/completed', { item: fetch }),
    notification('item/started', { item: { id: 'answer-1', type: 'agentMessage' } }),
    notification('item/delta', { itemId: 'answer-1', delta: { text: 'This fixed answer still requires independent quality review.' } }),
    notification('item/event', { event: { type: 'assistant_stop_reason', reason: 'end_turn' } }),
    notification('turn/completed', { turn: { id: turnId, status: 'completed' } })];
}

// The real rpcClient processes the same JSON response/notification/close events.
// This socket has no network, provider, native process or external search port.
class ControlledSocket extends EventTarget {
  constructor(clock, controller, trigger, outcome, budget) {
    super();
    Object.assign(this, { clock, controller, trigger, outcome, budget, readyState: 1, requests: [], trace: [], interruptCount: 0 });
  }
  receive(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  reply(request, result) { this.receive({ id: request.id, result }); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.trace.push({ event: 'transport_closed', at: Date.now() });
    this.dispatchEvent(new Event('close'));
  }
  send(bytes) {
    const request = JSON.parse(bytes);
    this.requests.push(request);
    this.trace.push({ event: 'request', method: request.method, at: Date.now() });
    if (request.method === 'usage/stats') {
      this.reply(request, { history: null, windowDays: 30, timeZone: 'UTC' });
      return;
    }
    if (request.method === 'turn/start') {
      this.reply(request, { turn: { id: turnId } });
      this.receive(notification('turn/completed', { threadId: 'peer-thread', turn: { id: turnId, status: 'completed' } }));
      if (this.outcome === 'completed') {
        for (const frame of completedFrames()) this.receive(frame);
        return;
      }
      const item = this.trigger === 'search-count' ? { id: 'search-1', type: 'toolCall', name: 'WebSearch' }
        : this.trigger === 'fetch-count' ? { id: 'fetch-1', type: 'toolCall', name: 'WebFetch' }
          : { id: 'response-1', type: 'agentMessage' };
      const count = this.trigger === 'response-count' ? this.budget.maxResponses + 1
        : this.trigger === 'search-count' ? this.budget.maxSearchCalls + 1
          : this.trigger === 'fetch-count' ? this.budget.maxFetchCalls + 1 : 1;
      for (let index = 0; index < count; index++) this.receive(notification('item/started', { item: { ...item, id: `${item.id}-${index}` } }));
      if (this.trigger === 'abort') this.controller.abort(new Error('Controlled suite cancellation'));
      if (this.trigger === 'wall-time') this.clock.tick(this.budget.caseWallMs + 1);
      this.trace.push({ event: 'trigger_established', trigger: this.trigger, at: Date.now() });
      return;
    }
    assert.equal(request.method, 'turn/interrupt', 'Fixture must not accept unexpected RPC methods');
    assert.deepEqual(request.params, { threadId, turnId }, 'Interruption must target only the original owned turn');
    this.interruptCount++;
    if (this.interruptCount === 1 && this.outcome !== 'interrupted') {
      // Advance only Date; request timers remain real and are settled by RPC.
      // The existing production grace stays 20 seconds and is never shortened.
      if (this.outcome === 'disconnected') this.close();
      else this.reply(request, {});
      this.clock.tick(this.budget.caseWallMs + 20_001);
      this.trace.push({ event: 'settle_deadline_exceeded', at: Date.now() });
      return;
    }
    this.reply(request, {});
    if (this.outcome === 'interrupted') this.receive(notification('turn/completed', { turn: { id: turnId, status: 'interrupted' } }));
  }
}

async function exercise(context, t, trigger, outcome, verify) {
  const controller = new AbortController();
  const budget = { caseWallMs: 30_000, maxResponses: trigger === 'response-count' ? 3 : 10,
    maxSearchCalls: trigger === 'search-count' ? 1 : 10, maxFetchCalls: trigger === 'fetch-count' ? 1 : 10 };
  const socket = new ControlledSocket(t.mock.timers, controller, trigger, outcome, budget);
  context.addCleanup('close in-memory RPC fixture and release cancellation', () => { socket.close(); controller.abort(); });
  const rpc = rpcClient(socket);
  // A peer completion already on this transport must never settle this turn.
  socket.receive(notification('turn/completed', { threadId: 'peer-thread', turn: { id: turnId, status: 'completed' } }));
  let observed;
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 12) });
  try {
    observed = await runResearchTurn(rpc, task, threadId, budget, controller.signal);
    verify(observed, socket);
  } finally {
    t.mock.timers.reset();
  }
  await context.writeArtifactJson(`cases/${trigger}-${outcome}.json`, {
    trigger, outcome, result: observed.result, frames: observed.frames,
    requests: socket.requests, trace: socket.trace, limits: { realModelCalls: 0, externalSearchCalls: 0, nativeProcesses: 0, actualNetworkSockets: 0 },
  });
  return { trigger, outcome, mechanicalPassed: observed.result.mechanicalPassed, reasons: observed.result.mechanicalReasons,
    turnStarts: socket.requests.filter(row => row.method === 'turn/start').length, realModelCalls: 0, externalSearchCalls: 0 };
}

test('model-independent research cancellation, budgets and terminal receipts retain all nine acceptance cases', { timeout: 10_000 }, async t => {
  await runE2E(import.meta.url, { testId: 'research-terminal-nine-fault-and-normal-cases', tier: 'harness-unit',
    modelPolicy: 'Model-independent real RPC decoder with in-memory socket, controlled clock/cancellation and public metadata only; no model, network search, browser or native process.' }, async context => {
    // Keep this evidence matrix in one run so ordinary per-source retention
    // cannot discard early cancellation cases while later cases are running.
    const cases = [];
    for (const trigger of ['abort', 'wall-time', 'response-count', 'search-count', 'fetch-count']) {
      const outcomes = ['abort', 'wall-time'].includes(trigger) ? ['missing-terminal', 'disconnected'] : ['disconnected'];
      for (const outcome of outcomes) {
        cases.push(await exercise(context, t, trigger, outcome, ({ result, frames }, socket) => {
          const reason = trigger === 'abort' ? 'suite_aborted' : 'observed_case_budget_exceeded';
          assert.equal(result.mechanicalPassed, false);
          assert.equal(result.terminal, null);
          assert.equal(result.finalAnswerCompleted, false);
          assert.equal(result.mechanicalReasons.filter(value => value === reason).length, 1);
          assert.ok(result.mechanicalReasons.includes('transport_or_terminal_receipt_unknown'));
          assert.match(result.transportError, /did not settle after interruption/);
          assert.equal(result.qualityAcceptance, 'pending_two_independent_human_reviews');
          assert.ok(frames.length > 0 && frames.every(row => row.message.params.threadId === threadId));
          assert.equal(socket.requests.filter(row => row.method === 'turn/start').length, 1);
          const established = socket.trace.findIndex(row => row.event === 'trigger_established');
          const interrupt = socket.trace.findIndex(row => row.method === 'turn/interrupt');
          const unknown = socket.trace.findIndex(row => row.event === 'settle_deadline_exceeded');
          assert.ok(established >= 0 && established < interrupt && interrupt < unknown, 'Cancellation/budget must precede interruption and loss of terminal receipt');
          if (outcome === 'disconnected') {
            assert.ok(socket.trace.some(row => row.event === 'transport_closed'));
            assert.equal(result.usage.after.available, false, 'Disconnected usage must remain unavailable');
          }
        }));
        t.diagnostic(`Accepted ${trigger} followed by ${outcome}`);
      }
    }
    cases.push(await exercise(context, t, 'none', 'completed', ({ result }, socket) => {
      assert.equal(result.terminal, 'completed');
      assert.equal(result.mechanicalPassed, true);
      assert.equal(result.finalAnswerCompleted, true);
      assert.deepEqual(result.mechanicalReasons, []);
      assert.equal(result.qualityAcceptance, 'pending_two_independent_human_reviews');
      assert.equal(result.receipts.length, 2);
      assert.equal(socket.requests.filter(row => row.method === 'turn/start').length, 1);
      assert.equal(socket.interruptCount, 0);
    }));
    cases.push(await exercise(context, t, 'abort', 'interrupted', ({ result }, socket) => {
      assert.equal(result.terminal, 'interrupted');
      assert.equal(result.mechanicalPassed, false);
      assert.ok(result.mechanicalReasons.includes('suite_aborted'));
      assert.ok(!result.mechanicalReasons.includes('transport_or_terminal_receipt_unknown'));
      assert.equal(result.transportError, undefined);
      assert.equal(socket.requests.filter(row => row.method === 'turn/start').length, 1);
      assert.equal(socket.interruptCount, 1);
    }));
    assert.equal(cases.length, 9);
    await context.writeArtifactJson('case-index.json', { cases, caseCount: cases.length, realModelCalls: 0, externalSearchCalls: 0 });
    return { cases, caseCount: cases.length, realModelCalls: 0, externalSearchCalls: 0 };
  });
});
