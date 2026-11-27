import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import {
  clearEvolutionData,
  listEvolutionTargets,
  readEvolutionSettings,
  readEvolutionStatus,
  saveEvolutionSettings,
  supportsSelfEvolution,
} from '@/kcoder/evolution/evolutionApi'
import type {
  EvolutionSettings,
  EvolutionStatusResult,
} from '@/kcoder/evolution/evolutionContract'
import { defaultEvolutionSettings } from '@/kcoder/evolution/evolutionSettingsModel'
import { publishEvolutionChanged } from '@/kcoder/evolution/evolutionEvents'
import type { UnifiedModel } from '@/types/api'
import { SelfEvolutionSettingsPage } from './SelfEvolutionSettingsPage'

vi.mock('@/features/runtime-target/useRuntimeSettingsTargets', () => ({
  useRuntimeSettingsTargets: () => ({
    selectedServerId: 'remote-a',
    selectedTarget: { id: 'remote-a', label: 'Build host', transport: 'ssh' },
    targets: [{ id: 'remote-a', label: 'Build host' }],
    selectTarget: vi.fn(),
    loading: false,
    error: null,
  }),
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'remote-a', isCurrent: () => true }),
}))
vi.mock('@/kcoder/evolution/evolutionApi', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kcoder/evolution/evolutionApi')>()),
  supportsSelfEvolution: vi.fn(),
  readEvolutionSettings: vi.fn(),
  saveEvolutionSettings: vi.fn(),
  readEvolutionStatus: vi.fn(),
  listEvolutionTargets: vi.fn(),
  listEvolutionPreferences: vi.fn(),
  clearEvolutionData: vi.fn(),
}))

function runtimeModel(provider: string, modelId: string | null, extra: Partial<UnifiedModel> = {}): UnifiedModel {
  return {
    name: `${provider}:${modelId}`,
    type: 'runtime',
    displayName: modelId,
    provider: 'local',
    modelId,
    config: { codexProviderId: provider, codexProviderName: provider.toUpperCase() },
    ...extra,
  }
}

const models: UnifiedModel[] = [
  runtimeModel('OpenAI-Main', 'GPT-Large'),
  runtimeModel('local-llm', 'qwen3'),
  // Placeholder rows without a model ID are not configured models.
  runtimeModel('broken', null, { displayName: 'Model unavailable' }),
]

function status(overrides: Partial<EvolutionStatusResult> = {}): EvolutionStatusResult {
  return {
    enabled: false,
    mode: 'propose',
    disabledReason: null,
    model: { selection: 'follow_session', available: true },
    targets: [
      { type: 'skill', enabled: true, implemented: true, learnedItems: 3, pendingProposals: 1 },
      { type: 'preference', enabled: true, implemented: true, learnedItems: 0, pendingProposals: 0 },
      { type: 'project_knowledge', enabled: true, implemented: false, learnedItems: 0, pendingProposals: 0 },
      { type: 'tool_usage', enabled: false, implemented: false, learnedItems: 0, pendingProposals: 0 },
      { type: 'workflow_template', enabled: false, implemented: false, learnedItems: 0, pendingProposals: 0 },
    ],
    usageThisMonth: { inputTokens: 1200, outputTokens: 300, estimatedCost: null },
    jobs: [],
    ...overrides,
  }
}

function settingsResult(settings: EvolutionSettings = defaultEvolutionSettings(), revision = 'rev-1') {
  return { settings, revision }
}

function renderPage() {
  const value = {
    services: { modelApi: { listModels: vi.fn().mockResolvedValue({ data: models }) } },
    state: { currentRuntimeTask: { deviceId: 'remote-a', taskId: 'task-1', workspacePath: '/repo' } },
  } as unknown as WorkbenchContextValue
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
  )
  return render(<SelfEvolutionSettingsPage />, { wrapper })
}

