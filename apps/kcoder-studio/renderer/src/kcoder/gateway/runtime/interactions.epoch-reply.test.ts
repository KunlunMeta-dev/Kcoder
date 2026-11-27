import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import { WorkspaceAppServerBroker } from '../../../../../src/workspace-app-server-broker.js'
import { forwardApprovalRequest, forwardServerRequest, respondToTaskQuestion } from './interactions'
import type { GatewayRuntimeCore } from './core'

vi.mock('../../gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => undefined) }))

const brokers: WorkspaceAppServerBroker[] = []
afterEach(() => brokers.splice(0).forEach(broker => broker.clearTransientState()))

for (const shared of [false, true]) {
  for (const kind of ['question', 'approval'] as const) {
    for (const unsafe of kind === 'approval' ? [false, true] : [false]) {
      test(`${kind} desktop reply retains the epoch after ID reuse (shared=${shared}, unsafe=${unsafe})`, async () => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        })
        const broker = new WorkspaceAppServerBroker({ child, serverId: 'target', residentThreads: true,
          maxMessageBytes: 1024 * 1024, adapter: { rawPassthrough: true,
            toUpstream: message => ({ upstream: [message], client: [] }),
            fromUpstream: message => ({ upstream: [], client: [message] }) } })
        brokers.push(broker)
        broker.initializeResponse = { result: { capabilities: { experimental: { interactionBindingV1: true } } } }
        const upstream: Array<Record<string, unknown>> = []
        child.stdin.on('data', chunk => upstream.push(...chunk.toString().trim().split('\n').map(JSON.parse)))
        const messages: Array<Record<string, unknown>> = []
        const socket = { channel: 'runtime', send(message) { messages.push(message); return true },
          pause() {}, resume() {}, close() {} }
        broker.attach(socket)
        Object.assign(socket, { initialized: true, gatewaySharedThreadsV1: shared })
        const emit = message => child.stdout.write(`${JSON.stringify(message)}\n`)
        let sequence = 0
        const rpc = (method, result) => {
          broker.receive(socket, JSON.stringify({ id: ++sequence, method, params: { threadId: 'thread' } }))
          emit({ id: upstream.at(-1)!.id, result })
        }
        const turn = { thread: { id: 'thread' }, turn: { id: 'turn', threadId: 'thread', status: 'running' } }
        rpc('thread/resume', turn)
        rpc('turn/start', turn)
        const binding = { threadId: 'thread', turnId: 'turn', [`${kind}Id`]: 'input' }
        const old = { id: 500, method: `${kind}/request`, params: { ...binding, appServerEpoch: 'old-epoch' } }
        emit(old)
        broker.receive(socket, JSON.stringify({ id: 500, result: { ...binding,
          ...(kind === 'question' ? { answers: {} } : { decision: 'decline' }) } }))
        emit({ method: `${kind}/resolved`, params: { ...old.params, requestId: 500, reason: 'client_response' } })
        emit({ method: 'turn/completed', params: { threadId: 'thread', turnId: 'turn' } })
        rpc('turn/start', turn)
        const current = { ...old, params: { ...binding, appServerEpoch: 'current-epoch',
          ...(kind === 'question' ? { questions: [{ id: 'item', prompt: 'Original question?', options: [] }] }
            : { action: unsafe ? { type: 'file_change', itemId: 'missing-path' }
              : { type: 'command', command: 'echo controlled' }, availableDecisions: ['accept', 'decline'] }) } }
        emit(current)
        expect(broker.serverRequests.get(500)).toBe(socket)
        const client = { supportsExperimental: () => true,
          respond: (id, result) => broker.receive(socket, JSON.stringify({ id, result })) }
        const runtime = {
          disposed: false, appServerDisconnectedClients: new WeakSet(),
          tasks: new Map([['task', { taskId: 'task', serverId: 'target', threadId: 'thread', workspacePath: '/owned', runtimeHandle: {} }]]),
          clientByTask: new Map([['task', client]]), threadByTask: new Map([['task', 'thread']]),
          taskByThread: new Map([['target\0thread', 'task']]), threadKey: (server, thread) => `${server}\0${thread}`,
          pendingQuestionByKey: new Map(), turnAttemptIds: new Map(), forwardApprovalRequest,
        } as unknown as GatewayRuntimeCore
        const writes = upstream.length
        await forwardServerRequest.call(runtime, client as never, current, 'target')
        if (!unsafe) {
          expect(await respondToTaskQuestion.call(runtime, 'task', { requestId: 500,
            answers: { [kind === 'question' ? 'item' : 'input']: { answers: [kind === 'question' ? 'Original answer' : 'Allow once'] } },
          })).toMatchObject({ accepted: true })
        }
        expect(upstream).toHaveLength(writes + 1)
        expect(upstream.at(-1)).toMatchObject({ id: 500, result: { ...binding, appServerEpoch: 'current-epoch',
          ...(kind === 'question' ? { answers: { item: { answers: ['Original answer'] } } }
            : { decision: unsafe ? 'decline' : 'accept' }) } })
        expect(messages.some(message => message.method === 'gateway/interaction/replyRejected')).toBe(false)
      })
    }
  }
}
