import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

const saved = { submissionId: 'winner', acceptedAtMs: 2, answers: { item: { text: 'Original answer' } } }

function fixture() {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
  const client = { supportsExperimental: () => true }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([['task', client]]), notificationReplayGuard: new NotificationReplayGuard(),
    forwardAcceptedNotification,
  }
  return (answer: unknown, status = 'queued', revision = 2) => forwardNotification.call(
    runtime as unknown as GatewayRuntimeCore, 'asyncQuestion/changed', {
      threadId: 'thread', serverId: 'native', sequence: 42,
      question: { threadId: 'thread', questionId: 'question', revision, status, answer },
    }, 'target', client as never)
}

it.each([
  { name: 'missing answer map', answer: { ...saved, answers: undefined } },
  { name: 'null answer map', answer: { ...saved, answers: null } },
  { name: 'missing save time', answer: { ...saved, acceptedAtMs: undefined } },
  { name: 'invalid save time', answer: { ...saved, acceptedAtMs: -1 } },
  { name: 'blank submission', answer: { ...saved, submissionId: '   ' } },
  { name: 'non-string text', answer: { ...saved, answers: { item: { text: false } } } },
  { name: 'unpaired surrogate item identity', answer: { ...saved, answers: { ['item\ud800']: { text: 'answer' } } } },
  { name: 'blank item identity', answer: { ...saved, answers: { ' \t ': { text: 'answer' } } } },
  { name: 'oversized item identity', answer: { ...saved, answers: { ['界'.repeat(86)]: { text: 'answer' } } } },
  { name: 'oversized submission identity', answer: { ...saved, submissionId: '界'.repeat(86) } },
  { name: 'blank option identity', answer: { ...saved, answers: { item: { selectedOptionIds: ['\u0085'] } } } },
  { name: 'oversized option identity', answer: { ...saved, answers: { item: { selectedOptionIds: ['界'.repeat(86)] } } } },
  { name: 'pending saved answer', answer: saved, status: 'pending' },
  { name: 'empty answer map', answer: { ...saved, answers: {} } },
  { name: 'too many items', answer: { ...saved, answers: Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`item-${i}`, { text: 'answer' }])) } },
  { name: 'duplicate selections', answer: { ...saved, answers: { item: { selectedOptionIds: ['option', 'option'] } } } },
  { name: 'too many selections', answer: { ...saved, answers: { item: { selectedOptionIds:
    Array.from({ length: 17 }, (_, i) => `option-${i}`) } } } },
  { name: 'empty answer', answer: { ...saved, answers: { item: {} } } },
  { name: 'Rust whitespace-only answer', answer: { ...saved, answers: { item: { text: ' \u0085\t' } } } },
  { name: 'UTF-8 answer overflow', answer: { ...saved, answers: { item: { text: '界'.repeat(5500) } } } },
  { name: 'escaped answer overflow', answer: { ...saved, answers: { item: { text: '\n'.repeat(8192) } } } },
])('a partial hint with $name cannot suppress original-question recovery', async ({ answer, status }) => {
  const notify = fixture()
  await notify(answer, status ?? 'queued')
  expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
  // A compatibility hint can omit prompts, but explicit saved data must be
  // valid before it claims the sequence needed by the authoritative replay.
  await notify(saved)
  expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
    event: 'async-question:changed', payload: {
      taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2,
    },
  })
  await notify(saved)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

it.each([undefined, null, saved])('retains valid or omitted legacy saved answers: %j', async answer => {
  await fixture()(answer)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

it.each(['x'.repeat(256), '界'.repeat(85) + 'x', '😀'.repeat(64), '\uFEFF'])(
  'retains valid legacy saved-answer identities without normalization: %j', async id => {
    const notify = fixture()
    const answer = { ...saved, submissionId: id, answers: { [id]: { selectedOptionIds: [id] } } }
    await notify(answer)
    await notify(answer)
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
      event: 'async-question:changed', payload: {
        taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2,
      },
    })
  }
)

const answerBudgetOverhead = JSON.stringify({ item: { selectedOptionIds: [], text: '' } }).length
it.each([
  { name: 'exact answer byte limit with defaulted selections', answers: {
    item: { text: 'x'.repeat(16384 - answerBudgetOverhead) },
  } },
  { name: 'original whitespace', answers: { item: { text: '  Original answer\n' } } },
  { name: 'Rust content U+FEFF', answers: { item: { text: '\ufeff' } } },
  { name: 'null text and multiple selections', answers: {
    item: { selectedOptionIds: ['first', 'second'], text: null },
  } },
])('retains valid legacy $name without replaying it', async ({ answers }) => {
  const notify = fixture()
  await notify({ ...saved, answers })
  await notify({ ...saved, answers })
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})