beforeEach(async () => {
  vi.clearAllMocks()
  window.localStorage.clear()
  await i18n.changeLanguage('en')
  vi.mocked(supportsSelfEvolution).mockResolvedValue(true)
  vi.mocked(readEvolutionSettings).mockResolvedValue(settingsResult())
  vi.mocked(readEvolutionStatus).mockResolvedValue(status())
  vi.mocked(saveEvolutionSettings).mockImplementation(async (_server, settings) =>
    settingsResult(settings, 'rev-2')
  )
  vi.mocked(listEvolutionTargets).mockResolvedValue({ items: [] })
})

async function editor() {
  return screen.findByTestId('self-evolution-editor')
}

test('shows the runtime target and an unsupported notice when the capability is absent', async () => {
  vi.mocked(supportsSelfEvolution).mockResolvedValue(false)
  renderPage()
  expect(await screen.findByTestId('self-evolution-unsupported')).toHaveTextContent(
    "Not supported by this target's version"
  )
  expect(screen.getByTestId('self-evolution-target-name')).toHaveTextContent('Build host')
  expect(readEvolutionSettings).not.toHaveBeenCalled()
})

test('locks controls with the reason in training mode', async () => {
  vi.mocked(readEvolutionStatus).mockResolvedValue(status({ disabledReason: 'training_mode' }))
  renderPage()
  const reason = await screen.findByTestId('self-evolution-disabled-reason')
  expect(reason).toHaveTextContent('training mode')
  expect(screen.getByTestId('self-evolution-master')).toBeDisabled()
  expect(screen.getByTestId('self-evolution-mode-auto')).toBeDisabled()
})

test('keeps controls usable but explains an unavailable model', async () => {
  vi.mocked(readEvolutionStatus).mockResolvedValue(status({ disabledReason: 'model_unavailable' }))
  renderPage()
  expect(await screen.findByTestId('self-evolution-disabled-reason')).toHaveAttribute(
    'data-reason',
    'model_unavailable'
  )
  await waitFor(() => expect(screen.getByTestId('self-evolution-master')).toBeEnabled())
})

test('explains extra model calls the first time the master switch is turned on', async () => {
  renderPage()
  await editor()
  fireEvent.click(screen.getByTestId('self-evolution-master'))
  const dialog = await screen.findByTestId('self-evolution-cost-dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(saveEvolutionSettings).not.toHaveBeenCalled()

  fireEvent.click(screen.getByTestId('self-evolution-master'))
  fireEvent.click(await screen.findByTestId('self-evolution-cost-confirm'))
  await waitFor(() =>
    expect(saveEvolutionSettings).toHaveBeenCalledWith(
      'remote-a',
      expect.objectContaining({ enabled: true }),
      'rev-1'
    )
  )
  // Turning it off and on again does not repeat the explanation.
  await waitFor(() => expect(screen.getByTestId('self-evolution-master')).toBeEnabled())
  fireEvent.click(screen.getByTestId('self-evolution-master'))
  await waitFor(() => expect(saveEvolutionSettings).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByTestId('self-evolution-master')).toBeEnabled())
  fireEvent.click(screen.getByTestId('self-evolution-master'))
  await waitFor(() => expect(saveEvolutionSettings).toHaveBeenCalledTimes(3))
  expect(screen.queryByTestId('self-evolution-cost-dialog')).toBeNull()
})

test('saves the mode with the observed revision and warns about automatic application', async () => {
  renderPage()
  await editor()
  // The warning is laid out with the Auto option up front, so choosing it inserts nothing.
  const warning = screen.getByTestId('self-evolution-auto-warning')
  expect(warning).toHaveAttribute('data-active', 'false')
  fireEvent.click(screen.getByTestId('self-evolution-mode-auto'))
  await waitFor(() =>
    expect(saveEvolutionSettings).toHaveBeenCalledWith(
      'remote-a',
      expect.objectContaining({ mode: 'auto' }),
      'rev-1'
    )
  )
  await waitFor(() => expect(warning).toHaveAttribute('data-active', 'true'))
  expect(warning).toHaveTextContent('roll them back')
  expect(screen.getByTestId('self-evolution-auto-warning')).toBe(warning)
})

