import '@/i18n'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RequestUserInputCard, type RequestUserInputPayload } from '@/components/chat/RequestUserInputCard'
import {
  createRequestUserInputAliasTracker,
  isHiddenRequestUserInputBlock,
} from '@/components/chat/requestUserInputMessages'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'
import { forwardServerRequest, respondToTaskQuestion } from '@/kcoder/gateway/runtime/interactions'
import { usePaneInteractions } from './usePaneInteractions'

vi.mock('@/kcoder/gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

async function fixture() {
  const taskId = 'task', threadId = 'parent', turnId = 'current-turn'
  const client = { supportsExperimental: () => true, respond: vi.fn() }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[taskId, { taskId, serverId: 'target', threadId }]]),
    clientByTask: new Map([[taskId, client]]), threadByTask: new Map([[taskId, threadId]]),
    taskByThread: new Map([[`target\0${threadId}`, taskId]]),
    threadKey: (serverId: string, id: string) => `${serverId}\0${id}`,
    turnAttemptIds: new Map(), pendingQuestionByKey: new Map(),
  } as unknown as GatewayRuntimeCore
  await forwardServerRequest.call(runtime, client as never, {
    id: 7, method: 'question/request', params: {
      threadId, turnId, questionId: 'question', appServerEpoch: 'current-epoch',
      sourceAgent: { parentSessionId: threadId, agentId: 'child' },
      questions: [{ id: 'choice', prompt: 'Continue?', options: [] }],
    },
  }, 'target')
  const pending = runtime.pendingQuestionByKey.get(`${taskId}\0${7}`)!
  expect(pending).toBeDefined()
  const payload = pending.renderPayload as unknown as RequestUserInputPayload
  const tracker = createRequestUserInputAliasTracker()
  tracker.previousPayloads = [payload]
  let answered = new Set<string>()
  const context = {
    accountScopeInvalidatedRef: { current: false },
    currentRuntimeTask: { runtime: 'kcoder', deviceId: 'target', taskId, threadId },
    projectChat: { setSelectedModelOption: vi.fn() },
    sendRuntimePaneMessage: vi.fn(async ({ requestUserInputResponse }) => {
      const result = await respondToTaskQuestion.call(runtime, taskId, requestUserInputResponse)
      return result.accepted === true
    }),
    editLastUserMessage: vi.fn(), cancelRuntimePaneTask: vi.fn(), setError: vi.fn(),
    requestUserInputAliasTrackerRef: { current: tracker },
    updateAnsweredRequestUserInputIds: (update: (value: Set<string>) => Set<string>) => { answered = update(answered) },
    messagesRef: { current: [] }, dispatchMessages: vi.fn(), paneStatus: { isBusy: true },
    getRuntimeModelFields: vi.fn(), applyLocalRequestUserInputResponse: vi.fn(),
  }
  const hook = renderHook(() => usePaneInteractions(context as unknown as Parameters<typeof usePaneInteractions>[0]))
  return { ...hook, payload, pending, client, context, tracker, answered: () => answered }
}

for (const field of ['threadId', 'turnId', 'appServerEpoch'] as const) {
  test(`ignoring a retained child question cannot consume a reused ID with another ${field}`, async () => {
    const f = await fixture()
    try {
      const stale = { ...f.payload, [field]: 'previous' }
      let ignored: unknown
      const view = render(<RequestUserInputCard payload={stale} onIgnore={() => {
        ignored = f.result.current.ignoreRequestUserInput(stale)
      }} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('request-user-input-ignore-button'))
        await ignored
      })
      expect.soft(f.client.respond).not.toHaveBeenCalled()
      expect.soft(f.pending.responsePending).toBeUndefined()
      expect.soft(f.pending.submittedResponse).toBeUndefined()
      expect.soft(f.answered().size).toBe(0)
      expect(f.context.cancelRuntimePaneTask).not.toHaveBeenCalled()

      // The current card remains answerable explicitly, without replaying the stale ignore.
      view.rerender(<RequestUserInputCard payload={f.payload} onIgnore={() => {
        ignored = f.result.current.ignoreRequestUserInput(f.payload)
      }} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('request-user-input-ignore-button'))
        await ignored
      })
      expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(7, {
        threadId: 'parent', turnId: 'current-turn', questionId: 'question',
        appServerEpoch: 'current-epoch', answers: {}, annotations: { ignored: true },
      })
      const block = { id: 'current', type: 'tool' as const, toolName: 'AskUserQuestion',
        status: 'pending' as const, renderPayload: f.payload }
      expect(isHiddenRequestUserInputBlock(block, f.answered())).toBe(true)
      expect(isHiddenRequestUserInputBlock({ ...block, renderPayload: stale }, f.answered())).toBe(false)
    } finally { f.unmount() }
  })

  test(`a current child ignore settles locally when terminal history reuses IDs with an old ${field}`, async () => {
    const f = await fixture()
    try {
      f.tracker.previousPayloads = [{ ...f.payload, [field]: 'previous', resolved: true }, f.payload]
      await act(async () => { await f.result.current.ignoreRequestUserInput(f.payload) })
      expect(f.client.respond).toHaveBeenCalledOnce()
      const block = { id: 'current', type: 'tool' as const, toolName: 'AskUserQuestion',
        status: 'pending' as const, renderPayload: f.payload }
      expect(isHiddenRequestUserInputBlock(block, f.answered())).toBe(true)
      expect(isHiddenRequestUserInputBlock({ ...block,
        renderPayload: { ...f.payload, [field]: 'previous' } }, f.answered())).toBe(false)
      expect(f.context.applyLocalRequestUserInputResponse).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'parent', turnId: 'current-turn', appServerEpoch: 'current-epoch',
      }))
      expect(f.context.cancelRuntimePaneTask).not.toHaveBeenCalled()
    } finally { f.unmount() }
  })
}
