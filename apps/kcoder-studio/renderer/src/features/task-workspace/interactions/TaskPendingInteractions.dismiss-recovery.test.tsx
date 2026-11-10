import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskPendingInteractions } from './TaskPendingInteractions'
import type { TaskInteractionSnapshotV1 } from '../../../../../shared/generated/contracts'

const f = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'original-owner', isCurrent: f.current }),
}))

afterEach(() => { cleanup(); f.request.mockReset() })

test('explicit refresh reopens a locally dismissed original question with its unsent draft', async () => {
  const address = { deviceId: 'native', taskId: 'task', threadId: 'thread', workspacePath: '/owned' }
  const snapshot: TaskInteractionSnapshotV1 = {
    schemaVersion: 1, threadId: 'thread', observationState: 'observed', items: [{
      reference: { attemptId: 'attempt', selector: {
        serverId: 'process', threadId: 'thread', turnId: 'turn', requestId: 2000001,
        appServerEpoch: 'epoch', kind: 'question', questionId: 'question',
      } },
      state: 'pending', presentation: { approval: null, questions: [{
        id: 'choice', header: 'Sources', question: 'Which sources?', isOther: true,
        multiSelect: true, options: [{ label: 'First source', description: '' }],
      }] },
    }],
  }
  f.request.mockImplementation(async (method, params) => method.endsWith('.read')
    ? structuredClone(snapshot) : { reference: params.response.reference, state: 'response_pending' })
  render(<TaskPendingInteractions address={address} />)
  const card = await screen.findByTestId('request-user-input-card')
  fireEvent.click(screen.getByTestId('request-user-input-option-choice-0'))
  fireEvent.change(screen.getByTestId('request-user-input-custom-choice'), {
    target: { value: 'Keep this unsent draft' },
  })
  fireEvent.click(screen.getByTestId('request-user-input-ignore-button'))
  expect(screen.getByTestId('request-user-input-summary')).toBeVisible()
  expect(card).not.toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(screen.getByTestId('request-user-input-card')).toBeVisible())
  expect(screen.getByTestId('request-user-input-card')).toBe(card)
  expect(screen.getByTestId('request-user-input-custom-choice')).toHaveValue('Keep this unsent draft')
  expect(screen.getByTestId('request-user-input-option-choice-0')).toHaveAttribute('aria-pressed', 'true')
  expect(f.request.mock.calls.some(([method]) => method.endsWith('.respond'))).toBe(false)
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1))
  expect(f.request.mock.calls.find(([method]) => method.endsWith('.respond'))?.[1]).toEqual({
    address, response: { reference: snapshot.items[0].reference,
      answers: { choice: { answers: ['First source', 'Keep this unsent draft'] } } },
  })
})
