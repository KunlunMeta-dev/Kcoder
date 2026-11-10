import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { TaskBoard } from './TaskBoard'
import { taskWorkspaceResources } from './locales'
import type { TaskWorkspaceThreadChoice } from './NativeTaskWorkspace'
import type { WorkControlApi } from './useWorkControl'
afterEach(cleanup)
const item = (
  threadId: string,
  activity: 'running' | 'waiting_approval' | 'idle',
  stale = false
): TaskWorkspaceThreadChoice => ({
  threadId,
  title: `Task ${threadId}`,
  workspacePath: '/original',
  board: {
    targetLabel: 'Original laptop',
    stale,
    task: {
      taskId: `task-${threadId}`,
      threadId,
      title: `Task ${threadId}`,
      workspacePath: '/original',
      runtime: 'kcoder',
      runActivity: activity,
      turnStatus: 'completed',
      ...(activity === 'idle' ? { goalStatusObservation: { availability: 'available', status: null } as const } : {}),
      updatedAt: new Date().toISOString(),
    },
  },
})
async function mount(
  language = 'zh-CN',
  listingState: 'ready' | 'unavailable' = 'ready',
  extraTasks: TaskWorkspaceThreadChoice[] = [],
  control?: WorkControlApi
) {
  const i18n = createInstance()
  await i18n.init({
    lng: language,
    resources: {
      en: { taskWorkspace: taskWorkspaceResources.en },
      'zh-CN': { taskWorkspace: taskWorkspaceResources['zh-CN'] },
    },
    interpolation: { escapeValue: false },
  })
  const onSelect = vi.fn(),
    onOpen = vi.fn()
  const tasks = [
    item('live', 'running'),
    item('approve', 'waiting_approval'),
    item('done', 'idle'),
    item('stale', 'idle', true),
    ...extraTasks,
  ]
  const view = render(
    <I18nextProvider i18n={i18n}>
      <TaskBoard
        tasks={tasks}
        listingState={listingState}
        onSelect={onSelect}
        canOpen={() => true}
        onOpen={onOpen}
        control={control}
      />
    </I18nextProvider>
  )
  return { onSelect, onOpen, tasks, view, i18n }
}
test('horizontal rows show all native states without overflowing columns', async () => {
  await mount()
  const rows = screen.getAllByTestId('task-board-list-row')
  expect(rows).toHaveLength(4)
  expect(within(rows[0]).getByText('进行中')).toBeInTheDocument()
  expect(within(rows[1]).getByText('等你')).toBeInTheDocument()
  expect(within(rows[2]).getByText('已完成')).toBeInTheDocument()
  expect(within(rows[3]).getByText('状态未知')).toBeInTheDocument()
  expect(screen.queryByTestId('task-board-columns')).not.toBeInTheDocument()
})
test('a finished reply remains distinct from an unconfirmed task outcome', async () => {
  const completedReply = item('reply-only', 'idle')
  completedReply.board!.task.goalStatusObservation = { availability: 'unavailable' }
  const olderTarget = item('older-target', 'idle')
  delete olderTarget.board!.task.goalStatusObservation
  await mount('zh-CN', 'ready', [completedReply, olderTarget])
  const row = screen.getByText('Task reply-only').closest('article')!
  expect(within(row).getByText('回复已完成')).toBeInTheDocument()
  expect(within(row).getByTitle('最近一轮回复已结束，任务的整体状态暂未确认。')).toBeInTheDocument()
  const olderRow = screen.getByText('Task older-target').closest('article')!
  expect(within(olderRow).getByText('回复已完成')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^已完成/ }))
  expect(screen.queryByText('Task reply-only')).not.toBeInTheDocument()
  expect(screen.queryByText('Task older-target')).not.toBeInTheDocument()
})
test('filter and actions retain exact original identity without writing execution state', async () => {
  const { onSelect, onOpen, tasks } = await mount('en')
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a task' }), {
    target: { value: 'approve' },
  })
  expect(screen.queryByText('Task done')).toBeNull()
  const row = screen.getByTestId('task-board-list-row')
  fireEvent.click(within(row).getByRole('button', { name: /^Task approve/ }))
  expect(onSelect).toHaveBeenCalledWith(tasks[1])
  fireEvent.click(screen.getByRole('button', { name: 'Open task: Task approve' }))
  expect(onOpen).toHaveBeenCalledWith(tasks[1])
})
test('status filters operate on confirmed native state', async () => {
  await mount('en')
  fireEvent.click(screen.getByRole('button', { name: /^Completed/ }))
  expect(screen.getAllByTestId('task-board-list-row')).toHaveLength(1)
  expect(screen.getByTestId('task-board-list-row')).toHaveTextContent('Task done')
})
test('unfinished goals are not displayed or filtered as completed turns', async () => {
  const active = item('goal-active', 'idle')
  active.board!.task.goalStatusObservation = { availability: 'available', status: 'active' }
  const paused = item('goal-paused', 'idle')
  paused.board!.task.goalStatusObservation = { availability: 'available', status: 'paused' }
  await mount('zh-CN', 'ready', [active, paused])
  const activeRow = screen.getByText('Task goal-active').closest('article')!
  const pausedRow = screen.getByText('Task goal-paused').closest('article')!
  expect(within(activeRow).getByText('目标未完成')).toBeInTheDocument()
  expect(within(activeRow).getByTitle('目标尚未完成，打开任务查看进展。')).toBeInTheDocument()
  expect(within(pausedRow).getByText('目标已暂停')).toBeInTheDocument()
  expect(within(pausedRow).getByTitle('目标已暂停，可打开任务继续。')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^已完成/ }))
  expect(screen.queryByText('Task goal-active')).not.toBeInTheDocument()
  expect(screen.queryByText('Task goal-paused')).not.toBeInTheDocument()
  expect(screen.getByText('Task done')).toBeInTheDocument()
})
test('unfinished goal labels and explanations follow the selected language', async () => {
  const active = item('goal-active-en', 'idle')
  active.board!.task.goalStatusObservation = { availability: 'available', status: 'active' }
  const paused = item('goal-paused-en', 'idle')
  paused.board!.task.goalStatusObservation = { availability: 'available', status: 'paused' }
  await mount('en', 'ready', [active, paused])
  const activeRow = screen.getByText('Task goal-active-en').closest('article')!
  const pausedRow = screen.getByText('Task goal-paused-en').closest('article')!
  expect(within(activeRow).getByText('Goal unfinished')).toBeInTheDocument()
  expect(
    within(activeRow).getByTitle('The goal is unfinished. Open the task to check its progress.')
  ).toBeInTheDocument()
  expect(within(pausedRow).getByText('Goal paused')).toBeInTheDocument()
})
test('disconnected snapshots retain rows as unknown instead of reporting completion', async () => {
  await mount('zh-CN', 'unavailable')
  const rows = screen.getAllByTestId('task-board-list-row')
  expect(rows).toHaveLength(4)
  for (const row of rows) expect(within(row).getByText('状态未知')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('连接或同步暂不可用')
})

test('paginates at ten rows and resets the page when searching or changing status', async () => {
  await mount(
    'en',
    'ready',
    Array.from({ length: 17 }, (_, index) => item(`extra-${index}`, 'idle'))
  )
  expect(screen.getAllByTestId('task-board-list-row')).toHaveLength(10)
  expect(screen.getByTestId('task-board-page-previous')).toBeDisabled()
  fireEvent.click(screen.getByTestId('task-board-page-next'))
  expect(screen.getAllByTestId('task-board-list-row')).toHaveLength(10)
  expect(screen.queryByText('Task live')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('task-board-page-next'))
  expect(screen.getAllByTestId('task-board-list-row')).toHaveLength(1)
  expect(screen.getByTestId('task-board-page-next')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /^Completed/ }))
  expect(screen.getAllByTestId('task-board-list-row')).toHaveLength(10)
  expect(screen.getByTestId('task-board-page-previous')).toBeDisabled()
  fireEvent.click(screen.getByTestId('task-board-page-next'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a task' }), {
    target: { value: 'extra-0' },
  })
  expect(screen.getAllByTestId('task-board-list-row')).toHaveLength(1)
  expect(screen.getByTestId('task-board-page-previous')).toBeDisabled()
  expect(screen.getByTestId('task-board-page-next')).toBeDisabled()
})

