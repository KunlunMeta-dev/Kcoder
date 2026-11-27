import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import {
  decideEvolutionProposal,
  readEvolutionSettings,
  distillEvolutionTarget,
  readEvolutionTarget,
  saveEvolutionSettings,
  updateEvolutionOverlay,
} from './evolutionApi'
import type { EvolutionTargetReadResult } from './evolutionContract'
import { defaultEvolutionSettings } from './evolutionSettingsModel'
import { EvolutionTargetSection } from './EvolutionTargetSection'
import { publishEvolutionChanged } from './evolutionEvents'
import { navigateTo } from '@/lib/navigation'

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))

vi.mock('./evolutionApi', async importOriginal => ({
  ...(await importOriginal<typeof import('./evolutionApi')>()),
  readEvolutionTarget: vi.fn(),
  distillEvolutionTarget: vi.fn(),
  decideEvolutionProposal: vi.fn(),
  updateEvolutionOverlay: vi.fn(),
  readEvolutionSettings: vi.fn(),
  saveEvolutionSettings: vi.fn(),
}))

const KEY = 'skill:project:deploy-check'

function target(): EvolutionTargetReadResult {
  return {
    summary: {
      targetKey: KEY,
      type: 'skill',
      source: 'project',
      name: 'deploy-check',
      enabled: true,
      evolutionMode: 'overlay',
      stable: { revision: 's1', mean: 0.62, lower: 0.5, upper: 0.71, observations: 40 },
      candidate: { revision: 'c1', mean: 0.75, lower: 0.6, upper: 0.85, observations: 12 },
      channelTraffic: 0.5,
      pendingProposals: 1,
      needsRevalidation: false,
      pinned: false,
    },
    overlay: {
      stable: { lessons: 'Run the smoke test first.', checklist: '', examples: [] },
      overlayRevision: 'ov-1',
    },
    patterns: [
      {
        id: 'p1',
        categories: ['procedure'],
        statement: 'Migrations need a dry run.',
        support: { usages: 9, sessions: 4, users: 1 },
        counterEvidence: 1,
        scope: 'target_overlay',
      },
    ],
    proposals: [
      {
        id: 'prop-1',
        state: 'evaluated',
        createdAt: '2026-11-20T10:00:00Z',
        actor: 'auto',
        diff: '+ Run a dry run before migrations.',
        evaluation: { winRate: 0.7, ties: 2, hardCheckRegressions: 0, diversityDelta: 0, completed: true },
      },
    ],
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
  vi.mocked(readEvolutionTarget).mockResolvedValue(target())
})

function open() {
  render(<EvolutionTargetSection deviceId="remote-a" targetKey={KEY} workspacePath="/repo" />)
  const section = screen.getByTestId('evolution-target-section') as HTMLDetailsElement
  expect(readEvolutionTarget).not.toHaveBeenCalled()
  section.open = true
  fireEvent(section, new Event('toggle'))
  return section
}

test('loads only when opened and shows scores, patterns and evaluated proposals', async () => {
  open()
  expect(await screen.findByTestId('evolution-detail-scores')).toHaveTextContent('Stable 62% (50%–71%) · 40 observations')
  expect(screen.getByTestId('evolution-detail-scores')).toHaveTextContent('Candidate 75% (60%–85%)')
  expect(readEvolutionTarget).toHaveBeenCalledWith('remote-a', KEY, '/repo')
  const pattern = screen.getByTestId('evolution-pattern')
  expect(pattern).toHaveTextContent('Migrations need a dry run.')
  expect(pattern).toHaveTextContent('Learned for this item')
  expect(pattern).toHaveTextContent('procedure')
  expect(pattern).toHaveTextContent('Uses 9 · sessions 4 · users 1 · counter-evidence 1')
  expect(screen.getByTestId('evolution-proposal-evaluation')).toHaveTextContent('Win rate 70%')
  expect(screen.getByTestId('evolution-detail-scores')).toHaveTextContent('Overlay')
})