test('reports saving in a slot that exists before the save and adds no rows above the controls', async () => {
  let finish: (() => void) | undefined
  vi.mocked(saveEvolutionSettings).mockImplementation(
    (_server, settings) =>
      new Promise(resolve => {
        finish = () => resolve(settingsResult(settings, 'rev-2'))
      })
  )
  renderPage()
  const root = await editor()
  const slot = screen.getByTestId('self-evolution-save-status')
  expect(slot).toHaveAttribute('aria-live', 'polite')
  expect(slot).toHaveAttribute('data-status', 'idle')
  const before = Array.from(root.children)
  fireEvent.click(screen.getByTestId('self-evolution-signal-rating_ui'))
  await waitFor(() => expect(slot).toHaveAttribute('data-status', 'saving'))
  expect(slot).toHaveAttribute('role', 'status')
  expect(Array.from(root.children)).toEqual(before)
  await act(async () => finish?.())
  await waitFor(() => expect(slot).toHaveAttribute('data-status', 'saved'))
  expect(screen.getByTestId('self-evolution-save-status')).toBe(slot)
  expect(Array.from(root.children)).toEqual(before)
})

test('marks unimplemented types as coming soon and saves type and item switches', async () => {
  vi.mocked(listEvolutionTargets).mockResolvedValue({
    items: [
      {
        targetKey: 'skill:project:deploy-check',
        type: 'skill',
        source: 'project',
        name: 'deploy-check',
        enabled: true,
        evolutionMode: 'overlay',
        stable: { revision: 's1', mean: 0.7, lower: 0.6, upper: 0.8, observations: 12 },
        pendingProposals: 0,
        needsRevalidation: false,
        pinned: false,
      },
    ],
  })
  renderPage()
  await editor()
  const knowledge = screen.getByTestId('self-evolution-target-project_knowledge')
  expect(knowledge).toHaveTextContent('Coming soon')
  expect(screen.getByTestId('self-evolution-target-toggle-project_knowledge')).toBeDisabled()
  expect(screen.getByTestId('self-evolution-target-skill')).toHaveTextContent('Learned items: 3')

  fireEvent.click(screen.getByTestId('self-evolution-target-toggle-preference'))
  await waitFor(() =>
    expect(vi.mocked(saveEvolutionSettings).mock.calls[0][1].targets.preference.enabled).toBe(false)
  )

  fireEvent.click(screen.getByTestId('self-evolution-target-open-skill'))
  const row = await screen.findByTestId('evolution-target-row')
  expect(listEvolutionTargets).toHaveBeenCalledWith('remote-a', 'skill', {})
  await waitFor(() => expect(within(row).getByRole('switch')).toBeEnabled())
  fireEvent.click(within(row).getByRole('switch'))
  await waitFor(() =>
    expect(vi.mocked(saveEvolutionSettings).mock.calls[1][1].targets.skill.items).toEqual({
      'skill:project:deploy-check': { enabled: false },
    })
  )
  // The direct-edit switch stays hidden until the target reports support.
  expect(screen.queryByTestId('self-evolution-allow-file-edits')).toBeNull()
})

test('lists only the follow-session option and configured models, saving a case-preserved reference', async () => {
  renderPage()
  await editor()
  const select = screen.getByTestId('self-evolution-model') as HTMLSelectElement
  await waitFor(() => expect(select.options).toHaveLength(3))
  expect(Array.from(select.options).map(option => option.textContent)).toEqual([
    'Follow current session model',
    'GPT-Large · OPENAI-MAIN',
    'qwen3 · LOCAL-LLM',
  ])
  expect(select.value).toBe('follow_session')
  fireEvent.change(select, { target: { value: select.options[1].value } })
  await waitFor(() =>
    expect(saveEvolutionSettings).toHaveBeenCalledWith(
      'remote-a',
      expect.objectContaining({ model: { provider: 'OpenAI-Main', model: 'GPT-Large' } }),
      'rev-1'
    )
  )
})

