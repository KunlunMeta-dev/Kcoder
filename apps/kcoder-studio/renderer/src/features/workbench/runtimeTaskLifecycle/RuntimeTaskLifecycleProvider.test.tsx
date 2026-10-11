import { act, render } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RuntimeTaskLifecycleProvider } from './RuntimeTaskLifecycleProvider'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'

const syncDesktopTaskActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/kcoder/desktopHost', () => ({ syncDesktopTaskActivity }))

test('desktop activity includes pending tasks without sidebar entries and becomes unknown on unmount', () => {
  const store = new RuntimeTaskLifecycleStore('desktop-tray-fixture')
  const { unmount } = render(
    <RuntimeTaskLifecycleProvider store={store}>
      <div />
    </RuntimeTaskLifecycleProvider>
  )
  expect(syncDesktopTaskActivity).toHaveBeenLastCalledWith(0)
  const address = { deviceId: 'local', taskId: 'pending-task', workspacePath: '/fixture' }
  act(() => store.sendRequested(address))
  expect(syncDesktopTaskActivity).toHaveBeenLastCalledWith(1)
  act(() => store.sendRejected(address))
  expect(syncDesktopTaskActivity).toHaveBeenLastCalledWith(0)
  unmount()
  expect(syncDesktopTaskActivity).toHaveBeenLastCalledWith(null)
  const count = syncDesktopTaskActivity.mock.calls.length
  act(() => store.sendRequested(address))
  expect(syncDesktopTaskActivity).toHaveBeenCalledTimes(count)
})
