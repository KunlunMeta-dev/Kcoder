import { act, render, screen, waitFor, within } from '@testing-library/react'
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

it.each([true, false].flatMap(fingerprint =>
  [false, true].map(readFails => ({ fingerprint, readFails }))))(
  'interleaved hints cannot starve readback (fingerprint=$fingerprint, read fails=$readFails)',
  async ({ fingerprint, readFails }) => {
    const f = await fixture(), before = f.reads()
    const updates = ['First conflicting prompt?', 'Second conflicting prompt?'].map(prompt => ({
      ...question, questions: [{ ...question.questions[0], question: prompt }],
    }))
    const reads: { resolve(value: unknown): void; reject(error: Error): void }[] = []
    bridge.request.mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })))
    await userEvent.click(screen.getByTestId('async-question-refresh'))
    const replay = () => {
      for (let index = 0; index < 20; index++) updates.forEach(update => f.changed(update, fingerprint))
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
  }
)

it('distinct legacy revisions still refresh within one coalesced read', async () => {
  const f = await fixture()
  const reads: Array<(value: unknown) => void> = []
  bridge.request.mockImplementation(() => new Promise(resolve => reads.push(resolve)))
  await userEvent.click(screen.getByTestId('async-question-refresh'))
  const replay = (revision: number) => f.changed({ ...question, revision }, false)
  await act(async () => {
    replay(2)
    reads[0]({ threadId: address.threadId, questions: [question] })
  })
  expect(reads).toHaveLength(2)
  await act(async () => {
    replay(3)
    reads[1]({ threadId: address.threadId, questions: [question] })
  })
  expect(reads).toHaveLength(3)
  await act(async () => {
    replay(3)
    reads[2]({ threadId: address.threadId, questions: [question] })
  })
  expect(reads).toHaveLength(3)
  expect(screen.getByTestId('async-question-refresh')).toBeEnabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
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
    const withdrawals = peers.map(peer => ({ ...peer, revision: peer.revision + 1, status: 'cancelled' as const }))
    let snapshotPeers: AsyncQuestionRecord[] = peers
    const reads: Array<{ resolve: () => void }> = []
    let notify!: (event: unknown) => void
    bridge.subscribe.mockImplementation(async listener => { notify = listener; return () => undefined })
    bridge.request.mockImplementation(async command => {
      if (command === 'runtime.asyncQuestion.supports') return { supported: true, threadId: address.threadId }
      const result = { threadId: address.threadId, questions: [question, ...(hold ? snapshotPeers : [])] }
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
        for (const [index, peer] of peers.entries()) {
          const update = kind === 'newer' ? withdrawals[index]
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
      if (next === 'newer') snapshotPeers = withdrawals
      await replay(next)
      await act(async () => reads[1].resolve())
      // The same unseen records must not invalidate every trailing read before
      // any snapshot can be displayed, even when their replays are interleaved.
      expect(reads).toHaveLength(next === 'replay' ? 2 : 3)
      if (next !== 'replay') await act(async () => reads[2].resolve())
      await waitFor(() => expect(screen.getByTestId('async-question-refresh')).toBeEnabled())
      for (const peer of peers) {
        const card = screen.queryByTestId(`async-question-card-${peer.questionId}`)
        if (next === 'newer') expect(card).not.toBeInTheDocument()
        else expect(card).toBeInTheDocument()
      }
      if (displayed) expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
      expect(bridge.request.mock.calls.some(([, params]) => params?.method === 'asyncQuestion/answer')).toBe(false)
    } finally {
      hold = false
      await act(async () => reads.forEach(read => read.resolve()))
    }
  }
)

it.each([
  { fingerprint: true, readFails: false },
  { fingerprint: true, readFails: true },
  { fingerprint: false, readFails: false },
  { fingerprint: false, readFails: true },
])('a same-revision hint suspends answers until readback settles ($fingerprint, $readFails)', async ({ fingerprint, readFails }) => {
  const f = await fixture()
  let complete!: (value: unknown) => void
  let fail!: (error: Error) => void
  bridge.request.mockImplementation(() => new Promise((resolve, reject) => { complete = resolve; fail = reject }))
  const conflicting = { ...question, questions: [{ ...question.questions[0], question: 'A different original prompt?' }] }
  await act(async () => f.changed(conflicting, fingerprint))
  // A sparse hint cannot prove that the current card matches the notified record.
  expect.soft(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
  expect(screen.getByTestId('composer')).toBeEnabled()
  await act(async () => {
    if (readFails) fail(new Error('Original question read failed'))
    else complete({ threadId: address.threadId, questions: [question] })
  })
  if (readFails) {
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    bridge.request.mockResolvedValue({ threadId: address.threadId, questions: [question] })
    await userEvent.click(screen.getByTestId('async-question-retry'))
  }
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
  expect(bridge.request.mock.calls.some(([, params]) => params?.method === 'asyncQuestion/answer')).toBe(false)
})

it.each([true, false])('a newer withdrawal hint suspends stale answers during readback (read fails=%s)', async readFails => {
  const f = await fixture()
  let complete!: (value: unknown) => void
  let fail!: (error: Error) => void
  bridge.request.mockImplementation(() => new Promise((resolve, reject) => { complete = resolve; fail = reject }))
  const withdrawn = { ...question, revision: 2, status: 'cancelled' } satisfies AsyncQuestionRecord
  await act(async () => f.changed(withdrawn))
  const submit = screen.getByTestId('request-user-input-submit-button')
  expect.soft(submit).toBeDisabled()
  expect(screen.getByTestId('async-question-refresh')).toBeDisabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
  expect(screen.getByTestId('composer')).toBeEnabled()
  await act(async () => {
    if (readFails) fail(new Error('Original question read failed'))
    else complete({ threadId: address.threadId, questions: [withdrawn] })
  })
  if (readFails) {
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(submit).toBeDisabled()
  } else {
    expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
    expect(screen.queryByTestId('request-user-input-submit-button')).not.toBeInTheDocument()
  }
})

it('keeps a draft locked when original-task readback predates a confirmed withdrawal', async () => {
  const f = await fixture()
  const withdrawn = { ...question, revision: 2, status: 'cancelled' } satisfies AsyncQuestionRecord
  const submit = screen.getByTestId('request-user-input-submit-button')
  const before = f.reads()

  await act(async () => f.changed(withdrawn))

  expect(f.reads()).toBe(before + 1)
  expect(submit).toBeDisabled()
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
  expect(screen.getByTestId('composer')).toBeEnabled()

  bridge.request.mockResolvedValue({ threadId: address.threadId, questions: [withdrawn] })
  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument())
  expect(bridge.request.mock.calls.some(([, params]) => params?.method === 'asyncQuestion/answer')).toBe(false)
})

it('a newer notification for a conflicting source cannot pin the original card at its revision', async () => {
  const f = await fixture()
  const before = f.reads()
  const foreignWithdrawal = { ...question, sourceTurnId: 'other-turn', revision: 2, status: 'cancelled' } satisfies AsyncQuestionRecord

  bridge.request.mockRejectedValueOnce(new Error('Original task temporarily unavailable'))
  await act(async () => f.changed(foreignWithdrawal))
  expect(f.reads()).toBe(before + 1)
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()

  await userEvent.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
  expect(screen.getByTestId('composer')).toBeEnabled()
  expect(bridge.request.mock.calls.some(([, params]) => params?.method === 'asyncQuestion/answer')).toBe(false)
})

it.each(['missing', 'stale'] as const)(
  'requires readback of a newly notified question when the list is %s', async snapshot => {
    const f = await fixture()
    const peer = { ...question, questionId: 'peer', requestId: 'peer-request', toolCallId: 'peer-tool' }
    const withdrawn = { ...peer, revision: 2, status: 'cancelled' } satisfies AsyncQuestionRecord
    bridge.request.mockResolvedValue({
      threadId: address.threadId, questions: snapshot === 'missing' ? [question] : [question, peer],
    })

    await act(async () => f.changed(withdrawn))

    expect(screen.queryByTestId('async-question-card-peer')).not.toBeInTheDocument()
    expect(screen.getByTestId('async-question-retry')).toBeEnabled()
    expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
    expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
    expect(screen.getByTestId('composer')).toBeEnabled()

    bridge.request.mockResolvedValue({ threadId: address.threadId, questions: [question, withdrawn] })
    await userEvent.click(screen.getByTestId('async-question-retry'))
    await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
    expect(screen.queryByTestId('async-question-card-peer')).not.toBeInTheDocument()
  }
)

it.each([false, true])(
  'uses the original list source for a newly notified ID (matching withdrawal=%s)', async matchingWithdrawal => {
    const f = await fixture()
    const peer = { ...question, questionId: 'peer', requestId: 'peer-request', toolCallId: 'peer-tool' }
    const withdrawn = { ...peer, revision: 2, status: 'cancelled' } satisfies AsyncQuestionRecord
    const unrelated = { ...peer, sourceTurnId: 'other-turn', revision: 3, status: 'stale' } satisfies AsyncQuestionRecord
    bridge.request.mockResolvedValue({ threadId: address.threadId, questions: [question, peer] })

    await act(async () => {
      if (matchingWithdrawal) f.changed(withdrawn)
      f.changed(unrelated)
    })

    if (matchingWithdrawal) {
      expect(screen.getByTestId('async-question-retry')).toBeEnabled()
      expect(screen.queryByTestId('async-question-card-peer')).not.toBeInTheDocument()
      bridge.request.mockResolvedValue({ threadId: address.threadId, questions: [question, withdrawn] })
      await userEvent.click(screen.getByTestId('async-question-retry'))
      await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
      expect(screen.queryByTestId('async-question-card-peer')).not.toBeInTheDocument()
    } else {
      const card = within(screen.getByTestId('async-question-card-peer'))
      await userEvent.type(card.getByTestId('request-user-input-custom-item'), 'Answer for the verified source')
      expect(card.getByTestId('request-user-input-submit-button')).toBeEnabled()
    }

    const original = within(screen.getByTestId('async-question-card-question'))
    expect(original.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
    expect(screen.getByTestId('composer')).toBeEnabled()
    expect(bridge.request.mock.calls.every(([, params]) =>
      !params?.method || params.method === 'asyncQuestion/list')).toBe(true)
  },
)

it.each(['initial discovery', 'reconnect'] as const)(
  'requires readback of a withdrawal received during %s', async phase => {
    let notify!: (event: unknown) => void
    let finishSupport!: (result: unknown) => void
    let holdSupport = phase === 'initial discovery'
    let snapshot = question
    bridge.subscribe.mockImplementation(async listener => { notify = listener; return () => undefined })
    bridge.request.mockImplementation(async command => {
      if (command === 'runtime.asyncQuestion.supports') {
        if (holdSupport) return new Promise(resolve => { finishSupport = resolve })
        return { supported: true, threadId: address.threadId }
      }
      return { threadId: address.threadId, questions: [snapshot] }
    })
    render(<AsyncQuestionPanel address={address} />)
    if (phase === 'reconnect') {
      await userEvent.click(await screen.findByTestId('async-question-toggle'))
      await userEvent.type(screen.getByTestId('request-user-input-custom-item'), 'Keep my draft')
      holdSupport = true
      await act(async () => notify({ event: 'async-question:refresh', payload: {
        ...address, serverId: address.deviceId,
      } }))
    }
    expect(finishSupport).toBeTypeOf('function')
    const withdrawn = { ...question, revision: 2, status: 'cancelled' } satisfies AsyncQuestionRecord
    const changed = (record: AsyncQuestionRecord) => notify({ event: 'async-question:changed', payload: {
      ...address, serverId: address.deviceId, threadId: record.threadId,
      questionId: record.questionId, revision: record.revision,
      revisionFingerprint: asyncQuestionRevisionFingerprint(record),
    } })
    await act(async () => {
      changed({ ...withdrawn, threadId: 'other-thread', revision: 3 })
      changed(withdrawn)
      finishSupport({ supported: true, threadId: address.threadId })
    })
    if (phase === 'reconnect') {
      expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
      expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Keep my draft')
    } else {
      expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
    }
    snapshot = withdrawn
    if (phase === 'reconnect') {
      await userEvent.click(screen.getByTestId('async-question-retry'))
    } else {
      holdSupport = false
      await act(async () => notify({ event: 'async-question:refresh', payload: {
        ...address, serverId: address.deviceId,
      } }))
    }
    expect(bridge.request.mock.calls.filter(([, params]) => params?.method === 'asyncQuestion/list'))
      .toHaveLength(phase === 'reconnect' ? 3 : 2)
    await waitFor(() => expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument())
    expect(screen.queryByTestId('async-question-card-question')).not.toBeInTheDocument()
  }
)
