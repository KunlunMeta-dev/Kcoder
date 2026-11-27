import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
const host = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/kcoder/gatewayMigration', () => ({
  createMigrationApi: () => ({ codexLayersRead: host.read }),
}))
import { MigrationCodexLayerReport } from './MigrationCodexLayerReport'
const target = { kind: 'source' as const, sourceId: 'owned' },
  current = () => true
const page = (index = 0) => ({
  target,
  status: 'available',
  pageIndex: index,
  adapterRevision: 'codex-selected-layers/v1',
  layers: [
    { index: 0, kind: 'user', present: true },
    { index: 1, kind: 'profile', present: true },
    { index: 2, kind: 'project', present: false },
    { index: 3, kind: 'project', present: true },
  ],
  fields: Array.from({ length: index ? 1 : 10 }, () => ({
    field: index ? '/model_providers/env_key' : null,
    layer: index ? 0 : 3,
    providerIndex: index ? 0 : null,
    supported: !!index,
    ignored: false,
    private: !!index,
  })),
  totalFields: 11,
  nextPage: index ? null : 1,
  unobserved: [
    'command_line_overrides',
    'source_process_environment',
    'system_cloud_managed_defaults',
    'managed_requirements',
    'separate_mcp_namespaces',
    'git_worktree_runtime_routing',
  ],
})
beforeEach(() => {
  host.read.mockReset().mockImplementation(async (p: { pageIndex: number }) => page(p.pageIndex))
})
test('only explicit disclosure loads one bounded static report page and names profile, missing project and private boundaries', async () => {
  render(<MigrationCodexLayerReport deviceId="target" target={target} isCurrent={current} />)
  expect(host.read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-codex-report-toggle'))
  expect(await screen.findAllByTestId('migration-codex-field')).toHaveLength(10)
  expect(screen.getByText(/不代表来源进程的最终配置/)).toBeInTheDocument()
  expect(screen.getByText(/所选 profile.*项目层 1: 捕获时不存在/)).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('migration-codex-next'))
  await waitFor(() => expect(screen.getAllByTestId('migration-codex-field')).toHaveLength(1))
  expect(host.read).toHaveBeenLastCalledWith({ target, pageIndex: 1 }, expect.anything())
  expect(screen.getByText(/私有值已隐藏/)).toBeInTheDocument()
  expect(screen.getByTestId('migration-codex-next')).toBeDisabled()
})
test('changing target/account invalidates a late result and equivalent target objects do not trigger a new read', async () => {
  const { rerender, unmount } = render(
    <MigrationCodexLayerReport deviceId="target" target={target} isCurrent={current} />
  )
  fireEvent.click(screen.getByTestId('migration-codex-report-toggle'))
  await screen.findAllByTestId('migration-codex-field')
  rerender(
    <MigrationCodexLayerReport deviceId="target" target={{ ...target }} isCurrent={current} />
  )
  await act(async () => {})
  expect(host.read).toHaveBeenCalledTimes(1)
  let resolve!: (value: unknown) => void
  host.read.mockImplementation(
    () =>
      new Promise(yes => {
        resolve = yes
      })
  )
  fireEvent.click(screen.getByTestId('migration-codex-next'))
  rerender(<MigrationCodexLayerReport deviceId="peer" target={target} isCurrent={current} />)
  await act(async () => resolve(page(1)))
  expect(screen.queryByTestId('migration-codex-report-details')).not.toBeInTheDocument()
  unmount()
})

test('source reports stay on the supplied owned source reader rather than opening an ordinary target RPC', async () => {
  const readSource = vi.fn(async (_id: string, index: number) => page(index))
  render(<MigrationCodexLayerReport deviceId="source" target={target} isCurrent={current} readSource={readSource as never} />)
  expect(readSource).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-codex-report-toggle'))
  expect(await screen.findAllByTestId('migration-codex-field')).toHaveLength(10)
  fireEvent.click(screen.getByTestId('migration-codex-next'))
  await waitFor(() => expect(screen.getAllByTestId('migration-codex-field')).toHaveLength(1))
  expect(readSource).toHaveBeenLastCalledWith('owned', 1, expect.any(AbortSignal))
  expect(host.read).not.toHaveBeenCalled()
})
