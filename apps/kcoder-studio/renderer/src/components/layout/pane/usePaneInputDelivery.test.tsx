import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  cacheRuntimeConversationQueuedMessagesByKey,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationQueuedMessagesByKey,
  runtimeConversationKey,
} from '@/features/workbench/runtimeConversationCache'
import { usePaneSend } from './usePaneSend'
import { usePaneQueueControls } from './usePaneQueueControls'
import { notifyAccountContextChange, updateVerifiedAccountContextScope } from '@/kcoder/accountContextEvents'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: request }))
afterEach(() => {
  clearRuntimeConversationCacheForTests()
  vi.clearAllMocks()
})
const address = { deviceId: 'delivery-ui-server', taskId: 'task', threadId: 'thread' }
const message: RuntimePaneQueuedMessage = {
  id: 'input',
  content: 'original message',
  status: 'queued',
  createdAt: 'now',
  ownerKey: runtimeConversationKey(address),
}

function setup(initial: RuntimePaneQueuedMessage[] = [], draft = '') {
  const key = runtimeConversationKey(address)
  cacheRuntimeConversationQueuedMessagesByKey(key, initial)
  const context = {
    currentRuntimeTask: address as RuntimeTaskAddress,
    currentRuntimeTaskRef: { current: address },
    runtimeTaskLoadTarget: { address: address as RuntimeTaskAddress },
    accountScopeInvalidatedRef: { current: false },
    queuedMessageSendInFlightIdsRef: { current: new Set<string>() },
    pendingAppliedGuidancesRef: { current: new Map() },
    queuedMessages: initial,
    input: draft,
    projectChat: { models: [], addExistingAttachment: vi.fn() },
    setQueuedMessages: vi.fn(
      (update: (rows: RuntimePaneQueuedMessage[]) => RuntimePaneQueuedMessage[]) => {
        const previous = getRuntimeConversationQueuedMessagesByKey(key)
        const next = update(previous)
        // Match the existing pane owner's identity guard before persistence.
        if (next !== previous) cacheRuntimeConversationQueuedMessagesByKey(key, next)
      }
    ),
    setInput: vi.fn(),
    setCodeCommentContexts: vi.fn(),
    setError: vi.fn(),
    dispatchMessages: vi.fn(),
    lastSubmittedRetryMessageRef: { current: null },
    sendRuntimePaneMessage: vi.fn(async () => true),
  }
  const send = renderHook(() =>
    usePaneSend(context as unknown as Parameters<typeof usePaneSend>[0])
  )
  const controls = renderHook(() =>
    usePaneQueueControls({
      ...context,
      refreshQueuedDelivery: send.result.current.refreshQueuedDelivery,
    } as unknown as Parameters<typeof usePaneQueueControls>[0])
  )
  return { context, send, controls, rows: () => getRuntimeConversationQueuedMessagesByKey(key) }
}

test('fresh receipt reads with unchanged facts do not rewrite pending inputs', async () => {
  updateVerifiedAccountContextScope(address.deviceId, 'owned-input-receipt-account')
  const f = setup([{ ...message, status: 'unknown' }])
  const before = f.rows()
  const write = vi.spyOn(Storage.prototype, 'setItem')
  const remove = vi.spyOn(Storage.prototype, 'removeItem')
  request.mockResolvedValue({ status: 'unknown' })
  try {
    for (let index = 0; index < 40; index++)
      await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
    expect(request).toHaveBeenCalledTimes(40)
    expect(write).not.toHaveBeenCalled()
    expect(f.rows()).toBe(before)
    request.mockResolvedValue({ status: 'running', turnId: 'original-turn' })
    await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
    expect(write).toHaveBeenCalledTimes(1)
    expect(f.rows()).toMatchObject([{ status: 'running', turnId: 'original-turn' }])
    write.mockClear()
    request.mockResolvedValue({ status: 'unknown' })
    await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
    expect(write).not.toHaveBeenCalled()
    request.mockResolvedValue({ status: 'completed', turnId: 'original-turn' })
    await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
    expect(f.rows()).toEqual([])
    expect(remove).toHaveBeenCalledTimes(1)
  } finally {
    f.send.unmount(); f.controls.unmount(); write.mockRestore(); remove.mockRestore()
    notifyAccountContextChange(address.deviceId)
  }
})

