import { listen } from '@/lib/runtime-events'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import type { TurnFileChangesCapture } from '../../../shared/generated/contracts'

afterEach(() => {
  clearTestTransports()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('capture observations at the owning Native transport boundary', () => {
  it.each(['supported', 'legacy', 'foreign-attempt'])(
    'accepts only negotiated matching observations: %s',
    async mode => {
      installTestTransport(() => undefined)
      const client = new FakeGatewayClient('thread-capture')
      const original = client.supportsExperimental.bind(client)
      vi.spyOn(client, 'supportsExperimental').mockImplementation(capability =>
        capability === 'turnFileCaptureV1' ? mode !== 'legacy' : original(capability)
      )
      const runtime = new KCoderGatewayRuntime('token', {
        loadServers: async () => [
          {
            id: 'local',
            label: 'Local',
            description: 'Fixture',
            transport: 'local',
            workspacePath: '/workspace',
          },
        ],
        createClient: () => client,
      })
      const received: Array<{ event: string; payload: { data?: Record<string, unknown> } }> = []
      const unlisten = await listen<{ event: string; payload: { data?: Record<string, unknown> } }>(
        'local-executor:event',
        event => received.push(event.payload)
      )
      try {
        await runtime.request('runtime.tasks.create', {
          taskId: 'capture-task',
          executionRequest: { prompt: 'fixture' },
        })
        client.emitNotification('turn/started', {
          threadId: 'thread-capture',
          turnId: 'thread-capture-turn',
          turn: { id: 'thread-capture-turn', status: 'inProgress' },
        })
        const capture: TurnFileChangesCapture = {
          version: 1,
          captureId: 'a'.repeat(64),
          threadId: 'thread-capture',
          turnId: 'thread-capture-turn',
          attemptId: mode === 'foreign-attempt' ? 'peer-attempt' : 'thread-capture-turn',
          state: 'failed',
          base: null,
          head: null,
          limitations: ['captureFailed'],
          artifactId: null,
        }
        client.emitNotification('turn/completed', {
          threadId: 'thread-capture',
          turnId: 'thread-capture-turn',
          turn: { id: 'thread-capture-turn', status: 'completed' },
          fileChangesCapture: capture,
        })
        await vi.waitFor(() =>
          expect(received.some(event => event.event === 'response.completed')).toBe(true)
        )
        const done = received.find(event => event.event === 'response.completed')!
        if (mode === 'supported') expect(done.payload.data?.file_changes_capture).toEqual(capture)
        else expect(done.payload.data).not.toHaveProperty('file_changes_capture')
      } finally {
        unlisten()
        await runtime.disposeAsync()
      }
    }
  )
})
