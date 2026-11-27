import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import chat from '@/i18n/locales/zh-CN/chat.json'
import common from '@/i18n/locales/zh-CN/common.json'
import { SessionMessagesControl } from './SessionMessagesControl'

const bridge = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/host/localExecutor', () => ({ requestLocalExecutor: bridge.request }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => ({ openRuntimeTask: vi.fn() }) }))
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => ({ key: 'owned-title-search', isCurrent: () => true }) }))
const address = { deviceId: 'owned-search', taskId: 'owned-task', threadId: 'source', workspacePath: '/owned/search' }
const receiver = (id: string, title: string) => ({ address: { targetId: 'owned-native', workspaceId: 'owned-workspace', threadId: id },
  threadId: id, title, status: 'idle', presence: 'resident', allowedModes: ['enqueue_only'] })
const page = (targets: ReturnType<typeof receiver>[], nextCursor?: string) => ({ coverage: 'workspace_history', completeness: nextCursor ? 'indexing' : 'complete', observedAtMs: Date.now(), targets, ...(nextCursor ? { nextCursor } : {}) })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeAll(async () => { await createInstance().use(initReactI18next).init({ lng: 'zh-CN', resources: { 'zh-CN': { chat, common } }, interpolation: { escapeValue: false } }) })
beforeEach(() => {
  bridge.request.mockReset(); window.localStorage.clear()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key: string, work: () => Promise<unknown>) => work() } })
})
afterEach(cleanup)
function setup(search = true) {
  bridge.request.mockImplementation(async (_command, input) => {
    if (input.operation === 'supports') return { scope: input.address.deviceId, sourceThreadId: 'source', discovery: true, messages: true, search }
    if (input.operation === 'policyRead') return { enabled: true, wakeIdle: false, revision: 'policy-one' }
    if (input.operation === 'targets') return page([receiver('default', '默认会话')])
    throw new Error('Search must not dispatch a side effect')
  })
}
async function open() {
  fireEvent.click(screen.getByTestId('session-messages-open'))
  await waitFor(() => expect(screen.getByTestId('session-message-target')).toBeEnabled())
}
const targetCalls = () => bridge.request.mock.calls.filter(([, input]) => input.operation === 'targets').map(([, input]) => input)

test('a task progress update preserves the open dialog and draft while a changed source constraint retires them', async () => {
  setup()
  const first = { ...address, runtimeHandle: { sessionId: 'source', memoryTaskSnapshot: { sequence: 1 } } }
  const view = render(<SessionMessagesControl address={first} />)
  await open()
  fireEvent.click(screen.getByTestId('session-message-target'))
  const draft = screen.getByTestId('session-message-input')
  fireEvent.change(draft, { target: { value: '保留草稿' } })
  view.rerender(<SessionMessagesControl address={{ ...first, runtimeHandle: { sessionId: 'source', memoryTaskSnapshot: { sequence: 2 } } }} />)
  expect(screen.getByTestId('session-message-input')).toBe(draft)
  expect(draft).toHaveValue('保留草稿')
  expect(targetCalls()).toHaveLength(1)
  view.rerender(<SessionMessagesControl address={{ ...first, expectedSessionAddress: receiver('source', '').address }} />)
  await waitFor(() => expect(screen.getByTestId('session-message-input')).toHaveValue(''))
  expect(targetCalls()).toHaveLength(2)
})

test('submitted title survives refresh/more while editing stays local and Clear restores the default list', async () => {
  setup(); const original = bridge.request.getMockImplementation()!
  bridge.request.mockImplementation(async (command, input) => {
    if (input.operation === 'targets' && input.title === '关键') return page([receiver('filtered', '关键会话')], 'keyword-next')
    if (input.operation === 'targets' && input.cursor === 'keyword-next') return page([receiver('more', '关键更多')])
    return original(command, input)
  })
  const outerEnter = vi.fn()
  render(<div onKeyDown={outerEnter}><SessionMessagesControl address={address} /></div>); await open()
  fireEvent.click(screen.getByTestId('session-message-target'))
  fireEvent.change(screen.getByTestId('session-message-input'), { target: { value: '保留对等消息草稿' } })
  const input = screen.getByRole('searchbox', { name: chat.peerMessages.search.label })
  fireEvent.change(input, { target: { value: '关键' } })
  expect(targetCalls()).toHaveLength(1)
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.getByText('关键会话')).toBeVisible())
  expect(outerEnter).not.toHaveBeenCalled(); expect(screen.getByTestId('session-message-send')).toBeDisabled()
  expect(screen.getByTestId('session-message-input')).toHaveValue('保留对等消息草稿')
  fireEvent.change(input, { target: { value: '尚未提交' } })
  fireEvent.click(screen.getByRole('button', { name: chat.peerMessages.refresh }))
  await waitFor(() => expect(targetCalls().filter(call => call.title === '关键')).toHaveLength(2))
  fireEvent.click(screen.getByRole('button', { name: chat.peerMessages.more }))
  await waitFor(() => expect(screen.getByText('关键更多')).toBeVisible())
  expect(targetCalls().at(-1)).toMatchObject({ cursor: 'keyword-next' }); expect(targetCalls().at(-1)?.title).toBeUndefined()
  expect(targetCalls().some(call => call.title === '尚未提交')).toBe(false)
  fireEvent.click(screen.getByTestId('session-message-search-clear'))
  await waitFor(() => expect(screen.getByText('默认会话')).toBeVisible())
  expect(input).toHaveValue(''); expect(targetCalls().at(-1)?.title).toBeUndefined()
  expect(screen.getByTestId('session-message-send')).toBeDisabled()
  expect(bridge.request.mock.calls.some(([, input]) => ['send', 'policySave', 'turn/start'].includes(input.operation))).toBe(false)
})