test('send and queue observers share only an unfinished receipt read, then read afresh', async () => {
  const f = setup([{ ...message, status: 'unknown' }])
  let finish!: (delivery: { status: string }) => void
  request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  let first!: Promise<void>, second!: Promise<void>
  act(() => {
    first = f.send.result.current.refreshQueuedDelivery(message.id)
    second = f.send.result.current.refreshQueuedDelivery(message.id)
  })
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { finish({ status: 'unknown' }); await Promise.all([first, second]) })
  expect(f.context.setQueuedMessages).toHaveBeenCalledTimes(1)
  request.mockResolvedValue({ status: 'completed', turnId: 'original-turn' })
  await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
  expect(request).toHaveBeenCalledTimes(2)
  expect(f.rows()).toEqual([])
})

test('presentation metadata does not replace the original receipt reader or its unfinished read', async () => {
  const f = setup([{ ...message, status: 'unknown' }])
  let finish!: (delivery: { status: string }) => void
  request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const reader = f.send.result.current.refreshQueuedDelivery
  let first!: Promise<void>, second!: Promise<void>
  act(() => { first = reader(message.id) })
  f.context.currentRuntimeTask = { ...address, runtimeHandle: { modelSelection: { modelName: 'updated-presentation' } } }
  f.context.currentRuntimeTaskRef.current = f.context.currentRuntimeTask as typeof address
  f.send.rerender()
  expect(f.send.result.current.refreshQueuedDelivery).toBe(reader)
  act(() => { second = f.send.result.current.refreshQueuedDelivery(message.id) })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith('runtime.input.delivery', expect.objectContaining({ address }))
  await act(async () => { finish({ status: 'unknown' }); await Promise.all([first, second]) })
})

test('a stale pending render cannot reread an input already confirmed running in the current queue', async () => {
  const f = setup([{ ...message, status: 'accepted' }])
  request.mockResolvedValue({ status: 'running', turnId: 'original-turn' })
  cacheRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(address), [
    { ...message, status: 'running', turnId: 'original-turn' },
  ])
  await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id, 'pending') })
  expect(request).not.toHaveBeenCalled()
  request.mockResolvedValue({ status: 'completed', turnId: 'original-turn' })
  await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
  expect(request).toHaveBeenCalledTimes(1)
  expect(f.rows()).toEqual([])
})

test('verified presentation facts added to the retained address do not replace its receipt reader', async () => {
  const f = setup([{ ...message, status: 'unknown' }])
  let finish!: (delivery: { status: string }) => void
  request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const reader = f.send.result.current.refreshQueuedDelivery
  let first!: Promise<void>, second!: Promise<void>
  act(() => { first = reader(message.id) })
  const updated = { ...address, runtimeHandle: { threadId: address.threadId,
    memoryTaskSnapshot: { sequence: 1 }, agentDefinition: { agentId: 'presentation' } } }
  f.context.currentRuntimeTask = updated
  f.context.currentRuntimeTaskRef.current = updated
  f.context.runtimeTaskLoadTarget = { address: updated }
  f.send.rerender()
  expect(f.send.result.current.refreshQueuedDelivery).toBe(reader)
  act(() => { second = f.send.result.current.refreshQueuedDelivery(message.id) })
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { finish({ status: 'unknown' }); await Promise.all([first, second]) })
})

test('the receipt selector retains the original handle thread and ignores presentation fields', async () => {
  const f = setup([{ ...message, status: 'unknown' }])
  f.context.currentRuntimeTask = { ...address, threadId: null, runtimeHandle: { session_id: address.threadId, memoryTaskSnapshot: { sequence: 1 } } }
  f.context.runtimeTaskLoadTarget = { address: f.context.currentRuntimeTask }
  f.send.rerender()
  request.mockResolvedValue({ status: 'unknown' })
  await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
  expect(request).toHaveBeenCalledWith('runtime.input.delivery', expect.objectContaining({ address }))
})

