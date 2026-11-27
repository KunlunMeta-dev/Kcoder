import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

for (const complete of [false, true]) {
  it.each(['ownerThreadId', 'workspacePath', 'unexpected'])(
    `an unknown %s envelope field cannot consume a corrected question replay (complete=${complete})`,
    async field => {
      const client = { supportsExperimental: () => true }
      const task = { taskId: 'task', serverId: 'target', threadId: 'thread' }
      const runtime = {
        disposed: false, appServerDisconnectedClients: new WeakSet(),
        tasks: new Map([['task', task]]), taskByThread: new Map([['target\0thread', 'task']]),
        threadKey: (target: string, thread: string) => `${target}\0${thread}`,
        clientByTask: new Map([['task', client]]), notificationReplayGuard: new NotificationReplayGuard(),
        forwardAcceptedNotification,
      }
      const params = {
        threadId: 'thread', serverId: 'native', sequence: 42,
        question: { threadId: 'thread', questionId: 'question', revision: 1,
          ...(complete ? { requestId: 'request', sourceTurnId: 'source', toolCallId: 'tool',
            createdAtMs: 1, status: 'pending', questions: [{ id: 'item', header: 'Mode',
              question: 'Continue?', multiSelect: false, options: [] }] } : {}) },
      }
      const notify = (value: Record<string, unknown>) => forwardNotification.call(
        runtime as unknown as GatewayRuntimeCore, 'asyncQuestion/changed', value, 'target', client as never)

      // Direct/older transports can bypass the Gateway's envelope guard. The
      // malformed frame must leave the original sequence free for recovery.
      await notify({ ...params, [field]: 'another-task' })
      expect.soft(emitRuntimeEvent).not.toHaveBeenCalled()
      vi.mocked(emitRuntimeEvent).mockClear()
      await notify(params)
      expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', {
        event: 'async-question:changed', payload: expect.objectContaining({ taskId: 'task',
          serverId: 'target', threadId: 'thread', questionId: 'question', revision: 1 }),
      })
      await notify(params)
      expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    }
  )
}
