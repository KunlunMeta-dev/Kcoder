import { afterEach, expect, test, vi } from 'vitest'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'
import * as diagnostics from './runtimeSidebarDiagnostics'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

test.each(['runtime_work_refreshed', 'lists_refreshed'] as const)('%s does not summarize directory IDs when logs are disabled', type => {
  localStorage.clear()
  const summarize = vi.spyOn(diagnostics, 'summarizeRuntimeWorkTaskIds')
  const work = { projects: [], chats: [], totalTasks: 0 }
  const action = type === 'runtime_work_refreshed' ? { type, runtimeWork: work }
    : { type, projects: [], devices: [], runtimeWork: work }
  const result = workbenchReducer(initialWorkbenchState, action)
  expect(result.runtimeWork).toMatchObject(work)
  expect(summarize).not.toHaveBeenCalled()
  localStorage.setItem('kcoder:debug-runtime', '1')
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  workbenchReducer(initialWorkbenchState, action)
  expect(summarize).toHaveBeenCalledTimes(3)
  expect(info).toHaveBeenCalledWith('[KCoder Studio] Runtime sidebar state', expect.objectContaining({
    event: type === 'runtime_work_refreshed' ? 'reducer-runtime-work-refreshed' : 'reducer-lists-refreshed',
    incomingTaskIds: { projects: [], chats: [] },
  }))
})

test('task visibility warnings remain available without debug logging', () => {
  localStorage.clear()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  diagnostics.warnRuntimeSidebarMismatch({ reason: 'hidden-selection' })
  expect(warning).toHaveBeenCalledWith('[KCoder Studio] Runtime sidebar selected task is hidden', { reason: 'hidden-selection' })
})
