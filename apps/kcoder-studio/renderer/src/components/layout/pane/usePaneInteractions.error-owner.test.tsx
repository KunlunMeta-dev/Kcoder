import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { createRequestUserInputAliasTracker } from '@/components/chat/requestUserInputMessages'
import { usePaneInteractions } from './usePaneInteractions'

const payload = { requestId: 41, itemId: 'question-41', threadId: 'thread-a', turnId: 'turn-a' }
const response = { ...payload, answers: { choice: { answers: ['Continue'] } } }

for (const operation of ['answer', 'ignore', 'child-ignore'] as const) {
  it.each(['current', 'switch', 'revisit', 'unmount'] as const)(
    `${operation}: a delayed failure belongs only to its original pane visit (%s)`,
    async lifetime => {
      let finish!: () => void
      const failure = new Promise<void>(resolve => { finish = resolve })
      const fail = vi.fn(async (_request: unknown, options: { onError: (error: string) => void }) => {
        await failure
        options.onError('Original question transport failed')
        return false
      })
      const context = {
        accountScopeInvalidatedRef: { current: false },
        currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId: 'task-a', threadId: 'thread-a' },
        projectChat: { setSelectedModelOption: vi.fn() },
        sendRuntimePaneMessage: fail, cancelRuntimePaneTask: fail, editLastUserMessage: vi.fn(),
        setError: vi.fn(), requestUserInputAliasTrackerRef: { current: createRequestUserInputAliasTracker() },
        updateAnsweredRequestUserInputIds: vi.fn(), messagesRef: { current: [] },
        dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
        getRuntimeModelFields: vi.fn(), applyLocalRequestUserInputResponse: vi.fn(),
      }
      const hook = renderHook(({ taskId }) => usePaneInteractions({
        ...context, currentRuntimeTask: { ...context.currentRuntimeTask, taskId },
      } as unknown as Parameters<typeof usePaneInteractions>[0]), { initialProps: { taskId: 'task-a' } })
      let pending!: Promise<unknown>
      act(() => {
        pending = operation === 'answer'
          ? hook.result.current.sendRequestUserInputResponse(response)
          : hook.result.current.ignoreRequestUserInput({ ...payload,
              ...(operation === 'child-ignore' ? { sourceAgent: { parentSessionId: 'parent', agentId: 'child' } } : {}),
            })
      })
      if (lifetime === 'switch' || lifetime === 'revisit') hook.rerender({ taskId: 'task-b' })
      if (lifetime === 'revisit') hook.rerender({ taskId: 'task-a' })
      if (lifetime === 'unmount') hook.unmount()
      // Ordinary rerenders of the same owner must still show genuine failures.
      if (lifetime === 'current') hook.rerender({ taskId: 'task-a' })
      await act(async () => { finish(); await pending })
      if (lifetime === 'current')
        expect(context.setError).toHaveBeenCalledExactlyOnceWith('Original question transport failed')
      else expect(context.setError).not.toHaveBeenCalled()
      expect(fail).toHaveBeenCalledOnce()
      expect(context.applyLocalRequestUserInputResponse).not.toHaveBeenCalled()
      expect(context.updateAnsweredRequestUserInputIds).not.toHaveBeenCalled()
      hook.unmount()
    }
  )
}