test.each(['unknown', 'completed'])('real receipt hints reconcile after a pending %s result without parallel reads', async status => {
  const f = setup([{ ...message, status: 'unknown' }])
  const finish: Array<(delivery: { status: string }) => void> = []
  request.mockImplementation(() => new Promise(resolve => { finish.push(resolve) }))
  let first!: Promise<void>, hint!: Promise<void>, anotherHint!: Promise<void>
  act(() => {
    first = f.send.result.current.refreshQueuedDelivery(message.id)
    hint = f.send.result.current.refreshQueuedDelivery(message.id, 'reconcile')
    anotherHint = f.send.result.current.refreshQueuedDelivery(message.id, 'reconcile')
  })
  expect(request).toHaveBeenCalledTimes(1)
  await act(async () => { finish[0]({ status }); await first })
  if (status === 'completed') expect(request).toHaveBeenCalledTimes(1)
  else {
    expect(request).toHaveBeenCalledTimes(2)
    await act(async () => { finish[1]({ status: 'completed' }) })
  }
  await act(async () => { await Promise.all([hint, anotherHint]) })
  expect(f.rows()).toEqual([])
})

test.each(['account', 'task'])('a receipt hint cannot continue after its %s ownership is replaced', async owner => {
  const f = setup([{ ...message, status: 'unknown' }])
  let finish!: (delivery: { status: string }) => void
  request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  let first!: Promise<void>, hint!: Promise<void>
  act(() => {
    first = f.send.result.current.refreshQueuedDelivery(message.id)
    hint = f.send.result.current.refreshQueuedDelivery(message.id, 'reconcile')
  })
  if (owner === 'account') notifyAccountContextChange(address.deviceId)
  else f.context.currentRuntimeTaskRef.current = { ...address, taskId: 'replacement' }
  await act(async () => { finish({ status: 'unknown' }); await Promise.all([first, hint]) })
  expect(request).toHaveBeenCalledTimes(1)
  expect(f.context.sendRuntimePaneMessage).not.toHaveBeenCalled()
})

test('an account revision retires the pending read and rejects its late projection', async () => {
  const f = setup([{ ...message, status: 'unknown' }])
  let finishOld!: (delivery: { status: string }) => void, finishNew!: (delivery: { status: string; turnId: string }) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  let previous!: Promise<void>
  act(() => { previous = f.send.result.current.refreshQueuedDelivery(message.id) })
  notifyAccountContextChange(address.deviceId)
  request.mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
  let current!: Promise<void>, joining!: Promise<void>
  act(() => { current = f.send.result.current.refreshQueuedDelivery(message.id) })
  await act(async () => { finishOld({ status: 'completed' }); await previous })
  act(() => { joining = f.send.result.current.refreshQueuedDelivery(message.id) })
  expect(request).toHaveBeenCalledTimes(2)
  await act(async () => { finishNew({ status: 'running', turnId: 'new-account-turn' }); await Promise.all([current, joining]) })
  expect(f.context.setQueuedMessages).toHaveBeenCalledTimes(1)
  expect(f.rows()[0]).toMatchObject({ status: 'running', turnId: 'new-account-turn' })
})

test('a failed shared read leaves unknown input intact and allows a fresh recovery', async () => {
  const f = setup([{ ...message, status: 'unknown' }])
  request.mockRejectedValueOnce(new Error('Owned transport lost'))
  await act(async () => { await Promise.all([
    f.send.result.current.refreshQueuedDelivery(message.id),
    f.send.result.current.refreshQueuedDelivery(message.id),
  ]) })
  expect(request).toHaveBeenCalledTimes(1)
  expect(f.rows()[0].status).toBe('unknown')
  expect(f.context.sendRuntimePaneMessage).not.toHaveBeenCalled()
  request.mockResolvedValue({ status: 'completed', turnId: 'original-turn' })
  await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
  expect(request).toHaveBeenCalledTimes(2)
  expect(f.rows()).toEqual([])
})

