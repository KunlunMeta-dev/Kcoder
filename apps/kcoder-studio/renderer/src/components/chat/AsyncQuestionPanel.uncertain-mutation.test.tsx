import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: async () => () => undefined,
}))
const address = { taskId: 'task', deviceId: 'server', threadId: 'thread' }
const question: AsyncQuestionRecord = {
  questionId: 'question', requestId: 'request', threadId: address.threadId,
  sourceTurnId: 'turn', toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
  questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
}
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { bridge.request.mockReset() })

for (const saved of [false, true]) {
  it.each(['lost receipt', 'invalid receipt'])(
    `${saved ? 'saved delivery' : 'new answer'} waits for original-task readback after %s`,
    async failure => {
      const user = userEvent.setup()
      const original: AsyncQuestionRecord = saved ? { ...question, status: 'queued',
        answer: { submissionId: 'saved-submission', acceptedAtMs: 2,
          answers: { item: { text: 'Original answer' } } } } : question
      const list = { threadId: address.threadId, questions: [original] }
      let finish!: (value: typeof list) => void
      let reads = 0
      let answers = 0
      bridge.request.mockImplementation(async (command, params) => {
        if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
        if (params.method === 'asyncQuestion/list') {
          if (++reads === 1) return list
          return new Promise(resolve => { finish = resolve })
        }
        if (params.method === 'asyncQuestion/answer') {
          answers++
          if (failure === 'lost receipt') throw new Error('Original outcome unknown')
          return { threadId: 'another-task' }
        }
        throw new Error('Unexpected question operation')
      })
      render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
      await user.click(await screen.findByTestId('async-question-toggle'))
      if (!saved) await user.type(screen.getByTestId('request-user-input-custom-item'), 'Original answer')
      const action = screen.getByTestId(saved ? 'async-question-continue-delivery-question'
        : 'request-user-input-submit-button')
      try {
        await user.click(action)
        await screen.findByTestId('async-question-submit-error')
        expect(reads).toBe(2)
        expect(action).toBeDisabled()
        expect(screen.getByTestId('composer')).toBeEnabled()
        if (!saved) expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Original answer')
        await user.click(action)
        expect(answers).toBe(1)
      } finally {
        await act(async () => { finish?.(list) })
      }
      // Unchanged authoritative readback allows an explicit action, while the
      // original uncertain receipt remains visible and is never auto-replayed.
      await waitFor(() => expect(action).toBeEnabled())
      expect(screen.getByTestId('async-question-submit-error')).toBeInTheDocument()
      expect(answers).toBe(1)
    },
  )
}
