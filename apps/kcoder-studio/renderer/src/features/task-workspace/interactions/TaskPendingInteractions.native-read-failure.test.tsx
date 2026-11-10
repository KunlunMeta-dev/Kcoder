import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskPendingInteractions } from './TaskPendingInteractions'
import {
  captureTaskInteraction,
  readTaskInteractions,
  respondTaskInteraction,
} from '@/kcoder/gateway/runtime/taskInteractions'
import { respondToTaskQuestion } from '@/kcoder/gateway/runtime/interactions'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'

const executor = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: executor.request }))
vi.mock('@/kcoder/gatewayServiceBridge', () => ({ emitRuntimeEvent: vi.fn(async () => {}) }))
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'original-owner', isCurrent: executor.current }),
}))

afterEach(() => { cleanup(); executor.request.mockReset() })

async function fixture(pinned: boolean, count: number, failure: 'transport' | 'binding' | 'schema' | 'target-lookup' | 'target-check' = 'transport') {
  const taskId = 'original-task'
  const frame = { serverId: 'native', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch' }
  const address = { deviceId: 'target', taskId, threadId: frame.threadId, workspacePath: '/owned' }
  let failingRequestId: number | undefined
  let status = 'pending'
  const request = vi.fn(async (_method: string, selector: { requestId: number }) => {
    if (selector.requestId === failingRequestId) {
      if (failure === 'transport') throw new Error('Native status transport unavailable')
      if (failure === 'binding') return { ...selector, questionId: 'foreign-question', status }
      return { ...selector, status: 'invalid-status' }
    }
    return { ...selector, status }
  })
  const client = { supportsExperimental: () => true, request, respond: vi.fn(),
    ...(pinned ? {
      diagnosticConnection: { connectionId: 'original-connection' },
      requestOnConnection: vi.fn(async (connectionId: string, method: string, selector: { requestId: number }) => {
        expect(connectionId).toBe('original-connection')
        return request(method, selector)
      }),
    } : {}),
  }
  const task = { taskId, serverId: address.deviceId, threadId: frame.threadId, workspacePath: address.workspacePath,
    runtimeHandle: { memoryTaskSnapshot: { ...frame, attemptId: 'attempt', serverInstanceId: frame.serverId } } }
  const server = { id: address.deviceId, transport: 'local', command: '/owned/kcoder', workspacePath: '/owned' }
  const runtime = { disposed: false, tasks: new Map([[taskId, task]]), clientByTask: new Map([[taskId, client]]),
    threadByTask: new Map([[taskId, frame.threadId]]), appServerDisconnectedClients: new WeakSet(),
    activeTurnByTask: new Map([[taskId, { turnId: frame.turnId }]]),
    turnAttemptIds: new Map([[`${taskId}:${frame.turnId}`, 'attempt']]),
    pendingQuestionByKey: new Map(),
    taskDescriptor: async () => ({ taskId, task, server }),
    serverForParams: async () => {
      if (failingRequestId && failure === 'target-lookup') throw new Error('Target lookup unavailable')
      return server
    },
    assertCommandTarget: async () => {
      if (failingRequestId && failure === 'target-check') throw new Error('Target authority unavailable')
    },
    respondToTaskQuestion: (id: string, response: Record<string, unknown>, expected: never) =>
      respondToTaskQuestion.call(core, id, response, expected),
  }
  const core = runtime as unknown as GatewayRuntimeCore
  for (let index = 0; index < count; index++) {
    const requestId = 2000001 + index
    runtime.pendingQuestionByKey.set(`${taskId}\0${requestId}`, {
      client, taskId, requestId, turnId: frame.turnId, questionId: `question-${index}`, block: { id: `block-${index}` },
      renderPayload: { questions: [{ id: `choice-${index}`, header: 'Original question', question: 'Which sources?',
        isOther: true, multiSelect: true, options: [
          { label: 'First source', description: 'Original first choice' },
          { label: 'Second source', description: 'Original second choice' },
        ] }] },
    })
    await captureTaskInteraction(core, client as never, taskId, frame, requestId)
  }
  executor.request.mockImplementation((method, params) => method.endsWith('.read')
    ? readTaskInteractions(core, params) : respondTaskInteraction(core, params))
  render(<TaskPendingInteractions address={address} />)
  await screen.findAllByTestId('request-user-input-card')
  return { client, core, address,
    fail: () => { failingRequestId = 2000000 + count },
    recover: (next: 'pending' | 'resolved') => { failingRequestId = undefined; status = next },
  }
}

for (const scenario of [
  { name: 'original target lookup', pinned: true, count: 1, failure: 'target-lookup' as const },
  { name: 'original target authority', pinned: true, count: 1, failure: 'target-check' as const },
  { name: 'legacy status RPC', pinned: false, count: 1 },
  { name: 'captured connection status RPC', pinned: true, count: 1 },
  { name: 'second status RPC in a batch', pinned: true, count: 2 },
  { name: 'legacy misbound status receipt', pinned: false, count: 1, failure: 'binding' as const },
  { name: 'captured connection misbound status receipt', pinned: true, count: 1, failure: 'binding' as const },
  { name: 'second misbound status receipt in a batch', pinned: true, count: 2, failure: 'binding' as const },
  { name: 'malformed status receipt', pinned: true, count: 1, failure: 'schema' as const },
]) {
  test.each(['pending', 'resolved'] as const)(
    `${scenario.name} failure retains and disables original drafts until a %s receipt is read`, async state => {
      const f = await fixture(scenario.pinned, scenario.count, 'failure' in scenario ? scenario.failure : undefined)
      const cards = screen.getAllByTestId('request-user-input-card')
      const input = screen.getByTestId('request-user-input-custom-choice-0')
      for (let index = 0; index < scenario.count; index++) {
        fireEvent.click(screen.getByTestId(`request-user-input-option-choice-${index}-1`))
        fireEvent.change(screen.getByTestId(`request-user-input-custom-choice-${index}`), {
          target: { value: 'Keep the original unsent draft' },
        })
      }
      f.fail()
      await act(async () => { window.dispatchEvent(new Event('online')) })
      await screen.findByText('errors.unavailable')
      for (const card of cards) expect(card).toBeInTheDocument()
      for (let index = 0; index < scenario.count; index++) {
        const field = screen.getByTestId(`request-user-input-custom-choice-${index}`)
        expect(field).toHaveValue('Keep the original unsent draft')
        expect(field).toBeDisabled()
        expect(screen.getByTestId(`request-user-input-option-choice-${index}-1`)).toHaveAttribute('aria-pressed', 'true')
      }
      expect(f.client.respond).not.toHaveBeenCalled()

      f.recover(state)
      fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
      await waitFor(() => expect(screen.queryByText('errors.unavailable')).toBeNull())
      expect(f.client.respond).not.toHaveBeenCalled()
      if (state === 'resolved') {
        expect(screen.queryByTestId('request-user-input-card')).toBeNull()
      } else {
        expect(input).toBeEnabled()
        expect(input).toHaveValue('Keep the original unsent draft')
        fireEvent.click(screen.getAllByTestId('request-user-input-submit-button')[0])
        await waitFor(() => expect(f.client.respond).toHaveBeenCalledOnce())
        expect(f.client.respond).toHaveBeenCalledWith(2000001, expect.objectContaining({
          questionId: 'question-0', answers: { 'choice-0': { answers: ['Second source', 'Keep the original unsent draft'] } },
        }))
      }
    },
  )
}

test.each(['disconnect', 'abort'] as const)('a rejected status read still honors %s before classifying a transport failure', async change => {
  const f = await fixture(true, 1)
  let reject!: (error: Error) => void
  f.client.request.mockImplementationOnce(() => new Promise((_resolve, onReject) => { reject = onReject }))
  const abort = new AbortController()
  const reading = readTaskInteractions(f.core, { address: f.address }, { signal: abort.signal })
  const outcome = reading.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
  await waitFor(() => expect(reject).toBeTypeOf('function'))
  if (change === 'disconnect') f.core.appServerDisconnectedClients.add(f.client as never)
  else abort.abort()
  reject(new Error('Native status transport unavailable'))
  const result = await outcome
  if (change === 'disconnect') {
    expect(result.error).toBeUndefined()
    expect(result.value).toMatchObject({ observationState: 'unknown', items: [] })
  } else expect(result.error?.name).toBe('AbortError')
  expect(f.client.respond).not.toHaveBeenCalled()
})
