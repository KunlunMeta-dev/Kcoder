import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ScheduledTasksPanel } from './ScheduledTasksPanel'
import { requestAutomation } from '@/kcoder/gatewayAutomationApi'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import type { RuntimeWorkListResponse } from '@/types/api'
import '@/i18n'

vi.mock('@/kcoder/gatewayRpc', () => ({ fetchGatewayServers: vi.fn() }))

vi.mock('@/kcoder/gatewayAutomationApi', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kcoder/gatewayAutomationApi')>()),
  requestAutomation: vi.fn(),
}))

const work = {
  projects: [],
  totalTasks: 1,
  chats: [
    {
      deviceId: 'local',
      workspacePath: '/workspace',
      tasks: [
        {
          taskId: 'task',
          title: 'Review',
          workspacePath: '/workspace',
          runtime: 'kcoder',
          running: false,
        },
      ],
    },
  ],
} as RuntimeWorkListResponse

beforeEach(() => {
  vi.mocked(fetchGatewayServers)
    .mockReset()
    .mockResolvedValue([
      { id: 'local', transport: 'local', label: 'Local' },
      { id: 'other', transport: 'local', label: 'Other' },
    ])
  vi.mocked(requestAutomation).mockReset().mockResolvedValue({ jobs: [] })
})

function rebuiltWorkMetadata(): RuntimeWorkListResponse {
  return {
    ...work,
    chats: work.chats.map(workspace => ({
      ...workspace,
      label: 'Updated workspace label',
      tasks: workspace.tasks.map(task => ({ ...task, title: 'Updated title', running: true })),
    })),
  }
}

test('same execution scope metadata updates do not restart the list poll or issue duplicate requests', async () => {
  const view = render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalledTimes(1))
  for (let update = 0; update < 3; update++) {
    view.rerender(<ScheduledTasksPanel runtimeWork={rebuiltWorkMetadata()} />)
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  expect(requestAutomation).toHaveBeenCalledTimes(1)
})

test('a pending list remains valid when the same device/workspace metadata object is rebuilt', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(requestAutomation).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const view = render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalledTimes(1))
  view.rerender(<ScheduledTasksPanel runtimeWork={rebuiltWorkMetadata()} />)
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await act(async () =>
    finish({
      jobs: [
        {
          id: 'pending-job',
          prompt: 'Pending list retained',
          next_run_at: '2030-01-01T00:00:00Z',
          last_fired_at: null,
          schedule: { kind: 'at', at: '2030-01-01T00:00:00Z' },
        },
      ],
    })
  )
  fireEvent.click(screen.getByTestId('automation-tab-history'))
  expect(await screen.findByTestId('automation-job')).toHaveTextContent('Pending list retained')
})

test('an account change rejects its pending list even when device and workspace are unchanged', async () => {
  let finish!: (value: unknown) => void
  vi.mocked(requestAutomation).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const job = {
    id: 'new-account-job',
    prompt: 'New account schedule',
    next_run_at: '2030-01-01T00:00:00Z',
    last_fired_at: null,
    schedule: { kind: 'at', at: '2030-01-01T00:00:00Z' },
  }
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalledTimes(1))
  vi.mocked(requestAutomation).mockResolvedValue({ jobs: [job] })
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    {
      id: 'local',
      transport: 'local',
      label: 'Local',
      authorityId: 'new-authority',
      security: { identity: { mode: 'kcoder-account' } },
      accountIdentity: { principalId: 'new-account', username: 'Bob', role: 'user' },
    },
  ])
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  await waitFor(() => expect(screen.getByTestId('automation-identity')).toHaveTextContent('Bob'))
  await waitFor(() => expect(requestAutomation).toHaveBeenCalledTimes(2))
  await act(async () =>
    finish({ jobs: [{ ...job, id: 'old-account-job', prompt: 'Old private schedule' }] })
  )
  fireEvent.click(screen.getByTestId('automation-tab-history'))
  expect(await screen.findByTestId('automation-job')).toHaveTextContent('New account schedule')
  expect(screen.queryByText('Old private schedule')).not.toBeInTheDocument()
})

