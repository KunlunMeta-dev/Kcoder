import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ScheduledTasksPanel } from './ScheduledTasksPanel'
import { requestAutomation } from '@/kcoder/gatewayAutomationApi'
import { fetchGatewayServers } from '@/kcoder/gatewayRpc'
import type { RuntimeWorkListResponse } from '@/types/api'
import '@/i18n'

const workflowViews = vi.hoisted(() => vi.fn())
vi.mock('./ScheduledWorkflowTasks', async () => {
  const { useState } = await import('react')
  return {
    ScheduledWorkflowTasks: function MockScheduledWorkflow(props: {
      serverId: string
      workspacePath: string
      view: string
      suspended?: boolean
    }) {
      const [draft, setDraft] = useState('')
      workflowViews(props)
      return (
        <input
          aria-label="workflow draft"
          disabled={props.suspended}
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
      )
    },
  }
})
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
  workflowViews.mockReset()
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

test('selects the actual current host with a custom ID without manual target selection', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    { id: 'peer', label: 'Peer', transport: 'ssh' },
    { id: 'custom-host', label: 'My workstation', transport: 'local' },
  ])
  const customWork: RuntimeWorkListResponse = {
    ...work,
    chats: [
      { ...work.chats[0]!, deviceId: 'peer', workspacePath: '/peer' },
      { ...work.chats[0]!, deviceId: 'custom-host', label: 'My workstation' },
    ],
  }
  render(<ScheduledTasksPanel runtimeWork={customWork} currentHostId="custom-host" />)
  await waitFor(() =>
    expect(requestAutomation).toHaveBeenCalledWith(
      { deviceId: 'custom-host', workspacePath: '/workspace' },
      'cron/list'
    )
  )
  expect(screen.getByTestId('automation-target')).toHaveValue('custom-host\0/workspace')
  expect(screen.getByTestId('scheduled-task-kind')).toBeVisible()
  fireEvent.change(screen.getByTestId('automation-target'), {
    target: { value: 'peer\0/peer' },
  })
  await waitFor(() =>
    expect(requestAutomation).toHaveBeenCalledWith(
      { deviceId: 'peer', workspacePath: '/peer' },
      'cron/list'
    )
  )
})

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
  expect(screen.getByTestId('automation-run')).toHaveTextContent('fixture')
  expect(screen.queryByText('provider unavailable')).not.toBeInTheDocument()
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

test('workflow creation and inbox share the selected target and preserve draft across same-owner refresh', async () => {
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByTestId('scheduled-task-kind'), { target: { value: 'workflow' } })
  const draft = await screen.findByLabelText('workflow draft')
  fireEvent.change(draft, { target: { value: 'Owned unsent workflow arguments' } })
  expect(workflowViews).toHaveBeenLastCalledWith(
    expect.objectContaining({ serverId: 'local', workspacePath: '/workspace', view: 'create' })
  )
  fireEvent(window, new CustomEvent('kcoder:servers-changed', { detail: { targetId: 'local' } }))
  expect(screen.getByLabelText('workflow draft')).toHaveValue('Owned unsent workflow arguments')
  await waitFor(() => expect(screen.getByLabelText('workflow draft')).not.toBeDisabled())
  expect(screen.getByLabelText('workflow draft')).toHaveValue('Owned unsent workflow arguments')
  fireEvent.click(screen.getByTestId('automation-tab-inbox'))
  await waitFor(() =>
    expect(workflowViews).toHaveBeenLastCalledWith(
      expect.objectContaining({ serverId: 'local', workspacePath: '/workspace', view: 'inbox' })
    )
  )
  expect(
    vi.mocked(requestAutomation).mock.calls.some(([, method]) => method === 'cron/create')
  ).toBe(false)
})

test('ordinary scheduled task creation does not present budget settings', async () => {
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('automation-prompt')).toBeInTheDocument()
  for (const id of [
    'subscription-tokens',
    'subscription-runtime',
    'period-budget-enabled',
    'period-budget-calls',
    'period-budget-observation',
  ])
    expect(screen.queryByTestId(id)).not.toBeInTheDocument()
  expect(
    vi.mocked(requestAutomation).mock.calls.some(([, method]) => method === 'cron/create')
  ).toBe(false)
})

