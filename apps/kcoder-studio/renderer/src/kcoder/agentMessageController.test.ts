import { expect, test, vi } from 'vitest'
import { AgentMessageController, agentMessageTargetKey, type AgentMessageOperation, type AddressedMessageTarget } from '../../../shared/agentMessageController'
import { AgentMessageJournal, agentMessageIntentDigest } from '../../../shared/agentMessageJournal'
import type { CrossSessionMessageReceipt } from '../../../shared/generated/contracts'

const sourceAddress = { targetId: 'native-source', workspaceId: 'source-workspace', threadId: 'same' }
const firstAddress = { targetId: 'native-first', workspaceId: 'first-workspace', threadId: 'same' }
const secondAddress = { targetId: 'native-second', workspaceId: 'second-workspace', threadId: 'same' }
const target = (address = firstAddress): AddressedMessageTarget => ({ address, threadId: address.threadId,
  title: address.targetId, status: 'idle', presence: 'resident', allowedModes: ['enqueue_only', 'wake_if_idle'] })
const receipt = (clientMessageId = 'request-1', address = firstAddress): CrossSessionMessageReceipt => ({
  messageId: 'accepted-message', clientMessageId, targetThreadId: address.threadId, revision: 1, status: 'queued',
  sourceAddress, targetAddress: address,
} as CrossSessionMessageReceipt)

function fixture(enabled = true) {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  let lock = Promise.resolve()
  const journal = new AgentMessageJournal(storage, 'account/actual-source/workspace/same', async work => {
    const previous = lock
    let release!: () => void
    lock = new Promise(resolve => { release = resolve })
    await previous
    try { return await work() } finally { release() }
  })
  const state = { current: true, policy: { enabled, wakeIdle: false, revision: 'policy-1' },
    accepted: undefined as CrossSessionMessageReceipt | undefined, loseSend: false, loseSave: false }
  const calls: Array<{ operation: AgentMessageOperation; input: Record<string, unknown>; scope: string }> = []
  const createId = vi.fn(() => `request-${createId.mock.calls.length}`)
  const adapter = {
    current: () => state.current, createId, journal: () => journal,
    support: async () => ({ scope: 'owned-source-scope', sourceThreadId: 'same', discovery: true, messages: true }),
    request: async (operation: AgentMessageOperation, input: Record<string, unknown>, scope: string): Promise<unknown> => {
      calls.push({ operation, input, scope })
      if (operation === 'policyRead') return { ...state.policy }
      if (operation === 'policySave') {
        expect(input.expectedRevision).toBe(state.policy.revision)
        state.policy = { enabled: input.enabled as boolean, wakeIdle: input.wakeIdle as boolean, revision: 'policy-2' }
        if (state.loseSave) throw Error('lost receipt')
        return { ...state.policy }
      }
      if (operation === 'targets') return { coverage: 'workspace_history', completeness: 'complete', targets: [target(), target(secondAddress)] }
      if (operation === 'get') return { receipt: state.accepted ?? null }
      const message = input.message as { clientMessageId: string; targetAddress: typeof firstAddress }
      expect((await journal.load()).some(row => row.clientMessageId === message.clientMessageId)).toBe(true)
      state.accepted = receipt(message.clientMessageId, message.targetAddress)
      if (state.loseSend) throw Error('lost receipt')
      return state.accepted
    },
  }
  const controller = new AgentMessageController(adapter)
  const ready = async () => { await controller.load(); controller.select(agentMessageTargetKey(target())); controller.setDraft('hello') }
  return { controller, adapter, journal, values, state, calls, ready, createId }
}

test('capability support cannot enable messaging; the first user policy action uses the observed revision', async () => {
  const f = fixture(false)
  await f.controller.load()
  expect(f.controller.getSnapshot().targets).toEqual([])
  expect(f.calls.map(call => call.operation)).toEqual(['policyRead'])
  expect(f.controller.canSend()).toBe(false)
  await f.controller.savePolicy(true, false)
  expect(f.calls.map(call => call.operation)).toEqual(['policyRead', 'policySave', 'policyRead', 'targets'])
  expect(f.controller.getSnapshot().policy).toEqual({ enabled: true, wakeIdle: false, revision: 'policy-2' })
  f.controller.select(agentMessageTargetKey(target()))
  f.controller.setDraft('hello')
  f.controller.setMode('wake_if_idle')
  expect(f.controller.canSend()).toBe(false)
})

