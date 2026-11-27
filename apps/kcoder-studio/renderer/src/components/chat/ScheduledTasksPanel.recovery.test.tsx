import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import { ScheduledTasksPanel } from './ScheduledTasksPanel'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import { requestAutomation } from '@/kcoder/gatewayAutomationApi'
import '@/i18n'
import { GatewayRpcError } from '@/kcoder/gatewayRpc'
vi.mock('./ScheduledWorkflowTasks', () => ({ ScheduledWorkflowTasks: () => null }))
vi.mock('@/kcoder/gatewayRpc', async original => ({
  ...(await original<typeof import('@/kcoder/gatewayRpc')>()),
  fetchGatewayServers: vi.fn(),
}))
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
  sessionStorage.clear()
  vi.mocked(fetchGatewayServers)
    .mockReset()
    .mockResolvedValue([{ id: 'local', label: 'Owned', transport: 'local' }])
  vi.mocked(requestAutomation)
    .mockReset()
    .mockImplementation(async (_address, method, params) => {
      if (params?.creationContext) return { epoch: 0 }
      if (method === 'cron/list' && params?.clientRequestId) return { clientRequestId: params.clientRequestId, creationReceipt: null, retired: false }
      if (method === 'cron/create') throw new Error('KCoder app-server 连接已断开')
      if (method === 'cron/preview') return { nextRunAt: '2035-01-01T09:00:00Z' }
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

it('keeps a definite invalid-time rejection editable without creating an unknown operation', async () => {
  vi.mocked(requestAutomation).mockImplementation(async (_address, method, params) => {
      if (params?.creationContext) return { epoch: 0 }
      if (method === 'cron/list' && params?.clientRequestId) return { clientRequestId: params.clientRequestId, creationReceipt: null, retired: false }
    if (method === 'cron/create')
      throw new GatewayRpcError('scheduled time must be in the future', -32602, undefined, 'runtime-session', 'remote')
    if (method === 'cron/preview') return { nextRunAt: '2035-01-01T09:00:00Z' }
    return { jobs: [] }
  })
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await fill()
  fireEvent.click(screen.getByTestId('automation-create'))
  await waitFor(() => expect(document.body.textContent).toContain('执行时间已过'))
  expect(screen.queryByText(/原操作结果尚未确认/)).not.toBeInTheDocument()
  expect(screen.getByTestId('automation-prompt')).toHaveValue('Keep this unsent draft.')
  expect(screen.getByTestId('automation-confirm')).not.toBeChecked()
})

it('rejects an expired form before any create request is sent', async () => {
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await fill()
  fireEvent.change(screen.getByTestId('automation-at'), { target: { value: '2000-01-01T09:00' } })
  fireEvent.click(screen.getByTestId('automation-create'))
  await screen.findByText(/执行时间已过/)
  expect(vi.mocked(requestAutomation).mock.calls.filter(([, method]) => method === 'cron/create')).toHaveLength(0)
  expect(screen.queryByText(/原操作结果尚未确认/)).not.toBeInTheDocument()
})

it('allows legacy task creation when preview is unsupported', async () => {
  vi.mocked(requestAutomation).mockImplementation(async (_address, method, params) => {
    if (params?.creationContext) return { epoch: null }
    if (method === 'cron/preview') throw new Error('preview unsupported')
    if (method === 'cron/create') return { job: { id: 'legacy-created' } }
    return { jobs: [] }
  })
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await fill()
  await waitFor(() => expect(vi.mocked(requestAutomation).mock.calls.some(([, method]) => method === 'cron/preview')).toBe(true))
  expect(screen.getByTestId('automation-create')).toBeEnabled()
  fireEvent.click(screen.getByTestId('automation-create'))
  await waitFor(() => expect(vi.mocked(requestAutomation).mock.calls.some(([, method]) => method === 'cron/create')).toBe(true))
  const creation = vi.mocked(requestAutomation).mock.calls.find(([, method]) => method === 'cron/create')!
  expect(creation[2]).not.toHaveProperty('clientRequestId')
})

it('restores the pending identity on re-entry and reconciles it without resending creation', async () => {
  let found = false
  vi.mocked(requestAutomation).mockImplementation(async (_address, method, params) => {
    if (params?.creationContext) return { epoch: 3 }
    if (method === 'cron/preview') return { nextRunAt: '2035-01-01T09:00:00Z' }
    if (method === 'cron/create') throw new Error('lost create reply')
    if (params?.clientRequestId) return { clientRequestId: params.clientRequestId, creationReceipt: found ? { id: 'original-job' } : null, retired: false }
    return { jobs: [] }
  })
  const first = render(<ScheduledTasksPanel runtimeWork={work} />)
  await fill()
  fireEvent.click(screen.getByTestId('automation-create'))
  await screen.findByText(/原操作结果尚未确认/)
  const id = vi.mocked(requestAutomation).mock.calls.find(([, method]) => method === 'cron/create')![2]!.clientRequestId
  expect(id).toMatch(/^cron-v1-3-/)
  first.unmount()
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await screen.findByText(/原操作结果尚未确认/)
  expect(screen.getByTestId('automation-create')).toBeDisabled()
  found = true
  fireEvent.click(screen.getByRole('button', { name: '核对任务与运行记录' }))
  await waitFor(() => expect(screen.queryByText(/原操作结果尚未确认/)).not.toBeInTheDocument())
  expect(vi.mocked(requestAutomation)).toHaveBeenCalledWith(expect.anything(), 'cron/list', { clientRequestId: id })
  expect(vi.mocked(requestAutomation).mock.calls.filter(([, method]) => method === 'cron/create')).toHaveLength(1)
  expect(Object.keys(sessionStorage).filter(key => key.startsWith('kcoder.automation.pending:'))).toHaveLength(0)
})

it('retired receipts keep the original pending operation blocked and visible', async () => {
  vi.mocked(requestAutomation).mockImplementation(async (_address, method, params) => {
    if (params?.creationContext) return { epoch: 0 }
    if (method === 'cron/preview') return { nextRunAt: '2035-01-01T09:00:00Z' }
    if (method === 'cron/create') throw new Error('lost create reply')
    if (params?.clientRequestId) return { clientRequestId: params.clientRequestId, creationReceipt: null, retired: true }
    return { jobs: [] }
  })
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await fill()
  fireEvent.click(screen.getByTestId('automation-create'))
  await screen.findByText(/原操作结果尚未确认/)
  fireEvent.click(screen.getByRole('button', { name: '核对任务与运行记录' }))
  await screen.findByText(/原操作回执已超出保留窗口/)
  expect(vi.mocked(requestAutomation).mock.calls.filter(([, method]) => method === 'cron/create')).toHaveLength(1)
  expect(Object.keys(sessionStorage).filter(key => key.startsWith('kcoder.automation.pending:'))).toHaveLength(1)
})

it('creation context read failures do not manufacture an unconfirmed write', async () => {
  vi.mocked(requestAutomation).mockImplementation(async (_address, _method, params) => {
    if (params?.creationContext) throw new Error('context unavailable')
    return { jobs: [] }
  })
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await fill()
  fireEvent.click(screen.getByTestId('automation-create'))
  await screen.findByRole('alert')
  expect(screen.queryByText(/原操作结果尚未确认/)).not.toBeInTheDocument()
  expect(vi.mocked(requestAutomation).mock.calls.some(([, method]) => method === 'cron/create')).toBe(false)
})

it('explicit refresh retries an unavailable preview without changing the draft', async () => {
  let previews = 0
  vi.mocked(requestAutomation).mockImplementation(async (_address, method) => {
    if (method === 'cron/preview') {
      if (++previews === 1) throw new Error('temporary preview outage')
      return { nextRunAt: '2035-01-01T09:00:00Z' }
    }
    return { jobs: [] }
  })
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await fill()
  await waitFor(() => expect(screen.getByTestId('automation-preview')).toHaveTextContent('无法预览'))
  expect(screen.getByTestId('automation-create')).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '刷新任务' }))
  await waitFor(() => expect(previews).toBeGreaterThan(1))
  expect(screen.getByTestId('automation-prompt')).toHaveValue('Keep this unsent draft.')
})
