import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { ProjectHistoryRefreshDialog } from './ProjectHistoryRefreshDialog'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/tauri/localExecutor', () => ({ requestLocalExecutor: request }))
const workspaces = [
  {
    deviceId: 'remote',
    deviceName: 'Remote',
    workspacePath: '/project',
    available: true,
    tasks: [],
  },
]

test('project history confirmation automatically progresses and reloads only after ready', async () => {
  request
    .mockReset()
    .mockResolvedValueOnce({
      status: 'building',
      nextCursor: 'next',
      examinedEntries: 128,
      indexedSessions: 3,
      issueCount: 0,
    })
    .mockResolvedValueOnce({
      status: 'ready',
      examinedEntries: 256,
      indexedSessions: 6,
      issueCount: 0,
    })
  const onReady = vi.fn().mockResolvedValue(undefined)
  render(
    <ProjectHistoryRefreshDialog workspaces={workspaces} onClose={vi.fn()} onReady={onReady} />
  )
  expect(screen.getByTestId('project-history-refresh-dialog-confirm')).toBeDisabled()
  await userEvent.click(screen.getByTestId('history-refresh-acknowledge'))
  await userEvent.click(screen.getByTestId('project-history-refresh-dialog-confirm'))
  await waitFor(() => expect(onReady).toHaveBeenCalledOnce())
  expect(request.mock.calls).toEqual([
    [
      'runtime.history.refresh',
      { deviceId: 'remote', workspacePath: '/project', acknowledgeExternalWriters: true },
    ],
    ['runtime.history.refresh', { deviceId: 'remote', workspacePath: '/project', cursor: 'next' }],
  ])
  expect(screen.getByTestId('history-refresh-progress')).toHaveTextContent('256')
})

test('closing while a history step is pending cancels its late replacement cursor', async () => {
  let release!: (result: unknown) => void
  request
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    .mockResolvedValue({
      status: 'cancelled',
      examinedEntries: 0,
      indexedSessions: 0,
      issueCount: 0,
    })
  const onClose = vi.fn()
  const view = render(<ProjectHistoryRefreshDialog workspaces={workspaces} onClose={onClose} />)
  await userEvent.click(screen.getByTestId('history-refresh-acknowledge'))
  await userEvent.click(screen.getByTestId('project-history-refresh-dialog-confirm'))
  await userEvent.click(screen.getByTestId('project-history-refresh-dialog-close'))
  expect(onClose).toHaveBeenCalledOnce()
  view.unmount()
  await act(async () => {
    release({
      status: 'building',
      nextCursor: 'late',
      examinedEntries: 128,
      indexedSessions: 3,
      issueCount: 0,
    })
  })
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  expect(request).toHaveBeenLastCalledWith('runtime.history.refresh', {
    deviceId: 'remote',
    workspacePath: '/project',
    cursor: 'late',
    cancel: true,
  })
})

test('old-server failure stays visible without automatic retry', async () => {
  request.mockReset().mockRejectedValue(new Error('Missing threadHistoryIndexRefresh'))
  render(<ProjectHistoryRefreshDialog workspaces={workspaces} onClose={vi.fn()} />)
  await userEvent.click(screen.getByTestId('history-refresh-acknowledge'))
  await userEvent.click(screen.getByTestId('project-history-refresh-dialog-confirm'))
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(request).toHaveBeenCalledOnce()
})

test('renders a Windows device workspace without its namespace prefix', () => {
  request.mockReset()
  render(
    <ProjectHistoryRefreshDialog
      workspaces={[
        {
          deviceId: 'device-1',
          deviceName: 'This computer',
          deviceStatus: 'online',
          available: true,
          workspacePath: String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-factory`,
          tasks: [],
        },
      ]}
      onClose={vi.fn()}
    />
  )
  expect(
    screen.getByText('This computer · C:/Users/kunlunmeta/projects/gpt-factory')
  ).toBeTruthy()
  expect(screen.queryByText(/\\\?\\/)).toBeNull()
})

test('sends the namespace-free workspace path to the refresh RPC', async () => {
  request.mockReset().mockResolvedValue({
    status: 'ready',
    examinedEntries: 1,
    indexedSessions: 1,
    issueCount: 0,
  })
  render(
    <ProjectHistoryRefreshDialog
      workspaces={[
        {
          deviceId: 'device-1',
          deviceName: 'This computer',
          deviceStatus: 'online',
          available: true,
          workspacePath: String.raw`\\?\C:\Users\kunlunmeta\projects\gpt-factory`,
          tasks: [],
        },
      ]}
      onClose={vi.fn()}
    />
  )
  await userEvent.click(screen.getByTestId('history-refresh-acknowledge'))
  await userEvent.click(screen.getByTestId('project-history-refresh-dialog-confirm'))
  await waitFor(() => expect(request).toHaveBeenCalled())
  expect(request.mock.calls[0]).toEqual([
    'runtime.history.refresh',
    {
      deviceId: 'device-1',
      workspacePath: 'C:/Users/kunlunmeta/projects/gpt-factory',
      acknowledgeExternalWriters: true,
    },
  ])
})
