import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { ScheduledTasksPanel } from './ScheduledTasksPanel'
import { requestAutomation } from '@/kcoder/gatewayAutomationApi'
import type { RuntimeWorkListResponse } from '@/types/api'
import '@/i18n'

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
  vi.mocked(requestAutomation).mockReset().mockResolvedValue({ jobs: [] })
})

test('requires explicit consent and sends the one-off schedule to the selected target', async () => {
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
  fireEvent.change(screen.getByTestId('automation-prompt'), { target: { value: 'Review changes' } })
  const at = new Date(Date.now() + 3600000)
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19)
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

test('preset menu compiles local time into a recurring UTC cron schedule', async () => {
  render(<ScheduledTasksPanel runtimeWork={work} />)
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
  fireEvent.change(screen.getByTestId('automation-prompt'), { target: { value: 'Morning review' } })
  fireEvent.click(screen.getByTestId('automation-kind'))
  fireEvent.click(screen.getByRole('option', { name: '固定间隔' }))
  fireEvent.change(screen.getByTestId('automation-interval'), { target: { value: '3600' } })
  fireEvent.click(screen.getByTestId('automation-confirm'))
  fireEvent.click(screen.getByTestId('automation-create'))
  await waitFor(() =>
    expect(requestAutomation).toHaveBeenCalledWith(
      expect.anything(),
      'cron/create',
      {
        prompt: 'Morning review',
        schedule: { kind: 'every', every_seconds: 3600 },
        confirmed: true,
      }
    )
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
  fireEvent.click(screen.getByTestId('automation-confirm'))
  const next = { ...work, chats: [{ ...work.chats[0], deviceId: 'other' }] }
  rerender(<ScheduledTasksPanel runtimeWork={next} />)
  expect(screen.getByTestId('automation-confirm')).not.toBeChecked()
  expect(screen.getByTestId('automation-create')).toBeDisabled()
  await waitFor(() => expect(requestAutomation).toHaveBeenCalled())
})