test('a lost send receipt survives reload and reconciles the original ID without automatically resending', async () => {
  const f = fixture(); await f.ready(); f.state.loseSend = true
  await f.controller.send()
  expect(f.controller.getSnapshot()).toMatchObject({ error: 'send_unknown', draft: 'hello' })
  const original = (await f.journal.load())[0]!
  expect(f.controller.canSend()).toBe(false)
  f.controller.dispose()
  const reloaded = new AgentMessageController(f.adapter)
  await reloaded.load(); reloaded.select(agentMessageTargetKey(target())); reloaded.setDraft('hello')
  await reloaded.send()
  expect(f.calls.filter(call => call.operation === 'send')).toHaveLength(1)
  await reloaded.reconcile(original.clientMessageId)
  expect(reloaded.getSnapshot()).toMatchObject({ draft: '', observations: [{ clientMessageId: original.clientMessageId, receipt: f.state.accepted }] })
  expect(f.createId).toHaveBeenCalledTimes(1)
  expect([...f.values.values()].join('')).not.toContain('hello')
})

test('confirmed absence allows one explicit retry with the same request ID and immediately revokes the old absence observation', async () => {
  const f = fixture(); await f.ready(); f.state.loseSend = true
  await f.controller.send()
  const original = (await f.journal.load())[0]!
  f.state.accepted = undefined
  await f.controller.reconcile(original.clientMessageId)
  expect(f.controller.canSend()).toBe(true)
  await f.controller.send()
  const sends = f.calls.filter(call => call.operation === 'send')
  expect(sends).toHaveLength(2)
  expect(sends[0]?.input).toEqual(sends[1]?.input)
  expect(f.createId).toHaveBeenCalledTimes(1)
  expect(f.controller.getSnapshot()).toMatchObject({ error: 'send_unknown', absent: [] })
  expect(f.controller.canSend()).toBe(false)
})

test('same thread IDs on different targets remain separate selections, fingerprints and receipts', async () => {
  const f = fixture(); await f.ready()
  expect(f.controller.getSnapshot().targets).toHaveLength(2)
  const common = { targetThreadId: 'same', mode: 'enqueue_only' as const, text: 'hello' }
  expect(agentMessageIntentDigest({ ...common, targetAddress: firstAddress })).not.toBe(agentMessageIntentDigest({ ...common, targetAddress: secondAddress }))
  f.controller.select(agentMessageTargetKey(target(secondAddress)))
  await f.controller.send()
  expect(f.calls.find(call => call.operation === 'send')?.input).toMatchObject({ message: { targetAddress: secondAddress } })
  const original = (await f.journal.load())[0]!
  await expect(f.journal.observe({ ...receipt(original.clientMessageId, firstAddress), revision: 2 })).rejects.toThrow('owner_changed')
  await expect(f.journal.observe({ ...receipt(original.clientMessageId, secondAddress), messageId: 'another-message', revision: 2 })).rejects.toThrow('owner_changed')
})

test('a lost policy receipt reads the current policy instead of replaying a settings write', async () => {
  const f = fixture(false); await f.controller.load(); f.state.loseSave = true
  await f.controller.savePolicy(true, true)
  expect(f.calls.map(call => call.operation)).toEqual(['policyRead', 'policySave', 'policyRead'])
  expect(f.controller.getSnapshot()).toMatchObject({ policy: { enabled: true, wakeIdle: true }, error: 'policy_unknown', selected: undefined })
  expect(f.controller.canSend()).toBe(false)
})

test('an accepted receipt cannot become absent or move to another message identity', async () => {
  const f = fixture(); await f.ready(); await f.controller.send()
  const original = (await f.journal.load())[0]!
  f.state.accepted = undefined
  await f.controller.reconcile(original.clientMessageId)
  expect(f.controller.getSnapshot()).toMatchObject({ error: 'receipt_failed', absent: [] })
  expect(f.controller.getSnapshot().observations[0]?.receipt).toEqual(original.receipt)
})

