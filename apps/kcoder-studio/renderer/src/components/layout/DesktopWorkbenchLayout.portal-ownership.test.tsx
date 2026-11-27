import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test } from 'vitest'
import { installTestTransport, clearTestTransports } from '@/test/runtime-transport'
import { DesktopWorkbenchLayout, baseProps } from './DesktopWorkbenchLayout.test-harness'

afterEach(() => clearTestTransports())

const first = { deviceId: 'device-1', taskId: 'first', workspacePath: '/workspace/project' }
const second = { ...first, taskId: 'second' }
const runtimeWork = {
  projects: [],
  chats: [{
    deviceId: first.deviceId,
    workspacePath: first.workspacePath,
    available: true,
    tasks: [first, second].map(address => ({
      ...address, title: address.taskId, runtime: 'kcoder', status: 'completed',
    })),
  }],
  totalTasks: 2,
}

test.each(['/todo', '/settings'])('hides a conversation feedback portal while visiting %s and preserves its draft', async route => {
  installTestTransport(() => null)
  render(<DesktopWorkbenchLayout {...baseProps}
    state={{ ...baseProps.state, currentRuntimeTask: first, runtimeWork }} />)
  await userEvent.click(screen.getByTestId('task-feedback-button'))
  const dialog = screen.getByTestId('task-feedback-dialog-overlay')
  const note = screen.getByTestId('task-feedback-note')
  fireEvent.change(note, { target: { value: 'Original task feedback' } })
  expect(dialog).toBeVisible()

  window.history.pushState({}, '', route)
  fireEvent.popState(window)
  await waitFor(() => expect(dialog).not.toBeVisible())
  fireEvent.keyDown(document, { key: 'Escape' })

  window.history.pushState({}, '', '/')
  fireEvent.popState(window)
  await waitFor(() => expect(dialog).toBeVisible())
  expect(note).toHaveValue('Original task feedback')
})

test('switching conversations keeps feedback scoped to the original conversation', async () => {
  installTestTransport(() => null)
  const view = render(<DesktopWorkbenchLayout {...baseProps}
    state={{ ...baseProps.state, currentRuntimeTask: first, runtimeWork }} />)
  await userEvent.click(screen.getByTestId('task-feedback-button'))
  const original = screen.getByTestId('task-feedback-dialog-overlay')
  fireEvent.change(screen.getByTestId('task-feedback-note'), { target: { value: 'First task only' } })

  view.rerender(<DesktopWorkbenchLayout {...baseProps}
    state={{ ...baseProps.state, currentRuntimeTask: second, runtimeWork }} />)
  await waitFor(() => expect(original).not.toBeVisible())
  await userEvent.click(screen.getByTestId('task-feedback-button'))
  const dialogs = screen.getAllByTestId('task-feedback-dialog-overlay')
  expect(dialogs.filter(dialog => !dialog.style.display.includes('none'))).toHaveLength(1)
  expect(screen.getAllByTestId('task-feedback-note').find(note => note !== original.querySelector('textarea')))
    .toHaveValue('')
})