test('keeps a removed model selected and marks it unavailable instead of falling back', async () => {
  vi.mocked(readEvolutionSettings).mockResolvedValue(
    settingsResult({ ...defaultEvolutionSettings(), model: { provider: 'gone', model: 'Old-Model' } })
  )
  renderPage()
  expect(await screen.findByTestId('self-evolution-model-unavailable')).toBeInTheDocument()
  const select = screen.getByTestId('self-evolution-model') as HTMLSelectElement
  expect(select.selectedOptions[0].textContent).toBe('Old-Model · gone (unavailable)')
  expect(select.selectedOptions[0].disabled).toBe(true)
  expect(saveEvolutionSettings).not.toHaveBeenCalled()
})

test('blocks saving out-of-range advanced values and restores defaults', async () => {
  vi.mocked(readEvolutionSettings).mockResolvedValue(
    settingsResult({ ...defaultEvolutionSettings(), candidate_traffic: 0.2, promote_threshold: 0.9 })
  )
  renderPage()
  await editor()
  const save = screen.getByTestId('evolution-advanced-save')
  fireEvent.change(screen.getByTestId('evolution-advanced-candidate_traffic'), {
    target: { value: '1.5' },
  })
  expect(screen.getByText('Enter a number greater than 0 and at most 1.')).toBeInTheDocument()
  expect(save).toBeDisabled()
  fireEvent.change(screen.getByTestId('evolution-advanced-candidate_traffic'), {
    target: { value: '0.3' },
  })
  fireEvent.change(screen.getByTestId('evolution-advanced-rollback_threshold'), {
    target: { value: '0.95' },
  })
  expect(screen.getByText('Must be lower than the promotion threshold.')).toBeInTheDocument()
  expect(save).toBeDisabled()
  fireEvent.change(screen.getByTestId('evolution-advanced-rollback_threshold'), {
    target: { value: '0.2' },
  })
  fireEvent.change(screen.getByTestId('evolution-advanced-monthly_max_tokens'), {
    target: { value: '50000' },
  })
  expect(save).toBeEnabled()
  fireEvent.click(save)
  await waitFor(() =>
    expect(saveEvolutionSettings).toHaveBeenLastCalledWith(
      'remote-a',
      expect.objectContaining({
        candidate_traffic: 0.3,
        rollback_threshold: 0.2,
        usage_limit: { monthly_max_tokens: 50000 },
      }),
      'rev-1'
    )
  )
  await waitFor(() => expect(screen.getByTestId('evolution-advanced-restore')).toBeEnabled())
  fireEvent.click(screen.getByTestId('evolution-advanced-restore'))
  await waitFor(() =>
    expect(saveEvolutionSettings).toHaveBeenLastCalledWith(
      'remote-a',
      expect.objectContaining({
        candidate_traffic: 0.5,
        promote_threshold: 0.8,
        rollback_threshold: 0.3,
        usage_limit: { monthly_max_tokens: null },
        stage_models: { classifier: null, distill: null, eval: null },
        eval: { win_rate: 0.6, max_diversity_drop: 0.1 },
      }),
      'rev-2'
    )
  )
})

test('validates and saves the evaluation thresholds', async () => {
  renderPage()
  await editor()
  const save = screen.getByTestId('evolution-advanced-save')
  fireEvent.change(screen.getByTestId('evolution-advanced-win_rate'), { target: { value: '0.45' } })
  expect(screen.getByText('Enter a number from 0.5 to 1.')).toBeInTheDocument()
  fireEvent.change(screen.getByTestId('evolution-advanced-win_rate'), { target: { value: '0.75' } })
  fireEvent.change(screen.getByTestId('evolution-advanced-max_diversity_drop'), { target: { value: '0.7' } })
  expect(screen.getByText('Enter a number from 0 to 0.5.')).toBeInTheDocument()
  expect(save).toBeDisabled()
  fireEvent.change(screen.getByTestId('evolution-advanced-max_diversity_drop'), { target: { value: '0.2' } })
  fireEvent.click(save)
  await waitFor(() =>
    expect(vi.mocked(saveEvolutionSettings).mock.calls[0][1].eval).toEqual({
      win_rate: 0.75,
      max_diversity_drop: 0.2,
    })
  )
})