test('requires explicit consent and sends the one-off schedule to the selected target', async () => {
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
  fireEvent.change(screen.getByTestId('automation-prompt'), { target: { value: 'Review changes' } })
  const at = new Date(Date.now() + 3600000)
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
  fireEvent.change(screen.getByTestId('automation-at'), { target: { value: local } })
  expect(screen.getByTestId('automation-create')).toBeDisabled()
  fireEvent.click(screen.getByTestId('automation-confirm'))
  fireEvent.click(screen.getByTestId('automation-create'))
  await waitFor(() =>
    expect(requestAutomation).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/workspace', deviceId: 'local' }),
      'cron/create',
      {
        prompt: 'Review changes',
        // `datetime-local` has only second-level precision; sub-second components are zeroed.
        schedule: { kind: 'at', at: new Date(local).toISOString() },
        confirmed: true,
      }
    )
  )
})

test('interval preset retains interval scheduling', async () => {
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
  fireEvent.change(screen.getByTestId('automation-prompt'), { target: { value: 'Morning review' } })
  fireEvent.click(screen.getByTestId('automation-kind'))
  fireEvent.click(screen.getByRole('option', { name: '固定间隔' }))
  fireEvent.change(screen.getByTestId('automation-interval'), { target: { value: '3600' } })
  fireEvent.click(screen.getByTestId('automation-confirm'))
  fireEvent.click(screen.getByTestId('automation-create'))
  await waitFor(() =>
    expect(requestAutomation).toHaveBeenCalledWith(expect.anything(), 'cron/create', {
      prompt: 'Morning review',
      schedule: { kind: 'every', every_seconds: 3600 },
      confirmed: true,
    })
  )
  // After successful creation, switch to the history tab automatically
  expect(screen.getByTestId('automation-tab-history')).toHaveAttribute('aria-selected', 'true')
})

test('does not claim a fired job was deleted or its execution cancelled', async () => {
  vi.mocked(requestAutomation).mockImplementation(async (_address, method) =>
    method === 'cron/delete'
      ? { deleted: false }
      : {
          jobs: [
            {
              id: 'fired',
              prompt: 'Scheduled fixture',
              next_run_at: '2030-01-01T00:00:00Z',
              last_fired_at: null,
              schedule: { kind: 'at', at: '2030-01-01T00:00:00Z' },
            },
          ],
        }
  )
  render(<ScheduledTasksPanel runtimeWork={work} />)
  fireEvent.click(await screen.findByTestId('automation-tab-history'))
  await screen.findByTestId('automation-job')
  fireEvent.click(screen.getByRole('button', { name: '删除', exact: true }))
  fireEvent.click(screen.getAllByRole('button', { name: '删除', exact: true }).at(-1)!)
  expect(await screen.findByRole('alert')).toHaveTextContent('没有取消已经开始的执行')
})

test('does not reuse consent when the selected execution target disappears', async () => {
  const { rerender } = render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
  fireEvent.click(screen.getByTestId('automation-confirm'))
  const next = { ...work, chats: [{ ...work.chats[0], deviceId: 'other' }] }
  rerender(<ScheduledTasksPanel runtimeWork={next} />)
  expect(screen.getByTestId('automation-confirm')).not.toBeChecked()
  expect(screen.getByTestId('automation-create')).toBeDisabled()
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
})

