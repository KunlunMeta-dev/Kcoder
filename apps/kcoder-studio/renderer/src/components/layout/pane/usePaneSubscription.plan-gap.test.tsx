import { act, render, renderHook, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ComposerStatusRegion } from '@/components/chat/composer/ComposerStatusRegion'
import { TaskPlanProgress } from '@/components/chat/composer/TaskPlanProgress'
import type { RuntimePlanEventPayload, RuntimeTaskAddress } from '@/types/api'
import {
  createResponseApiStreamState,
  emitResponseApiEvent,
  getCachedRuntimeTaskPlan,
} from '@/stream/responseApiStream'
import { usePaneSubscription } from './usePaneSubscription'
import type { usePaneRestore } from './usePaneRestore'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === 'workbench.task_plan_last_known' ? 'Last known plan · awaiting sync' : key,
  }),
}))

test('a stream gap marks only the cached unfinished plan as stale', async () => {
  const address: RuntimeTaskAddress = {
    deviceId: 'plan-gap-device',
    taskId: 'plan-gap-task',
    runtimeHandle: { threadId: 'plan-gap-thread' },
  }
  emitResponseApiEvent(
    {},
    'runtime.plan.updated',
    {
      deviceId: address.deviceId,
      taskId: address.taskId,
      data: {
        threadId: 'plan-gap-thread',
        turnId: 'plan-gap-turn',
        plan: [
          { step: 'Finish implementation', status: 'inProgress' },
          { step: 'Verify changes', status: 'pending' },
        ],
      },
    },
    createResponseApiStreamState()
  )

  let handlers!: {
    onStreamGap: () => void
    onRuntimePlanUpdated?: (payload: RuntimePlanEventPayload) => void
  }
  const setTaskPlanStale = vi.fn()
  const target = {
    identityKey: 'plan-gap-device:plan-gap-task',
    key: 'plan-gap-device:plan-gap-task',
    address,
  }
  const context = {
    runtimeTaskLoadTargetRef: { current: target },
    subscribeRuntimeTaskStreamRef: {
      current: vi.fn((_address: unknown, value: typeof handlers) => {
        handlers = value
        return vi.fn()
      }),
    },
    getRuntimeGoalRef: { current: vi.fn(async () => ({ accepted: true, goal: null })) },
    goalRevisionRef: { current: 0 },
    commitThreadGoal: vi.fn(),
    lifecycleStore: { goalStatusReceived: vi.fn() },
    refreshWorkListsRef: { current: vi.fn().mockResolvedValue(undefined) },
    setPendingGoalState: vi.fn(),
    transcriptGapGenerationRef: { current: 0 },
    forceAuthoritativeTranscriptRef: { current: false },
    rebuildingTranscriptRef: { current: false },
    showLiveDuringTranscriptLoadRef: { current: false },
    rebuildingTranscriptIdentityRef: { current: null },
    bufferedTranscriptActionsRef: { current: [] },
    loadedRuntimeTranscriptKeyRef: { current: null },
    setReceiptTranscriptRevision: vi.fn(),
    setQueuedMessages: vi.fn(),
    setError: vi.fn(),
    transcriptPageGateRef: { current: {} },
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
    setTaskPlanStale,
    pendingAppliedGuidancesRef: { current: new Map() },
    interruptedGuidanceIdsRef: { current: new Set() },
    loadRuntimeTranscriptForPaneRef: { current: vi.fn() },
    messagesRef: { current: [] },
    dispatchMessages: vi.fn(),
    lastSubmittedRetryMessageRef: { current: null },
    retrySourceBySubtaskIdRef: { current: new Map() },
    runtimeTaskStreamTargetKey: target.key,
    appendGuidanceLocalUserMessage: vi.fn(),
  } as unknown as ReturnType<typeof usePaneRestore>

  const view = renderHook(() => usePaneSubscription(context))
  expect(getCachedRuntimeTaskPlan(address)).not.toHaveProperty('stale')

  act(() => handlers.onStreamGap())

  expect(getCachedRuntimeTaskPlan(address)).toMatchObject({ stale: true })
  const cachedPlan = getCachedRuntimeTaskPlan(address)
  expect(cachedPlan).not.toBeNull()
  render(
    <ComposerStatusRegion>
      <TaskPlanProgress plan={cachedPlan} stale={cachedPlan?.stale} presentation="embedded" />
    </ComposerStatusRegion>
  )
  const planStatus = await screen.findByTestId('composer-status-trigger-plan')
  expect(planStatus).toHaveTextContent('Last known plan · awaiting sync')
  expect(planStatus).toHaveClass('text-warning')

  act(() => planStatus.click())
  expect(await screen.findByTestId('runtime-plan-detail')).toHaveTextContent(
    'Finish implementation'
  )

  act(() =>
    emitResponseApiEvent(
      { onRuntimePlanUpdated: handlers.onRuntimePlanUpdated },
      'runtime.plan.updated',
      {
        deviceId: address.deviceId,
        taskId: address.taskId,
        data: { plan: [{ step: 'Finish', status: 'inProgress' }] },
      },
      createResponseApiStreamState()
    )
  )
  expect(getCachedRuntimeTaskPlan(address)).not.toHaveProperty('stale')
  expect(setTaskPlanStale).toHaveBeenLastCalledWith(false)

  context.runtimeTaskLoadTargetRef.current = { ...target, identityKey: 'another-task' }
  act(() => handlers.onStreamGap())
  expect(getCachedRuntimeTaskPlan(address)).not.toHaveProperty('stale')
  view.unmount()
})
