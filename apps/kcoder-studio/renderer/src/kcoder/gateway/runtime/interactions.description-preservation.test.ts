import { beforeEach, expect, it, vi } from 'vitest'
import { emitRuntimeEvent } from '../../gatewayServiceBridge'
import type { GatewayRuntimeCore } from './core'
import { forwardServerRequest, respondToTaskQuestion } from './interactions'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))
beforeEach(() => vi.clearAllMocks())

it.each(['\uFEFF', '\uFEFF原始说明\uFEFF', '  first line\n    second line\n'])(
  'preserves the original option description %j through request projection and answering', async description => {
    const client = { respond: vi.fn(), supportsExperimental: () => true }
    const task = { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned' }
    const runtime = {
      disposed: false, appServerDisconnectedClients: new WeakSet(),
      tasks: new Map([[task.taskId, task]]), clientByTask: new Map([[task.taskId, client]]),
      threadByTask: new Map([[task.taskId, task.threadId]]),
      taskByThread: new Map([['target\0thread', task.taskId]]),
      threadKey: (target: string, thread: string) => `${target}\0${thread}`,
      activeTurnByTask: new Map(), turnAttemptIds: new Map(), pendingQuestionByKey: new Map(),
    } as unknown as GatewayRuntimeCore
    await forwardServerRequest.call(runtime, client as never, {
      id: 101, method: 'question/request', params: {
        threadId: 'thread', turnId: 'turn', questionId: 'original-question',
        questions: [{ id: 'choice', header: 'Mode', prompt: 'Choose the original option',
          options: [{ label: 'Keep', value: 'original-value', description }] }],
      },
    }, task.serverId)
    expect(emitRuntimeEvent).toHaveBeenCalledExactlyOnceWith('local-executor:event', expect.objectContaining({
      event: 'response.block.created', payload: expect.objectContaining({ data: {
        block: expect.objectContaining({ renderPayload: expect.objectContaining({
          questions: [expect.objectContaining({ options: [{ label: 'Keep', value: 'original-value', description }] })],
        }) }),
      } }),
    }))
    const answers = { choice: { answers: ['original-value'] } }
    expect(await respondToTaskQuestion.call(runtime, task.taskId, { requestId: 101, answers }))
      .toMatchObject({ accepted: true })
    expect(client.respond).toHaveBeenCalledExactlyOnceWith(101, {
      threadId: 'thread', turnId: 'turn', questionId: 'original-question', answers,
    })
  }
)
