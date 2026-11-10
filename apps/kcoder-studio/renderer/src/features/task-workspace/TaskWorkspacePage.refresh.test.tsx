import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { TaskWorkspacePage } from './TaskWorkspacePage'

const context = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))
const workTransport = vi.hoisted(() => ({ request: vi.fn(), isCurrent: () => true }))
vi.mock('@/host/localExecutor', async original => ({
  ...(await original<object>()),
  requestLocalExecutor: workTransport.request,
}))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: (serverId: string) => ({
    key: serverId,
    isCurrent: workTransport.isCurrent,
  }),
}))
vi.mock('@/lib/runtime-environment', async original => ({
  ...(await original<object>()),
  isNativeGatewayHost: () => false,
}))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => context.current }))
vi.mock('@/features/workbench/workbenchModelTarget', () => ({
  workbenchModelTarget: (state: { target: unknown }) => state.target,
}))
vi.mock('@/features/workbench/runtimeTaskLifecycle', () => ({
  useRuntimeTaskLifecycle: () => undefined,
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./NativeTaskWorkspace', () => ({
  NativeTaskWorkspace: ({
    tasks,
    onNewTask,
  }: {
    tasks: { threadId: string; workId?: string; title: string }[]
    onNewTask?: () => void
  }) => (
    <div>
      <button onClick={onNewTask}>ordinary-new-task</button>
      <div data-testid="actual-task-choices">
        {tasks.map(task => (
          <span key={`${task.threadId}:${task.workId ?? ''}`}>
            {task.threadId} {task.title}
          </span>
        ))}
      </div>
    </div>
  ),
}))
afterEach(cleanup)
beforeEach(() => {
  workTransport.request
    .mockReset()
    .mockResolvedValue({ status: 'unsupported', items: [], pageCount: 0 })
})
function value(refreshWorkLists: () => Promise<void>, task = '', target = 'local') {
  return {
    refreshWorkLists,
    openRuntimeTask: vi.fn(),
    startNewChat: vi.fn(),
    selectStandaloneDevice: vi.fn(),
    services: null,
    state: {
      target: { deviceId: target, workspacePath: '/owned' },
      devices: [
        { device_id: 'local', name: 'Local' },
        { device_id: 'peer', name: 'Peer' },
      ],
      runtimeWork: {
        chats: [
          {
            deviceId: target,
            workspacePath: '/owned',
            tasks: task ? [{ threadId: task, title: 'Original accepted task' }] : [],
          },
        ],
        projects: [],
      },
    },
  }
}
test('shows distinct business work from the same original conversation without a duplicate session row', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  context.current = value(refresh, 'original-thread')
  const batch = {
    status: 'complete',
    pageCount: 1,
    items: [
      {
        workId: 'work-1',
        threadId: 'original-thread',
        title: 'First objective',
        phase: 'pending',
        freshness: 'partial',
        revision: 1,
        requirementsRevision: 1,
      },
      {
        workId: 'work-2',
        threadId: 'original-thread',
        title: 'Second objective',
        phase: 'pending',
        freshness: 'partial',
        revision: 1,
        requirementsRevision: 1,
      },
    ],
  }
  workTransport.request.mockResolvedValue(batch)
  render(<TaskWorkspacePage />)
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  const rows = screen.getByTestId('actual-task-choices')
  await waitFor(() => expect(rows).toHaveTextContent('First objective'))
  expect(rows).toHaveTextContent('Second objective')
  expect(rows).not.toHaveTextContent('Original accepted task')
  expect(workTransport.request).toHaveBeenCalledWith(
    'runtime.continuousWork.list',
    { deviceId: 'local', workspacePath: '/owned' },
    expect.objectContaining({ signal: expect.any(AbortSignal) })
  )
  const previousCalls = workTransport.request.mock.calls.length
  let finish!: (value: typeof batch) => void
  workTransport.request.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  fireEvent.click(screen.getByTestId('task-workspace-refresh-tasks'))
  await waitFor(() =>
    expect(workTransport.request.mock.calls.length).toBeGreaterThan(previousCalls)
  )
  expect(rows).toHaveTextContent('First objective')
  await act(async () => finish(batch))
  workTransport.request.mockResolvedValue({ ...batch, incomplete: true })
  fireEvent.click(screen.getByTestId('task-workspace-refresh-tasks'))
  await screen.findByText('board.workUnavailable')
  expect(rows).toHaveTextContent('First objective')
})
test('entering the task workspace refreshes real workbench task choices without opening or selecting a task', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  context.current = value(refresh)
  const view = render(<TaskWorkspacePage />)
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('actual-task-choices').textContent).toBe('')
  context.current = value(refresh, 'original-accepted-thread')
  view.rerender(<TaskWorkspacePage />)
  expect(screen.getByTestId('actual-task-choices')).toHaveTextContent('original-accepted-thread')
  expect(context.current.openRuntimeTask).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('task-workspace-refresh-tasks'))
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  expect(screen.getByTestId('actual-task-choices')).toHaveTextContent('original-accepted-thread')
})
test('the task board includes original expert and channel tasks in the same directory', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  const current = value(refresh, 'ordinary-thread')
  const owner = { accountId: 'owner', targetId: 'target', workspaceId: null }
  const ordinary = current.state.runtimeWork.chats[0].tasks[0]
  const tasks = [ordinary,
    { threadId: 'channel-thread', title: 'Channel', runtimeHandle: { channelTaskSource: { owner, channelId: 'feishu' } } },
    { threadId: 'expert-thread', title: 'Expert', runtimeHandle: { agentDefinition: {
      owner, definition: { id: 'expert', version: '1', definitionSha256: 'a'.repeat(64) }, title: 'Expert', source: 'expert',
    } } },
  ]
  Object.assign(current.state.runtimeWork.chats[0], { tasks })
  context.current = current
  render(<TaskWorkspacePage />)
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  const choices = Array.from(screen.getByTestId('actual-task-choices').children).map(
    choice => choice.textContent?.split(' ')[0]
  )
  expect(choices).toEqual(['ordinary-thread', 'channel-thread', 'expert-thread'])
  expect(current.state.runtimeWork.chats[0].tasks).toHaveLength(3)
})

