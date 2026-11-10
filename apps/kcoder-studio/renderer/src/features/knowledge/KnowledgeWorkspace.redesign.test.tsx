import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import i18n from '@/i18n'
import { KnowledgeWorkspace } from './KnowledgeWorkspace'

const fixture = vi.hoisted(() => ({
  flags: { enabled: true, retrievalEnabled: true, organizationEnabled: false },
  configureMode: vi.fn(),
  status: vi.fn(),
  libraries: vi.fn(),
  state: {
    devices: [
      {
        device_id: 'one',
        name: 'Actual host',
        device_type: 'remote',
        capabilities: ['kcoder-gateway', 'kcoder-gateway-local'],
      },
      { device_id: 'ssh-peer', name: 'Remote', device_type: 'ssh' },
    ],
  },
  current: () => true,
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ state: fixture.state }),
}))
vi.mock('@/features/workbench/workbenchModelTarget', () => ({
  workbenchModelTarget: () => ({ deviceId: 'ssh-peer', workspacePath: '/remote' }),
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (id: string) => ({ key: id, isCurrent: fixture.current }),
}))
vi.mock('@/kcoder/knowledgeApi', () => ({
  knowledgeApi: {
    status: fixture.status,
    configureMode: fixture.configureMode,
    libraries: fixture.libraries,
    defaultLibrary: vi.fn(async () => ({ libraryId: 'library-owned' })),
  },
}))
vi.mock('./KnowledgeContents', () => ({
  KnowledgeContents: ({ actions }: { actions: React.ReactNode }) => (
    <div data-testid="actual-library-content-slot">{actions}</div>
  ),
}))
vi.mock('./WikiManagedKnowledge', () => ({
  WikiManagedKnowledge: () => <div data-testid="memory-content" />,
}))
beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('zh-CN')
  fixture.flags = { enabled: true, retrievalEnabled: true, organizationEnabled: false }
  fixture.status.mockImplementation(async () => ({ ...fixture.flags }))
  fixture.libraries.mockResolvedValue({
    items: [{ id: 'library-owned', name: '原有资料库', revision: 1, archived: false, purpose: '' }],
  })
  fixture.configureMode.mockImplementation(
    async (_id: string, field: 'retrievalEnabled' | 'organizationEnabled', value: boolean) => {
      fixture.flags[field] = value
    }
  )
})
test('shows the neutral knowledge hero, independent switches and real single-library selector on the actual host', async () => {
  render(<KnowledgeWorkspace />)
  await screen.findByTestId('knowledge-library-picker')
  expect(screen.getByTestId('knowledge-target')).toHaveValue('one')
  expect(fixture.status).toHaveBeenCalledWith('one')
  const hero = within(screen.getByTestId('knowledge-space-hero'))
  expect(hero.getByText('我的知识空间')).toBeInTheDocument()
  expect(hero.getAllByRole('switch')).toHaveLength(2)
  expect(hero.getByTestId('knowledge-retrieval-enabled')).toHaveAttribute('aria-checked', 'true')
  expect(hero.getByTestId('knowledge-organization-enabled')).toHaveAttribute(
    'aria-checked',
    'false'
  )
  expect(screen.getByTestId('knowledge-library-picker')).toHaveValue('library-owned')
  expect(screen.getByTestId('knowledge-create')).toBeDisabled()
  expect(screen.getAllByTestId('workspace-page-header')).toHaveLength(1)
})
test('switching organization leaves retrieval separate and retains the existing create flow', async () => {
  render(<KnowledgeWorkspace />)
  const organization = await screen.findByTestId('knowledge-organization-enabled')
  await waitFor(() => expect(organization).not.toBeDisabled())
  fireEvent.click(organization)
  await waitFor(() =>
    expect(fixture.configureMode).toHaveBeenCalledWith('one', 'organizationEnabled', true)
  )
  await waitFor(() => expect(screen.getByTestId('knowledge-create')).not.toBeDisabled())
  expect(screen.getByTestId('knowledge-retrieval-enabled')).toHaveAttribute('aria-checked', 'true')
  expect(fixture.configureMode).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('wiki-workspace-tab-memory'))
  expect(screen.getByTestId('memory-content')).toBeVisible()
  fireEvent.keyDown(screen.getByTestId('wiki-workspace-tab-memory'), { key: 'Home' })
  expect(screen.getByTestId('wiki-workspace-tab-library')).toHaveFocus()
})

test('reloads Wiki status after a busy refusal without replaying configuration writes', async () => {
  fixture.status.mockRejectedValueOnce(new Error('knowledge service is busy'))
  render(<KnowledgeWorkspace />)
  const reload = await screen.findByRole('button', { name: '重新加载' })
  expect(screen.getByRole('alert')).toHaveTextContent('知识服务当前繁忙')
  expect(screen.getByTestId('knowledge-retrieval-enabled')).toBeDisabled()
  fireEvent.click(reload)
  await screen.findByTestId('knowledge-library-picker')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByTestId('knowledge-retrieval-enabled')).toHaveAttribute('aria-checked', 'true')
  expect(fixture.status).toHaveBeenCalledTimes(2)
  expect(fixture.configureMode).not.toHaveBeenCalled()
})
