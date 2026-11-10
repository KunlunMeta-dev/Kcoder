import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
import { MigrationDialog } from './MigrationDialog'

const { api, targets, factory } = vi.hoisted(() => ({
  api: Object.fromEntries(
    ['discover', 'list', 'read', 'plan', 'capture', 'apply', 'undo', 'cancel', 'resume'].map(
      name => [name, vi.fn()]
    )
  ),
  targets: {
    selectedTarget: { id: 'first', workspacePath: '/owned' },
    selectedServerId: 'first',
    targets: [
      { id: 'first', label: 'First' },
      { id: 'second', label: 'Second' },
    ],
    loading: false,
    error: '',
    selectTarget: vi.fn(),
    refresh: vi.fn(),
  },
  factory: vi.fn(),
}))
vi.mock('@/features/runtime-target/useRuntimeSettingsTargets', () => ({
  useRuntimeSettingsTargets: () => targets,
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (id: string, path: string) => ({
    key: `${id}:${path}`,
    isCurrent: () => true,
  }),
}))
vi.mock('@/kcoder/gatewayMigrationPlugins', () => ({
  createMigrationPluginsApi: (...args: unknown[]) => {
    factory(...args)
    return api
  },
}))
vi.mock('./MigrationQuickHistory', () => ({
  MigrationQuickHistory: () => <div data-testid="quick-only" />,
}))
vi.mock('./MigrationBatchWorkspace', () => ({
  MigrationBatchWorkspace: () => <div data-testid="batch-only" />,
}))
vi.mock('./MigrationHistoryWorkspace', () => ({
  MigrationHistoryWorkspace: () => <div data-testid="history-only" />,
}))

beforeEach(() => {
  vi.resetAllMocks()
  targets.selectedTarget = { id: 'first', workspacePath: '/owned' }
  targets.selectedServerId = 'first'
  api.list.mockResolvedValue({ items: [], nextCursor: null })
  api.discover.mockResolvedValue({ candidates: [], problems: [], nextCursor: null })
})

test('local plugins are an explicit independent branch and entering it only observes records', async () => {
  render(<MigrationDialog onClose={() => {}} />)
  expect(screen.getByTestId('quick-only')).toBeInTheDocument()
  expect(screen.queryByTestId('migration-mode-plugins')).not.toBeInTheDocument()
  expect(factory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-advanced-toggle'))
  fireEvent.click(screen.getByTestId('migration-mode-plugins'))
  await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
  expect(screen.getByTestId('migration-plugins')).toBeInTheDocument()
  expect(screen.queryByTestId('quick-only')).not.toBeInTheDocument()
  expect(screen.queryByTestId('migration-plugin-select-batch')).not.toBeInTheDocument()
  for (const name of ['discover', 'plan', 'capture', 'apply', 'undo', 'cancel', 'resume'])
    expect(api[name]).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-plugin-discover'))
  await waitFor(() => expect(api.discover).toHaveBeenCalledOnce())
  expect(api.apply).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '批量迁移', exact: true }))
  expect(screen.queryByTestId('migration-plugins')).not.toBeInTheDocument()
  expect(api.cancel).not.toHaveBeenCalled()
})

test('an old target shows the plugin-specific upgrade boundary without another migration action', async () => {
  api.list.mockRejectedValue(new Error('migration_plugins_update_required'))
  render(<MigrationDialog onClose={() => {}} />)
  fireEvent.click(screen.getByTestId('migration-advanced-toggle'))
  fireEvent.click(screen.getByTestId('migration-mode-plugins'))
  await screen.findByText('请将所选目标更新到支持本地插件迁移的版本。')
  for (const name of ['discover', 'plan', 'capture', 'apply', 'undo', 'cancel', 'resume'])
    expect(api[name]).not.toHaveBeenCalled()
})

test('a target change resets the selected branch and rejects the old plugin record response', async () => {
  let finish!: (value: unknown) => void
  api.list.mockReturnValueOnce(
    new Promise(done => {
      finish = done
    })
  )
  const { rerender } = render(<MigrationDialog onClose={() => {}} />)
  fireEvent.click(screen.getByTestId('migration-advanced-toggle'))
  fireEvent.click(screen.getByTestId('migration-mode-plugins'))
  await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
  targets.selectedTarget = { id: 'second', workspacePath: '/other' }
  targets.selectedServerId = 'second'
  rerender(<MigrationDialog onClose={() => {}} />)
  expect(screen.getByTestId('quick-only')).toBeInTheDocument()
  expect(screen.queryByTestId('migration-plugins')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('migration-advanced-toggle'))
  fireEvent.click(screen.getByTestId('migration-mode-plugins'))
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
  await act(async () => {
    finish({ items: [], nextCursor: 'old-target-cursor' })
  })
  expect(screen.getByTestId('migration-plugin-record-next')).toBeDisabled()
  expect(factory).toHaveBeenLastCalledWith('second', '/other')
  expect(api.apply).not.toHaveBeenCalled()
})

test('first-use fixed target cannot fall back to another configured target or a changed account', () => {
  const fixed = { id: 'first', label: 'First', description: '', runtime: 'kcoder' as const, transport: 'local' as const, workspacePath: '/owned' }
  targets.targets = [{ ...fixed }, { ...fixed, id: 'second', label: 'Second' }]
  targets.selectedTarget = targets.targets[1]
  const view = render(<MigrationDialog target={fixed} onClose={() => {}} />)
  expect(screen.getByLabelText('迁移到哪个运行目标')).toHaveValue('first')
  expect(screen.getByLabelText('迁移到哪个运行目标')).toBeDisabled()
  expect(screen.getByTestId('quick-only')).toBeInTheDocument()
  targets.targets = [{ ...fixed, id: 'second', label: 'Second' }]
  view.rerender(<MigrationDialog target={fixed} onClose={() => {}} />)
  expect(screen.queryByTestId('quick-only')).not.toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('原运行目标或账号已变化')
})

test('an explicit advanced entry or saved job retains its original workspace', () => {
  const view = render(<MigrationDialog onClose={() => {}} initialMode="batch" />)
  expect(screen.getByTestId('batch-only')).toBeInTheDocument()
  expect(screen.getByTestId('migration-mode-plugins')).toBeInTheDocument()
  view.unmount()
  render(<MigrationDialog onClose={() => {}} initialJobId="saved-job" />)
  expect(screen.getByTestId('batch-only')).toBeInTheDocument()
  expect(screen.queryByTestId('quick-only')).not.toBeInTheDocument()
})
