import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { reduceWorkbenchMessages } from '@wegent/chat-core'
import type { WorkbenchMessage, RuntimePaneQueuedMessage } from '@/types/workbench'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
import { useWorkbenchRuntimeMessaging } from '@/features/workbench/useWorkbenchRuntimeMessaging'
import { isPendingInput } from '@/features/workbench/inputDelivery'
import {
  cacheRuntimeConversationQueuedMessagesByKey,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationQueuedMessagesByKey,
  runtimeConversationKey,
} from '@/features/workbench/runtimeConversationCache'
import { usePaneSend } from './usePaneSend'

const receipt = vi.hoisted(() => vi.fn())
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: receipt }))

afterEach(() => {
  clearRuntimeConversationCacheForTests()
  vi.clearAllMocks()
})

const address = { deviceId: 'interrupt-test', taskId: 'task', threadId: 'thread' }
const input: RuntimePaneQueuedMessage = {
  id: 'replacement', content: 'Stop compiling', status: 'queued',
  createdAt: '2026-11-13T00:00:00Z', ownerKey: runtimeConversationKey(address),
}

function fixture() {
  const interrupt = vi.fn()
  const lifecycleStore = { sendRequested: vi.fn(), sendAccepted: vi.fn(), sendRejected: vi.fn() }
  const messaging = renderHook(() => useWorkbenchRuntimeMessaging({
    state: {}, services: {}, runtimeTasks: {},
    attachmentSelection: { attachments: [] }, modelSelection: {}, skillSelection: { selectedSkills: [] },
    executorClient: { runtime: { interruptAndSendRuntimeMessage: interrupt } },
    lifecycleStore, refreshWorkLists: async () => {},
  } as unknown as Parameters<typeof useWorkbenchRuntimeMessaging>[0]))
  const key = runtimeConversationKey(address)
  let messages: WorkbenchMessage[] = []
  cacheRuntimeConversationQueuedMessagesByKey(key, [])
  const context = {
    currentRuntimeTask: address,
    accountScopeInvalidatedRef: { current: false },
    interruptAndSendInFlightRef: { current: false },
    pendingAppliedGuidancesRef: { current: new Map() },
    interruptedGuidanceIdsRef: { current: new Set() },
    setQueuedMessages: (update: (rows: RuntimePaneQueuedMessage[]) => RuntimePaneQueuedMessage[]) =>
      cacheRuntimeConversationQueuedMessagesByKey(key, update(getRuntimeConversationQueuedMessagesByKey(key))),
    setMessages: (update: (rows: WorkbenchMessage[]) => WorkbenchMessage[]) => { messages = update(messages) },
    dispatchMessages: (action: Parameters<typeof reduceWorkbenchMessages>[1]) => {
      messages = reduceWorkbenchMessages(messages, action) as WorkbenchMessage[]
    },
    setError: vi.fn(),
    interruptAndSendRuntimePaneMessage: messaging.result.current.interruptAndSendRuntimePaneMessage,
  }
  const sending = renderHook(() => usePaneSend(context as unknown as Parameters<typeof usePaneSend>[0]))
  return { interrupt, context, sending, messages: () => messages,
    rows: () => getRuntimeConversationQueuedMessagesByKey(key) }
}

test('a stop timeout removes unsent optimistic input, then retry and its echo show only one user message', async () => {
  const f = fixture()
  f.interrupt.mockResolvedValueOnce({ accepted: false, taskId: address.taskId,
    error: '等待 KCoder app-server 中断任务超时' })
  await act(async () => {
    expect(await f.sending.result.current.interruptAndSendQueuedMessage(input)).toBe(false)
  })
  expect(f.messages()).toEqual([])
  expect(f.rows()).toMatchObject([{ id: input.id, status: 'failed' }])
  expect(receipt).not.toHaveBeenCalled()

  // Retrying uses the same request identity. A committed echo merges with the
  // optimistic input, while the execution receipt removes it from the queue.
  f.interrupt.mockImplementationOnce(async () => {
    f.context.dispatchMessages({ type: 'user_added', message: {
      id: input.id, role: 'user', content: input.content, status: 'done',
      createdAt: input.createdAt, taskId: address.taskId, turnId: 'replacement-turn',
    } })
    return { accepted: true, taskId: address.taskId }
  })
  receipt.mockResolvedValue({ status: 'running', turnId: 'replacement-turn' })
  await act(async () => {
    expect(await f.sending.result.current.interruptAndSendQueuedMessage(input)).toBe(true)
  })
  expect(f.context.setError).toHaveBeenLastCalledWith(null)
  expect(f.messages()).toHaveLength(1)
  expect(f.messages()[0]).toMatchObject({ id: input.id, content: input.content })
  expect(f.rows().filter(isPendingInput)).toEqual([])
  expect(f.interrupt.mock.calls.map(([request]) => request.clientMessageId)).toEqual([input.id, input.id])
})

test('a lost post-dispatch acknowledgement stays unknown and is reconciled without resending', async () => {
  const f = fixture()
  f.interrupt.mockRejectedValue(new GatewayRpcError('connection lost', -1, undefined, 'runtime-session', 'connection'))
  receipt.mockResolvedValue({ status: 'unknown' })
  await act(async () => { await f.sending.result.current.interruptAndSendQueuedMessage(input) })
  expect(f.messages()).toHaveLength(1)
  expect(f.rows()).toMatchObject([{ id: input.id, status: 'unknown' }])
  receipt.mockResolvedValue({ status: 'completed', turnId: 'replacement-turn' })
  await act(async () => { await f.sending.result.current.refreshQueuedDelivery(input.id) })
  expect(f.rows()).toEqual([])
  expect(f.interrupt).toHaveBeenCalledOnce()
})
