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
vi.mock('@/kcoder/usePluginTargetScope', () => ({ usePluginTargetScope: () => ({ key: 'owned-policy-scope', isCurrent: () => true }) }))

const address = { deviceId: 'owned-device', taskId: 'owned-source', threadId: 'source', workspacePath: '/owned-policy' }
const receiver = { address: { targetId: 'owned-target', workspaceId: 'owned-workspace', threadId: 'receiver' },
  threadId: 'receiver', title: 'Original receiver', status: 'idle', presence: 'resident', allowedModes: ['enqueue_only', 'wake_if_idle'] }
beforeAll(async () => {
  await createInstance().use(initReactI18next).init({ lng: 'zh-CN', resources: { 'zh-CN': { chat, common } }, interpolation: { escapeValue: false } })
})
beforeEach(() => {
  bridge.request.mockReset()
  Object.defineProperty(navigator, 'locks', { configurable: true,
    value: { request: async (_key: string, work: () => Promise<unknown>) => work() } })
})
afterEach(cleanup)

function fixture(rows: boolean) {
  let policy = { enabled: true, wakeIdle: false, revision: 'policy-1' }
  let resolveSave!: () => void
  let resolveTargets!: () => void
  let refreshing = false
  bridge.request.mockImplementation(async (_command, input) => {
    if (input.operation === 'supports') return { scope: 'owned-policy-scope', sourceThreadId: 'source', discovery: true, messages: true }
    if (input.operation === 'policyRead') return policy
    if (input.operation === 'policySave') {
      refreshing = true
      await new Promise<void>(resolve => { resolveSave = resolve })
      policy = { enabled: true, wakeIdle: true, revision: 'policy-2' }
      return policy
    }
    if (input.operation === 'targets') {
      if (refreshing) await new Promise<void>(resolve => { resolveTargets = resolve })
      if (!rows) throw Error('owned read unavailable')
      return { coverage: 'workspace_history', completeness: 'complete', targets: [receiver] }
    }
    throw Error('unexpected side effect')
  })
  return { saved: () => resolveSave(), targets: () => resolveTargets() }
}

test.each([true, false])('policy toggle retains panel nodes through loading/error with receivers=%s', async rows => {
  const f = fixture(rows)
  render(<SessionMessagesControl address={address} />)
  fireEvent.click(screen.getByTestId('session-messages-open'))
  await waitFor(() => expect(screen.getByTestId('session-message-policy-wake')).toBeEnabled())
  if (rows) fireEvent.click(screen.getByTestId('session-message-target'))
  else expect(await screen.findByRole('alert')).toHaveTextContent(chat.peerMessages.error.read_failed)
  fireEvent.change(screen.getByTestId('session-message-input'), { target: { value: 'Keep this original draft' } })
  const feedback = screen.getByTestId('session-message-feedback')
  const feedbackNodes = [...feedback.children]
  const input = screen.getByTestId('session-message-input')
  const wake = screen.getByTestId('session-message-wake')
  const target = rows ? screen.getByTestId('session-message-target') : null
  const removed: Node[] = []
  const observer = new MutationObserver(records => records.forEach(record => removed.push(...record.removedNodes)))
  observer.observe(screen.getByTestId('session-messages-dialog'), { childList: true, subtree: true })
  fireEvent.click(screen.getByTestId('session-message-policy-wake'))
  expect(screen.getByTestId('session-message-send')).toBeDisabled()
  expect(screen.getByTestId('session-message-send')).toHaveTextContent(chat.peerMessages.send)
  expect(input).toHaveValue('Keep this original draft')
  await act(async () => f.saved())
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(chat.peerMessages.loading))
  expect(screen.getByTestId('session-message-send')).toHaveTextContent(chat.peerMessages.send)
  expect(screen.getByTestId('session-message-input')).toBe(input)
  expect(screen.getByTestId('session-message-wake')).toBe(wake)
  expect([...feedback.children]).toEqual(feedbackNodes)
  if (target) expect(screen.getByTestId('session-message-target')).toBe(target)
  await act(async () => f.targets())
  await waitFor(() => expect(screen.getByTestId('session-message-policy-wake')).toBeEnabled())
  expect(screen.getByTestId('session-message-policy-wake')).toBeChecked()
  expect(input).toHaveValue('Keep this original draft')
  expect(wake).toBeInTheDocument()
  expect([...feedback.children]).toEqual(feedbackNodes)
  if (rows) expect(screen.getByTestId('session-message-send')).toBeEnabled()
  else {
    expect(screen.getByRole('alert')).toHaveTextContent(chat.peerMessages.error.read_failed)
    expect(screen.getByTestId('session-message-send')).toBeDisabled()
  }
  await act(async () => Promise.resolve())
  expect(removed).not.toContain(input)
  expect(removed).not.toContain(wake)
  if (target) expect(removed).not.toContain(target)
  observer.disconnect()
  expect(bridge.request.mock.calls.filter(([, input]) => input.operation === 'policySave')).toHaveLength(1)
  expect(bridge.request.mock.calls.some(([, input]) => input.operation === 'send')).toBe(false)
})

test('unknown policy confirmation disables both settings controls until explicit refresh', async () => {
  fixture(true)
  render(<SessionMessagesControl address={address} />)
  fireEvent.click(screen.getByTestId('session-messages-open'))
  await waitFor(() => expect(screen.getByTestId('session-message-policy-wake')).toBeEnabled())
  const original = bridge.request.getMockImplementation()!
  bridge.request.mockImplementation(async (command, input) => input.operation === 'policySave' || input.operation === 'policyRead'
    ? Promise.reject(Error('owned confirmation unavailable')) : original(command, input))
  fireEvent.click(screen.getByTestId('session-message-policy-wake'))
  expect(await screen.findByRole('alert')).toHaveTextContent(chat.peerMessages.error.policy_unknown)
  expect(screen.getByTestId('session-message-policy-enable')).toBeDisabled()
  expect(screen.getByTestId('session-message-policy-wake')).toBeDisabled()
  expect(screen.getByTestId('session-message-send')).toBeDisabled()
})