test('late old-title and old-context reads cannot replace the current search or restore its old selection', async () => {
  setup(); const original = bridge.request.getMockImplementation()!, old = deferred<unknown>()
  bridge.request.mockImplementation(async (command, input) => {
    if (input.operation === 'targets' && input.title === '旧') return old.promise
    if (input.operation === 'targets' && input.title === '新') return page([receiver('new', '新结果')])
    return original(command, input)
  })
  const view = render(<SessionMessagesControl address={address} />); await open()
  fireEvent.click(screen.getByTestId('session-message-target'))
  const input = screen.getByTestId('session-message-title-search')
  fireEvent.change(input, { target: { value: '旧' } }); fireEvent.click(screen.getByTestId('session-message-search-submit'))
  await waitFor(() => expect(targetCalls().some(call => call.title === '旧')).toBe(true))
  expect(screen.queryByTestId('session-message-target')).toBeNull()
  fireEvent.change(input, { target: { value: '新' } }); fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.getByText('新结果')).toBeVisible())
  await act(async () => { old.resolve(page([receiver('old', '旧结果')])); await old.promise })
  expect(screen.queryByText('旧结果')).toBeNull(); expect(screen.getByText('新结果')).toBeVisible()
  expect(screen.getByTestId('session-message-send')).toBeDisabled()
  view.rerender(<SessionMessagesControl address={{ ...address, deviceId: 'other-source', taskId: 'other-task', threadId: 'other-thread' }} />)
  await waitFor(() => expect(screen.getByText('默认会话')).toBeVisible())
  expect(screen.getByTestId('session-message-title-search')).toHaveValue('')
  expect(screen.queryByText('新结果')).toBeNull()
})

test('old advertised search absence and a rejected filtered request keep a usable explicit default list', async () => {
  setup(false)
  const view = render(<SessionMessagesControl address={address} />); await open()
  expect(screen.getByTestId('session-message-title-search')).toBeDisabled()
  expect(screen.getByTestId('session-message-search-help')).toHaveTextContent(chat.peerMessages.search.unsupported)
  expect(targetCalls().every(call => call.title === undefined)).toBe(true)
  view.unmount(); setup(true); const original = bridge.request.getMockImplementation()!
  bridge.request.mockImplementation(async (command, input) => input.operation === 'targets' && input.title
    ? Promise.reject(Object.assign(new Error('Bounded unsupported query'), { code: -32602 })) : original(command, input))
  render(<SessionMessagesControl address={address} />); await open()
  fireEvent.change(screen.getByTestId('session-message-title-search'), { target: { value: '无法搜索' } })
  fireEvent.click(screen.getByTestId('session-message-search-submit'))
  await waitFor(() => expect(screen.getByTestId('session-message-title-search')).toBeDisabled())
  expect(screen.getByTestId('session-message-search-help')).toHaveTextContent(chat.peerMessages.search.unsupported)
  expect(screen.getByText('默认会话')).toBeVisible()
  expect(targetCalls().filter(call => call.title === '无法搜索')).toHaveLength(1)
  expect(targetCalls().at(-1)?.title).toBeUndefined()
  expect(bridge.request.mock.calls.some(([, input]) => input.operation === 'send')).toBe(false)
})

test('IME confirmation and invalid oversized keywords do not submit a search or a conversation turn', async () => {
  setup(); render(<SessionMessagesControl address={address} />); await open()
  const input = screen.getByTestId('session-message-title-search')
  fireEvent.change(input, { target: { value: '输入中' } }); fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(targetCalls()).toHaveLength(1)
  fireEvent.change(input, { target: { value: '界'.repeat(90) } }); fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.getByTestId('session-message-search-submit')).toBeDisabled()
  expect(input).toHaveAttribute('aria-invalid', 'true'); expect(targetCalls()).toHaveLength(1)
})
