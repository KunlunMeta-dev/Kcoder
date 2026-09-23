import { describe, expect, test, vi } from 'vitest'
import { listen } from '@tauri-apps/api/event'
import { KCoderGatewayRuntime as Runtime } from './gatewayRuntime'
import { KCoderGatewayRuntime as InstalledRuntime } from './installGatewayRuntime'
import { FakeGatewayClient, localGatewayServer } from './gatewayRuntime.test-support'

describe.each([Runtime, InstalledRuntime])('late terminal isolation', RuntimeClass => {
  test.each([false, true])('an older terminal cannot stop current work, same logical turn=%s', async sameTurn => {
    const received: Array<{ event: string; payload: { subtaskId?: string; data?: { delta?: string } } }> = []
    const unlisten = await listen<(typeof received)[number]>('local-executor:event', event => received.push(event.payload))
    const client = new FakeGatewayClient('late-thread')
    client.threadResumeSupported = true
    const original = client.request.bind(client)
    client.request = async <T>(method: string, params: Record<string, unknown> = {}) => {
      if (method === 'thread/read' || method === 'thread/read/indexed') return { messages: [], hasMoreBefore: false } as T
      return original<T>(method, params)
    }
    const runtime = new RuntimeClass('token', { loadServers: async () => [localGatewayServer()], createClient: () => client })
    try {
      const created = await runtime.request('runtime.tasks.create', { executionRequest: { prompt: 'original' } }) as { taskId: string }
      const currentTurn = sameTurn ? 'turn-1' : 'turn-2'
      const currentAttempt = sameTurn ? 'turn-1-retry-11111111-1111-1111-1111-111111111111' : 'turn-2'
      client.emitNotification('turn/started', { threadId: 'late-thread', turnId: currentTurn, attemptId: currentAttempt, turn: { id: currentTurn } })
      client.emitNotification('turn/completed', { threadId: 'late-thread', turnId: 'turn-1', turn: { id: 'turn-1', attemptId: 'turn-1', status: 'completed' } })
      client.emitNotification('item/delta', { threadId: 'late-thread', turnId: currentTurn, delta: { text: 'CURRENT_STILL_RUNNING' } })
      await vi.waitFor(() => expect(received.some(event => event.payload.data?.delta === 'CURRENT_STILL_RUNNING')).toBe(true))
      const transcript = await runtime.request('runtime.tasks.transcript', { taskId: created.taskId }) as { running: boolean }
      expect(transcript.running).toBe(true)
      expect(received.find(event => event.payload.data?.delta === 'CURRENT_STILL_RUNNING')?.payload.subtaskId).toBe(currentAttempt)
    } finally { unlisten(); await runtime.dispose() }
  })
})