test('shared renderer and Mobile selectors retain actual current turn observations without binding a generic send', async () => {
  const f = fixture()
  const originalRequest = f.adapter.request
  f.adapter.request = async (operation, input, scope) => operation === 'targets'
    ? { coverage: 'workspace_history', completeness: 'complete', targets: [{ ...target(), status: 'running', activeTurnId: 'original-current-turn' }] }
    : originalRequest(operation, input, scope)
  await f.ready()
  expect(f.controller.getSnapshot().selected?.activeTurnId).toBe('original-current-turn')
  await f.controller.send()
  expect(f.calls.find(call => call.operation === 'send')?.input).toMatchObject({ message: { targetAddress: firstAddress } })
  expect((f.calls.find(call => call.operation === 'send')?.input.message as Record<string, unknown>).expectedTurnId).toBeUndefined()
  f.adapter.request = async (operation, input, scope) => operation === 'targets'
    ? { coverage: 'workspace_history', completeness: 'complete', targets: [{ ...target(), activeTurnId: 'x'.repeat(257) }] }
    : originalRequest(operation, input, scope)
  await f.controller.load()
  expect(f.controller.getSnapshot().error).toBe('read_failed')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('policy refresh retains displayed receivers and draft but blocks every intermediate send', async () => {
  const f = fixture(); await f.ready()
  const original = f.adapter.request
  const saved = deferred<unknown>(), refreshed = deferred<unknown>()
  f.adapter.request = async (operation, input, scope) => operation === 'policySave' ? saved.promise
    : operation === 'targets' ? refreshed.promise : original(operation, input, scope)
  const before = f.controller.getSnapshot()
  const states: Array<{ selected: unknown; targets: unknown; canSend: boolean }> = []
  const unsubscribe = f.controller.subscribe(() => states.push({ selected: f.controller.getSnapshot().selected,
    targets: f.controller.getSnapshot().targets, canSend: f.controller.canSend() }))
  const save = f.controller.savePolicy(true, true)
  await f.controller.send()
  expect(f.controller.getSnapshot()).toMatchObject({ selected: before.selected, targets: before.targets, draft: 'hello', busy: true })
  f.state.policy = { enabled: true, wakeIdle: true, revision: 'policy-2' }
  saved.resolve(f.state.policy)
  await vi.waitFor(() => expect(f.controller.getSnapshot().loading).toBe(true))
  await f.controller.send()
  expect(states.every(state => state.selected === before.selected && state.targets === before.targets && !state.canSend)).toBe(true)
  refreshed.resolve({ coverage: 'workspace_history', completeness: 'complete', targets: [target(), target(secondAddress)] })
  await save
  expect(f.controller.getSnapshot()).toMatchObject({ selected: before.selected, draft: 'hello', busy: false, loading: false })
  expect(f.controller.canSend()).toBe(true)
  expect(f.calls.some(call => call.operation === 'send')).toBe(false)
  unsubscribe()
})

test('policy refresh failure keeps displayed rows without retaining dispatch permission', async () => {
  const f = fixture(); await f.ready(); const before = f.controller.getSnapshot()
  const original = f.adapter.request
  f.adapter.request = async (operation, input, scope) => operation === 'targets' ? Promise.reject(Error('read unavailable')) : original(operation, input, scope)
  await f.controller.savePolicy(true, true)
  expect(f.controller.getSnapshot()).toMatchObject({ targets: before.targets, selected: before.selected, draft: 'hello', error: 'read_failed' })
  expect(f.controller.canSend()).toBe(false)
  await f.controller.send()
  expect(f.calls.some(call => call.operation === 'send')).toBe(false)
  f.adapter.request = async (operation, input, scope) => operation === 'targets'
    ? { coverage: 'workspace_history', completeness: 'complete', targets: [{ ...target(), allowedModes: [] }] }
    : original(operation, input, scope)
  await f.controller.load()
  expect(f.controller.canSend()).toBe(false)
})

test('policy refresh revalidates every displayed page before keeping its original selection sendable', async () => {
  const f = fixture(); const original = f.adapter.request
  const pageTwo = deferred<unknown>(); let refreshing = false
  f.adapter.request = async (operation, input, scope) => operation === 'targets'
    ? input.cursor ? refreshing ? pageTwo.promise : { coverage: 'workspace_history', completeness: 'complete', targets: [target(secondAddress)] }
      : { coverage: 'workspace_history', completeness: 'complete', nextCursor: 'second-page', targets: [target()] }
    : original(operation, input, scope)
  await f.controller.load(); await f.controller.load('second-page')
  f.controller.select(agentMessageTargetKey(target(secondAddress))); f.controller.setDraft('second receiver')
  const before = f.controller.getSnapshot(); refreshing = true
  const save = f.controller.savePolicy(true, true)
  await vi.waitFor(() => expect(f.controller.getSnapshot().loading).toBe(true))
  expect(f.controller.getSnapshot().targets).toBe(before.targets)
  expect(f.controller.getSnapshot().selected).toBe(before.selected)
  expect(f.controller.canSend()).toBe(false)
  pageTwo.resolve({ coverage: 'workspace_history', completeness: 'complete', targets: [target(secondAddress)] })
  await save
  expect(f.controller.getSnapshot()).toMatchObject({ targets: [target(), target(secondAddress)], selected: target(secondAddress), draft: 'second receiver' })
  expect(f.controller.canSend()).toBe(true)
})

test('lost policy confirmation preserves presentation and requires explicit refresh before any new action', async () => {
  const f = fixture(); await f.ready(); const before = f.controller.getSnapshot(); const original = f.adapter.request
  f.adapter.request = async (operation, input, scope) => operation === 'policySave' || operation === 'policyRead'
    ? Promise.reject(Error('receipt unavailable')) : original(operation, input, scope)
  await f.controller.savePolicy(true, true)
  expect(f.controller.getSnapshot()).toMatchObject({ targets: before.targets, selected: before.selected, policy: before.policy, error: 'policy_unknown' })
  expect(f.controller.canSend()).toBe(false)
  await f.controller.savePolicy(true, true); await f.controller.send()
  expect(f.calls.some(call => call.operation === 'send')).toBe(false)
  f.adapter.request = original
  await f.controller.load()
  expect(f.controller.canSend()).toBe(true)
})

test('sending progress belongs only to an actual send and settles with its original receipt', async () => {
  const f = fixture(); await f.ready(); const original = f.adapter.request
  const dispatch = deferred<void>()
  f.adapter.request = async (operation, input, scope) => {
    if (operation === 'send') await dispatch.promise
    return original(operation, input, scope)
  }
  await f.controller.savePolicy(true, true)
  expect(f.controller.getSnapshot().sending).not.toBe(true)
  const send = f.controller.send()
  await vi.waitFor(() => expect(f.controller.getSnapshot().sending).toBe(true))
  dispatch.resolve()
  await send
  expect(f.controller.getSnapshot()).toMatchObject({ sending: false, busy: false, draft: '' })
})


test.each(['support', 'journal', 'policy', 'targets', 'validation'] as const)('read diagnostics retain the closed %s failure stage without sending', async stage => {
  const f = fixture(); const original = f.adapter.request;
  const failure = Object.assign(new Error('PRIVATE_PATH_TOKEN'), { data: { reason: 'peer_source_tool_disabled', token: 'PRIVATE_PATH_TOKEN' } });
  if (stage === 'support') f.adapter.support = async () => { throw failure };
  else if (stage === 'journal') f.adapter.journal = () => { throw failure };
  else f.adapter.request = async (operation, input, scope) => {
    if (stage === 'policy' && operation === 'policyRead' || stage === 'targets' && operation === 'targets') throw failure;
    if (stage === 'validation' && operation === 'targets') return { targets: [{ ...target(), activeTurnId: 'x'.repeat(257) }] };
    return original(operation, input, scope);
  };
  await f.controller.load();
  expect(f.controller.getSnapshot().readDiagnostic).toEqual({ stage, reason: stage === 'validation' ? 'agent_messages_invalid_target' : 'peer_source_tool_disabled' });
  expect(JSON.stringify(f.controller.getSnapshot().readDiagnostic)).not.toContain('PRIVATE_PATH_TOKEN');
  expect(f.controller.canSend()).toBe(false);
  expect(f.calls.some(call => call.operation === 'send')).toBe(false);
});

test('read diagnostics retain the old observation during the same read and clear on success, new scope and disposal', async () => {
  const f = fixture(); const original = f.adapter.request;
  f.adapter.request = async (operation, input, scope) => operation === 'targets' ? Promise.reject(new Error('PRIVATE_TOKEN')) : original(operation, input, scope);
  await f.controller.load();
  const before = f.controller.getSnapshot().readDiagnostic;
  const next = deferred<unknown>();
  f.adapter.request = async (operation, input, scope) => operation === 'targets' ? next.promise : original(operation, input, scope);
  const read = f.controller.load();
  expect(f.controller.getSnapshot().readDiagnostic).toEqual(before);
  next.resolve({ coverage: 'workspace_history', completeness: 'complete', targets: [target()] });
  await read; expect(f.controller.getSnapshot().readDiagnostic).toBeUndefined();
  f.adapter.request = async () => { throw new Error('PRIVATE_TOKEN') };
  await f.controller.load(); expect(f.controller.getSnapshot().readDiagnostic).toBeDefined();
  const changed = deferred<unknown>();
  f.adapter.support = async () => ({ scope: 'new-owned-source-scope', sourceThreadId: 'same', discovery: true, messages: true });
  f.adapter.request = async () => changed.promise;
  const pending = f.controller.load();
  await vi.waitFor(() => expect(f.controller.getSnapshot().support?.scope).toBe('new-owned-source-scope'));
  expect(f.controller.getSnapshot().readDiagnostic).toBeUndefined();
  changed.resolve({ enabled: false, wakeIdle: false, revision: 'policy-2' });
  await pending;
  f.controller.dispose(); expect(f.controller.getSnapshot().readDiagnostic).toBeUndefined();
});
