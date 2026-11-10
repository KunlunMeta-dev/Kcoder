import { beforeEach, expect, it, vi } from 'vitest'
import type { GatewayRuntimeCore } from './core'
import { forwardAcceptedNotification, forwardNotification } from './notifications'
import { NotificationReplayGuard } from '../../notificationReplayGuard'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

const cases = ['connection', 'client'].flatMap(replacement =>
  ['before queue', 'during projection'].flatMap(timing =>
    ['turn/started', 'turn/completed', 'item/delta'].map(method => ({ replacement, timing, method, hasTurnId: true }))
      .concat([{ replacement, timing, method: 'turn/completed', hasTurnId: false }])))

it.each(cases)(
  'retires old task events and preserves the current replay ($replacement, $timing, $method, identity=$hasTurnId)',
  async ({ replacement, timing, method, hasTurnId }) => {
    const original = { targetId: 'target', connectionId: 'old' }
    const recovered = { ...original, connectionId: 'recovered' }
    const initiallyRunning = method !== 'turn/started'
    const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned',
      runtimeHandle: {}, running: initiallyRunning }
    const client = { diagnosticConnection: recovered, supportsExperimental: () => true }
    const retired = replacement === 'connection' ? client : {
      diagnosticConnection: original, supportsExperimental: () => true,
    }
    const runtime = {
      disposed: false, tasks: new Map([[task.taskId, task]]),
      taskByThread: new Map([['target\0thread', task.taskId]]),
      threadKey: (server: string, thread: string) => `${server}\0${thread}`,
      clientByTask: new Map([[task.taskId, client]]),
      notificationReplayGuard: new NotificationReplayGuard(), forwardAcceptedNotification,
      completedTurnKeys: new Set(), pendingTurnStartByTask: new Set(),
      activeTurnByTask: new Map(), trackActiveTurn: vi.fn(),
      turnAttemptIds: new Map(), turnText: new Map(), backgroundJobById: new Map(), pendingQuestionByKey: new Map(),
      remoteSessions: { handleNotification: () => false },
      toolPathPreviews: { beforeResumeBoundary: () => false, handle: () => {} },
    }
    const notify = (source: typeof client, connection: typeof original) => forwardNotification.call(
      runtime as unknown as GatewayRuntimeCore, method, {
        threadId: task.threadId, serverId: 'native', sequence: 42,
        ...(hasTurnId ? { turnId: 'current-turn', turn: { id: 'current-turn', status: 'completed' } } : {}),
        delta: { text: 'CURRENT_TEXT' },
      }, task.serverId, source as never, connection
    )
    if (timing === 'during projection') {
      if (replacement === 'connection') client.diagnosticConnection = original
      else runtime.clientByTask.set(task.taskId, retired)
    }
    const stale = notify(retired, original)
    client.diagnosticConnection = recovered
    runtime.clientByTask.set(task.taskId, client)
    await stale
    expect(runtime.tasks.get(task.taskId)).toBe(task)
    expect(emitRuntimeEvent).not.toHaveBeenCalled()
    expect(runtime.trackActiveTurn).not.toHaveBeenCalled()

    // The current binding can still process the exact event discarded above.
    await notify(client, recovered)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
    expect(runtime.tasks.get(task.taskId)).toMatchObject({
      running: method === 'turn/started' ? true : method === 'turn/completed' ? false : initiallyRunning,
    })
    if (method === 'item/delta') expect(runtime.turnText.get('task:current-turn')).toBe('CURRENT_TEXT')
    await notify(client, recovered)
    expect(emitRuntimeEvent).toHaveBeenCalledTimes(1)
  }
)
