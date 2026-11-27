import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AsyncQuestionRecord } from '../../../../shared/generated/contracts'
import chat from '@/i18n/locales/en/chat.json'
import common from '@/i18n/locales/en/common.json'
import { AsyncQuestionPanel } from './AsyncQuestionPanel'

const bridge = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({
  requestLocalExecutor: bridge.request,
  subscribeLocalExecutorEvents: bridge.subscribe,
}))

beforeAll(async () => {
  await createInstance().use(initReactI18next).init({
    lng: 'en', resources: { en: { chat, common } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  bridge.request.mockReset()
  bridge.subscribe.mockReset().mockResolvedValue(() => undefined)
})

function fixture(threadId: string, known = true) {
  const address = { taskId: 'task', deviceId: 'server', ...(known ? { threadId } : {}) }
  const question: AsyncQuestionRecord = {
    questionId: 'question', requestId: 'request', threadId, sourceTurnId: 'turn',
    toolCallId: 'tool', revision: 1, createdAtMs: 1, status: 'pending',
    questions: [{ id: 'item', header: 'Mode', question: 'Which mode?', multiSelect: false, options: [] }],
  }
  let capabilityThreadId = threadId
  bridge.request.mockImplementation(async (command, params) => {
    if (command === 'runtime.asyncQuestion.supports')
      return { supported: true, threadId: capabilityThreadId }
    expect(params.method).toBe('asyncQuestion/list')
    expect(params.params.threadId).toBe(threadId)
    return { threadId, questions: [question] }
  })
  const recover = async () => {
    const listener = bridge.subscribe.mock.calls[0][0]
    await act(async () => listener({ event: 'async-question:refresh', payload: {
      taskId: address.taskId, serverId: address.deviceId, threadId,
    } }))
  }
  return { address, recover, replaceCapability: (value: string) => { capabilityThreadId = value } }
}

for (const threadId of [' thread ', '\uFEFF原任务\uFEFF']) {
  for (const known of [false, true]) {
    it(`preserves opaque thread bytes on discovery and reconnect (${JSON.stringify(threadId)}, known=${known})`, async () => {
      const f = fixture(threadId, known)
      const user = userEvent.setup()
      render(<AsyncQuestionPanel address={f.address} />)
      await screen.findByTestId('async-question-card-question')
      await user.click(screen.getByTestId('async-question-toggle'))
      await user.type(screen.getByTestId('request-user-input-custom-item'), 'Original draft')
      await f.recover()
      await waitFor(() => expect(bridge.request.mock.calls.filter(([command]) =>
        command === 'runtime.asyncQuestion.supports')).toHaveLength(2))
      await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
      expect(screen.getByTestId('request-user-input-custom-item')).toHaveValue('Original draft')
      expect(screen.queryByTestId('async-question-retry')).not.toBeInTheDocument()
      expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/list')
        .every(([, params]) => params.params.threadId === threadId)).toBe(true)
    })
  }
}

it.each(['initial', 'reconnect'])('rejects a padded mismatching owner during %s without reading another task', async stage => {
  const f = fixture('thread')
  if (stage === 'initial') f.replaceCapability(' thread ')
  render(<AsyncQuestionPanel address={f.address} />)
  if (stage === 'reconnect') {
    await screen.findByTestId('async-question-card-question')
    f.replaceCapability(' thread ')
    bridge.request.mockClear()
    await f.recover()
  }
  await act(async () => {})
  if (stage === 'reconnect') expect(screen.getByTestId('async-question-retry')).toBeEnabled()
  else expect(screen.queryByTestId('async-question-panel')).not.toBeInTheDocument()
  expect(bridge.request.mock.calls.some(([, params]) => params.method === 'asyncQuestion/list')).toBe(false)
})

it('keeps the discovered original thread when reconnect resolves the same task alias elsewhere', async () => {
  const f = fixture('original-thread', false)
  const user = userEvent.setup()
  render(<AsyncQuestionPanel address={f.address} />)
  await user.click(await screen.findByTestId('async-question-toggle'))
  const draft = screen.getByTestId('request-user-input-custom-item')
  await user.type(draft, 'Original draft')

  f.replaceCapability('replacement-thread')
  bridge.request.mockClear()
  await f.recover()
  expect(bridge.request.mock.calls.map(([command]) => command))
    .toEqual(['runtime.asyncQuestion.supports'])
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  expect(draft).toHaveValue('Original draft')

  f.replaceCapability('original-thread')
  await user.click(screen.getByTestId('async-question-retry'))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(draft).toHaveValue('Original draft')
  expect(bridge.request.mock.calls.filter(([, params]) => params.method === 'asyncQuestion/list')
    .map(([, params]) => params.params.threadId)).toEqual(['original-thread'])
})
