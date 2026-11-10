import { listen } from '@/lib/runtime-events'
import { clearTestTransports, installTestTransport } from '@/test/runtime-transport'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeGatewayClient } from './gateway/runtime/contractFixture.test-support'
import { KCoderGatewayRuntime } from './gatewayRuntime'
import { reviewEvidenceFixture } from '../features/workbench/reviewEvidence.test-support'

afterEach(() => {
  clearTestTransports()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('review evidence at the owning Native transport boundary', () => {
  it.each(['supported', 'legacy', 'foreign-attempt'])(
    'accepts only negotiated matching observations: %s',
    async mode => {
      installTestTransport(() => undefined)
      const client = new FakeGatewayClient('thread-capture')
      const original = client.supportsExperimental.bind(client)
      vi.spyOn(client, 'supportsExperimental').mockImplementation(capability =>
        capability === 'turnReviewEvidenceV1' ? mode !== 'legacy' : original(capability)
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
        const capture = { ...reviewEvidenceFixture,
          threadId: 'thread-capture', turnId: 'thread-capture-turn',
          attemptId: mode === 'foreign-attempt' ? 'peer-attempt' : 'thread-capture-turn',
        }
        client.emitNotification('turn/completed', {
          threadId: 'thread-capture',
          turnId: 'thread-capture-turn',
          turn: { id: 'thread-capture-turn', status: 'completed' },
          reviewEvidence: capture,
        })
        await vi.waitFor(() =>
          expect(received.some(event => event.event === 'response.completed')).toBe(true)
        )
        const done = received.find(event => event.event === 'response.completed')!
        if (mode === 'supported') expect(done.payload.data?.review_evidence).toEqual(capture)
        else expect(done.payload.data).not.toHaveProperty('review_evidence')
      } finally {
        unlisten()
        await runtime.disposeAsync()
      }
    }
  )
})

it('keeps the capability selection from a completed history read after releasing its client', async () => {
  installTestTransport(() => undefined)
  const client = new FakeGatewayClient('thread-capture')
  vi.spyOn(client, 'supportsThreadResume').mockReturnValue(true)
  const original = client.supportsExperimental.bind(client)
  let connected = true
  vi.spyOn(client, 'supportsExperimental').mockImplementation(capability =>
    capability === 'turnReviewEvidenceV1' || capability === 'turnFileCaptureV1' ? connected : original(capability))
  vi.spyOn(client, 'close').mockImplementation(() => { connected = false })
  const runtime = new KCoderGatewayRuntime('token', {
    loadServers: async () => [{ id: 'local', label: 'Local', description: 'Fixture', transport: 'local', workspacePath: '/workspace' }],
    createClient: () => client,
  })
  try {
    const created = await runtime.request('runtime.tasks.create', { taskId: 'history-evidence', executionRequest: { prompt: 'fixture' } }) as { taskId: string }
    connected = true
    const review = { ...reviewEvidenceFixture, threadId: 'thread-capture' }
    const capture = { version: 1, captureId: 'c'.repeat(64), threadId: 'thread-capture', turnId: 'turn-A', attemptId: 'attempt-A', state: 'failed', base: null, head: null, limitations: ['captureFailed'], artifactId: null }
    client.threadMessages = [{ id: 'history-result', role: 'assistant', content: 'historical result', turnId: 'turn-A', attemptId: 'attempt-A', timestampMs: 1, reviewEvidence: review, fileChangesCapture: capture }]
    const transcript = await runtime.request('runtime.tasks.transcript', { taskId: created.taskId }) as { messages: { reviewEvidence?: unknown; fileChangesCapture?: unknown }[] }
    expect(connected).toBe(false)
    expect(transcript.messages[0].reviewEvidence).toEqual(review)
    expect(transcript.messages[0].fileChangesCapture).toEqual(capture)
  } finally {
    await runtime.disposeAsync()
  }
})