test('account changes discard consent and ignore the prior account creation response', async () => {
  let finishCreate!: (value: unknown) => void
  vi.mocked(requestAutomation).mockImplementation(async (_address, method) => {
    if (method === 'cron/create')
      return new Promise(resolve => {
        finishCreate = resolve
      })
    return { jobs: [] }
  })
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
  fireEvent.change(screen.getByTestId('automation-prompt'), {
    target: { value: 'Alice private draft' },
  })
  fireEvent.change(screen.getByTestId('automation-at'), { target: { value: '2030-01-01T09:00' } })
  fireEvent.click(screen.getByTestId('automation-confirm'))
  fireEvent.click(screen.getByTestId('automation-create'))
  await waitFor(() => expect(finishCreate).toBeTypeOf('function'))
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    {
      id: 'local',
      transport: 'local',
      security: { identity: { mode: 'kcoder-account' } },
      accountIdentity: { principalId: 'bob', username: 'Bob', role: 'user' },
    },
  ])
  act(() => window.dispatchEvent(new Event('kcoder:servers-changed')))
  await waitFor(() => expect(screen.getByTestId('automation-identity')).toHaveTextContent('Bob'))
  expect(screen.getByTestId('automation-prompt')).toHaveValue('')
  expect(screen.getByTestId('automation-confirm')).not.toBeChecked()
  fireEvent.change(screen.getByTestId('automation-prompt'), { target: { value: 'Bob draft' } })
  await act(async () => finishCreate({ job: { id: 'alice-job' } }))
  expect(screen.getByTestId('automation-prompt')).toHaveValue('Bob draft')
  expect(screen.getByTestId('automation-tab-settings')).toHaveAttribute('aria-selected', 'true')
})

test('monthly preset submits a timezone and renders resolved translated values', async () => {
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
  fireEvent.change(screen.getByTestId('automation-prompt'), { target: { value: 'Monthly review' } })
  fireEvent.click(screen.getByTestId('automation-kind'))
  fireEvent.click(screen.getByRole('option', { name: '每月' }))
  fireEvent.change(screen.getByTestId('automation-time-of-day'), { target: { value: '00:30' } })
  expect(screen.getByTestId('scheduled-tasks-panel')).toHaveTextContent('每月1日 00:30')
  expect(screen.getByTestId('scheduled-tasks-panel')).not.toHaveTextContent('{time}')
  fireEvent.click(screen.getByTestId('automation-confirm'))
  fireEvent.click(screen.getByTestId('automation-create'))
  await waitFor(() =>
    expect(requestAutomation).toHaveBeenCalledWith(expect.anything(), 'cron/create', {
      prompt: 'Monthly review',
      schedule: {
        kind: 'zoned_cron',
        expression: '30 0 1 * *',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      confirmed: true,
    })
  )
})

// Model-independent mount/routing boundary: execution history must open the persisted thread.
test('history shows actual execution receipts and opens their target thread', async () => {
  vi.mocked(requestAutomation).mockResolvedValue({
    jobs: [],
    executionDiagnostics: {
      runs: [
        {
          triggerId: 'cron:fixture:due',
          jobId: 'fixture',
          scheduledAt: '2026-10-03T09:00:00Z',
          recordedAt: '2026-10-03T09:00:00Z',
          status: 'failed',
          workspacePath: '/workspace',
          threadId: 'actual-thread',
          failureStage: 'starting_turn',
          error: 'provider unavailable',
          automaticReplay: false,
        },
      ],
      serviceRequired: true,
      automaticReplay: false,
      offlinePolicy: 'wait-for-host-and-service',
    },
  })
  const onOpenTask = vi.fn().mockResolvedValue(undefined)
  render(<ScheduledTasksPanel runtimeWork={work} onOpenTask={onOpenTask} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
  fireEvent.click(screen.getByTestId('automation-tab-history'))
  await screen.findByTestId('automation-run')
  expect(screen.getByRole('alert')).toHaveTextContent('provider unavailable')
  fireEvent.click(screen.getByTestId('automation-run-open-thread'))
  await waitFor(() =>
    expect(onOpenTask).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'local',
        workspacePath: '/workspace',
        threadId: 'actual-thread',
      })
    )
  )
})
