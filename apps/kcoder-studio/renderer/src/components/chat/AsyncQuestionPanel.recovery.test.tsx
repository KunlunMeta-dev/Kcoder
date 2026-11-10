import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const executor = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: executor.request,
  subscribeLocalExecutorEvents: executor.subscribe,
}))
const address = { taskId: 'kcoder:server:thread', deviceId: 'server', threadId: 'thread' }
const original: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: 'thread', sourceTurnId: 'turn',
  toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Decision', question: 'Choose', multiSelect: false,
    options: [{ id: 'option', label: 'Option', description: 'First option' }] }],
}

describe('AsyncQuestionPanel recovery submission ownership', () => {
  beforeAll(async () => {
    await createInstance().use(initReactI18next).init({
      lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
    })
  })
  beforeEach(() => {
    vi.resetAllMocks()
    executor.subscribe.mockResolvedValue(vi.fn())
  })

  for (const mode of ['answer', 'saved delivery'] as const) {
    it.each(['rejected', 'accepted'] as const)(`${mode}: recovery releases a hung old request and fences its late %s receipt`, async outcome => {
      const user = userEvent.setup()
      const record = mode === 'answer' ? original : { ...original, status: 'answer_saved', answer: {
        submissionId: 'saved', acceptedAtMs: 2, answers: { item: { selectedOptionIds: ['option'] } },
      } } as AsyncQuestionRecord
      const calls: Array<{ params: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
      let holdRecoveryList = false
      let finishRecoveryList: (() => void) | undefined
      executor.request.mockImplementation((method: string, params: Record<string, unknown>) => {
        if (method === 'runtime.asyncQuestion.supports') return Promise.resolve({ supported: true, threadId: 'thread' })
        if (params.method === 'asyncQuestion/list') {
          const result = { threadId: 'thread', questions: [record] }
          if (holdRecoveryList) return new Promise(resolve => { finishRecoveryList = () => resolve(result) })
          return Promise.resolve(result)
        }
        if (params.method === 'asyncQuestion/answer') return new Promise((resolve, reject) => {
          calls.push({ params: params.params as Record<string, unknown>, resolve, reject })
        })
        throw new Error('Unexpected request')
      })
      const view = render(<AsyncQuestionPanel address={address} />)
      const action = () => screen.getByTestId(mode === 'answer'
        ? 'request-user-input-submit-button' : 'async-question-continue-delivery-question')
      try {
        await screen.findByTestId('async-question-card-question')
        await user.click(screen.getByTestId('async-question-toggle'))
        if (mode === 'answer') await user.type(screen.getByTestId('request-user-input-custom-item'), 'Keep draft')
        await user.click(action())
        expect(calls).toHaveLength(1)
        expect(action()).toBeDisabled()
        holdRecoveryList = true
        await act(async () => executor.subscribe.mock.calls[0][0]({ event: 'async-question:refresh', payload: {
          taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
        } }))
        await waitFor(() => expect(finishRecoveryList).toBeTypeOf('function'))
        expect(action()).toBeDisabled()
        await act(async () => finishRecoveryList!())
        await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
        // Readback has finished; the old transport may never settle.
        expect(action()).toBeEnabled()
        if (mode === 'answer') expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep draft')
        expect(calls).toHaveLength(1)
        await user.click(action())
        expect(calls).toHaveLength(2)
        expect(calls[1].params.submissionId).toBe(calls[0].params.submissionId)
        await act(async () => {
          if (outcome === 'rejected') calls[0].reject(new Error('Old connection closed'))
          else calls[0].resolve({ threadId: 'thread', accepted: true, duplicate: false,
            question: { ...record, status: 'context_applied', revision: 2, answer: {
              submissionId: calls[0].params.submissionId, answers: calls[0].params.answers, acceptedAtMs: 2,
            } } })
        })
        expect(action()).toBeDisabled()
        expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', record.status)
        expect(screen.queryByTestId('async-question-submit-error')).not.toBeInTheDocument()
        await user.click(action())
        expect(calls).toHaveLength(2)
        await act(async () => calls[1].resolve({ threadId: 'thread', accepted: true, duplicate: false,
          question: { ...record, status: 'context_applied', revision: 2, answer: {
            submissionId: calls[1].params.submissionId, answers: calls[1].params.answers, acceptedAtMs: 2,
          } } }))
        await waitFor(() => expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'context_applied'))
      } finally {
        view.unmount()
        await act(async () => { for (const call of calls) call.reject(new Error('Owned fixture cleanup')) })
      }
    })
  }
})
