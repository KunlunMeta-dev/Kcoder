import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

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
  return (fields: Record<string, unknown>, revision = 2) => forwardNotification.call(
    runtime as unknown as GatewayRuntimeCore, 'asyncQuestion/changed', {
      threadId: 'thread', serverId: 'native', sequence: 42,
      question: { threadId: 'thread', questionId: 'question', revision, ...fields },
    }, 'target', client as never)
}

for (const field of ['requestId', 'sourceTurnId', 'toolCallId']) {
  it.each(['', ' \t\n ', null, 7, false, {}, []].map(value => ({ value })))(
    `a legacy hint with invalid ${field}=$value cannot consume corrected recovery`, async ({ value }) => {
      const notify = fixture()
      await notify({ [field]: value }, 1)
      expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
      // The corrected replay must still refresh the original task, even when
      // a legacy producer omits the full prompt and retains its event sequence.
      await notify({ [field]: 'original-source' })
      expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
        event: 'async-question:changed', payload: {
          taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2,
        },
      })
      await notify({ [field]: 'original-source' })
      expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    }
  )
}

it.each([{}, { requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool' }])(
  'retains omitted or valid legacy source identities: %j', async fields => {
    const notify = fixture()
    await notify(fields)
    await notify(fields)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  }
)

it.each([
  { status: 'cancelled' },
  { status: 'queued', answer: { submissionId: 'winner', acceptedAtMs: 2,
    answers: { item: { text: 'Original answer' } } } },
])('unknown record fields cannot consume a corrected legacy $status replay', async fields => {
  const notify = fixture()
  await notify({ ...fields, unexpected: 'invalid snapshot' })
  expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
  vi.mocked(emitRuntimeEvent).mockClear()
  await notify(fields)
  expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
    event: 'async-question:changed', payload: {
      taskId: 'task', serverId: 'target', threadId: 'thread', questionId: 'question', revision: 2,
    },
  })
  await notify(fields)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

it.each(['requestId', 'sourceTurnId', 'toolCallId'])(
  'a corrected legacy %s can trigger readback after an earlier hint reused its sequence', async field => {
    const notify = fixture()
    await notify({ [field]: 'superseded-source' })
    await notify({ [field]: 'original-source' })
    await notify({ [field]: 'original-source' })

    // Both source bindings need to reach the card's readback path, but a
    // duplicate of the corrected hint must not schedule another list read.
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
    expect(vi.mocked(emitRuntimeEvent).mock.calls[1][1]).toMatchObject({
      event: 'async-question:changed', payload: {
        taskId: 'task', threadId: 'thread', questionId: 'question', revision: 2,
      },
    })
  }
)
