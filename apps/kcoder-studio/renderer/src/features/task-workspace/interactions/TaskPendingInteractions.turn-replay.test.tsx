import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { TaskInteractionSnapshotV1 } from '../../../../../shared/generated/contracts'
import { TaskPendingInteractions } from './TaskPendingInteractions'

const executor = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: executor.request }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'original-owner', isCurrent: executor.current }),
}))

const address = { deviceId: 'target', taskId: 'task', threadId: 'thread', workspacePath: '/owned',
  runtimeHandle: { threadId: 'thread', memoryTaskSnapshot: {
    snapshotId: null, threadId: 'thread', turnId: 'turn', attemptId: 'attempt',
    serverInstanceId: 'process', sequence: 12,
  } } }
const snapshot: TaskInteractionSnapshotV1 = {
  schemaVersion: 1, threadId: 'thread', observationState: 'observed', items: [{
    reference: { attemptId: 'attempt', selector: {
      serverId: 'process', threadId: 'thread', turnId: 'turn', requestId: 2000001,
      appServerEpoch: 'epoch', kind: 'question', questionId: 'question',
    } },
    state: 'pending', presentation: { approval: null, questions: [{
      id: 'choice', header: 'Sources', question: 'Which sources?', isOther: true,
      multiSelect: true, options: [{ label: 'Original source', description: '' }],
    }] },
  }],
}
const replayAddress = (attemptId = 'attempt') => ({ ...address, runtimeHandle: {
  ...address.runtimeHandle, memoryTaskSnapshot: {
    ...address.runtimeHandle.memoryTaskSnapshot, sequence: 42, attemptId,
  },
} })

afterEach(() => { cleanup(); executor.request.mockReset() })

async function fixture() {
  executor.request.mockImplementation(async (method, params) => method.endsWith('.read')
    ? structuredClone(snapshot) : { reference: params.response.reference, state: 'response_pending' })
  const view = render(<TaskPendingInteractions address={address} />)
  const card = await screen.findByTestId('request-user-input-card')
  fireEvent.click(screen.getByTestId('request-user-input-option-choice-0'))
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Keep the original draft' },
  })
  return { view, card }
}

test('a replayed start for the same attempt preserves the question draft and its original address', async () => {
  const { view, card } = await fixture()
  // Live turn/started projection advances its event sequence without changing
  // the task, app-server or accepted attempt used by interaction status reads.
  view.rerender(<TaskPendingInteractions address={replayAddress()} />)
  await screen.findByTestId('request-user-input-card')
  expect(card).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep the original draft')
  expect(screen.getByTestId('request-user-input-option-choice-0')).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await screen.findByText('states.response_pending')
  expect(executor.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toEqual([
    ['runtime.tasks.interactions.respond', { address, response: {
      reference: snapshot.items[0].reference,
      answers: { choice: { answers: ['Original source', 'Keep the original draft'] } },
    } }, expect.anything()],
  ])
})

test('a replayed start cannot abort or reopen an answer waiting for its original confirmation', async () => {
  const { view, card } = await fixture()
  let finish!: () => void
  let signal!: AbortSignal
  executor.request.mockImplementationOnce((_method, params, options) => {
    signal = options.signal
    return new Promise(resolve => {
      finish = () => resolve({ reference: params.response.reference, state: 'response_pending' })
    })
  })
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.rerender(<TaskPendingInteractions address={replayAddress()} />)
  expect(signal.aborted).toBe(false)
  await act(async () => finish())
  expect(card).toBeInTheDocument()
  expect(card).not.toBeVisible()
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep the original draft')
  expect(executor.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1)
})

test('a different accepted attempt still retires the original question draft', async () => {
  const { view, card } = await fixture()
  view.rerender(<TaskPendingInteractions address={replayAddress('replacement-attempt')} />)
  await screen.findByTestId('request-user-input-card')
  expect(card).not.toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('')
  expect(executor.request.mock.calls.some(([method]) => method.endsWith('.respond'))).toBe(false)
})
