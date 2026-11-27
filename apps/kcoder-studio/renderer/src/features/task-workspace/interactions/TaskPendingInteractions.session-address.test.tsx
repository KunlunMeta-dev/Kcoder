import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { TaskInteractionSnapshotV1 } from '../../../../../shared/generated/contracts'
import { TaskPendingInteractions } from './TaskPendingInteractions'

const f = vi.hoisted(() => ({ request: vi.fn(), servers: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: f.servers }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const address = { deviceId: 'native', taskId: 'task', threadId: 'thread', workspacePath: '/owned',
  expectedSessionAddress: { targetId: 'native-owner', workspaceId: 'original-workspace', threadId: 'thread' } }
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
  f.request.mockResolvedValue(structuredClone(snapshot))
}

test.each(['targetId', 'workspaceId', 'threadId'] as const)(
  'a changed canonical %s retires the old draft before a conflicting original-task read', async field => {
    prepare()
    const initial = structuredClone(address)
    const view = render(<><TaskPendingInteractions address={initial} /><input data-testid="composer" /></>)
    await screen.findByTestId('request-user-input-card')
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Old session draft' },
    })
    const before = f.request.mock.calls.length
    // Directory DTOs may be updated in place without changing the task alias.
    initial.expectedSessionAddress[field] = 'replacement'
    f.request.mockRejectedValue(new Error('SESSION_ADDRESS_EXPECTATION_CONFLICT'))
    view.rerender(<><TaskPendingInteractions address={initial} /><input data-testid="composer" /></>)
    await waitFor(() => expect(f.request.mock.calls.length).toBeGreaterThan(before))
    expect(screen.queryByDisplayValue('Old session draft')).not.toBeInTheDocument()
    expect(f.request.mock.calls.slice(before).every(([method, params]) =>
      method.endsWith('.read') && params.address.expectedSessionAddress[field] === 'replacement')).toBe(true)
    expect(screen.getByTestId('composer')).toBeEnabled()
  }
)

test('a new session constraint aborts the old answer transport and ignores its late receipt', async () => {
  prepare()
  let answerSignal!: AbortSignal
  let finish!: () => void
  f.request.mockImplementation(async (method, params, options) => {
    if (method.endsWith('.read')) return structuredClone(snapshot)
    answerSignal = options.signal
    return new Promise(resolve => {
      finish = () => resolve({ reference: params.response.reference, state: 'resolved' })
    })
  })
  const view = render(<TaskPendingInteractions address={address} />)
  await screen.findByTestId('request-user-input-card')
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Original answer' },
  })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(answerSignal).toBeInstanceOf(AbortSignal))
  const replacement = { ...address, expectedSessionAddress: {
    ...address.expectedSessionAddress, workspaceId: 'replacement-workspace',
  } }
  view.rerender(<TaskPendingInteractions address={replacement} />)
  expect(answerSignal.aborted).toBe(true)
  await screen.findByTestId('request-user-input-card')
  await act(async () => finish())
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
  expect(screen.getByTestId('request-user-input-submit-button')).toBeEnabled()
  expect(screen.queryByText('states.resolved')).not.toBeInTheDocument()
  expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1)
})

test('an equivalent canonical selector preserves the draft and original answer transport', async () => {
  prepare()
  let answerSignal!: AbortSignal
  f.request.mockImplementation(async (method, _params, options) => {
    if (method.endsWith('.read')) return structuredClone(snapshot)
    answerSignal = options.signal
    return new Promise(() => {})
  })
  const view = render(<TaskPendingInteractions address={address} />)
  const card = await screen.findByTestId('request-user-input-card')
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Retain the original draft' },
  })
  // Object construction order is not part of the canonical session identity.
  const equivalent = { ...address, expectedSessionAddress: {
    threadId: 'thread', workspaceId: 'original-workspace', targetId: 'native-owner',
  } }
  view.rerender(<TaskPendingInteractions address={equivalent} />)
  expect(card).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Retain the original draft')
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(answerSignal).toBeInstanceOf(AbortSignal))
  view.rerender(<TaskPendingInteractions address={address} />)
  expect(answerSignal.aborted).toBe(false)
  expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1)
})
