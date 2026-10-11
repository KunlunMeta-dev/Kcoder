import { act, renderHook } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import type { RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import { usePaneInteractions } from './usePaneInteractions'

describe('source-bound question ignore preserves parent and other pending work', () => {
  function setup(accepted = true) {
    const source: RequestUserInputPayload = {
      requestId: 7,
      itemId: 'question-7',
      sourceAgent: {
        parentSessionId: 'parent',
        agentId: 'child',
        backgroundRun: { parentSessionId: 'parent', agentId: 'child', runId: 'actual-run' },
      },
    }
    const other: RequestUserInputPayload = { requestId: 8, itemId: 'question-8' }
    const tracker = createRequestUserInputAliasTracker()
    tracker.previousPayloads = [source, other]
    let answered = new Set<string>()
    const parent = { running: true }
    const sendRuntimePaneMessage = vi.fn().mockResolvedValue(accepted)
    const cancelRuntimePaneTask = vi.fn().mockImplementation(() => {
      parent.running = false
      return Promise.resolve(true)
    })
    const context = {
      currentRuntimeTask: { runtime: 'kcoder', deviceId: 'local', taskId: 'parent' },
      projectChat: { setSelectedModelOption: vi.fn() },
      sendRuntimePaneMessage,
      editLastUserMessage: vi.fn(),
      cancelRuntimePaneTask,
      setError: vi.fn(),
      requestUserInputAliasTrackerRef: { current: tracker },
      updateAnsweredRequestUserInputIds: (update: (value: Set<string>) => Set<string>) => {
        answered = update(answered)
      },
      messagesRef: {
        current: [{ id: 'active-parent-message', role: 'assistant', status: 'streaming' }],
      },
      dispatchMessages: vi.fn(),
      paneStatus: { isBusy: true },
      getRuntimeModelFields: vi.fn(),
      applyLocalRequestUserInputResponse: vi.fn(),
    }
    const hook = renderHook(() =>
      usePaneInteractions(context as unknown as Parameters<typeof usePaneInteractions>[0])
    )
    return {
      ...hook,
      source,
      other,
      context,
      parent,
      answered: () => answered,
      sendRuntimePaneMessage,
      cancelRuntimePaneTask,
    }
  }
  test('ignores only the exact source request with an empty real response, without cancelling a run', async () => {
    const value = setup()
    await act(async () => {
      await value.result.current.ignoreRequestUserInput(value.source)
    })
    expect(value.cancelRuntimePaneTask).not.toHaveBeenCalled()
    expect(value.parent.running).toBe(true)
    expect(value.context.dispatchMessages).not.toHaveBeenCalled()
    expect(value.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestUserInputResponse: {
          requestId: 7,
          itemId: 'question-7',
          sourceAgent: value.source.sourceAgent,
          answers: {},
          annotations: { ignored: true },
        },
      })
    )
    expect(value.answered().has('request:7')).toBe(true)
    expect(value.answered().has('request:8')).toBe(false)
    expect(value.answered().has('item:question-8')).toBe(false)
  })
  test('failed source response keeps the question pending and still cannot cancel the parent', async () => {
    const value = setup(false)
    await act(async () => {
      await value.result.current.ignoreRequestUserInput(value.source)
    })
    expect(value.cancelRuntimePaneTask).not.toHaveBeenCalled()
    expect(value.answered().size).toBe(0)
    expect(value.parent.running).toBe(true)
  })
  test('ordinary parent ignore keeps its existing cancellation behavior', async () => {
    const value = setup()
    await act(async () => {
      await value.result.current.ignoreRequestUserInput(value.other)
    })
    expect(value.cancelRuntimePaneTask).toHaveBeenCalledOnce()
    expect(value.sendRuntimePaneMessage).not.toHaveBeenCalled()
  })
})
