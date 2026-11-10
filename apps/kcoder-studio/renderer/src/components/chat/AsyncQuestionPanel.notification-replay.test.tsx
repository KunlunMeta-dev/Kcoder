import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { asyncQuestionRevisionFingerprint } from '../../../../shared/asyncQuestionRevision'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: bridge.subscribe,
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
beforeEach(() => { bridge.request.mockReset(); bridge.subscribe.mockReset() })

async function fixture() {
  let notify!: (event: unknown) => void
  bridge.subscribe.mockImplementation(async listener => { notify = listener; return () => undefined })
  bridge.request.mockImplementation(async command => command === 'runtime.asyncQuestion.supports'
    ? { supported: true, threadId: address.threadId }
    : { threadId: address.threadId, questions: [question] })
  render(<><AsyncQuestionPanel address={address} /><input data-testid="composer" /></>)
  await userEvent.click(await screen.findByTestId('async-question-toggle'))
  await userEvent.type(screen.getByTestId('request-user-input-custom-item'), 'Keep my draft')
  const reads = () => bridge.request.mock.calls.filter(([, params]) => params?.method === 'asyncQuestion/list').length
  const changed = (record = question, fingerprint = true) => notify({ event: 'async-question:changed', payload: {
    taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
    questionId: record.questionId, revision: record.revision,
    ...(fingerprint ? { revisionFingerprint: asyncQuestionRevisionFingerprint(record) } : {}),
  } })
  return { reads, changed }
}

it('identical question replays do not reread or suspend an answer card', async () => {
  const f = await fixture(), before = f.reads()
  await act(async () => { for (let index = 0; index < 100; index++) f.changed() })
  expect(f.reads()).toBe(before)
  expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
  expect(screen.getByTestId('composer')).toBeEnabled()
})

it('a duplicate during a failed read cannot supersede that failure with a trailing read', async () => {
  const f = await fixture()
  let fail!: (error: Error) => void
  bridge.request.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  const before = f.reads()
  await act(async () => { f.changed(); fail(new Error('Original read failed')) })
  expect(f.reads()).toBe(before)
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  await act(async () => f.changed())
  expect(f.reads()).toBe(before)
  expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
})

it.each([false, true])('interleaved conflicts cannot starve readback (read fails=%s)', async readFails => {
  const f = await fixture(), before = f.reads()
  const updates = ['First conflicting prompt?', 'Second conflicting prompt?'].map(prompt => ({
    ...question, questions: [{ ...question.questions[0], question: prompt }],
  }))
  const reads: { resolve(value: unknown): void; reject(error: Error): void }[] = []
  bridge.request.mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })))
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  const replay = () => {
    for (let index = 0; index < 20; index++) updates.forEach(update => f.changed(update))
  }
  await act(async () => {
    replay()
    reads[0].resolve({ threadId: address.threadId, questions: [question] })
  })
  expect(f.reads() - before).toBe(2)
  await act(async () => {
    replay()
    if (readFails) reads[1].reject(new Error('Original read failed'))
    else reads[1].resolve({ threadId: address.threadId, questions: [question] })
  })
  // Settle unexpected trailing work before asserting, keeping every read owned.
  await act(async () => reads.slice(2).forEach(read =>
    read.resolve({ threadId: address.threadId, questions: [question] })))
  expect(f.reads() - before).toBe(2)
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
  expect(screen.getByTestId('composer')).toBeEnabled()
  if (readFails) {
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  } else {
    expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument()
    expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
  }
})

it.each(['conflicting content', 'legacy notification'])(
  '%s still reconciles the original question', async kind => {
    const f = await fixture(), before = f.reads()
    const changed = { ...question, questions: [{ ...question.questions[0], question: 'Different prompt?' }] }
    bridge.request.mockResolvedValue({ threadId: address.threadId, questions: [changed] })
    await act(async () => f.changed(changed, kind !== 'legacy notification'))
    await waitFor(() => expect(f.reads()).toBeGreaterThan(before))
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(screen.getByTestId('composer')).toBeEnabled()
  }
)

it.each([
  { displayed: false, next: 'replay' },
  { displayed: true, next: 'replay' },
  { displayed: true, next: 'newer' },
  { displayed: true, next: 'conflict' },
  { displayed: true, next: 'legacy' },
])(
  'in-flight unseen question notifications ($next, already displayed=$displayed)', async ({ displayed, next }) => {
    const peers = [1, 2].map(index => ({ ...question, questionId: `peer-${index}`,
      requestId: `peer-request-${index}`, toolCallId: `peer-tool-${index}`,
      questions: [{ ...question.questions[0], id: `peer-item-${index}` }] }))
    let hold = !displayed
    const reads: Array<{ resolve: () => void }> = []
    let notify!: (event: unknown) => void
    bridge.subscribe.mockImplementation(async listener => { notify = listener; return () => undefined })
    bridge.request.mockImplementation(async command => {
      if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
      const result = { threadId: address.threadId, questions: [question, ...(hold ? peers : [])] }
      if (hold) await new Promise<void>(resolve => { reads.push({ resolve }) })
      return result
    })
    render(<AsyncQuestionPanel address={address} />)
    if (displayed) {
      await userEvent.click(await screen.findByTestId('async-question-toggle'))
      await userEvent.type(screen.getByTestId('request-user-input-custom-item'), 'Keep my draft')
      hold = true
      await userEvent.click(screen.getByTestId('async-question-refresh'))
    }
    await waitFor(() => expect(reads).toHaveLength(1))
    const replay = async (kind = 'replay') => act(async () => {
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const peer of peers) {
          const update = kind === 'newer' ? { ...peer, revision: peer.revision + 1 }
            : kind === 'conflict' ? { ...peer, questions: [{ ...peer.questions[0], question: 'Changed prompt?' }] }
            : peer
          notify({ event: 'async-question:changed', payload: {
            taskId: address.taskId, serverId: address.deviceId, threadId: address.threadId,
            questionId: update.questionId, revision: update.revision,
            ...(kind === 'legacy' ? {} : { revisionFingerprint: asyncQuestionRevisionFingerprint(update) }),
          } })
        }
      }
    })
    try {
      await replay()
      await act(async () => reads[0].resolve())
      expect(reads).toHaveLength(2)
      await replay(next)
      await act(async () => reads[1].resolve())
      // The same unseen records must not invalidate every trailing read before
      // any snapshot can be displayed, even when their replays are interleaved.
      expect(reads).toHaveLength(next === 'replay' ? 2 : 3)
      if (next !== 'replay') await act(async () => reads[2].resolve())
      await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
      for (const peer of peers) expect(screen.getByTestId(`async-question-card-${peer.questionId}`)).toBeInTheDocument()
      if (displayed) expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
      expect(bridge.request.mock.calls.some(([, params]) => params?.method === 'asyncQuestion/answer')).toBe(false)
    } finally {
      hold = false
      await act(async () => reads.forEach(read => read.resolve()))
    }
  }
)