test('failed task refresh stays visible and the original refresh action can retry', async () => {
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(new Error('Owned target unavailable'))
    .mockResolvedValue(undefined)
  context.current = value(refresh)
  render(<TaskWorkspacePage />)
  await screen.findByTestId('task-workspace-task-list-error')
  fireEvent.click(screen.getByTestId('task-workspace-refresh-tasks'))
  await waitFor(() => expect(screen.queryByTestId('task-workspace-task-list-error')).toBeNull())
  expect(refresh).toHaveBeenCalledTimes(2)
})
test('a late failed refresh from a replaced target cannot overwrite the current refresh state', async () => {
  let rejectOriginal!: (error: Error) => void
  const refresh = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOriginal = reject
        })
    )
    .mockResolvedValue(undefined)
  context.current = value(refresh)
  const view = render(<TaskWorkspacePage />)
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  context.current = value(refresh, 'peer-original', 'peer')
  view.rerender(<TaskWorkspacePage />)
  fireEvent.change(screen.getByRole('combobox', { name: 'targetLabel' }), {
    target: { value: 'peer' },
  })
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  await act(async () => {
    rejectOriginal(new Error('Old target ended'))
  })
  expect(screen.queryByTestId('task-workspace-task-list-error')).toBeNull()
  expect(screen.getByTestId('actual-task-choices')).toHaveTextContent('peer-original')
  expect(screen.getByTestId('task-workspace-refresh-tasks')).not.toBeDisabled()
})

