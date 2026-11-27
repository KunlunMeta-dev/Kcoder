import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { LocalExecutorEvent } from '@/host/localExecutor'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn(),
  listeners: new Set<(event: LocalExecutorEvent) => void>(),
  press: undefined as undefined | (() => void) }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: async (listener: (event: LocalExecutorEvent) => void) => {
    bridge.listeners.add(listener)
    return () => { bridge.listeners.delete(listener) }
  },
}))
// Retain the actual button callback to model a press queued before recovery.
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const original = await importOriginal<typeof import('react/jsx-dev-runtime')>()
  return { ...original, jsxDEV: (...args: Parameters<typeof original.jsxDEV>) => {
    const props = args[1] as Record<string, unknown>
    if (props?.['data-testid'] === 'async-question-continue-delivery-question')
      bridge.press = props.onClick as () => void
    return original.jsxDEV(...args)
  } }
})

const address = { taskId: 'task', deviceId: 'server', threadId: 'thread', workspacePath: '/workspace' }
const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: address.threadId,
  sourceTurnId: 'source', toolCallId: 'tool', revision: 2, createdAtMs: 1, status: 'queued',
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
  answer: { submissionId: 'saved', acceptedAtMs: 2, answers: { item: { text: 'Original answer' } } },
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset(); bridge.listeners.clear(); bridge.press = undefined })

it.each(['reconnect', 'task revisit', 'peer completion', 'read failure'] as const)(
  'a queued delivery press cannot outlive %s', async transition => {
    let current = question
    let readFails = false
    bridge.request.mockImplementation(async (command, params) => {
      if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
      if (params.method === 'asyncQuestion/list') {
        if (readFails) throw new Error('Controlled list read failure')
        return { threadId: address.threadId, questions: [current] }
      }
      expect(params.method).toBe('asyncQuestion/answer')
      return { threadId: address.threadId, question: current, accepted: true, duplicate: true }
    })
    const view = render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
    await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
    const queued = bridge.press!
    expect(queued).toBeTypeOf('function')
    if (transition === 'task revisit') {
      view.rerender(<><AsyncQuestionPanel address={address} pendingCreation /><input data-testid="composer" /></>)
      view.rerender(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
    } else {
      if (transition === 'peer completion') current = { ...question, revision: 3, status: 'context_applied' }
      readFails = transition === 'read failure'
      await act(async () => {
        for (const listener of bridge.listeners) listener({
          event: readFails ? 'async-question:changed' : 'async-question:refresh', payload: {
          taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
          workspacePath: address.workspacePath,
        } })
      })
    }
    if (transition === 'peer completion')
      await waitFor(() => expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument())
    else await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
    await act(async () => queued())
    expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(0)
    expect(screen.getByTestId('composer')).toBeEnabled()
    if (transition !== 'peer completion') {
      if (readFails) {
        expect(screen.getByTestId('async-question-continue-delivery-question')).toBeDisabled()
        readFails = false
        fireEvent.click(screen.getByTestId('async-question-refresh'))
        await waitFor(() => expect(screen.getByTestId('async-question-continue-delivery-question')).toBeEnabled())
      }
      await act(async () => bridge.press!())
      const answers = bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')
      expect(answers).toHaveLength(1)
      expect(answers[0][1].params).toEqual({ threadId: address.threadId, questionId: question.questionId,
        submissionId: question.answer!.submissionId, expectedRevision: question.revision,
        answers: question.answer!.answers })
    }
  },
)
