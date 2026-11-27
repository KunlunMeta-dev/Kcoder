import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { channelFixture } from '@/kcoder/channels.test-fixtures'
import { TaskChannelBindingDialog } from './TaskChannelBindingDialog'
import { TaskChannelBindingControl } from './TaskChannelBindingControl'

const owned = vi.hoisted(() => ({
  read: vi.fn(),
  act: vi.fn(),
  isCurrent: () => true,
  t: (key: string) => key,
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: owned.t }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({
  usePluginTargetScope: () => ({ key: 'original-target', isCurrent: owned.isCurrent }),
}))
vi.mock('@/kcoder/channels', async original => ({ ...await original<typeof import('@/kcoder/channels')>(), channelInventory: owned.read, channelAction: owned.act }))
beforeEach(() => {
  owned.read.mockResolvedValue(channelFixture())
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

const address = {
  deviceId: 'target', taskId: 'kcoder:target:original-session', workspacePath: '/original-workspace',
  runtimeHandle: { threadId: 'original-session' },
}

test('homepage task with only a runtime handle reads the original durable task instead of showing unsaved', async () => {
  owned.read.mockResolvedValue(channelFixture())
  render(<TaskChannelBindingDialog address={address} onClose={() => {}} />)
  await waitFor(() => expect(owned.read).toHaveBeenCalledOnce())
  await screen.findByText('chatTasks.noCurrentBinding')
  expect(screen.queryByText('chatTasks.persistedRequired')).not.toBeInTheDocument()
})

test('composer accepts an original runtime handle, but a presentation task ID alone cannot bind', () => {
  const view = render(<TaskChannelBindingControl address={address} />)
  expect(screen.getByRole('button', { name: 'chatTasks.bindTask' })).toBeEnabled()
  view.rerender(<TaskChannelBindingControl address={{ ...address, runtimeHandle: null }} />)
  expect(screen.getByRole('button', { name: 'chatTasks.bindTask' })).toBeDisabled()
})

test('navigation closes a task binding dialog without submitting a binding mutation', async () => {
  owned.read.mockResolvedValue(channelFixture())
  render(<TaskChannelBindingControl address={address} compact />)
  fireEvent.click(screen.getByRole('button', { name: 'chatTasks.bindTask' }))
  await screen.findByTestId('task-channel-binding-dialog')
  fireEvent(window, new PopStateEvent('popstate'))
  await waitFor(() => expect(screen.queryByTestId('task-channel-binding-dialog')).not.toBeInTheDocument())
  expect(owned.act).not.toHaveBeenCalled()
})

test('the shared sidebar binding dialog removes its navigation listener on unmount', () => {
  const close = vi.fn()
  const view = render(<TaskChannelBindingDialog address={address} onClose={close} />)
  fireEvent(window, new PopStateEvent('popstate'))
  expect(close).toHaveBeenCalledOnce()
  view.unmount()
  fireEvent(window, new PopStateEvent('popstate'))
  expect(close).toHaveBeenCalledOnce()
})

test('navigation still dismisses when an earlier route listener refreshes the close callback', () => {
  const originalClose = vi.fn(), currentClose = vi.fn()
  let view: ReturnType<typeof render> | undefined
  const route = () => flushSync(() => view?.rerender(
    <TaskChannelBindingDialog address={address} onClose={currentClose} />
  ))
  window.addEventListener('popstate', route)
  try {
    view = render(<TaskChannelBindingDialog address={address} onClose={originalClose} />)
    fireEvent(window, new PopStateEvent('popstate'))
    expect(currentClose).toHaveBeenCalledOnce()
    expect(originalClose).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener('popstate', route)
    view?.unmount()
  }
})
