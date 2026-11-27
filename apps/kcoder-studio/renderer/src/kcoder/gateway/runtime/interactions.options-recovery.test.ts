import { createElement } from 'react'
import '@/i18n'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RequestUserInputCard } from '@/components/chat/RequestUserInputCard'
import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

function fixture() {
  const client = { respond: vi.fn(), respondError: vi.fn(), supportsExperimental: () => true }
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
    threadByTask: new Map([[task.taskId, task.threadId]]),
    taskByThread: new Map([['target\0thread', task.taskId]]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    activeTurnByTask: new Map(), turnAttemptIds: new Map(), pendingQuestionByKey: new Map(),
  } as unknown as GatewayRuntimeCore
  const forward = (options: unknown, fields: Record<string, unknown> = {}) => forwardServerRequest.call(runtime, client as never, {
    id: 101, method: 'question/request', params: {
      threadId: task.threadId, turnId: 'turn', questionId: 'original-question',
      questions: [{ id: 'choice', prompt: 'Keep the original file?', options, ...fields }],
    },
  }, task.serverId)
  return { runtime, client, forward }
}

const invalidOptions = [
  [{ label: '\u0085', value: 'yes' }], [{ label: 'Yes', value: '\u0085' }],
  null, {}, [null], ['Yes'], [{}],
  [{ label: 7, value: 'yes' }], [{ label: ' ', value: 'yes' }],
  [{ label: '\ud800', value: 'yes' }],
  [{ label: 'Yes', value: null }], [{ label: 'Yes', value: '' }],
  [{ label: 'Yes', value: '\udfff' }],
]

it.each(invalidOptions.map(options => [options]))(
  'unusable choices %j cannot reserve the original question before its corrected replay', async options => {
    const f = fixture()
    await f.forward(options)
    expect(f.runtime.pendingQuestionByKey.size).toBe(0)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    expect(f.client.respondError).not.toHaveBeenCalled()

    await f.forward([{ label: 'Keep', value: 'keep' }])
    const pending = f.runtime.pendingQuestionByKey.get('task\0' + 101)!
    expect(pending.renderPayload.questions).toMatchObject([
      { id: 'choice', options: [{ label: 'Keep', value: 'keep' }] },
    ])
    expect(emitRuntimeEvent).toHaveBeenCalledOnce()
    const response = { requestId: 101, answers: { choice: { answers: ['keep'] } } }
    expect(await respondToTaskQuestion.call(f.runtime, 'task', response)).toMatchObject({ accepted: true })
    expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(101, expect.objectContaining({
      questionId: 'original-question', threadId: 'thread', turnId: 'turn', answers: response.answers,
    }))
  },
)

it.each([
  [undefined, []], [[], []],
  [[{ label: '\uFEFF', value: '\uFEFF' }], [{ label: '\uFEFF', value: '\uFEFF' }]],
  [[{ label: 'Keep' }], [{ label: 'Keep', value: 'Keep' }]],
  [[{ value: 'keep' }], [{ label: 'keep', value: 'keep' }]],
  [[{ label: 'Keep', value: 'keep' }], [{ label: 'Keep', value: 'keep' }]],
])('retains usable legacy choices %j', async (options, expected) => {
  const f = fixture()
  await f.forward(options)
  expect(f.runtime.pendingQuestionByKey.get('task\0' + 101)?.renderPayload.questions)
    .toMatchObject([{ options: expected }])
  expect(emitRuntimeEvent).toHaveBeenCalledOnce()
})

// Legacy transports bypass Gateway admission, so validate before replay binding.
it.each([
  { id: '\u0085' }, { prompt: '\u0085' }, { question: '\u0085' },
])('Unicode blank question data %j cannot retain the original waiter', async fields => {
  const f = fixture()
  await f.forward([], fields)
  expect(f.runtime.pendingQuestionByKey.size).toBe(0)
  expect(emitRuntimeEvent).not.toHaveBeenCalled()
  await f.forward([])
  expect(f.runtime.pendingQuestionByKey.size).toBe(1)
})

it('the original card sends valid Unicode content without substituting its option value', async () => {
  const f = fixture()
  await f.forward([{ label: '\uFEFF', value: '\uFEFF' }], { id: '\uFEFF', prompt: '\uFEFF' })
  const pending = f.runtime.pendingQuestionByKey.get('task\0' + 101)!
  expect(pending.renderPayload.questions).toMatchObject([{ id: '\uFEFF', question: '\uFEFF' }])
  render(createElement(RequestUserInputCard, { payload: pending.renderPayload, onSubmit: response =>
    respondToTaskQuestion.call(f.runtime, 'task', response) }))
  fireEvent.click(screen.getByTestId('request-user-input-option-\uFEFF-0', { normalizer: value => value }))
  await waitFor(() => expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(101, expect.objectContaining({
    questionId: 'original-question', answers: { '\uFEFF': { answers: ['\uFEFF'] } },
  })))
})
