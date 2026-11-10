import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { TaskPendingInteractions } from './TaskPendingInteractions'
import type { TaskInteractionSnapshotV1 } from '../../../../../shared/generated/contracts'

const f = vi.hoisted(() => ({ request: vi.fn(), current: () => true }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: f.request }))
const t = (key: string) => key
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'native', isCurrent: f.current }),
}))
afterEach(() => { cleanup(); f.request.mockReset() })

test.each(['implement', 'strategy'])('original question %s keeps every answer when a choice resembles a plan confirmation', async id => {
  const address = { deviceId: 'native', taskId: 'task', threadId: 'thread', workspacePath: '/owned' }
  const snapshot: TaskInteractionSnapshotV1 = {
    schemaVersion: 1, threadId: 'thread', observationState: 'observed', items: [{
      reference: { attemptId: 'attempt', selector: {
        serverId: 'process', threadId: 'thread', turnId: 'turn', requestId: 2000001,
        appServerEpoch: 'epoch', kind: 'question', questionId: 'question',
      } },
      state: 'pending', presentation: { approval: null, questions: [
        { id, header: 'Strategy', question: 'How should work proceed?', isOther: false,
          options: [{ label: '执行此计划', description: '' }, { label: 'Review first', description: '' }] },
        { id: 'scope', header: 'Scope', question: 'Which scope?', isOther: false,
          options: [{ label: 'All modules', description: '' }, { label: 'Selected module', description: '' }] },
      ] },
    }],
  }
  f.request.mockImplementation(async (method, params) => method.endsWith('.read')
    ? structuredClone(snapshot) : { reference: params.response.reference, state: 'response_pending' })
  render(<TaskPendingInteractions address={address} />)
  await screen.findByTestId('request-user-input-card')
  fireEvent.click(screen.getByText('执行此计划', { exact: true }))
  expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(0)
  fireEvent.click(screen.getByText('Selected module', { exact: true }))
  expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(0)
  fireEvent.click(screen.getByTestId('request-user-input-submit-button'))
  await waitFor(() => expect(f.request.mock.calls.filter(([method]) => method.endsWith('.respond'))).toHaveLength(1))
  expect(f.request.mock.calls.find(([method]) => method.endsWith('.respond'))?.[1]).toEqual({
    address, response: { reference: snapshot.items[0].reference,
      answers: { [id]: { answers: ['执行此计划'] }, scope: { answers: ['Selected module'] } } },
  })
  await screen.findByText('states.response_pending')
})
