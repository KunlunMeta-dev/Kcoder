import { afterEach, expect, test, vi } from 'vitest'
import { debugRuntimePaneMessageFlow } from './paneDiagnostics'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

test('message-flow details are evaluated only while logging is enabled and are never retained', () => {
  localStorage.clear()
  const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
  let count = 1
  const details = vi.fn(() => ({ count }))
  debugRuntimePaneMessageFlow('message-action', details)
  expect(details).not.toHaveBeenCalled()
  expect(log).not.toHaveBeenCalled()
  localStorage.setItem('kcoder:debug-runtime', '1')
  debugRuntimePaneMessageFlow('message-action', details)
  expect(details).toHaveBeenCalledTimes(1)
  expect(log).toHaveBeenLastCalledWith('[KCoder Studio] Runtime pane message flow', { event: 'message-action', count: 1 })
  count = 2
  debugRuntimePaneMessageFlow('message-action', details)
  expect(details).toHaveBeenCalledTimes(2)
  expect(log).toHaveBeenLastCalledWith('[KCoder Studio] Runtime pane message flow', { event: 'message-action', count: 2 })
  localStorage.removeItem('kcoder:debug-runtime')
  debugRuntimePaneMessageFlow('message-action', details)
  expect(details).toHaveBeenCalledTimes(2)
})
