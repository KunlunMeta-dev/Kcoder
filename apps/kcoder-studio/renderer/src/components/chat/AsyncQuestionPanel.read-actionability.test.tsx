import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import type { LocalExecutorEvent } from '@/host/localExecutor'
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
  sourceTurnId: 'source', toolCallId: 'tool', revision: 1, createdAtMs: 1,
  status: 'pending', questions: [{ id: 'item', header: 'Mode', question: 'Which mode?',
    multiSelect: false, options: [{ id: 'fast', label: 'Fast', description: '' }] }],
}

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset(); bridge.listeners.clear() })

for (const saved of [false, true]) {
  it.each(['support', 'list'] as const)(
    `${saved ? 'saved delivery' : 'unsent draft'} waits for a verified %s read before acting`, async stage => {
      const record: AsyncQuestionRecord = saved ? { ...question, status: 'queued', revision: 2,
        answer: { submissionId: 'original-submission', acceptedAtMs: 2,
          answers: { item: { selectedOptionIds: ['fast'] } } } } : question
      bridge.request.mockImplementation(async (command, params) => command === 'runtime.asyncQuestion.supports'
        ? { supported: true, threadId: address.threadId }
        : params.method === 'asyncQuestion/list'
          ? { threadId: address.threadId, questions: [record] }
          : { threadId: address.threadId, question: { ...record, revision: 3, status: 'context_applied' }, accepted: true })
      render(<AsyncQuestionPanel address={address} />)
      await userEvent.click(await screen.findByTestId('async-question-toggle'))
      const card = screen.getByTestId('async-question-card-question')
      if (!saved) await userEvent.type(screen.getByTestId('request-user-input-custom-item'), 'Keep this original draft')
      const action = () => screen.getByTestId(saved
        ? 'async-question-continue-delivery-question' : 'request-user-input-submit-button')
      expect(action()).toBeEnabled()
      let fail!: (error: Error) => void
      bridge.request.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      if (stage === 'support') {
        await act(async () => {
          for (const listener of bridge.listeners) listener({ event: 'async-question:refresh', payload: {
            taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
            workspacePath: address.workspacePath,
          } })
        })
      } else fireEvent.click(screen.getByTestId('async-question-refresh'))
      await waitFor(() => expect(fail).toBeTypeOf('function'))
      if (stage === 'support') expect(action()).toBeDisabled()
      else expect(action()).toBeEnabled()
      await act(async () => fail(new Error('Original task read unavailable')))
      expect(action()).toBeDisabled()
      fireEvent.click(action())
      expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/answer')).toBe(false)
      expect(card).toBeInTheDocument()
      if (!saved) expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep this original draft')
      fireEvent.click(screen.getByTestId('async-question-retry'))
      await waitFor(() => expect(action()).toBeEnabled())
      expect(card).toBeInTheDocument()
      if (!saved) expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep this original draft')
      fireEvent.click(action())
      await waitFor(() => expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1))
    }
  )
}
