import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { TaskBoard } from '../TaskBoard'
import { taskWorkspaceResources } from '../locales'
import type { TaskWorkspaceThreadChoice } from '../NativeTaskWorkspace'
import type { ContinuousWorkView } from '../../../../../shared/generated/contracts'

afterEach(cleanup)

const task = (
  id: string,
  work?: Partial<ContinuousWorkView>
): TaskWorkspaceThreadChoice => ({
  threadId: id,
  title: `Task ${id}`,
  workspacePath: '/original',
  board: {
    targetLabel: 'Original laptop',
    stale: false,
    task: {
      taskId: `task-${id}`,
      threadId: id,
      title: `Task ${id}`,
      workspacePath: '/original',
      runtime: 'kcoder',
      runActivity: 'running',
      turnStatus: 'completed',
      updatedAt: new Date().toISOString(),
    },
    ...(work === undefined
      ? {}
      : {
          work: {
            workId: `work-${id}`,
            threadId: id,
            phase: 'running',
            revision: 1,
            requirementsRevision: 1,
            freshness: 'current',
            ...work,
          },
        }),
  },
})

async function mount(tasks: TaskWorkspaceThreadChoice[]) {
  const i18n = createInstance()
  await i18n.init({
    lng: 'zh-CN',
    resources: {
      en: { taskWorkspace: taskWorkspaceResources.en },
      'zh-CN': { taskWorkspace: taskWorkspaceResources['zh-CN'] },
    },
    interpolation: { escapeValue: false },
  })
  render(
    <I18nextProvider i18n={i18n}>
      <TaskBoard
        tasks={tasks}
        listingState="ready"
        onSelect={() => {}}
        canOpen={() => true}
        onOpen={() => {}}
      />
    </I18nextProvider>
  )
}

test('an observed pending queue shows every state and never claims consumption', async () => {
  await mount([
    task('queued', {
      unconsumedInputs: 3,
      pendingInputs: [
        { inputId: 'input-1', sequence: 1, state: 'queued' },
        { inputId: 'input-2', sequence: 2, state: 'rejected' },
        { inputId: 'input-3', sequence: 3, state: 'queued' },
      ],
    }),
  ])
  const pending = screen.getByTestId('task-board-pending-inputs')
  expect(pending).toHaveTextContent('已受理但尚未进入请求的要求 3 条')
  expect(within(pending).getByText('已排队')).toBeInTheDocument()
  expect(within(pending).getByText('已拒绝')).toBeInTheDocument()
  // The queue is reported as observed states, not as the bare watermark count.
  expect(pending).not.toHaveTextContent('未消费要求')
  expect(within(pending).queryByText('已应用')).toBeNull()
})

test('an unknown pending state is shown as needing review rather than applied', async () => {
  await mount([
    task('future', {
      pendingInputs: [{ inputId: 'input-1', sequence: 1, state: 'future_state' }],
    }),
  ])
  const pending = screen.getByTestId('task-board-pending-inputs')
  expect(within(pending).getByText('需核对')).toBeInTheDocument()
  expect(within(pending).queryByText('已应用')).toBeNull()
  expect(within(pending).queryByText('已排队')).toBeNull()
})

test('a record that only carries the count keeps the bare counter', async () => {
  await mount([task('counted', { unconsumedInputs: 2 })])
  expect(screen.queryByTestId('task-board-pending-inputs')).toBeNull()
  expect(screen.getByTestId('task-board-work-counters')).toHaveTextContent('未消费要求 2 条')
})

test('an observed empty queue shows nothing instead of an unobserved count', async () => {
  await mount([task('empty', { unconsumedInputs: 0, pendingInputs: [] })])
  expect(screen.queryByTestId('task-board-work-counters')).toBeNull()
})
