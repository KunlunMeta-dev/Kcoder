import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskPendingInteractions } from './TaskPendingInteractions'
import type { TaskInteractionSnapshotV1 } from '../../../../../shared/generated/contracts'

const f = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (deviceId: string) => ({ key: deviceId, isCurrent: f.current }),
}))

const address = { deviceId: 'native', taskId: 'task', threadId: 'thread', workspacePath: '/owned' }
const snapshot: TaskInteractionSnapshotV1 = {
  schemaVersion: 1, threadId: address.threadId, observationState: 'observed', items: [{
    reference: { attemptId: 'attempt', selector: {
      serverId: 'process', threadId: address.threadId, turnId: 'turn', requestId: 2000001,
      appServerEpoch: 'epoch', kind: 'question', questionId: 'question',
    } },
    state: 'pending', presentation: { approval: null, questions: [{
      id: 'choice', header: 'Original question', question: 'Which sources?', isOther: true,
      multiSelect: true, options: [
        { label: 'First source', description: 'Original first choice' },
        { label: 'Second source', description: 'Original second choice' },
      ],
    }] },
  }],
}

afterEach(() => { cleanup(); f.request.mockReset() })

async function draft() {
  f.request.mockImplementation(async (method, params) => method.endsWith('.read')
    ? structuredClone(snapshot) : { reference: params.response.reference, state: 'response_pending' })
  render(<TaskPendingInteractions address={address} />)
  const card = await screen.findByTestId('request-user-input-card')
  fireEvent.click(screen.getByText('Second source', { exact: true }))
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Keep this unsent original draft' },
  })
  return card
}

async function submitOriginalDraft() {
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1))
  expect(f.request.mock.calls.find(([method]) => method.endsWith('.respond'))?.[1]).toEqual({
    address, response: { reference: snapshot.items[0].reference,
      answers: { choice: { answers: ['Second source', 'Keep this unsent original draft'] } } },
  })
}

test('manual receipt refresh keeps the mounted original card and its unsent selection and text', async () => {
  const card = await draft()
  let finish!: () => void
  f.request.mockImplementationOnce(() => new Promise(resolve => {
    finish = () => resolve(structuredClone(snapshot))
  }))
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(card).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep this unsent original draft')
  await act(async () => finish())
  await submitOriginalDraft()
})

test.each(['pending', 'resolved'] as const)('a failed poll retains a disabled draft until the original receipt becomes %s', async state => {
  const card = await draft()
  f.request.mockRejectedValueOnce(new Error('Original receipt connection unavailable'))
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await screen.findByText('errors.unavailable')
  expect(card).toBeInTheDocument()
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep this unsent original draft')
  expect(screen.getByTestId('request-user-input-custom-choice')).toBeDisabled()
  expect(screen.getByTestId('request-user-input-submit-button')).toBeDisabled()
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  expect(f.request.mock.calls.some(([method]) => method.endsWith('.respond'))).toBe(false)
  const recovered = structuredClone(snapshot)
  recovered.items[0].state = state
  f.request.mockResolvedValueOnce(recovered)
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(screen.queryByText('errors.unavailable')).toBeNull())
  if (state === 'resolved') {
    expect(screen.queryByTestId('request-user-input-card')).toBeNull()
    expect(f.request.mock.calls.some(([method]) => method.endsWith('.respond'))).toBe(false)
  } else {
    expect(screen.getByTestId('request-user-input-custom-choice')).not.toBeDisabled()
    await submitOriginalDraft()
  }
})