test.each([
  { threadId: 'replacement-thread' },
  { workspacePath: '/replacement-workspace' },
  { expectedSessionAddress: { targetId: 'native-target', workspaceId: 'native-workspace', threadId: address.threadId } },
])('a changed original read scope cannot join its previous read: %j', async changed => {
  const f = setup([{ ...message, status: 'unknown' }])
  let finish!: (delivery: { status: string }) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  let previous!: Promise<void>
  act(() => { previous = f.send.result.current.refreshQueuedDelivery(message.id) })
  f.context.currentRuntimeTask = { ...address, ...changed }
  f.context.runtimeTaskLoadTarget = { address: f.context.currentRuntimeTask }
  f.send.rerender()
  request.mockResolvedValue({ status: 'unknown' })
  await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
  expect(request).toHaveBeenCalledTimes(2)
  await act(async () => { finish({ status: 'unknown' }); await previous })
})

test.each(['turnId', 'deliveryMode'] as const)('a changed %s requires its own receipt read', async field => {
  const f = setup([{ ...message, status: 'unknown' }])
  let finishOld!: (delivery: { status: string }) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  let previous!: Promise<void>
  act(() => { previous = f.send.result.current.refreshQueuedDelivery(message.id) })
  cacheRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(address), [
    { ...message, status: 'unknown', ...(field === 'turnId' ? { turnId: 'resolved-turn' } : { deliveryMode: 'guidance' }) },
  ])
  request.mockResolvedValue({ status: 'unknown' })
  await act(async () => { await f.send.result.current.refreshQueuedDelivery(message.id) })
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenLastCalledWith('runtime.input.delivery', expect.objectContaining(
    field === 'turnId' ? { expectedTurnId: 'resolved-turn' } : { deliveryMode: 'guidance' }
  ))
  await act(async () => { finishOld({ status: 'unknown' }); await previous })
})

test('cancellation is independent of an unfinished read and its terminal result cannot be resurrected', async () => {
  const f = setup([{ ...message, status: 'running', turnId: 'original-turn' }])
  let finishRead!: (delivery: { status: string; turnId: string }) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
  let reading!: Promise<void>
  act(() => { reading = f.send.result.current.refreshQueuedDelivery(message.id) })
  request.mockResolvedValue({ status: 'completed', turnId: 'original-turn' })
  await act(async () => { f.controls.result.current.cancelQueuedMessage(message.id) })
  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenLastCalledWith('runtime.input.delivery', expect.objectContaining({ action: 'cancel' }))
  expect(f.rows()).toEqual([])
  await act(async () => { finishRead({ status: 'running', turnId: 'original-turn' }); await reading })
  expect(f.rows()).toEqual([])
})

test('Enter exposes sending immediately and acceptance keeps the same stable identity', async () => {
  const f = setup()
  let accept!: (accepted: boolean) => void
  f.context.sendRuntimePaneMessage.mockImplementation(
    () =>
      new Promise(resolve => {
        accept = resolve
      })
  )
  request.mockResolvedValue({ status: 'running', turnId: 'original-turn' })
  let sending!: Promise<boolean>
  act(() => {
    sending = f.send.result.current.sendRuntimeMessage(message)
  })
  expect(f.rows()[0]).toMatchObject({ id: message.id, status: 'sending' })
  expect(f.rows()[0].directSubmission).toBe(true)
  await act(async () => {
    accept(true)
    await sending
  })
  expect(f.rows()).toHaveLength(1)
  expect(f.rows()[0]).toMatchObject({ id: message.id, status: 'running', turnId: 'original-turn' })
})

test('an explicitly queued submission retains its queue presentation while being dispatched', async () => {
  const f = setup([message])
  request.mockResolvedValue({ status: 'running', turnId: 'queued-original-turn' })
  await act(async () => { await f.send.result.current.sendRuntimeMessage(message) })
  expect(f.rows()[0].directSubmission).not.toBe(true)
  expect(f.rows()[0]).toMatchObject({ id: message.id, status: 'running', turnId: 'queued-original-turn' })
})

