import { useLayoutEffect } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn(), submit: undefined as undefined | (() => Promise<void>) }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: async () => () => undefined,
}))
vi.mock('./RequestUserInputCard', () => ({
  RequestUserInputCard: ({ onSubmit }: { onSubmit: (response: unknown, answers: unknown) => Promise<void> }) => {
    bridge.submit = () => onSubmit({}, { item: { text: 'original draft' } })
    return <div data-testid="question-form" />
  },
}))

const address = { taskId: 'original-task', deviceId: 'server', threadId: 'original-thread' }
const question = {
  questionId: 'question', requestId: 'request', threadId: address.threadId,
  sourceTurnId: 'source', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Mode', question: 'Continue?', multiSelect: false, options: [] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  bridge.submit = undefined
  bridge.request.mockReset()
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
    if (params.method === 'asyncQuestion/answer') return new Promise(() => undefined)
    return { threadId: address.threadId, questions: [question] }
  })
})

it.each(['task-switch', 'pending-creation'] as const)(
  'a queued answer cannot use the retired task visit during %s commit', async transition => {
    let settled: Promise<unknown> | undefined
    function Host({ changed }: { changed: boolean }) {
      useLayoutEffect(() => {
        // Drain a retained callback after the new view commits, before the
        // previous visit's passive cleanup has run.
        if (changed) settled = queued().catch(error => error)
      }, [changed])
      return <><AsyncQuestionPanel
        address={changed && transition === 'task-switch'
          ? { ...address, taskId: 'new-task', threadId: 'new-thread' } : address}
        pendingCreation={changed && transition === 'pending-creation'}
      /><input data-testid="composer" /></>
    }
    const view = render(<Host changed={false} />)
    await screen.findByTestId('question-form')
    const queued = bridge.submit!
    await act(async () => { view.rerender(<Host changed />) })
    expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(0)
    expect(await settled).toBeInstanceOf(Error)
    expect(screen.getByTestId('composer')).toBeEnabled()
    if (transition === 'pending-creation') {
      await act(async () => { view.rerender(<Host changed={false} />) })
      await waitFor(() => expect(bridge.submit).not.toBe(queued))
      expect(screen.getByTestId('question-form')).toBeInTheDocument()
    }
  },
)
