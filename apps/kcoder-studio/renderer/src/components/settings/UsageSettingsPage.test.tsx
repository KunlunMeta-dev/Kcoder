import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { UsageSettingsPage } from './UsageSettingsPage'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { emptyUsage, readUsageStats, type UsageStats } from '@/kcoder/usageHistory'
import '@/i18n'

vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: vi.fn() }))
vi.mock('@/kcoder/usageHistory', async original => ({
  ...(await original<typeof import('@/kcoder/usageHistory')>()),
  readUsageStats: vi.fn(),
}))
const stats: UsageStats = {
  windowDays: 30,
  timeZone: 'UTC',
  generatedAtMs: Date.parse('2026-09-08'),
  history: {
    version: 1,
    trackedSinceMs: Date.parse('2026-09-01'),
    lastRecordedAtMs: Date.parse('2026-09-08'),
    days: {
      '2026-09-08': {
        model: {
          ...emptyUsage(),
          requests: 2,
          totalTokens: 120,
          inputTokens: 100,
          outputTokens: 20,
          unreportedRequests: 1,
          cacheReadTokens: 80,
        },
      },
    },
  },
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    { id: 'local', label: 'Local', transport: 'local', workspacePath: '/fixture' },
    { id: 'remote', label: 'Remote', transport: 'ssh', workspacePath: '/fixture' },
  ])
  vi.mocked(readUsageStats).mockResolvedValue(stats)
})

test('shows real totals, coverage, missing usage and model breakdown with explicit refresh', async () => {
  render(<UsageSettingsPage />)
  expect(await screen.findByTestId('usage-totalTokens')).toHaveTextContent('120')
  expect(screen.getByTestId('usage-coverage')).toHaveTextContent('已被清理')
  expect(screen.getByRole('status')).toHaveTextContent('未报告不代表没有消耗')
  fireEvent.click(screen.getByTestId('usage-view-models'))
  expect(screen.getByTestId('usage-table')).toHaveTextContent('model')
  fireEvent.click(screen.getByTestId('usage-refresh'))
  await waitFor(() => expect(readUsageStats).toHaveBeenCalledTimes(2))
})

test('target changes clear old results and failed reads never render stale totals', async () => {
  render(<UsageSettingsPage />)
  await screen.findByTestId('usage-totalTokens')
  vi.mocked(readUsageStats).mockRejectedValue(new Error('Target offline'))
  fireEvent.change(screen.getByTestId('usage-target'), { target: { value: 'remote' } })
  expect(screen.queryByTestId('usage-totalTokens')).not.toBeInTheDocument()
  expect(await screen.findByRole('alert')).toHaveTextContent('无法读取用量')
  expect(screen.getByRole('alert')).not.toHaveTextContent('Target offline')
  expect(readUsageStats).toHaveBeenLastCalledWith('remote')
  vi.mocked(readUsageStats).mockResolvedValue({ ...stats, history: null })
  fireEvent.click(screen.getByTestId('usage-refresh'))
  expect(await screen.findByTestId('usage-coverage')).toHaveTextContent('暂无已记录请求')
})

test('dates and models paginate independently without changing the aggregate totals', async () => {
  const many: UsageStats = {
    ...stats,
    history: {
      ...stats.history!,
      days: {
        '2026-09-08': Object.fromEntries(
          Array.from({ length: 23 }, (_, index) => [
            `model-${String(index).padStart(2, '0')}`,
            { ...emptyUsage(), requests: 1, inputTokens: 10, totalTokens: 10 },
          ])
        ),
      },
    },
  }
  vi.mocked(readUsageStats).mockResolvedValue(many)
  render(<UsageSettingsPage />)
  await screen.findByTestId('usage-table')
  const rows = () => within(screen.getByTestId('usage-table')).getAllByRole('row').slice(1)
  expect(rows()).toHaveLength(10)
  expect(rows()[0]).toHaveTextContent('2026-09-08')
  expect(screen.getByTestId('usage-page-previous')).toBeDisabled()
  fireEvent.click(screen.getByTestId('usage-page-next'))
  expect(rows()[0]).toHaveTextContent('2026-08-29')
  fireEvent.click(screen.getByTestId('usage-view-models'))
  expect(rows()).toHaveLength(10)
  expect(rows()[0]).toHaveTextContent('model-00')
  fireEvent.click(screen.getByTestId('usage-page-next'))
  fireEvent.click(screen.getByTestId('usage-page-next'))
  expect(rows()).toHaveLength(3)
  expect(rows()[0]).toHaveTextContent('model-20')
  expect(screen.getByTestId('usage-page-next')).toBeDisabled()
  expect(screen.getByTestId('usage-page-range')).toHaveTextContent('第 21–23 条，共 23 条')
  expect(screen.getByTestId('usage-totalTokens')).toHaveTextContent('230')
  fireEvent.click(screen.getByTestId('usage-view-daily'))
  expect(screen.getByTestId('usage-page-number')).toHaveTextContent('2 / 3')
  fireEvent.click(screen.getByTestId('usage-range-7'))
  expect(rows()).toHaveLength(7)
  expect(screen.getByTestId('usage-page-number')).toHaveTextContent('1 / 1')
  fireEvent.click(screen.getByTestId('usage-view-models'))
  fireEvent.change(screen.getByTestId('usage-page-size'), { target: { value: '20' } })
  expect(rows()).toHaveLength(20)
  fireEvent.click(screen.getByTestId('usage-page-next'))
  vi.mocked(readUsageStats).mockResolvedValue(stats)
  fireEvent.click(screen.getByTestId('usage-refresh'))
  await waitFor(() => expect(screen.getByTestId('usage-totalTokens')).toHaveTextContent('120'))
  expect(rows()).toHaveLength(1)
  expect(screen.getByTestId('usage-page-number')).toHaveTextContent('1 / 1')
  expect(screen.getByTestId('usage-page-next')).toBeDisabled()
})
