import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskPendingInteractions } from './TaskPendingInteractions'
import { captureTaskInteraction, readTaskInteractions } from '@/kcoder/gateway/runtime/taskInteractions'
import type { GatewayRuntimeCore } from '@/kcoder/gateway/runtime/core'

const bridge = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: bridge.request }))
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'original-owner', isCurrent: bridge.current }),
}))
afterEach(() => { cleanup(); bridge.request.mockReset() })

test('a directory refresh racing a native read retains the disabled draft until readback recovers', async () => {
  const taskId = 'task', requestId = 2000001
  const frame = { serverId: 'native', threadId: 'thread', turnId: 'turn', appServerEpoch: 'epoch' }
  const address = { deviceId: 'target', taskId, threadId: frame.threadId, workspacePath: '/owned' }
  const client = { supportsExperimental: () => true, respond: vi.fn(),
    request: vi.fn(async (_method: string, selector: object) => ({ ...selector, status: 'pending' })),
  }
  const pending = { client, taskId, requestId, turnId: frame.turnId, questionId: 'question',
    block: { id: 'block' }, renderPayload: { questions: [{ id: 'choice', header: 'Source',
      question: 'Which source?', isOther: true, options: [] }] },
  }
  const task = { taskId, serverId: address.deviceId, threadId: frame.threadId, workspacePath: address.workspacePath,
    runtimeHandle: { memoryTaskSnapshot: { ...frame, attemptId: 'attempt', serverInstanceId: frame.serverId } } }
  const server = { id: address.deviceId, transport: 'local', command: '/owned/kcoder', workspacePath: '/owned' }
  const core = { disposed: false, tasks: new Map([[taskId, task]]), clientByTask: new Map([[taskId, client]]),
    appServerDisconnectedClients: new WeakSet(), activeTurnByTask: new Map([[taskId, { turnId: frame.turnId }]]),
    turnAttemptIds: new Map([[`${taskId}:${frame.turnId}`, 'attempt']]),
    pendingQuestionByKey: new Map([[`${taskId}\0${requestId}`, pending]]),
    taskDescriptor: async () => ({ taskId, task, server }), serverForParams: async () => server,
    assertCommandTarget: async () => {}, commandDirectoryRefresh: new Map(),
  } as unknown as GatewayRuntimeCore
  await captureTaskInteraction(core, client as never, taskId, frame, requestId)
  bridge.request.mockImplementation((_method, params, options) => readTaskInteractions(core, params, options))
  render(<><TaskPendingInteractions address={address} /><input data-testid="composer" /></>)
  const draft = await screen.findByTestId('request-user-input-custom-choice')
  fireEvent.change(draft, { target: { value: 'Keep the original answer' } })

  // The target stays unchanged, but its directory generation changes while
  // the original native status RPC is in flight.
  client.request.mockImplementationOnce(async (_method, selector) => {
    core.commandDirectoryRefresh.set(address.deviceId, { sequence: 1, result: Promise.resolve([server]) } as never)
    return { ...selector, status: 'pending' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await screen.findByText('errors.unavailable')
  expect(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
  expect(draft).toHaveValue('Keep the original answer')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  expect(screen.getByTestId('composer')).toBeEnabled()

  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled())
  expect(screen.getByTestId('request-user-input-custom-choice')).toBe(draft)
  expect(draft).toHaveValue('Keep the original answer')
  expect(client.respond).not.toHaveBeenCalled()
  expect(core.pendingQuestionByKey.get(`${taskId}\0${requestId}`)).toBe(pending)
})
