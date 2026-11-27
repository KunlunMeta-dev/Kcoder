import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import {
  decideEvolutionProposal,
  listEvolutionRatings,
  readEvolutionSettings,
  readEvolutionStatus,
  readEvolutionTarget,
  supportsSelfEvolution,
} from './evolutionApi'
import { useEvolutionConversation } from './evolutionConversationContext'
import { publishEvolutionChanged } from './evolutionEvents'
import { defaultEvolutionSettings } from './evolutionSettingsModel'
import { EvolutionConversationProvider } from './EvolutionConversationProvider'

vi.mock('./evolutionApi', async importOriginal => ({
  ...(await importOriginal<typeof import('./evolutionApi')>()),
  supportsSelfEvolution: vi.fn(),
  readEvolutionStatus: vi.fn(),
  readEvolutionSettings: vi.fn(),
  readEvolutionTarget: vi.fn(),
  decideEvolutionProposal: vi.fn(),
  listEvolutionRatings: vi.fn(),
}))

function Probe() {
  const value = useEvolutionConversation()
  return <span data-testid="gate">{value?.ratingEnabled ? 'on' : 'off'}</span>
}

function enabledSettings(ratingUi = true) {
  const settings = defaultEvolutionSettings()
  return { settings: { ...settings, enabled: true, signals: { ...settings.signals, rating_ui: ratingUi } }, revision: 'r' }
}

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
  vi.mocked(supportsSelfEvolution).mockResolvedValue(true)
  vi.mocked(readEvolutionStatus).mockResolvedValue({
    enabled: true,
    mode: 'propose',
    model: { selection: 'follow_session', available: true },
    targets: [],
    usageThisMonth: { inputTokens: 0, outputTokens: 0 },
    jobs: [],
  })
  vi.mocked(readEvolutionSettings).mockResolvedValue(enabledSettings())
  vi.mocked(listEvolutionRatings).mockResolvedValue({ items: [], truncated: false })
})

const address = { deviceId: 'remote-a', taskId: 'task-1', workspacePath: '/repo' }

test('enables ratings only with the capability, evolution on and the rating signal on', async () => {
  const first = render(
    <EvolutionConversationProvider address={address}>
      <Probe />
    </EvolutionConversationProvider>
  )
  await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('on'))
  first.unmount()

  vi.mocked(readEvolutionSettings).mockResolvedValue(enabledSettings(false))
  const second = render(
    <EvolutionConversationProvider address={address}>
      <Probe />
    </EvolutionConversationProvider>
  )
  await waitFor(() => expect(readEvolutionSettings).toHaveBeenCalledTimes(2))
  expect(screen.getByTestId('gate')).toHaveTextContent('off')
  second.unmount()

  vi.mocked(supportsSelfEvolution).mockResolvedValue(false)
  render(
    <EvolutionConversationProvider address={address}>
      <Probe />
    </EvolutionConversationProvider>
  )
  await waitFor(() => expect(supportsSelfEvolution).toHaveBeenCalledTimes(3))
  expect(screen.getByTestId('gate')).toHaveTextContent('off')
  expect(readEvolutionSettings).toHaveBeenCalledTimes(2)
})

test('shows a one-line notice after promotion and undoes it by rolling back', async () => {
  vi.mocked(readEvolutionTarget).mockResolvedValue({
    summary: {
      targetKey: 'skill:project:deploy-check',
      type: 'skill',
      source: 'project',
      name: 'deploy-check',
      enabled: true,
      evolutionMode: 'overlay',
      stable: { revision: 's2', mean: 0.8, lower: 0.7, upper: 0.9, observations: 20 },
      pendingProposals: 0,
      needsRevalidation: false,
      pinned: false,
    },
    overlay: { stable: { lessons: '', examples: [] }, overlayRevision: 'ov-3' },
    patterns: [],
    proposals: [
      { id: 'old', state: 'promoted', createdAt: '2026-11-01T00:00:00Z', actor: 'auto', diff: '' },
      { id: 'new', state: 'promoted', createdAt: '2026-11-23T00:00:00Z', actor: 'auto', diff: '' },
    ],
  })
  vi.mocked(decideEvolutionProposal).mockResolvedValue({} as never)
  render(
    <EvolutionConversationProvider address={address}>
      <Probe />
    </EvolutionConversationProvider>
  )
  await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('on'))
  act(() => {
    // Another target's notification is ignored.
    publishEvolutionChanged({ deviceId: 'other', reason: 'promoted', targetKey: 'skill:project:deploy-check' })
    publishEvolutionChanged({ deviceId: 'remote-a', reason: 'promoted', targetKey: 'skill:project:deploy-check' })
  })
  const notice = await screen.findByTestId('evolution-promotion-notice')
  expect(notice).toHaveTextContent('Skill deploy-check learned a new lesson.')
  expect(readEvolutionTarget).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('evolution-promotion-undo'))
  await waitFor(() =>
    expect(decideEvolutionProposal).toHaveBeenCalledWith('remote-a', {
      workspace: '/repo',
      targetKey: 'skill:project:deploy-check',
      proposalId: 'new',
      decision: 'rollback',
      expectedRevision: 'ov-3',
    })
  )
  expect(await screen.findByText('The new lesson for deploy-check was rolled back.')).toBeInTheDocument()
})

function RatableProbe() {
  const value = useEvolutionConversation()
  return (
    <span data-testid="ratable">
      {value?.ratableTurns ? value.ratableTurns.map(turn => `${turn.turnId}:${turn.rating}`).join(',') : 'none'}
    </span>
  )
}

test('loads the server projection of ratable turns for the conversation, subagent included', async () => {
  vi.mocked(listEvolutionRatings).mockResolvedValue({
    items: [{ turnId: 'turn-4', toolCallIds: ['toolu_1'], targetKeys: ['skill:bundled:docx'], rating: 'down' }],
    truncated: false,
  })
  render(
    <EvolutionConversationProvider address={address} subagentId="agent-7">
      <RatableProbe />
    </EvolutionConversationProvider>
  )
  await waitFor(() => expect(screen.getByTestId('ratable')).toHaveTextContent('turn-4:down'))
  expect(listEvolutionRatings).toHaveBeenCalledWith({
    deviceId: 'remote-a',
    taskId: 'task-1',
    subagentId: 'agent-7',
  })
})
