import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import { usePaneQueueDispatch } from './usePaneQueueDispatch'
import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle/RuntimeTaskLifecycleStore'

function fixture(status = 'sending', turnId?: string) {
  return {
    currentRuntimeTask: { deviceId: 'owned-target', taskId: 'kcoder:owned-target:thread', threadId: 'thread' },
    queuedMessages: [{ id: 'original-cid', content: 'Original continuation', status, turnId, directSubmission: true }],
    queuedMessagesPaused: false,
    setQueuedMessages: vi.fn(), setError: vi.fn(),
    paneStatus: { isBusy: true, canSendQueuedMessage: false },
    queuedMessageSendInFlightIdsRef: { current: new Set(['original-cid']) },
    pendingAppliedGuidancesRef: { current: new Map() },
    refreshQueuedDelivery: vi.fn(async () => {}),
  }
}

test('receipt polling waits for the original send to settle instead of manufacturing an unknown result', () => {
  const context = fixture()
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  expect(context.refreshQueuedDelivery).not.toHaveBeenCalled()
  context.queuedMessageSendInFlightIdsRef.current.delete('original-cid')
  context.queuedMessages = [{ ...context.queuedMessages[0], status: 'accepted' }]
  hook.rerender()
  expect(context.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith('original-cid', 'pending')
  hook.unmount()
})

test('a genuinely unknown original submission is still reconciled after remount', () => {
  const context = fixture('unknown')
  context.queuedMessageSendInFlightIdsRef.current.clear()
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  expect(context.refreshQueuedDelivery).toHaveBeenCalledWith('original-cid', 'observe')
  hook.unmount()
})

test('projecting a running receipt stops pending polling without rereading the receipt', async () => {
  vi.useFakeTimers()
  const context = fixture('unknown')
  context.queuedMessageSendInFlightIdsRef.current.clear()
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  try {
    await act(async () => {})
    expect(context.refreshQueuedDelivery).toHaveBeenCalledWith('original-cid', 'observe')
    context.refreshQueuedDelivery.mockClear()
    context.queuedMessages = [{ ...context.queuedMessages[0], status: 'running', turnId: 'original-turn' }]
    await act(async () => { hook.rerender() })
    expect(context.refreshQueuedDelivery).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(context.refreshQueuedDelivery).not.toHaveBeenCalled()
    await act(async () => { window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', {
      detail: context.currentRuntimeTask,
    })) })
    expect(context.refreshQueuedDelivery).toHaveBeenLastCalledWith('original-cid', 'reconcile')
    context.refreshQueuedDelivery.mockClear()
    context.paneStatus.isBusy = false
    await act(async () => { hook.rerender() })
    expect(context.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith('original-cid', 'observe')
  } finally { hook.unmount(); vi.useRealTimers() }
})

test('new unresolved inputs reconcile without polling an already running predecessor', async () => {
  vi.useFakeTimers()
  const context = fixture('running', 'original-turn')
  context.queuedMessageSendInFlightIdsRef.current.clear()
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  try {
    await act(async () => {})
    context.refreshQueuedDelivery.mockClear()
    context.queuedMessages = [...context.queuedMessages,
      { ...context.queuedMessages[0], id: 'unresolved-input', status: 'unknown', turnId: undefined }]
    await act(async () => { hook.rerender() })
    expect(context.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith('unresolved-input', 'pending')
    context.refreshQueuedDelivery.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(context.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith('unresolved-input', 'pending')
  } finally { hook.unmount(); vi.useRealTimers() }
})

test('a projected running turn still reconciles on attachment and replacement of its read connection', async () => {
  const initial = fixture('running', 'original-turn')
  initial.queuedMessageSendInFlightIdsRef.current.clear()
  const lifecycle = new RuntimeTaskLifecycleStore('receipt-recovery')
  lifecycle.turnStarted(initial.currentRuntimeTask, 'original-turn')
  const context = { ...initial, taskLifecycle: lifecycle.getTask(initial.currentRuntimeTask) }
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  try {
    expect(context.taskLifecycle?.derived.isBusy).toBe(true)
    expect(context.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith('original-cid', 'observe')
    await act(async () => {})
    context.refreshQueuedDelivery = vi.fn(async () => {})
    await act(async () => { hook.rerender() })
    expect(context.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith('original-cid', 'observe')
  } finally { hook.unmount() }
})

test('receipt hints do not duplicate a cancellation already owned by this observer', async () => {
  const context = { ...fixture('unknown'), queuedMessages: [
    { ...fixture('unknown').queuedMessages[0], cancelRequested: true },
  ] }
  context.queuedMessageSendInFlightIdsRef.current.clear()
  let finish!: () => void
  context.refreshQueuedDelivery.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  try {
    act(() => { window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', {
      detail: context.currentRuntimeTask,
    })) })
    expect(context.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith('original-cid', 'observe')
    await act(async () => { finish() })
  } finally { hook.unmount() }
})

test('a receipt refresh wakes only the pane for the original target and task', async () => {
  const a = fixture('unknown'), b = fixture('unknown')
  a.queuedMessageSendInFlightIdsRef.current.clear()
  b.queuedMessageSendInFlightIdsRef.current.clear()
  b.currentRuntimeTask = { ...b.currentRuntimeTask, deviceId: 'another-target' }
  const hook = renderHook(() => {
    usePaneQueueDispatch(a as unknown as Parameters<typeof usePaneQueueDispatch>[0])
    usePaneQueueDispatch(b as unknown as Parameters<typeof usePaneQueueDispatch>[0])
  })
  try {
    await act(async () => {})
    a.refreshQueuedDelivery.mockClear(); b.refreshQueuedDelivery.mockClear()
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', {
        detail: { deviceId: a.currentRuntimeTask.deviceId, taskId: a.currentRuntimeTask.taskId },
      }))
    })
    expect(a.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith('original-cid', 'reconcile')
    expect(b.refreshQueuedDelivery).not.toHaveBeenCalled()
  } finally { hook.unmount() }
})

