import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ExpertToolsWorkspace } from './ExpertToolsWorkspace'
import { newExpert, type ExpertClient } from './client'
import { readToolSelections } from '@/kcoder/toolSelections'
vi.mock('@/kcoder/toolSelections', () => ({ readToolSelections: vi.fn() }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const tools = () => ({
  revision: 'catalog',
  modes: [{ mode: 'kcoder' as const, editable: true, allowedTools: ['bash'] }],
  lunaAllowedTools: ['read', 'HiddenTool'],
  tools: [
    {
      name: 'read',
      available: true,
      supportedModes: ['kcoder' as const],
      unavailableReason: null,
      ui: {
        displayName: 'Read files',
        description: 'Read project files',
        icon: 'file' as const,
        group: 'files' as const,
      },
    },
    {
      name: 'bash',
      available: true,
      supportedModes: ['kcoder' as const],
      unavailableReason: null,
      ui: {
        displayName: 'Shell',
        description: 'Execute commands',
        icon: 'terminal' as const,
        group: 'terminal' as const,
      },
    },
  ],
  total: 2,
  truncated: false,
})
function fixture() {
  vi.mocked(readToolSelections).mockResolvedValue(tools())
  const definition = { ...newExpert('en'), id: 'personal.original', title: 'Expert' }
  const draft = {
    owner: { accountId: 'account', targetId: 'remote', workspaceId: 'project' },
    revision: 8,
    definition,
    updatedAtMs: 1,
  }
  let revision = 7
  const client = {
    target: { serverId: 'remote', workspacePath: '/original-project' },
    pending: vi.fn<() => string | null>(() => null),
    reconcile: vi.fn().mockResolvedValue(undefined),
    controller: { call: vi.fn().mockResolvedValue({ draft }) },
    save: vi
      .fn()
      .mockImplementation(async definition => ({ ...draft, definition, revision: ++revision })),
    mutate: vi.fn().mockResolvedValue({}),
  }
  const onSaved = vi.fn()
  const props = {
    client: client as unknown as ExpertClient,
    item: { definition, builtin: false, draftRevision: 7 },
    onSaved,
  }
  return { client, props, onSaved, definition }
}
test('inherits target Luna defaults rather than Studio defaults without granting or saving anything on entry', async () => {
  const f = fixture()
  render(<ExpertToolsWorkspace {...f.props} />)
  const read = await screen.findByRole('switch', { name: 'Read files' })
  expect(readToolSelections).toHaveBeenCalledWith('remote', '/original-project', true, f.definition)
  expect(read).toHaveAttribute('aria-checked', 'true')
  expect(read).toBeEnabled()
  expect(screen.getByRole('switch', { name: 'Shell' })).toHaveAttribute('aria-checked', 'false')
  expect(screen.getByRole('switch', { name: 'Shell' })).toBeDisabled()
  expect(f.client.save).not.toHaveBeenCalled()
})
test('an older target without a Luna baseline cannot claim active defaults or edit them', async () => {
  const f = fixture()
  const legacy = tools()
  Reflect.deleteProperty(legacy, 'lunaAllowedTools')
  vi.mocked(readToolSelections).mockResolvedValue(legacy)
  render(<ExpertToolsWorkspace {...f.props} />)
  const read = await screen.findByRole('switch', { name: 'Read files' })
  expect(read).toHaveAttribute('aria-checked', 'false')
  expect(read).toBeDisabled()
  expect(screen.getByRole('combobox', { name: 'toolAccess' })).toBeDisabled()
  expect(screen.getAllByText(/toolSettings.baselineUnknown/).length).toBeGreaterThan(0)
  expect(screen.getAllByTestId('tool-selection-resolution')[0]).toHaveTextContent(
    'tool_selections.preview_unsupported'
  )
  expect(f.client.save).not.toHaveBeenCalled()
})
test('an explicit empty Luna baseline enables no tools and does not fall back to Studio defaults', async () => {
  const f = fixture()
  vi.mocked(readToolSelections).mockResolvedValue({ ...tools(), lunaAllowedTools: [] })
  render(<ExpertToolsWorkspace {...f.props} />)
  await screen.findByRole('switch', { name: 'Read files' })
  for (const tool of screen.getAllByRole('switch')) {
    expect(tool).toHaveAttribute('aria-checked', 'false')
    expect(tool).toBeDisabled()
  }
  expect(screen.queryByText(/^toolSettings.baselineUnknown$/)).toBeNull()
  expect(f.client.save).not.toHaveBeenCalled()
})
test('custom names outside Luna remain selected and can be removed without granting them', async () => {
  const f = fixture()
  f.props.item.definition.allowedTools = ['read', 'bash', 'HiddenTool']
  render(<ExpertToolsWorkspace {...f.props} />)
  const read = await screen.findByRole('switch', { name: 'Read files' })
  expect(read).not.toBeDisabled()
  const shell = screen.getByRole('switch', { name: 'Shell' })
  expect(shell).toHaveAttribute('aria-checked', 'true')
  expect(shell).toBeEnabled()
  fireEvent.click(read)
  await waitFor(() =>
    expect(f.client.save).toHaveBeenCalledWith(
      { ...f.definition, allowedTools: ['bash', 'HiddenTool'] },
      7,
      expect.any(AbortSignal)
    )
  )
})
test('unavailable tools within Luna keep their configuration visible and can be removed', async () => {
  const f = fixture()
  const catalog = tools()
  catalog.tools[0].available = false
  vi.mocked(readToolSelections).mockResolvedValue(catalog)
  render(<ExpertToolsWorkspace {...f.props} />)
  const read = await screen.findByRole('switch', { name: 'Read files' })
  expect(read).toHaveAttribute('aria-checked', 'true')
  expect(read).toBeEnabled()
})
test('a direct inherited switch automatically persists this expert and subsequent changes use the acknowledged revision', async () => {
  const f = fixture()
  render(<ExpertToolsWorkspace {...f.props} />)
  const read = await screen.findByRole('switch', { name: 'Read files' })
  fireEvent.click(read)
  await waitFor(() =>
    expect(f.client.save).toHaveBeenCalledWith(
      { ...f.definition, allowedTools: ['HiddenTool'] },
      7,
      expect.any(AbortSignal)
    )
  )
  await screen.findByText('toolSettings.saved')
  expect(read).toHaveAttribute('aria-checked', 'false')
  expect(
    screen.getByRole('combobox', { name: 'toolAccess' }).closest('.ant-select, .octop-select')
  ).toHaveTextContent('restrictedTools')
  fireEvent.click(read)
  await waitFor(() =>
    expect(f.client.save).toHaveBeenLastCalledWith(
      { ...f.definition, allowedTools: ['HiddenTool', 'read'] },
      8,
      expect.any(AbortSignal)
    )
  )
  await waitFor(() => expect(f.onSaved).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: 'save', exact: true })).toBeDisabled()
  expect(f.client.mutate).not.toHaveBeenCalled()
})
test('an uncertain automatic save locks mutations until the original receipt is reconciled without replay', async () => {
  const f = fixture()
  f.client.save.mockImplementation(async () => {
    f.client.pending.mockReturnValue('original-save')
    throw new Error('lost receipt')
  })
  render(<ExpertToolsWorkspace {...f.props} />)
  await screen.findByRole('switch', { name: 'Read files' })
  fireEvent.click(screen.getByRole('switch', { name: 'Read files' }))
  await screen.findByText('toolSettings.pending')
  expect(screen.getByRole('switch', { name: 'Read files' })).toBeDisabled()
  expect(screen.getByRole('combobox', { name: 'toolAccess' })).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: 'version' }), { target: { value: '1.0.2' } })
  fireEvent.click(screen.getByRole('button', { name: 'toolSettings.publish' }))
  expect(f.client.save).toHaveBeenCalledTimes(1)
  expect(f.client.mutate).not.toHaveBeenCalled()
  f.client.reconcile.mockImplementation(async () => {
    f.client.pending.mockReturnValue(null)
  })
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(f.client.controller.call).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Read files' })).toBeEnabled())
  expect(screen.getByRole('switch', { name: 'Read files' })).toHaveAttribute('aria-checked', 'true')
  expect(f.client.save).toHaveBeenCalledTimes(1)
})
test('late catalog results cannot fill a replacement project editor', async () => {
  const first = fixture()
  let finish!: (value: ReturnType<typeof tools>) => void
  vi.mocked(readToolSelections).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const view = render(<ExpertToolsWorkspace key="first" {...first.props} />)
  await waitFor(() => expect(readToolSelections).toHaveBeenCalledTimes(1))
  const second = fixture()
  second.client.target.workspacePath = '/second-project'
  view.rerender(<ExpertToolsWorkspace key="second" {...second.props} />)
  await screen.findByRole('switch', { name: 'Read files' })
  finish({ ...tools(), tools: [] })
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Read files' })).toBeTruthy())
  expect(readToolSelections).toHaveBeenLastCalledWith(
    'remote',
    '/second-project',
    true,
    expect.any(Object)
  )
})

