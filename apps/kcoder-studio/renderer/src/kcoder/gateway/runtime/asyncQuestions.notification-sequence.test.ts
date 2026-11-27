import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

function fixture(complete: boolean) {
  const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
  const connection = { targetId: 'target', connectionId: 'original-connection' }
  const client = { supportsExperimental: () => true, diagnosticConnection: connection }
  const runtime = {
    disposed: false, appServerDisconnectedClients: new WeakSet(),
    tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
    threadKey: (target: string, thread: string) => `${target}\0${thread}`,
    clientByTask: new Map([['task', client]]), notificationReplayGuard: new NotificationReplayGuard(),
    forwardAcceptedNotification,
  }
  const question = { threadId: 'thread', questionId: 'question', revision: 1,
    ...(complete ? { requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool',
      createdAtMs: 1, status: 'pending', questions: [{ id: 'item', header: 'Mode',
        question: 'Continue?', multiSelect: false, options: [] }] } : {}) }
  return (sequence: unknown, origin: Record<string, unknown> = { serverId: 'native' },
    payload = question, connectionId = connection.connectionId) => {
    connection.connectionId = connectionId
    return forwardNotification.call(runtime as unknown as GatewayRuntimeCore,
      'asyncQuestion/changed', { threadId: 'thread', question: payload, ...origin,
        ...(sequence === undefined ? {} : { sequence }) }, 'target', client as never, { ...connection })
  }
}

for (const complete of [false, true]) {
  it.each([null, -1, 0.5, '42', {}, [], Number.MAX_SAFE_INTEGER + 1])(
    `invalid sequence %j cannot repeatedly refresh the original question (complete=${complete})`, async sequence => {
      const notify = fixture(complete)
      // A legacy/direct transport can bypass Gateway admission. An invalid
      // explicit sequence must not turn every replay into a new card refresh.
      await notify(sequence)
      await notify(sequence)
      expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
      // The next valid original-task update still refreshes exactly once.
      await notify(42)
      await notify(42)
      expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
      expect(emitRuntimeEvent).toHaveBeenLastCalledWith('local-executor:event', {
        event: 'async-question:changed', payload: expect.objectContaining({ taskId: 'task',
          serverId: 'target', threadId: 'thread', questionId: 'question', revision: 1 }),
      })
    })
}

it.each([0, Number.MAX_SAFE_INTEGER, undefined])('valid or omitted sequence %s preserves original refresh behavior', async sequence => {
  const notify = fixture(true)
  await notify(sequence)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  await notify(sequence)
  // Legacy hints have no event identity; repeated explicit reads remain useful.
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(sequence === undefined ? 2 : 1)
})

it.each([null, 7, '', '   ', '\u0085', '\ud800', 'x'.repeat(257)])(
  'invalid replay server ID %j cannot repeatedly refresh a question', async serverId => {
    const notify = fixture(true)
    await notify(42, { serverId })
    await notify(42, { serverId })
    expect(emitRuntimeEvent).not.toHaveBeenCalled()

    await notify(42)
    await notify(42)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  }
)

it('still refreshes on legacy hints that omit the replay server ID', async () => {
  const notify = fixture(false)
  await notify(undefined, {})
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
})

it('refreshes a newer legacy revision and a different question even when the sequence is reused', async () => {
  const notify = fixture(false)
  const origin = { serverId: 'native' }
  const hints = [
    { threadId: 'thread', questionId: 'question', revision: 1 },
    { threadId: 'thread', questionId: 'question', revision: 2 },
    { threadId: 'thread', questionId: 'another-question', revision: 2 },
  ]
  for (const hint of hints) {
    await notify(42, origin, hint)
    await notify(42, origin, hint)
  }

  expect(vi.mocked(emitRuntimeEvent).mock.calls.map(([, event]) => event)).toEqual(
    hints.map(hint => ({
      event: 'async-question:changed',
      payload: { taskId: 'task', serverId: 'target', ...hint },
    })),
  )
})

it('refreshes from a complete recovery snapshot after a legacy hint with the same sequence', async () => {
  const notify = fixture(true)
  const origin = { serverId: 'native' }
  const hint = { threadId: 'thread', questionId: 'question', revision: 1 }

  await notify(42, origin, hint)
  await notify(42, origin, hint)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  expect(vi.mocked(emitRuntimeEvent).mock.calls[0][1]).toMatchObject({
    event: 'async-question:changed', payload: { questionId: 'question', revision: 1 },
  })
  expect(vi.mocked(emitRuntimeEvent).mock.calls[0][1]).not.toMatchObject({
    payload: { revisionFingerprint: expect.any(String) },
  })

  await notify(42)
  await notify(42)
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
  expect(vi.mocked(emitRuntimeEvent).mock.calls[1][1]).toMatchObject({
    event: 'async-question:changed', payload: { questionId: 'question', revision: 1,
      revisionFingerprint: expect.any(String) },
  })
})

it('forwards a conflicting complete snapshot with the same sequence for original-task readback', async () => {
  const notify = fixture(true)
  const origin = { serverId: 'native' }
  const conflict = {
    threadId: 'thread', questionId: 'question', revision: 1,
    requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool', createdAtMs: 1,
    status: 'pending',
    questions: [{ id: 'item', header: 'Mode', question: 'Try a different mode?', multiSelect: false, options: [] }],
  }

  await notify(42)
  await notify(42)
  await notify(42, origin, conflict)
  await notify(42, origin, conflict)

  const hints = vi.mocked(emitRuntimeEvent).mock.calls.map(([, event]) => event.payload)
  expect(hints).toHaveLength(2)
  expect(hints[0]).toMatchObject({ questionId: 'question', revision: 1 })
  expect(hints[1]).toMatchObject({ questionId: 'question', revision: 1 })
  expect(hints[1].revisionFingerprint).not.toBe(hints[0].revisionFingerprint)
})

it('deduplicates a sequenced legacy hint without a server ID only on its original connection', async () => {
  const notify = fixture(false)

  await notify(42, {})
  await notify(42, {})
  expect.soft(emitRuntimeEvent).toHaveBeenCalledTimes(1)

  await notify(42, {}, undefined, 'replacement-connection')
  await notify(42, {}, undefined, 'replacement-connection')
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
})

it('releases the legacy replay claim when publishing the refresh fails', async () => {
  const notify = fixture(false)
  vi.mocked(emitRuntimeEvent).mockRejectedValueOnce(new Error('refresh event delivery failed'))

  await expect(notify(42, {})).rejects.toThrow('refresh event delivery failed')
  await notify(42, {})
  await notify(42, {})
  expect(emitRuntimeEvent).toHaveBeenCalledTimes(2)
})
