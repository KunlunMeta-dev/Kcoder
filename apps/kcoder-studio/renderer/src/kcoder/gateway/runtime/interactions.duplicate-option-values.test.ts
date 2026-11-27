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
    turnAttemptIds: new Map(), activeTurnByTask: new Map([[task.taskId, { turnId: 'turn' }]]),
    pendingQuestionByKey: new Map(),
  } as unknown as GatewayRuntimeCore
  const forward = (options: unknown, fields: Record<string, unknown> = {}, id = 101, params: Record<string, unknown> = {}) => forwardServerRequest.call(runtime, client as never, {
    jsonrpc: '2.0', id, method: 'question/request', params: {
      threadId: task.threadId, turnId: 'turn', questionId: 'original-question',
      questions: [{ id: 'choice', prompt: 'Keep the original file?', options, ...fields }],
      ...params,
    },
  }, task.serverId)
  return { runtime, client, forward }
}

const invalidOptions = [
  [{ label: 'Keep', value: 'same' }, { label: 'Delete', value: 'same' }],
  [{ label: 'same' }, { label: 'Delete', value: 'same' }],
  [{ value: 'same' }, { label: 'same' }],
]

it.each(invalidOptions.map(options => [options]))(
  'duplicate answer values %j cannot consume the corrected original question', async options => {
    const f = fixture()
    await f.forward(options)
    expect(f.runtime.pendingQuestionByKey.size).toBe(0)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    expect(f.client.respondError).toHaveBeenCalledExactlyOnceWith(101, -32602,
      'Invalid question/request payload', { interactionBinding: {
        questionId: 'original-question', threadId: 'thread', turnId: 'turn',
      } })

    await f.forward([{ label: 'Original', value: 'keep' }, { label: 'Original', value: 'delete' }], {}, 102)
    const pending = f.runtime.pendingQuestionByKey.get('task\0' + 102)!
    render(createElement(RequestUserInputCard, { payload: pending.renderPayload, onSubmit: response =>
      respondToTaskQuestion.call(f.runtime, 'task', response) }))
    fireEvent.click(screen.getByTestId('request-user-input-option-choice-1'))
    await waitFor(() => expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(102, expect.objectContaining({
      questionId: 'original-question', answers: { choice: { answers: ['delete'] } },
    })))
  },
)

it('a malformed same-ID replay preserves the existing current question and its answer path', async () => {
  const f = fixture()
  await f.forward([{ label: 'Keep', value: 'keep' }])
  const pending = f.runtime.pendingQuestionByKey.get('task\0' + 101)!
  await f.forward([{ label: 'Keep', value: 'same' }, { label: 'Delete', value: 'same' }])
  expect(f.client.respondError).not.toHaveBeenCalled()
  expect(f.runtime.pendingQuestionByKey.get('task\0' + 101)).toBe(pending)
  render(createElement(RequestUserInputCard, { payload: pending.renderPayload, onSubmit: response =>
    respondToTaskQuestion.call(f.runtime, 'task', response) }))
  fireEvent.click(screen.getByTestId('request-user-input-option-choice-0'))
  await waitFor(() => expect(f.client.respond).toHaveBeenCalledExactlyOnceWith(101, expect.objectContaining({
    questionId: 'original-question', answers: { choice: { answers: ['keep'] } },
  })))
})

it('a malformed question with conflicting task identity is not answered', async () => {
  const f = fixture()
  await f.forward([{ label: 'Keep', value: 'same' }, { label: 'Delete', value: 'same' }], {}, 103,
    { turn_id: 'another-turn' })
  expect(f.client.respondError).not.toHaveBeenCalled()
  expect(f.runtime.pendingQuestionByKey.size).toBe(0)
})

it('a settled request ID remains usable on a distinct active turn', async () => {
  const f = fixture()
  await f.forward([{ label: 'bad', value: 'same' }, { label: 'bad again', value: 'same' }])
  expect(f.client.respondError).toHaveBeenCalledOnce()
  ;(f.runtime.activeTurnByTask as Map<string, { turnId: string }>).set('task', { turnId: 'next-turn' })
  await f.forward([{ label: 'Continue', value: 'continue' }], {}, 101, { turnId: 'next-turn' })
  expect(f.runtime.pendingQuestionByKey.get('task\0' + 101)).toMatchObject({ turnId: 'next-turn' })
})

it('preserves exact distinct answer values across label-only and value-only choices', async () => {
  const f = fixture()
  await f.forward([{ label: 'same' }, { value: ' same ' }, { label: 'same', value: 'other' }])
  expect(f.runtime.pendingQuestionByKey.get('task\0' + 101)?.renderPayload.questions)
    .toMatchObject([{ options: [{ value: 'same' }, { value: ' same ' }, { value: 'other' }] }])
})