test.each([
  { deviceId: 'owned-target', taskId: 'different-task' },
  { taskId: 'kcoder:owned-target:thread' },
  undefined,
])('unrelated or incomplete receipt identity does not trigger another read: %j', async detail => {
  const context = fixture('unknown')
  context.queuedMessageSendInFlightIdsRef.current.clear()
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  try {
    await act(async () => {})
    context.refreshQueuedDelivery.mockClear()
    await act(async () => {
      window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', { detail }))
    })
    expect(context.refreshQueuedDelivery).not.toHaveBeenCalled()
  } finally { hook.unmount() }
})

test('switching task ownership replaces the event filter and unmount removes it', async () => {
  const context = fixture('unknown')
  context.queuedMessageSendInFlightIdsRef.current.clear()
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  await act(async () => {})
  const previous = context.currentRuntimeTask
  context.currentRuntimeTask = { ...previous, taskId: 'next-task' }
  await act(async () => { hook.rerender() })
  context.refreshQueuedDelivery.mockClear()
  await act(async () => { window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', { detail: previous })) })
  expect(context.refreshQueuedDelivery).not.toHaveBeenCalled()
  await act(async () => {
    window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', { detail: context.currentRuntimeTask }))
  })
  expect(context.refreshQueuedDelivery).toHaveBeenCalledExactlyOnceWith('original-cid', 'reconcile')
  hook.unmount()
  context.refreshQueuedDelivery.mockClear()
  window.dispatchEvent(new CustomEvent('kcoder:turn-receipt-reconciled', { detail: context.currentRuntimeTask }))
  expect(context.refreshQueuedDelivery).not.toHaveBeenCalled()
})


test.each(['uncertain-reply', 'transport-error'])('unknown guidance must reconcile after %s', async mode => {
  vi.useFakeTimers()
  const context = { ...fixture('queued'),
    sendRuntimePaneGuidance: vi.fn(async () => ({ sent: false })),
    interruptedGuidanceIdsRef: { current: new Set<string>() },
    sendRuntimeMessage: vi.fn(),
  }
  context.queuedMessageSendInFlightIdsRef.current.clear()
  context.sendRuntimePaneGuidance = vi.fn(async () => {
    if (mode === 'transport-error') throw new Error('Owned transport failure')
    return { sent: false }
  })
  context.interruptedGuidanceIdsRef = { current: new Set() }
  context.sendRuntimeMessage = vi.fn()
  context.setQueuedMessages = vi.fn((update: (rows: typeof context.queuedMessages) => typeof context.queuedMessages) => { context.queuedMessages = update(context.queuedMessages) })
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  try {
    await act(async () => { await hook.result.current.sendQueuedMessageAsGuidance(context.queuedMessages[0] as RuntimePaneQueuedMessage) })
    hook.rerender()
    expect(context.queuedMessages[0].status).toBe('unknown')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(context.refreshQueuedDelivery, 'unknown guidance must not stay excluded from all receipt observations').toHaveBeenCalledWith('original-cid', 'pending')
  } finally { hook.unmount(); vi.useRealTimers() }
})

test('unpausing a restored queue preserves unknown and busy barriers before dispatching once', async () => {
  const context = { ...fixture('unknown'), queuedMessagesPaused: true,
    queuedMessages: [{ id: 'original-cid', content: 'unknown input', status: 'unknown', directSubmission: false },
      { id: 'next', content: 'next input', status: 'queued', directSubmission: false }],
    paneStatus: { isBusy: true, canSendQueuedMessage: false },
    sendRuntimeMessage: vi.fn(async () => true),
  }
  context.queuedMessageSendInFlightIdsRef.current.clear()
  const hook = renderHook(() => usePaneQueueDispatch(context as unknown as Parameters<typeof usePaneQueueDispatch>[0]))
  context.queuedMessagesPaused = false
  hook.rerender()
  expect(context.sendRuntimeMessage).not.toHaveBeenCalled()
  context.paneStatus = { isBusy: false, canSendQueuedMessage: true }
  hook.rerender()
  expect(context.sendRuntimeMessage).not.toHaveBeenCalled()
  context.queuedMessages = [context.queuedMessages[1]]
  await act(async () => hook.rerender())
  expect(context.sendRuntimeMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'next' }))
  hook.unmount()
})