test('a missing send acknowledgement remains unknown and cannot be restored or replayed', async () => {
  const f = setup()
  f.context.sendRuntimePaneMessage.mockResolvedValue(false)
  request.mockResolvedValue({ status: 'unknown' })
  await act(async () => {
    await f.send.result.current.sendRuntimeMessage(message)
  })
  expect(f.rows()[0].status).toBe('unknown')
  act(() => f.controls.result.current.cancelQueuedMessage(message.id))
  expect(f.rows()[0].cancelRequested).toBe(true)
  expect(f.context.setInput).not.toHaveBeenCalled()
})

test('a late acceptance acknowledgement cannot downgrade an already observed running receipt', async () => {
  const f = setup()
  let accept!: (accepted: boolean) => void
  f.context.sendRuntimePaneMessage.mockImplementation(
    () =>
      new Promise(resolve => {
        accept = resolve
      })
  )
  request
    .mockResolvedValueOnce({ status: 'running', turnId: 'original-turn' })
    .mockResolvedValue({ status: 'unknown' })
  let sending!: Promise<boolean>
  act(() => {
    sending = f.send.result.current.sendRuntimeMessage(message)
  })
  await act(async () => {
    await f.send.result.current.refreshQueuedDelivery(message.id)
  })
  expect(f.rows()[0].status).toBe('running')
  await act(async () => {
    accept(true)
    await sending
  })
  expect(f.rows()[0]).toMatchObject({ status: 'running', turnId: 'original-turn' })
})

test('a locally queued cancellation restores the draft without contacting the backend', () => {
  const f = setup([message])
  act(() => f.controls.result.current.cancelQueuedMessage(message.id))
  expect(f.rows()).toEqual([])
  expect(f.context.setInput).toHaveBeenCalledWith(message.content)
  expect(request).not.toHaveBeenCalled()
})

test('a stale queued click rechecks the current sending record before cancelling', async () => {
  const f = setup([message])
  cacheRuntimeConversationQueuedMessagesByKey(runtimeConversationKey(address), [
    { ...message, status: 'sending' },
  ])
  request.mockResolvedValue({ status: 'unknown' })
  await act(async () => f.controls.result.current.cancelQueuedMessage(message.id))
  expect(f.rows()[0]).toMatchObject({ status: 'unknown', cancelRequested: true })
  expect(f.context.setInput).not.toHaveBeenCalled()
  expect(request).toHaveBeenCalledWith(
    'runtime.input.delivery',
    expect.objectContaining({ action: 'cancel', clientMessageId: message.id })
  )
})

test('completion winning cancellation removes the pending record without restoring a draft', async () => {
  const f = setup([{ ...message, status: 'running', turnId: 'original-turn' }])
  request.mockResolvedValue({ status: 'completed', turnId: 'original-turn' })
  await act(async () => {
    f.controls.result.current.cancelQueuedMessage(message.id)
  })
  expect(f.rows()).toEqual([])
  expect(f.context.setInput).not.toHaveBeenCalled()
})

test('confirmed cancellation restores once and preserves text typed while waiting', () => {
  const f = setup([{ ...message, status: 'interrupted', cancelRequested: true }], 'newer draft')
  // The cancellation is settled when the controls observe the backend receipt.
  expect(f.context.setInput).toHaveBeenCalledWith(message.content + '\n\nnewer draft')
  expect(f.rows()).toEqual([])
  f.controls.rerender()
  expect(f.context.setInput).toHaveBeenCalledTimes(1)
})

test('an old owner cancellation cannot restore a draft into a replacement task', () => {
  const f = setup([
    { ...message, status: 'interrupted', cancelRequested: true, ownerKey: 'old-owner' },
  ])
  expect(f.context.setInput).not.toHaveBeenCalled()
  expect(f.rows()).toHaveLength(1)
})