test('accepts a proposal against the read revision', async () => {
  vi.mocked(decideEvolutionProposal).mockResolvedValue({ summary: target().summary })
  open()
  const proposal = await screen.findByTestId('evolution-proposal')
  expect(within(proposal).queryByTestId('evolution-proposal-rollback')).toBeNull()
  // Accepting an evaluated proposal approves evaluation and canary; it does not promote.
  expect(within(proposal).getByTestId('evolution-proposal-accept')).toHaveTextContent(
    'Approve evaluation and canary'
  )
  fireEvent.click(within(proposal).getByTestId('evolution-proposal-accept'))
  await waitFor(() =>
    expect(decideEvolutionProposal).toHaveBeenCalledWith('remote-a', {
      workspace: '/repo',
      targetKey: KEY,
      proposalId: 'prop-1',
      decision: 'accept',
      expectedRevision: 'ov-1',
    })
  )
  await waitFor(() => expect(readEvolutionTarget).toHaveBeenCalledTimes(2))
  expect(await screen.findByTestId('evolution-detail-notice')).toHaveAttribute('data-kind', 'decided.approve')
})

test('accepting a draft in propose mode only approves evaluation and keeps the draft state', async () => {
  const draft = target()
  draft.proposals[0] = { ...draft.proposals[0], state: 'draft', evaluation: null }
  vi.mocked(readEvolutionTarget).mockResolvedValue(draft)
  vi.mocked(decideEvolutionProposal).mockResolvedValue({ summary: draft.summary })
  open()
  const proposal = await screen.findByTestId('evolution-proposal')
  expect(proposal).toHaveAttribute('data-state', 'draft')
  fireEvent.click(within(proposal).getByTestId('evolution-proposal-accept'))
  const notice = await screen.findByTestId('evolution-detail-notice')
  expect(notice).toHaveAttribute('data-kind', 'decided.approve')
  expect(notice).toHaveTextContent('evaluated and then rolled out gradually')
  await waitFor(() => expect(readEvolutionTarget).toHaveBeenCalledTimes(2))
  // The server reports `proposal`; the state is unchanged and approval stays available.
  publishEvolutionChanged({ deviceId: 'remote-a', reason: 'proposal', targetKey: KEY })
  await waitFor(() => expect(readEvolutionTarget).toHaveBeenCalledTimes(3))
  const again = await screen.findByTestId('evolution-proposal')
  expect(again).toHaveAttribute('data-state', 'draft')
  expect(within(again).getByTestId('evolution-proposal-accept')).toHaveTextContent('Approve evaluation and canary')
})

test('shows the server notice after a rollback that kept user-edited files', async () => {
  const promoted = target()
  promoted.proposals[0] = { ...promoted.proposals[0], state: 'promoted' }
  vi.mocked(readEvolutionTarget).mockResolvedValue(promoted)
  vi.mocked(decideEvolutionProposal).mockResolvedValue({
    summary: promoted.summary,
    notice: 'Skill files were edited after promotion; only the overlay was reverted.',
  })
  open()
  const proposal = await screen.findByTestId('evolution-proposal')
  fireEvent.click(within(proposal).getByTestId('evolution-proposal-rollback'))
  expect(await screen.findByTestId('evolution-detail-warning')).toHaveTextContent(
    'Note: Skill files were edited after promotion; only the overlay was reverted.'
  )
  expect(screen.getByTestId('evolution-detail-notice')).toHaveAttribute('data-kind', 'decided.rollback')
})

test('explains an unavailable model for distillation and links to the settings page', async () => {
  vi.mocked(distillEvolutionTarget).mockResolvedValue({
    outcome: 'model_unavailable',
    reason: 'No open session to follow.',
  })
  open()
  fireEvent.click(await screen.findByTestId('evolution-detail-distill'))
  const notice = await screen.findByTestId('evolution-detail-notice')
  expect(notice).toHaveTextContent('No open session to follow.')
  expect(screen.getByTestId('evolution-detail-model-hint')).toHaveTextContent('open a conversation')
  fireEvent.click(screen.getByTestId('evolution-detail-open-settings'))
  expect(navigateTo).toHaveBeenCalledWith('/settings/personal/self-evolution')
})

