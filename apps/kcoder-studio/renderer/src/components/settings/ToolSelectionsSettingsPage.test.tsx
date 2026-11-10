import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { readToolSelections, saveToolSelections } from '@/kcoder/toolSelections'
import { ToolSelectionsSettingsPage } from './ToolSelectionsSettingsPage'

const context = vi.hoisted(() => ({ target: 'local', key: 'local:account-a', valid: true }))
vi.mock('@/features/runtime-target/useRuntimeSettingsTargets', () => ({
  useRuntimeSettingsTargets: () => ({
    selectedServerId: context.target,
    selectedTarget: { id: context.target, transport: 'local' },
    targets: [{ id: 'local' }, { id: 'remote' }],
    selectTarget: vi.fn(),
    loading: false,
    error: null,
  }),
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => {
    const key = context.key
    return { key, isCurrent: () => context.valid && context.key === key }
  },
}))
vi.mock('@/kcoder/toolSelections', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kcoder/toolSelections')>()),
  readToolSelections: vi.fn(),
  saveToolSelections: vi.fn(),
}))

function result(revision = 'one', allowed = ['HiddenTool']) {
  return {
    revision,
    modes: [
      { mode: 'kcoder' as const, editable: true, allowedTools: allowed },
      { mode: 'kworker' as const, editable: true, allowedTools: ['Read'] },
    ],
    tools: [
      {
        name: 'Read',
        ui: {
          displayName: 'Read file',
          description: 'Read file contents',
          icon: 'file' as const,
          group: 'files' as const,
        },
        available: true,
        supportedModes: ['kcoder' as const, 'kworker' as const],
        unavailableReason: null,
      },
    ],
    total: 1,
    truncated: false,
  }
}
beforeEach(async () => {
  vi.clearAllMocks()
  context.target = 'local'
  context.key = 'local:account-a'
  context.valid = true
  await i18n.changeLanguage('en')
  vi.mocked(readToolSelections).mockResolvedValue(result())
  vi.mocked(saveToolSelections).mockResolvedValue(result('two', ['HiddenTool', 'Read']))
})

test('switches modes and saves only the addressed mode, preserving unlisted tools and CAS', async () => {
  render(<ToolSelectionsSettingsPage />)
  const toggle = await screen.findByRole('switch', { name: 'Read file' })
  expect(toggle).toHaveAttribute('aria-checked', 'false')
  fireEvent.click(screen.getByRole('tab', { name: 'KWorker' }))
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  fireEvent.click(screen.getByRole('tab', { name: 'KCoder' }))
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(saveToolSelections).toHaveBeenCalledWith(
      'local',
      'kcoder',
      ['HiddenTool', 'Read'],
      'one'
    )
  )
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  expect(readToolSelections).toHaveBeenCalledExactlyOnceWith('local')
})

test('does not reenter a pending save and reconciles failed responses without replaying writes', async () => {
  let reject!: (error: Error) => void
  vi.mocked(saveToolSelections).mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail
    })
  )
  vi.mocked(readToolSelections)
    .mockResolvedValueOnce(result())
    .mockResolvedValueOnce(result('two', ['HiddenTool', 'Read']))
  render(<ToolSelectionsSettingsPage />)
  const toggle = await screen.findByRole('switch', { name: 'Read file' })
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  expect(saveToolSelections).toHaveBeenCalledTimes(1)
  expect(toggle).toBeDisabled()
  await act(async () => reject(new Error('connection lost')))
  await waitFor(() => expect(readToolSelections).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  expect(saveToolSelections).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('alert')).toHaveTextContent('current configuration')
})

test('failed reconciliation retains last confirmed values and locks further changes', async () => {
  vi.mocked(saveToolSelections).mockRejectedValue(new Error('timeout'))
  vi.mocked(readToolSelections)
    .mockResolvedValueOnce(result())
    .mockRejectedValueOnce(new Error('offline'))
  render(<ToolSelectionsSettingsPage />)
  const toggle = await screen.findByRole('switch', { name: 'Read file' })
  fireEvent.click(toggle)
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('outcome is unknown'))
  expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect(toggle).toBeDisabled()
})

test('ignores a result from the previous target/account lifetime', async () => {
  let finish!: (value: ReturnType<typeof result>) => void
  vi.mocked(readToolSelections).mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve
    })
  )
  const view = render(<ToolSelectionsSettingsPage />)
  await waitFor(() => expect(readToolSelections).toHaveBeenCalledTimes(1))
  context.target = 'remote'
  context.key = 'remote:account-b'
  view.rerender(<ToolSelectionsSettingsPage />)
  const toggle = await screen.findByRole('switch', { name: 'Read file' })
  await act(async () => finish(result('stale', ['Read'])))
  expect(toggle).toHaveAttribute('aria-checked', 'false')
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(saveToolSelections).toHaveBeenCalledWith(
      'remote',
      'kcoder',
      ['HiddenTool', 'Read'],
      'one'
    )
  )
})