test('refetches status on a background evolution/changed event for this target', async () => {
  renderPage()
  await editor()
  await waitFor(() => expect(readEvolutionStatus).toHaveBeenCalledTimes(1))
  act(() => {
    publishEvolutionChanged({ deviceId: 'other', reason: 'proposal' })
    publishEvolutionChanged({ deviceId: 'remote-a', reason: 'proposal', targetKey: 'skill:user_created:x' })
  })
  await waitFor(() => expect(readEvolutionStatus).toHaveBeenCalledTimes(2))
})

test('clears local data only after a second confirmation, with all as the default scope', async () => {
  vi.mocked(clearEvolutionData).mockResolvedValue({ cleared: true })
  renderPage()
  await editor()
  fireEvent.click(screen.getByTestId('evolution-clear-data'))
  expect(await screen.findByTestId('evolution-clear-scope-all')).toBeChecked()
  fireEvent.click(screen.getByTestId('evolution-clear-continue'))
  expect(clearEvolutionData).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByTestId('evolution-clear-confirm'))
  await waitFor(() => expect(clearEvolutionData).toHaveBeenCalledWith('remote-a', 'all', undefined))
  expect(await screen.findByTestId('evolution-clear-outcome')).toHaveTextContent('cleared')

  fireEvent.click(screen.getByTestId('evolution-clear-data'))
  fireEvent.click(await screen.findByTestId('evolution-clear-scope-user'))
  fireEvent.click(screen.getByTestId('evolution-clear-continue'))
  expect(screen.getByTestId('evolution-clear-dialog')).toHaveTextContent('Personal data only')
  fireEvent.click(await screen.findByTestId('evolution-clear-confirm'))
  await waitFor(() => expect(clearEvolutionData).toHaveBeenLastCalledWith('remote-a', 'user', undefined))

  // Project scope uses the workspace of the current conversation on this target.
  fireEvent.click(screen.getByTestId('evolution-clear-data'))
  fireEvent.click(await screen.findByTestId('evolution-clear-scope-project'))
  fireEvent.click(screen.getByTestId('evolution-clear-continue'))
  fireEvent.click(await screen.findByTestId('evolution-clear-confirm'))
  await waitFor(() => expect(clearEvolutionData).toHaveBeenLastCalledWith('remote-a', 'project', '/repo'))
})

test('prompts a refresh on a revision conflict and never retries the write', async () => {
  vi.mocked(saveEvolutionSettings).mockRejectedValue(
    Object.assign(new Error('conflict'), { data: { kind: 'evolution_revision_conflict' } })
  )
  renderPage()
  await editor()
  fireEvent.click(screen.getByTestId('self-evolution-signal-rating_ui'))
  const notice = await screen.findByTestId('self-evolution-notice')
  expect(notice).toHaveAttribute('data-notice', 'conflict')
  expect(saveEvolutionSettings).toHaveBeenCalledTimes(1)
  // The shown value returns to the verified snapshot and further writes are blocked.
  expect(screen.getByTestId('self-evolution-signal-rating_ui')).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByTestId('self-evolution-signal-rating_ui')).toBeDisabled()
  vi.mocked(readEvolutionSettings).mockResolvedValue(settingsResult(defaultEvolutionSettings(), 'rev-9'))
  await act(async () => {
    fireEvent.click(screen.getByTestId('self-evolution-refresh'))
  })
  await waitFor(() => expect(screen.queryByTestId('self-evolution-notice')).toBeNull())
  expect(readEvolutionSettings).toHaveBeenCalledTimes(2)
  expect(screen.getByTestId('self-evolution-signal-rating_ui')).toBeEnabled()
})

