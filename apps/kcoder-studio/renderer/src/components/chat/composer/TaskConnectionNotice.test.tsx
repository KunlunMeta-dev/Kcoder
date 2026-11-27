import { act, render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { taskConnectionStatus } from '@/kcoder/taskConnectionStatus'
import { TaskConnectionNotice } from './TaskConnectionNotice'
import '@/i18n'

test('shows only the current task connection and ignores an older recovery settling late', () => {
  const owner = {}
  const address = { deviceId: 'server', taskId: 'task' }
  const view = render(<TaskConnectionNotice address={address} />)
  const notice = () => screen.queryByTestId('task-connection-notice')
  expect(notice()).not.toBeInTheDocument()

  act(() => {
    const first = taskConnectionStatus.start(owner, 'server', 'task')
    taskConnectionStatus.start(owner, 'server', 'task')
    first(true)
  })
  expect(notice()).toHaveTextContent('连接中断，正在重连…')
  view.rerender(<TaskConnectionNotice address={{ ...address, deviceId: 'other' }} />)
  expect(notice()).not.toBeInTheDocument()

  view.rerender(<TaskConnectionNotice address={address} />)
  act(() => taskConnectionStatus.start(owner, 'server', 'task')(true))
  expect(notice()).toHaveAttribute('role', 'alert')
  expect(notice()).toHaveTextContent('重连失败，请重新打开任务。')
  act(() => taskConnectionStatus.start(owner, 'server', 'task')(false))
  expect(notice()).not.toBeInTheDocument()
  taskConnectionStatus.dispose(owner)
})
