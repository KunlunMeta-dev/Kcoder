import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import '@/i18n'
const host = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/kcoder/gatewayMigration', () => ({
  createMigrationApi: () => ({ configurationLayers: host.read }),
}))
import { MigrationConfigurationLayers } from './MigrationConfigurationLayers'
const target = { kind: 'source' as const, sourceId: 'source-a' }
const current = () => true
const page = (index = 0) => ({
  target,
  status: 'available',
  pageIndex: index,
  adapterRevision: 'claude-settings-layers/v1',
  layers: [
    { scope: 'user', present: true },
    { scope: 'project', present: false },
    { scope: 'local', present: true },
  ],
  fields: Array.from({ length: index ? 2 : 10 }, (_, i) => ({
    field: index ? '/env/ANTHROPIC_API_KEY' : null,
    ordinal: index * 10 + i,
    scopes: ['local'],
    supported: index > 0,
    private: index > 0,
  })),
  totalFields: 12,
  nextPage: index ? null : 1,
  unobserved: [
    'managed_settings',
    'command_line_settings',
    'source_process_environment',
    'git_worktree_local_routing',
    'separate_mcp_namespaces',
  ],
})
beforeEach(() => {
  host.read.mockReset().mockImplementation(async (p: { pageIndex: number }) => page(p.pageIndex))
})
test('advanced disclosure is passive until opened, limits rows to a native page and names static/private boundaries', async () => {
  render(<MigrationConfigurationLayers deviceId="owned" target={target} isCurrent={current} />)
  expect(host.read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('migration-layer-toggle'))
  expect(await screen.findAllByTestId('migration-layer-field')).toHaveLength(10)
  expect(screen.getByText(/不代表来源应用运行时的最终配置/)).toBeInTheDocument()
  expect(screen.getByText(/项目层: 捕获时不存在/)).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('migration-layer-next'))
  await waitFor(() => expect(screen.getAllByTestId('migration-layer-field')).toHaveLength(2))
  expect(host.read).toHaveBeenLastCalledWith({ target, pageIndex: 1 }, expect.anything())
  expect(screen.getAllByText(/私有值已隐藏/)).toHaveLength(2)
  expect(screen.getAllByText(/胜出层: 项目本地层/)).toHaveLength(2)
  expect(screen.getByTestId('migration-layer-next')).toBeDisabled()
})
test('a late report cannot appear after changing source, account lifetime or unmounting', async () => {
  let resolve!: (value: unknown) => void,
    valid = true
  host.read.mockImplementation(
    () =>
      new Promise(yes => {
        resolve = yes
      })
  )
  const isCurrent = () => valid
  const { rerender, unmount } = render(
    <MigrationConfigurationLayers deviceId="owned" target={target} isCurrent={isCurrent} />
  )
  fireEvent.click(screen.getByTestId('migration-layer-toggle'))
  rerender(
    <MigrationConfigurationLayers
      deviceId="owned"
      target={{ kind: 'source', sourceId: 'source-b' }}
      isCurrent={isCurrent}
    />
  )
  await act(async () => resolve(page()))
  expect(screen.queryByTestId('migration-layer-details')).not.toBeInTheDocument()
  valid = false
  fireEvent.click(screen.getByTestId('migration-layer-toggle'))
  expect(host.read).toHaveBeenCalledTimes(1)
  unmount()
})

test('equivalent parent projections keep the same static report request instead of rereading every poll', async () => {
  const { rerender } = render(
    <MigrationConfigurationLayers deviceId="owned" target={target} isCurrent={current} />
  )
  fireEvent.click(screen.getByTestId('migration-layer-toggle'))
  expect(await screen.findAllByTestId('migration-layer-field')).toHaveLength(10)
  rerender(
    <MigrationConfigurationLayers deviceId="owned" target={{ ...target }} isCurrent={current} />
  )
  await act(async () => {})
  expect(host.read).toHaveBeenCalledTimes(1)
})


test('an owned source report uses its original child for every page and never the shared target API', async () => {
  const readSource = vi.fn(async (_sourceId: string, index: number) => page(index) as unknown as import('../../../../shared/generated/contracts').MigrationConfigurationLayersResult);
  render(<MigrationConfigurationLayers deviceId="owned" target={target} isCurrent={current} readSource={readSource} />);
  expect(readSource).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('migration-layer-toggle'));
  expect(await screen.findAllByTestId('migration-layer-field')).toHaveLength(10);
  expect(readSource).toHaveBeenLastCalledWith('source-a', 0, expect.any(AbortSignal));
  fireEvent.click(screen.getByTestId('migration-layer-next'));
  await waitFor(() => expect(screen.getAllByTestId('migration-layer-field')).toHaveLength(2));
  expect(readSource).toHaveBeenLastCalledWith('source-a', 1, expect.any(AbortSignal));
  expect(host.read).not.toHaveBeenCalled();
});


test('an older source reports its required update without trying the shared target broker', async () => {
  const readSource = vi.fn().mockRejectedValue(Object.assign(new Error('capability unavailable'), { code: 'source_transfer_configuration_layers_update_required' }));
  render(<MigrationConfigurationLayers deviceId="owned" target={target} isCurrent={current} readSource={readSource} />);
  fireEvent.click(screen.getByTestId('migration-layer-toggle'));
  expect(await screen.findByRole('alert')).toHaveTextContent('请更新来源端 KCoder');
  expect(readSource).toHaveBeenCalledTimes(1);
  expect(host.read).not.toHaveBeenCalled();
});
