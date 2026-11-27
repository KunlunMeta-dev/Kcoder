import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentTaskBinding, TaskInteractionSnapshotV1 } from '../../../../../shared/generated/contracts'
import { TaskPendingInteractions } from './TaskPendingInteractions'

const f = vi.hoisted(() => ({ request: vi.fn(), servers: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: f.servers }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const address = { deviceId: 'native', taskId: 'task', threadId: 'thread', workspacePath: '/owned',
  runtimeHandle: { threadId: 'thread', owner: 'original-owner' } }
const snapshot: TaskInteractionSnapshotV1 = {
  schemaVersion: 1, threadId: address.threadId, observationState: 'observed', items: [{
    reference: { attemptId: 'attempt', selector: {
      serverId: 'process', threadId: address.threadId, turnId: 'turn', requestId: 2000001,
      appServerEpoch: 'epoch', kind: 'question', questionId: 'question',
    } },
    state: 'pending', presentation: { approval: null, questions: [{
      id: 'choice', header: 'Original question', question: 'Which sources?', isOther: true,
      multiSelect: false, options: [],
    }] },
  }],
}

afterEach(() => { cleanup(); vi.resetAllMocks() })

function prepare() {
  f.servers.mockResolvedValue([{ id: address.deviceId, transport: 'local', command: 'kcoder' }])
  f.request.mockImplementation(async () => structuredClone(snapshot))
}

function expert(id: string): AgentTaskBinding {
  return { owner: { accountId: 'account', targetId: address.deviceId, workspaceId: null },
    definition: { id, version: '1', definitionSha256: 'a'.repeat(64) },
    title: id, source: 'expert' }
}

test('next-turn expert selection changes preserve the current question and its unsent draft', async () => {
  prepare()
  const view = render(<TaskPendingInteractions address={address} />)
  const card = await screen.findByTestId('request-user-input-card')
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Keep the original sources' },
  })
  for (const agentDefinition of [expert('first'), expert('second'), undefined]) {
    view.rerender(<TaskPendingInteractions address={{ ...address, runtimeHandle: {
      ...address.runtimeHandle, ...(agentDefinition ? { agentDefinition } : {}),
    } }} />)
    await screen.findByTestId('request-user-input-card')
    expect(card).toBeInTheDocument()
    expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep the original sources')
  }
  expect(f.request.mock.calls.every(([method]) => method.endsWith('.read'))).toBe(true)
})

test('an expert refresh keeps the dispatched answer on its original transport until confirmation', async () => {
  prepare()
  let finish!: () => void
  let answerSignal!: AbortSignal
  f.request.mockImplementation(async (method, params, options) => {
    if (method.endsWith('.read')) return structuredClone(snapshot)
    answerSignal = options.signal
    return new Promise(resolve => {
      finish = () => resolve({ reference: params.response.reference, state: 'response_pending' })
    })
  })
  const view = render(<TaskPendingInteractions address={address} />)
  await screen.findByTestId('request-user-input-card')
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Original answer' },
  })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.rerender(<TaskPendingInteractions address={{ ...address, runtimeHandle: {
    ...address.runtimeHandle, agentDefinition: expert('next-turn-expert'),
  } }} />)
  expect(answerSignal.aborted).toBe(false)
  await act(async () => finish())
  await screen.findByText('states.response_pending')
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Original answer')
  expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1)
})

test('a changed runtime owner still retires the old question draft', async () => {
  prepare()
  const view = render(<TaskPendingInteractions address={address} />)
  const card = await screen.findByTestId('request-user-input-card')
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Original owner draft' },
  })
  view.rerender(<TaskPendingInteractions address={{ ...address, runtimeHandle: {
    ...address.runtimeHandle, owner: 'replacement-owner',
  } }} />)
  await screen.findByTestId('request-user-input-card')
  expect(card).not.toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
})
