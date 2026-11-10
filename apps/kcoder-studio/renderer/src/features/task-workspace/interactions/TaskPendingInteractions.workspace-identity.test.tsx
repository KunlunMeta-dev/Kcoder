import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { TaskInteractionSnapshotV1 } from '../../../../../shared/generated/contracts'
import { TaskPendingInteractions } from './TaskPendingInteractions'

const f = vi.hoisted(() => ({ request: vi.fn(), servers: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: f.servers }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const address = { deviceId: 'native', taskId: 'task', threadId: 'thread', workspacePath: '/owned' }
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

test.each([
  ['/owned', '/owned/'],
  ['C:\\Owned', 'c:/Owned/'],
])('equivalent workspace spellings preserve the original draft and pending answer (%s)', async (original, alias) => {
  f.servers.mockResolvedValue([{ id: address.deviceId, transport: 'local', command: 'kcoder' }])
  let finish!: () => void
  let answerSignal!: AbortSignal
  f.request.mockImplementation(async (method, params, options) => {
    if (method.endsWith('.read')) return structuredClone(snapshot)
    answerSignal = options.signal
    return new Promise(resolve => {
      finish = () => resolve({ reference: params.response.reference, state: 'response_pending' })
    })
  })
  const initial = { ...address, workspacePath: original }
  const view = render(<TaskPendingInteractions address={initial} />)
  const card = await screen.findByTestId('request-user-input-card')
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Keep the original answer' },
  })
  view.rerender(<TaskPendingInteractions address={{ ...initial, workspacePath: alias }} />)
  expect(card).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep the original answer')
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.rerender(<TaskPendingInteractions address={initial} />)
  expect(answerSignal.aborted).toBe(false)
  await act(async () => finish())
  await screen.findByText('states.response_pending')
  expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1)
  expect(f.request.mock.calls.find(([method]) => method.endsWith('.respond'))?.[1].address).toEqual(initial)
})

test('an equivalent path cannot reopen an answer whose original acknowledgement was lost', async () => {
  f.servers.mockResolvedValue([{ id: address.deviceId, transport: 'local', command: 'kcoder' }])
  f.request.mockImplementation(async method => {
    if (method.endsWith('.read')) return structuredClone(snapshot)
    throw new Error('Original answer acknowledgement lost')
  })
  const view = render(<TaskPendingInteractions address={address} />)
  await screen.findByTestId('request-user-input-card')
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Original answer' },
  })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await screen.findByText('states.unknown')
  view.rerender(<TaskPendingInteractions address={{ ...address, workspacePath: '/owned/' }} />)
  await act(async () => {})
  expect(screen.getByText('states.unknown')).toBeInTheDocument()
  expect(screen.queryByTestId('request-user-input-card')).toBeNull()
  expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1)
})

test.each(['/other', '/Owned', '/owned/../owned'])(
  'a genuinely different workspace still disposes the original pending transport (%s)', async workspacePath => {
    f.servers.mockResolvedValue([{ id: address.deviceId, transport: 'local', command: 'kcoder' }])
    let answerSignal!: AbortSignal
    f.request.mockImplementation(async (method, _params, options) => {
      if (method.endsWith('.read')) return structuredClone(snapshot)
      answerSignal = options.signal
      return new Promise(() => {})
    })
    const view = render(<TaskPendingInteractions address={address} />)
    await screen.findByTestId('request-user-input-card')
    fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
      target: { value: 'Original answer' },
    })
    fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
    await waitFor(() => expect(answerSignal).toBeInstanceOf(AbortSignal))
    view.rerender(<TaskPendingInteractions address={{ ...address, workspacePath }} />)
    expect(answerSignal.aborted).toBe(true)
    const input = await screen.findByTestId('request-user-input-custom-choice')
    expect(input).toHaveValue('')
  }
)
