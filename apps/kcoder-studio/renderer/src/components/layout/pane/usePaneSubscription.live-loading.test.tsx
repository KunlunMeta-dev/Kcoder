import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { RuntimeTaskStreamHandlers } from '@/features/workbench/runtimePaneMessages'
import { usePaneSubscription } from './usePaneSubscription'
import type { usePaneRestore } from './usePaneRestore'

test('shows current live output during initial history loading, but buffers after a gap or switch', () => {
  const target = { identityKey: 'local:task', key: 'local:task', address: { deviceId: 'local', taskId: 'task' } }
  let handlers!: RuntimeTaskStreamHandlers
  const dispatchMessages = vi.fn()
  const context = {
    runtimeTaskLoadTargetRef: { current: target },
    subscribeRuntimeTaskStreamRef: { current: (_address: unknown, value: RuntimeTaskStreamHandlers) => { handlers = value; return vi.fn() } },
    rebuildingTranscriptRef: { current: true },
    showLiveDuringTranscriptLoadRef: { current: true },
    rebuildingTranscriptIdentityRef: { current: target.identityKey },
    bufferedTranscriptActionsRef: { current: [] },
    transcriptGapGenerationRef: { current: 0 },
    forceAuthoritativeTranscriptRef: { current: false },
    loadedRuntimeTranscriptKeyRef: { current: 'old' },
    setReceiptTranscriptRevision: vi.fn(), dispatchMessages,
  } as unknown as ReturnType<typeof usePaneRestore>
  const view = renderHook(() => usePaneSubscription(context))
  const first = { type: 'assistant_chunk' as const, subtaskId: 'turn-1', content: 'first' }
  act(() => handlers.onMessageAction(first))
  expect(dispatchMessages).toHaveBeenCalledWith(first)
  expect(context.bufferedTranscriptActionsRef.current).toEqual([first])
  act(() => handlers.onStreamGap?.())
  const afterGap = { type: 'assistant_chunk' as const, subtaskId: 'turn-1', content: 'after gap' }
  act(() => handlers.onMessageAction(afterGap))
  expect(dispatchMessages).not.toHaveBeenCalledWith(afterGap)
  expect(context.bufferedTranscriptActionsRef.current).toEqual([afterGap])
  context.runtimeTaskLoadTargetRef.current = { ...target, identityKey: 'other' }
  act(() => handlers.onMessageAction({ ...first, content: 'stale' }))
  expect(context.bufferedTranscriptActionsRef.current).toEqual([afterGap])
  view.unmount()
})
