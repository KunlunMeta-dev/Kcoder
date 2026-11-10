import { describe, expect, test, vi } from 'vitest'
import { listen } from '@/lib/runtime-events'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

const threadId = 'question-event-thread'
const input = { questionId: 'question', expectedRevision: 1, submissionId: 'answer-submission',
  answers: { item: { text: 'original answer' } } }
const receipt = { threadId, accepted: true, duplicate: false,
  question: { threadId, questionId: input.questionId,
    answer: { submissionId: input.submissionId, answers: input.answers } },
  startedTurn: { id: 'answer-turn', status: 'running' } }

describe.each([Runtime, InstalledRuntime])('async answers share task events and recovery', RuntimeClass => {
  test.each(['turn/started', 'turn/completed'])(
    'first history read preserves a concurrent %s event', async method => {
      const client = new FakeGatewayClient(threadId)
      client.threadResumeSupported = true
      const original = client.request.bind(client)
      let finish!: (value: unknown) => void
      client.request = async <T>(name: string, params: Record<string, unknown> = {}) => {
        if (name === 'gateway/thread/attach') return { changed: true } as T
        if (name !== 'thread/read' && name !== 'thread/read/indexed') return original<T>(name, params)
        return new Promise<T>(resolve => { finish = value => resolve(value as T) })
      }
      const runtime = new RuntimeClass('token', {
        loadServers: async () => [localGatewayServer()], createClient: () => client,
      })
      try {
        const created = await runtime.request('runtime.tasks.create', {
          executionRequest: { prompt: 'original' },
        }) as { taskId: string }
        await runtime.request('runtime.tasks.view.attach', { ...created, viewId: 'question-events' })
        const originalTurn = runtime.activeTurnByTask.get(created.taskId)!.turnId
        if (method === 'turn/started') {
          client.emitNotification('turn/completed', {
            threadId, turnId: originalTurn, turn: { id: originalTurn, status: 'completed' },
          })
          await vi.waitFor(() => expect(runtime.activeTurnByTask.has(created.taskId)).toBe(false))
        }
        const read = runtime.request('runtime.tasks.transcript', {
          ...created, attachToLiveTurn: true, deviceId: 'local', threadId, workspacePath: '/workspace',
        })
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
        const nextId = method === 'turn/started' ? 'next-turn' : originalTurn
        client.emitNotification(method, { threadId, turnId: nextId,
          turn: { id: nextId, status: method === 'turn/started' ? 'running' : 'completed' } })
        const expected = { running: method === 'turn/started',
          turnStatus: method === 'turn/started' ? 'inProgress' : 'completed' }
        await vi.waitFor(() => expect(runtime.tasks.get(created.taskId)).toMatchObject(expected))
        finish({ messages: [], hasMoreBefore: false })
        await expect(read).resolves.toMatchObject({ running: expected.running })
        expect(runtime.tasks.get(created.taskId)).toMatchObject({ ...expected, persisted: true })
      } finally { await runtime.dispose() }
    }
  )

  test.each(['before receipt', 'after receipt'])(
    'standard events settle the turn when completion arrives %s', async ordering => {
      const received: Array<{ event: string; payload: { data?: { delta?: string } } }> = []
      const unlisten = await listen<(typeof received)[number]>('local-executor:event', event => received.push(event.payload))
      const client = new FakeGatewayClient(threadId)
      client.threadResumeSupported = true
      let finish!: (value: typeof receipt) => void
      const original = client.request.bind(client)
      client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
        if (method === 'gateway/thread/attach') return { changed: true } as T
        if (method !== 'asyncQuestion/answer') return original<T>(method, params)
        client.requests.push({ method, params })
        return new Promise<T>(resolve => { finish = value => resolve(value as T) })
      }
      const runtime = new RuntimeClass('token', {
        loadServers: async () => [localGatewayServer()], createClient: () => client,
      })
      try {
        const created = await runtime.request('runtime.tasks.create', {
          executionRequest: { prompt: 'original' },
        }) as { taskId: string }
        await runtime.request('runtime.tasks.view.attach', { ...created, viewId: 'question-events' })
        const running = async () => (await runtime.request('runtime.tasks.transcript', { ...created, attachToLiveTurn: true,
          deviceId: 'local', threadId, workspacePath: '/workspace' }) as { running: boolean }).running
        const complete = (id: string) => client.emitNotification('turn/completed', {
          threadId, turnId: id, turn: { id, status: 'completed' },
        })
        complete(runtime.activeTurnByTask.get(created.taskId)!.turnId)
        await vi.waitFor(async () => expect(await running()).toBe(false))
        const answer = runtime.request('runtime.asyncQuestion.request', {
          taskId: created.taskId, method: 'asyncQuestion/answer', params: input,
        })
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
        client.emitNotification('turn/started', { threadId, turnId: 'answer-turn',
          turn: { id: 'answer-turn', status: 'running' } })
        client.emitNotification('item/delta', { threadId, turnId: 'answer-turn', delta: { text: 'ORIGINAL_STREAM_TEXT' } })
        await vi.waitFor(async () => {
          expect(await running()).toBe(true)
          expect(received.some(event => event.payload.data?.delta === 'ORIGINAL_STREAM_TEXT')).toBe(true)
        })
        if (ordering === 'before receipt') {
          complete('answer-turn')
          await vi.waitFor(async () => expect(await running()).toBe(false))
        }
        finish(receipt)
        await expect(answer).resolves.toMatchObject({ accepted: true, startedTurn: receipt.startedTurn })
        expect(await running()).toBe(ordering === 'after receipt')
        if (ordering === 'after receipt') complete('answer-turn')
        await vi.waitFor(async () => expect(await running()).toBe(false))
        expect(client.requests.filter(request => request.method === 'turn/start')).toHaveLength(1)
        expect(client.requests.filter(request => request.method === 'asyncQuestion/answer')).toHaveLength(1)
      } finally { unlisten(); await runtime.dispose() }
    }
  )

  test('a pending answer cannot overwrite the common reconnect snapshot or replay itself', async () => {
    const old = new FakeGatewayClient(threadId)
    const recovered = new FakeGatewayClient(threadId)
    old.threadResumeSupported = recovered.threadResumeSupported = true
    let finish!: (value: typeof receipt) => void
    const request = old.request.bind(old)
    old.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
      if (method === 'gateway/thread/attach') return { changed: true } as T
      if (method !== 'asyncQuestion/answer') return request<T>(method, params)
      old.requests.push({ method, params })
      return new Promise<T>(resolve => { finish = value => resolve(value as T) })
    }
    const resume = recovered.request.bind(recovered)
    recovered.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
      if (method === 'gateway/thread/attach') return { changed: true } as T
      if (method !== 'thread/resume') return resume<T>(method, params)
      recovered.requests.push({ method, params })
      return { thread: { id: threadId, status: 'idle' } } as T
    }
    let connections = 0
    const runtime = new RuntimeClass('token', {
      loadServers: async () => [localGatewayServer()], createClient: () => connections++ === 0 ? old : recovered,
    })
    try {
      const created = await runtime.request('runtime.tasks.create', {
        executionRequest: { prompt: 'original' },
      }) as { taskId: string }
      await runtime.request('runtime.tasks.view.attach', { ...created, viewId: 'question-events' })
      const running = async () => (await runtime.request('runtime.tasks.transcript', { ...created, attachToLiveTurn: true,
          deviceId: 'local', threadId, workspacePath: '/workspace' }) as { running: boolean }).running
      const answer = runtime.request('runtime.asyncQuestion.request', {
        taskId: created.taskId, method: 'asyncQuestion/answer', params: input,
      }).then(() => null, error => error)
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      old.close()
      await vi.waitFor(async () => {
        expect(recovered.requests.some(request => request.method === 'thread/resume')).toBe(true)
        expect(await running()).toBe(false)
      })
      finish(receipt)
      expect(await answer).toBeInstanceOf(Error)
      expect(await running()).toBe(false)
      expect(recovered.requests.filter(request => request.method === 'asyncQuestion/answer')).toHaveLength(0)
      recovered.emitNotification('turn/started', { threadId, turnId: 'next-turn', turn: { id: 'next-turn' } })
      await vi.waitFor(async () => expect(await running()).toBe(true))
      recovered.emitNotification('turn/completed', {
        threadId, turnId: 'next-turn', turn: { id: 'next-turn', status: 'completed' },
      })
      await vi.waitFor(async () => expect(await running()).toBe(false))
    } finally { await runtime.dispose() }
  })
})