test('labels canary acceptance as promotion and refetches on evolution/changed', async () => {
  const canary = target()
  canary.proposals[0] = { ...canary.proposals[0], state: 'canary', evaluation: { completed: false, ties: 0, hardCheckRegressions: 0, winRate: null } }
  vi.mocked(readEvolutionTarget).mockResolvedValue(canary)
  open()
  const proposal = await screen.findByTestId('evolution-proposal')
  expect(within(proposal).getByTestId('evolution-proposal-accept')).toHaveTextContent('Promote')
  expect(within(proposal).getByTestId('evolution-proposal-pin_stable')).toBeInTheDocument()
  expect(within(proposal).getByTestId('evolution-proposal-evaluation')).toHaveTextContent('win rate so far unknown')
  publishEvolutionChanged({ deviceId: 'other', reason: 'promoted', targetKey: KEY })
  publishEvolutionChanged({ deviceId: 'remote-a', reason: 'proposal', targetKey: 'skill:user:other' })
  publishEvolutionChanged({ deviceId: 'remote-a', reason: 'promoted', targetKey: KEY })
  await waitFor(() => expect(readEvolutionTarget).toHaveBeenCalledTimes(2))
})

test.each([
  ['queued', 'Distillation is queued'],
  ['disabled', 'turned off'],
  ['unknown_target', 'no longer knows this item'],
  ['model_unavailable', 'model is unavailable'],
] as const)('reports the %s distill outcome', async (outcome, text) => {
  vi.mocked(distillEvolutionTarget).mockResolvedValue({ outcome })
  open()
  fireEvent.click(await screen.findByTestId('evolution-detail-distill'))
  await waitFor(() => expect(distillEvolutionTarget).toHaveBeenCalledWith('remote-a', KEY, '/repo'))
  const notice = await screen.findByTestId('evolution-detail-notice')
  expect(notice).toHaveAttribute('data-kind', `distill.${outcome}`)
  expect(notice).toHaveTextContent(text)
  expect(notice).toHaveAttribute('role', outcome === 'queued' ? 'status' : 'alert')
})

test('saves an overlay edit and shows the rejection reason from the target', async () => {
  vi.mocked(updateEvolutionOverlay).mockRejectedValue(
    Object.assign(new Error('rejected'), {
      data: { kind: 'evolution_content_rejected', reason: 'Contains a credential-like value' },
    })
  )
  open()
  const lessons = await screen.findByTestId('evolution-overlay-lessons')
  expect(screen.getByTestId('evolution-overlay-save')).toBeDisabled()
  fireEvent.change(lessons, { target: { value: 'Use token=abc' } })
  fireEvent.click(screen.getByTestId('evolution-overlay-save'))
  await waitFor(() =>
    expect(updateEvolutionOverlay).toHaveBeenCalledWith(
      'remote-a',
      KEY,
      { lessons: 'Use token=abc', checklist: '', examples: [] },
      'ov-1',
      '/repo'
    )
  )
  const notice = await screen.findByTestId('evolution-detail-notice')
  expect(notice).toHaveAttribute('data-kind', 'rejected')
  expect(notice).toHaveTextContent('Contains a credential-like value')
  // The draft stays for the user to fix.
  expect(lessons).toHaveValue('Use token=abc')
})

test('turns evolution off for this item with a revision-checked settings write', async () => {
  vi.mocked(readEvolutionSettings).mockResolvedValue({ settings: defaultEvolutionSettings(), revision: 'r7' })
  vi.mocked(saveEvolutionSettings).mockResolvedValue({ settings: defaultEvolutionSettings(), revision: 'r8' })
  open()
  fireEvent.click(await screen.findByTestId('evolution-detail-toggle'))
  await waitFor(() => expect(saveEvolutionSettings).toHaveBeenCalled())
  const [server, settings, revision] = vi.mocked(saveEvolutionSettings).mock.calls[0]
  expect(server).toBe('remote-a')
  expect(revision).toBe('r7')
  expect(settings.targets.skill.items).toEqual({ [KEY]: { enabled: false } })
})

test('explains an object without evolution data', async () => {
  vi.mocked(readEvolutionTarget).mockRejectedValue(
    Object.assign(new Error('missing'), { data: { kind: 'evolution_target_not_found' } })
  )
  open()
  expect(await screen.findByText('No evolution data for this item yet.')).toBeInTheDocument()
})
