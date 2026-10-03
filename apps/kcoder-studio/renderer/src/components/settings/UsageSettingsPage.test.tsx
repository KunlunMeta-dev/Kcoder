import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
