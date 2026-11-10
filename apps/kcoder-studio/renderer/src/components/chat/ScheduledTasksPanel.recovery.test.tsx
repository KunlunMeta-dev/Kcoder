import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import { ScheduledTasksPanel } from './ScheduledTasksPanel'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { requestAutomation } from '@/kcoder/gatewayAutomationApi'
import '@/i18n'
vi.mock('./ScheduledWorkflowTasks', () => ({ ScheduledWorkflowTasks: () => null }))
vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: vi.fn() }))
vi.mock('@/kcoder/gatewayAutomationApi', async original => ({
  ...(await original<typeof import('@/kcoder/gatewayAutomationApi')>()),
  requestAutomation: vi.fn(),
}))
const work = {
  projects: [],
  totalTasks: 1,
  chats: [{ deviceId: 'local', workspacePath: '/workspace', tasks: [] }],
} as unknown as RuntimeWorkListResponse
beforeEach(() => {
  vi.mocked(fetchGatewayServers)
    .mockReset()
    .mockResolvedValue([{ id: 'local', label: 'Owned', transport: 'local' }])
  vi.mocked(requestAutomation)
    .mockReset()
    .mockImplementation(async (_address, method) => {
      if (method === 'cron/create') throw new Error('KCoder app-server 连接已断开')
      return { jobs: [] }
    })
})
async function fill() {
  await waitFor(() => expect(screen.getByTestId('automation-prompt')).not.toBeDisabled())
  fireEvent.change(screen.getByTestId('automation-prompt'), {
    target: { value: 'Keep this unsent draft.' },
  })
  fireEvent.change(screen.getByTestId('automation-at'), { target: { value: '2035-01-01T09:00' } })
  fireEvent.click(screen.getByTestId('automation-confirm'))
}
it('retains the draft and unknown outcome across a successful read without resending creation', async () => {
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await fill()
  fireEvent.click(screen.getByTestId('automation-create'))
  await screen.findByText(/原操作结果尚未确认/)
  expect(screen.getByTestId('automation-prompt')).toHaveValue('Keep this unsent draft.')
  expect(screen.getByTestId('automation-confirm')).not.toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '核对任务与运行记录' }))
  await waitFor(() =>
    expect(
      vi.mocked(requestAutomation).mock.calls.filter(([, method]) => method === 'cron/list').length
    ).toBeGreaterThan(1)
  )
  expect(screen.getByText(/原操作结果尚未确认/)).toBeInTheDocument()
  expect(
    vi.mocked(requestAutomation).mock.calls.filter(([, method]) => method === 'cron/create')
  ).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: '我已核对记录，开始新的操作' }))
  expect(screen.getByTestId('automation-prompt')).toHaveValue('Keep this unsent draft.')
  expect(screen.getByTestId('automation-confirm')).not.toBeChecked()
  expect(
    vi.mocked(requestAutomation).mock.calls.filter(([, method]) => method === 'cron/create')
  ).toHaveLength(1)
})
