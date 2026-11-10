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

it.each(['unsupported', 'failed', 'supported'] as const)(
  'a question notification cannot supersede a pending recovered capability read (%s)', async outcome => {
    let recovering = false
    let finish!: () => void
    bridge.request.mockImplementation(async (command, params) => {
      if (command === 'runtime.asyncQuestion.supports') {
        if (!recovering) return { supported: true, threadId: address.threadId }
        return new Promise((resolve, reject) => {
          finish = () => outcome === 'failed' ? reject(new Error('capability unavailable'))
            : resolve({ supported: outcome === 'supported', threadId: address.threadId })
        })
      }
      expect(params.method).toBe('asyncQuestion/list')
      return { threadId: address.threadId, questions: [question] }
    })
    const user = userEvent.setup()
    render(<AsyncQuestionPanel address={address} />)
    await user.click(await screen.findByTestId('async-question-toggle'))
    const draft = screen.getByTestId('request-user-input-custom-item')
    await user.type(draft, 'Keep my draft')
    const reads = () => bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/list').length
    const initialReads = reads()
    recovering = true
    await act(async () => {
      for (const listener of bridge.listeners) listener({ event: 'async-question:refresh', payload: {
        taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
        workspacePath: address.workspacePath,
      } })
    })
    expect(finish).toBeTypeOf('function')
    await act(async () => {
      for (const listener of bridge.listeners) listener({ event: 'async-question:changed', payload: {
        taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
        questionId: question.questionId, revision: 2,
      } })
    })
    // Do not let a change start a list read and steal the capability response's
    // sequence. The result still owns unsupported/error recovery for this task.
    await act(async () => finish())
    if (outcome === 'unsupported') {
      await waitFor(() => expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument())
    } else if (outcome === 'failed') {
      await waitFor(() => expect(screen.getByTestId('async-question-retry')).toBeEnabled())
    } else {
      await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
    }
    expect(reads()).toBe(initialReads + (outcome === 'supported' ? 1 : 0))
    if (outcome !== 'unsupported') {
      expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
      expect(draft).toHaveValue('Keep my draft')
    }
  }
)

it('releases an answer draft when its receipt arrives during capability recovery', async () => {
  let recovering = false
  let finishSupport!: () => void
  let finishAnswer!: () => void
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports') {
      if (!recovering) return { supported: true, threadId: address.threadId }
      return new Promise(resolve => {
        finishSupport = () => resolve({ supported: true, threadId: address.threadId })
      })
    }
    if (params.method === 'asyncQuestion/answer') {
      return new Promise(resolve => {
        finishAnswer = () => resolve({ threadId: address.threadId, accepted: true, duplicate: false,
          question: { ...question, revision: 2, status: 'answer_saved', answer: {
            submissionId: params.params.submissionId, answers: params.params.answers, acceptedAtMs: 2,
          } } })
      })
    }
    return { threadId: address.threadId, questions: [question] }
  })
  const user = userEvent.setup()
  render(<AsyncQuestionPanel address={address} />)
  await user.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await user.type(draft, 'Keep my draft')
  const submit = screen.getByTestId('request-user-input-submit-button')
  await user.click(submit)
  expect(finishAnswer).toBeTypeOf('function')
  recovering = true
  await act(async () => {
    for (const listener of bridge.listeners) listener({ event: 'async-question:refresh', payload: {
      taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
      workspacePath: address.workspacePath,
    } })
  })
  // The old receipt is no longer authoritative for the card while the recovered
  // connection is being checked. Its completion must still release local busy state.
  await act(async () => finishAnswer())
  expect(screen.getByTestId('async-question-card-question')).toHaveAttribute('data-status', 'pending')
  expect(submit).toBeDisabled()
  await act(async () => finishSupport())
  await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
  expect(screen.getByTestId('request-user-input-custom-item')).toBe(draft)
  expect(draft).toHaveValue('Keep my draft')
  expect(submit).toBeEnabled()
  expect(draft).toBeEnabled()
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/answer')).toHaveLength(1)
})