test('late cancellation or replay callbacks cannot act on a replacement task', () => {
  const f = setup([message])
  const cancel = f.controls.result.current.cancelQueuedMessage
  f.context.currentRuntimeTaskRef.current = { ...address, taskId: 'replacement' }
  act(() => cancel(message.id))
  expect(f.rows()).toHaveLength(1)
  expect(f.context.setInput).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})


test.each(['applied', 'running'])('a %s receipt reconciles guidance and refreshes its original transcript', async status => {
  const f = setup([{ ...message, status: 'unknown', deliveryMode: 'guidance' }])
  f.context.pendingAppliedGuidancesRef.current.set(message.id, message)
  const reconciled = vi.fn()
  window.addEventListener('kcoder:turn-receipt-reconciled', reconciled)
  request.mockResolvedValue({ status, turnId: 'containing-turn' })
  await act(async () => { await Promise.all([
    f.send.result.current.refreshQueuedDelivery(message.id),
    f.send.result.current.refreshQueuedDelivery(message.id),
  ]) })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith('runtime.input.delivery', expect.objectContaining({ clientMessageId: message.id, deliveryMode: 'guidance' }))
  if (status === 'applied') expect(f.rows()).toEqual([])
  else expect(f.rows()[0]).toMatchObject({ status: 'running', turnId: 'containing-turn', deliveryMode: undefined })
  expect(f.context.pendingAppliedGuidancesRef.current.has(message.id)).toBe(false)
  expect(reconciled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: { taskId: address.taskId, deviceId: address.deviceId } }))
  window.removeEventListener('kcoder:turn-receipt-reconciled', reconciled)
})

test('resume only unpauses; unresolved predecessors remain with the central dispatcher', () => {
  const sendQueuedMessage = vi.fn()
  const setQueuedMessagesPaused = vi.fn()
  const send = vi.fn(async () => {})
  const context = { queuedMessages: [{ ...message, status: 'unknown' }, { ...message, id: 'next', status: 'queued' }],
    setQueuedMessagesPaused, sendQueuedMessage, send, input: '', setQueuedMessages: vi.fn(),
    currentRuntimeTask: address, currentRuntimeTaskRef: { current: address }, accountScopeInvalidatedRef: { current: false },
  }
  const hook = renderHook(() => usePaneQueueControls(context as unknown as Parameters<typeof usePaneQueueControls>[0]))
  act(() => hook.result.current.resumeQueuedMessages())
  expect(setQueuedMessagesPaused).toHaveBeenCalledWith(false)
  expect(sendQueuedMessage).not.toHaveBeenCalled()
  hook.unmount()
})

test('accepted or unknown steering cannot enter a fictitious cancellation state', () => {
  for (const status of ['accepted', 'unknown'] as const) {
    const f = setup([{ ...message, status, deliveryMode: 'guidance' }])
    act(() => f.controls.result.current.cancelQueuedMessage(message.id))
    expect(f.rows()[0].cancelRequested).not.toBe(true)
    expect(request).not.toHaveBeenCalled()
    f.send.unmount(); f.controls.unmount()
  }
})

test('resume with new input never rewrites or replays an in-flight guidance identity', async () => {
  const sendQueuedMessage = vi.fn()
  const send = vi.fn(async () => {})
  const context = { queuedMessages: [{ ...message, status: 'sending', notice: '正在引导当前对话' }],
    setQueuedMessagesPaused: vi.fn(), sendQueuedMessage, send, input: '', setQueuedMessages: vi.fn(),
    currentRuntimeTask: address, currentRuntimeTaskRef: { current: address }, accountScopeInvalidatedRef: { current: false },
  }
  const hook = renderHook(() => usePaneQueueControls(context as unknown as Parameters<typeof usePaneQueueControls>[0]))
  await act(async () => { await hook.result.current.resumeQueuedMessagesWithInput('new input') })
  expect(send).toHaveBeenCalledWith('new input', undefined)
  expect(sendQueuedMessage).not.toHaveBeenCalled()
  hook.unmount()
})