test('refresh reconciles an original uncertain write and reads this expert without replaying a mutation', async () => {
  const f = fixture()
  f.client.pending.mockReturnValue('original-operation')
  f.client.reconcile.mockImplementation(async () => {
    f.client.pending.mockReturnValue(null)
  })
  render(<ExpertToolsWorkspace {...f.props} />)
  await screen.findByRole('switch', { name: 'Read files' })
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() =>
    expect(f.client.controller.call).toHaveBeenCalledWith(
      'assistant/read',
      { id: 'personal.original' },
      undefined,
      expect.any(AbortSignal)
    )
  )
  expect(f.client.reconcile).toHaveBeenCalledOnce()
  expect(f.client.save).not.toHaveBeenCalled()
  expect(f.client.mutate).not.toHaveBeenCalled()
})

test('a committed draft is reported separately when publication returns no authoritative version', async () => {
  const f = fixture()
  render(<ExpertToolsWorkspace {...f.props} />)
  await screen.findByRole('switch', { name: 'Read files' })
  fireEvent.click(screen.getByRole('switch', { name: 'Read files' }))
  await screen.findByText('toolSettings.saved')
  fireEvent.change(screen.getByRole('textbox', { name: 'version' }), { target: { value: '1.0.2' } })
  fireEvent.click(screen.getByRole('button', { name: 'toolSettings.publish' }))
  await screen.findByText('toolSettings.publishFailed')
  expect(f.client.mutate).toHaveBeenCalledWith(
    'assistant/saveVersion',
    { id: 'personal.original', version: '1.0.2' },
    expect.any(AbortSignal),
    8
  )
  expect(screen.queryByText('toolSettings.published')).toBeNull()
})

