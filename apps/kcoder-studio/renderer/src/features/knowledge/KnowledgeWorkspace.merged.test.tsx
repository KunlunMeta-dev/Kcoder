import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { KnowledgeWorkspace } from './KnowledgeWorkspace'

const fixture = vi.hoisted(() => ({
  current: () => true,
  state: {
    devices: [
      { device_id: 'one', name: 'One', device_type: 'local' },
      { device_id: 'two', name: 'Two' },
    ],
  },
  status: vi.fn(),
  configure: vi.fn(),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ state: fixture.state }),
}))
vi.mock('@/features/workbench/workbenchModelTarget', () => ({
  workbenchModelTarget: () => ({ deviceId: 'one', workspacePath: '/owned/workspace' }),
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (id: string) => ({ key: id, isCurrent: fixture.current }),
}))
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: { status: fixture.status, configure: fixture.configure },
}))
vi.mock('./WikiManagedKnowledge', () => ({
  WikiManagedKnowledge: ({
    section,
    serverId,
    workspacePath,
  }: {
    section: string
    serverId: string
    workspacePath?: string
  }) => {
    const [draft, setDraft] = useState('')
    return (
      <div
        data-testid="merged-managed-section"
        data-target={serverId}
        data-workspace={workspacePath}
      >
        {section}
        <input aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} />
      </div>
    )
  },
}))
const activeSection = () =>
  within(screen.getByRole('tabpanel')).getByTestId('merged-managed-section')
beforeEach(() => {
  vi.clearAllMocks()
  fixture.status.mockResolvedValue({
    enabled: false,
    retrievalEnabled: false,
    organizationEnabled: false,
  })
})

it('keeps the Wiki library and exposes memory and shared knowledge on the same page without enabling anything', async () => {
  render(<KnowledgeWorkspace />)
  await screen.findByTestId('knowledge-enable')
  expect(screen.getAllByRole('tab')).toHaveLength(2)
  fireEvent.click(screen.getByTestId('wiki-workspace-tab-memory'))
  expect(activeSection()).toHaveTextContent('memory')
  expect(activeSection()).toHaveAttribute('data-target', 'one')
  expect(activeSection()).toHaveAttribute('data-workspace', '/owned/workspace')
  expect(screen.queryByTestId('wiki-workspace-tab-shared')).not.toBeInTheDocument()
  expect(fixture.configure).not.toHaveBeenCalled()
  expect(screen.queryByTestId('knowledge-section-automation')).not.toBeInTheDocument()
})

it('binds an embedded section to the Wiki target and never carries another target workspace', () => {
  render(<KnowledgeWorkspace initialSection="memory" />)
  fireEvent.change(screen.getByTestId('knowledge-target'), { target: { value: 'two' } })
  expect(activeSection()).toHaveAttribute('data-target', 'two')
  expect(activeSection()).not.toHaveAttribute('data-workspace')
  expect(fixture.status).not.toHaveBeenCalled()
  expect(fixture.configure).not.toHaveBeenCalled()
})

it('supports keyboard tabs and the legacy memory route without showing a second workspace header', async () => {
  const view = render(<KnowledgeWorkspace initialSection="memory" />)
  expect(screen.getByTestId('wiki-workspace-tab-memory')).toHaveAttribute('aria-selected', 'true')
  fireEvent.keyDown(screen.getByTestId('wiki-workspace-tab-memory'), { key: 'Home' })
  expect(screen.getByTestId('wiki-workspace-tab-library')).toHaveFocus()
  expect(await screen.findByTestId('knowledge-enable')).toBeInTheDocument()
  view.rerender(<KnowledgeWorkspace initialSection="library" />)
  expect(screen.getByTestId('wiki-workspace-tab-library')).toHaveAttribute('aria-selected', 'true')
  expect(screen.getAllByTestId('workspace-page-header')).toHaveLength(1)
})

it('preserves same-target section drafts and drops them when the actual target changes', () => {
  render(<KnowledgeWorkspace initialSection="memory" />)
  fireEvent.change(within(activeSection()).getByRole('textbox', { name: 'Draft' }), {
    target: { value: 'Keep my draft' },
  })
  fireEvent.click(screen.getByTestId('wiki-workspace-tab-library'))
  fireEvent.click(screen.getByTestId('wiki-workspace-tab-memory'))
  expect(within(activeSection()).getByRole('textbox', { name: 'Draft' })).toHaveValue(
    'Keep my draft'
  )
  fireEvent.change(screen.getByTestId('knowledge-target'), { target: { value: 'two' } })
  expect(within(activeSection()).getByRole('textbox', { name: 'Draft' })).toHaveValue('')
})