test('shows the direct-edit switch when supported, evolution modes and skipped project scope', async () => {
  vi.mocked(readEvolutionStatus).mockResolvedValue(
    status({
      skillFileEditsSupported: true,
      diagnostics: {
        duplicateRecords: 0,
        futureRecords: 0,
        invalidRecords: 0,
        tornTail: false,
        projectScopeIssue: 'data_root_inside_project',
      },
    })
  )
  vi.mocked(listEvolutionTargets).mockResolvedValue({
    items: [
      {
        targetKey: 'skill:user_created:notes',
        type: 'skill',
        source: 'user_created',
        name: 'notes',
        enabled: true,
        evolutionMode: 'skill_file',
        stable: { revision: 'r', mean: 0.5, lower: 0.4, upper: 0.6, observations: 3 },
        pendingProposals: 0,
        needsRevalidation: false,
        pinned: false,
      },
    ],
  })
  renderPage()
  expect(await screen.findByTestId('self-evolution-project-scope-issue')).toHaveTextContent(
    'Project-scope learning is skipped'
  )
  const allow = screen.getByTestId('self-evolution-allow-file-edits')
  await waitFor(() => expect(allow).toBeEnabled())
  fireEvent.click(allow)
  await waitFor(() =>
    expect(vi.mocked(saveEvolutionSettings).mock.calls[0][1].targets.skill.allow_file_edits).toBe(true)
  )
  await waitFor(() => expect(screen.getByTestId('self-evolution-target-open-skill')).toBeEnabled())
  fireEvent.click(screen.getByTestId('self-evolution-target-open-skill'))
  expect(await screen.findByTestId('evolution-target-row')).toHaveTextContent('Skill file')
})

test('renders the server-read mode and preserves settings keys this client does not know', async () => {
  const read = {
    ...defaultEvolutionSettings(),
    mode: 'observe' as const,
    eval: { win_rate: 0.6, max_diversity_drop: 0.1 },
  }
  vi.mocked(readEvolutionSettings).mockResolvedValue(settingsResult(read as EvolutionSettings))
  renderPage()
  await editor()
  expect(screen.getByTestId('self-evolution-mode-observe')).toBeChecked()
  fireEvent.click(screen.getByTestId('self-evolution-signal-chat_corrections'))
  await waitFor(() => expect(saveEvolutionSettings).toHaveBeenCalled())
  expect(vi.mocked(saveEvolutionSettings).mock.calls[0][1]).toMatchObject({
    mode: 'observe',
    eval: { win_rate: 0.6, max_diversity_drop: 0.1 },
    signals: { chat_corrections: false },
  })
})

test('shows this month usage as display-only text', async () => {
  renderPage()
  expect(await screen.findByTestId('self-evolution-usage')).toHaveTextContent(
    '1,200 input tokens · 300 output tokens · cost estimate unavailable'
  )
})

test('renders the editor complete once first reads settle instead of inserting notices later', async () => {
  let resolveStatus: ((value: EvolutionStatusResult) => void) | undefined
  vi.mocked(readEvolutionStatus).mockImplementation(
    () => new Promise(resolve => (resolveStatus = resolve))
  )
  renderPage()
  await waitFor(() => expect(readEvolutionSettings).toHaveBeenCalled())
  await waitFor(() => expect(resolveStatus).toBeDefined())
  // Settings alone do not mount the editor: its rows would change once status arrives.
  expect(screen.queryByTestId('self-evolution-editor')).toBeNull()
  await act(async () => resolveStatus?.(status({ disabledReason: 'usage_limit' })))
  const root = await editor()
  // The reason, implemented-type controls and usage are part of the first editor render.
  expect(within(root).getByTestId('self-evolution-disabled-reason')).toBeInTheDocument()
  expect(within(root).getByTestId('self-evolution-target-open-skill')).toBeInTheDocument()
  expect(within(root).getByTestId('self-evolution-usage')).toBeInTheDocument()
  const structure = Array.from(root.children)
  await act(async () => {})
  expect(Array.from(root.children)).toEqual(structure)
})