test('restoring inheritance automatically persists null instead of a copied default list', async () => {
  const f = fixture()
  f.props.item.definition.allowedTools = []
  render(<ExpertToolsWorkspace {...f.props} />)
  await screen.findByRole('switch', { name: 'Read files' })
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'toolAccess' }))
  fireEvent.click(await screen.findByText('inheritTaskTools'))
  await screen.findByText('toolSettings.saved')
  expect(f.client.save).toHaveBeenCalledWith(
    { ...f.definition, allowedTools: null },
    7,
    expect.any(AbortSignal)
  )
})

test('an explicitly empty expert allowlist can enable a Luna tool without restoring all defaults', async () => {
  const f = fixture()
  f.props.item.definition.allowedTools = []
  render(<ExpertToolsWorkspace {...f.props} />)
  const read = await screen.findByRole('switch', { name: 'Read files' })
  expect(read).toHaveAttribute('aria-checked', 'false')
  fireEvent.click(read)
  await screen.findByText('toolSettings.saved')
  expect(f.client.save).toHaveBeenCalledWith(
    { ...f.definition, allowedTools: ['read'] },
    7,
    expect.any(AbortSignal)
  )
})

test('saving disables further input and never reports success before an authoritative matching draft', async () => {
  const f = fixture()
  let finish!: (draft: unknown) => void
  f.client.save.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  render(<ExpertToolsWorkspace {...f.props} />)
  const read = await screen.findByRole('switch', { name: 'Read files' })
  fireEvent.click(read)
  expect(read).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('toolSettings.saving')
  fireEvent.click(read)
  expect(f.client.save).toHaveBeenCalledOnce()
  finish({ definition: { ...f.definition, allowedTools: ['wrong'] }, revision: 8 })
  await screen.findByText('toolSettings.failed')
  expect(f.onSaved).not.toHaveBeenCalled()
  expect(screen.queryByText('toolSettings.saved')).toBeNull()
})