test('locks truncated and read-only selections', async () => {
  vi.mocked(readToolSelections).mockResolvedValue({ ...result(), truncated: true })
  render(<ToolSelectionsSettingsPage />)
  expect(await screen.findByRole('switch', { name: 'Read file' })).toBeDisabled()
  expect(saveToolSelections).not.toHaveBeenCalled()
})

test.each(['readonly', 'unavailable', 'unsupported'] as const)(
  'explains and locks %s tools',
  async kind => {
    const snapshot = result()
    if (kind === 'readonly') snapshot.modes[0].editable = false
    if (kind === 'unavailable') snapshot.tools[0].available = false
    if (kind === 'unsupported') snapshot.tools[0].supportedModes = ['kworker']
    vi.mocked(readToolSelections).mockResolvedValue(snapshot)
    render(<ToolSelectionsSettingsPage />)
    const toggle = await screen.findByRole('switch', { name: 'Read file' })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-describedby')
    fireEvent.click(toggle)
    expect(saveToolSelections).not.toHaveBeenCalled()
  }
)

function paginatedResult(count = 23) {
  const snapshot = result()
  snapshot.tools = Array.from({ length: count }, (_, index) => ({
    ...snapshot.tools[0],
    name: `Tool${index + 1}`,
    ui: { ...snapshot.tools[0].ui, displayName: `Tool ${index + 1}` },
  }))
  snapshot.total = count
  snapshot.modes[0].allowedTools = snapshot.tools.map(tool => tool.name)
  return snapshot
}

test('shows ten tools per page and saves the complete selection across pages', async () => {
  const snapshot = paginatedResult()
  vi.mocked(readToolSelections).mockResolvedValue(snapshot)
  const saved = {
    ...snapshot,
    revision: 'two',
    modes: [
      {
        ...snapshot.modes[0],
        allowedTools: snapshot.modes[0].allowedTools.filter(name => name !== 'Tool11'),
      },
      snapshot.modes[1],
    ],
  }
  vi.mocked(saveToolSelections).mockResolvedValue(saved)
  render(<ToolSelectionsSettingsPage />)
  await screen.findByRole('switch', { name: 'Tool 1' })
  expect(screen.getAllByRole('switch')).toHaveLength(10)
  expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  expect(screen.getAllByRole('switch')).toHaveLength(10)
  fireEvent.click(screen.getByRole('switch', { name: 'Tool 11' }))
  await waitFor(() =>
    expect(saveToolSelections).toHaveBeenCalledWith(
      'local',
      'kcoder',
      snapshot.modes[0].allowedTools.filter(name => name !== 'Tool11'),
      'one'
    )
  )
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Tool 11' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  expect(screen.getAllByRole('switch')).toHaveLength(3)
  expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
  expect(screen.getByRole('switch', { name: 'Tool 11' })).toHaveAttribute('aria-checked', 'false')
})

test('search and mode changes reset pagination, and refresh clamps a smaller catalog', async () => {
  vi.mocked(readToolSelections).mockResolvedValue(paginatedResult())
  render(<ToolSelectionsSettingsPage />)
  await screen.findByRole('switch', { name: 'Tool 1' })
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  fireEvent.click(screen.getByRole('tab', { name: 'KWorker' }))
  expect(screen.getByRole('switch', { name: 'Tool 1' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Search tools' }), {
    target: { value: 'Tool 23' },
  })
  expect(screen.getAllByRole('switch')).toHaveLength(1)
  expect(screen.getByRole('switch', { name: 'Tool 23' })).toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search tools' }), { target: { value: '' } })
  expect(screen.getByRole('switch', { name: 'Tool 1' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
  vi.mocked(readToolSelections).mockResolvedValue(paginatedResult(2))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(2))
  expect(screen.getByRole('switch', { name: 'Tool 1' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled()
})

test('shows only ordinary-task defaults even when a response includes tool availability', async () => {
  vi.mocked(readToolSelections).mockResolvedValue({
    ...result('one', ['Read']),
    resolution: [
      {
        mode: 'kcoder',
        tools: [
          { name: 'Read', effective: false, restrictions: [{ source: 'model_tools_disabled' }] },
        ],
      },
    ],
  })
  render(<ToolSelectionsSettingsPage />)
  const toggle = await screen.findByRole('switch', { name: 'Read file' })
  expect(toggle).toHaveAttribute('aria-checked', 'true')
  expect(toggle).toBeEnabled()
  expect(screen.getByTestId('tool-selections-default-scope')).toHaveTextContent('ordinary tasks')
  expect(screen.getByTestId('tool-selection-default')).toHaveTextContent(
    'Selected by default for new ordinary tasks'
  )
  expect(screen.queryByTestId('tool-selection-resolution')).not.toBeInTheDocument()
  expect(readToolSelections).toHaveBeenCalledExactlyOnceWith('local')
})
