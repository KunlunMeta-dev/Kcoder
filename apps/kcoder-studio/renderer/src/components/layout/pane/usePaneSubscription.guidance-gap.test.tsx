import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import type { RuntimeTaskStreamHandlers } from '@/features/workbench/runtimePaneMessages'
import type { RuntimeGuidanceAppliedPayload, RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import { usePaneQueueDispatch } from './usePaneQueueDispatch'
import { usePaneSubscription } from './usePaneSubscription'
import type { usePaneInteractions } from './usePaneInteractions'
import type { usePaneRestore } from './usePaneRestore'

const address: RuntimeTaskAddress = {
  deviceId: 'guidance-gap-device',
  taskId: 'guidance-gap-task',
  runtimeHandle: { threadId: 'guidance-gap-thread' },
}

const guidance: RuntimePaneQueuedMessage = {
  id: 'guidance-gap-id',
  content: 'Please verify the patch',
  status: 'sending',
  notice: '正在引导当前对话',
  createdAt: '2026-11-13T00:00:00.000Z',
}

function fixture() {
  const target = {
    identityKey: `${address.deviceId}:${address.taskId}`,
    key: `${address.deviceId}:${address.taskId}`,
    address,
  }
  const runtimeTaskLoadTargetRef = { current: target }
  const pendingAppliedGuidancesRef = { current: new Map([[guidance.id, guidance]]) }
  const interruptedGuidanceIdsRef = { current: new Set<string>() }
  const queuedMessageSendInFlightIdsRef = { current: new Set<string>() }
  const sendRuntimeMessage = vi.fn(async () => true)
  const sendRuntimePaneGuidance = vi.fn(async () => ({ sent: true }))
  const refreshQueuedDelivery = vi.fn(async () => undefined)
  const appendGuidanceLocalUserMessage = vi.fn()
  const getRuntimeGoalRef = { current: vi.fn(async () => ({ accepted: true, goal: null })) }
  let handlers!: RuntimeTaskStreamHandlers

  const subscriptionContext = {
    runtimeTaskLoadTargetRef,
    subscribeRuntimeTaskStreamRef: {
      current: vi.fn((_address: RuntimeTaskAddress, value: RuntimeTaskStreamHandlers) => {
        handlers = value
        return vi.fn()
      }),
    },
    getRuntimeGoalRef,
    goalRevisionRef: { current: 0 },
    commitThreadGoal: vi.fn(),
    lifecycleStore: { goalStatusReceived: vi.fn() },
    refreshWorkListsRef: { current: vi.fn(async () => undefined) },
    pendingAppliedGuidancesRef,
    interruptedGuidanceIdsRef,
    transcriptGapGenerationRef: { current: 0 },
    forceAuthoritativeTranscriptRef: { current: false },
    rebuildingTranscriptRef: { current: false },
    showLiveDuringTranscriptLoadRef: { current: false },
    rebuildingTranscriptIdentityRef: { current: null },
    bufferedTranscriptActionsRef: { current: [] },
    loadedRuntimeTranscriptKeyRef: { current: null },
    setReceiptTranscriptRevision: vi.fn(),
    setError: vi.fn(),
    transcriptPageGateRef: { current: { invalidate: vi.fn() } },
    setTranscriptHasMoreBefore: vi.fn(),
    setTranscriptBeforeCursor: vi.fn(),
    setTranscriptLoadingMoreBefore: vi.fn(),
    setTranscriptLoadingFullContent: vi.fn(),
    setTranscriptFullContent: vi.fn(),
    setLoadedTranscriptRanges: vi.fn(),
    setTurnNavigation: vi.fn(),
    setSubagentStatuses: vi.fn(),
    setGoalContinuation: vi.fn(),
    setTaskPlan: vi.fn(),
    setTaskPlanStale: vi.fn(),
    setPendingGoalState: vi.fn(),
    loadRuntimeTranscriptForPaneRef: { current: vi.fn() },
    messagesRef: { current: [] },
    dispatchMessages: vi.fn(),
    lastSubmittedRetryMessageRef: { current: null },
    retrySourceBySubtaskIdRef: { current: new Map() },
    runtimeTaskStreamTargetKey: target.key,
    appendGuidanceLocalUserMessage,
  } as unknown as ReturnType<typeof usePaneRestore> & { setQueuedMessages?: unknown }

  const dispatchContext = {
    currentRuntimeTask: address,
    refreshQueuedDelivery,
    sendRuntimePaneGuidance,
    queuedMessagesPaused: false,
    setError: vi.fn(),
    loadRuntimeTranscriptForPaneRef: { current: vi.fn() },
    pendingAppliedGuidancesRef,
    interruptedGuidanceIdsRef,
    queuedMessageSendInFlightIdsRef,
    runtimeTaskLoadTarget: { key: target.key, address },
    messagesRef: { current: [] },
    paneStatus: { isBusy: true, canSendQueuedMessage: false },
    sendRuntimeMessage,
  } as unknown as ReturnType<typeof usePaneInteractions> & {
    queuedMessages?: RuntimePaneQueuedMessage[]
    setQueuedMessages?: unknown
  }

  const view = renderHook(() => {
    const [queuedMessages, setQueuedMessages] = useState<RuntimePaneQueuedMessage[]>([
      guidance,
      { ...guidance, id: 'unrelated-queued', status: 'queued', notice: undefined },
    ])
    Object.assign(subscriptionContext, { setQueuedMessages })
    Object.assign(dispatchContext, { queuedMessages, setQueuedMessages })
    usePaneSubscription(subscriptionContext)
    usePaneQueueDispatch(dispatchContext)
    return { queuedMessages }
  })

  return {
    ...view,
    handlers: () => handlers,
    targetRef: runtimeTaskLoadTargetRef,
    pendingAppliedGuidancesRef,
    sendRuntimeMessage,
    sendRuntimePaneGuidance,
    refreshQueuedDelivery,
    appendGuidanceLocalUserMessage,
    getRuntimeGoalRef,
  }
}

test('a stream gap exposes pending guidance as unknown without replay and late applied settles it', () => {
  const f = fixture()

  act(() => f.handlers().onStreamGap?.())

  expect(f.result.current.queuedMessages).toEqual([
    { ...guidance, status: 'unknown', notice: undefined },
    { ...guidance, id: 'unrelated-queued', status: 'queued', notice: undefined },
  ])
  expect(f.pendingAppliedGuidancesRef.current.has(guidance.id)).toBe(true)
  expect(f.sendRuntimeMessage).not.toHaveBeenCalled()
  expect(f.sendRuntimePaneGuidance).not.toHaveBeenCalled()
  expect(f.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith(guidance.id, 'pending')

  act(() => f.handlers().onGuidanceApplied?.({
    guidanceId: guidance.id,
    message: guidance.content,
    appliedAtMs: 1,
  } satisfies RuntimeGuidanceAppliedPayload))

  expect(f.pendingAppliedGuidancesRef.current.has(guidance.id)).toBe(false)
  expect(f.result.current.queuedMessages).toEqual([
    { ...guidance, id: 'unrelated-queued', status: 'queued', notice: undefined },
  ])
  expect(f.appendGuidanceLocalUserMessage).toHaveBeenCalledExactlyOnceWith(
    guidance.content,
    undefined,
    expect.objectContaining({ id: guidance.id, runtimeGuidance: true })
  )
  f.unmount()
})

test('a late stream-gap callback from another pane owner leaves guidance untouched', () => {
  const f = fixture()
  f.targetRef.current = {
    ...f.targetRef.current,
    identityKey: 'replacement-device:replacement-task',
  }

  act(() => f.handlers().onStreamGap?.())

  expect(f.result.current.queuedMessages).toEqual([
    guidance,
    { ...guidance, id: 'unrelated-queued', status: 'queued', notice: undefined },
  ])
  expect(f.pendingAppliedGuidancesRef.current.has(guidance.id)).toBe(true)
  expect(f.getRuntimeGoalRef.current).not.toHaveBeenCalled()
  expect(f.sendRuntimeMessage).not.toHaveBeenCalled()
  f.unmount()
})

test('an applied receipt identifies the exact input rather than matching its text', () => {
  const f = fixture()
  const second = { ...guidance, id: 'same-text-second' }
  f.pendingAppliedGuidancesRef.current.set(second.id, second)
  act(() => f.handlers().onGuidanceApplied?.({ guidanceId: second.id, message: guidance.content, appliedAtMs: 1 }))
  expect(f.pendingAppliedGuidancesRef.current.has(guidance.id)).toBe(true)
  expect(f.pendingAppliedGuidancesRef.current.has(second.id)).toBe(false)
  expect(f.appendGuidanceLocalUserMessage).toHaveBeenCalledWith(second.content, undefined, expect.objectContaining({ id: second.id }))
  f.unmount()
})
