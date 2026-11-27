import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { rateEvolutionTurn } from '@/kcoder/evolution/evolutionApi'
import {
  EvolutionConversationContext,
  type EvolutionConversationValue,
} from '@/kcoder/evolution/evolutionConversationContext'
import type { WorkbenchMessage } from '@/types/workbench'
import { EvolutionTurnRating } from './EvolutionTurnRating'

vi.mock('@/kcoder/evolution/evolutionApi', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kcoder/evolution/evolutionApi')>()),
  rateEvolutionTurn: vi.fn(),
}))

function message(toolName = 'skill', overrides: Partial<WorkbenchMessage> = {}): WorkbenchMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: 'Done',
    status: 'completed',
    createdAt: '2026-11-24T00:00:00Z',
    turnId: 'turn-1',
    blocks: [{ id: 'b1', type: 'tool', toolName, subtaskId: 's', status: 'done', createdAt: 0 }],
    ...overrides,
  } as unknown as WorkbenchMessage
}

function renderWith(value: Partial<EvolutionConversationValue> | null, item = message()) {
  const ratings = new Map()
  const context: EvolutionConversationValue | null = value
    ? {
        deviceId: 'remote-a',
        taskId: 'task-1',
        ratingEnabled: true,
        ratings,
        rememberRating: (turnId, rating) => ratings.set(turnId, rating),
        ratableTurns: [{ turnId: 'turn-1', toolCallIds: ['b1'], rating: null }],
        requestRatableTurns: vi.fn(),
        ...value,
      }
    : null
  return render(
    <EvolutionConversationContext.Provider value={context}>
      <EvolutionTurnRating message={item} />
    </EvolutionConversationContext.Provider>
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
  vi.mocked(rateEvolutionTurn).mockResolvedValue({ recorded: true })
})

test('renders nothing without a provider, when the gate is off, or when no skill was used', () => {
  const { unmount } = renderWith(null)
  expect(screen.queryByTestId('evolution-turn-rating')).toBeNull()
  unmount()
  const second = renderWith({ ratingEnabled: false })
  expect(screen.queryByTestId('evolution-turn-rating')).toBeNull()
  second.unmount()
  const third = renderWith({}, message('Read'))
  expect(screen.queryByTestId('evolution-turn-rating')).toBeNull()
  third.unmount()
  renderWith({}, message('skill', { status: 'streaming' } as Partial<WorkbenchMessage>))
  expect(screen.queryByTestId('evolution-turn-rating')).toBeNull()
})

test('rates the turn through its task and adds an optional reason to the same rating', async () => {
  renderWith({})
  fireEvent.click(screen.getByTestId('evolution-rate-down'))
  await waitFor(() =>
    expect(rateEvolutionTurn).toHaveBeenCalledWith({
      deviceId: 'remote-a',
      taskId: 'task-1',
      turnId: 'turn-1',
      toolCallIds: ['b1'],
      rating: 'down',
    })
  )
  fireEvent.click(await screen.findByTestId('evolution-rate-reason-open'))
  fireEvent.change(screen.getByTestId('evolution-rate-reason'), { target: { value: 'Wrong file' } })
  fireEvent.submit(screen.getByTestId('evolution-rate-reason').closest('form')!)
  await waitFor(() =>
    expect(rateEvolutionTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ rating: 'down', reason: 'Wrong file', turnId: 'turn-1' })
    )
  )
  expect(await screen.findByText('Reason recorded')).toBeInTheDocument()
})

test('rates a subagent turn with the child agent id', async () => {
  renderWith({ subagentId: 'agent-7' })
  fireEvent.click(screen.getByTestId('evolution-rate-up'))
  await waitFor(() =>
    expect(rateEvolutionTurn).toHaveBeenCalledWith({
      deviceId: 'remote-a',
      taskId: 'task-1',
      subagentId: 'agent-7',
      turnId: 'turn-1',
      toolCallIds: ['b1'],
      rating: 'up',
    })
  )
})

test('reports an unconfirmed rating when the request fails', async () => {
  vi.mocked(rateEvolutionTurn).mockRejectedValue(new Error('offline'))
  renderWith({})
  fireEvent.click(screen.getByTestId('evolution-rate-up'))
  expect(await screen.findByRole('alert')).toHaveTextContent('The rating could not be confirmed; try again later.')
})

test('offers the control only for turns the server lists, matched by skill call', async () => {
  const request = vi.fn()
  // A failed skill call recorded no usage.
  const failed = renderWith(
    { requestRatableTurns: request },
    message('skill', {
      blocks: [{ id: 'b1', type: 'tool', toolName: 'skill', subtaskId: 's', status: 'error', createdAt: 0 }],
    } as unknown as Partial<WorkbenchMessage>)
  )
  expect(screen.queryByTestId('evolution-turn-rating')).toBeNull()
  failed.unmount()
  // Not listed yet: hidden, and the projection is reloaded once.
  const unlisted = renderWith({ ratableTurns: [], requestRatableTurns: request })
  expect(screen.queryByTestId('evolution-turn-rating')).toBeNull()
  await waitFor(() => expect(request).toHaveBeenCalledWith('m1:b1'))
  unlisted.unmount()
  // A subagent view's own turn id differs; the recorded turn id is sent.
  renderWith({
    subagentId: 'agent-7',
    ratableTurns: [{ turnId: 'turn-2', toolCallIds: ['b1'], rating: 'up' }],
  }, message('skill', { turnId: 'assistant-item-9' } as Partial<WorkbenchMessage>))
  expect(screen.getByTestId('evolution-rate-up')).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(screen.getByTestId('evolution-rate-down'))
  await waitFor(() =>
    expect(rateEvolutionTurn).toHaveBeenCalledWith(
      expect.objectContaining({ subagentId: 'agent-7', turnId: 'turn-2', rating: 'down' })
    )
  )
})

test('explains a rating without a recorded usage and a disabled runtime', async () => {
  vi.mocked(rateEvolutionTurn).mockResolvedValueOnce({ recorded: false })
  const first = renderWith({})
  fireEvent.click(screen.getByTestId('evolution-rate-up'))
  expect(await screen.findByRole('alert')).toHaveTextContent('no recorded skill use')
  first.unmount()
  vi.mocked(rateEvolutionTurn).mockRejectedValueOnce({ code: -32050, data: { kind: 'evolution_disabled' } })
  renderWith({})
  fireEvent.click(screen.getByTestId('evolution-rate-up'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Self-evolution is off')
})