test('defaults to the local gateway workspace even before the work list contains it', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    { id: 'remote', transport: 'ssh', label: 'Remote', workspacePath: '/remote' },
    { id: 'host-42', transport: 'local', label: 'Custom local name', workspacePath: '/home/local' },
  ] as never)
  const empty: RuntimeWorkListResponse = { projects: [], chats: [], totalTasks: 0 }
  render(<ScheduledTasksPanel runtimeWork={empty} />)
  await waitFor(() =>
    expect(screen.getByTestId('automation-target')).toHaveValue('host-42\0/home/local')
  )
  expect(screen.getByTestId('automation-target')).toHaveDisplayValue('当前计算机')
  await waitFor(() =>
    expect(requestAutomation).toHaveBeenCalledWith(
      { deviceId: 'host-42', workspacePath: '/home/local' },
      'cron/list'
    )
  )
})

test('does not select a remote target when the local host is missing', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    { id: 'remote', transport: 'ssh', label: 'Remote', workspacePath: '/remote' },
  ] as never)
  const remoteOnly: RuntimeWorkListResponse = {
    projects: [],
    chats: [{ ...work.chats[0]!, deviceId: 'remote', workspacePath: '/remote' }],
    totalTasks: 0,
  }
  render(<ScheduledTasksPanel runtimeWork={remoteOnly} />)
  await waitFor(() => expect(fetchGatewayServers).toHaveBeenCalled())
  expect(screen.getByTestId('automation-target')).toHaveValue('')
  expect(screen.getByTestId('automation-target')).toHaveDisplayValue('当前计算机暂不可用')
  expect(requestAutomation).not.toHaveBeenCalled()
})

test('a delayed local lookup never overrides an explicit remote choice', async () => {
  let finish!: (value: Awaited<ReturnType<typeof fetchGatewayServers>>) => void
  const delayed = new Promise<Awaited<ReturnType<typeof fetchGatewayServers>>>(resolve => {
    finish = resolve
  })
  const servers = [
    { id: 'remote', transport: 'ssh', label: 'Remote', workspacePath: '/remote' },
    { id: 'host', transport: 'local', label: 'Host', workspacePath: '/local' },
  ] as never
  vi.mocked(fetchGatewayServers)
    .mockReset()
    .mockImplementationOnce(() => delayed)
    .mockResolvedValue(servers)
  const remoteOnly: RuntimeWorkListResponse = {
    projects: [],
    chats: [{ ...work.chats[0]!, deviceId: 'remote', workspacePath: '/remote' }],
    totalTasks: 0,
  }
  render(<ScheduledTasksPanel runtimeWork={remoteOnly} />)
  fireEvent.change(screen.getByTestId('automation-target'), {
    target: { value: 'remote\0/remote' },
  })
  await waitFor(() =>
    expect(requestAutomation).toHaveBeenCalledWith(
      { deviceId: 'remote', workspacePath: '/remote' },
      'cron/list'
    )
  )
  await act(async () => finish(servers))
  expect(screen.getByTestId('automation-target')).toHaveValue('remote\0/remote')
})

test('recognizes a custom local host from Gateway metadata even without a configured default workspace', async () => {
  vi.mocked(fetchGatewayServers).mockResolvedValue([
    { id: 'peer', transport: 'ssh', label: 'Remote' },
    { id: 'host-42', transport: 'local', label: 'Custom local name' },
  ] as never)
  const localWork: RuntimeWorkListResponse = {
    projects: [],
    chats: [{ ...work.chats[0]!, deviceId: 'host-42', workspacePath: '/work' }],
    totalTasks: 0,
  }
  render(<ScheduledTasksPanel runtimeWork={localWork} />)
  await waitFor(() => expect(screen.getByTestId('automation-target')).toHaveValue('host-42\0/work'))
  expect(screen.getByTestId('automation-target')).toHaveDisplayValue('当前计算机')
  await waitFor(() =>
    expect(requestAutomation).toHaveBeenCalledWith(
      { deviceId: 'host-42', workspacePath: '/work' },
      'cron/list'
    )
  )
})

test('an explicitly known current host prevents remote labels from appearing as the local computer', async () => {
  const { automationTargets } = await import('@/kcoder/gatewayAutomationApi')
  const mixed = { ...work, chats: [
    { ...work.chats[0]!, deviceId: 'peer', label: 'Remote', labelKey: 'currentComputer' },
    { ...work.chats[0]!, deviceId: 'host', label: 'Host', workspacePath: '/host' },
  ] } as RuntimeWorkListResponse
  const targets = automationTargets(mixed, '当前计算机', 'host')
  expect(targets.find(item => item.address.deviceId === 'host')?.label).toBe('当前计算机')
  expect(targets.find(item => item.address.deviceId === 'peer')?.label).toBe('Remote · peer')
})