test('a rejected save remains unsaved and refresh reads the latest draft and revision before the next change', async () => {
  const f = fixture()
  f.client.save.mockRejectedValueOnce(new Error('revision conflict'))
  render(<ExpertToolsWorkspace {...f.props} />)
  const read = await screen.findByRole('switch', { name: 'Read files' })
  fireEvent.click(read)
  await screen.findByText('toolSettings.failed')
  expect(screen.getByRole('button', { name: 'save', exact: true })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(f.client.controller.call).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Read files' })).toBeEnabled())
  fireEvent.click(screen.getByRole('switch', { name: 'Read files' }))
  await waitFor(() =>
    expect(f.client.save).toHaveBeenLastCalledWith(
      { ...f.definition, allowedTools: ['HiddenTool'] },
      8,
      expect.any(AbortSignal)
    )
  )
})

test('shows server-computed mode and skill restrictions separately from the expert selection', async () => {
  const f = fixture()
  vi.mocked(readToolSelections).mockResolvedValue({
    ...tools(),
    resolution: [
      {
        mode: 'kcoder',
        tools: [{ name: 'read', effective: false, restrictions: [{ source: 'mode_selection' }] }],
      },
      {
        mode: 'kworker',
        tools: [
          {
            name: 'read',
            effective: false,
            restrictions: [{ source: 'skill_selection', skill: 'workflow' }],
          },
        ],
      },
    ],
  })
  render(<ExpertToolsWorkspace {...f.props} />)
  const read = await screen.findByRole('switch', { name: 'Read files' })
  expect(read).toHaveAttribute('aria-checked', 'true')
  await screen.findByText(/tool_selections.restrictions.mode_selection/)
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'toolSettings.previewMode' }))
  fireEvent.click(await screen.findByText('KWorker'))
  await screen.findByText(/tool_selections.restrictions.skill_selection/)
  expect(f.client.save).not.toHaveBeenCalled()
})

test('late previews cannot replace the preview for a newer local selection', async () => {
  const f = fixture()
  let finish!: (result: ReturnType<typeof tools>) => void
  vi.mocked(readToolSelections)
    .mockResolvedValueOnce(tools())
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValue(tools())
  render(<ExpertToolsWorkspace {...f.props} />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Read files' }))
  await waitFor(() => expect(readToolSelections).toHaveBeenCalledTimes(2))
  await screen.findByText('toolSettings.saved')
  fireEvent.click(screen.getByRole('switch', { name: 'Read files' }))
  await waitFor(() => expect(readToolSelections).toHaveBeenCalledTimes(3))
  finish({ ...tools(), lunaAllowedTools: [] })
  await waitFor(() =>
    expect(screen.getByRole('switch', { name: 'Read files' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  )
})

test('a target with independent expert tools lets a custom selection add a registered tool outside Luna', async () => {
  const f = fixture()
  vi.mocked(readToolSelections).mockResolvedValue({ ...tools(), expertToolsIndependent: true })
  render(<ExpertToolsWorkspace {...f.props} />)
  const shell = await screen.findByRole('switch', { name: 'Shell' })
  expect(shell).toBeEnabled()
  expect(shell).toHaveAttribute('aria-checked', 'false')
  fireEvent.click(shell)
  await waitFor(() =>
    expect(f.client.save).toHaveBeenCalledWith(
      { ...f.definition, allowedTools: ['read', 'HiddenTool', 'bash'] },
      7,
      expect.any(AbortSignal)
    )
  )
})