test('shrinking the task list clamps the current page and later updates do not restore an invalid page', async () => {
  const fixture = await mount(
    'en',
    'ready',
    Array.from({ length: 17 }, (_, index) => item(`extra-${index}`, 'idle'))
  )
  fireEvent.click(screen.getByTestId('task-board-page-next'))
  fireEvent.click(screen.getByTestId('task-board-page-next'))
  const update = (tasks: TaskWorkspaceThreadChoice[]) =>
    fixture.view.rerender(
      <I18nextProvider i18n={fixture.i18n}>
        <TaskBoard
          tasks={tasks}
          listingState="ready"
          onSelect={fixture.onSelect}
          canOpen={() => true}
          onOpen={fixture.onOpen}
        />
      </I18nextProvider>
    )
  update(fixture.tasks.slice(0, 2))
  expect(screen.getAllByTestId('task-board-list-row')).toHaveLength(2)
  expect(screen.getByTestId('task-board-page-previous')).toBeDisabled()
  update(fixture.tasks)
  expect(screen.getAllByTestId('task-board-list-row')).toHaveLength(10)
  expect(screen.getByTestId('task-board-page-previous')).toBeDisabled()
})

test('defaults to the last seven calendar days and combines time, status and pagination filters', async () => {
  const daysAgo = (days: number) => {
    const date = new Date()
    date.setDate(date.getDate() - days)
    return date.toISOString()
  }
  const old = item('old', 'idle')
  old.board!.task.updatedAt = daysAgo(20)
  const ancient = item('ancient', 'idle')
  ancient.board!.task.updatedAt = daysAgo(40)
  const unknown = item('no-time', 'idle')
  unknown.board!.task.updatedAt = undefined
  const { tasks } = await mount('en', 'ready', [
    old,
    ancient,
    unknown,
    ...Array.from({ length: 10 }, (_, i) => item(`fresh-${i}`, 'idle')),
  ])
  const periods = screen.getByRole('group', { name: 'Filter by update time' })
  expect(within(periods).getByRole('button', { name: 'Last 7 days' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(screen.queryByText('Task old')).not.toBeInTheDocument()
  expect(screen.getByTestId('task-board-pagination')).toHaveTextContent('14 tasks')
  expect(
    screen.getByText('Tasks without an update time are available under All.')
  ).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('task-board-page-next'))
  fireEvent.click(within(periods).getByRole('button', { name: 'Last 30 days' }))
  expect(screen.getByTestId('task-board-page-previous')).toBeDisabled()
  expect(screen.getByTestId('task-board-pagination')).toHaveTextContent('15 tasks')
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a task' }), {
    target: { value: 'old' },
  })
  expect(screen.getByTestId('task-board-list-row')).toHaveTextContent('Task old')
  fireEvent.click(within(periods).getByRole('button', { name: 'All' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a task' }), {
    target: { value: 'no-time' },
  })
  expect(screen.getByTestId('task-board-list-row')).toHaveTextContent('Task no-time')
  fireEvent.click(within(periods).getByRole('button', { name: 'Today' }))
  expect(screen.queryByTestId('task-board-list-row')).not.toBeInTheDocument()
  expect(tasks).toHaveLength(17)
})

const controlTask = (overrides: Partial<TaskWorkspaceThreadChoice> = {}): TaskWorkspaceThreadChoice => ({
  threadId: 'controlled',
  title: 'Controlled task',
  workspacePath: '/original',
  board: {
    task: {
      taskId: 'task-controlled',
      threadId: 'controlled',
      title: 'Controlled task',
      workspacePath: '/original',
      runtime: 'kcoder',
      runActivity: 'running',
      turnStatus: 'completed',
      updatedAt: new Date().toISOString(),
    },
    work: {
      workId: 'work-1',
      threadId: 'controlled',
      phase: 'running',
      revision: 5,
      requirementsRevision: 2,
      freshness: 'current',
    },
  },
  ...overrides,
})

const controlApi = (receipt?: ReturnType<WorkControlApi['receipt']>): WorkControlApi => ({
  enabled: true,
  receipt: () => receipt,
  submit: vi.fn(),
  recheck: vi.fn(),
})

test('no control affordance is rendered without the negotiated capability', async () => {
  await mount('zh-CN', 'ready', [controlTask()])
  expect(screen.queryByTestId('task-board-control')).toBeNull()
})

test('a negotiated target exposes pause and stop for the observed work revision', async () => {
  const control = controlApi()
  await mount('zh-CN', 'ready', [controlTask()], control)
  const stop = screen.getByTestId('task-board-control-stop')
  await act(async () => {
    fireEvent.click(stop)
  })
  expect(control.submit).toHaveBeenCalledWith({
    workId: 'work-1',
    threadId: 'controlled',
    workspacePath: '/original',
    revision: 5,
    action: 'stop',
  })
  expect(control.recheck).not.toHaveBeenCalled()
})

test('an unknown receipt blocks resubmission and offers a re-read', async () => {
  const control = controlApi({ action: 'stop', state: 'unknown', requestId: 'request-1' })
  await mount('zh-CN', 'ready', [controlTask()], control)
  expect(screen.getByTestId('task-board-control-receipt').textContent).toContain('结果未知')
  expect((screen.getByTestId('task-board-control-stop') as HTMLButtonElement).disabled).toBe(true)
  await act(async () => {
    fireEvent.click(screen.getByTestId('task-board-control-recheck'))
  })
  expect(control.recheck).toHaveBeenCalledWith({ workId: 'work-1', workspacePath: '/original' })
  expect(control.submit).not.toHaveBeenCalled()
})

test('durable counters appear only when a stored value is non-zero', async () => {
  const withCounters = controlTask({
    threadId: 'counted',
    title: 'Counted task',
    board: {
      task: {
        taskId: 'task-counted',
        threadId: 'counted',
        title: 'Counted task',
        workspacePath: '/original',
        runtime: 'kcoder',
        runActivity: 'running',
        turnStatus: 'completed',
        updatedAt: new Date().toISOString(),
      },
      work: {
        workId: 'work-2',
        threadId: 'counted',
        phase: 'running',
        revision: 3,
        requirementsRevision: 2,
        freshness: 'current',
        usage: { automaticTurns: 2, consecutiveFailures: 1, stalledRounds: 0 },
        unconsumedInputs: 3,
      },
    },
  })
  await mount('zh-CN', 'ready', [withCounters])
  const counters = screen.getAllByTestId('task-board-work-counters')
  expect(counters).toHaveLength(1)
  expect(counters[0].textContent).toContain('自动轮次 2')
  expect(counters[0].textContent).toContain('连续失败 1')
  expect(counters[0].textContent).toContain('未消费要求 3 条')
  cleanup()

  // A record with zero counters and no unconsumed input stays silent.
  const quiet = controlTask({
    threadId: 'quiet',
    title: 'Quiet task',
    board: {
      task: {
        taskId: 'task-quiet',
        threadId: 'quiet',
        title: 'Quiet task',
        workspacePath: '/original',
        runtime: 'kcoder',
        runActivity: 'running',
        turnStatus: 'completed',
        updatedAt: new Date().toISOString(),
      },
      work: {
        workId: 'work-3',
        threadId: 'quiet',
        phase: 'running',
        revision: 1,
        requirementsRevision: 1,
        freshness: 'current',
        usage: { automaticTurns: 0, consecutiveFailures: 0, stalledRounds: 0 },
        unconsumedInputs: 0,
      },
    },
  })
  await mount('zh-CN', 'ready', [quiet])
  expect(screen.queryByTestId('task-board-work-counters')).toBeNull()
})

test('a recorded result is shown apart from delivery, and never as delivered unobserved', async () => {
  const withResult = (deliveryRequirement?: string, requiredDeliveryState?: string) =>
    controlTask({
      threadId: 'resulted',
      title: 'Resulted task',
      board: {
        task: {
          taskId: 'task-resulted',
          threadId: 'resulted',
          title: 'Resulted task',
          workspacePath: '/original',
          runtime: 'kcoder',
          runActivity: 'running',
          turnStatus: 'completed',
          updatedAt: new Date().toISOString(),
        },
        work: {
          workId: 'work-4',
          threadId: 'resulted',
          phase: 'running',
          revision: 2,
          requirementsRevision: 1,
          freshness: 'current',
          result: {
            resultId: 'result-1',
            ready: true,
            deliveryRequirement: deliveryRequirement ?? 'unobserved',
            requiredDeliveryState: requiredDeliveryState ?? null,
            artifactRefs: [],
          },
        },
      },
    })

  await mount('zh-CN', 'ready', [withResult()])
  expect(screen.getByTestId('task-board-work-result').textContent).toContain('交付要求未观察')
  cleanup()

  await mount('zh-CN', 'ready', [withResult('required', 'pending')])
  expect(screen.getByTestId('task-board-work-result').textContent).toContain('待交付')
  cleanup()

  // Protocol WorkDeliveryState values; a legacy 'delivered' must not read as delivered.
  for (const [state, text] of [
    ['confirmed', '已交付'],
    ['sending', '正在交付'],
    ['unknown_outcome', '交付未确认'],
    ['failed', '交付失败'],
    ['cancelled', '已取消交付'],
    ['delivered', '交付状态需核对'],
  ] as const) {
    await mount('zh-CN', 'ready', [withResult('required', state)])
    expect(screen.getByTestId('task-board-work-result').textContent, state).toContain(text)
    cleanup()
  }

  await mount('zh-CN', 'ready', [controlTask()])
  expect(screen.queryByTestId('task-board-work-result')).toBeNull()
})
