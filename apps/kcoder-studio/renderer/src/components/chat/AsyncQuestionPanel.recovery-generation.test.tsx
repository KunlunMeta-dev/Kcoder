import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { LocalExecutorEvent } from '@/host/localExecutor'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn(), listeners: new Set<(event: LocalExecutorEvent) => void>() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: async (listener: (event: LocalExecutorEvent) => void) => {
    bridge.listeners.add(listener)
    return () => { bridge.listeners.delete(listener) }
  },
}))
const address = { taskId: 'task', deviceId: 'server', threadId: 'thread', workspacePath: '/workspace' }
const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: address.threadId,
  sourceTurnId: 'source', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset(); bridge.listeners.clear() })

it.each((['pending', 'queued'] as const).flatMap(status =>
  (['accepted', 'winner', 'error'] as const).map(outcome => ({ status, outcome }))))(
  'a recovered $status card discards a late $outcome from the previous connection', async ({ status, outcome }) => {
    let finishAnswer!: () => void
    const original: AsyncQuestionRecord = status === 'pending' ? question : {
      ...question, status, revision: 2, answer: {
        submissionId: 'saved', answers: { item: { text: 'Keep my draft' } }, acceptedAtMs: 2,
      },
    }
    bridge.request.mockImplementation(async (command, params) => {
      if (command === 'runtime.asyncQuestion.supports')
        return { supported: true, threadId: address.threadId }
      if (params.method === 'asyncQuestion/answer') return new Promise((resolve, reject) => {
        finishAnswer = () => outcome === 'error' ? reject(new Error('Old connection failed')) : resolve({ threadId: address.threadId, accepted: outcome === 'accepted', duplicate: false,
          question: { ...original, revision: original.revision + 1, status: 'context_applied', answer: {
            submissionId: outcome === 'winner' ? 'peer-submission' : params.params.submissionId,
            answers: params.params.answers, acceptedAtMs: 3,
          } } })
      })
      expect(params.method).toBe('asyncQuestion/list')
      return { threadId: address.threadId, questions: [original] }
    })
    const user = userEvent.setup()
    render(<AsyncQuestionPanel address={address} />)
    await user.click(await screen.findByTestId('async-question-toggle'))
    if (status === 'pending')
      await user.type(screen.getByTestId('request-user-input-custom-item'), 'Keep my draft')
    const action = () => screen.getByTestId(status === 'pending'
      ? 'request-user-input-submit-button' : 'async-question-continue-delivery-question')
    await user.click(action())
    expect(finishAnswer).toBeTypeOf('function')
    await act(async () => {
      for (const listener of bridge.listeners) listener({ event: 'async-question:refresh', payload: {
        taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
        workspacePath: address.workspacePath,
      } })
    })
    await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
    const reads = bridge.request.mock.calls.length
    await act(async () => finishAnswer())
    expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', status)
    expect(action()).toBeEnabled()
    if (status === 'pending')
      expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
    expect(bridge.request.mock.calls).toHaveLength(reads)
    expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
  }
)
