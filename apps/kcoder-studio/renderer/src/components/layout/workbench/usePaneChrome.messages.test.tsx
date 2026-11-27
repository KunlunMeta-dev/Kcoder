import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import { usePaneChrome } from './usePaneChrome'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  scope: { key: 'owned-account', isCurrent: () => true },
}))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: mocks.request }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({ openRuntimeTask: vi.fn() }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => mocks.scope }))
vi.mock('./useSubagentWorkspaceHost', () => ({ useSubagentWorkspaceHost: () => ({ statuses: [] }) }))
vi.mock('@/kcoder/backgroundIssues', () => ({ useTaskBackgroundIssues: () => [] }))
vi.mock('@/features/connectivity/TaskChannelBindingControl', () => ({ TaskChannelBindingControl: () => null }))
vi.mock('../workspace-panels/WorkspacePanelActions', () => ({ WorkspacePanelActions: () => null }))
vi.mock('../DesktopWindowControls', () => ({ DesktopWindowControls: () => null }))

const original: RuntimeTaskAddress = { deviceId: 'owned', taskId: 'source', workspacePath: '/owned',
  runtimeHandle: { sessionId: 'parent', memoryTaskSnapshot: { sequence: 1 } } }
const receiver = { threadId: 'receiver', title: 'Owned receiver', status: 'idle', presence: 'resident',
  allowedModes: ['enqueue_only'] }
const context = {
  paneActive: true, workbenchVisible: true, isGateway: true,
  paneSession: { historyReadOnly: false }, background: {},
  t: (key: string) => key, tChat: (key: string) => key,
  previousRightPanelSessionKeyRef: { current: 'owned' }, rightPanelSessionKey: 'owned',
}
function Chrome({ address, header = 'main' }: { address: RuntimeTaskAddress; header?: 'main' | 'right' }) {
  const chrome = usePaneChrome({ ...context, currentRuntimeTask: address } as Parameters<typeof usePaneChrome>[0], vi.fn())
  return <>{header === 'main' ? chrome.mainHeaderActions : chrome.topRightActions}</>
}
const calls = (operation: string) => mocks.request.mock.calls.filter(([, input]) => input.operation === operation)
async function open() {
  fireEvent.click(screen.getByTestId('session-messages-open'))
  await waitFor(() => expect(screen.getByTestId('session-message-target')).toBeEnabled())
}
beforeEach(() => {
  mocks.scope = { key: 'owned-account', isCurrent: () => true }
  mocks.request.mockReset()
  window.localStorage.clear()
  Object.defineProperty(navigator, 'locks', { configurable: true,
    value: { request: async (_key: string, work: () => Promise<unknown>) => work() } })
  mocks.request.mockImplementation(async (_command, input) => {
    if (input.operation === 'supports') return { scope: 'owned-message-scope', sourceThreadId: 'parent', discovery: true, messages: true, search: true }
    if (input.operation === 'policyRead') return { enabled: true, wakeIdle: false, revision: 'one' }
    if (input.operation === 'targets') return { coverage: 'workspace_history', completeness: 'complete', targets: [receiver] }
    throw Error('No mutation belongs to this display test')
  })
})
afterEach(cleanup)

test.each(['main', 'right'] as const)('same original task enrichment preserves the %s message panel without rereading', async header => {
  const view = render(<Chrome address={original} header={header} />)
  await open()
  fireEvent.click(screen.getByTestId('session-message-target'))
  const dialog = screen.getByTestId('session-messages-dialog')
  const input = screen.getByTestId('session-message-input')
  fireEvent.change(input, { target: { value: 'Keep the unsent original draft' } })
  fireEvent.change(screen.getByTestId('session-message-title-search'), { target: { value: 'Unsubmitted search' } })
  const before = mocks.request.mock.calls.length
  view.rerender(<Chrome header={header} address={{ ...original, threadId: 'parent',
    runtimeHandle: { sessionId: 'parent', memoryTaskSnapshot: { sequence: 2 }, expertBinding: { revision: 2 } } }} />)
  expect(screen.getByTestId('session-messages-dialog')).toBe(dialog)
  expect(screen.getByTestId('session-message-input')).toBe(input)
  expect(input).toHaveValue('Keep the unsent original draft')
  expect(screen.getByTestId('session-message-title-search')).toHaveValue('Unsubmitted search')
  expect(mocks.request).toHaveBeenCalledTimes(before)
  expect(calls('targets')).toHaveLength(1)
  expect(mocks.request.mock.calls.some(([, input]) => ['send', 'policySave'].includes(input.operation))).toBe(false)
})

test.each([
  { taskId: 'another-task' },
  { deviceId: 'another-device' },
  { workspacePath: '/another-workspace' },
  { threadId: 'another-thread' },
  { runtimeHandle: { sessionId: 'another-thread' } },
  { expectedSessionAddress: { targetId: 'native', workspaceId: 'workspace', threadId: 'parent' } },
])('a changed original task constraint closes the message panel: %j', async changed => {
  const view = render(<Chrome address={original} />)
  await open()
  fireEvent.click(screen.getByTestId('session-message-target'))
  fireEvent.change(screen.getByTestId('session-message-input'), { target: { value: 'Private to the old task' } })
  const before = mocks.request.mock.calls.length
  view.rerender(<Chrome address={{ ...original, ...changed }} />)
  expect(screen.queryByTestId('session-messages-dialog')).not.toBeInTheDocument()
  expect(mocks.request).toHaveBeenCalledTimes(before)
  await open()
  expect(screen.getByTestId('session-message-input')).toHaveValue('')
  expect(calls('targets')).toHaveLength(2)
})

test('account lifetime replacement discards the old panel draft and reads the current scope', async () => {
  const view = render(<Chrome address={original} />)
  await open()
  fireEvent.click(screen.getByTestId('session-message-target'))
  fireEvent.change(screen.getByTestId('session-message-input'), { target: { value: 'Private to the old account' } })
  const oldDialog = screen.getByTestId('session-messages-dialog')
  mocks.scope = { key: 'replacement-account', isCurrent: () => true }
  view.rerender(<Chrome address={original} />)
  await waitFor(() => expect(screen.getByTestId('session-message-target')).toBeEnabled())
  expect(screen.getByTestId('session-messages-dialog')).not.toBe(oldDialog)
  expect(screen.getByTestId('session-message-input')).toHaveValue('')
  expect(calls('targets')).toHaveLength(2)
})