test('opens the board automatically for the real Gateway local host regardless of the conversation target', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  const current = value(refresh, 'current-host-thread', 'cyx-custom-host')
  current.state.target = { deviceId: 'peer', workspacePath: '/peer' }
  current.state.devices = [
    { device_id: 'peer', name: 'Peer', device_type: 'remote', capabilities: ['kcoder-gateway'] },
    {
      device_id: 'cyx-custom-host',
      name: 'Current computer',
      device_type: 'remote',
      capabilities: ['kcoder-gateway', 'kcoder-gateway-local'],
    },
  ] as typeof current.state.devices
  context.current = current
  render(<TaskWorkspacePage />)
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('combobox', { name: 'targetLabel' })).toHaveValue('cyx-custom-host')
  expect(screen.getByTestId('actual-task-choices')).toHaveTextContent('current-host-thread')
  expect(screen.queryByText('noTarget')).not.toBeInTheDocument()
  expect(current.openRuntimeTask).not.toHaveBeenCalled()
})

test('shows the board when local host metadata arrives without requiring selection', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  const initial = value(refresh)
  initial.state.devices = []
  context.current = initial
  const view = render(<TaskWorkspacePage />)
  expect(refresh).not.toHaveBeenCalled()
  expect(screen.queryByTestId('actual-task-choices')).not.toBeInTheDocument()
  context.current = value(refresh, 'loaded-current-host-thread')
  view.rerender(<TaskWorkspacePage />)
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('actual-task-choices')).toHaveTextContent('loaded-current-host-thread')
})

test('keeps a manual target across refreshes and returns to the local host if that target is removed', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined)
  context.current = value(refresh, 'host-thread')
  const view = render(<TaskWorkspacePage />)
  fireEvent.change(screen.getByRole('combobox', { name: 'targetLabel' }), {
    target: { value: 'peer' },
  })
  context.current = value(refresh, 'host-thread')
  view.rerender(<TaskWorkspacePage />)
  expect(screen.getByRole('combobox', { name: 'targetLabel' })).toHaveValue('peer')
  const next = value(refresh, 'host-thread')
  next.state.devices = next.state.devices.filter(device => device.device_id !== 'peer')
  context.current = next
  view.rerender(<TaskWorkspacePage />)
  expect(screen.getByRole('combobox', { name: 'targetLabel' })).toHaveValue('local')
  expect(screen.getByTestId('actual-task-choices')).toHaveTextContent('host-thread')
})

test('new task reuses the existing conversation entry without creating a workflow or task locally', async () => {
  context.current = value(vi.fn().mockResolvedValue(undefined))
  render(<TaskWorkspacePage />)
  fireEvent.click(screen.getByRole('button', { name: 'ordinary-new-task' }))
  expect(context.current.startNewChat).toHaveBeenCalledTimes(1)
  expect(context.current.selectStandaloneDevice).not.toHaveBeenCalled()
  expect(context.current.openRuntimeTask).not.toHaveBeenCalled()
})
test('new task on a different selected target uses the original standalone navigation for that target', async () => {
  context.current = value(vi.fn().mockResolvedValue(undefined))
  render(<TaskWorkspacePage />)
  fireEvent.change(screen.getByRole('combobox', { name: 'targetLabel' }), {
    target: { value: 'peer' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'ordinary-new-task' }))
  expect(context.current.selectStandaloneDevice).toHaveBeenCalledWith('peer')
  expect(context.current.startNewChat).not.toHaveBeenCalled()
})

test('the refresh affordance stays actionable while a refresh is still in flight', async () => {
  let settle: (() => void) | undefined
  const pending = new Promise<void>(resolve => {
    settle = resolve
  })
  const refresh = vi.fn().mockReturnValue(pending)
  context.current = value(refresh)
  render(<TaskWorkspacePage />)
  await waitFor(() => expect(refresh).toHaveBeenCalled())
  const button = screen.getByTestId('task-workspace-refresh-tasks') as HTMLButtonElement
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-busy')).toBe('true')
  await act(async () => {
    settle?.()
  })
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('false'))
})
